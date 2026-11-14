/**
 * Boss's public address (WAN). A pure module (no dependency on Electron / React / DOM), shared by
 * main (TunnelService, HttpRelayService, BossAddressProbe, BossUrlAnnouncement) and the renderer
 * (Settings → Employees → Connection, ApiOverviewPanel, InboundWebhooksPanel, TopBar). Test: src/__tests__/cloudflare/tunnelAddress.test.ts.
 *
 * No intermediary service is used: the new address only goes from Boss to the employees over the authenticated realtime channel
 * (the relay's Socket.IO). An employee that loses contact enters the new address by hand.
 */
import { backoffDelay, normalizeBossUrl } from '../employee/employeeConnection';
import { tr } from '../i18n';

// ── Boss: restart the tunnel automatically ───────────────────────────────────

/** cloudflared exits unexpectedly → restarted after 2 s, 5 s, 15 s, 30 s, then held at 60 s. */
export const TUNNEL_RESTART_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

/** If the tunnel ran stably for at least this long before it died, the next restart starts the backoff again from the beginning. */
export const TUNNEL_STABLE_UPTIME_MS = 120_000;

/**
 * Config change while the tunnel is running (make-before-break): the old tunnel is kept for this extra time after the new tunnel is ready,
 * so employees still connected through the old address have time to pick up the new address and switch over.
 */
export const TUNNEL_SWITCH_GRACE_MS = 10_000;

/** Delay before restart number `attempt` (0-based); past the end of the schedule → hold at 60 s. */
export function tunnelRestartDelay(attempt: number): number {
  return backoffDelay(attempt, TUNNEL_RESTART_BACKOFF_MS);
}

/**
 * The backoff index for the next restart when the tunnel has just died: if it had run stably for >= TUNNEL_STABLE_UPTIME_MS,
 * it goes back to 0 (an isolated death). If it keeps dying, the index stays so the delay keeps growing.
 */
export function nextRestartAttempt(previousAttempt: number, uptimeMs: number | null | undefined): number {
  if (typeof uptimeMs === 'number' && Number.isFinite(uptimeMs) && uptimeMs >= TUNNEL_STABLE_UPTIME_MS) return 0;
  return Number.isFinite(previousAttempt) && previousAttempt > 0 ? Math.floor(previousAttempt) : 0;
}

// ── Boss: address type from the tunnel config ─────────────────────────

export type TunnelProviderId = 'cloudflare' | 'ngrok' | 'cloudflare_named';

/** 'temporary' = random URL, changes every time the tunnel restarts; 'fixed' = address that does not change. */
export type TunnelAddressKind = 'temporary' | 'fixed';

export const TUNNEL_KIND_LABEL: Record<TunnelAddressKind, string> = {
  fixed: 'Địa chỉ cố định',
  temporary: 'Địa chỉ tạm, đổi mỗi lần khởi động lại',
};

/**
 * Cloudflare Quick Tunnel → temporary; Cloudflare Tunnel with an account (token) → fixed;
 * ngrok with a static domain → fixed, without a domain → treated as temporary.
 */
export function tunnelAddressKind(provider: string | null | undefined, opts?: { domain?: string | null } | null): TunnelAddressKind {
  if (provider === 'cloudflare_named') return 'fixed';
  if (provider === 'ngrok') return String(opts?.domain ?? '').trim() ? 'fixed' : 'temporary';
  return 'temporary';
}

