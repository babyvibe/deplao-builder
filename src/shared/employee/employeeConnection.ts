/**
 * Employee ↔ Boss connection lifecycle: the pure part (no dependency on Electron / React / DOM),
 * shared by the main process (HttpConnectionManager, HttpClientService, SocketIOClient)
 * and the renderer (App, TopBar, employeeStore). Test: src/__tests__/employee/employeeConnection.test.ts.
 *
 * The ONLY source of truth for the Boss URL + token is the workspace config in the main process.
 * Main emits the IPC events below; the renderer only follows them (it keeps no URL/token copy of its own).
 */

// ── Backoff schedule ────────────────────────────────────────────────────

/**
 * Socket.IO is REJECTED by Boss (middleware) or Boss disconnects it on purpose ('io server disconnect'):
 * Socket.IO does not retry by itself, so we schedule our own retries at 1 s, 2 s, 5 s, 10 s, 30 s, then hold at 30 s.
 */
import { tr } from '../i18n';

export const SOCKET_RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Workspace connection failed (Boss off / network down): retry after 15 s, then 30 s, then hold at 60 s. */
export const WORKSPACE_RETRY_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000];

/** Losing the connection for longer than this threshold → data must be reloaded when it comes back (employee:resync). */
export const RESYNC_GAP_MS = 10_000;

/** The heartbeat must fail at least this many times in a row before it counts as "lost connection" that needs a resync. */
export const HEARTBEAT_FAILURES_FOR_RESYNC = 2;

/**
 * Socket and heartbeat recover together after ONE network drop (at most 1 heartbeat cycle of 15 s apart)
 * → emit only 1 employee:resync within this window.
 */
export const RESYNC_COALESCE_MS = 15_000;

/** Refresh the employee snapshot (permissions / assigned accounts) at most once every 10 s. */
export const SNAPSHOT_REFRESH_THROTTLE_MS = 10_000;

/** Message shown when the token expires / Boss rejects it. */
export const AUTH_EXPIRED_MESSAGE = tr('Phiên đăng nhập hết hạn — đăng nhập lại');

/** Delay for retry number `attempt` (0-based); past the end of the schedule, keep the last value. */
export function backoffDelay(attempt: number, schedule: readonly number[]): number {
  if (!schedule.length) return 0;
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return schedule[Math.min(index, schedule.length - 1)];
}

// ── Boss URL + token ────────────────────────────────────────────────

/**
 * Normalize the Boss URL the same way as RestQueryService.normalizeBossUrl: add http:// if missing,
 * drop the query/hash and the trailing '/', KEEP the sub-path. Empty → ''.
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

/** true when the URL (after normalizing) or the token differs. A URL that is only written differently does NOT count as a change. */
export function credentialsChanged(prev: BossCredentials | null | undefined, next: BossCredentials | null | undefined): boolean {
  return normalizeBossUrl(prev?.bossUrl) !== normalizeBossUrl(next?.bossUrl)
    || String(prev?.token ?? '') !== String(next?.token ?? '');
}

// ── Socket.IO error classification ─────────────────────────────────────────

/**
 * Messages from Boss's auth middleware (SocketIOService) that only a new login fixes:
 * wrong/expired/missing token, employee deleted/locked. 'Authentication failed' (a Boss-side error,
 * e.g. DB not ready yet) is NOT in the list → it is retried with backoff.
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

// ── Login ───────────────────────────────────────────────────────

/** `code` that Boss returns for a wrong password (EmployeeService.authenticate). Older Boss builds only send the message 'Mật khẩu không đúng' (Wrong password). */
export const LOGIN_WRONG_PASSWORD_CODE = 'WRONG_PASSWORD';

/** Login response is "sai mật khẩu" (wrong password), not a network error or a locked account → drop the saved password. */
export function isWrongPasswordLogin(res: { success?: boolean; code?: unknown; error?: unknown } | null | undefined): boolean {
  if (!res || res.success) return false;
  if (res.code === LOGIN_WRONG_PASSWORD_CODE) return true;
  return /mật khẩu không đúng/i.test(String(res.error ?? ''));
}

