/**
 * RestQueryService - Employee-side REST client.
 * Dùng trong employee mode để gọi REST API lên Boss.
 *
 * Singleton. Chỉ active khi mode=employee.
 * Boss/standalone mode không dùng file này.
 */

import Logger from '../../utils/Logger';

interface RestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, any>;
  body?: any;
  timeout?: number;
}

interface RestResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

const MAX_CONSECUTIVE_FAILURES = 2;
const HEALTH_CHECK_INTERVAL_MS = 15_000;

class RestQueryService {
  private static instance: RestQueryService;
  private baseUrl: string = '';
  private token: string = '';
  private connected: boolean = false;
  private consecutiveFailures: number = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private onStatusChange: ((connected: boolean, latency: number) => void) | null = null;

  public static getInstance(): RestQueryService {
    if (!RestQueryService.instance) {
      RestQueryService.instance = new RestQueryService();
    }
    return RestQueryService.instance;
  }

  /** Đăng ký callback mỗi khi trạng thái kết nối thay đổi */
  public setOnStatusChange(cb: ((connected: boolean, latency: number) => void) | null): void {
    this.onStatusChange = cb;
  }

  /** Khởi tạo với boss URL + JWT token */
  public init(baseUrl: string, token: string): void {
    let url = baseUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    this.baseUrl = url.replace(/\/+$/, '');
    this.token = token;
    this.connected = true;
    this.consecutiveFailures = 0;
    this.startHealthCheck();
    const msg = `[RestQueryService] Initialized: ${this.baseUrl} token=${token ? token.slice(0, 12)+'...' : 'EMPTY!'}`;
    Logger.log(msg);
    console.log(msg);
    this.notifyStatus(true, 0);
  }

  /** Reset (khi logout) */
  public reset(): void {
    this.stopHealthCheck();
    this.baseUrl = '';
    this.token = '';
    this.connected = false;
    this.consecutiveFailures = 0;
    Logger.log('[RestQueryService] Reset');
    this.notifyStatus(false, 0);
  }

