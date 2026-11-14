/**
 * PluginRoutes: /api/v1/plugins/:pluginId/* calls go to contributes.routes of the enabled plugin.
 *
 * Authenticated like every route (API key / employee); a sub-route only runs when it is listed in the manifest and
 * the caller has the scope that route declares; body up to 1 MB; returns the plugin's { status, body }.
 */
import { s } from '../api/schema';
import { ApiError, HttpMethod, route, RouteDef } from '../api/types';
import { principalSummary, requireScope } from '../api/auth/ApiAuth';
import type { PluginRecord, PluginRuntimeHandle } from './PluginManager';
import { TIMEOUTS } from './PluginSandbox';
import { tr } from '../../shared/i18n';

export interface PluginRouteDeps {
    get(id: string): PluginRecord | null;
    isActive(id: string): boolean;
    runtimeFor(id: string): PluginRuntimeHandle | null;
}

/** Matches "/bookings/:id" against "/bookings/42" → { id: '42' }; no match → null. */
export function matchRoutePath(pattern: string, actual: string): Record<string, string> | null {
    const a = pattern.split('/').filter(Boolean);
    const b = actual.split('/').filter(Boolean);
    if (a.length !== b.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < a.length; i++) {
        if (a[i].startsWith(':')) {
            try { params[a[i].slice(1)] = decodeURIComponent(b[i]); } catch { params[a[i].slice(1)] = b[i]; }
        } else if (a[i] !== b[i]) {
            return null;
        }
    }
    return params;
}

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function pluginRoutes(deps: PluginRouteDeps): RouteDef[] {
    return METHODS.map(method => route({
        method,
        path: '/plugins/:pluginId/*',
        scope: 'any',
        tags: ['Plugin'],
        operationId: `pluginRoute${method.charAt(0)}${method.slice(1).toLowerCase()}`,
        summary: tr('Route do plugin cung cấp ({{method}})', { method }),
        description: tr('Chạy route trong `contributes.routes` của plugin đang bật. Scope cần có theo khai báo của route; body tối đa 1 MB. Kết quả trả về là `body` plugin trả.'),
        params: s.object({ pluginId: s.string().max(100), '*': s.string().max(1000).default('') }),
        query: s.object({}).passthrough(),
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: s.any().optional() }),
        maxBodyBytes: 1024 * 1024,
        handler: async ctx => {
            const id = String(ctx.params.pluginId);
            const sub = `/${String(ctx.params['*'] || '').replace(/^\/+/, '')}`;
            const rec = deps.get(id);
            if (!rec || !deps.isActive(id)) throw new ApiError(404, 'PLUGIN_DISABLED', tr('Plugin {{id}} chưa cài hoặc đang tắt', { id }));
            let pathParams: Record<string, string> | null = null;
            const decl = (rec.manifest.contributes?.routes || []).find(r => {
                if (r.method !== method) return false;
                pathParams = matchRoutePath(r.path, sub);
                return pathParams !== null;
            });
            if (!decl) throw new ApiError(404, 'NOT_FOUND', tr('Plugin {{id}} không có route {{method}} {{sub}}', { id, method, sub }));
            requireScope(ctx.principal, (decl.scope || 'any') as any);
            const runtime = deps.runtimeFor(id);
            if (!runtime) throw new ApiError(503, 'PLUGIN_DISABLED', tr('Plugin {{id}} không có phần chạy nền', { id }));
            let out: any;
            try {
                out = await runtime.call('route.handle', {
                    method,
                    path: decl.path,
                    req: {
                        path: sub,
                        params: pathParams || {},
                        query: ctx.query,
                        body: ctx.body ?? null,
                        principal: principalSummary(ctx.principal),
                        requestId: ctx.requestId,
                    },
                }, TIMEOUTS.route);
            } catch (err: any) {
                if (err?.code === 'TIMEOUT') throw new ApiError(504, 'TIMEOUT', err.message);
                throw new ApiError(502, 'PLUGIN_ERROR', tr('Plugin lỗi: {{v1}}', { v1: err?.message || err }));
            }
            const status = Number(out?.status) || 200;
            if (status >= 400) {
                const body = out?.body;
                const message = typeof body === 'string' ? body : body?.error || body?.message || tr('Plugin trả HTTP {{status}}', { status });
                throw new ApiError(status, 'PLUGIN_ERROR', String(message).slice(0, 500), body);
            }
            return out?.body ?? null;
        },
    }));
}
