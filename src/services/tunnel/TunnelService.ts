/**
 * TunnelService: exposes a local port to the Internet through a tunnel. Several tunnels at once, one tunnel per port.
 *
 * Providers:
 *  - 'cloudflare'        Cloudflare Quick Tunnel (trycloudflare.com), no account needed: TEMPORARY ADDRESS:
 *                         each time cloudflared runs again it gets a new random URL.
 *  - 'cloudflare_named'  Cloudflare Tunnel with an account: FIXED ADDRESS. Runs
 *                         `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:0 run`, token through the environment variable
 *                         TUNNEL_TOKEN (not visible in the process list like --token). The metrics port (chosen by the OS, read from the log line
 *                         "Starting metrics server on …") + Connector ID + version are in getState() for reading
 *                         /ready. The Public Hostname + service (http://localhost:<port>) are configured on the dashboard; cloudflared
 *                         does not print the URL, so opts.publicUrl is used; the ingress config received is checked and warned about
 *                         (except opts.managedIngress: "Cloudflare tự động" (Cloudflare automatic) manages the ingress itself through the API).
 *  - 'ngrok'             @ngrok/ngrok: fixed when a static domain is given (opts.domain), otherwise treated as temporary.
 *
 * cloudflared binary: the `cloudflared` npm package downloads the "latest" build at npm install (bin/ in app.asar.unpacked); a machine with no
 * binary installs CLOUDFLARED_PINNED_VERSION (override with the CLOUDFLARED_VERSION environment variable) instead of "latest".
 *
 * Watchdog: a tunnel that was running whose cloudflared process exits unexpectedly → runs again on its own by
 * TUNNEL_RESTART_BACKOFF_MS (2 s, 5 s, 15 s, 30 s, then 60 s; a run that stays up >= 2 minutes starts the count again) until
 * stop(). ngrok reconnects by itself inside the SDK, so it only logs. opts.keepAlive (turned on automatically when the app opens): a first start that fails
 * (e.g. no network yet) also retries on that schedule instead of giving up.
 *
 * replace(): changes the config of a running tunnel make-before-break style: starts the new tunnel first (if that fails, the old one stays),
 * tells the listeners the new address (the Boss tells employees through the old tunnel while it is still alive), keeps the old tunnel for
 * TUNNEL_SWITCH_GRACE_MS more, and only then shuts it down.
 *
 * Listeners:
 *  - onChange(port, cb): per SESSION as before: removed by an explicit stop()/start(), kept across automatic restarts
 *    and replace(). Registered before start() → start() receives it right away.
 *  - watch(port, cb): durable, receives EVERY change of the port (started, died, restarted, changed, retry failed, stopped).
 *  cb(url, info): url = the address currently in use (null when dead / stopped). Both return an unsubscribe function.
 *
 * Usage:
 *   const url = await TunnelService.start(9900, 'Employee Relay', { provider: 'cloudflare_named', token, publicUrl });
 *   const off = TunnelService.watch(9900, (url, info) => …);
 *   await TunnelService.replace(9900, 'Employee Relay', newOpts);   // change the config, the employees are not cut off
 *   await TunnelService.stop(9900);
 */

import Logger from '../../utils/Logger';
import {
  checkNamedTunnelIngress,
  isQuickTunnelUrl,
  nextRestartAttempt,
  TUNNEL_KIND_LABEL,
  TUNNEL_SWITCH_GRACE_MS,
  tunnelAddressKind,
  tunnelRestartDelay,
  type TunnelAddressKind,
} from '../../shared/cloud/tunnelAddress';
import { tr } from '../../shared/i18n';

let Tunnel: any = null;
let bin: string | null = null;
let install: ((to: string, version?: string) => Promise<string>) | null = null;
let ConfigHandler: any = null;

/**
 * The cloudflared version installed when the machine has no binary (the npm package default "latest" → each machine gets a different version). This is the
 * version bundled with the app when this was written (2026.7.3). Override: the CLOUDFLARED_VERSION environment variable.
 */
export const CLOUDFLARED_PINNED_VERSION = '2026.7.3';

/** Run parameters for a tunnel with an account (the token is passed through TUNNEL_TOKEN). Metrics :0 → the OS picks a free port, read back from the log. */
const NAMED_TUNNEL_ARGS: readonly string[] = ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', 'run'];

