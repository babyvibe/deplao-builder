/**
 * Nhóm Hệ thống: health, me, thông tin máy chủ, danh mục scope.
 */
import { s } from '../schema';
import { API_SCOPES, SCOPE_PRESETS, route, RouteDef } from '../types';
import { principalSummary } from '../ApiAuth';
import { activeWorkspace, appMode, appVersion, startedAt } from '../runtime';

export function systemRoutes(): RouteDef[] {
    return [
        route({
            method: 'GET', path: '/health', scope: null, tags: ['Hệ thống'], operationId: 'health',
            summary: 'Kiểm tra API còn sống',
            description: 'Không cần key. Dùng cho uptime monitor.',
            response: s.object({ status: s.string(), version: s.string(), uptime_ms: s.int(), time: s.int() }),
            handler: () => ({ status: 'ok', version: appVersion(), uptime_ms: Date.now() - startedAt, time: Date.now() }),
        }),
        route({
            method: 'GET', path: '/me', scope: 'any', tags: ['Hệ thống'], operationId: 'getMe',
            summary: 'Thông tin key đang dùng (scope, tài khoản được phép)',
            response: s.object({
                kind: s.string(), id: s.string(), name: s.string(), scopes: s.array(s.string()),
                account_ids: s.array(s.string()).nullable(), rate_limit_per_min: s.int(), erp_role: s.string(),
                allowed_ips: s.array(s.string()).nullable(),
            }),
            examples: {
                response: {
                    kind: 'apikey', id: '6f1c…', name: 'Bot CSKH', scopes: ['chat:read', 'chat:send'],
                    account_ids: ['0501234567'], rate_limit_per_min: 0, erp_role: 'manager', allowed_ips: null,
                },
            },
            handler: ctx => principalSummary(ctx.principal),
        }),
        route({
            method: 'GET', path: '/system/info', scope: 'settings:read', tags: ['Hệ thống'], operationId: 'getSystemInfo',
            summary: 'Phiên bản, chế độ, workspace, trạng thái server/tunnel',
            handler: async ctx => {
                let relay: any = null;
                try { relay = await ctx.call('relay:getServerStatus'); } catch { relay = null; }
                return {
                    version: appVersion(),
                    mode: appMode(),
                    workspace: activeWorkspace(),
                    uptime_ms: Date.now() - startedAt,
                    server: relay ? {
                        running: !!relay.running,
                        port: relay.port ?? null,
                        local_ips: relay.localIPs || [],
                        tunnel_active: !!relay.tunnelActive,
                        tunnel_url: relay.tunnelUrl || null,
                        connected_employees: Array.isArray(relay.connectedEmployees) ? relay.connectedEmployees.length : 0,
                    } : null,
                };
            },
        }),
        route({
            method: 'GET', path: '/scopes', scope: null, tags: ['Hệ thống'], operationId: 'listScopes',
            summary: 'Danh mục scope và preset',
            handler: () => ({
                scopes: API_SCOPES.map(sc => ({ id: sc.id, group: sc.group, label: sc.label })),
                presets: Object.entries(SCOPE_PRESETS).map(([id, p]) => ({ id, label: p.label, scopes: p.scopes })),
            }),
        }),
    ];
}
