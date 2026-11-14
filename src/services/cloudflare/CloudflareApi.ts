/**
 * CloudflareApi: REST v4 client (https://api.cloudflare.com/client/v4) for all Cloudflare modules.
 *
 *  - The Bearer token is obtained via getToken() on each call (cloudSettings decrypts it with safeStorage, kept in RAM).
 *    NEVER log the token or the Authorization header.
 *  - Budget: at most 100 requests in ANY 5-minute window for the whole app (shared RequestBudget). When the budget is used up
 *    → wait until one is free (FIFO), never exceed it. `unbudgeted` is only for verifying the token when connecting.
 *  - 5xx → retry at most 2 times (wait 1 s, 3 s); network errors are only retried for GET. 429 → CloudError('RATE_LIMITED',
 *    …, retryAfterMs from Retry-After). Other 4xx → CloudApiError (short code + a Vietnamese message + the Cloudflare error code).
 *  - Timeout via AbortController (default 20 s).
 */
import { CloudError, CfRequestOptions, CloudflareApi } from './contracts';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
export const CF_BUDGET_MAX = 100;
export const CF_BUDGET_WINDOW_MS = 5 * 60 * 1000;
export const CF_DEFAULT_TIMEOUT_MS = 20_000;
export const CF_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 3000];
/** Retry-After missing on a 429 → back off 60 s. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

// ─── Minimal fetch types (easy to mock in tests, no dependency on the DOM/undici lib) ──────────────────

export interface FetchResponseLike {
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}
export type FetchLike = (url: string, init: any) => Promise<FetchResponseLike>;

export interface CfApiErrorItem { code: number; message: string }

export interface CfResultInfo {
    page?: number;
    per_page?: number;
    count?: number;
    total_count?: number;
    total_pages?: number;
    cursor?: string;
    cursors?: { after?: string; before?: string };
}

export interface CfEnvelope<T = any> {
    success: boolean;
    errors?: CfApiErrorItem[];
    messages?: any[];
    result: T;
    result_info?: CfResultInfo;
}

/** Cloudflare API error, keeps the original error code (errors[].code) so modules can tell them apart (e.g. 10042, 81057). */
export class CloudApiError extends CloudError {
    constructor(
        code: string,
        message: string,
        status: number | undefined,
        public readonly cfErrors: CfApiErrorItem[] = [],
        retryAfterMs?: number,
    ) {
        super(code, message, status, retryAfterMs);
        this.name = 'CloudApiError';
    }
}

/** Cloudflare error codes (errors[].code) of any error ([] if it is not an API error). */
export function cfErrorCodes(err: unknown): number[] {
    return err instanceof CloudApiError ? err.cfErrors.map(e => Number(e.code)).filter(n => Number.isFinite(n)) : [];
}

/** Retry-After: seconds or HTTP-date → ms (null if it cannot be read). */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
    if (!value) return null;
    const v = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(v)) return Math.max(0, Math.round(parseFloat(v) * 1000));
    const at = Date.parse(v);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
    return null;
}

// ─── Request budget ───────────────────────────────────────────────────────

/**
 * Limit to `max` requests in every `windowMs` window (sliding window: records the timestamp of each request, and each new request
 * only goes ahead when the number of timestamps in the last windowMs is < max). Stricter than a plain token bucket (no 2× burst at the window edge).
 * Waiting callers are served in order (FIFO).
 */
export class RequestBudget {
    private readonly stamps: number[] = [];
    private readonly waiters: Array<() => void> = [];
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        readonly max: number = CF_BUDGET_MAX,
        readonly windowMs: number = CF_BUDGET_WINDOW_MS,
        private readonly now: () => number = () => Date.now(),
    ) {}

    remaining(): number {
        this.prune();
        return Math.max(0, this.max - this.stamps.length);
    }

    /** Number of requests waiting for budget. */
    waiting(): number {
        return this.waiters.length;
    }

    acquire(): Promise<void> {
        this.prune();
        if (this.waiters.length === 0 && this.stamps.length < this.max) {
            this.stamps.push(this.now());
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.waiters.push(resolve);
            this.schedule();
        });
    }

    private prune(): void {
        const cutoff = this.now() - this.windowMs;
        while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
    }

    private drain(): void {
        this.prune();
        while (this.waiters.length && this.stamps.length < this.max) {
            this.stamps.push(this.now());
            const resolve = this.waiters.shift()!;
            resolve();
        }
    }

    private schedule(): void {
        if (this.timer) return;
        this.drain();
        if (!this.waiters.length) return;
        const wait = Math.max(1, this.stamps[0] + this.windowMs - this.now());
        this.timer = setTimeout(() => {
            this.timer = null;
            this.schedule();
        }, wait);
    }
}

