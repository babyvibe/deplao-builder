/**
 * Địa chỉ công khai (WAN) của Boss — phần thuần (không phụ thuộc Electron / React / DOM), dùng chung cho
 * main (TunnelService, HttpRelayService, BossAddressProbe, BossUrlAnnouncement) và renderer
 * (RelayStatusPanel, ApiOverviewPanel, InboundWebhooksPanel, TopBar). Test: src/__tests__/tunnelAddress.test.ts.
 *
 * Không dùng dịch vụ trung gian nào: địa chỉ mới chỉ đi từ Boss tới nhân viên qua kênh realtime đã xác thực
 * (Socket.IO của relay); nhân viên mất liên lạc thì tự nhập địa chỉ mới.
 */
import { backoffDelay, normalizeBossUrl } from './employeeConnection';

// ── Boss: tự chạy lại tunnel ────────────────────────────────────────

/** cloudflared thoát ngoài ý muốn → chạy lại sau 2 s, 5 s, 15 s, 30 s rồi giữ 60 s. */
export const TUNNEL_RESTART_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Tunnel chạy ổn định ít nhất ngần này rồi mới chết → lần chạy lại tính backoff lại từ đầu. */
export const TUNNEL_STABLE_UPTIME_MS = 120_000;

/**
 * Đổi cấu hình khi tunnel đang chạy (make-before-break): tunnel cũ được giữ thêm ngần này sau khi
 * tunnel mới sẵn sàng, để nhân viên đang nối qua địa chỉ cũ kịp nhận địa chỉ mới và chuyển sang.
 */
export const TUNNEL_SWITCH_GRACE_MS = 10_000;

/** Delay cho lần chạy lại thứ `attempt` (0-based); quá cuối lịch thì giữ 60 s. */
export function tunnelRestartDelay(attempt: number): number {
  return backoffDelay(attempt, TUNNEL_RESTART_BACKOFF_MS);
}

/**
 * Chỉ số backoff cho lần chạy lại kế tiếp khi tunnel vừa chết: đã chạy ổn định >= TUNNEL_STABLE_UPTIME_MS
 * thì về 0 (lần chết lẻ), còn chết liên tục thì giữ nguyên để delay tăng dần.
 */
export function nextRestartAttempt(previousAttempt: number, uptimeMs: number | null | undefined): number {
  if (typeof uptimeMs === 'number' && Number.isFinite(uptimeMs) && uptimeMs >= TUNNEL_STABLE_UPTIME_MS) return 0;
  return Number.isFinite(previousAttempt) && previousAttempt > 0 ? Math.floor(previousAttempt) : 0;
}

// ── Boss: loại địa chỉ theo cấu hình tunnel ─────────────────────────

export type TunnelProviderId = 'cloudflare' | 'ngrok' | 'cloudflare_named';

/** 'temporary' = URL ngẫu nhiên, đổi mỗi lần tunnel chạy lại; 'fixed' = địa chỉ không đổi. */
export type TunnelAddressKind = 'temporary' | 'fixed';

export const TUNNEL_KIND_LABEL: Record<TunnelAddressKind, string> = {
  fixed: 'Địa chỉ cố định',
  temporary: 'Địa chỉ tạm, đổi mỗi lần khởi động lại',
};

/**
 * Cloudflare Quick Tunnel → tạm; Cloudflare Tunnel có tài khoản (token) → cố định;
 * ngrok có domain tĩnh → cố định, không có domain → coi là tạm.
 */
export function tunnelAddressKind(provider: string | null | undefined, opts?: { domain?: string | null } | null): TunnelAddressKind {
  if (provider === 'cloudflare_named') return 'fixed';
  if (provider === 'ngrok') return String(opts?.domain ?? '').trim() ? 'fixed' : 'temporary';
  return 'temporary';
}

/** Hostname (chữ thường, không dấu chấm cuối) của một URL / "host:port"; '' nếu không đọc được. */
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
 * URL của Cloudflare Quick Tunnel do cloudflared in ra. Bỏ api.trycloudflare.com: cloudflared in địa chỉ API
 * này trong dòng lỗi ("failed to request quick Tunnel: Post https://api.trycloudflare.com/tunnel…"), gói
 * `cloudflared` lại phát nó thành sự kiện 'url'.
 */