/** Hostname (lowercase, no trailing dot) of a URL / "host:port"; '' if it cannot be read. */
export function urlHost(raw: string | null | undefined): string {
  const url = normalizeBossUrl(raw);
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * URL of the Cloudflare Quick Tunnel printed by cloudflared. Ignore api.trycloudflare.com: cloudflared prints this API address
 * in an error line ("failed to request quick Tunnel: Post https://api.trycloudflare.com/tunnel…"), and the
 * `cloudflared` package emits it again as a 'url' event.
 */
export function isQuickTunnelUrl(raw: string | null | undefined): boolean {
  if (!/^https:\/\//i.test(String(raw ?? '').trim())) return false;
  const host = urlHost(raw);
  return /^[a-z0-9-]+\.trycloudflare\.com$/.test(host) && host !== 'api.trycloudflare.com';
}

/**
 * Checks the ingress config that cloudflared receives from the dashboard (Tunnel with an account): whether a Public Hostname matches
 * the BOSS address that was entered and points to the right relay port. Returns a warning sentence, or null when it is fine or there is not enough data.
 */
export function checkNamedTunnelIngress(config: unknown, publicUrl: string, port: number): string | null {
  const ingress = Array.isArray((config as any)?.ingress) ? (config as any).ingress as any[] : null;
  if (!ingress) return null;
  const host = urlHost(publicUrl);
  if (!host) return null;
  const rules = ingress.filter((rule) => rule && typeof rule.hostname === 'string' && rule.hostname.trim());
  if (!rules.length) return null;
  const rule = rules.find((r) => {
    const name = String(r.hostname).trim().toLowerCase();
    return name === host || (name.startsWith('*.') && host.endsWith(name.slice(1)));
  });
  if (!rule) {
    const names = rules.map((r) => String(r.hostname).trim()).join(', ');
    return tr('Tunnel không có Public Hostname "{{host}}" (đang có: {{names}}) — nhân viên sẽ không vào được địa chỉ này.', { host, names });
  }
  const service = String(rule.service ?? '').trim();
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?\/?$/i.exec(service);
  if (local) {
    const servicePort = Number(local[2] || (/^https:/i.test(service) ? 443 : 80));
    if (servicePort !== port) return tr('Public Hostname "{{host}}" đang trỏ tới {{service}}, cần http://localhost:{{port}}.', { host, service, port });
  }
  return null;
}

// ── Employee: classify the saved Boss address ────────────────────────

/**
 * temporary - a free tunnel can change its URL when Boss restarts (trycloudflare.com, ngrok free, loca.lt)
 * fixed     - another public domain / IP (Cloudflare Tunnel with an account, paid ngrok…)
 * lan       - internal IP, localhost, machine name
 * invalid   - cannot be read
 */
export type BossAddressKind = 'temporary' | 'fixed' | 'lan' | 'invalid';
export type BossAddressProvider = 'cloudflare_quick' | 'ngrok_free' | 'localtunnel' | null;

export interface BossAddressInfo {
  kind: BossAddressKind;
  provider: BossAddressProvider;
  host: string;
  /** Normalized with normalizeBossUrl ('' if invalid). */
  url: string;
}

const NGROK_FREE_SUFFIXES = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.io'];
const LOCALTUNNEL_SUFFIXES = ['.loca.lt', '.localtunnel.me'];

/** Internal IP (RFC 1918, loopback, link-local, CGNAT/VPN 100.64/10, IPv6 ULA), localhost, *.local, machine name. */
export function isLanHost(rawHost: string): boolean {
  const host = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  return !host.includes('.');
}

export function classifyBossUrl(raw: string | null | undefined): BossAddressInfo {
  const url = normalizeBossUrl(raw);
  const host = urlHost(url);
  if (!url || !host) return { kind: 'invalid', provider: null, host: '', url: '' };
  if (host.endsWith('.trycloudflare.com')) return { kind: 'temporary', provider: 'cloudflare_quick', host, url };
  if (NGROK_FREE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { kind: 'temporary', provider: 'ngrok_free', host, url };
  if (LOCALTUNNEL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { kind: 'temporary', provider: 'localtunnel', host, url };
  if (isLanHost(host)) return { kind: 'lan', provider: null, host, url };
  return { kind: 'fixed', provider: null, host, url };
}

/**
 * An address the employee pastes without http(s):// . Tunnels / public domains use https (the http of
 * trycloudflare only returns a redirect), while LAN, IP or addresses with their own port keep http, as in normalizeBossUrl.
 */
export function normalizePastedBossUrl(raw: string | null | undefined): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return normalizeBossUrl(text);
  const info = classifyBossUrl(text);
  if (info.kind === 'invalid') return '';
  const hasPort = /^(\[[^\]]+\]|[^/:]+):\d+(\/|$)/.test(text);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(info.host) || info.host.startsWith('[');
  if (info.kind === 'lan' || hasPort || isIp) return info.url;
  return normalizeBossUrl(`https://${text}`);
}

/** Short name of the tunnel service, for the notice sentence. */
export function bossAddressProviderLabel(info: BossAddressInfo): string {
  if (info.provider === 'cloudflare_quick') return 'trycloudflare.com';
  if (info.provider === 'ngrok_free') return tr('ngrok miễn phí');
  if (info.provider === 'localtunnel') return 'loca.lt';
  return info.host;
}

/**
 * Domain used to check "máy có mạng + DNS không" (whether the machine has network + DNS) when the Boss address does not resolve: the root domain
 * of the tunnel service itself still resolves → the tunnel address is really gone, not a network outage.
 */
export function internetCheckHost(info: BossAddressInfo): string {
  if (info.provider === 'cloudflare_quick') return 'api.trycloudflare.com';
  if (info.provider === 'ngrok_free') return 'ngrok.com';
  if (info.provider === 'localtunnel') return 'loca.lt';
  return 'cloudflare.com';
}

// ── Employee: probe the Boss address ─────────────────────────────────

/**
 * reachable    - Boss answers /api/health
 * dead         - the tunnel address is gone: the domain does not exist (the network is fine), Cloudflare 530/1033 of
 *                a Quick Tunnel, ngrok ERR_NGROK_3200 (endpoint offline), loca.lt 404
 * refused      - the server refuses the connection (ECONNREFUSED)
 * boss-offline - the tunnel still points to the right place, but the Boss software / relay does not answer (502-504, ngrok 8012,
 *                530 of a fixed tunnel) → the address does not change, wait for Boss to turn it back on
 * no-network   - the employee's machine lost network, or DNS does not answer
 * error        - other error (timeout, TLS, a page that is not Boss's...)
 */
export type BossProbeVerdict = 'reachable' | 'dead' | 'refused' | 'boss-offline' | 'no-network' | 'error';

export interface BossProbeEvidence {
  /** DNS lookup error code of the Boss address (e.g. 'ENOTFOUND', 'EAI_AGAIN'). */
  dnsError?: string | null;
  /** internetCheckHost() resolves → the machine's network + DNS are still fine (null = not checked yet). */
  internetOk?: boolean | null;
  /** HTTP connection error code (e.g. 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'). */
  connectError?: string | null;
  httpStatus?: number | null;
  /** The ngrok-error-code header of the response. */
  ngrokError?: string | null;
  /** Start of the body (to find the Cloudflare error code 1033…). */
  body?: string | null;
  /** The body is Boss's JSON health ({ status: 'ok' }). */
  bossHealthOk?: boolean;
}

const DNS_NO_SUCH_HOST = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'ENONAME']);
const CONNECT_NO_NETWORK = new Set(['ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EAI_AGAIN', 'EAI_FAIL']);
/** Cloudflare error page 1033 (Argo Tunnel error) / 1016 (Origin DNS error): the tunnel no longer has a connector. */
function isCloudflareTunnelGonePage(body: string | null | undefined): boolean {
  const text = String(body ?? '');
  return /\b(1033|1016)\b/.test(text) && /cloudflare|tunnel/i.test(text);
}

