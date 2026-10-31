/**
 * ApiAuth — quy mọi request về một Principal và kiểm tra quyền TRƯỚC khi vào IPC.
 *
 *  - API key: `Authorization: Bearer dpk_...` hoặc `X-Api-Key: dpk_...`
 *  - Nhân viên: JWT hiện có của employee mode (Bearer <jwt>), quyền module → scope.
 *  - Plugin: principal tạo trong process (PluginApiBridge), không qua HTTP.
 */
import type { IncomingMessage } from 'http';
import ApiKeyService from './ApiKeyService';
import { ApiError, ApiScope, ErpRoleName, Principal } from '../types';
import { getApiSettingNumber } from '../settings';

/** Module quyền nhân viên → scope API v1. */
export const EMPLOYEE_MODULE_SCOPES: Record<string, ApiScope[]> = {
    chat: ['accounts:read', 'chat:read', 'chat:send', 'chat:manage', 'media:read', 'media:write', 'events:subscribe'],
    friends: ['contacts:read', 'contacts:write'],
    crm: ['crm:read', 'crm:write', 'campaigns:run'],
    workflow: ['workflow:read', 'workflow:write', 'workflow:run'],
    integration: ['integrations:read', 'integrations:execute'],
    analytics: ['analytics:read'],
    ai_assistant: ['ai:use'],
    settings: ['settings:read'],
    erp: ['erp:read', 'erp:write'],
};

export function extractToken(req: IncomingMessage): string {
    const header = req.headers['authorization'];
    const auth = Array.isArray(header) ? header[0] : header || '';
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    const apiKey = req.headers['x-api-key'];
    const v = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    return typeof v === 'string' ? v.trim() : '';
}

export interface EmployeeLike {
    employee_id: string;
    display_name?: string;
    username?: string;
    is_active?: number | boolean;
    assigned_accounts?: string[];
}

export function employeePrincipal(
    emp: EmployeeLike,
    permissions: Record<string, boolean>,
    erpRole: ErpRoleName,
): Principal {
    const scopes = new Set<ApiScope>();
    for (const [module, allowed] of Object.entries(permissions || {})) {
        if (!allowed) continue;
        for (const scope of EMPLOYEE_MODULE_SCOPES[module] || []) scopes.add(scope);
    }
    return {
        kind: 'employee',
        id: emp.employee_id,
        name: emp.display_name || emp.username || emp.employee_id,
        scopes,
        accountIds: Array.isArray(emp.assigned_accounts) ? emp.assigned_accounts.map(String) : [],
        rateLimitPerMin: 0,
        erp: { employeeId: emp.employee_id, role: erpRole },
        allowedIps: null,
    };
}

/** Xác thực token (API key hoặc JWT nhân viên). null = không hợp lệ. */
export function authenticateToken(token: string, ip: string): Principal | null {
    if (!token) return null;
    const keys = ApiKeyService.getInstance();
    if (keys.looksLikeApiKey(token)) {
        const record = keys.verify(token);
        if (!record) return null;
        keys.touch(record.id, ip);
        return keys.toPrincipal(record);
    }
    if (token.split('.').length !== 3) return null;
    try {
        const EmployeeService = require('../../employee/EmployeeService').default;
        const svc = EmployeeService.getInstance();
        const v = svc.validateToken(token);
        if (!v?.valid || !v.employee_id) return null;
        const emp = svc.getEmployeeById(v.employee_id);
        if (!emp || !emp.is_active) return null;
        const permissions: Record<string, boolean> = svc.getPermissions(v.employee_id) || {};
        let role: ErpRoleName = 'member';
        try {
            const ErpAuthContext = require('../../erp/ErpAuthContext').default;
            role = ErpAuthContext.forEmployee(v.employee_id).role;
        } catch { /* giữ member */ }
        return employeePrincipal(emp, permissions, role);
    } catch {
        return null;
    }
}

export function pluginPrincipal(pluginId: string, name: string, scopes: ApiScope[], accountIds: string[] | null): Principal {
    const limit = getApiSettingNumber('plugins_rate_limit_per_min');
    const hasErpWrite = scopes.includes('erp:write') || scopes.includes('admin');
    return {
        kind: 'plugin',
        id: pluginId,
        name,
        scopes: new Set(scopes),
        accountIds,
        rateLimitPerMin: Math.max(0, limit),
        erp: { employeeId: 'boss', role: hasErpWrite ? 'manager' : 'member' },
        allowedIps: null,
    };
}

export function hasScope(p: Principal, scope: ApiScope): boolean {
    return p.scopes.has('admin') || p.scopes.has(scope);
}

export function requireScope(p: Principal, scope: ApiScope | 'any' | null): void {
    if (scope === null || scope === 'any') return;
    if (hasScope(p, scope)) return;
    throw new ApiError(403, 'FORBIDDEN_SCOPE', `Cần scope ${scope}`, { required: scope });
}

export function accountAllowed(p: Principal, accountId: string): boolean {
    return p.accountIds === null || p.accountIds.includes(String(accountId));
}

export function requireAccount(p: Principal, accountId: string): void {
    if (accountAllowed(p, accountId)) return;
    throw new ApiError(403, 'FORBIDDEN_ACCOUNT', 'Key không được cấp quyền cho tài khoản này', { account_id: accountId });
}

export function principalSummary(p: Principal) {
    return {
        kind: p.kind,
        id: p.id,
        name: p.name,
        scopes: Array.from(p.scopes).sort(),
        account_ids: p.accountIds,
        rate_limit_per_min: p.rateLimitPerMin,
        erp_role: p.erp.role,
        allowed_ips: p.allowedIps,
    };
}
