/**
 * ApiRouter — định tuyến /api/v1 với pipeline cố định:
 *
 *   requestId → (OPTIONS) → api_enabled → workspace → match route → auth (+ chống dò key)
 *   → IP allowlist → scope → rate limit (chỉ khi khách bật) → body (giới hạn) → validate
 *   → handler (chỉ gọi IPC chung qua ctx.call) → envelope → nhật ký
 *
 * `invoke()` chạy cùng pipeline (từ bước scope) cho plugin, không qua HTTP.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
    AccountInfo, ApiContext, ApiError, HttpMethod, IpcCallOptions, Paged, Principal, RESPONSE_HANDLED,
    RouteDef, principalLogId,
} from './types';
import { CORS_HEADERS, parseQuery, readJsonBody, sendJson } from './http';
import { clientIp, ipAllowed, isLocalRequest } from './ip';
import { extractToken, requireAccount, requireScope } from './ApiAuth';
import { IpcInvoker, unwrapIpcResult } from './IpcInvoker';
import { AccountDirectory } from './AccountDirectory';
import { RequestLog } from './RequestLog';
import { BruteForceGuard, RateLimiter } from './RateLimiter';
import { getApiSettingBool, getApiSettingNumber } from './settings';

export const API_PREFIX = '/api/v1';

interface CompiledRoute {
    def: RouteDef;
    regex: RegExp;
    keys: string[];
    operationId: string;
    /** Dạng OpenAPI: /accounts/{accountId}/conversations */
    template: string;
    /** Số đoạn tĩnh: khi nhiều route cùng khớp, route cụ thể hơn thắng (vd /users/lookup thắng /users/:userId). */
    statics: number;
}

export interface RouterDeps {
    invoker: IpcInvoker;
    accounts: AccountDirectory;
    log: RequestLog;
    rateLimiter: RateLimiter;
    guard: BruteForceGuard;
    authenticate: (token: string, ip: string) => Principal | null;
    /** false khi workspace đang mở là workspace nhân viên (không có dữ liệu local). */
    isWorkspaceAvailable: () => boolean;
    /** HTML trang /docs. */
    docsHtml: () => string;
    /** OpenAPI JSON (đã cache). */
    openApi: () => any;
    onError?: (err: any, route: string) => void;
}

export function operationIdFor(method: HttpMethod, path: string): string {
    const slug = path
        .replace(/:([a-zA-Z0-9_]+)/g, 'by_$1')
        .replace(/\*/g, 'any')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return `${method.toLowerCase()}_${slug || 'root'}`;
}

