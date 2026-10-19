/**
 * RestQueryService - Employee-side REST client (renderer).
 * Dùng trong employee mode để gọi REST API lên Boss. Boss/standalone mode không dùng file này.
 *
 * Singleton. Phân loại kết quả (xem exchange() + interpret()):
 *  - CHỈ lỗi transport tính vào mất kết nối: fetch reject, timeout/abort (gồm cả lúc đọc body),
 *    HTTP 502/503/504 (gateway/tunnel). 3 lỗi liên tiếp → "blocked": request trả NOT_CONNECTED ngay,
 *    trừ tối đa 1 request thật mỗi ~2 s được đi qua làm probe; health probe chạy sau 1 s rồi backoff
 *    2/4/8 s (tối đa 15 s). Khi kết nối lại → status listener (true) + onRecovered.
 *  - KHÔNG tính: 2xx sai hình dạng (data:null, JSON lỗi), 4xx/5xx khác, 401/403. Body không phải JSON
 *    → BAD_RESPONSE (kèm status). Mọi phản hồi JSON từ Boss (kể cả 4xx/5xx) chứng minh mạng ổn → reset bộ đếm.
 *  - postBinary: lỗi transport KHÔNG tính (upload lớn có thể bị proxy/tunnel cắt riêng lẻ), thành công vẫn tính.
 *
 * Log: warn/error + sự kiện chuyển trạng thái đi qua Logger → IPC 'log:append' → Nhật ký (main) với
 * prefix [renderer]. Không bao giờ log token / query / body — chỉ method + path + status + thời gian.
 */

import Logger from '../../utils/Logger';

export type RestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RestOptions {
  method: RestMethod;
  path: string;
  query?: Record<string, any>;
  body?: any;
  timeout?: number;
}

export interface RestResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  /** HTTP status khi lỗi đến từ một phản hồi HTTP (BAD_RESPONSE, HTTP_xxx, ACCOUNT_FORBIDDEN…). */
  status?: number;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export type RestStatusListener = (connected: boolean, latency: number) => void;

/** Số lỗi transport liên tiếp trước khi chặn request (blocked). */
export const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** Lịch health probe khi blocked: 1 s, rồi backoff 2/4/8 s, tối đa 15 s. */
const RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Khi blocked: tối đa 1 request thật được đi qua mỗi ~2 s để thử kết nối (probe-through). */
const PROBE_THROUGH_INTERVAL_MS = 2_000;
/** Lỗi gateway (tunnel/proxy không tới được Boss) — Boss không bao giờ tự trả các mã này. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const NOT_CONNECTED_ERROR = 'Chưa kết nối tới BOSS';
/** Host tunnel ngrok (free/paid) — chèn trang cảnh báo trình duyệt nếu thiếu header bỏ qua. */
const NGROK_HOST_SUFFIXES = ['ngrok-free.app', 'ngrok-free.dev', 'ngrok.app', 'ngrok.io'];

// ── URL / header helpers (export cho test) ─────────────────────────

/** Chuẩn hoá Boss URL: thêm http:// nếu thiếu, bỏ query/hash và '/' cuối — GIỮ sub-path (vd https://host/boss). */
export function normalizeBossUrl(raw: string): string {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return url.replace(/\/+$/, '');
  }
}

/**
 * Ghép Boss URL (có thể có sub-path) + path API (có thể kèm query sẵn) + query object.
 * Nối chuỗi thay vì new URL(path, base) — cách cũ làm rơi sub-path. Ném lỗi nếu URL không hợp lệ.
 */
export function buildBossUrl(baseUrl: string, path: string, query?: Record<string, any>): string {
  const p = String(path ?? '');
  const url = new URL(`${baseUrl}${p.startsWith('/') ? p : `/${p}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
  }
  return url.toString();
}

/**
 * Header vượt trang cảnh báo tunnel — CHỈ cho host tunnel. Boss bản cũ từ chối header lạ ở CORS
 * preflight, nên tuyệt đối không gửi cho LAN / host khác.
 */
export function tunnelBypassHeaders(baseUrl: string): Record<string, string> {
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return {}; }
  const isHost = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  if (NGROK_HOST_SUFFIXES.some(isHost)) return { 'ngrok-skip-browser-warning': '1' };
  if (isHost('loca.lt')) return { 'Bypass-Tunnel-Reminder': '1' };
  return {};
}