try {
  const cf = require('cloudflared');
  Tunnel = cf.Tunnel;
  bin = cf.bin;
  install = cf.install;
  ConfigHandler = cf.ConfigHandler || null;

  // Fix binary path when running inside Electron asar archive.
  // cf.bin uses __dirname which resolves inside app.asar. We must use cf.use()
  // to update the module-scope bin variable that Tunnel.quick() reads via
  // import_constants.bin - a local assignment wouldn't propagate.
  if (bin && bin.includes('app.asar') && typeof cf.use === 'function') {
    bin = bin.replace('app.asar', 'app.asar.unpacked');
    cf.use(bin);  // ← writes into constants.js module-scope
    Logger.log(`[TunnelService] Rewrote bin path for asar: ${bin}`);
  }
} catch {
  Logger.warn('[TunnelService] cloudflared package not found');
}

// ngrok provider (optional). Gives a fixed static domain; used for the employee relay.
let ngrok: any = null;
try {
  ngrok = require('@ngrok/ngrok');
} catch {
  Logger.warn('[TunnelService] @ngrok/ngrok package not found');
}

export type TunnelProvider = 'cloudflare' | 'ngrok' | 'cloudflare_named';

export interface TunnelOptions {
  provider?: TunnelProvider;
  authtoken?: string;
  domain?: string;
  /** cloudflare_named: the Cloudflare Tunnel token (Zero Trust → Networks → Tunnels). */
  token?: string;
  /** cloudflare_named: the public address attached to the tunnel (Public Hostname), e.g. https://shop.example.com */
  publicUrl?: string;
  /** A first start that fails (e.g. no network when the app opens) → keep the session and retry on the backoff schedule instead of giving up. */
  keepAlive?: boolean;
  /** cloudflare_named: ingress managed by Deplao through the API (Cloudflare automatic) → do not check the Public Hostname / port. */
  managedIngress?: boolean;
}

/**
 * started - start() succeeded
 * restarted - ran again automatically after it died / after a first start that failed (keepAlive)
 * switched - replace() moved to the new config
 * down - the tunnel died unexpectedly; it will run again on its own (url = null)
 * retry-failed - one attempt to run again failed; it will keep trying (url = null; only watch() receives it)
 * stopped - explicit stop() (url = null)
 */
export type TunnelChangeReason = 'started' | 'restarted' | 'switched' | 'down' | 'retry-failed' | 'stopped';

export interface TunnelChangeInfo {
  port: number;
  label: string;
  reason: TunnelChangeReason;
  provider: TunnelProvider;
  kind: TunnelAddressKind;
  /** The last usable address BEFORE this change (null if the session never had one). */
  previousUrl: string | null;
  error?: string;
}

export type TunnelListener = (url: string | null, info: TunnelChangeInfo) => void;

export type TunnelState = 'starting' | 'active' | 'restarting';

export interface TunnelStateSnapshot {
  port: number;
  label: string;
  provider: TunnelProvider;
  kind: TunnelAddressKind;
  state: TunnelState;
  /** The address currently usable (null while starting / restarting). */
  url: string | null;
  /** The last usable address in the session. */
  lastUrl: string | null;
  restarts: number;
  attempt: number;
  lastError: string | null;
  nextRetryAt: number | null;
  activeSince: number | null;
  warning: string | null;
  /** cloudflared with an account: metrics port on 127.0.0.1 (/ready, /metrics). null when unknown / not cloudflared. */
  metricsPort: number | null;
  /** Connector ID of the cloudflared process (log "Generated Connector ID"). */
  connectorId: string | null;
  /** Version of the running cloudflared (log "Version …"). */
  cloudflaredVersion: string | null;
}

/** One running tunnel (one cloudflared process or one ngrok listener). */
interface TunnelHandle {
  provider: TunnelProvider;
  url: string;
  /** Config warning found after start (Public Hostname mismatch…). */
  warning: string | null;
  /** Read from the cloudflared log while running (null for ngrok / not printed yet). */
  metricsPort: number | null;
  connectorId: string | null;
  version: string | null;
  close(): Promise<void>;
  /** Report that a tunnel died unexpectedly (called at most once; if registered after it died, called immediately). */
  onDeath(cb: (reason: string) => void): void;
}

