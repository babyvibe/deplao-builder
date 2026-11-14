/**
 * PluginApiBridge: every deplao.* call from a plugin (UI through postMessage → IPC, backend through RPC).
 *
 *  - API function (operationId or "METHOD /path") → ApiRouter.invoke with the principal plugin:<id>:
 *    the same scope / account checks, the same validation, the same IPC handler as external apps and the UI.
 *  - The plugin's own functions (storage, settings, log, events, http, workflow.trigger, media.upload,
 *    system) check the plugin permission here before touching any data.
 *  - deplao.cloudflare.* (backend only, permission "cloudflare:workers"): checks the manifest permission, the Worker / D1 names by prefix
 *    (pluginShortName) and that the folder is inside the app HERE, and only then calls the cloudflare:workers:* channel through IpcInvoker
 *    with a delegation grant (PluginGrant): the only admin channel a plugin can reach, the Cloudflare token never leaves main.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ApiError, Principal } from '../api/types';
import type { EventHub, ApiEvent } from '../api/events/EventHub';
import type { UploadStore } from '../api/UploadStore';
import type { PluginGrant } from '../api/IpcInvoker';
import { guardedRequest } from '../api/http/netGuard';
import { getApiSettingBool } from '../api/settings';
import { CloudError } from '../cloudflare/contracts';
import {
    assertResourceName, normalizeDeployOptions, normalizeDomainHostname, normalizeQuery, WORKERS_ERROR_STATUS, WORKERS_PERMISSION,
} from '../cloudflare/workers/validate';
import type { PluginRecord, PluginRuntimeHandle } from './PluginManager';
import type { PluginLogStore, PluginStorage } from './PluginStorage';
import { isSafeRelativePath, PLUGIN_API_VERSION, pluginShortName } from './manifest';
import { tr } from '../../shared/i18n';

export interface OperationInfo {
    method: string;
    keys: string[];
}

export interface BridgeDeps {
    manager: {
        get(id: string): PluginRecord | null;
        principalFor(id: string): Principal | null;
        settingsFor(id: string): Record<string, any>;
        runtimeFor(id: string): PluginRuntimeHandle | null;
        storage: PluginStorage;
        logs: PluginLogStore;
    };
    invoke: (target: string, input: { principal: Principal; params?: any; query?: any; body?: any; binary?: { maxBytes: number } }) => Promise<{ status: number; payload: any }>;
    operations: () => Map<string, OperationInfo>;
    hub: () => EventHub;
    invokeIpc: (channel: string, payload: any, principal: Principal) => Promise<any>;
    /**
     * Admin channels delegated to plugins (cloudflare:workers:*, see PLUGIN_DELEGATED_CHANNEL_PREFIXES): the bridge has already checked
     * the permission + prefix, and `grant` is passed along to the handler. Returns the handler result UNCHANGED ({ success, result } | { success:false,
     * error, code }) to keep the CF_* error codes. Missing (old test builds) → deplao.cloudflare reports NOT_IMPLEMENTED.
     */
    invokeDelegated?: (channel: string, payload: any, principal: Principal, grant: PluginGrant, timeoutMs: number) => Promise<any>;
    uploads: () => UploadStore;
    appVersion: () => string;
    requestImpl?: typeof guardedRequest;
}

const HTTP_MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** API functions that return files (downloadMessageMedia, downloadLibraryItem...): the plugin receives base64, up to the upload limit. */
const FILE_MAX_BYTES = UPLOAD_MAX_BYTES;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+json|.*\+xml)/i;

/** No Content-Type: treated as text only when it is valid UTF-8 and has no 0 byte (binary files → base64, not corrupted). */
function looksLikeText(body: Buffer): boolean {
    if (!body.length) return true;
    if (body.includes(0)) return false;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(body);
        return true;
    } catch {
        return false;
    }
}