// ── Resync after losing the connection ──────────────────────────────────────

/**
 * - socket-reconnect / heartbeat-recovered / system-resume / reconnect: the connection recovered (see the functions below);
 * - boss-restart: Socket.IO catch-up, Boss restarted (different bootId) → events from the disconnect time cannot be replayed;
 * - catchup-gap: Socket.IO catch-up, Boss's buffer no longer covers the employee's position (or too many events);
 * - catchup-unverified: old Boss build (no bootId / no catch-up ack): cannot verify what was missed
 *   during the reconnect → reload to be safe.
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
 * Reason to resync when the heartbeat succeeds again (null = no resync needed):
 * - the machine just woke from sleep (resume) → always resync, after confirming that Boss responds;
 * - the heartbeat failed >= HEARTBEAT_FAILURES_FOR_RESYNC times in a row and the connection was lost > RESYNC_GAP_MS.
 * A single isolated failure (Socket.IO still connected) does not need a resync, since the socket measures its own gap.
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

/** Socket.IO reconnected: resync only if it had connected before and was down for longer than RESYNC_GAP_MS. */
export function socketResyncNeeded(gapMs: number | null | undefined): boolean {
  return typeof gapMs === 'number' && Number.isFinite(gapMs) && gapMs > RESYNC_GAP_MS;
}

// ── Throttle ────────────────────────────────────────────────────────

/** true if it already ran within the last `intervalMs` (so skip this time). */
export function isThrottled(lastRunAt: number | null | undefined, now: number, intervalMs: number): boolean {
  if (!lastRunAt) return false;
  return now - lastRunAt < intervalMs;
}

/**
 * Throttle gate per key: returns true (and records the run) if it may run, false if it is still inside the window.
 * `now` can be injected for tests.
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

// ── Status badge in TopBar ───────────────────────────────────────

/**
 * online     - main heartbeat OK and REST is not blocked (green)
 * recovering - heartbeat OK but REST is blocked / not configured yet, recovering on its own (yellow)
 * offline    - the heartbeat cannot reach Boss (red, shows the "Kết nối lại" (Reconnect) button)
 * expired    - Boss rejects the token: must log in again (red, shows the "Kết nối lại" (Reconnect) button)
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

// ── IPC event payloads, main → renderer ─────────────────────────────

export type EmployeeCredentialsReason = 'connected' | 'updated';

/** 'employee:credentials': main just connected to / changed the URL + token of a remote workspace. */
export interface EmployeeCredentialsEvent {
  workspaceId: string;
  /** Normalized with normalizeBossUrl. */
  bossUrl: string;
  token: string;
  /** This workspace was active in main when the event was emitted. */
  active: boolean;
  reason: EmployeeCredentialsReason;
}

/**
 * 'employee:resync': the connection just recovered after a gap > RESYNC_GAP_MS, the machine just woke from sleep, or the Socket.IO catch-up
 * could not replay what was missed (Boss restarted / buffer too small / old Boss build).
 */
export interface EmployeeResyncEvent {
  workspaceId: string;
  reason: EmployeeResyncReason;
  /** Estimated disconnect time in ms (0 if it cannot be measured). */
  gapMs: number;
  /** Date.now() at emit time. */
  at: number;
}

/** 'workspace:connectionStatus': heartbeat / main connection status of a remote workspace. */
export interface WorkspaceConnectionStatusEvent {
  workspaceId: string;
  connected: boolean;
  latency: number;
  /** Boss rejected the token → must log in again; main stops retrying on its own. */
  authExpired?: boolean;
  /** In the auto-retry list (backoff 15 s → 60 s). */
  retrying?: boolean;
  /** Kicked out by Boss (relay:kicked). */
  kicked?: boolean;
  /** 'user-disconnect' when the user clicks Disconnect; or an error message / kick reason. */
  reason?: string;
}