/** Budget shared by the whole app. */
export const cloudflareBudget = new RequestBudget();

// ─── Error mapping ──────────────────────────────────────────────────────────────

const KNOWN_CF_CODES: Record<number, [string, string]> = {
    1000: ['INVALID_TOKEN', tr('Token Cloudflare không hợp lệ')],
    6003: ['INVALID_TOKEN', tr('Token Cloudflare sai định dạng')],
    6111: ['INVALID_TOKEN', tr('Token Cloudflare sai định dạng')],
    9103: ['INVALID_TOKEN', tr('Token Cloudflare không hợp lệ')],
    9106: ['INVALID_TOKEN', tr('Thiếu token Cloudflare')],
    9109: ['INVALID_TOKEN', tr('Token Cloudflare không hợp lệ hoặc đã bị thu hồi')],
    10000: ['FORBIDDEN', tr('Token không có quyền cho thao tác này')],
    7000: ['NOT_FOUND', tr('Đường dẫn API Cloudflare không tồn tại')],
    7003: ['NOT_FOUND', tr('Sai Account ID / Zone ID hoặc tài nguyên không còn trên Cloudflare')],
    10042: ['R2_NOT_ENABLED', tr('Tài khoản Cloudflare chưa bật R2')],
    10006: ['R2_NO_BUCKET', tr('Bucket R2 không tồn tại')],
    81053: ['DNS_RECORD_EXISTS', tr('Đã có bản ghi DNS trùng tên')],
    81057: ['DNS_RECORD_EXISTS', tr('Đã có bản ghi DNS trùng tên')],
    81058: ['DNS_RECORD_EXISTS', tr('Đã có bản ghi DNS giống hệt')],
};