/** Maximum wait time for each deplao.cloudflare function (deploys that upload assets + scripts can take a few minutes). */
const CLOUDFLARE_TIMEOUTS_MS = {
    status: 60_000,
    get: 60_000,
    d1Ensure: 60_000,
    d1Query: 60_000,
    d1Migrate: 5 * 60_000,
    deploy: 10 * 60_000,
    zones: 60_000,
    domains: 60_000,
    /** This includes the time spent waiting for the user to answer Deplao's confirmation dialog. */
    domainAttach: 10 * 60_000,
    domainDetach: 60_000,
};

function need(rec: PluginRecord, perm: string): void {
    if (!rec.granted_permissions.includes(perm)) {
        throw new ApiError(403, 'FORBIDDEN_SCOPE', tr('Plugin cần quyền "{{perm}}" trong manifest', { perm }), { required: perm });
    }
}

/** Error codes from the cloudflare:workers:* handler / CloudError → ApiError (keeps the contract's CF_* codes). */
function cloudflareApiError(code: unknown, message: unknown, retryAfterMs?: unknown): ApiError {
    const raw = typeof code === 'string' ? code : '';
    const text = String(message || tr('Lỗi không rõ'));
    const details = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? { retryAfterMs } : undefined;
    const mapped = raw === 'BAD_INPUT' ? 'VALIDATION_ERROR' : raw;
    if (WORKERS_ERROR_STATUS[mapped]) return new ApiError(WORKERS_ERROR_STATUS[mapped], mapped, text, details);
    if (['APP_ONLY', 'EMPLOYEE_MACHINE', 'REMOTE_WORKSPACE'].includes(raw)) return new ApiError(403, 'FORBIDDEN_SCOPE', text);
    return new ApiError(500, 'INTERNAL_ERROR', text);
}

function toCloudflareApiError(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof CloudError) return cloudflareApiError(err.code, err.message, err.retryAfterMs);
    return new ApiError(500, 'INTERNAL_ERROR', String((err as any)?.message || err));
}

/** Splits the SDK's flat parameters into path params / query / body according to the route. */
export function splitParams(info: OperationInfo, params: any): { params: Record<string, any>; query: Record<string, any>; body: any } {
    const input = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
    const pathParams: Record<string, any> = {};
    for (const key of info.keys) {
        const name = key === '*' ? 'path' : key;
        if (input[name] !== undefined) {
            pathParams[key] = String(input[name]);
            delete input[name];
        }
    }
    const explicitQuery = input.query && typeof input.query === 'object' ? input.query : undefined;
    const explicitBody = input.body;
    delete input.query;
    delete input.body;
    if (info.method === 'GET' || info.method === 'DELETE') {
        return { params: pathParams, query: { ...input, ...(explicitQuery || {}) }, body: explicitBody };
    }
    return { params: pathParams, query: explicitQuery || {}, body: explicitBody !== undefined ? explicitBody : input };
}

export class PluginApiBridge {
    private backendSubs = new Map<string, () => void>();

    constructor(private readonly deps: BridgeDeps) {}

    private active(pluginId: string): { rec: PluginRecord; principal: Principal } {
        const rec = this.deps.manager.get(pluginId);
        const principal = this.deps.manager.principalFor(pluginId);
        if (!rec || !principal) throw new ApiError(409, 'CONFLICT', tr('Plugin {{pluginId}} chưa được bật', { pluginId }));
        return { rec, principal };
    }

    private async callApi(principal: Principal, target: string, input: { params?: any; query?: any; body?: any }): Promise<any> {
        // binary: a file route returns { name, mime, size, base64 } instead of "chỉ gọi được qua HTTP" (only callable over HTTP; other routes skip it).
        const { status, payload } = await this.deps.invoke(target, { principal, ...input, binary: { maxBytes: FILE_MAX_BYTES } });
        if (!payload?.success) {
            const e = payload?.error || {};
            throw new ApiError(status || 500, e.code || 'INTERNAL_ERROR', e.message || tr('Lỗi không rõ'), e.details);
        }
        return payload.pagination ? { data: payload.data, pagination: payload.pagination } : { data: payload.data };
    }