/** Path để log: bỏ query string (có thể chứa id tài khoản / từ khoá tìm kiếm). */
function pathForLog(path: string): string {
  const p = String(path ?? '');
  const i = p.indexOf('?');
  return i >= 0 ? p.slice(0, i) : p;
}

function fmtSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

type LogKind = 'log' | 'notice' | 'warn' | 'error';

/**
 * Ghi log an toàn — lỗi của logger không bao giờ làm hỏng request.
 * warn/error/notice được Logger chuyển về Nhật ký (main); log chỉ ở console dev.
 */
function log(kind: LogKind, msg: string): void {
  try {
    const target: any = Logger;
    const fn = target?.[kind] ?? target?.log;
    if (typeof fn === 'function') fn.call(target, msg);
  } catch { /* ignore */ }
}

function dispatchWindowEvent(name: string, detail: any): void {
  try {
    const g: any = globalThis as any;
    const w = g.window;
    const CustomEventCtor = g.CustomEvent;
    if (!w || typeof w.dispatchEvent !== 'function' || typeof CustomEventCtor !== 'function') return;
    w.dispatchEvent(new CustomEventCtor(name, { detail }));
  } catch { /* listener lỗi không ảnh hưởng request */ }
}

function pickCode(json: any): string {
  if (typeof json?.code === 'string' && json.code) return json.code;
  if (typeof json?.error?.code === 'string' && json.error.code) return json.error.code;
  return '';
}

function pickError(json: any): string {
  if (typeof json?.error === 'string' && json.error) return json.error;
  if (typeof json?.error?.message === 'string' && json.error.message) return json.error.message;
  if (typeof json?.message === 'string' && json.message) return json.message;
  return '';
}

// ── Low-level exchange: fetch + đọc body dưới CÙNG một timeout ─────

type Exchange =
  | { kind: 'json'; status: number; ok: boolean; json: any; elapsed: number }
  | { kind: 'binary'; status: number; blob: any; elapsed: number }
  | { kind: 'invalid'; status: number; contentType: string; reason: 'content-type' | 'parse' | 'shape'; elapsed: number }
  | { kind: 'gateway'; status: number; elapsed: number }
  | { kind: 'timeout'; elapsed: number }
  | { kind: 'network'; message: string; elapsed: number };

function isBinaryContentType(ct: string): boolean {
  return ct.includes('application/octet-stream') || ct.includes('image/') || ct.includes('video/') || ct.includes('audio/');
}

