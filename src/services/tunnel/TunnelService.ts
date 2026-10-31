/**
 * TunnelService — mở cổng local ra Internet qua tunnel. Nhiều tunnel cùng lúc, mỗi cổng một tunnel.
 *
 * Nhà cung cấp:
 *  - 'cloudflare'        Cloudflare Quick Tunnel (trycloudflare.com), không cần tài khoản — ĐỊA CHỈ TẠM:
 *                         mỗi lần cloudflared chạy lại là một URL ngẫu nhiên mới.
 *  - 'cloudflare_named'  Cloudflare Tunnel có tài khoản — ĐỊA CHỈ CỐ ĐỊNH. Chạy
 *                         `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:0 run`, token qua biến môi trường
 *                         TUNNEL_TOKEN (không lộ trong danh sách tiến trình như --token). Cổng metrics (OS chọn, đọc từ
 *                         dòng log "Starting metrics server on …") + Connector ID + phiên bản có trong getState() để đọc
 *                         /ready. Public Hostname + service (http://localhost:<port>) cấu hình trên dashboard; cloudflared
 *                         không in URL nên dùng opts.publicUrl; cấu hình ingress nhận về được đối chiếu và cảnh báo
 *                         (trừ opts.managedIngress — "Cloudflare tự động" tự quản lý ingress qua API).
 *  - 'ngrok'             @ngrok/ngrok — cố định khi có domain tĩnh (opts.domain), không có thì coi là tạm.
 *
 * Binary cloudflared: gói npm `cloudflared` tải bản "latest" lúc npm install (bin/ trong app.asar.unpacked); máy chưa có
 * binary thì cài bản CLOUDFLARED_PINNED_VERSION (ghi đè bằng biến môi trường CLOUDFLARED_VERSION) thay vì "latest".
 *
 * Giám sát: tunnel đã chạy mà tiến trình cloudflared thoát ngoài ý muốn → tự chạy lại theo
 * TUNNEL_RESTART_BACKOFF_MS (2 s, 5 s, 15 s, 30 s rồi 60 s; chạy ổn >= 2 phút thì tính lại từ đầu) cho tới khi
 * stop(). ngrok tự kết nối lại trong SDK nên chỉ ghi log. opts.keepAlive (tự bật khi mở app): lần bật đầu lỗi
 * (vd chưa có mạng) cũng thử lại theo lịch đó thay vì bỏ cuộc.
 *
 * replace(): đổi cấu hình khi đang chạy kiểu make-before-break — bật tunnel mới trước (lỗi thì giữ nguyên
 * tunnel cũ), báo listener địa chỉ mới (Boss báo nhân viên qua tunnel cũ còn sống), giữ tunnel cũ thêm
 * TUNNEL_SWITCH_GRACE_MS rồi mới tắt.
 *
 * Listener:
 *  - onChange(port, cb) — theo PHIÊN như trước: bị xoá khi stop()/start() tường minh, giữ qua các lần tự chạy
 *    lại và replace(). Đăng ký trước start() thì start() nhận luôn.
 *  - watch(port, cb)    — bền, nhận MỌI thay đổi của cổng (bật, chết, chạy lại, đổi, thử lại lỗi, tắt).
 *  cb(url, info): url = địa chỉ đang dùng được (null khi đang chết / đã tắt). Cả hai trả hàm huỷ.
 *
 * Usage:
 *   const url = await TunnelService.start(9900, 'Employee Relay', { provider: 'cloudflare_named', token, publicUrl });
 *   const off = TunnelService.watch(9900, (url, info) => …);
 *   await TunnelService.replace(9900, 'Employee Relay', newOpts);   // đổi cấu hình, không ngắt nhân viên
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

let Tunnel: any = null;
let bin: string | null = null;
let install: ((to: string, version?: string) => Promise<string>) | null = null;
let ConfigHandler: any = null;

/**
 * Bản cloudflared cài khi máy chưa có binary (gói npm mặc định "latest" → mỗi máy một bản khác nhau). Đây là bản
 * đang đóng gói kèm app lúc viết (2026.7.3). Ghi đè: biến môi trường CLOUDFLARED_VERSION.
 */
export const CLOUDFLARED_PINNED_VERSION = '2026.7.3';

/** Tham số chạy Tunnel có tài khoản (token đi qua TUNNEL_TOKEN). Metrics :0 → OS chọn cổng trống, đọc lại từ log. */
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