export function isQuickTunnelUrl(raw: string | null | undefined): boolean {
  if (!/^https:\/\//i.test(String(raw ?? '').trim())) return false;
  const host = urlHost(raw);
  return /^[a-z0-9-]+\.trycloudflare\.com$/.test(host) && host !== 'api.trycloudflare.com';
}

/**
 * Kiểm tra cấu hình ingress mà cloudflared nhận từ dashboard (Tunnel có tài khoản): có Public Hostname trùng
 * địa chỉ BOSS đã nhập và trỏ đúng cổng relay không. Trả câu cảnh báo, hoặc null khi ổn / không đủ dữ liệu.
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
    return `Tunnel không có Public Hostname "${host}" (đang có: ${names}) — nhân viên sẽ không vào được địa chỉ này.`;
  }
  const service = String(rule.service ?? '').trim();
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?\/?$/i.exec(service);
  if (local) {
    const servicePort = Number(local[2] || (/^https:/i.test(service) ? 443 : 80));
    if (servicePort !== port) return `Public Hostname "${host}" đang trỏ tới ${service}, cần http://localhost:${port}.`;
  }
  return null;
}

// ── Nhân viên: phân loại địa chỉ Boss đã lưu ────────────────────────

/**
 * temporary — tunnel miễn phí có thể đổi URL khi Boss khởi động lại (trycloudflare.com, ngrok free, loca.lt)
 * fixed     — tên miền / IP công khai khác (Cloudflare Tunnel có tài khoản, ngrok trả phí…)
 * lan       — IP nội bộ, localhost, tên máy
 * invalid   — không đọc được
 */
export type BossAddressKind = 'temporary' | 'fixed' | 'lan' | 'invalid';
export type BossAddressProvider = 'cloudflare_quick' | 'ngrok_free' | 'localtunnel' | null;

export interface BossAddressInfo {
  kind: BossAddressKind;
  provider: BossAddressProvider;
  host: string;
  /** Đã chuẩn hoá bằng normalizeBossUrl ('' nếu invalid). */
  url: string;
}

const NGROK_FREE_SUFFIXES = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.io'];
const LOCALTUNNEL_SUFFIXES = ['.loca.lt', '.localtunnel.me'];

/** IP nội bộ (RFC 1918, loopback, link-local, CGNAT/VPN 100.64/10, IPv6 ULA), localhost, *.local, tên máy. */
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
 * Địa chỉ nhân viên dán vào mà thiếu http(s):// — tunnel / tên miền công khai dùng https (http của
 * trycloudflare chỉ trả redirect), còn LAN, IP hoặc có cổng riêng thì giữ http như normalizeBossUrl.
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

/** Tên ngắn của dịch vụ tunnel cho câu thông báo. */
export function bossAddressProviderLabel(info: BossAddressInfo): string {
  if (info.provider === 'cloudflare_quick') return 'trycloudflare.com';
  if (info.provider === 'ngrok_free') return 'ngrok miễn phí';
  if (info.provider === 'localtunnel') return 'loca.lt';
  return info.host;
}

/**
 * Tên miền dùng để kiểm tra "máy có mạng + DNS không" khi địa chỉ Boss không phân giải được: tên miền gốc
 * của chính dịch vụ tunnel đó còn phân giải được → địa chỉ tunnel đã mất thật, không phải do mất mạng.
 */
export function internetCheckHost(info: BossAddressInfo): string {
  if (info.provider === 'cloudflare_quick') return 'api.trycloudflare.com';
  if (info.provider === 'ngrok_free') return 'ngrok.com';
  if (info.provider === 'localtunnel') return 'loca.lt';
  return 'cloudflare.com';
}

// ── Nhân viên: thăm dò địa chỉ Boss ─────────────────────────────────

/**
 * reachable    — Boss trả lời /api/health
 * dead         — địa chỉ tunnel không còn: tên miền không tồn tại (mạng vẫn ổn), Cloudflare 530/1033 của
 *                Quick Tunnel, ngrok ERR_NGROK_3200 (endpoint offline), loca.lt 404
 * refused      — máy chủ từ chối kết nối (ECONNREFUSED)
 * boss-offline — tunnel vẫn trỏ đúng nhưng phần mềm Boss / relay không trả lời (502–504, ngrok 8012,
 *                530 của tunnel cố định) → địa chỉ không đổi, chờ Boss bật lại
 * no-network   — máy nhân viên mất mạng / DNS không trả lời
 * error        — lỗi khác (timeout, TLS, trang không phải của Boss…)
 */
export type BossProbeVerdict = 'reachable' | 'dead' | 'refused' | 'boss-offline' | 'no-network' | 'error';

