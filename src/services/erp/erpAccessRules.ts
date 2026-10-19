/**
 * erpAccessRules — quy tắc quyền ERP phụ thuộc tham số / dữ liệu hiện có (phần thuần, có test: erpRestRoutes.test.ts).
 *
 * Handler IPC erp:* (dùng chung cho UI Boss, nhân viên qua REST và API v1) gọi các hàm này rồi
 * `requireErpPermission(action, ctx)` cho từng quyền trả về — tính cả quyền riêng (allow / deny) của hồ sơ ERP.
 * Trước khi có REST nhân viên các kiểm tra này chỉ chạy trên DB cục bộ của từng máy nên lỗ hổng không lộ ra; giờ một
 * nhân viên gọi thẳng Boss nên mỗi quy tắc phải đúng ở đây.
 */
import { parseErpPermissionOverridesFromExtraJson } from './permissions';

export type AssignmentAction = 'task.assign_self' | 'task.assign_others';

function idSet(ids: readonly unknown[] | null | undefined): Set<string> {
  return new Set((Array.isArray(ids) ? ids : []).map((id) => (id === undefined || id === null ? '' : String(id))).filter(Boolean));
}

/**
 * Quyền giao việc theo THAY ĐỔI người thực hiện so với hiện tại: không đổi → null (không cần quyền); chỉ thêm / bỏ
 * chính mình → task.assign_self; có thêm / bỏ người khác → task.assign_others. (Trước đây xét cả danh sách gửi lên:
 * form sửa task luôn gửi kèm người thực hiện → thành viên sửa tiêu đề task đang giao cho người khác bị từ chối.)
 */
export function assignmentAction(nextIds: readonly unknown[], currentIds: readonly unknown[], actorId: string): AssignmentAction | null {
  const next = idSet(nextIds);
  const current = idSet(currentIds);
  const changed = [...next].filter((id) => !current.has(id)).concat([...current].filter((id) => !next.has(id)));
  if (!changed.length) return null;
  return changed.every((id) => id === actorId) ? 'task.assign_self' : 'task.assign_others';
}

/**
 * Xoá task: người tạo xoá được task của mình nếu có quyền sửa task (cùng quy tắc REST nhân viên trước đây); task của
 * người khác cần task.delete. null = không cần thêm quyền.
 */
export function taskDeleteAction(reporterId: string | null | undefined, actorId: string, canUpdateTask: boolean): 'task.delete' | null {
  return reporterId && reporterId === actorId && canUpdateTask ? null : 'task.delete';
}

/** Trường tổ chức của hồ sơ: phòng ban, chức vụ, quản lý trực tiếp (= tuyến duyệt nghỉ phép), ngày vào làm. */
export const PROFILE_ORG_FIELDS = ['department_id', 'position_id', 'manager_employee_id', 'joined_at'] as const;

export const ERP_ROLE_NAMES = ['owner', 'admin', 'manager', 'member', 'guest'] as const;

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  return norm(a) === norm(b);
}

/** Cùng bộ quyền riêng (extra_json.action_permissions), không phụ thuộc thứ tự khoá / định dạng chuỗi. */
export function sameErpOverrides(a: unknown, b: unknown): boolean {
  const key = (raw: unknown) => {
    const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw);
    return JSON.stringify(Object.entries(parseErpPermissionOverridesFromExtraJson(text)).sort(([x], [y]) => x.localeCompare(y)));
  };
  return key(a) === key(b);
}

/**
 * Quyền phải có THÊM cho một bản sửa hồ sơ ERP (ngoài employee.edit_self / edit_others) — chỉ xét trường thật sự đổi
 * (form luôn gửi lại cả hồ sơ):
 *  - đổi vai trò ERP / quyền riêng → settings.erp (owner / admin). Trước đây ai có employee.edit_self tự nâng mình lên
 *    owner được — qua REST nhân viên là leo thang quyền trên Boss;
 *  - tự đổi trường tổ chức của chính mình (vd tự chọn người duyệt nghỉ phép) → employee.edit_others (quản lý).
 */
export function profilePatchActions(
  patch: Record<string, unknown> | null | undefined,
  current: Record<string, unknown> | null | undefined,
  isSelf: boolean,
): string[] {
  const p = patch || {};
  const actions: string[] = [];
  if (isSelf && PROFILE_ORG_FIELDS.some((field) => p[field] !== undefined && !sameValue(p[field], current?.[field]))) {
    actions.push('employee.edit_others');
  }
  const roleChanged = p.erp_role !== undefined && !sameValue(p.erp_role, current?.erp_role ?? 'member');
  const overridesChanged = p.extra_json !== undefined && !sameErpOverrides(p.extra_json, current?.extra_json);
  if (roleChanged || overridesChanged) actions.push('settings.erp');
  return actions;
}

/** Xoá hồ sơ của người có vai trò trên member = hạ vai trò của họ → cần quyền cấu hình ERP như khi đổi vai trò. */
export function profileDeleteAction(role: unknown): 'settings.erp' | null {
  const r = String(role || 'member');
  return r === 'member' || r === 'guest' ? null : 'settings.erp';
}

/**
 * Sự kiện lịch mời người khác (attendees khác chính mình) = cuộc họp → calendar.create_meeting (owner / admin / manager).
 * Trước đây quyền tạo lịch cá nhân là đủ để mời — và gửi thông báo "Mời tham dự" — cho bất kỳ ai.
 */
export function eventInviteAction(attendees: readonly unknown[] | null | undefined, actorId: string): 'calendar.create_meeting' | null {
  return [...idSet(attendees)].some((id) => id !== actorId) ? 'calendar.create_meeting' : null;
}

/** Người duyệt đơn nghỉ: quản lý trực tiếp của người xin nghỉ (manager_employee_id) hoặc Boss — như listPendingForManager. */
export function canDecideLeave(approverId: string, managerId: string | null | undefined): boolean {
  if (approverId === 'boss') return true;
  return !!managerId && managerId === approverId;
}