interface Session {
  port: number;
  label: string;
  opts: TunnelOptions;
  provider: TunnelProvider;
  kind: TunnelAddressKind;
  handle: TunnelHandle | null;
  state: TunnelState;
  url: string | null;
  lastUrl: string | null;
  activeSince: number | null;
  attempt: number;
  restarts: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextRetryAt: number | null;
  lastError: string | null;
  stopped: boolean;
  stopping: Promise<void> | null;
  /** onChange() - per session. */
  listeners: Set<TunnelListener>;
}

// ─── State ───────────────────────────────────────────────────────────────────

const sessions = new Map<number, Session>();
/** onChange() registered while the port has no session → the next start() session receives it. */
const pendingListeners = new Map<number, Set<TunnelListener>>();
/** watch() - durable per port. */
const watchers = new Map<number, Set<TunnelListener>>();
/** Old tunnel waiting to be shut down after replace(). */
const retiring = new Set<TunnelHandle>();
let shuttingDown = false;
let quitHookInstalled = false;

const START_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function providerOf(opts?: TunnelOptions | null): TunnelProvider {
  return opts?.provider === 'ngrok' || opts?.provider === 'cloudflare_named' ? opts.provider : 'cloudflare';
}

function providerName(provider: TunnelProvider): string {
  if (provider === 'cloudflare_named') return tr('Cloudflare Tunnel (có tài khoản)');
  if (provider === 'ngrok') return 'ngrok';
  return 'Cloudflare Quick Tunnel';
}

function errorMessage(err: unknown): string {
  return (err as any)?.message || String(err);
}

/** Strip long strings that look like a token / secret from log lines before they go into error messages. */
function redact(text: string): string {
  return text.replace(/[A-Za-z0-9+/=_-]{40,}/g, '***');
}

function safeCall(cb: TunnelListener, url: string | null, info: TunnelChangeInfo): void {
  try { cb(url, info); } catch (err) { Logger.warn(`[TunnelService] listener error: ${errorMessage(err)}`); }
}

function addListener(map: Map<number, Set<TunnelListener>>, port: number, cb: TunnelListener): () => void {
  let set = map.get(port);
  if (!set) { set = new Set(); map.set(port, set); }
  set.add(cb);
  return () => {
    const current = map.get(port);
    current?.delete(cb);
    if (current && current.size === 0) map.delete(port);
  };
}

/** Emit changes to the per-session listeners (except retry-failed) and to the port's durable watchers. */
function emit(session: Session, reason: TunnelChangeReason, previousUrl: string | null, error?: string): void {
  const info: TunnelChangeInfo = {
    port: session.port,
    label: session.label,
    reason,
    provider: session.provider,
    kind: session.kind,
    previousUrl,
    ...(error ? { error } : {}),
  };
  const url = session.url;
  if (reason !== 'retry-failed') {
    for (const cb of Array.from(session.listeners)) safeCall(cb, url, info);
  }
  const portWatchers = watchers.get(session.port);
  if (portWatchers) for (const cb of Array.from(portWatchers)) safeCall(cb, url, info);
}

/** Stop tunnels when the app quits (so no cloudflared is left orphaned) and block automatic restarts while quitting. */
function installQuitHook(): void {
  if (quitHookInstalled) return;
  quitHookInstalled = true;
  try {
    const { app } = require('electron');
    if (app && typeof app.on === 'function') app.on('before-quit', () => TunnelService.shutdown());
  } catch { /* outside Electron (tests) */ }
}

// ─── Providers ───────────────────────────────────────────────────────────────

async function ensureCloudflared(): Promise<void> {
  if (!Tunnel || !bin || !install) {
    throw new Error(tr('Chưa cài gói cloudflared. Chạy: npm install cloudflared'));
  }
  // Auto-install the cloudflared binary on first run
  const fs = require('fs');
  if (!fs.existsSync(bin)) {
    const version = String(process.env.CLOUDFLARED_VERSION || '').trim() || CLOUDFLARED_PINNED_VERSION;
    Logger.log(`[TunnelService] Installing cloudflared ${version} binary (first time)...`);
    await install(bin, version);
    Logger.log('[TunnelService] cloudflared binary installed');
  }
}