export function classifyBossProbe(info: BossAddressInfo, ev: BossProbeEvidence): BossProbeVerdict {
  if (ev.bossHealthOk) return 'reachable';

  const dns = String(ev.dnsError ?? '').toUpperCase();
  if (dns) {
    if (!DNS_NO_SUCH_HOST.has(dns)) return 'no-network'; // EAI_AGAIN, ETIMEOUT… - DNS does not answer
    if (ev.internetOk === true) return 'dead';
    if (ev.internetOk === false) return 'no-network';
    return 'error';
  }

  const connect = String(ev.connectError ?? '').toUpperCase();
  if (connect) {
    if (connect === 'ECONNREFUSED') return 'refused';
    if (CONNECT_NO_NETWORK.has(connect) || ev.internetOk === false) return 'no-network';
    return 'error';
  }

  const status = Number(ev.httpStatus) || 0;
  const ngrok = String(ev.ngrokError ?? '').toUpperCase();
  if (ngrok === 'ERR_NGROK_3200') return 'dead';
  if (ngrok === 'ERR_NGROK_8012') return 'boss-offline';
  if (status === 530 || (status >= 500 && isCloudflareTunnelGonePage(ev.body))) {
    // A Quick Tunnel that loses its connector is gone for good (the next cloudflared run gets another URL); a fixed tunnel waits for Boss
    return info.kind === 'temporary' ? 'dead' : 'boss-offline';
  }
  if (status === 502 || status === 503 || status === 504) return 'boss-offline';
  if (status === 404 && info.provider === 'localtunnel') return 'dead';
  return 'error';
}

