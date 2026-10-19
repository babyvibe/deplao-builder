/**
 * restCommandPolicy.ts — lệnh ghi REST của nhân viên (POST/PUT/PATCH/DELETE /api/command/*): phần quy tắc thuần, có test.
 *
 * checkEmployeeAccess (employeeAccess.ts) đã kiểm tra id tài khoản thông thường (zaloId…) trong tham số. Ở đây là phần
 * riêng của lệnh ghi, chạy ngay sau nó trong HttpRelayService.executeRestCommand:
 *   1. Quyền module theo nhóm lệnh — cùng bảng với đường proxy (channelToModule): crm/* → crm, workflows → workflow,
 *      integrations → integration, ai/* → ai_assistant. Trước đây REST không kiểm tra: nhân viên bị tắt module vẫn
 *      sửa / xoá được chiến dịch, workflow, tích hợp, trợ lý AI của Boss.
 *   2. Lệnh chỉ Boss được làm: proxy mạng (/api/command/proxies*, /api/command/accounts/proxy). Gán proxy cho tài khoản =
 *      chuyển toàn bộ lưu lượng (kể cả cookie) của tài khoản qua máy chủ do người gọi chọn.
 *   3. Tài khoản nguồn / đích của lệnh nhân bản (sourceZaloId / targetZaloId) cũng phải được giao — trước đây nhân viên
 *      chép được tin nhắn nhanh / nhãn của tài khoản không được giao sang tài khoản của mình (và ngược lại).
 */

export interface CommandEmployee {
  assigned_accounts?: readonly string[] | null;
}

export type RestCommandDenied = {
  status: 403;
  code: 'MODULE_FORBIDDEN' | 'COMMAND_FORBIDDEN' | 'ACCOUNT_FORBIDDEN';
  error: string;
};

/** Nhóm lệnh gắn với một module quyền (cùng tên module với EmployeeService / ALL_MODULES). */
const COMMAND_MODULES: ReadonlyArray<{ prefix: string; module: string }> = [
  { prefix: '/api/command/crm/', module: 'crm' },
  { prefix: '/api/command/workflows', module: 'workflow' },
  { prefix: '/api/command/integrations', module: 'integration' },
  { prefix: '/api/command/ai/', module: 'ai_assistant' },
  // ERP: quyền ERP chi tiết (RBAC theo hồ sơ ERP) kiểm tra thêm ở HttpRelayService.executeErpRest
  { prefix: '/api/command/erp/', module: 'erp' },
];

/** Lệnh chỉ Boss được làm (nhân viên luôn bị từ chối). */
const BOSS_ONLY_COMMAND_PREFIXES: readonly string[] = ['/api/command/proxies', '/api/command/accounts/proxy'];

/** Tham số tài khoản phụ của lệnh ghi (ngoài các khoá checkEmployeeAccess đã kiểm tra). */
export const COMMAND_EXTRA_ACCOUNT_KEYS = ['sourceZaloId', 'targetZaloId'] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Module quyền cần cho một lệnh ghi (undefined = không yêu cầu module riêng, vd nhãn / tin nhắn nhanh / ghim). */
export function requiredCommandModule(pathname: string): string | undefined {
  const path = String(pathname || '');
  return COMMAND_MODULES.find((rule) => matchesPrefix(path, rule.prefix))?.module;
}