// ngrok provider (optional). Cấp static domain cố định — dùng cho relay nhân viên.
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
  /** cloudflare_named: token của Cloudflare Tunnel (Zero Trust → Networks → Tunnels). */
  token?: string;
  /** cloudflare_named: địa chỉ công khai đã gắn với tunnel (Public Hostname), vd https://shop.example.com */
  publicUrl?: string;
  /** Lần bật đầu lỗi (vd chưa có mạng lúc mở app) → giữ phiên và tự thử lại theo backoff thay vì bỏ cuộc. */
  keepAlive?: boolean;
  /** cloudflare_named: ingress do Deplao quản lý qua API (Cloudflare tự động) → không đối chiếu Public Hostname / cổng. */
  managedIngress?: boolean;
}

/**
 * started    — start() thành công
 * restarted  — tự chạy lại sau khi chết / sau lần bật đầu lỗi (keepAlive)
 * switched   — replace() đã chuyển sang cấu hình mới
 * down       — tunnel chết ngoài ý muốn, sẽ tự chạy lại (url = null)
 * retry-failed — một lần thử chạy lại thất bại, sẽ thử tiếp (url = null; chỉ watch() nhận)
 * stopped    — stop() tường minh (url = null)
 */
export type TunnelChangeReason = 'started' | 'restarted' | 'switched' | 'down' | 'retry-failed' | 'stopped';

export interface TunnelChangeInfo {
  port: number;
  label: string;
  reason: TunnelChangeReason;
  provider: TunnelProvider;
  kind: TunnelAddressKind;
  /** Địa chỉ dùng được gần nhất TRƯỚC thay đổi này (null nếu phiên chưa từng có). */
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
  /** Địa chỉ đang dùng được (null khi đang khởi động / chạy lại). */
  url: string | null;
  /** Địa chỉ dùng được gần nhất trong phiên. */
  lastUrl: string | null;
  restarts: number;
  attempt: number;
  lastError: string | null;
  nextRetryAt: number | null;
  activeSince: number | null;
  warning: string | null;
  /** cloudflared có tài khoản: cổng metrics trên 127.0.0.1 (/ready, /metrics) — null khi chưa biết / không phải cloudflared. */
  metricsPort: number | null;
  /** Connector ID của tiến trình cloudflared (log "Generated Connector ID"). */
  connectorId: string | null;
  /** Phiên bản cloudflared đang chạy (log "Version …"). */
  cloudflaredVersion: string | null;
}

/** Một tunnel đang chạy (một tiến trình cloudflared hoặc một listener ngrok). */
interface TunnelHandle {
  provider: TunnelProvider;
  url: string;
  /** Cảnh báo cấu hình phát hiện sau khi chạy (Public Hostname không khớp…). */
  warning: string | null;
  /** Đọc từ log cloudflared khi chạy (null với ngrok / chưa in). */
  metricsPort: number | null;
  connectorId: string | null;
  version: string | null;
  close(): Promise<void>;
  /** Báo tunnel chết ngoài ý muốn (gọi tối đa 1 lần; đăng ký sau khi đã chết thì gọi ngay). */
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
  /** onChange() — theo phiên. */
  listeners: Set<TunnelListener>;
}

// ─── State ───────────────────────────────────────────────────────────────────

const sessions = new Map<number, Session>();
/** onChange() đăng ký khi cổng chưa có phiên → phiên start() kế tiếp nhận. */
const pendingListeners = new Map<number, Set<TunnelListener>>();
/** watch() — bền theo cổng. */
const watchers = new Map<number, Set<TunnelListener>>();
/** Tunnel cũ đang chờ tắt sau replace(). */
const retiring = new Set<TunnelHandle>();
let shuttingDown = false;
let quitHookInstalled = false;

const START_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function providerOf(opts?: TunnelOptions | null): TunnelProvider {
  return opts?.provider === 'ngrok' || opts?.provider === 'cloudflare_named' ? opts.provider : 'cloudflare';
}

function providerName(provider: TunnelProvider): string {
  if (provider === 'cloudflare_named') return 'Cloudflare Tunnel (có tài khoản)';
  if (provider === 'ngrok') return 'ngrok';
  return 'Cloudflare Quick Tunnel';
}

function errorMessage(err: unknown): string {
  return (err as any)?.message || String(err);
}

/** Bỏ chuỗi dài giống token / secret khỏi dòng log trước khi đưa vào thông báo lỗi. */
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

/** Phát thay đổi cho listener theo phiên (trừ retry-failed) và watcher bền của cổng. */
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