    async handle(pluginId: string, method: string, params: any, origin: 'ui' | 'backend'): Promise<any> {
        const m = String(method || '');
        const { rec, principal } = this.active(pluginId);
        const p = params ?? {};

        switch (m) {
            case 'backend.call': {
                // The plugin's UI calls commands[name] in the backend of that SAME plugin.
                if (origin !== 'ui') throw new ApiError(400, 'VALIDATION_ERROR', tr('backend.call chỉ dùng từ UI plugin'));
                const name = String(p.name || '');
                if (!/^[A-Za-z0-9_.:-]{1,60}$/.test(name)) throw new ApiError(400, 'VALIDATION_ERROR', tr('Tên command không hợp lệ'));
                const runtime = this.deps.manager.runtimeFor(pluginId);
                if (!runtime) throw new ApiError(409, 'CONFLICT', tr('Plugin không có phần chạy nền (runtime web)'));
                try {
                    return await runtime.call('composer.command', { id: name, context: p.params ?? {} }, 30_000);
                } catch (err: any) {
                    throw new ApiError(err?.code === 'TIMEOUT' ? 504 : 502, err?.code === 'TIMEOUT' ? 'TIMEOUT' : 'PLUGIN_ERROR', err?.message || String(err));
                }
            }

            case 'system.info':
                return { appVersion: this.deps.appVersion(), apiVersion: PLUGIN_API_VERSION, pluginId: rec.id, pluginVersion: rec.version, runtime: rec.runtime };

            case 'api.request': {
                const verb = String(p.method || 'GET').toUpperCase();
                const path = String(p.path || '');
                if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(verb) || !path.startsWith('/')) throw new ApiError(400, 'VALIDATION_ERROR', tr('api.request cần { method, path: "/..." }'));
                return this.callApi(principal, `${verb} ${path}`, { query: p.query, body: p.body });
            }

            case 'settings.get':
                return this.deps.manager.settingsFor(pluginId);

            case 'storage.get':
                need(rec, 'storage');
                return this.deps.manager.storage.get(pluginId, p.key);
            case 'storage.set':
                need(rec, 'storage');
                this.deps.manager.storage.set(pluginId, p.key, p.value);
                return { ok: true };
            case 'storage.delete':
                need(rec, 'storage');
                return { deleted: this.deps.manager.storage.delete(pluginId, p.key) };
            case 'storage.list':
                need(rec, 'storage');
                return this.deps.manager.storage.list(pluginId, p.prefix || '', p.limit);
            case 'storage.dataDir':
                need(rec, 'storage');
                if (origin !== 'backend') throw new ApiError(400, 'VALIDATION_ERROR', tr('storage.dataDir chỉ dùng ở backend'));
                return this.deps.manager.storage.dataDir(pluginId);

            case 'log.debug':
            case 'log.info':
            case 'log.warn':
            case 'log.error':
                this.deps.manager.logs.append(pluginId, m.slice(4) as any, typeof p === 'string' ? p : String(p.message ?? JSON.stringify(p)).slice(0, 4000));
                return { ok: true };

            case 'events.emit': {
                need(rec, 'events:emit');
                const name = String(p.name || '');
                const allowed = rec.manifest.contributes?.events || [];
                if (!allowed.includes(name)) throw new ApiError(400, 'VALIDATION_ERROR', tr('Sự kiện "{{name}}" chưa khai báo trong contributes.events', { name }));
                const ev = this.deps.hub().publish({ type: `plugin.${pluginId}.${name}`, account_id: '', channel: '', data: p.data ?? null });
                return { id: ev?.id ?? null, seq: ev?.seq ?? 0 };
            }

            case 'events.subscribe': {
                if (origin !== 'backend') throw new ApiError(400, 'VALIDATION_ERROR', tr('UI đăng ký sự kiện qua cầu UI'));
                if (!principal.scopes.has('events:subscribe')) throw new ApiError(403, 'FORBIDDEN_SCOPE', tr('Cần scope events:subscribe'));
                this.backendSubs.get(pluginId)?.();
                const types = Array.isArray(p.types) ? p.types.map(String).slice(0, 50) : null;
                const unsubscribe = this.deps.hub().subscribe({
                    principal,
                    types,
                    handler: (ev: ApiEvent) => {
                        if (ev.type.startsWith(`plugin.${pluginId}.`)) return; // does not loop back to itself
                        this.deps.manager.runtimeFor(pluginId)?.notify('event', ev);
                    },
                });
                this.backendSubs.set(pluginId, unsubscribe);
                return { ok: true };
            }
            case 'events.unsubscribe':
                this.backendSubs.get(pluginId)?.();
                this.backendSubs.delete(pluginId);
                return { ok: true };

            case 'workflow.trigger': {
                need(rec, 'workflow:nodes');
                const type = String(p.type || '');
                if (!(rec.manifest.contributes?.triggers || []).some(t => t.type === type)) {
                    throw new ApiError(400, 'VALIDATION_ERROR', tr('Trigger "{{type}}" chưa khai báo trong contributes.triggers', { type }));
                }
                return this.deps.invokeIpc('workflow:triggerPlugin', { type, payload: p.payload ?? {}, pluginId }, principal);
            }

            case 'http.fetch': {
                if (origin !== 'backend') throw new ApiError(400, 'VALIDATION_ERROR', tr('http.fetch chỉ dùng ở backend; UI dùng fetch với ui.connectSrc'));
                need(rec, 'network');
                const init = p.init || {};
                const res = await (this.deps.requestImpl || guardedRequest)(String(p.url || ''), {
                    method: String(init.method || 'GET').toUpperCase(),
                    headers: init.headers && typeof init.headers === 'object' ? init.headers : {},
                    body: init.body === undefined || init.body === null ? undefined : String(init.body),
                    timeoutMs: Math.min(Math.max(1000, Number(init.timeoutMs) || 30_000), 120_000),
                    allowPrivate: getApiSettingBool('api_allow_private_urls'),
                    maxRedirects: 5,
                    maxBytes: HTTP_MAX_BYTES,
                }).catch((err: any) => {
                    throw new ApiError(502, 'UPSTREAM_ERROR', `http.fetch: ${err?.message || err}`);
                });
                const type = String(res.headers['content-type'] || '');
                // responseType: 'text' | 'base64' forces the return type; by default it is guessed from the Content-Type (if missing, the content is inspected).
                const textual = init.responseType === 'text' ? true
                    : init.responseType === 'base64' ? false
                        : TEXT_TYPES.test(type) || (!type && looksLikeText(res.body));
                return {
                    status: res.status,
                    url: res.url,
                    headers: res.headers,
                    truncated: res.truncated,
                    ...(textual ? { text: res.body.toString('utf8') } : { base64: res.body.toString('base64') }),
                };
            }

            case 'media.upload': {
                if (!principal.scopes.has('media:write') && !principal.scopes.has('chat:send')) throw new ApiError(403, 'FORBIDDEN_SCOPE', tr('Cần scope media:write hoặc chat:send'));
                const b64 = String(p.dataBase64 || '');
                if (b64.length > Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', tr('Upload qua plugin tối đa 25 MB'));
                const buf = Buffer.from(b64, 'base64');
                const record = await this.deps.uploads().saveBuffer(buf, String(p.name || 'file'), String(p.mime || ''), `plugin:${pluginId}`);
                return { upload_id: record.id, name: record.name, kind: record.kind, size: record.size, mime: record.mime, expires_at: record.expires_at };
            }

            case 'cloudflare.status':
            case 'cloudflare.workers.get':
            case 'cloudflare.workers.deployBundle':
            case 'cloudflare.d1.ensure':
            case 'cloudflare.d1.migrate':
            case 'cloudflare.d1.query':
            case 'cloudflare.zones':
            case 'cloudflare.workers.domains.list':
            case 'cloudflare.workers.domains.attach':
            case 'cloudflare.workers.domains.detach':
                return this.cloudflare(rec, principal, m, p, origin);

            default: {
                // operationId of API v1: "sendMessage" or "api.sendMessage".
                const opId = m.startsWith('api.') ? m.slice(4) : m;
                const info = this.deps.operations().get(opId);
                if (!info) throw new ApiError(404, 'NOT_FOUND', tr('Không có hàm "{{m}}" (xem operationId trong /docs)', { m }));
                const split = splitParams(info, p);
                return this.callApi(principal, opId, split);
            }
        }
    }

