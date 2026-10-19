/**
 * Nhân viên (chỉ máy Boss): danh sách, quyền module, phân tài khoản, phiên đăng nhập, thống kê.
 * Kênh IPC: employee:list, employee:getById, employee:create, employee:update, employee:delete,
 * employee:setPermissions, employee:getPermissions, employee:assignAccounts, employee:getAssignedAccounts,
 * employee:getSessions, employee:getStats, relay:getServerStatus, relay:kickEmployee.
 *
 * Yêu cầu key không giới hạn tài khoản (quản trị toàn hệ thống).
 */
import { s } from '../schema';
import { ApiContext, ApiError, route, RouteDef } from '../types';
import { notFound, scrub } from './common';

const MODULES = ['chat', 'friends', 'crm', 'workflow', 'integration', 'analytics', 'ai_assistant', 'settings', 'erp'] as const;
const empParams = s.object({ employeeId: s.id() });

function requireGlobal(ctx: ApiContext): void {
    if (ctx.principal.accountIds !== null) {
        throw new ApiError(403, 'FORBIDDEN_ACCOUNT', 'Quản lý nhân viên cần key không giới hạn tài khoản');
    }
}

function mapEmployee(e: any): any {
    if (!e) return null;
    const { password_hash, password, ...rest } = e;
    return scrub(rest);
}