/** Tắt tunnel khi app thoát (không để cloudflared mồ côi) và chặn tự chạy lại trong lúc thoát. */
function installQuitHook(): void {
  if (quitHookInstalled) return;
  quitHookInstalled = true;
  try {
    const { app } = require('electron');
    if (app && typeof app.on === 'function') app.on('before-quit', () => TunnelService.shutdown());
  } catch { /* ngoài Electron (test) */ }
}

// ─── Providers ───────────────────────────────────────────────────────────────

async function ensureCloudflared(): Promise<void> {
  if (!Tunnel || !bin || !install) {
    throw new Error('Chưa cài gói cloudflared. Chạy: npm install cloudflared');
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
 * Tunnel có tài khoản: token qua biến môi trường TUNNEL_TOKEN thay vì --token (argv ai cũng đọc được trong danh sách
 * tiến trình). Gói `cloudflared` spawn không nhận env riêng → đặt tạm process.env quanh lúc spawn: spawn chép env ĐỒNG BỘ,
 * không đoạn mã nào chen vào giữa, rồi trả lại giá trị cũ ngay.
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
 * Chạy cloudflared (quick hoặc named). Resolve khi sẵn sàng: quick = có URL trycloudflare, named = có kết nối
 * đầu tiên tới Cloudflare. Thoát / lỗi / quá 30 s trước đó → reject (kèm dòng lỗi cuối của cloudflared).
 */
async function launchCloudflared(port: number, opts: TunnelOptions, provider: 'cloudflare' | 'cloudflare_named'): Promise<TunnelHandle> {
  await ensureCloudflared();
  const named = provider === 'cloudflare_named';
  const token = String(opts.token || '').trim();
  const publicUrl = cleanPublicUrl(opts.publicUrl);
  if (named) {
    if (!token) throw new Error('Thiếu Cloudflare Tunnel token');
    if (!/^https:\/\/[^/\s]+$/i.test(publicUrl)) throw new Error('Nhập địa chỉ công khai dạng https://ten-mien (Public Hostname của tunnel)');
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
        try { tunnel.stop(); } catch { /* đã thoát */ }
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

    // Nhớ dòng lỗi gần nhất của cloudflared để báo lý do khi nó thoát / không lên; đọc cổng metrics / Connector ID / phiên bản
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
      try { tunnel.stop(); } catch { /* đã thoát */ }
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
        ? `Cloudflare tunnel không kết nối được sau 30 giây — kiểm tra token và mạng${detail}`
        : `Cloudflare tunnel timeout (port ${port}) - kiểm tra kết nối mạng${detail}`));
    }, START_TIMEOUT_MS);

    if (named) {
      tunnel.on('connected', () => ready(publicUrl));
      // Đối chiếu cấu hình ingress nhận từ dashboard với địa chỉ đã nhập + cổng relay (ingress tự quản lý thì bỏ qua)
      if (ConfigHandler && !opts.managedIngress) {
        try {
          const configHandler = new ConfigHandler(tunnel);
          configHandler.on('error', () => { /* cấu hình lạ — bỏ qua */ });
          configHandler.on('config', ({ config }: { config: unknown }) => {
            const warning = checkNamedTunnelIngress(config, publicUrl, port);
            if (warning !== handle.warning) {
              handle.warning = warning;
              if (warning) Logger.warn(`[TunnelService] ⚠️ Named tunnel [${port}]: ${warning}`);
            }
          });
        } catch { /* gói cloudflared cũ không có ConfigHandler */ }
      }
    } else {
      tunnel.on('url', (url: string) => {
        if (isQuickTunnelUrl(url)) ready(url);
      });
    }

    tunnel.on('exit', (code: number | null, signal: string | null) => {
      const reason = `cloudflared thoát (code ${code ?? '-'}${signal ? `, ${signal}` : ''})${lastErrorLine ? ` — ${lastErrorLine}` : ''}`;
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new Error(named ? `${reason}. Token sai hoặc tunnel đã bị xoá?` : reason));
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
      // Tiến trình đã chết mà không có 'exit' (vd spawn lỗi) → coi như chết
      const proc = tunnel.process;
      if (proc && proc.exitCode !== null && proc.exitCode !== undefined) fireDeath(`cloudflared lỗi: ${msg}`);
    });
  });
}

