/**
 * employeeAccess.ts: permissions for the employee REST API (served by Boss).
 *
 * Previously the /api/query/* (read), /api/search/* and /api/command/* (write) endpoints accepted an arbitrary `zaloId`:
 * a logged-in employee could read / change the data of an account that was NOT assigned to them, just by changing the parameter.
 * Only the proxy path (/api/proxy) had a check. This module puts the rules in one place, which HttpRelayService calls
 * before dispatching:
 *   1. Every account id in the parameters must be in the employee's `assigned_accounts`.
 *   2. Endpoint groups tied to a module (e.g. /api/query/analytics/* → 'analytics') need that module's permission.
 * With no account parameter → the handler uses the first assigned account by itself (as before).
 */

/**
 * Boss settings that employees may read / write through REST (allowlist). Every other key (the employee JWT signing secret
 * (`employee_jwt_secret`), tunnel tokens, relay config…) is Boss-only. Per-account notification settings
 * use their own route (`settings/notif`, key `notifSettings_<zaloId>`).
 */
import { tr } from '../../shared/i18n';

export const EMPLOYEE_SETTING_KEYS: ReadonlySet<string> = new Set(['sidebar_width']);

export function isEmployeeSettingKey(key: string): boolean {
  return EMPLOYEE_SETTING_KEYS.has(String(key || ''));
}

/** The parameter name that carries an account id (Zalo / Facebook / Telegram all live in accounts.zalo_id). */
export const ACCOUNT_PARAM_KEYS = ['zaloId', 'zalo_id', 'zaloIds', 'zalo_ids', 'ownerZaloId', 'owner_zalo_id'] as const;

/** The endpoint families that are checked (the library has its own check in LibraryHandler). */
const CHECKED_PREFIXES = ['/api/query/', '/api/search/', '/api/command/'];

export interface AccessEmployee {
  assigned_accounts?: string[];
}

/** Account ids in the parameters: a string, "a,b", an array, or a parsed JSON array. */
export function requestedAccountIds(params: Record<string, unknown> | null | undefined): string[] {
  const ids = new Set<string>();
  if (!params) return [];
  for (const key of ACCOUNT_PARAM_KEYS) {
    const raw = params[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const list: unknown[] = Array.isArray(raw) ? raw : String(raw).split(',');
    for (const value of list) {
      const id = String(value ?? '').trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** The module permission needed for a path (undefined = no separate module is required). */
export function requiredModuleFor(pathname: string): string | undefined {
  if (pathname.startsWith('/api/query/analytics/')) return 'analytics';
  // ERP (projects, tasks, calendar, notes, HR, notifications): the detailed ERP permissions are checked further in executeErpRest
  if (pathname.startsWith('/api/query/erp/')) return 'erp';
  return undefined;
}

export interface AccessDenied {
  status: 403;
  error: string;
  code: 'ACCOUNT_FORBIDDEN' | 'MODULE_FORBIDDEN';
}

/**
 * null = allowed. Returns a 403 error when the parameters contain an account that is not assigned, or the module permission is missing.
 * `hasPermission(module)` is provided by Boss (EmployeeService.hasPermission).
 */
export function checkEmployeeAccess(
  employee: AccessEmployee,
  pathname: string,
  params: Record<string, unknown> | null | undefined,
  hasPermission: (module: string) => boolean,
): AccessDenied | null {
  if (!CHECKED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  const assigned = new Set((employee.assigned_accounts || []).map(String));
  if (requestedAccountIds(params).some((id) => !assigned.has(id))) {
    return { status: 403, error: tr('Không có quyền truy cập tài khoản này'), code: 'ACCOUNT_FORBIDDEN' };
  }
  const module = requiredModuleFor(pathname);
  if (module && !hasPermission(module)) {
    return { status: 403, error: tr('Không có quyền truy cập module: {{module}}', { module }), code: 'MODULE_FORBIDDEN' };
  }
  return null;
}