export function employeeRoutes(): RouteDef[] {
    const tags = ['Nhân viên'];
    return [
        route({
            method: 'GET', path: '/employees', scope: 'employees:manage', tags, operationId: 'listEmployees',
            summary: 'Danh sách nhân viên',
            handler: async ctx => {
                requireGlobal(ctx);
                const r = await ctx.call('employee:list');
                return (r?.employees || r?.items || (Array.isArray(r) ? r : [])).map(mapEmployee);
            },
        }),
        route({
            method: 'GET', path: '/employees/online', scope: 'employees:manage', tags, operationId: 'listOnlineEmployees',
            summary: 'Nhân viên đang kết nối',
            handler: async ctx => {
                requireGlobal(ctx);
                const st = await ctx.call('relay:getServerStatus');
                return st?.connectedEmployees || [];
            },
        }),
        route({
            method: 'GET', path: '/employees/:employeeId', scope: 'employees:manage', tags, operationId: 'getEmployee',
            summary: 'Một nhân viên kèm quyền và tài khoản được giao',
            params: empParams,
            handler: async ctx => {
                requireGlobal(ctx);
                const r = await ctx.call('employee:getById', { employeeId: ctx.params.employeeId });
                const emp = r?.employee ?? r?.data ?? null;
                if (!emp) notFound(`nhân viên ${ctx.params.employeeId}`);
                return mapEmployee(emp);
            },
        }),
        route({
            method: 'POST', path: '/employees', scope: 'employees:manage', tags, operationId: 'createEmployee',
            summary: 'Tạo nhân viên',
            body: s.object({
                username: s.string().min(3).max(50).pattern(/^[A-Za-z0-9_.-]+$/),
                password: s.string().min(6).max(200),
                display_name: s.string().min(1).max(100),
                role: s.string().max(30).default('employee'),
            }),
            handler: async ctx => {
                requireGlobal(ctx);
                const r = await ctx.call('employee:create', ctx.body);
                return mapEmployee(r?.employee ?? { employee_id: r?.employee_id ?? r?.id });
            },
        }),
        route({
            method: 'PATCH', path: '/employees/:employeeId', scope: 'employees:manage', tags, operationId: 'updateEmployee',
            summary: 'Sửa nhân viên (tên, mật khẩu, bật/tắt)',
            params: empParams,
            body: s.object({
                display_name: s.string().min(1).max(100).optional(),
                password: s.string().min(6).max(200).optional(),
                is_active: s.boolean().optional(),
                role: s.string().max(30).optional(),
            }),
            handler: async ctx => {
                requireGlobal(ctx);
                const updates: any = { ...ctx.body };
                if (updates.is_active !== undefined) updates.is_active = updates.is_active ? 1 : 0;
                await ctx.call('employee:update', { employeeId: ctx.params.employeeId, updates });
                return { updated: true };
            },
        }),
        route({
            method: 'DELETE', path: '/employees/:employeeId', scope: 'employees:manage', tags, operationId: 'deleteEmployee',
            summary: 'Xoá nhân viên',
            params: empParams,
            handler: async ctx => {
                requireGlobal(ctx);
                await ctx.call('employee:delete', { employeeId: ctx.params.employeeId });
                return { deleted: true };
            },
        }),
        route({
            method: 'GET', path: '/employees/:employeeId/permissions', scope: 'employees:manage', tags, operationId: 'getEmployeePermissions',
            summary: 'Quyền module của nhân viên',
            params: empParams,
            handler: async ctx => {
                requireGlobal(ctx);
                const r = await ctx.call('employee:getPermissions', { employeeId: ctx.params.employeeId });
                return r?.permissions ?? r;
            },
        }),
        route({
            method: 'PUT', path: '/employees/:employeeId/permissions', scope: 'employees:manage', tags, operationId: 'setEmployeePermissions',
            summary: 'Đặt quyền module',
            params: empParams,
            body: s.object({ permissions: s.record(s.boolean(), 20).describe(`Module → true/false. Module: ${MODULES.join(', ')}`) }),
            handler: async ctx => {
                requireGlobal(ctx);
                const permissions = Object.entries(ctx.body.permissions)
                    .filter(([m]) => (MODULES as readonly string[]).includes(m))
                    .map(([module, can_access]) => ({ module, can_access }));
                await ctx.call('employee:setPermissions', { employeeId: ctx.params.employeeId, permissions });
                return { updated: permissions.length };
            },
        }),
        route({
            method: 'GET', path: '/employees/:employeeId/accounts', scope: 'employees:manage', tags, operationId: 'getEmployeeAccounts',
            summary: 'Tài khoản được giao',
            params: empParams,
            handler: async ctx => {
                requireGlobal(ctx);
                const r = await ctx.call('employee:getAssignedAccounts', { employeeId: ctx.params.employeeId });
                return r?.accounts ?? r?.zaloIds ?? r?.assigned_accounts ?? [];
            },
        }),
        route({
            method: 'PUT', path: '/employees/:employeeId/accounts', scope: 'employees:manage', tags, operationId: 'setEmployeeAccounts',
            summary: 'Giao tài khoản cho nhân viên (ghi đè)',
            params: empParams,
            body: s.object({ account_ids: s.array(s.id()).max(500) }),
            handler: async ctx => {
                requireGlobal(ctx);
                await ctx.call('employee:assignAccounts', { employeeId: ctx.params.employeeId, zaloIds: ctx.body.account_ids });
                return { assigned: ctx.body.account_ids.length };
            },
        }),
        route({
            method: 'GET', path: '/employees/:employeeId/sessions', scope: 'employees:manage', tags, operationId: 'listEmployeeSessions',
            summary: 'Phiên đăng nhập gần đây',
            params: empParams,
            query: s.object({ limit: s.int().min(1).max(500).default(50) }),
            handler: async ctx => {
                requireGlobal(ctx);
                const r = await ctx.call('employee:getSessions', { employeeId: ctx.params.employeeId, limit: ctx.query.limit });
                return r?.sessions ?? [];
            },
        }),
        route({
            method: 'GET', path: '/employees/:employeeId/stats', scope: 'employees:manage', tags, operationId: 'getEmployeeStats',
            summary: 'Thống kê làm việc (tin đã xử lý, thời gian online...)',
            params: empParams,
            query: s.object({ from: s.timestamp().optional(), to: s.timestamp().optional() }),
            handler: async ctx => {
                requireGlobal(ctx);
                const r = await ctx.call('employee:getStats', { employeeId: ctx.params.employeeId, sinceTs: ctx.query.from, untilTs: ctx.query.to });
                const { success, ...rest } = r || {};
                return rest.stats ?? rest;
            },
        }),
        route({
            method: 'POST', path: '/employees/:employeeId/kick', scope: 'employees:manage', tags, operationId: 'kickEmployee',
            summary: 'Ngắt kết nối nhân viên đang online',
            description: 'Đóng phiên đang mở (REST + realtime) và thu hồi token hiện tại — nhân viên phải đăng nhập lại. '
                + 'Vô hiệu hoá, xoá hoặc đổi mật khẩu nhân viên cũng thu hồi phiên ngay.',
            params: empParams,
            handler: async ctx => {
                requireGlobal(ctx);
                await ctx.call('relay:kickEmployee', { employeeId: ctx.params.employeeId });
                return { kicked: true };
            },
        }),
    ];
}
