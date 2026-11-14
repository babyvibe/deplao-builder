/**
 * RestQueryService - Employee-side REST client (renderer).
 * Used in employee mode to call the REST API on Boss. Boss / standalone mode does not use this file.
 *
 * Singleton. Result classification (see exchange() + interpret()):
 *  - ONLY transport errors count toward a lost connection: fetch reject, timeout / abort (including while reading the body),
 *    HTTP 502/503/504 (gateway / tunnel). 3 errors in a row → "blocked": the request returns NOT_CONNECTED right away,
 *    except that at most 1 real request every ~2 s is let through as a probe; the health probe runs after 1 s, then backs off
 *    2/4/8 s (max 15 s). When the connection comes back → status listener (true) + onRecovered.
 *  - NOT counted: 2xx with the wrong shape (data: null, broken JSON), other 4xx/5xx, 401/403. A body that is not JSON
 *    → BAD_RESPONSE (with the status). Any JSON reply from Boss (even 4xx/5xx) proves the network is fine → reset the counter.
 *  - postBinary: transport errors are NOT counted (large uploads can be cut individually by the proxy / tunnel); success still counts.
 *
 * Log: warn/error + state-change events go through Logger → IPC 'log:append' → the Log view (main) with the
 * [renderer] prefix. Never logs the token / query / body, only method + path + status + duration.
 */

import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

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
  /** HTTP status when the error comes from an HTTP response (BAD_RESPONSE, HTTP_xxx, ACCOUNT_FORBIDDEN…). */
  status?: number;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export type RestStatusListener = (connected: boolean, latency: number) => void;

/** Number of transport errors in a row before requests are blocked. */
export const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** Health probe schedule while blocked: 1 s, then backoff 2/4/8 s, max 15 s. */
const RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** While blocked: at most 1 real request is let through about every 2 s to test the connection (probe-through). */
const PROBE_THROUGH_INTERVAL_MS = 2_000;
/** Gateway errors (tunnel / proxy cannot reach Boss): Boss never returns these codes itself. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const NOT_CONNECTED_ERROR = tr('Chưa kết nối tới BOSS');
/** ngrok tunnel hosts (free / paid): insert a browser warning page unless the bypass header is sent. */
const NGROK_HOST_SUFFIXES = ['ngrok-free.app', 'ngrok-free.dev', 'ngrok.app', 'ngrok.io'];

// ── URL / header helpers (export cho test) ─────────────────────────

/** Normalize the Boss URL: add http:// if missing, strip the query / hash and the trailing '/', KEEP the sub-path (e.g. https://host/boss). */
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
 * Join the Boss URL (may have a sub-path) + the API path (may already include a query) + the query object.
 * Uses string concatenation instead of new URL(path, base): the old way dropped the sub-path. Throws if the URL is invalid.
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
 * The tunnel-warning bypass header: ONLY for tunnel hosts. Older Boss versions reject unknown headers in the
 * CORS preflight, so it must never be sent to the LAN or to other hosts.
 */
export function tunnelBypassHeaders(baseUrl: string): Record<string, string> {
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return {}; }
  const isHost = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  if (NGROK_HOST_SUFFIXES.some(isHost)) return { 'ngrok-skip-browser-warning': '1' };
  if (isHost('loca.lt')) return { 'Bypass-Tunnel-Reminder': '1' };
  return {};
}

/** Path for logging: the query string is stripped (it may contain account ids / search keywords). */
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
 * Safe logging: a logger error never breaks a request.
 * warn / error / notice are forwarded by Logger to the Log view (main); logs only go to the dev console.
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
  } catch { /* a listener error does not affect the request */ }
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

