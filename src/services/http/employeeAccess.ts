/**
 * employeeAccess.ts — phân quyền cho REST API nhân viên (Boss phục vụ).
 *
 * Trước đây các endpoint /api/query/* (đọc), /api/search/* và /api/command/* (ghi) nhận `zaloId` tuỳ ý:
 * nhân viên đã đăng nhập có thể đọc / sửa dữ liệu của tài khoản KHÔNG được giao chỉ bằng cách đổi tham số.
 * Chỉ đường proxy (/api/proxy) là có kiểm tra. Module này gom quy tắc về một chỗ để HttpRelayService gọi
 * trước khi điều phối:
 *   1. Mọi id tài khoản có trong tham số phải thuộc `assigned_accounts` của nhân viên.
 *   2. Nhóm endpoint gắn với một module (vd /api/query/analytics/* → 'analytics') cần quyền module đó.
 * Không có tham số tài khoản → handler tự dùng tài khoản được giao đầu tiên (như cũ).
 */

/**
 * Cài đặt của Boss mà nhân viên được đọc / ghi qua REST (allowlist). Mọi khoá khác — bí mật ký token nhân viên
 * (`employee_jwt_secret`), token tunnel, cấu hình relay… — chỉ Boss truy cập. Cài đặt thông báo theo tài khoản
 * đi route riêng (`settings/notif`, khoá `notifSettings_<zaloId>`).
 */
export const EMPLOYEE_SETTING_KEYS: ReadonlySet<string> = new Set(['sidebar_width']);

export function isEmployeeSettingKey(key: string): boolean {
  return EMPLOYEE_SETTING_KEYS.has(String(key || ''));
}

/** Tên tham số mang id tài khoản (Zalo / Facebook / Telegram đều nằm ở accounts.zalo_id). */
export const ACCOUNT_PARAM_KEYS = ['zaloId', 'zalo_id', 'zaloIds', 'zalo_ids', 'ownerZaloId', 'owner_zalo_id'] as const;

/** Các họ endpoint được kiểm tra (thư viện có kiểm tra riêng trong LibraryHandler). */
const CHECKED_PREFIXES = ['/api/query/', '/api/search/', '/api/command/'];

export interface AccessEmployee {
  assigned_accounts?: string[];
}

/** Id tài khoản trong tham số: chuỗi, "a,b", mảng hoặc mảng JSON đã parse. */
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

/** Module quyền cần cho một đường dẫn (undefined = không yêu cầu module riêng). */
export function requiredModuleFor(pathname: string): string | undefined {
  if (pathname.startsWith('/api/query/analytics/')) return 'analytics';
  // ERP (dự án, công việc, lịch, ghi chú, nhân sự, thông báo) — quyền ERP chi tiết kiểm tra thêm ở executeErpRest
  if (pathname.startsWith('/api/query/erp/')) return 'erp';
  return undefined;
}

export interface AccessDenied {
  status: 403;
  error: string;
  code: 'ACCOUNT_FORBIDDEN' | 'MODULE_FORBIDDEN';
}

/**
 * null = được phép. Trả lỗi 403 khi tham số chứa tài khoản không được giao, hoặc thiếu quyền module.
 * `hasPermission(module)` do Boss cung cấp (EmployeeService.hasPermission).
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
    return { status: 403, error: 'Không có quyền truy cập tài khoản này', code: 'ACCOUNT_FORBIDDEN' };
  }
  const module = requiredModuleFor(pathname);
  if (module && !hasPermission(module)) {
    return { status: 403, error: `Không có quyền truy cập module: ${module}`, code: 'MODULE_FORBIDDEN' };
  }
  return null;
}