export interface BossProbeEvidence {
  /** Mã lỗi phân giải tên miền của địa chỉ Boss (vd 'ENOTFOUND', 'EAI_AGAIN'). */
  dnsError?: string | null;
  /** internetCheckHost() phân giải được → mạng + DNS của máy vẫn ổn (null = chưa kiểm tra). */
  internetOk?: boolean | null;
  /** Mã lỗi kết nối HTTP (vd 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'). */
  connectError?: string | null;
  httpStatus?: number | null;
  /** Header ngrok-error-code của phản hồi. */
  ngrokError?: string | null;
  /** Phần đầu body (tìm mã lỗi Cloudflare 1033…). */
  body?: string | null;
  /** Body là JSON health của Boss ({ status: 'ok' }). */
  bossHealthOk?: boolean;
}

const DNS_NO_SUCH_HOST = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'ENONAME']);
const CONNECT_NO_NETWORK = new Set(['ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EAI_AGAIN', 'EAI_FAIL']);
/** Trang lỗi Cloudflare 1033 (Argo Tunnel error) / 1016 (Origin DNS error) — tunnel không còn connector. */
function isCloudflareTunnelGonePage(body: string | null | undefined): boolean {
  const text = String(body ?? '');
  return /\b(1033|1016)\b/.test(text) && /cloudflare|tunnel/i.test(text);
}

export function classifyBossProbe(info: BossAddressInfo, ev: BossProbeEvidence): BossProbeVerdict {
  if (ev.bossHealthOk) return 'reachable';

  const dns = String(ev.dnsError ?? '').toUpperCase();
  if (dns) {
    if (!DNS_NO_SUCH_HOST.has(dns)) return 'no-network'; // EAI_AGAIN, ETIMEOUT… — DNS không trả lời
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
    // Quick Tunnel mất connector là mất hẳn (lần sau cloudflared chạy ra URL khác); tunnel cố định thì chờ Boss
    return info.kind === 'temporary' ? 'dead' : 'boss-offline';
  }
  if (status === 502 || status === 503 || status === 504) return 'boss-offline';
  if (status === 404 && info.provider === 'localtunnel') return 'dead';
  return 'error';
}

/** Lý do (tiếng Việt, chữ thường đầu câu) để ghép vào thông báo cho nhân viên. */
export function describeBossProbe(verdict: BossProbeVerdict | null | undefined, info?: BossAddressInfo | null): string {
  switch (verdict) {
    case 'reachable': return 'BOSS đang trả lời';
    case 'dead': return info?.provider === 'ngrok_free'
      ? 'ngrok báo địa chỉ này đang offline'
      : 'địa chỉ tunnel này không còn tồn tại';
    case 'refused': return 'máy chủ từ chối kết nối';
    case 'boss-offline': return 'tunnel vẫn còn nhưng phần mềm BOSS chưa bật hoặc chưa bật Relay';
    case 'no-network': return 'máy bạn đang mất mạng hoặc DNS không trả lời';
    default: return 'BOSS không phản hồi';
  }
}

// ── Nhân viên: nhắc nhập địa chỉ mới ────────────────────────────────

/** Mất kết nối liên tục ít nhất ngần này mới thăm dò / nhắc địa chỉ đã đổi. */
export const DEAD_ADDRESS_AFTER_MS = 30_000;

/** Đang mất kết nối: thăm dò lại sau mỗi khoảng này. */
export const DEAD_ADDRESS_REPROBE_MS = 30_000;

/** Kết quả thăm dò cho thấy địa chỉ (không phải mạng của nhân viên) có vấn đề. */
export function isDeadAddressVerdict(verdict: BossProbeVerdict | null | undefined): boolean {
  return verdict === 'dead' || verdict === 'refused';
}

/**
 * Nhắc "Địa chỉ BOSS có thể đã đổi": chỉ với địa chỉ tunnel tạm, đã mất kết nối >= DEAD_ADDRESS_AFTER_MS và
 * thăm dò thấy địa chỉ chết (DNS không còn / tunnel offline / từ chối kết nối) — không nhắc khi mất mạng.
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

/** ms tới lần thăm dò kế tiếp (0 = ngay): lần đầu khi mất kết nối đủ DEAD_ADDRESS_AFTER_MS, sau đó mỗi REPROBE. */
export function nextBossProbeDelay(offlineSince: number, lastProbeAt: number | null | undefined, now: number): number {
  const firstAt = offlineSince + DEAD_ADDRESS_AFTER_MS;
  const dueAt = lastProbeAt && lastProbeAt >= offlineSince
    ? Math.max(firstAt, lastProbeAt + DEAD_ADDRESS_REPROBE_MS)
    : firstAt;
  return Math.max(0, dueAt - now);
}