function shortCfMessage(errors: CfApiErrorItem[]): string {
    const first = errors[0];
    if (!first) return '';
    const msg = String(first.message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return msg;
}

/** HTTP 4xx (not 429) + errors[] → CloudApiError with a short Vietnamese message. */
export function mapCloudflareError(status: number, errors: CfApiErrorItem[]): CloudApiError {
    for (const e of errors) {
        const known = KNOWN_CF_CODES[Number(e.code)];
        if (known) return new CloudApiError(known[0], tr('{{v1}} (mã {{code}})', { v1: known[1], code: e.code }), status, errors);
    }
    const cfCode = errors[0]?.code;
    const cfMsg = shortCfMessage(errors);
    const suffix = cfCode ? tr(' (mã {{cfCode}}{{v1}})', { cfCode, v1: cfMsg ? `: ${cfMsg}` : '' }) : (cfMsg ? ` (${cfMsg})` : '');
    if (status === 401) return new CloudApiError('INVALID_TOKEN', tr('Token Cloudflare không hợp lệ hoặc đã hết hạn{{suffix}}', { suffix }), status, errors);
    if (status === 403) return new CloudApiError('FORBIDDEN', tr('Token thiếu quyền cho thao tác này{{suffix}}', { suffix }), status, errors);
    if (status === 404) return new CloudApiError('NOT_FOUND', tr('Không tìm thấy trên Cloudflare{{suffix}}', { suffix }), status, errors);
    if (status === 409) return new CloudApiError('CONFLICT', tr('Đã tồn tại trên Cloudflare{{suffix}}', { suffix }), status, errors);
    if (status === 400 || status === 422) return new CloudApiError('BAD_REQUEST', tr('Cloudflare từ chối yêu cầu{{suffix}}', { suffix }), status, errors);
    return new CloudApiError('CF_ERROR', tr('Cloudflare báo lỗi (HTTP {{status}}){{suffix}}', { status, suffix }), status, errors);
}

function parseErrors(env: any): CfApiErrorItem[] {
    const list = Array.isArray(env?.errors) ? env.errors : [];
    return list
        .filter((e: any) => e && (e.code !== undefined || e.message))
        .map((e: any) => ({ code: Number(e.code) || 0, message: String(e.message || '') }));
}

function safeJson(text: string): any {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

function networkReason(err: any): string {
    const code = err?.cause?.code || err?.code;
    if (typeof code === 'string' && code) return code;
    const msg = String(err?.cause?.message || err?.message || tr('lỗi mạng'));
    return msg.slice(0, 120);
}

/** List in the result: an array, or the first array inside an object (e.g. R2 returns { buckets: [...] }). */
function extractItems(result: any): any[] {
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object') {
        for (const v of Object.values(result)) if (Array.isArray(v)) return v;
    }
    return [];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface CloudflareApiOptions {
    getToken: () => string | null;
    fetchImpl?: FetchLike;
    budget?: RequestBudget;
    baseUrl?: string;
    /** Replaces setTimeout when waiting between retries (tests). */
    sleep?: (ms: number) => Promise<void>;
    retryDelaysMs?: ReadonlyArray<number>;
    now?: () => number;
}

export class CloudflareApiClient implements CloudflareApi {
    private readonly budget: RequestBudget;
    private readonly baseUrl: string;

    constructor(private readonly opts: CloudflareApiOptions) {
        this.budget = opts.budget ?? cloudflareBudget;
        this.baseUrl = (opts.baseUrl ?? CF_API_BASE).replace(/\/+$/, '');
    }

    budgetRemaining(): number {
        return this.budget.remaining();
    }

    async request<T = any>(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body?: unknown,
        opts: CfRequestOptions = {},
    ): Promise<T> {
        const env = await this.requestEnvelope<T>(method, path, body, opts);
        return env.result;
    }

    async requestAll<T = any>(path: string, opts: CfRequestOptions & { perPage?: number; maxPages?: number } = {}): Promise<T[]> {
        const { perPage: perPageOpt, maxPages: maxPagesOpt, ...reqOpts } = opts;
        const perPage = Math.max(1, Math.floor(perPageOpt ?? 50));
        const maxPages = Math.max(1, Math.floor(maxPagesOpt ?? 20));
        const out: T[] = [];
        let mode: 'first' | 'page' | 'cursor' = 'first';
        let page = 1;
        let cursor = '';
        for (let i = 0; i < maxPages; i++) {
            const query: Record<string, string | number | boolean | undefined> = { ...(reqOpts.query || {}), per_page: perPage };
            if (mode === 'page') query.page = page;
            if (mode === 'cursor') query.cursor = cursor;
            const env = await this.requestEnvelope<any>('GET', path, undefined, { ...reqOpts, query });
            const items = extractItems(env.result) as T[];
            out.push(...items);
            const info: CfResultInfo = env.result_info || {};
            const nextCursor = (typeof info.cursor === 'string' && info.cursor) || (info.cursors && info.cursors.after) || '';
            if (mode !== 'page' && nextCursor && items.length > 0) {
                if (nextCursor === cursor) break;
                mode = 'cursor';
                cursor = nextCursor;
                continue;
            }
            if (mode === 'cursor' || items.length === 0) break;
            const currentPage = Number(info.page) || page;
            const totalPages = Number(info.total_pages)
                || (Number(info.total_count) && Number(info.per_page) ? Math.ceil(Number(info.total_count) / Number(info.per_page)) : 0);
            const more = totalPages ? currentPage < totalPages : items.length >= perPage;
            if (!more) break;
            mode = 'page';
            page = currentPage + 1;
        }
        return out;
    }

    async graphql<T = any>(
        query: string,
        variables: Record<string, unknown> = {},
        opts: CfRequestOptions = {},
    ): Promise<{ data: T | null; errors: Array<{ message: string; [k: string]: unknown }> }> {
        // A GraphQL response without `success` → requestEnvelope returns { data, errors } as is
        const env: any = await this.requestEnvelope<any>('POST', '/graphql', { query, variables }, opts);
        const errors = Array.isArray(env?.errors)
            ? env.errors.map((e: any) => ({ ...(e && typeof e === 'object' ? e : {}), message: String(e?.message ?? e ?? tr('Lỗi GraphQL')) }))
            : [];
        return { data: (env?.data ?? null) as T | null, errors };
    }

    /** Like request() but returns the whole envelope (result_info…). */
    async requestEnvelope<T = any>(method: string, path: string, body?: unknown, opts: CfRequestOptions = {}): Promise<CfEnvelope<T>> {
        const token = this.opts.getToken();
        if (!token) throw new CloudError('NOT_CONNECTED', tr('Chưa kết nối Cloudflare'));
        const url = this.buildUrl(path, opts.query);
        const headers: Record<string, string> = {
            ...(opts.headers || {}),
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        };
        let payload: string | Buffer | undefined;
        if (body !== undefined && body !== null) {
            if (opts.contentType && (typeof body === 'string' || Buffer.isBuffer(body))) {
                // Prebuilt body (multipart Worker script upload), sent as is; the token still only lives here.
                headers['Content-Type'] = opts.contentType;
                payload = body;
            } else {
                headers['Content-Type'] = 'application/json';
                payload = JSON.stringify(body);
            }
        }
        const delays = this.opts.retryDelaysMs ?? CF_RETRY_DELAYS_MS;
        const fetchImpl: FetchLike = this.opts.fetchImpl ?? ((u, init) => (globalThis as any).fetch(u, init));
        const logPath = path.split('?')[0];

        for (let attempt = 0; ; attempt++) {
            if (!opts.unbudgeted) await this.budget.acquire();
            const controller = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, opts.timeoutMs ?? CF_DEFAULT_TIMEOUT_MS);

            let status = 0;
            let text = '';
            let retryAfter: string | null = null;
            try {
                const res = await fetchImpl(url, { method, headers, body: payload, signal: controller.signal });
                status = res.status;
                retryAfter = res.headers.get('retry-after');
                text = await res.text();
            } catch (err: any) {
                clearTimeout(timer);
                if (!timedOut && method === 'GET' && attempt < delays.length) {
                    await this.sleep(delays[attempt]);
                    continue;
                }
                if (timedOut) {
                    Logger.warn(`[CloudflareApi] ${method} ${logPath} timeout`);
                    throw new CloudError('TIMEOUT', tr('Cloudflare phản hồi quá lâu, thử lại sau'));
                }
                const reason = networkReason(err);
                Logger.warn(`[CloudflareApi] ${method} ${logPath} network error: ${reason}`);
                throw new CloudError('NETWORK', tr('Không kết nối được Cloudflare ({{reason}})', { reason }));
            }
            clearTimeout(timer);

            const env = safeJson(text);
            if (status >= 500) {
                if (attempt < delays.length) {
                    Logger.warn(`[CloudflareApi] ${method} ${logPath} → HTTP ${status}, thử lại sau ${delays[attempt]} ms`);
                    await this.sleep(delays[attempt]);
                    continue;
                }
                Logger.warn(`[CloudflareApi] ${method} ${logPath} → HTTP ${status} (hết lượt thử lại)`);
                throw new CloudApiError('CF_UNAVAILABLE', tr('Cloudflare đang lỗi tạm thời (HTTP {{status}}), thử lại sau', { status }), status, parseErrors(env));
            }
            if (status === 429) {
                const retryAfterMs = parseRetryAfterMs(retryAfter, this.now()) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
                Logger.warn(`[CloudflareApi] ${method} ${logPath} → 429, chờ ${retryAfterMs} ms`);
                throw new CloudApiError(
                    'RATE_LIMITED',
                    tr('Cloudflare đang giới hạn số yêu cầu, thử lại sau {{v1}} giây', { v1: Math.max(1, Math.ceil(retryAfterMs / 1000)) }),
                    429,
                    parseErrors(env),
                    retryAfterMs,
                );
            }
            if (status >= 200 && status < 300 && env && typeof env === 'object' && env.success !== false) {
                return env as CfEnvelope<T>;
            }
            if (status >= 200 && status < 300 && !env) {
                throw new CloudError('BAD_RESPONSE', tr('Cloudflare trả về dữ liệu không đọc được'), status);
            }
            const errors = parseErrors(env);
            const mapped = mapCloudflareError(status, errors);
            Logger.warn(`[CloudflareApi] ${method} ${logPath} → HTTP ${status} ${mapped.code} [${errors.map(e => e.code).join(',')}]`);
            throw mapped;
        }
    }

    private buildUrl(path: string, query?: CfRequestOptions['query']): string {
        const p = path.startsWith('/') ? path : `/${path}`;
        const url = new URL(this.baseUrl + p);
        for (const [k, v] of Object.entries(query || {})) {
            if (v === undefined || v === null) continue;
            url.searchParams.set(k, String(v));
        }
        return url.toString();
    }

    private sleep(ms: number): Promise<void> {
        if (this.opts.sleep) return this.opts.sleep(ms);
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }
}