/**
 * Tunnel with an account: the token goes through the TUNNEL_TOKEN environment variable instead of --token (anyone can read argv in the process
 * list). The `cloudflared` package's spawn does not accept a separate env, so process.env is set temporarily around the spawn: spawn copies the env SYNCHRONOUSLY,
 * with no code running in between, then the old value is restored at once.
 */
function spawnNamedTunnel(token: string): any {
  const previous = process.env.TUNNEL_TOKEN;
  process.env.TUNNEL_TOKEN = token;
  try {
    return new Tunnel([...NAMED_TUNNEL_ARGS]);
  } finally {
    if (previous === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = previous;
  }
}

const METRICS_LINE_RE = /metrics server on \S*?:(\d+)\/metrics/i;
const CONNECTOR_ID_RE = /Connector ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const VERSION_RE = /\bVersion (\d+\.\d+\.\d+)/;

function cleanPublicUrl(raw: string | undefined): string {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * Runs cloudflared (quick or named). Resolves when ready: quick = a trycloudflare URL has appeared; named = the first connection to Cloudflare exists. Exit / error / over 30 s before that → reject (with cloudflared's last error line).
 */
async function launchCloudflared(port: number, opts: TunnelOptions, provider: 'cloudflare' | 'cloudflare_named'): Promise<TunnelHandle> {
  await ensureCloudflared();
  const named = provider === 'cloudflare_named';
  const token = String(opts.token || '').trim();
  const publicUrl = cleanPublicUrl(opts.publicUrl);
  if (named) {
    if (!token) throw new Error(tr('Thiếu Cloudflare Tunnel token'));
    if (!/^https:\/\/[^/\s]+$/i.test(publicUrl)) throw new Error(tr('Nhập địa chỉ công khai dạng https://ten-mien (Public Hostname của tunnel)'));
  }

  return new Promise<TunnelHandle>((resolve, reject) => {
    const tunnel = named ? spawnNamedTunnel(token) : Tunnel.quick(`http://localhost:${port}`);
    let settled = false;
    let closing = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastErrorLine = '';
    let deathReason: string | null = null;
    let deathCb: ((reason: string) => void) | null = null;

    const handle: TunnelHandle = {
      provider,
      url: '',
      warning: null,
      metricsPort: null,
      connectorId: null,
      version: null,
      close: async () => {
        closing = true;
        try { tunnel.stop(); } catch { /* already exited */ }
      },
      onDeath: (cb) => {
        deathCb = cb;
        if (deathReason !== null) cb(deathReason);
      },
    };

    const fireDeath = (reason: string) => {
      if (closing || deathReason !== null) return;
      deathReason = reason;
      deathCb?.(reason);
    };

    // Remember the most recent cloudflared error line to report the reason when it exits / does not come up; read the metrics port / Connector ID / version
    const onOutput = (chunk: string) => {
      for (const line of String(chunk || '').split(/\r?\n/)) {
        if (/\bERR\b|error=|failed/i.test(line)) {
          lastErrorLine = redact(line.replace(/^\S+Z\s+/, '').trim()).slice(0, 300);
        }
        if (!named) continue;
        const metrics = METRICS_LINE_RE.exec(line);
        if (metrics) handle.metricsPort = Number(metrics[1]) || null;
        const connector = CONNECTOR_ID_RE.exec(line);
        if (connector) handle.connectorId = connector[1].toLowerCase();
        const version = VERSION_RE.exec(line);
        if (version && !handle.version) handle.version = version[1];
      }
    };
    tunnel.on('stderr', onOutput);
    tunnel.on('stdout', onOutput);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closing = true;
      try { tunnel.stop(); } catch { /* already exited */ }
      reject(err);
    };

    const ready = (url: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handle.url = url;
      resolve(handle);
    };

    timer = setTimeout(() => {
      const detail = lastErrorLine ? ` (${lastErrorLine})` : '';
      fail(new Error(named
        ? tr('Cloudflare tunnel không kết nối được sau 30 giây — kiểm tra token và mạng{{detail}}', { detail })
        : tr('Cloudflare tunnel timeout (port {{port}}) - kiểm tra kết nối mạng{{detail}}', { port, detail })));
    }, START_TIMEOUT_MS);

    if (named) {
      tunnel.on('connected', () => ready(publicUrl));
      // Check the ingress config received from the dashboard against the address entered + the relay port (self-managed ingress: skip)
      if (ConfigHandler && !opts.managedIngress) {
        try {
          const configHandler = new ConfigHandler(tunnel);
          configHandler.on('error', () => { /* unknown config: skip */ });
          configHandler.on('config', ({ config }: { config: unknown }) => {
            const warning = checkNamedTunnelIngress(config, publicUrl, port);
            if (warning !== handle.warning) {
              handle.warning = warning;
              if (warning) Logger.warn(`[TunnelService] ⚠️ Named tunnel [${port}]: ${warning}`);
            }
          });
        } catch { /* old cloudflared package without a ConfigHandler */ }
      }
    } else {
      tunnel.on('url', (url: string) => {
        if (isQuickTunnelUrl(url)) ready(url);
      });
    }

    tunnel.on('exit', (code: number | null, signal: string | null) => {
      const reason = tr('cloudflared thoát (code {{v1}}{{v2}}){{v3}}', { v1: code ?? '-', v2: signal ? `, ${signal}` : '', v3: lastErrorLine ? ` — ${lastErrorLine}` : '' });
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new Error(named ? tr('{{reason}}. Token sai hoặc tunnel đã bị xoá?', { reason }) : reason));
        return;
      }
      fireDeath(reason);
    });

    tunnel.on('error', (err: Error) => {
      const msg = redact(errorMessage(err));
      if (!settled) {
        fail(err instanceof Error ? err : new Error(msg));
        return;
      }
      Logger.warn(`[TunnelService] cloudflared [${port}] báo lỗi: ${msg}`);
      // The process died without 'exit' (e.g. a spawn error) → treat it as dead
      const proc = tunnel.process;
      if (proc && proc.exitCode !== null && proc.exitCode !== undefined) fireDeath(tr('cloudflared lỗi: {{msg}}', { msg }));
    });
  });
}

