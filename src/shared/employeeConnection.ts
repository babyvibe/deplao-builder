/**
 * Vòng đời kết nối nhân viên ↔ Boss — phần thuần (không phụ thuộc Electron / React / DOM),
 * dùng chung cho main process (HttpConnectionManager, HttpClientService, SocketIOClient)
 * và renderer (App, TopBar, employeeStore). Test: src/__tests__/employeeConnection.test.ts.
 *
 * Nguồn sự thật DUY NHẤT cho Boss URL + token là cấu hình workspace ở main process.
 * Main phát các sự kiện IPC dưới đây; renderer chỉ làm theo (không tự giữ bản URL/token riêng).
 */

// ── Lịch backoff ────────────────────────────────────────────────────

/**
 * Socket.IO bị Boss TỪ CHỐI (middleware) hoặc Boss chủ động ngắt ('io server disconnect'):
 * Socket.IO không tự thử lại → tự lên lịch 1 s, 2 s, 5 s, 10 s, 30 s rồi giữ 30 s.
 */
export const SOCKET_RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Workspace kết nối thất bại (Boss tắt / mạng hỏng): thử lại sau 15 s, 30 s rồi giữ 60 s. */
export const WORKSPACE_RETRY_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000];

/** Mất kết nối lâu hơn ngưỡng này → khi có lại phải tải lại dữ liệu (employee:resync). */
export const RESYNC_GAP_MS = 10_000;

/** Heartbeat phải hỏng ít nhất ngần này lần liên tiếp mới tính là "mất kết nối" cần resync. */
export const HEARTBEAT_FAILURES_FOR_RESYNC = 2;

/**
 * Socket + heartbeat cùng hồi phục sau MỘT lần mất mạng (cách nhau tối đa 1 chu kỳ heartbeat 15 s)
 * → chỉ phát 1 employee:resync trong cửa sổ này.
 */
export const RESYNC_COALESCE_MS = 15_000;

/** Làm mới snapshot nhân viên (quyền / tài khoản được giao) tối đa 1 lần mỗi 10 s. */
export const SNAPSHOT_REFRESH_THROTTLE_MS = 10_000;

/** Thông báo hiển thị khi token hết hạn / bị Boss từ chối. */
export const AUTH_EXPIRED_MESSAGE = 'Phiên đăng nhập hết hạn — đăng nhập lại';

/** Delay cho lần thử thứ `attempt` (0-based); quá cuối lịch thì giữ giá trị cuối. */
export function backoffDelay(attempt: number, schedule: readonly number[]): number {
  if (!schedule.length) return 0;
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return schedule[Math.min(index, schedule.length - 1)];
}

// ── Boss URL + token ────────────────────────────────────────────────

/**
 * Chuẩn hoá Boss URL giống RestQueryService.normalizeBossUrl: thêm http:// nếu thiếu,
 * bỏ query/hash và '/' cuối, GIỮ sub-path. Rỗng → ''.
 */
export function normalizeBossUrl(raw: string | null | undefined): string {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return url.replace(/\/+$/, '');
  }
}

export interface BossCredentials {
  bossUrl?: string | null;
  token?: string | null;
}

/** true khi URL (sau chuẩn hoá) hoặc token khác nhau — chỉ khác cách viết URL thì KHÔNG tính là đổi. */
export function credentialsChanged(prev: BossCredentials | null | undefined, next: BossCredentials | null | undefined): boolean {
  return normalizeBossUrl(prev?.bossUrl) !== normalizeBossUrl(next?.bossUrl)
    || String(prev?.token ?? '') !== String(next?.token ?? '');
}

// ── Phân loại lỗi Socket.IO ─────────────────────────────────────────

/**
 * Thông điệp từ middleware xác thực của Boss (SocketIOService) mà đăng nhập lại mới hết:
 * token sai/hết hạn/thiếu, nhân viên bị xoá/khoá. 'Authentication failed' (lỗi phía Boss,
 * vd DB chưa sẵn sàng) KHÔNG nằm trong danh sách → được thử lại theo backoff.
 */
const AUTH_REJECTION_PATTERNS: readonly RegExp[] = [
  /invalid token/i,
  /missing auth token/i,
  /not found or inactive/i,
  /unauthori[sz]ed/i,
  /jwt (expired|malformed)/i,
  /token (expired|invalid)/i,
];

export function isAuthRejectionMessage(message: string | null | undefined): boolean {
  const text = String(message ?? '').trim();
  if (!text) return false;
  return AUTH_REJECTION_PATTERNS.some(pattern => pattern.test(text));
}

// ── Đăng nhập ───────────────────────────────────────────────────────

/** `code` Boss trả khi sai mật khẩu (EmployeeService.authenticate). Boss bản cũ chỉ có thông điệp 'Mật khẩu không đúng'. */
export const LOGIN_WRONG_PASSWORD_CODE = 'WRONG_PASSWORD';

/** Phản hồi đăng nhập là "sai mật khẩu" (không phải lỗi mạng / tài khoản bị khoá) → bỏ mật khẩu đã lưu. */
export function isWrongPasswordLogin(res: { success?: boolean; code?: unknown; error?: unknown } | null | undefined): boolean {
  if (!res || res.success) return false;
  if (res.code === LOGIN_WRONG_PASSWORD_CODE) return true;
  return /mật khẩu không đúng/i.test(String(res.error ?? ''));
}

// ── Resync sau khi mất kết nối ──────────────────────────────────────