/** Reason (Vietnamese text, lowercase first letter) to append to the employee notice. */
export function describeBossProbe(verdict: BossProbeVerdict | null | undefined, info?: BossAddressInfo | null): string {
  switch (verdict) {
    case 'reachable': return tr('BOSS đang trả lời');
    case 'dead': return info?.provider === 'ngrok_free'
      ? tr('ngrok báo địa chỉ này đang offline')
      : tr('địa chỉ tunnel này không còn tồn tại');
    case 'refused': return tr('máy chủ từ chối kết nối');
    case 'boss-offline': return tr('tunnel vẫn còn nhưng phần mềm BOSS chưa bật hoặc chưa bật Relay');
    case 'no-network': return tr('máy bạn đang mất mạng hoặc DNS không trả lời');
    default: return tr('BOSS không phản hồi');
  }
}

// ── Employee: prompt to enter the new address ────────────────────────────────

/** Only probe / prompt about a changed address after the connection has been lost continuously for at least this long. */
export const DEAD_ADDRESS_AFTER_MS = 30_000;

/** While the connection is lost: probe again after each of this interval. */
export const DEAD_ADDRESS_REPROBE_MS = 30_000;

/** The probe result shows that the address (not the employee's network) has a problem. */
export function isDeadAddressVerdict(verdict: BossProbeVerdict | null | undefined): boolean {
  return verdict === 'dead' || verdict === 'refused';
}

/**
 * Prompt "Địa chỉ BOSS có thể đã đổi" (the BOSS address may have changed): only for a temporary tunnel address, disconnected for >= DEAD_ADDRESS_AFTER_MS, and
 * the probe finds the address dead (DNS gone / tunnel offline / connection refused). No prompt when the network is down.
 */
export function shouldSuggestNewBossAddress(input: {
  info: BossAddressInfo;
  offlineSince: number | null | undefined;
  now: number;
  verdict: BossProbeVerdict | null | undefined;
}): boolean {
  if (input.info.kind !== 'temporary') return false;
  if (!input.offlineSince || input.now - input.offlineSince < DEAD_ADDRESS_AFTER_MS) return false;
  return isDeadAddressVerdict(input.verdict);
}

/** ms until the next probe (0 = now): the first one when the disconnection reaches DEAD_ADDRESS_AFTER_MS, then every REPROBE. */
export function nextBossProbeDelay(offlineSince: number, lastProbeAt: number | null | undefined, now: number): number {
  const firstAt = offlineSince + DEAD_ADDRESS_AFTER_MS;
  const dueAt = lastProbeAt && lastProbeAt >= offlineSince
    ? Math.max(firstAt, lastProbeAt + DEAD_ADDRESS_REPROBE_MS)
    : firstAt;
  return Math.max(0, dueAt - now);
}

// ── Boss → employees: announce the new address ───────────────────────────────

/** Realtime channel from Boss to employees (Socket.IO 'event', this channel). */
export const BOSS_URL_CHANGED_EVENT = 'relay:bossUrlChanged';

/** IPC from main to the employee-side renderer after the notice is handled (payload EmployeeBossUrlChangedPayload). */
export const EMPLOYEE_BOSS_URL_CHANGED = 'employee:bossUrlChanged';

/** start = tunnel just turned on (different from last time's address); restart = automatically restarted after dying; switch = Boss changed the config. */
export type BossUrlChangeReason = 'start' | 'restart' | 'switch';

export interface BossUrlChangedEvent {
  /** Old address (normalized): the employee only switches on their own if they are using exactly this address. */
  previousUrl: string;
  /** New address (normalized, always https). */
  newUrl: string;
  kind: TunnelAddressKind;
  reason: BossUrlChangeReason;
  at: number;
}

export interface EmployeeBossUrlChangedPayload extends BossUrlChangedEvent {
  workspaceId: string;
  /** true = main has saved the new address in the workspace config and is reconnecting. */
  applied: boolean;
}

