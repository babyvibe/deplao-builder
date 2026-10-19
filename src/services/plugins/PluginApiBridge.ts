/**
 * PluginApiBridge — mọi lời gọi deplao.* của plugin (UI qua postMessage→IPC, backend qua RPC).
 *
 *  - Hàm API (operationId hoặc "METHOD /path") → ApiRouter.invoke với principal plugin:<id>:
 *    cùng kiểm tra scope/tài khoản, cùng validate, cùng IPC handler với app ngoài và UI.
 *  - Hàm riêng của plugin (storage, settings, log, events, http, workflow.trigger, media.upload,
 *    system) kiểm tra quyền plugin ở đây rồi mới chạm dữ liệu.
 */
import { ApiError, Principal } from '../api/types';
import type { EventHub, ApiEvent } from '../api/events/EventHub';
import type { UploadStore } from '../api/UploadStore';
import { guardedRequest } from '../api/netGuard';
import { getApiSettingBool } from '../api/settings';
import type { PluginRecord, PluginRuntimeHandle } from './PluginManager';
import type { PluginLogStore, PluginStorage } from './PluginStorage';
import { PLUGIN_API_VERSION } from './manifest';

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
    invoke: (target: string, input: { principal: Principal; params?: any; query?: any; body?: any }) => Promise<{ status: number; payload: any }>;
    operations: () => Map<string, OperationInfo>;
    hub: () => EventHub;
    invokeIpc: (channel: string, payload: any, principal: Principal) => Promise<any>;
    uploads: () => UploadStore;
    appVersion: () => string;
    requestImpl?: typeof guardedRequest;
}

const HTTP_MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+json|.*\+xml)/i;

function need(rec: PluginRecord, perm: string): void {
    if (!rec.granted_permissions.includes(perm)) {
        throw new ApiError(403, 'FORBIDDEN_SCOPE', `Plugin cần quyền "${perm}" trong manifest`, { required: perm });
    }
}

/** Tách tham số phẳng của SDK thành path params / query / body theo route. */
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
        if (!rec || !principal) throw new ApiError(409, 'CONFLICT', `Plugin ${pluginId} chưa được bật`);
        return { rec, principal };
    }

    private async callApi(principal: Principal, target: string, input: { params?: any; query?: any; body?: any }): Promise<any> {
        const { status, payload } = await this.deps.invoke(target, { principal, ...input });
        if (!payload?.success) {
            const e = payload?.error || {};
            throw new ApiError(status || 500, e.code || 'INTERNAL_ERROR', e.message || 'Lỗi không rõ', e.details);
        }
        return payload.pagination ? { data: payload.data, pagination: payload.pagination } : { data: payload.data };
    }

    async handle(pluginId: string, method: string, params: any, origin: 'ui' | 'backend'): Promise<any> {
        const m = String(method || '');
        const { rec, principal } = this.active(pluginId);
        const p = params ?? {};

        switch (m) {
            case 'backend.call': {
                // UI của plugin gọi commands[name] trong backend của CHÍNH plugin đó.
                if (origin !== 'ui') throw new ApiError(400, 'VALIDATION_ERROR', 'backend.call chỉ dùng từ UI plugin');
                const name = String(p.name || '');
                if (!/^[A-Za-z0-9_.:-]{1,60}$/.test(name)) throw new ApiError(400, 'VALIDATION_ERROR', 'Tên command không hợp lệ');
                const runtime = this.deps.manager.runtimeFor(pluginId);
                if (!runtime) throw new ApiError(409, 'CONFLICT', 'Plugin không có phần chạy nền (runtime web)');
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
                if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(verb) || !path.startsWith('/')) throw new ApiError(400, 'VALIDATION_ERROR', 'api.request cần { method, path: "/..." }');
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
                if (origin !== 'backend') throw new ApiError(400, 'VALIDATION_ERROR', 'storage.dataDir chỉ dùng ở backend');
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
                if (!allowed.includes(name)) throw new ApiError(400, 'VALIDATION_ERROR', `Sự kiện "${name}" chưa khai báo trong contributes.events`);
                const ev = this.deps.hub().publish({ type: `plugin.${pluginId}.${name}`, account_id: '', channel: '', data: p.data ?? null });
                return { id: ev?.id ?? null, seq: ev?.seq ?? 0 };
            }

            case 'events.subscribe': {
                if (origin !== 'backend') throw new ApiError(400, 'VALIDATION_ERROR', 'UI đăng ký sự kiện qua cầu UI');
                if (!principal.scopes.has('events:subscribe')) throw new ApiError(403, 'FORBIDDEN_SCOPE', 'Cần scope events:subscribe');
                this.backendSubs.get(pluginId)?.();
                const types = Array.isArray(p.types) ? p.types.map(String).slice(0, 50) : null;
                const unsubscribe = this.deps.hub().subscribe({
                    principal,
                    types,
                    handler: (ev: ApiEvent) => {
                        if (ev.type.startsWith(`plugin.${pluginId}.`)) return; // không vòng lại chính mình
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
                    throw new ApiError(400, 'VALIDATION_ERROR', `Trigger "${type}" chưa khai báo trong contributes.triggers`);
                }
                return this.deps.invokeIpc('workflow:triggerPlugin', { type, payload: p.payload ?? {}, pluginId }, principal);
            }

            case 'http.fetch': {
                if (origin !== 'backend') throw new ApiError(400, 'VALIDATION_ERROR', 'http.fetch chỉ dùng ở backend; UI dùng fetch với ui.connectSrc');
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
                const textual = TEXT_TYPES.test(type) || !type;
                return {
                    status: res.status,
                    url: res.url,
                    headers: res.headers,
                    truncated: res.truncated,
                    ...(textual ? { text: res.body.toString('utf8') } : { base64: res.body.toString('base64') }),
                };
            }

            case 'media.upload': {
                if (!principal.scopes.has('media:write') && !principal.scopes.has('chat:send')) throw new ApiError(403, 'FORBIDDEN_SCOPE', 'Cần scope media:write hoặc chat:send');
                const b64 = String(p.dataBase64 || '');
                if (b64.length > Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Upload qua plugin tối đa 25 MB');
                const buf = Buffer.from(b64, 'base64');
                const record = await this.deps.uploads().saveBuffer(buf, String(p.name || 'file'), String(p.mime || ''), `plugin:${pluginId}`);
                return { upload_id: record.id, name: record.name, kind: record.kind, size: record.size, mime: record.mime, expires_at: record.expires_at };
            }

            default: {
                // operationId của API v1: "sendMessage" hoặc "api.sendMessage".
                const opId = m.startsWith('api.') ? m.slice(4) : m;
                const info = this.deps.operations().get(opId);
                if (!info) throw new ApiError(404, 'NOT_FOUND', `Không có hàm "${m}" (xem operationId trong /docs)`);
                const split = splitParams(info, p);
                return this.callApi(principal, opId, split);
            }
        }
    }

    /** Plugin tắt → huỷ đăng ký sự kiện của backend. */
    cleanup(pluginId: string): void {
        this.backendSubs.get(pluginId)?.();
        this.backendSubs.delete(pluginId);
    }
}