    /** Plugin turned off → unsubscribes its backend events. */
    cleanup(pluginId: string): void {
        this.backendSubs.get(pluginId)?.();
        this.backendSubs.delete(pluginId);
    }

    /**
     * deplao.cloudflare.*: checked BEFORE calling IPC: backend only, manifest permission "cloudflare:workers" (PLUGIN_PERMISSION),
     * Worker / D1 name = the prefix or "<prefix>-…" (CF_NAME_FORBIDDEN), bundleDir / dir must be a relative folder inside the
     * app (CF_BUNDLE_INVALID). Then calls the cloudflare:workers:* channel with the delegation grant; the handler in main checks again.
     */
    private async cloudflare(rec: PluginRecord, principal: Principal, method: string, p: any, origin: 'ui' | 'backend'): Promise<any> {
        if (origin !== 'backend') throw new ApiError(400, 'VALIDATION_ERROR', tr('deplao.cloudflare chỉ dùng ở backend của ứng dụng (UI gọi qua deplao.backend.call)'));
        if (!rec.granted_permissions.includes(WORKERS_PERMISSION)) {
            throw new ApiError(403, 'PLUGIN_PERMISSION', tr('Ứng dụng cần quyền "{{WORKERS_PERMISSION}}" trong manifest', { WORKERS_PERMISSION }), { required: WORKERS_PERMISSION });
        }
        const prefix = pluginShortName(rec.id);
        let channel = '';
        let payload: Record<string, unknown> = {};
        let timeoutMs = CLOUDFLARE_TIMEOUTS_MS.status;
        let pluginDir = '';
        try {
            pluginDir = this.pluginRoot(rec);
            switch (method) {
                case 'cloudflare.status':
                    channel = 'cloudflare:workers:status';
                    payload = {};
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.status;
                    break;
                case 'cloudflare.workers.get':
                    channel = 'cloudflare:workers:get';
                    payload = { name: assertResourceName(p.name, prefix, 'Worker') };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.get;
                    break;
                case 'cloudflare.workers.deployBundle': {
                    const opts = normalizeDeployOptions(p, prefix); // Worker + D1 names in bindings, binding, secret
                    channel = 'cloudflare:workers:deploy';
                    payload = {
                        name: opts.name,
                        bundleDir: this.pluginDirectory(rec, p.bundleDir, 'bundleDir'),
                        bindings: p.bindings ?? {},
                        secrets: p.secrets ?? {},
                        workersDev: opts.workersDev,
                    };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.deploy;
                    break;
                }
                case 'cloudflare.d1.ensure':
                    channel = 'cloudflare:workers:d1Ensure';
                    payload = { name: assertResourceName(p.name, prefix, 'D1') };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.d1Ensure;
                    break;
                case 'cloudflare.d1.migrate':
                    channel = 'cloudflare:workers:d1Migrate';
                    payload = { name: assertResourceName(p.name, prefix, 'D1'), dir: this.pluginDirectory(rec, p.dir, 'dir') };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.d1Migrate;
                    break;
                case 'cloudflare.d1.query': {
                    const name = assertResourceName(p.name, prefix, 'D1');
                    const q = normalizeQuery(p.sql, p.params);
                    channel = 'cloudflare:workers:d1Query';
                    payload = { name, sql: q.sql, params: q.params };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.d1Query;
                    break;
                }
                case 'cloudflare.zones':
                    channel = 'cloudflare:workers:zones';
                    payload = {};
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.zones;
                    break;
                case 'cloudflare.workers.domains.list':
                    channel = 'cloudflare:workers:domains';
                    payload = { name: assertResourceName(p.name, prefix, 'Worker') };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.domains;
                    break;
                case 'cloudflare.workers.domains.attach':
                    channel = 'cloudflare:workers:domainAttach';
                    payload = { name: assertResourceName(p.name, prefix, 'Worker'), hostname: normalizeDomainHostname(p.hostname) };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.domainAttach;
                    break;
                case 'cloudflare.workers.domains.detach':
                    channel = 'cloudflare:workers:domainDetach';
                    payload = { name: assertResourceName(p.name, prefix, 'Worker'), hostname: normalizeDomainHostname(p.hostname) };
                    timeoutMs = CLOUDFLARE_TIMEOUTS_MS.domainDetach;
                    break;
                default:
                    throw new ApiError(404, 'NOT_FOUND', tr('Không có hàm "{{method}}"', { method }));
            }
        } catch (err) {
            throw toCloudflareApiError(err);
        }
        if (!this.deps.invokeDelegated) throw new ApiError(501, 'NOT_IMPLEMENTED', tr('Bản app này chưa hỗ trợ deplao.cloudflare'));
        const grant: PluginGrant = Object.freeze({
            pluginId: rec.id,
            pluginName: String(rec.name || rec.id).slice(0, 80),
            permission: WORKERS_PERMISSION,
            resourcePrefix: prefix,
            pluginDir,
            log: (level: 'info' | 'warn' | 'error', message: string) => this.deps.manager.logs.append(rec.id, level, String(message).slice(0, 4000)),
        });
        const res = await this.deps.invokeDelegated(channel, payload, principal, grant, timeoutMs);
        if (res && typeof res === 'object' && res.success === false) throw cloudflareApiError(res.code, res.error, res.retryAfterMs);
        return res && typeof res === 'object' && 'result' in res ? res.result : null;
    }