/** Read and validate the 'relay:bossUrlChanged' payload. The new address must be https (never downgrade the token to http). */
export function parseBossUrlChangedEvent(raw: unknown): BossUrlChangedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const rawNew = typeof data.newUrl === 'string' ? data.newUrl.trim() : '';
  const rawPrevious = typeof data.previousUrl === 'string' ? data.previousUrl.trim() : '';
  if (!rawNew || !rawPrevious || rawNew.length > 300 || rawPrevious.length > 300) return null;
  if (!/^https:\/\//i.test(rawNew)) return null;
  const newUrl = normalizeBossUrl(rawNew);
  const previousUrl = normalizeBossUrl(rawPrevious);
  if (!urlHost(newUrl) || !urlHost(previousUrl) || newUrl === previousUrl) return null;
  const kind: TunnelAddressKind = data.kind === 'fixed' ? 'fixed' : 'temporary';
  const reason: BossUrlChangeReason = data.reason === 'start' || data.reason === 'switch' ? data.reason : 'restart';
  const at = typeof data.at === 'number' && Number.isFinite(data.at) ? data.at : 0;
  return { previousUrl, newUrl, kind, reason, at };
}

/**
 * apply              - the workspace uses exactly the old address → save the new address and reconnect
 * already-current    - already uses the new address (e.g. the event was replayed during catch-up) → skip
 * not-using-previous - the workspace uses another address (LAN…) → no change, only tell the user
 */
export type AnnouncedUrlDecision = 'apply' | 'already-current' | 'not-using-previous';

export function decideAnnouncedBossUrl(savedUrl: string | null | undefined, event: BossUrlChangedEvent): AnnouncedUrlDecision {
  const saved = normalizeBossUrl(savedUrl);
  if (saved && saved === normalizeBossUrl(event.newUrl)) return 'already-current';
  if (saved && saved === normalizeBossUrl(event.previousUrl)) return 'apply';
  return 'not-using-previous';
}

// ── Relay tunnel status (Boss UI) ───────────────────────────

export type RelayTunnelState = 'stopped' | 'starting' | 'active' | 'restarting';

/** relay:getTunnelStatus / relay:tunnelStatusUpdate / relay:getServerStatus().tunnel */
export interface RelayTunnelStatus {
  /** Whether an address is usable now. */
  active: boolean;
  tunnelUrl: string | null;
  state: RelayTunnelState;
  /** Provider of the running tunnel (null when off). */
  provider: TunnelProviderId | null;
  kind: TunnelAddressKind | null;
  /** Number of automatic restarts in this session. */
  restarts: number;
  /** Number of consecutive attempts in the current outage. */
  attempt: number;
  lastError: string | null;
  /** When the next restart attempt will happen (while 'restarting'). */
  nextRetryAt: number | null;
  /** Config warning (e.g. Public Hostname does not match). */
  warning: string | null;
  /** Address before the change: only present when tunnelUrl is the address that just changed (compared with the last run, including before the app was closed). */
  previousUrl: string | null;
  urlChangedAt: number | null;
  changeReason: BossUrlChangeReason | null;
  /** "Tự bật tunnel khi mở app" (start the tunnel when the app opens): relay_tunnel_autostart. */
  autoStart: boolean;
}

export const STOPPED_RELAY_TUNNEL: RelayTunnelStatus = {
  active: false,
  tunnelUrl: null,
  state: 'stopped',
  provider: null,
  kind: null,
  restarts: 0,
  attempt: 0,
  lastError: null,
  nextRetryAt: null,
  warning: null,
  previousUrl: null,
  urlChangedAt: null,
  changeReason: null,
  autoStart: false,
};

/** Show "Địa chỉ cho nhân viên đã đổi" (the address for employees has changed) when the running address just changed and BOSS has not clicked "Đã gửi" (Sent). */
export function shouldShowUrlChangedNotice(
  status: Pick<RelayTunnelStatus, 'tunnelUrl' | 'previousUrl'> | null | undefined,
  acknowledgedUrl: string | null | undefined,
): boolean {
  if (!status?.tunnelUrl || !status.previousUrl) return false;
  const current = normalizeBossUrl(status.tunnelUrl);
  if (current === normalizeBossUrl(status.previousUrl)) return false;
  return normalizeBossUrl(acknowledgedUrl) !== current;
}