async function launchNgrok(port: number, opts: TunnelOptions): Promise<TunnelHandle> {
  if (!ngrok) {
    throw new Error('Chưa cài gói @ngrok/ngrok. Chạy: npm install @ngrok/ngrok');
  }
  if (!opts.authtoken) {
    throw new Error('Thiếu ngrok authtoken. Nhập trong Cài đặt → Nhân viên → Kết nối.');
  }
  const domain = String(opts.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const listener = await ngrok.forward({
    addr: port,
    authtoken: opts.authtoken,
    ...(domain ? { domain } : {}),
    // SDK tự kết nối lại phiên ngrok khi mất mạng — chỉ ghi log
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
      try { await listener.close(); } catch { /* đã đóng */ }
    },
    onDeath: () => { /* ngrok tự kết nối lại */ },
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

/** Lên lịch chạy lại theo backoff; trả delay (ms) và số thứ tự lần thử. */
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
    // Đã tắt, hoặc replace() đã gắn tunnel khác trong lúc chờ → bỏ tunnel vừa bật
    if (!isCurrent(session) || shuttingDown || session.handle) {
      await handle.close();
      return;
    }
    // Phiên keepAlive chưa từng lên (vd mở app lúc chưa có mạng) → đây là lần bật đầu, không phải "chạy lại"
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
   * Bật tunnel cho một cổng (tunnel cũ của cổng đó bị tắt trước). Mặc định Cloudflare Quick Tunnel (URL tạm);
   * opts.provider = 'cloudflare_named' / 'ngrok' cho địa chỉ cố định. Trả URL công khai.
   * Lỗi → reject; nếu opts.keepAlive thì phiên vẫn giữ và tự thử lại (listener nhận URL khi lên).
   */
  async start(port: number, label?: string, opts?: TunnelOptions): Promise<string> {
    installQuitHook();
    if (shuttingDown) throw new Error('Ứng dụng đang thoát');

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
        throw new Error('Tunnel đã bị tắt trong lúc khởi động');
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
          // Không giữ phiên (nơi gọi tự báo lỗi). Listener đăng ký trước start() để lại cho lần start() sau.
          sessions.delete(port);
          if (session.listeners.size) pendingListeners.set(port, session.listeners);
        }
      }
      throw err;
    }
  },

  /**
   * Đổi cấu hình tunnel đang chạy mà không ngắt người đang dùng (make-before-break). Không có tunnel đang
   * chạy → như start(). Tunnel mới lỗi → reject, tunnel cũ giữ nguyên. Hai phiên ngrok không chạy song song
   * được (giới hạn phiên / trùng domain) → ngrok sang ngrok thì tắt rồi bật lại.
   */
  async replace(port: number, label?: string, opts?: TunnelOptions, graceMs: number = TUNNEL_SWITCH_GRACE_MS): Promise<string> {
    installQuitHook();
    if (shuttingDown) throw new Error('Ứng dụng đang thoát');
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
    const handle = await launch(port, nextOpts); // lỗi → tunnel cũ giữ nguyên
    if (!isCurrent(session) || shuttingDown) {
      await handle.close();
      throw new Error('Tunnel đã bị tắt trong lúc chuyển');
    }
    const old = session.handle;
    // Tunnel cũ có thể đã chết trong lúc chờ tunnel mới → huỷ lịch tự chạy lại của nó
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

  /** Tắt tunnel của một cổng (huỷ lịch tự chạy lại). Listener theo phiên nhận null rồi bị xoá. */
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

  /** App đang thoát: tắt mọi tunnel ngay, không tự chạy lại, không phát sự kiện (DB/cửa sổ đang đóng). */
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
   * Check if a specific tunnel is currently active (có địa chỉ dùng được).
   */
  isActive(port: number): boolean {
    return !!sessions.get(port)?.url;
  },

  /** Trạng thái chi tiết (null = cổng không có tunnel, kể cả đang chờ chạy lại thì vẫn có). */
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
   * Listener theo phiên: gọi với URL mới (hoặc null khi tunnel chết / tắt). Bị xoá khi stop()/start() tường
   * minh; đăng ký khi cổng chưa có tunnel thì start() kế tiếp nhận. Trả hàm huỷ.
   */
  onChange(port: number, cb: TunnelListener): () => void {
    const session = sessions.get(port);
    if (session && !session.stopped) {
      session.listeners.add(cb);
      return () => { session.listeners.delete(cb); };
    }
    return addListener(pendingListeners, port, cb);
  },

  /** Listener bền của cổng: mọi thay đổi (bật, chết, chạy lại, đổi, thử lại lỗi, tắt). Trả hàm huỷ. */
  watch(port: number, cb: TunnelListener): () => void {
    return addListener(watchers, port, cb);
  },
};

export default TunnelService;