/**
 * - socket-reconnect / heartbeat-recovered / system-resume / reconnect — kết nối hồi phục (xem các hàm bên dưới);
 * - boss-restart — catch-up Socket.IO: Boss đã khởi động lại (bootId khác) → event lúc mất kết nối không phát lại được;
 * - catchup-gap — catch-up Socket.IO: buffer của Boss không còn phủ vị trí của nhân viên (hoặc quá nhiều event);
 * - catchup-unverified — Boss bản cũ (không có bootId / không trả ack catch-up): không kiểm chứng được phần đã lỡ
 *   khi kết nối lại → tải lại cho chắc.
 */
export type EmployeeResyncReason =
  | 'socket-reconnect'
  | 'heartbeat-recovered'
  | 'system-resume'
  | 'reconnect'
  | 'boss-restart'
  | 'catchup-gap'
  | 'catchup-unverified';

/**
 * Lý do resync khi heartbeat thành công trở lại (null = không cần):
 * - vừa máy ngủ dậy (resume) → luôn resync, sau khi đã xác nhận Boss trả lời;
 * - heartbeat hỏng >= HEARTBEAT_FAILURES_FOR_RESYNC lần liên tiếp và mất kết nối > RESYNC_GAP_MS.
 * Một lần hỏng lẻ (Socket.IO vẫn nối) không cần resync — socket tự đo khoảng mất của nó.
 */
export function heartbeatResyncReason(input: {
  failuresBefore: number;
  gapMs: number;
  pendingWake: boolean;
}): EmployeeResyncReason | null {
  if (input.pendingWake) return 'system-resume';
  if (input.failuresBefore >= HEARTBEAT_FAILURES_FOR_RESYNC && input.gapMs > RESYNC_GAP_MS) return 'heartbeat-recovered';
  return null;
}

/** Socket.IO kết nối lại: chỉ resync khi trước đó đã từng nối và mất lâu hơn RESYNC_GAP_MS. */
export function socketResyncNeeded(gapMs: number | null | undefined): boolean {
  return typeof gapMs === 'number' && Number.isFinite(gapMs) && gapMs > RESYNC_GAP_MS;
}

// ── Throttle ────────────────────────────────────────────────────────

/** true nếu đã chạy trong `intervalMs` gần nhất (nên bỏ qua lần này). */
export function isThrottled(lastRunAt: number | null | undefined, now: number, intervalMs: number): boolean {
  if (!lastRunAt) return false;
  return now - lastRunAt < intervalMs;
}

/**
 * Cổng throttle theo key: trả true (và ghi nhận) nếu được phép chạy, false nếu còn trong cửa sổ.
 * `now` tiêm được để test.
 */
export function createThrottleGate(intervalMs: number, now: () => number = Date.now): (key?: string) => boolean {
  const lastRun = new Map<string, number>();
  return (key = 'default') => {
    const t = now();
    if (isThrottled(lastRun.get(key), t, intervalMs)) return false;
    lastRun.set(key, t);
    return true;
  };
}

// ── Badge trạng thái ở TopBar ───────────────────────────────────────

/**
 * online     — heartbeat main OK và REST không bị chặn (xanh)
 * recovering — heartbeat OK nhưng REST đang bị chặn / chưa có cấu hình, đang tự hồi phục (vàng)
 * offline    — heartbeat không tới được Boss (đỏ, hiện nút "Kết nối lại")
 * expired    — Boss từ chối token: phải đăng nhập lại (đỏ, hiện nút "Kết nối lại")
 */
export type EmployeeBadgeState = 'online' | 'recovering' | 'offline' | 'expired';

export function computeEmployeeBadgeState(input: {
  heartbeatOk: boolean;
  restBlocked: boolean;
  authExpired?: boolean;
}): EmployeeBadgeState {
  if (input.authExpired) return 'expired';
  if (!input.heartbeatOk) return 'offline';
  return input.restBlocked ? 'recovering' : 'online';
}

// ── Payload sự kiện IPC main → renderer ─────────────────────────────

export type EmployeeCredentialsReason = 'connected' | 'updated';

/** 'employee:credentials' — main vừa kết nối / đổi URL-token của một remote workspace. */
export interface EmployeeCredentialsEvent {
  workspaceId: string;
  /** Đã chuẩn hoá bằng normalizeBossUrl. */
  bossUrl: string;
  token: string;
  /** Workspace này đang active ở main lúc phát. */
  active: boolean;
  reason: EmployeeCredentialsReason;
}

/**
 * 'employee:resync' — kết nối vừa hồi phục sau khoảng mất > RESYNC_GAP_MS, máy vừa ngủ dậy, hoặc catch-up Socket.IO
 * không phát lại được phần đã lỡ (Boss khởi động lại / buffer không đủ / Boss bản cũ).
 */
export interface EmployeeResyncEvent {
  workspaceId: string;
  reason: EmployeeResyncReason;
  /** ms mất kết nối ước lượng (0 nếu không đo được). */
  gapMs: number;
  /** Date.now() lúc phát. */
  at: number;
}

/** 'workspace:connectionStatus' — trạng thái heartbeat/kết nối main của một remote workspace. */
export interface WorkspaceConnectionStatusEvent {
  workspaceId: string;
  connected: boolean;
  latency: number;
  /** Boss từ chối token → cần đăng nhập lại; main ngừng tự thử lại. */
  authExpired?: boolean;
  /** Đang nằm trong danh sách tự thử lại (backoff 15 s → 60 s). */
  retrying?: boolean;
  /** Bị Boss ngắt (relay:kicked). */
  kicked?: boolean;
  /** 'user-disconnect' khi người dùng bấm Ngắt kết nối; hoặc thông điệp lỗi / lý do kick. */
  reason?: string;
}