export function isBossOnlyCommand(pathname: string): boolean {
  const path = String(pathname || '');
  return BOSS_ONLY_COMMAND_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

/** Id tài khoản nguồn / đích trong tham số lệnh (rỗng thì bỏ qua). */
export function commandExtraAccountIds(params: Record<string, unknown> | null | undefined): string[] {
  const ids = new Set<string>();
  if (!params) return [];
  for (const key of COMMAND_EXTRA_ACCOUNT_KEYS) {
    const raw = params[key];
    if (raw === undefined || raw === null) continue;
    const id = String(raw).trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/** null = được phép. `hasPermission(module)` do Boss cung cấp (EmployeeService.hasPermission). */
export function checkRestCommand(
  employee: CommandEmployee,
  pathname: string,
  params: Record<string, unknown> | null | undefined,
  hasPermission: (module: string) => boolean,
): RestCommandDenied | null {
  if (isBossOnlyCommand(pathname)) {
    return { status: 403, code: 'COMMAND_FORBIDDEN', error: 'Thao tác này chỉ Boss được thực hiện' };
  }
  const assigned = new Set((employee.assigned_accounts || []).map(String));
  if (commandExtraAccountIds(params).some((id) => !assigned.has(id))) {
    return { status: 403, code: 'ACCOUNT_FORBIDDEN', error: 'Không có quyền truy cập tài khoản này' };
  }
  const module = requiredCommandModule(pathname);
  if (module && !hasPermission(module)) {
    return { status: 403, code: 'MODULE_FORBIDDEN', error: `Không có quyền truy cập module: ${module}` };
  }
  return null;
}

/**
 * Tài khoản mặc định khi lệnh không gửi `zaloId`: chỉ khi nhân viên được giao đúng MỘT tài khoản (không mơ hồ).
 * Trước đây luôn lấy tài khoản được giao đầu tiên → lệnh thiếu tham số ghi nhầm sang tài khoản khác.
 */
export function defaultCommandAccount(params: Record<string, unknown> | null | undefined, assignedAccounts: readonly string[] | null | undefined): string {
  const explicit = params?.zaloId;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit).trim();
  const assigned = [...new Set((assignedAccounts || []).map((id) => String(id || '').trim()).filter(Boolean))];
  return assigned.length === 1 ? assigned[0] : '';
}

/**
 * Phần động của đường dẫn lệnh, theo regex có nhóm bắt (đã giải mã %xx). Trước đây cắt bằng `split('/')[3]` →
 * với /api/command/conversations/<id>/flags lấy nhầm chữ "conversations" làm id (cờ / biệt danh / xoá hội thoại ghi
 * vào liên hệ tên "conversations"; tương tự nhãn, workflow, tích hợp).
 */
export function commandPathParams(pathname: string, pattern: RegExp): string[] | null {
  const match = pattern.exec(String(pathname || ''));
  if (!match) return null;
  return match.slice(1).map((part) => {
    try { return decodeURIComponent(part ?? ''); } catch { return part ?? ''; }
  });
}

/** Danh sách trang của workflow: mảng pageIds, chuỗi "a,b" (cột page_ids) hoặc pageId đơn lẻ. */
export function workflowPageIds(pageIds: unknown, pageId?: unknown): string[] {
  const list: unknown[] = Array.isArray(pageIds)
    ? pageIds
    : (typeof pageIds === 'string' ? pageIds.split(',') : []);
  const ids = list.map((id) => String(id ?? '').trim()).filter(Boolean);
  if (ids.length === 0 && pageId !== undefined && pageId !== null && String(pageId).trim()) ids.push(String(pageId).trim());
  return [...new Set(ids)];
}

/**
 * Nhân viên chỉ được lưu / bật tắt / xoá workflow mà MỌI trang của nó thuộc tài khoản được giao — workflow gắn cả trang
 * không được giao thì sửa nó = đổi tự động trả lời của tài khoản đó. Workflow chung (không gắn trang) giữ như trước.
 */
export function workflowPagesAllowed(pageIds: readonly string[], assignedAccounts: readonly string[] | null | undefined): boolean {
  if (pageIds.length === 0) return true;
  const assigned = new Set((assignedAccounts || []).map((id) => String(id)));
  return pageIds.every((id) => assigned.has(id));
}

/** Số nguyên dương từ tham số (id nhãn / chiến dịch / tin nhắn nhanh…); không hợp lệ → 0. */
export function positiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