  public isConnected(): boolean {
    return this.connected && !!this.baseUrl && !!this.token;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  // ── Status notification ──────────────────────────────────────────

  private notifyStatus(connected: boolean, latency: number): void {
    try {
      this.onStatusChange?.(connected, latency);
    } catch { /* ignore */ }
  }

  // ── Health check ─────────────────────────────────────────────────

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      // Nếu đã connected mà không có lỗi gần đây → skip
      if (this.connected && this.consecutiveFailures === 0) return;

      try {
        const start = Date.now();
        const res = await fetch(`${this.baseUrl}/api/health`, {
          headers: { 'Authorization': `Bearer ${this.token}` },
          signal: AbortSignal.timeout(10_000),
        });
        const elapsed = Date.now() - start;

        if (res.ok || res.status === 200) {
          if (!this.connected) {
            this.connected = true;
            this.consecutiveFailures = 0;
            Logger.log(`[RestQueryService] ✅ Health check OK — reconnected (${elapsed}ms)`);
            this.notifyStatus(true, elapsed);
          }
        }
      } catch {
        // Boss vẫn không reachable — nothing to do
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── Failure tracking ────────────────────────────────────────────

  private onSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private onHttpError(status: number): void {
    // 401/403 = auth issue, không tính network error
    if (status === 401 || status === 403) return;
    // Các HTTP error khác (5xx, etc.) — không mất kết nối
    this.consecutiveFailures = 0;
  }

  private onNetworkError(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && this.connected) {
      this.connected = false;
      Logger.warn(`[RestQueryService] ❌ DISCONNECTED — ${this.consecutiveFailures} consecutive failures`);
      this.notifyStatus(false, 0);
      // Health check sẽ tự động reconnect khi Boss online trở lại
    }
  }

  // ── Generic request ──────────────────────────────────────────────

  private async request<T = any>(opts: RestOptions): Promise<RestResponse<T>> {
    if (!this.connected) {
      Logger.warn(`[RestQueryService] ❌ NOT_CONNECTED: ${opts.method} ${opts.path}`);
      return { success: false, error: 'Chưa kết nối tới BOSS', code: 'NOT_CONNECTED' };
    }

    const url = new URL(opts.path, this.baseUrl);
    if (opts.query) {
      Object.entries(opts.query).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
      });
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutMs = opts.timeout || 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let elapsed = 0;

    try {
      Logger.log(`[RestQueryService] ▶️ ${opts.method} ${opts.path}`, opts.query ? `query=${JSON.stringify(opts.query)}` : '');

      const res = await fetch(url.toString(), {
        method: opts.method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      elapsed = Date.now() - startTime;

      // Nếu response là binary (media)
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/octet-stream') || contentType.includes('image/')) {
        const blob = await res.blob();
        Logger.log(`[RestQueryService] ✅ ${opts.method} ${opts.path} (${elapsed}ms, binary ${(blob.size / 1024).toFixed(1)}KB)`);
        this.onSuccess();
        return { success: true, data: blob as any };
      }

      const json: any = await res.json();

      if (!res.ok) {
        Logger.warn(`[RestQueryService] ❌ HTTP ${res.status}: ${opts.method} ${opts.path} (${elapsed}ms) — ${json.error || ''}`);
        this.onHttpError(res.status);
        return {
          success: false,
          error: json.error || `HTTP ${res.status}`,
          code: json.code || `HTTP_${res.status}`,
        };
      }

      if (!json.success) {
        Logger.warn(`[RestQueryService] ❌ FAILED: ${opts.method} ${opts.path} (${elapsed}ms) — ${json.error || ''}`);
        // Business-level failure — không tính là network error
        this.onSuccess();
        return {
          success: false,
          error: json.error || 'Request failed',
          code: json.code || 'UNKNOWN',
        };
      }

      // Trả về data hoặc toàn bộ response nếu có pagination
      if (json.data !== undefined) {
        const dataSize = Array.isArray(json.data) ? json.data.length : (json.data.items?.length ?? '?');
        Logger.log(`[RestQueryService] ✅ ${opts.method} ${opts.path} (${elapsed}ms, ${dataSize} items)`);
        this.onSuccess();
        return {
          success: true,
          data: json.data,
          pagination: json.pagination,
        };
      }

      // Fallback: trả về toàn bộ (cho login, health, v.v.)
      Logger.log(`[RestQueryService] ✅ ${opts.method} ${opts.path} (${elapsed}ms)`);
      this.onSuccess();
      return { success: true, data: json as T };
    } catch (err: any) {
      clearTimeout(timeoutId);
      elapsed = Date.now() - startTime;
      if (err.name === 'AbortError') {
        Logger.warn(`[RestQueryService] ⏰ TIMEOUT: ${opts.method} ${opts.path} (${timeoutMs}ms)`);
        this.onNetworkError();
        return { success: false, error: 'Request timeout', code: 'TIMEOUT' };
      }
      Logger.warn(`[RestQueryService] ❌ ERROR: ${opts.method} ${opts.path} (${elapsed}ms) — ${err.message}`);
      this.onNetworkError();
      return { success: false, error: err.message, code: 'NETWORK_ERROR' };
    }
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

  /** Upload binary data to boss. Returns bossPath on success. */
  public async postBinary(path: string, data: Uint8Array | Blob, headers: Record<string, string>, timeout = 120000): Promise<RestResponse> {
    if (!this.connected) {
      return { success: false, error: 'Chưa kết nối tới BOSS', code: 'NOT_CONNECTED' };
    }
    const url = new URL(path, this.baseUrl);
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      // Convert Buffer to Uint8Array for fetch compatibility
      const body = data instanceof Blob ? data : new Uint8Array(data);
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          ...headers,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        Logger.warn(`[RestQueryService] ❌ postBinary ${path} (${elapsed}ms) — ${json.error || `HTTP ${res.status}`}`);
        return { success: false, error: json.error || `HTTP ${res.status}` };
      }
      Logger.log(`[RestQueryService] ✅ postBinary ${path} (${elapsed}ms)`);
      this.onSuccess();
      return { success: true, data: json };
    } catch (err: any) {
      clearTimeout(timeoutId);
      Logger.warn(`[RestQueryService] ❌ postBinary ${path} — ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Convenience: login (không cần token) ─────────────────────────

  /** Gọi POST /api/auth/login — đặc biệt vì chưa có token */
  public static async login(baseUrl: string, username: string, password: string): Promise<RestResponse<{
    token: string;
    employee: any;
    snapshot: any;
  }>> {
    let url = baseUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    url = url.replace(/\/+$/, '');

    try {
      const res = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(15000),
      });
      const json: any = await res.json();
      return json as RestResponse<{ token: string; employee: any; snapshot: any; }>;
    } catch (err: any) {
      return { success: false, error: err.message, code: 'NETWORK_ERROR' };
    }
  }
}

export default RestQueryService;