function compile(def: RouteDef): CompiledRoute {
    const keys: string[] = [];
    let template = '';
    const pattern = def.path.split('/').map(seg => {
        if (!seg) return '';
        if (seg.startsWith(':')) {
            const key = seg.slice(1);
            keys.push(key);
            template += `/{${key}}`;
            return '([^/]+)';
        }
        if (seg === '*') {
            keys.push('*');
            template += '/{path}';
            return '(.*)';
        }
        template += `/${seg}`;
        return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return {
        def,
        keys,
        regex: new RegExp(`^${pattern}/?$`),
        operationId: def.operationId || operationIdFor(def.method, def.path),
        template: template || '/',
        statics: def.path.split('/').filter(seg => seg && !seg.startsWith(':') && seg !== '*').length,
    };
}

function isPaged(v: any): v is Paged {
    return !!v && typeof v === 'object' && v.__paged === true;
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

interface StoredResponse { status: number; payload: any; at: number; }

class IdempotencyCache {
    private done = new Map<string, StoredResponse>();
    private inflight = new Map<string, Promise<StoredResponse>>();
    private static TTL = 24 * 3600_000;
    private static MAX = 10_000;

    get(key: string): StoredResponse | undefined {
        const hit = this.done.get(key);
        if (hit && Date.now() - hit.at > IdempotencyCache.TTL) {
            this.done.delete(key);
            return undefined;
        }
        return hit;
    }

    pending(key: string): Promise<StoredResponse> | undefined {
        return this.inflight.get(key);
    }

    track(key: string, p: Promise<StoredResponse>): void {
        this.inflight.set(key, p);
        p.then(r => {
            this.inflight.delete(key);
            // Không cache lỗi tạm thời (offline, rate limit, 5xx) để client retry được.
            if (r.status < 500 && r.status !== 409 && r.status !== 429) {
                this.done.set(key, r);
                if (this.done.size > IdempotencyCache.MAX) {
                    const first = this.done.keys().next().value;
                    if (first !== undefined) this.done.delete(first);
                }
            }
        }, () => this.inflight.delete(key));
    }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export class ApiRouter {
    private routes: CompiledRoute[] = [];
    private byOperationId = new Map<string, CompiledRoute>();
    private idempotency = new IdempotencyCache();

    constructor(private readonly deps: RouterDeps) {}

    register(defs: RouteDef[]): void {
        for (const def of defs) {
            const compiled = compile(def);
            if (this.byOperationId.has(compiled.operationId)) {
                throw new Error(`[ApiRouter] operationId trùng: ${compiled.operationId}`);
            }
            const dup = this.routes.find(r => r.def.method === def.method && r.def.path === def.path);
            if (dup) throw new Error(`[ApiRouter] route trùng: ${def.method} ${def.path}`);
            this.routes.push(compiled);
            this.byOperationId.set(compiled.operationId, compiled);
        }
    }

    unregister(predicate: (def: RouteDef) => boolean): void {
        this.routes = this.routes.filter(r => {
            if (!predicate(r.def)) return true;
            this.byOperationId.delete(r.operationId);
            return false;
        });
    }

    list(): Array<{ def: RouteDef; operationId: string; template: string }> {
        return this.routes.map(r => ({ def: r.def, operationId: r.operationId, template: r.template }));
    }

    getDeps(): RouterDeps {
        return this.deps;
    }

    match(method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | { status: 404 | 405; allow?: string[] } {
        const allow: string[] = [];
        let best: { r: CompiledRoute; m: RegExpExecArray } | null = null;
        for (const r of this.routes) {
            const m = r.regex.exec(path);
            if (!m) continue;
            if (r.def.method !== method) {
                allow.push(r.def.method);
                continue;
            }
            // Không phụ thuộc thứ tự đăng ký: đoạn tĩnh nhiều hơn thắng; bằng nhau thì route đăng ký trước.
            if (!best || r.statics > best.r.statics) best = { r, m };
        }
        if (best) {
            const { r, m } = best;
            const params: Record<string, string> = {};
            r.keys.forEach((key, i) => {
                try { params[key] = decodeURIComponent(m[i + 1]); } catch { params[key] = m[i + 1]; }
            });
            return { route: r, params };
        }
        return allow.length ? { status: 405, allow } : { status: 404 };
    }

    // ─── HTTP ─────────────────────────────────────────────────────────────

    /** true nếu URL thuộc API v1 / docs (đã xử lý), false để relay xử lý tiếp. */
    handles(url: string): boolean {
        const pathname = url.split('?')[0];
        return pathname === API_PREFIX || pathname.startsWith(API_PREFIX + '/') || pathname === '/docs' || pathname.startsWith('/docs/');
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const started = Date.now();
        const requestId = randomUUID();
        const url = req.url || '';
        const qIndex = url.indexOf('?');
        const pathname = qIndex >= 0 ? url.slice(0, qIndex) : url;
        const method = String(req.method || 'GET').toUpperCase();
        const { ip } = clientIp(req, getApiSettingBool('api_trust_proxy_headers'));
        res.setHeader('X-Request-Id', requestId);

        let principal: Principal | null = null;
        let routeLabel = pathname;
        let status = 200;
        let errorCode: string | null = null;

        try {
            if (method === 'OPTIONS') {
                res.writeHead(204, CORS_HEADERS);
                res.end();
                return;
            }
            if (pathname === '/docs' || pathname.startsWith('/docs/')) {
                res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
                res.end(this.deps.docsHtml());
                return;
            }
            const subPath = pathname.slice(API_PREFIX.length) || '/';

            // Tài liệu luôn xem được (kể cả khi đang chặn API): chỉ là mô tả endpoint, không có dữ liệu.
            // Từ xa cần key chỉ khi người dùng tắt "Tài liệu công khai" (mặc định bật).
            if (subPath === '/openapi.json') {
                routeLabel = '/v1/openapi.json';
                if (!isLocalRequest(req) && !getApiSettingBool('api_docs_public')) {
                    const token = extractToken(req);
                    if (!token || !this.deps.authenticate(token, ip)) {
                        throw new ApiError(401, 'UNAUTHORIZED', 'Cần API key để xem tài liệu từ xa (hoặc bật "Tài liệu công khai")');
                    }
                }
                sendJson(res, 200, this.deps.openApi());
                return;
            }

            if (!getApiSettingBool('api_enabled')) {
                throw new ApiError(503, 'API_DISABLED', 'API đang tắt (bật ở Công cụ → Ứng dụng, API & Webhook → API)');
            }

            const matched = this.match(method, subPath);
            if ('status' in matched) {
                if (matched.status === 405) {
                    throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Không hỗ trợ ${method}`, undefined, { Allow: matched.allow!.join(', ') });
                }
                throw new ApiError(404, 'NOT_FOUND', `Không có endpoint ${method} ${API_PREFIX}${subPath}`);
            }
            const { route, params } = matched;
            routeLabel = `/v1${route.template}`;

            if (route.def.scope !== null && !this.deps.isWorkspaceAvailable()) {
                throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', 'Máy đang mở workspace nhân viên; API chỉ phục vụ workspace local');
            }

            // ── Auth ──
            if (route.def.scope !== null) {
                const token = extractToken(req);
                principal = token ? this.deps.authenticate(token, ip) : null;
                if (!principal) {
                    const guardOn = getApiSettingBool('api_auth_bruteforce_guard');
                    if (guardOn && this.deps.guard.isBlocked(ip)) {
                        throw new ApiError(429, 'AUTH_BLOCKED', 'IP tạm bị chặn vì gửi quá nhiều key sai', undefined, { 'Retry-After': '600' });
                    }
                    if (guardOn && token) this.deps.guard.recordFailure(ip);
                    throw new ApiError(401, 'UNAUTHORIZED', token ? 'API key không hợp lệ, đã thu hồi hoặc hết hạn' : 'Thiếu API key (Authorization: Bearer dpk_... hoặc X-Api-Key)');
                }
                if (!ipAllowed(ip, principal.allowedIps)) {
                    throw new ApiError(403, 'FORBIDDEN_IP', `IP ${ip} không nằm trong danh sách cho phép của key`);
                }
            }

            // ── Body ──
            let body: any;
            if (!route.def.rawBody && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
                const maxBytes = route.def.maxBodyBytes || Math.max(1, getApiSettingNumber('api_max_body_mb')) * 1024 * 1024;
                body = await readJsonBody(req, maxBytes);
            }

            // ── Idempotency (POST) ──
            const idemHeader = req.headers['idempotency-key'];
            const idemKey = method === 'POST' && principal && typeof idemHeader === 'string' && idemHeader.length > 0 && idemHeader.length <= 200
                ? `${principalLogId(principal)}:${routeLabel}:${idemHeader}`
                : null;
            if (idemKey) {
                const hit = this.idempotency.get(idemKey) || (await this.idempotency.pending(idemKey)?.catch(() => undefined));
                if (hit) {
                    status = hit.status;
                    sendJson(res, hit.status, hit.payload, { 'Idempotent-Replayed': 'true' });
                    return;
                }
            }

            const exec = this.execute(route, {
                principal: principal || anonymousPrincipal(),
                params,
                query: parseQuery(qIndex >= 0 ? url.slice(qIndex + 1) : ''),
                body,
                requestId,
                ip,
                raw: { req, res },
            });
            if (idemKey) this.idempotency.track(idemKey, exec.then(r => ({ status: r.status, payload: r.payload, at: Date.now() })));
            const out = await exec;
            status = out.status;
            errorCode = out.payload?.error?.code || null;
            if (out.handled) return;
            sendJson(res, out.status, out.payload, out.headers);
        } catch (err: any) {
            const apiErr = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', 'Lỗi không mong đợi');
            if (!(err instanceof ApiError)) this.deps.onError?.(err, routeLabel);
            status = apiErr.status;
            errorCode = apiErr.code;
            sendJson(res, apiErr.status, errorEnvelope(apiErr, requestId), apiErr.headers || {});
        } finally {
            if (pathname !== `${API_PREFIX}/health` && method !== 'OPTIONS' && !pathname.startsWith('/docs')) {
                this.deps.log.record({
                    principal_id: principal ? principalLogId(principal) : 'anonymous',
                    method,
                    route: routeLabel,
                    status,
                    took_ms: Date.now() - started,
                    ip,
                    request_id: requestId,
                    error_code: errorCode,
                    created_at: started,
                });
            }
        }
    }

    // ─── Thực thi (dùng chung HTTP + plugin) ─────────────────────────────

    private async execute(route: CompiledRoute, input: {
        principal: Principal;
        params: Record<string, any>;
        query: Record<string, any>;
        body: any;
        requestId: string;
        ip: string;
        raw?: ApiContext['raw'];
    }): Promise<{ status: number; payload: any; headers?: Record<string, string>; handled?: boolean }> {
        const { def } = route;
        const { principal, requestId } = input;
        try {
            requireScope(principal, def.scope);

            if (def.scope !== null && principal.kind !== 'system') {
                const rl = this.deps.rateLimiter.take(principalLogId(principal), principal.rateLimitPerMin);
                if (!rl.allowed) {
                    throw new ApiError(429, 'RATE_LIMITED', `Vượt giới hạn ${rl.limit} request/phút đã đặt cho key`, undefined, {
                        'Retry-After': String(rl.retryAfterSec),
                        'X-RateLimit-Limit': String(rl.limit),
                        'X-RateLimit-Remaining': '0',
                    });
                }
            }

            const params = def.params ? parseOrThrow(def.params, input.params, true, 'params') : input.params;
            const query = def.query ? parseOrThrow(def.query, input.query, true, 'query') : {};
            const body = def.body ? parseOrThrow(def.body, input.body, false, 'body') : undefined;

            const ctx = this.buildContext(principal, params, query, body, requestId, input.ip, input.raw);
            const result = await def.handler(ctx);
            if (result === RESPONSE_HANDLED) {
                return { status: input.raw?.res.statusCode || 200, payload: null, handled: true };
            }
            if (isPaged(result)) {
                return { status: 200, payload: { success: true, data: result.data, pagination: result.pagination, request_id: requestId } };
            }
            return { status: 200, payload: { success: true, data: result === undefined ? null : result, request_id: requestId } };
        } catch (err: any) {
            const apiErr = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', 'Lỗi không mong đợi');
            if (!(err instanceof ApiError)) this.deps.onError?.(err, route.template);
            return { status: apiErr.status, payload: errorEnvelope(apiErr, requestId), headers: apiErr.headers };
        }
    }

    buildContext(principal: Principal, params: any, query: any, body: any, requestId: string, ip: string, raw?: ApiContext['raw']): ApiContext {
        const invoker = this.deps.invoker;
        const accounts = this.deps.accounts;
        return {
            principal,
            params,
            query,
            body,
            requestId,
            ip,
            raw,
            ipc: (channel: string, ...args: any[]) => invoker.invoke(channel, args, principal, { requestId }),
            call: async (channel: string, payload?: any, opts?: IpcCallOptions) => {
                const res = await invoker.invoke(channel, payload === undefined ? [] : [payload], principal, { requestId, timeoutMs: opts?.timeoutMs });
                return unwrapIpcResult(res, opts);
            },
            account: async (accountId: string): Promise<AccountInfo> => {
                requireAccount(principal, accountId);
                const acc = await accounts.get(accountId);
                if (!acc) throw new ApiError(404, 'NOT_FOUND', `Không tìm thấy tài khoản ${accountId}`);
                return acc;
            },
            listAccounts: () => accounts.list(),
            zaloAuth: async (accountId: string) => {
                requireAccount(principal, accountId);
                return accounts.zaloAuthFor(accountId);
            },
        };
    }

    /**
     * Gọi route không qua HTTP (plugin, test). `target` = operationId hoặc "METHOD /path".
     * Route trả stream (raw) không gọi được theo cách này.
     */
    async invoke(target: string, input: {
        principal: Principal;
        params?: Record<string, any>;
        query?: Record<string, any>;
        body?: any;
        requestId?: string;
        ip?: string;
    }): Promise<{ status: number; payload: any }> {
        const requestId = input.requestId || randomUUID();
        let route: CompiledRoute | undefined = this.byOperationId.get(target);
        let params = input.params || {};
        if (!route) {
            const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i.exec(target.trim());
            if (m) {
                const path = m[2].startsWith(API_PREFIX) ? m[2].slice(API_PREFIX.length) : m[2];
                const matched = this.match(m[1].toUpperCase(), path.split('?')[0]);
                if ('route' in matched) {
                    route = matched.route;
                    params = { ...matched.params, ...params };
                }
            }
        }
        if (!route) {
            const err = new ApiError(404, 'NOT_FOUND', `Không có thao tác ${target}`);
            return { status: 404, payload: errorEnvelope(err, requestId) };
        }
        if (route.def.rawResponse || route.def.rawBody) {
            const err = new ApiError(400, 'VALIDATION_ERROR', `${route.operationId} chỉ gọi được qua HTTP`);
            return { status: 400, payload: errorEnvelope(err, requestId) };
        }
        if (!getApiSettingBool('api_enabled')) {
            const err = new ApiError(503, 'API_DISABLED', 'API đang tắt (bật ở Công cụ → Ứng dụng, API & Webhook → API)');
            return { status: 503, payload: errorEnvelope(err, requestId) };
        }
        const started = Date.now();
        const out = await this.execute(route, {
            principal: input.principal,
            params,
            query: input.query || {},
            body: input.body,
            requestId,
            ip: input.ip || input.principal.kind,
        });
        this.deps.log.record({
            principal_id: principalLogId(input.principal),
            method: route.def.method,
            route: `/v1${route.template}`,
            status: out.status,
            took_ms: Date.now() - started,
            ip: input.ip || input.principal.kind,
            request_id: requestId,
            error_code: out.payload?.error?.code || null,
            created_at: started,
        });
        return { status: out.status, payload: out.payload };
    }
}

function parseOrThrow(schema: any, value: any, coerce: boolean, where: string): any {
    const r = schema.parse(value === undefined && where !== 'body' ? {} : value, { coerce });
    if (!r.ok) {
        throw new ApiError(400, 'VALIDATION_ERROR', `Tham số ${where} không hợp lệ`, r.issues.map((i: any) => ({
            path: `${where}${i.path && i.path !== '(root)' ? '.' + i.path : ''}`,
            message: i.message,
        })));
    }
    return r.value;
}

export function errorEnvelope(err: ApiError, requestId: string): any {
    return {
        success: false,
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
        request_id: requestId,
    };
}

function anonymousPrincipal(): Principal {
    return {
        kind: 'system',
        id: 'anonymous',
        name: 'anonymous',
        scopes: new Set(),
        accountIds: [],
        rateLimitPerMin: 0,
        erp: { employeeId: 'boss', role: 'guest' },
        allowedIps: null,
    };
}

export function systemPrincipal(): Principal {
    return {
        kind: 'system',
        id: 'system',
        name: 'Deplao',
        scopes: new Set(['admin']),
        accountIds: null,
        rateLimitPerMin: 0,
        erp: { employeeId: 'boss', role: 'owner' },
        allowedIps: null,
    };
}