// ── Low-level exchange: fetch + reading the body under the SAME timeout ─────

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
 * The timer starts right before fetch and covers reading the body too: a hung body is aborted as well.
 * Never throws; every outcome is returned as an Exchange.
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
  deadline.catch(() => { /* a timeout outcome is handled through the timedOut flag */ });
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
      // HTML (tunnel warning page, proxy error…): not parsed, the content is not read.
      discardBody(res);
      return { kind: 'invalid', status, contentType: mime, reason: 'content-type', elapsed: Date.now() - start };
    }
    const text: string = await Promise.race([res.text(), deadline]);
    const elapsed = Date.now() - start;
    if (typeof text !== 'string' || !text.trim()) {
      // Empty body (e.g. 204): treated as success / failure based on the status
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
  /** Incremented on every init that changes the config / reset → discards the results of older requests / probes. */
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
  /** A request was rejected / just blocked → the next success calls onRecovered (once). */
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
   * @deprecated Use addStatusListener (multiple listeners). Kept for compatibility: this is ONE separate slot;
   * calling it again replaces the previous callback in this slot (it does not affect the addStatusListener listeners).
   */
  public setOnStatusChange(cb: RestStatusListener | null): void {
    this.legacyStatusListener = typeof cb === 'function' ? cb : null;
  }

  /** Register a connection-status listener (several at once). Returns an unregister function. */
  public addStatusListener(cb: RestStatusListener): () => void {
    const entry = { cb };
    this.statusListeners.add(entry);
    return () => { this.statusListeners.delete(entry); };
  }

  /**
   * Called once each time the client goes from lost connection / blocked (or a request was rejected because it was not initialized yet) back to
   * connected, through the health probe or a successful request. The data loader uses it to reload. Returns an unregister function.
   */
  public onRecovered(cb: () => void): () => void {
    const entry = { cb };
    this.recoveredListeners.add(entry);
    return () => { this.recoveredListeners.delete(entry); };
  }

  private notifyStatus(connected: boolean, latency: number): void {
    for (const entry of Array.from(this.statusListeners)) {
      try { entry.cb(connected, latency); } catch { /* a listener error does not affect the other listeners */ }
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
   * Initialize with the Boss URL + JWT token. Idempotent: the same URL + token → nothing is reset.
   * Different → reconfigure, reset the counter, restart the health check.
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
      // A different Boss = a new session (the workspace switch flow reloads by itself), so do not call onRecovered for the old session.
      this.recoveryPending = false;
      this.refusedCount = 0;
      this.refusalLogged = false;
    }
    this.startHealthCheck();
    const tunnel = Object.keys(this.tunnelHeaders).length ? ', tunnel' : '';
    log('notice', `[RestQueryService] Initialized: ${url || '(trống)'} (${tok ? 'có token' : 'THIẾU token'}${tunnel})`);
    this.notifyStatus(this.isConnected(), 0);
  }

  /** Reset (on logout). The listeners stay in place. */
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

  /** true while requests are blocked because of repeated transport errors (only 1 request every ~2 s is let through as a probe). */
  public isBlocked(): boolean {
    return this.blocked;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getToken(): string {
    return this.token;
  }

  // ── Health check (every 15 s while connected) ─────────────────────────

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
    if (this.blocked) return;                    // a recovery probe is already in progress
    if (this.consecutiveFailures === 0) return;  // healthy → no extra traffic created
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
    if (gen !== this.generation || !this.blocked) return; // already reconfigured / already recovered via probe-through
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

  /** Boss replied (JSON with any status, or binary 2xx) → the network is fine: reset the counter, clear blocked, call onRecovered. */
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

  /** 'open' = send normally; 'probe' = blocked but allowed through as a probe; 'closed' = reject right away. */
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
        return { success: false, error: tr('Địa chỉ Boss không hợp lệ'), code: 'INVALID_URL' };
      }
      let body: string | undefined;
      try {
        body = opts.body ? JSON.stringify(opts.body) : undefined;
      } catch (err: any) {
        log('warn', `[RestQueryService] BAD_REQUEST: ${label} — body không serialize được`);
        return { success: false, error: err?.message || tr('Body không hợp lệ'), code: 'BAD_REQUEST' };
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
        return { success: false, error: tr('Boss/tunnel không phản hồi (HTTP {{status}})', { status: ex.status }), code: `HTTP_${ex.status}`, status: ex.status };
      case 'invalid':
        // Not counted as a lost connection (e.g. a tunnel warning page, a proxy error, broken JSON).
        log('warn', `[RestQueryService] BAD_RESPONSE: ${label} — HTTP ${ex.status}, ${ex.contentType || 'không có content-type'}`
          + ` (${ex.reason}, ${ex.elapsed}ms)${tag}`);
        return { success: false, error: tr('Phản hồi không hợp lệ từ Boss (HTTP {{status}})', { status: ex.status }), code: 'BAD_RESPONSE', status: ex.status };
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
          // Business error: Boss still replied, so it is not counted as a network error.
          const code = pickCode(json) || 'UNKNOWN';
          log('warn', `[RestQueryService] FAILED: ${label} → ${code} (${ex.elapsed}ms)`);
          return { success: false, error: pickError(json) || 'Request failed', code };
        }
        if (json.data !== undefined) {
          // data may be null (sticker not cached, a quoted message that does not exist…): do not read .items directly
          const items = Array.isArray(json.data) ? json.data : (Array.isArray(json.data?.items) ? json.data.items : null);
          log('log', `[RestQueryService] OK ${label} (${ex.elapsed}ms${items ? `, ${items.length} items` : ''})`);
          return { success: true, data: json.data, pagination: json.pagination };
        }
        // Fallback: return everything (for endpoints that do not wrap data)
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
   * Upload binary data to Boss. Returns bossPath on success.
   * While blocked: rejected right away (no probe). Transport errors are NOT counted as a lost connection.
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
      return { success: false, error: tr('Địa chỉ Boss không hợp lệ'), code: 'INVALID_URL' };
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
        return { success: false, error: tr('Phản hồi không hợp lệ từ Boss (HTTP {{status}})', { status: ex.status }), code: 'BAD_RESPONSE', status: ex.status };
      case 'gateway':
        log('warn', `[RestQueryService] HTTP ${ex.status} (gateway): ${label} (${ex.elapsed}ms)`);
        return { success: false, error: tr('Boss/tunnel không phản hồi (HTTP {{status}})', { status: ex.status }), code: `HTTP_${ex.status}`, status: ex.status };
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

  // ── Convenience: login (no token needed) ─────────────────────────

  /** Calls POST /api/auth/login: special because there is no token yet. Does not affect the connection status. */
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
      return { success: false, error: tr('Địa chỉ Boss không hợp lệ'), code: 'INVALID_URL' };
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
        // Boss returns {success, token, employee, snapshot}: NO data wrapper; kept as is for the caller.
        return json as RestResponse<{ token: string; employee: any; snapshot: any }>;
      }
      case 'invalid':
        log('warn', `[RestQueryService] BAD_RESPONSE: POST /api/auth/login — HTTP ${ex.status}, ${ex.contentType || 'không có content-type'} (${ex.reason}, ${ex.elapsed}ms)`);
        return {
          success: false,
          error: tr('Phản hồi không hợp lệ từ Boss (HTTP {{status}}) — kiểm tra lại địa chỉ Boss / tunnel', { status: ex.status }),
          code: 'BAD_RESPONSE',
          status: ex.status,
        };
      case 'gateway':
        log('warn', `[RestQueryService] login: HTTP ${ex.status} (gateway, ${ex.elapsed}ms)`);
        return { success: false, error: tr('Boss/tunnel không phản hồi (HTTP {{status}})', { status: ex.status }), code: `HTTP_${ex.status}`, status: ex.status };
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