async function launchNgrok(port: number, opts: TunnelOptions): Promise<TunnelHandle> {
  if (!ngrok) {
    throw new Error(tr('Chưa cài gói @ngrok/ngrok. Chạy: npm install @ngrok/ngrok'));
  }
  if (!opts.authtoken) {
    throw new Error(tr('Thiếu ngrok authtoken. Nhập trong Cài đặt → Nhân viên → Kết nối.'));
  }
  const domain = String(opts.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const listener = await ngrok.forward({
    addr: port,
    authtoken: opts.authtoken,
    ...(domain ? { domain } : {}),
    // The SDK reconnects the ngrok session by itself when the network drops: only log it
    onStatusChange: (status: string) => {
      Logger.log(`[TunnelService] ngrok [${port}] trạng thái: ${status}${status === 'closed' ? ' — SDK đang tự kết nối lại' : ''}`);
    },
  });
  return {
    provider: 'ngrok',
    url: listener.url(),
    warning: null,
    metricsPort: null,
    connectorId: null,
    version: null,
    close: async () => {
      try { await listener.close(); } catch { /* already closed */ }
    },
    onDeath: () => { /* ngrok reconnects by itself */ },
  };
}

function launch(port: number, opts: TunnelOptions): Promise<TunnelHandle> {
  const provider = providerOf(opts);
  if (provider === 'ngrok') return launchNgrok(port, opts);
  return launchCloudflared(port, opts, provider);
}

// ─── Supervisor ──────────────────────────────────────────────────────────────

function isCurrent(session: Session): boolean {
  return sessions.get(session.port) === session && !session.stopped;
}

function activate(session: Session, handle: TunnelHandle, reason: 'started' | 'restarted' | 'switched'): void {
  const previousUrl = session.lastUrl;
  session.handle = handle;
  session.url = handle.url;
  session.lastUrl = handle.url;
  session.state = 'active';
  session.activeSince = Date.now();
  session.lastError = null;
  session.nextRetryAt = null;
  if (reason === 'restarted') session.restarts++;
  handle.onDeath((why) => onDeath(session, handle, why));

  const kindLabel = TUNNEL_KIND_LABEL[session.kind];
  if (reason === 'started') {
    Logger.log(`[TunnelService] ✅ Tunnel active [${session.port}] (${session.label}): ${handle.url} — ${providerName(session.provider)}, ${kindLabel}`);
  } else if (reason === 'restarted') {
    const changed = previousUrl && previousUrl !== handle.url;
    Logger.log(`[TunnelService] ✅ Tunnel [${session.port}] (${session.label}) đã chạy lại: ${handle.url}`
      + (changed ? ` — ĐỊA CHỈ MỚI (trước: ${previousUrl})` : ' — địa chỉ không đổi'));
  } else {
    Logger.log(`[TunnelService] ✅ Đã chuyển tunnel [${session.port}] (${session.label}) sang ${providerName(session.provider)}: ${handle.url}`
      + (previousUrl && previousUrl !== handle.url ? ` (trước: ${previousUrl})` : ''));
  }
  emit(session, reason, previousUrl);
}

/** Schedule a restart on the backoff; returns the delay (ms) and the attempt number. */
function scheduleRestart(session: Session): { delay: number; attemptNo: number } {
  if (session.timer) clearTimeout(session.timer);
  const delay = tunnelRestartDelay(session.attempt);
  session.attempt++;
  session.state = 'restarting';
  session.nextRetryAt = Date.now() + delay;
  session.timer = setTimeout(() => {
    session.timer = null;
    void relaunch(session);
  }, delay);
  return { delay, attemptNo: session.attempt };
}

function onDeath(session: Session, handle: TunnelHandle, why: string): void {
  if (!isCurrent(session) || session.handle !== handle || shuttingDown) return;
  const uptime = session.activeSince ? Date.now() - session.activeSince : null;
  const previousUrl = session.url;
  session.handle = null;
  session.url = null;
  session.activeSince = null;
  session.lastError = why;
  session.attempt = nextRestartAttempt(session.attempt, uptime);
  const { delay, attemptNo } = scheduleRestart(session);
  Logger.warn(`[TunnelService] ⚠️ Tunnel [${session.port}] (${session.label}) dừng ngoài ý muốn: ${why} — tự chạy lại sau ${Math.round(delay / 1000)}s (lần ${attemptNo})`
    + (session.kind === 'temporary' ? '; địa chỉ tạm sẽ ĐỔI sau khi chạy lại' : ''));
  emit(session, 'down', previousUrl, why);
}

async function relaunch(session: Session): Promise<void> {
  if (!isCurrent(session) || shuttingDown) return;
  session.nextRetryAt = null;
  Logger.log(`[TunnelService] 🔁 Đang chạy lại tunnel [${session.port}] (${session.label}, lần ${session.attempt})...`);
  try {
    const handle = await launch(session.port, session.opts);
    // Stopped, or replace() attached another tunnel while waiting → discard the one that just started
    if (!isCurrent(session) || shuttingDown || session.handle) {
      await handle.close();
      return;
    }
    // The keepAlive session never came up (e.g. the app opened with no network) → this is the first start, not a "chạy lại" (restart)
    activate(session, handle, session.lastUrl === null ? 'started' : 'restarted');
  } catch (err) {
    if (!isCurrent(session) || shuttingDown || session.handle) return;
    const msg = errorMessage(err);
    session.lastError = msg;
    const { delay, attemptNo } = scheduleRestart(session);
    Logger.warn(`[TunnelService] Chạy lại tunnel [${session.port}] (${session.label}) thất bại: ${msg} — thử lại sau ${Math.round(delay / 1000)}s (lần ${attemptNo})`);
    emit(session, 'retry-failed', null, msg);
  }
}

function snapshotOf(session: Session): TunnelStateSnapshot {
  return {
    port: session.port,
    label: session.label,
    provider: session.provider,
    kind: session.kind,
    state: session.state,
    url: session.url,
    lastUrl: session.lastUrl,
    restarts: session.restarts,
    attempt: session.attempt,
    lastError: session.lastError,
    nextRetryAt: session.nextRetryAt,
    activeSince: session.activeSince,
    warning: session.handle?.warning ?? null,
    metricsPort: session.handle?.metricsPort ?? null,
    connectorId: session.handle?.connectorId ?? null,
    cloudflaredVersion: session.handle?.version ?? null,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export const TunnelService = {
  /**
   * Turns on the tunnel for one port (the old tunnel of that port is shut down first). Default is a Cloudflare Quick Tunnel (a temporary URL);
   * opts.provider = 'cloudflare_named' / 'ngrok' for a fixed address. Returns the public URL.
   * Error → reject; if opts.keepAlive, the session is kept and retried automatically (listeners receive the URL when it comes up).
   */
  async start(port: number, label?: string, opts?: TunnelOptions): Promise<string> {
    installQuitHook();
    if (shuttingDown) throw new Error(tr('Ứng dụng đang thoát'));

    const existing = sessions.get(port);
    if (existing) await this.stop(port);

    const sessionOpts: TunnelOptions = { ...(opts || {}) };
    const provider = providerOf(sessionOpts);
    const adopted = pendingListeners.get(port) ?? new Set<TunnelListener>();
    pendingListeners.delete(port);
    const session: Session = {
      port,
      label: label || `Port ${port}`,
      opts: sessionOpts,
      provider,
      kind: tunnelAddressKind(provider, sessionOpts),
      handle: null,
      state: 'starting',
      url: null,
      lastUrl: null,
      activeSince: null,
      attempt: 0,
      restarts: 0,
      timer: null,
      nextRetryAt: null,
      lastError: null,
      stopped: false,
      stopping: null,
      listeners: adopted,
    };
    sessions.set(port, session);

    Logger.log(`[TunnelService] Starting ${providerName(provider)} on port ${port} (${session.label})...`);
    try {
      const handle = await launch(port, sessionOpts);
      if (!isCurrent(session) || shuttingDown) {
        await handle.close();
        throw new Error(tr('Tunnel đã bị tắt trong lúc khởi động'));
      }
      activate(session, handle, 'started');
      return handle.url;
    } catch (err) {
      const msg = errorMessage(err);
      if (isCurrent(session)) {
        session.lastError = msg;
        if (sessionOpts.keepAlive && !shuttingDown) {
          const { delay, attemptNo } = scheduleRestart(session);
          Logger.warn(`[TunnelService] ⚠️ Không bật được tunnel [${port}] (${session.label}): ${msg} — tự thử lại sau ${Math.round(delay / 1000)}s (lần ${attemptNo})`);
          emit(session, 'retry-failed', null, msg);
        } else {
          // Session not kept (the caller reports the error itself). Listeners registered before start() are kept for the next start() call.
          sessions.delete(port);
          if (session.listeners.size) pendingListeners.set(port, session.listeners);
        }
      }
      throw err;
    }
  },

  /**
   * Changes the config of a running tunnel without cutting off the people using it (make-before-break). If no tunnel is
   * running → same as start(). If the new tunnel fails → reject, the old tunnel stays as it is. Two ngrok sessions cannot run in parallel
   * (session limit / duplicate domain), so ngrok → ngrok shuts the old one down first, then starts the new one.
   */
  async replace(port: number, label?: string, opts?: TunnelOptions, graceMs: number = TUNNEL_SWITCH_GRACE_MS): Promise<string> {
    installQuitHook();
    if (shuttingDown) throw new Error(tr('Ứng dụng đang thoát'));
    const session = sessions.get(port);
    const nextOpts: TunnelOptions = { ...(opts || {}) };
    const provider = providerOf(nextOpts);
    if (!session || session.stopped || session.state !== 'active' || !session.handle) {
      return this.start(port, label, nextOpts);
    }
    if (session.provider === 'ngrok' && provider === 'ngrok') {
      Logger.log(`[TunnelService] Đổi cấu hình ngrok [${port}]: tắt rồi bật lại (ngrok không chạy song song hai phiên)`);
      const keep = new Set(session.listeners);
      await this.stop(port);
      if (keep.size) {
        const pending = pendingListeners.get(port) ?? new Set<TunnelListener>();
        for (const cb of keep) pending.add(cb);
        pendingListeners.set(port, pending);
      }
      return this.start(port, label || session.label, nextOpts);
    }

    Logger.log(`[TunnelService] Đổi tunnel [${port}] (${session.label}) sang ${providerName(provider)} — giữ tunnel cũ tới khi tunnel mới sẵn sàng...`);
    const handle = await launch(port, nextOpts); // error → the old tunnel stays as it is
    if (!isCurrent(session) || shuttingDown) {
      await handle.close();
      throw new Error(tr('Tunnel đã bị tắt trong lúc chuyển'));
    }
    const old = session.handle;
    // The old tunnel may have died while the new one was waiting → cancel its own automatic restart schedule
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    session.opts = nextOpts;
    session.provider = provider;
    session.kind = tunnelAddressKind(provider, nextOpts);
    if (label) session.label = label;
    session.attempt = 0;
    session.restarts = 0;
    activate(session, handle, 'switched');

    if (old && old !== handle) {
      retiring.add(old);
      setTimeout(() => {
        if (!retiring.delete(old)) return;
        void old.close();
        Logger.log(`[TunnelService] Đã tắt tunnel cũ [${port}] sau ${Math.round(graceMs / 1000)}s chuyển tiếp`);
      }, Math.max(0, graceMs));
    }
    return handle.url;
  },

  /** Stop the tunnel of one port (cancels its automatic restart schedule). The per-session listeners receive null, then are removed. */
  async stop(port: number): Promise<void> {
    const session = sessions.get(port);
    if (!session) return;
    if (session.stopping) return session.stopping;
    session.stopped = true;
    session.stopping = (async () => {
      if (session.timer) { clearTimeout(session.timer); session.timer = null; }
      const handle = session.handle;
      const previousUrl = session.url ?? session.lastUrl;
      session.handle = null;
      session.url = null;
      session.nextRetryAt = null;
      if (handle) {
        try { await handle.close(); } catch { /* ignore */ }
      }
      emit(session, 'stopped', previousUrl);
      if (sessions.get(port) === session) sessions.delete(port);
      Logger.log(`[TunnelService] Stopped tunnel [${port}] (${session.label})`);
    })();
    return session.stopping;
  },

  /**
   * Stop all active tunnels.
   */
  async stopAll(): Promise<void> {
    const ports = Array.from(sessions.keys());
    for (const port of ports) {
      await this.stop(port);
    }
    Logger.log(`[TunnelService] All tunnels stopped (${ports.length} total)`);
  },

  /** The app is quitting: stop every tunnel now, no automatic restart, no events emitted (DB / windows are closing). */
  shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const session of sessions.values()) {
      session.stopped = true;
      if (session.timer) { clearTimeout(session.timer); session.timer = null; }
      const handle = session.handle;
      session.handle = null;
      session.url = null;
      if (handle) void handle.close().catch(() => {});
    }
    sessions.clear();
    for (const handle of retiring) void handle.close().catch(() => {});
    retiring.clear();
    Logger.log('[TunnelService] Shutdown — đã tắt mọi tunnel');
  },

  /**
   * Get the public URL for a specific tunnel (null if not active).
   */
  getUrl(port: number): string | null {
    return sessions.get(port)?.url ?? null;
  },

  /**
   * Check whether a specific tunnel is currently active (has a usable address).
   */
  isActive(port: number): boolean {
    return !!sessions.get(port)?.url;
  },

  /** Detailed state (null = the port has no tunnel; a tunnel waiting to restart still counts). */
  getState(port: number): TunnelStateSnapshot | null {
    const session = sessions.get(port);
    return session ? snapshotOf(session) : null;
  },

  /**
   * Get all active tunnels with their URLs and labels.
   * Returns a record keyed by port number.
   */
  getAllTunnels(): Record<number, { url: string; label: string }> {
    const result: Record<number, { url: string; label: string }> = {};
    for (const [port, session] of sessions) {
      if (session.url) {
        result[port] = { url: session.url, label: session.label };
      }
    }
    return result;
  },

  /**
   * Per-session listener: called with the new URL (or null when the tunnel dies / is stopped). Removed when stop()/start() is called
   * explicitly; registered while the port has no tunnel, so the next start() receives it. Returns an unsubscribe function.
   */
  onChange(port: number, cb: TunnelListener): () => void {
    const session = sessions.get(port);
    if (session && !session.stopped) {
      session.listeners.add(cb);
      return () => { session.listeners.delete(cb); };
    }
    return addListener(pendingListeners, port, cb);
  },

  /** Durable listener for the port: every change (started, died, restarted, changed, retry failed, stopped). Returns an unsubscribe function. */
  watch(port: number, cb: TunnelListener): () => void {
    return addListener(watchers, port, cb);
  },
};

export default TunnelService;