// ── Boss → nhân viên: báo địa chỉ mới ───────────────────────────────

/** Kênh realtime Boss → nhân viên (Socket.IO 'event', channel này). */
export const BOSS_URL_CHANGED_EVENT = 'relay:bossUrlChanged';

/** IPC main → renderer phía nhân viên sau khi xử lý thông báo (payload EmployeeBossUrlChangedPayload). */
export const EMPLOYEE_BOSS_URL_CHANGED = 'employee:bossUrlChanged';

/** start = tunnel vừa bật (khác địa chỉ lần trước); restart = tự chạy lại sau khi chết; switch = Boss đổi cấu hình. */
export type BossUrlChangeReason = 'start' | 'restart' | 'switch';

export interface BossUrlChangedEvent {
  /** Địa chỉ cũ (đã chuẩn hoá) — nhân viên chỉ tự chuyển nếu đang dùng đúng địa chỉ này. */
  previousUrl: string;
  /** Địa chỉ mới (đã chuẩn hoá, luôn https). */
  newUrl: string;
  kind: TunnelAddressKind;
  reason: BossUrlChangeReason;
  at: number;
}

export interface EmployeeBossUrlChangedPayload extends BossUrlChangedEvent {
  workspaceId: string;
  /** true = main đã lưu địa chỉ mới vào cấu hình workspace và đang kết nối lại. */
  applied: boolean;
}

/** Đọc + kiểm tra payload 'relay:bossUrlChanged'. Địa chỉ mới phải là https (không hạ token xuống http). */
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
 * apply              — workspace đang dùng đúng địa chỉ cũ → lưu địa chỉ mới và kết nối lại
 * already-current    — đã dùng địa chỉ mới (vd sự kiện được phát lại khi catch-up) → bỏ qua
 * not-using-previous — workspace dùng địa chỉ khác (LAN…) → không đổi, chỉ báo cho người dùng biết
 */
export type AnnouncedUrlDecision = 'apply' | 'already-current' | 'not-using-previous';

export function decideAnnouncedBossUrl(savedUrl: string | null | undefined, event: BossUrlChangedEvent): AnnouncedUrlDecision {
  const saved = normalizeBossUrl(savedUrl);
  if (saved && saved === normalizeBossUrl(event.newUrl)) return 'already-current';
  if (saved && saved === normalizeBossUrl(event.previousUrl)) return 'apply';
  return 'not-using-previous';
}

// ── Trạng thái tunnel của relay (Boss UI) ───────────────────────────

export type RelayTunnelState = 'stopped' | 'starting' | 'active' | 'restarting';

/** relay:getTunnelStatus / relay:tunnelStatusUpdate / relay:getServerStatus().tunnel */
export interface RelayTunnelStatus {
  /** Có địa chỉ đang dùng được. */
  active: boolean;
  tunnelUrl: string | null;
  state: RelayTunnelState;
  /** Nhà cung cấp của tunnel đang chạy (null khi tắt). */
  provider: TunnelProviderId | null;
  kind: TunnelAddressKind | null;
  /** Số lần đã tự chạy lại trong phiên này. */
  restarts: number;
  /** Số lần thử liên tiếp trong lần mất hiện tại. */
  attempt: number;
  lastError: string | null;
  /** Thời điểm sẽ thử chạy lại (đang 'restarting'). */
  nextRetryAt: number | null;
  /** Cảnh báo cấu hình (vd Public Hostname không khớp). */
  warning: string | null;
  /** Địa chỉ trước khi đổi — chỉ có khi tunnelUrl là địa chỉ vừa đổi (so với lần chạy trước, kể cả trước khi tắt app). */
  previousUrl: string | null;
  urlChangedAt: number | null;
  changeReason: BossUrlChangeReason | null;
  /** "Tự bật tunnel khi mở app" (relay_tunnel_autostart). */
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

/** Hiện "Địa chỉ cho nhân viên đã đổi" khi địa chỉ đang chạy vừa đổi và BOSS chưa bấm "Đã gửi". */
export function shouldShowUrlChangedNotice(
  status: Pick<RelayTunnelStatus, 'tunnelUrl' | 'previousUrl'> | null | undefined,
  acknowledgedUrl: string | null | undefined,
): boolean {
  if (!status?.tunnelUrl || !status.previousUrl) return false;
  const current = normalizeBossUrl(status.tunnelUrl);
  if (current === normalizeBossUrl(status.previousUrl)) return false;
  return normalizeBossUrl(acknowledgedUrl) !== current;
}