function discardBody(res: any): void {
  try {
    const p = res?.body?.cancel?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

/**
 * Timer bắt đầu ngay trước fetch và bao cả lúc đọc body: body treo cũng bị abort.
 * Không bao giờ throw — mọi kết cục được trả về dạng Exchange.
 */
async function exchange(url: string, init: Record<string, any>, timeoutMs: number, allowBinary: boolean): Promise<Exchange> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* ignore */ }
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  deadline.catch(() => { /* kết cục timeout xử lý qua cờ timedOut */ });
  const start = Date.now();
  try {
    const res: any = await Promise.race([fetch(url, { ...init, signal: controller.signal } as any), deadline]);
    const status = Number(res?.status) || 0;
    const ok = typeof res?.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
    const contentType = String(res?.headers?.get?.('content-type') || '').toLowerCase();
    const mime = contentType.split(';')[0].trim();
    if (GATEWAY_STATUSES.has(status)) {
      discardBody(res);
      return { kind: 'gateway', status, elapsed: Date.now() - start };
    }
    if (ok && allowBinary && isBinaryContentType(contentType)) {
      const blob = await Promise.race([res.blob(), deadline]);
      return { kind: 'binary', status, blob, elapsed: Date.now() - start };
    }
    if (mime && !mime.includes('json')) {
      // HTML (trang cảnh báo tunnel, lỗi proxy…) — không parse, không đọc nội dung.
      discardBody(res);
      return { kind: 'invalid', status, contentType: mime, reason: 'content-type', elapsed: Date.now() - start };
    }
    const text: string = await Promise.race([res.text(), deadline]);
    const elapsed = Date.now() - start;
    if (typeof text !== 'string' || !text.trim()) {
      // Body rỗng (vd 204): coi như thành công/thất bại theo status
      return { kind: 'json', status, ok, json: { success: ok }, elapsed };
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'invalid', status, contentType: mime || 'unknown', reason: 'parse', elapsed };
    }
    if (json === null || typeof json !== 'object') {
      return { kind: 'invalid', status, contentType: mime || 'unknown', reason: 'shape', elapsed };
    }
    return { kind: 'json', status, ok, json, elapsed };
  } catch (err: any) {
    const elapsed = Date.now() - start;
    if (timedOut) return { kind: 'timeout', elapsed };
    return { kind: 'network', message: String(err?.message || err || 'Network error'), elapsed };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type HealthResult = { kind: 'ok'; latency: number } | { kind: 'fail' | 'neutral'; code: string };

class RestQueryService {
  private static instance: RestQueryService;
  private baseUrl: string = '';
  private token: string = '';
  private tunnelHeaders: Record<string, string> = {};
  /** Tăng mỗi lần init đổi cấu hình / reset → bỏ qua kết quả của request/probe cũ. */
  private generation = 0;
  private consecutiveFailures = 0;
  private lastFailure = '';
  private blocked = false;
  private blockedAt = 0;
  private recoveryAttempt = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthProbeInFlight = false;
  private probeThroughInFlight = false;
  private lastProbeThroughAt = 0;
  /** Có request bị từ chối / vừa bị chặn → lần thành công kế tiếp sẽ gọi onRecovered (1 lần). */
  private recoveryPending = false;
  private refusedCount = 0;
  private refusalLogged = false;
  private readonly statusListeners = new Set<{ cb: RestStatusListener }>();
  private legacyStatusListener: RestStatusListener | null = null;
  private readonly recoveredListeners = new Set<{ cb: () => void }>();

  public static getInstance(): RestQueryService {
    if (!RestQueryService.instance) {
      RestQueryService.instance = new RestQueryService();
    }
    return RestQueryService.instance;
  }

  // ── Listeners ────────────────────────────────────────────────────

  /**
   * @deprecated Dùng addStatusListener (nhiều listener). Giữ để tương thích: đây là MỘT slot riêng,
   * gọi lại sẽ thay callback trước của slot này (không ảnh hưởng listener của addStatusListener).
   */
  public setOnStatusChange(cb: RestStatusListener | null): void {
    this.legacyStatusListener = typeof cb === 'function' ? cb : null;
  }

  /** Đăng ký listener trạng thái kết nối (nhiều listener cùng lúc). Trả về hàm huỷ đăng ký. */
  public addStatusListener(cb: RestStatusListener): () => void {
    const entry = { cb };
    this.statusListeners.add(entry);
    return () => { this.statusListeners.delete(entry); };
  }

  /**
   * Gọi 1 lần mỗi khi client từ mất kết nối / blocked (hoặc request bị từ chối vì chưa init) trở lại
   * kết nối được — qua health probe hoặc request thành công. Data loader dùng để tải lại. Trả về hàm huỷ.
   */
  public onRecovered(cb: () => void): () => void {
    const entry = { cb };
    this.recoveredListeners.add(entry);
    return () => { this.recoveredListeners.delete(entry); };
  }

  private notifyStatus(connected: boolean, latency: number): void {
    for (const entry of Array.from(this.statusListeners)) {
      try { entry.cb(connected, latency); } catch { /* listener lỗi không ảnh hưởng listener khác */ }
    }
    try { this.legacyStatusListener?.(connected, latency); } catch { /* ignore */ }
  }

  private emitRecovered(): void {
    for (const entry of Array.from(this.recoveredListeners)) {
      try { entry.cb(); } catch { /* ignore */ }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Khởi tạo với Boss URL + JWT token. Idempotent: cùng URL + token → không reset gì.
   * Khác → cấu hình lại, reset bộ đếm, khởi động lại health check.
   */
  public init(baseUrl: string, token: string): void {
    const url = normalizeBossUrl(baseUrl);
    const tok = typeof token === 'string' ? token : String(token ?? '');
    if (url && tok && url === this.baseUrl && tok === this.token) {
      log('log', '[RestQueryService] init: cấu hình không đổi — giữ nguyên trạng thái');
      return;
    }

    const previousUrl = this.baseUrl;
    this.generation++;
    this.stopRecoveryProbe();
    this.baseUrl = url;
    this.token = tok;
    this.tunnelHeaders = url ? tunnelBypassHeaders(url) : {};
    this.consecutiveFailures = 0;
    this.lastFailure = '';
    this.blocked = false;
    this.blockedAt = 0;
    this.recoveryAttempt = 0;
    this.healthProbeInFlight = false;
    this.probeThroughInFlight = false;
    this.lastProbeThroughAt = 0;
    if (previousUrl && previousUrl !== url) {
      // Boss khác = phiên mới (luồng chuyển workspace tự tải lại) → không báo onRecovered cho phiên cũ.
      this.recoveryPending = false;
      this.refusedCount = 0;
      this.refusalLogged = false;
    }
    this.startHealthCheck();
    const tunnel = Object.keys(this.tunnelHeaders).length ? ', tunnel' : '';
    log('notice', `[RestQueryService] Initialized: ${url || '(trống)'} (${tok ? 'có token' : 'THIẾU token'}${tunnel})`);
    this.notifyStatus(this.isConnected(), 0);
  }

  /** Reset (khi logout). Listener vẫn giữ nguyên. */
  public reset(): void {
    this.generation++;
    this.stopHealthCheck();
    this.stopRecoveryProbe();
    this.baseUrl = '';
    this.token = '';
    this.tunnelHeaders = {};
    this.consecutiveFailures = 0;
    this.lastFailure = '';
    this.blocked = false;
    this.blockedAt = 0;
    this.recoveryAttempt = 0;
    this.healthProbeInFlight = false;
    this.probeThroughInFlight = false;
    this.lastProbeThroughAt = 0;
    this.recoveryPending = false;
    this.refusedCount = 0;
    this.refusalLogged = false;
    log('notice', '[RestQueryService] Reset');
    this.notifyStatus(false, 0);
  }

  public isConnected(): boolean {
    return !!this.baseUrl && !!this.token && !this.blocked;
  }

  /** true khi đang chặn request vì lỗi transport liên tiếp (chỉ 1 request/~2 s được đi làm probe). */
  public isBlocked(): boolean {
    return this.blocked;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getToken(): string {
    return this.token;
  }

  // ── Health check (15 s khi đang kết nối) ─────────────────────────

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(() => { void this.healthTick(); }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async healthTick(): Promise<void> {
    if (!this.baseUrl || !this.token) return;
    if (this.blocked) return;                    // recovery probe đang lo
    if (this.consecutiveFailures === 0) return;  // khoẻ → không tạo traffic thừa
    if (this.healthProbeInFlight) return;
    const gen = this.generation;
    this.healthProbeInFlight = true;
    try {
      const r = await this.probeHealth();
      if (gen !== this.generation) return;
      if (r.kind === 'ok') this.onTransportOk(gen, r.latency, 'health check');
      else if (r.kind === 'fail') this.onTransportFailure(gen, `GET /api/health → ${r.code}`);
    } finally {
      if (gen === this.generation) this.healthProbeInFlight = false;
    }
  }

  private async probeHealth(): Promise<HealthResult> {
    let url: string;
    try { url = buildBossUrl(this.baseUrl, '/api/health'); } catch { return { kind: 'neutral', code: 'INVALID_URL' }; }
    const ex = await exchange(url, { method: 'GET', headers: this.buildHeaders(false) }, HEALTH_PROBE_TIMEOUT_MS, false);
    switch (ex.kind) {
      case 'json':
      case 'binary':
        return { kind: 'ok', latency: ex.elapsed };
      case 'invalid':
        return { kind: 'neutral', code: `BAD_RESPONSE ${ex.status}` };
      case 'gateway':
        return { kind: 'fail', code: `HTTP_${ex.status}` };
      case 'timeout':
        return { kind: 'fail', code: 'TIMEOUT' };
      default:
        return { kind: 'fail', code: 'NETWORK_ERROR' };
    }
  }

  // ── Blocked / recovery ───────────────────────────────────────────

  private scheduleRecoveryProbe(): void {
    this.stopRecoveryProbe();
    const delay = RECOVERY_DELAYS_MS[Math.min(this.recoveryAttempt, RECOVERY_DELAYS_MS.length - 1)];
    const gen = this.generation;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.runRecoveryProbe(gen);
    }, delay);
  }

  private stopRecoveryProbe(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private async runRecoveryProbe(gen: number): Promise<void> {
    if (gen !== this.generation || !this.blocked) return;
    this.recoveryAttempt++;
    const attempt = this.recoveryAttempt;
    const r = await this.probeHealth();
    if (gen !== this.generation || !this.blocked) return; // đã cấu hình lại / đã hồi phục qua probe-through
    if (r.kind === 'ok') {
      this.onTransportOk(gen, r.latency, 'health probe');
      return;
    }
    if (r.kind === 'fail') this.onTransportFailure(gen, `GET /api/health → ${r.code}`);
    const next = RECOVERY_DELAYS_MS[Math.min(this.recoveryAttempt, RECOVERY_DELAYS_MS.length - 1)];
    log('log', `[RestQueryService] health probe #${attempt} thất bại (${r.code}) — thử lại sau ${fmtSeconds(next)}`);
    this.scheduleRecoveryProbe();
  }

  private enterBlocked(): void {
    this.blocked = true;
    this.blockedAt = Date.now();
    this.lastProbeThroughAt = this.blockedAt;
    this.recoveryAttempt = 0;
    this.recoveryPending = true;
    this.refusedCount = 0;
    log('warn', `[RestQueryService] DISCONNECTED (blocked) — ${this.consecutiveFailures} lỗi kết nối liên tiếp`
      + ` (gần nhất: ${this.lastFailure}); chặn request, health probe sau ${fmtSeconds(RECOVERY_DELAYS_MS[0])}`);
    this.notifyStatus(false, 0);
    this.scheduleRecoveryProbe();
  }

  private onTransportFailure(gen: number, what: string): void {
    if (gen !== this.generation) return;
    this.consecutiveFailures++;
    this.lastFailure = what;
    if (!this.blocked && this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.enterBlocked();
  }

  /** Boss trả lời (JSON bất kỳ status, binary 2xx) → mạng ổn: reset bộ đếm, gỡ blocked, báo onRecovered. */
  private onTransportOk(gen: number, latency: number, via: string): void {
    if (gen !== this.generation) return;
    this.consecutiveFailures = 0;
    const wasBlocked = this.blocked;
    if (wasBlocked) {
      this.blocked = false;
      this.stopRecoveryProbe();
      this.recoveryAttempt = 0;
      log('notice', `[RestQueryService] RECOVERED — kết nối lại Boss sau ${fmtSeconds(Date.now() - this.blockedAt)}`
        + ` (${via}, ${latency}ms; ${this.refusedCount} request bị chặn trong lúc mất kết nối)`);
      this.notifyStatus(true, latency);
    }
    if (this.recoveryPending) {
      if (!wasBlocked) {
        log('notice', `[RestQueryService] RECOVERED — ${via} thành công; ${this.refusedCount} request bị từ chối trước đó`
          + ' (chưa init / đang cấu hình lại)');
      }
      this.recoveryPending = false;
      this.refusedCount = 0;
      this.refusalLogged = false;
      this.emitRecovered();
    }
  }

  /** 'open' = gửi bình thường; 'probe' = đang blocked nhưng được đi làm probe; 'closed' = từ chối ngay. */
  private acquireGate(allowProbe: boolean): 'open' | 'probe' | 'closed' {
    if (!this.baseUrl || !this.token) return 'closed';
    if (!this.blocked) return 'open';
    if (!allowProbe || this.probeThroughInFlight) return 'closed';
    const now = Date.now();
    if (now - this.lastProbeThroughAt < PROBE_THROUGH_INTERVAL_MS) return 'closed';
    this.probeThroughInFlight = true;
    this.lastProbeThroughAt = now;
    return 'probe';
  }

  private refuse(label: string): RestResponse<any> {
    this.recoveryPending = true;
    this.refusedCount++;
    if (!this.blocked && !this.refusalLogged) {
      this.refusalLogged = true;
      log('warn', `[RestQueryService] NOT_CONNECTED: ${label} — chưa init (thiếu Boss URL/token)`);
    } else {
      log('log', `[RestQueryService] NOT_CONNECTED: ${label}${this.blocked ? ' (blocked)' : ''}`);
    }
    return { success: false, error: NOT_CONNECTED_ERROR, code: 'NOT_CONNECTED' };
  }

  private buildHeaders(json: boolean, extra?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      ...(json ? { 'Content-Type': 'application/json', 'Accept': 'application/json' } : {}),
      ...(extra || {}),
      ...this.tunnelHeaders,
    };
  }

  private forbidden(label: string, path: string, elapsed: number): void {
    log('warn', `[RestQueryService] ACCOUNT_FORBIDDEN: ${label} (HTTP 403, ${elapsed}ms)`);
    dispatchWindowEvent('employee:accountForbidden', { path: pathForLog(path) });
  }

  // ── Generic request ──────────────────────────────────────────────

  private async request<T = any>(opts: RestOptions): Promise<RestResponse<T>> {
    const label = `${opts.method} ${pathForLog(opts.path)}`;
    const gate = this.acquireGate(true);
    if (gate === 'closed') return this.refuse(label);
    const gen = this.generation;
    const probe = gate === 'probe';
    try {
      let url: string;
      try {
        url = buildBossUrl(this.baseUrl, opts.path, opts.query);
      } catch {
        log('warn', `[RestQueryService] INVALID_URL: ${label}`);
        return { success: false, error: 'Địa chỉ Boss không hợp lệ', code: 'INVALID_URL' };
      }
      let body: string | undefined;
      try {
        body = opts.body ? JSON.stringify(opts.body) : undefined;
      } catch (err: any) {
        log('warn', `[RestQueryService] BAD_REQUEST: ${label} — body không serialize được`);
        return { success: false, error: err?.message || 'Body không hợp lệ', code: 'BAD_REQUEST' };
      }
      const timeoutMs = opts.timeout && opts.timeout > 0 ? opts.timeout : DEFAULT_TIMEOUT_MS;
      const ex = await exchange(url, { method: opts.method, headers: this.buildHeaders(true), body }, timeoutMs, true);
      return this.interpret<T>(ex, gen, label, opts.path, probe, timeoutMs);
    } finally {
      if (probe && gen === this.generation) this.probeThroughInFlight = false;
    }
  }

  private interpret<T>(ex: Exchange, gen: number, label: string, path: string, probe: boolean, timeoutMs: number): RestResponse<T> {
    const tag = probe ? ' [probe]' : '';
    switch (ex.kind) {
      case 'timeout':
        log('warn', `[RestQueryService] TIMEOUT: ${label} (${timeoutMs}ms)${tag}`);
        this.onTransportFailure(gen, `${label} → TIMEOUT`);
        return { success: false, error: 'Request timeout', code: 'TIMEOUT' };
      case 'network':
        log('warn', `[RestQueryService] NETWORK_ERROR: ${label} (${ex.elapsed}ms) — ${ex.message}${tag}`);
        this.onTransportFailure(gen, `${label} → NETWORK_ERROR`);
        return { success: false, error: ex.message || 'Network error', code: 'NETWORK_ERROR' };
      case 'gateway':
        log('warn', `[RestQueryService] HTTP ${ex.status} (gateway): ${label} (${ex.elapsed}ms)${tag}`);
        this.onTransportFailure(gen, `${label} → HTTP ${ex.status}`);
        return { success: false, error: `Boss/tunnel không phản hồi (HTTP ${ex.status})`, code: `HTTP_${ex.status}`, status: ex.status };
      case 'invalid':
        // Không tính vào mất kết nối (vd trang cảnh báo tunnel, lỗi proxy, JSON hỏng).
        log('warn', `[RestQueryService] BAD_RESPONSE: ${label} — HTTP ${ex.status}, ${ex.contentType || 'không có content-type'}`
          + ` (${ex.reason}, ${ex.elapsed}ms)${tag}`);
        return { success: false, error: `Phản hồi không hợp lệ từ Boss (HTTP ${ex.status})`, code: 'BAD_RESPONSE', status: ex.status };
      case 'binary': {
        this.onTransportOk(gen, ex.elapsed, label);
        const size = Number(ex.blob?.size) || 0;
        log('log', `[RestQueryService] OK ${label} (${ex.elapsed}ms, binary ${(size / 1024).toFixed(1)}KB)`);
        return { success: true, data: ex.blob as any };
      }
      case 'json': {
        const json = ex.json;
        this.onTransportOk(gen, ex.elapsed, label);
        if (!ex.ok) {
          const code = pickCode(json) || `HTTP_${ex.status}`;
          if (ex.status === 403 && code === 'ACCOUNT_FORBIDDEN') this.forbidden(label, path, ex.elapsed);
          else log('warn', `[RestQueryService] HTTP ${ex.status}: ${label} → ${code} (${ex.elapsed}ms)`);
          return { success: false, error: pickError(json) || `HTTP ${ex.status}`, code, status: ex.status };
        }
        if (!json.success) {
          // Lỗi nghiệp vụ — Boss vẫn trả lời nên không tính là lỗi mạng.
          const code = pickCode(json) || 'UNKNOWN';
          log('warn', `[RestQueryService] FAILED: ${label} → ${code} (${ex.elapsed}ms)`);
          return { success: false, error: pickError(json) || 'Request failed', code };
        }
        if (json.data !== undefined) {
          // data có thể null (sticker chưa cache, tin trích dẫn không tồn tại…) — không được đọc thẳng .items
          const items = Array.isArray(json.data) ? json.data : (Array.isArray(json.data?.items) ? json.data.items : null);
          log('log', `[RestQueryService] OK ${label} (${ex.elapsed}ms${items ? `, ${items.length} items` : ''})`);
          return { success: true, data: json.data, pagination: json.pagination };
        }
        // Fallback: trả về toàn bộ (cho endpoint không bọc data)
        log('log', `[RestQueryService] OK ${label} (${ex.elapsed}ms)`);
        return { success: true, data: json as T };
      }
    }
    return { success: false, error: 'Unknown response', code: 'UNKNOWN' };
  }

  // ── Public methods ───────────────────────────────────────────────

  public get<T = any>(path: string, query?: Record<string, any>, timeout?: number): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'GET', path, query, timeout });
  }

  public post<T = any>(path: string, body?: any, timeout?: number): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'POST', path, body, timeout });
  }

  public put<T = any>(path: string, body?: any, timeout?: number): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'PUT', path, body, timeout });
  }

  public patch<T = any>(path: string, body?: any, timeout?: number): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'PATCH', path, body, timeout });
  }

  public delete<T = any>(path: string, timeout?: number): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'DELETE', path, timeout });
  }

  /**
   * Upload binary data to boss. Returns bossPath on success.
   * Khi blocked: từ chối ngay (không làm probe). Lỗi transport KHÔNG tính vào mất kết nối.
   */
  public async postBinary(path: string, data: Uint8Array | Blob, headers: Record<string, string>, timeout = UPLOAD_TIMEOUT_MS): Promise<RestResponse> {
    const label = `POST ${pathForLog(path)} (binary)`;
    if (this.acquireGate(false) === 'closed') return this.refuse(label);
    const gen = this.generation;
    let url: string;
    try {
      url = buildBossUrl(this.baseUrl, path);
    } catch {
      log('warn', `[RestQueryService] INVALID_URL: ${label}`);
      return { success: false, error: 'Địa chỉ Boss không hợp lệ', code: 'INVALID_URL' };
    }
    const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
    const body = isBlob ? data : new Uint8Array(data as Uint8Array);
    const timeoutMs = timeout && timeout > 0 ? timeout : UPLOAD_TIMEOUT_MS;
    const ex = await exchange(url, { method: 'POST', headers: this.buildHeaders(false, headers), body }, timeoutMs, false);
    switch (ex.kind) {
      case 'json': {
        this.onTransportOk(gen, ex.elapsed, label);
        const json = ex.json;
        if (!ex.ok || !json.success) {
          const code = pickCode(json) || (ex.ok ? 'UNKNOWN' : `HTTP_${ex.status}`);
          if (ex.status === 403 && code === 'ACCOUNT_FORBIDDEN') this.forbidden(label, path, ex.elapsed);
          else log('warn', `[RestQueryService] FAILED: ${label} → ${code} (HTTP ${ex.status}, ${ex.elapsed}ms)`);
          return {
            success: false,
            error: pickError(json) || `HTTP ${ex.status}`,
            code,
            ...(ex.ok ? {} : { status: ex.status }),
          };
        }
        log('log', `[RestQueryService] OK ${label} (${ex.elapsed}ms)`);
        return { success: true, data: json };
      }
      case 'invalid':
        log('warn', `[RestQueryService] BAD_RESPONSE: ${label} — HTTP ${ex.status}, ${ex.contentType || 'không có content-type'} (${ex.reason}, ${ex.elapsed}ms)`);
        return { success: false, error: `Phản hồi không hợp lệ từ Boss (HTTP ${ex.status})`, code: 'BAD_RESPONSE', status: ex.status };
      case 'gateway':
        log('warn', `[RestQueryService] HTTP ${ex.status} (gateway): ${label} (${ex.elapsed}ms)`);
        return { success: false, error: `Boss/tunnel không phản hồi (HTTP ${ex.status})`, code: `HTTP_${ex.status}`, status: ex.status };
      case 'timeout':
        log('warn', `[RestQueryService] TIMEOUT: ${label} (${timeoutMs}ms)`);
        return { success: false, error: 'Request timeout', code: 'TIMEOUT' };
      case 'network':
        log('warn', `[RestQueryService] NETWORK_ERROR: ${label} (${ex.elapsed}ms) — ${ex.message}`);
        return { success: false, error: ex.message || 'Network error', code: 'NETWORK_ERROR' };
      default:
        return { success: false, error: 'Unknown response', code: 'UNKNOWN' };
    }
  }

  // ── Convenience: login (không cần token) ─────────────────────────

  /** Gọi POST /api/auth/login — đặc biệt vì chưa có token. Không ảnh hưởng trạng thái kết nối. */
  public static async login(baseUrl: string, username: string, password: string): Promise<RestResponse<{
    token: string;
    employee: any;
    snapshot: any;
  }>> {
    const base = normalizeBossUrl(baseUrl);
    let url: string;
    try {
      url = buildBossUrl(base, '/api/auth/login');
    } catch {
      return { success: false, error: 'Địa chỉ Boss không hợp lệ', code: 'INVALID_URL' };
    }
    const ex = await exchange(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tunnelBypassHeaders(base) },
      body: JSON.stringify({ username, password }),
    }, LOGIN_TIMEOUT_MS, false);
    switch (ex.kind) {
      case 'json': {
        const json = ex.json;
        if (!ex.ok) {
          const code = pickCode(json) || `HTTP_${ex.status}`;
          log('warn', `[RestQueryService] login: HTTP ${ex.status} → ${code} (${ex.elapsed}ms)`);
          return { ...json, success: false, error: pickError(json) || `HTTP ${ex.status}`, code, status: ex.status };
        }
        log('log', `[RestQueryService] login: HTTP ${ex.status} (${ex.elapsed}ms)`);
        // Boss trả {success, token, employee, snapshot} — KHÔNG có data wrapper; giữ nguyên cho caller.
        return json as RestResponse<{ token: string; employee: any; snapshot: any }>;
      }
      case 'invalid':
        log('warn', `[RestQueryService] BAD_RESPONSE: POST /api/auth/login — HTTP ${ex.status}, ${ex.contentType || 'không có content-type'} (${ex.reason}, ${ex.elapsed}ms)`);
        return {
          success: false,
          error: `Phản hồi không hợp lệ từ Boss (HTTP ${ex.status}) — kiểm tra lại địa chỉ Boss / tunnel`,
          code: 'BAD_RESPONSE',
          status: ex.status,
        };
      case 'gateway':
        log('warn', `[RestQueryService] login: HTTP ${ex.status} (gateway, ${ex.elapsed}ms)`);
        return { success: false, error: `Boss/tunnel không phản hồi (HTTP ${ex.status})`, code: `HTTP_${ex.status}`, status: ex.status };
      case 'timeout':
        log('warn', `[RestQueryService] login: TIMEOUT (${LOGIN_TIMEOUT_MS}ms)`);
        return { success: false, error: 'Request timeout', code: 'TIMEOUT' };
      case 'network':
        log('warn', `[RestQueryService] login: NETWORK_ERROR (${ex.elapsed}ms) — ${ex.message}`);
        return { success: false, error: ex.message || 'Network error', code: 'NETWORK_ERROR' };
      default:
        return { success: false, error: 'Unknown response', code: 'UNKNOWN' };
    }
  }
}

export default RestQueryService;