    /** realpath of the installed app folder. */
    private pluginRoot(rec: PluginRecord): string {
        try {
            return fs.realpathSync(rec.install_path);
        } catch {
            throw new CloudError('CF_BUNDLE_INVALID', tr('Không thấy thư mục của ứng dụng trên máy'));
        }
    }

    /** Relative folder inside the app → absolute path (realpath); rejects anything outside (.., absolute paths, symlinks). */
    private pluginDirectory(rec: PluginRecord, rel: unknown, label: string): string {
        if (typeof rel !== 'string' || !isSafeRelativePath(rel)) {
            throw new CloudError('CF_BUNDLE_INVALID', tr('{{label}} phải là thư mục tương đối trong ứng dụng, vd "vendor/fintrack"', { label }));
        }
        const root = this.pluginRoot(rec);
        const full = path.resolve(root, ...rel.split('/').filter(Boolean));
        let real: string;
        try {
            real = fs.realpathSync(full);
        } catch {
            throw new CloudError('CF_BUNDLE_INVALID', tr('Không thấy thư mục "{{rel}}" trong ứng dụng', { rel }));
        }
        if (real !== root && !real.startsWith(root + path.sep)) throw new CloudError('CF_BUNDLE_INVALID', tr('{{label}} phải nằm trong thư mục của ứng dụng', { label }));
        if (!fs.statSync(real).isDirectory()) throw new CloudError('CF_BUNDLE_INVALID', tr('"{{rel}}" không phải thư mục', { rel }));
        return real;
    }
}
