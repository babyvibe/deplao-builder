/**
 * ERP RBAC - shared between main process (IPC middleware + services)
 * and renderer (UI hooks). Source of truth for permission matrix.
 *
 * NOTE: `src/models/erp/Permission.ts` re-exports from here to avoid
 * breaking existing imports.
 */

import { tr } from '../../shared/i18n';

export type ErpRole = 'owner' | 'admin' | 'manager' | 'member' | 'guest';

/** Action → roles allowed. Keep keys stable; they are referenced from UI + IPC. */
export const ERP_PERMISSIONS: Record<string, ErpRole[]> = {
  'erp.access':              ['owner', 'admin', 'manager', 'member', 'guest'],
  'project.create':          ['owner', 'admin', 'manager'],
  'project.update':          ['owner', 'admin', 'manager'],
  'project.delete':          ['owner', 'admin'],
  'project.archive':         ['owner', 'admin', 'manager'],
  'task.create':             ['owner', 'admin', 'manager', 'member'],
  'task.update':             ['owner', 'admin', 'manager', 'member'],
  'task.assign_self':        ['owner', 'admin', 'manager', 'member'],
  'task.assign_others':      ['owner', 'admin', 'manager'],
  'task.edit_any':           ['owner', 'admin', 'manager'],
  'task.delete':             ['owner', 'admin', 'manager'],
  'task.comment':            ['owner', 'admin', 'manager', 'member'],
  'calendar.view':           ['owner', 'admin', 'manager', 'member', 'guest'],
  'calendar.create_personal':['owner', 'admin', 'manager', 'member'],
  'calendar.create_meeting': ['owner', 'admin', 'manager'],
  'calendar.update':         ['owner', 'admin', 'manager', 'member'],
  'calendar.delete':         ['owner', 'admin', 'manager', 'member'],
  'calendar.view_team':      ['owner', 'admin', 'manager', 'member'],
  'note.create':             ['owner', 'admin', 'manager', 'member'],
  'note.update':             ['owner', 'admin', 'manager', 'member'],
  'note.delete':             ['owner', 'admin', 'manager', 'member'],
  'note.share':              ['owner', 'admin', 'manager', 'member'],
  'note.edit_workspace':     ['owner', 'admin'],
  'department.manage':       ['owner', 'admin'],
  'position.manage':         ['owner', 'admin'],
  'employee.edit_self':      ['owner', 'admin', 'manager', 'member'],
  'employee.edit_others':    ['owner', 'admin', 'manager'],
  'employee.view_others':    ['owner', 'admin', 'manager', 'member'],
  'attendance.checkin':      ['owner', 'admin', 'manager', 'member'],
  'attendance.view_others':  ['owner', 'admin', 'manager'],
  'leave.create':            ['owner', 'admin', 'manager', 'member'],
  'leave.approve':           ['owner', 'admin', 'manager'],
  'settings.erp':            ['owner', 'admin'],
};

export type ErpPermissionAction = keyof typeof ERP_PERMISSIONS;
export type ErpPermissionOverrideMode = 'allow' | 'deny';
export type ErpPermissionOverrides = Partial<Record<ErpPermissionAction, ErpPermissionOverrideMode>>;

export const ERP_PERMISSION_META: Record<ErpPermissionAction, { label: string; description: string; group: string }> = {
  'erp.access':               { label: tr('Truy cập ERP'), description: tr('Mở khu vực quản trị ERP và các màn hình tổng quan.'), group: 'general' },
  'project.create':           { label: tr('Tạo dự án'), description: tr('Khởi tạo dự án mới.'), group: 'projects' },
  'project.update':           { label: tr('Cập nhật dự án'), description: tr('Sửa thông tin dự án.'), group: 'projects' },
  'project.delete':           { label: tr('Xoá dự án'), description: tr('Xoá vĩnh viễn dự án.'), group: 'projects' },
  'project.archive':          { label: tr('Lưu trữ dự án'), description: tr('Đưa dự án sang trạng thái lưu trữ.'), group: 'projects' },
  'task.create':              { label: tr('Tạo task'), description: tr('Tạo công việc mới.'), group: 'tasks' },
  'task.update':              { label: tr('Cập nhật task'), description: tr('Sửa task được giao hoặc được phép chỉnh sửa.'), group: 'tasks' },
  'task.assign_self':         { label: tr('Tự nhận task'), description: tr('Tự gán bản thân vào task.'), group: 'tasks' },
  'task.assign_others':       { label: tr('Giao task cho người khác'), description: tr('Phân công task cho nhân sự khác.'), group: 'tasks' },
  'task.edit_any':            { label: tr('Sửa mọi task'), description: tr('Chỉnh sửa task không thuộc mình.'), group: 'tasks' },
  'task.delete':              { label: tr('Xoá task'), description: tr('Xoá task khỏi hệ thống.'), group: 'tasks' },
  'task.comment':             { label: tr('Bình luận task'), description: tr('Trao đổi, cập nhật tiến độ trên task.'), group: 'tasks' },
  'calendar.view':            { label: tr('Xem lịch'), description: tr('Mở lịch cá nhân / công việc.'), group: 'calendar' },
  'calendar.create_personal': { label: tr('Tạo lịch cá nhân'), description: tr('Tạo sự kiện cá nhân.'), group: 'calendar' },
  'calendar.create_meeting':  { label: tr('Tạo cuộc họp'), description: tr('Tạo lịch họp / lịch nhóm.'), group: 'calendar' },
  'calendar.update':          { label: tr('Cập nhật lịch'), description: tr('Sửa sự kiện lịch.'), group: 'calendar' },
  'calendar.delete':          { label: tr('Xoá lịch'), description: tr('Xoá sự kiện lịch.'), group: 'calendar' },
  'calendar.view_team':       { label: tr('Xem lịch đội nhóm'), description: tr('Xem lịch của nhân sự / nhóm khác.'), group: 'calendar' },
  'note.create':              { label: tr('Tạo ghi chú'), description: tr('Tạo note mới.'), group: 'notes' },
  'note.update':              { label: tr('Cập nhật ghi chú'), description: tr('Sửa ghi chú.'), group: 'notes' },
  'note.delete':              { label: tr('Xoá ghi chú'), description: tr('Xoá note khỏi hệ thống.'), group: 'notes' },
  'note.share':               { label: tr('Chia sẻ ghi chú'), description: tr('Chia sẻ note cho người khác.'), group: 'notes' },
  'note.edit_workspace':      { label: tr('Sửa note toàn workspace'), description: tr('Chỉnh sửa note dùng chung cấp workspace.'), group: 'notes' },
  'department.manage':        { label: tr('Quản lý phòng ban'), description: tr('Tạo / sửa / xoá phòng ban.'), group: 'hrm' },
  'position.manage':          { label: tr('Quản lý chức vụ'), description: tr('Tạo / sửa / xoá chức vụ.'), group: 'hrm' },
  'employee.edit_self':       { label: tr('Sửa hồ sơ của mình'), description: tr('Cập nhật hồ sơ ERP cá nhân.'), group: 'hrm' },
  'employee.edit_others':     { label: tr('Sửa hồ sơ người khác'), description: tr('Cập nhật hồ sơ ERP của nhân sự khác.'), group: 'hrm' },
  'employee.view_others':     { label: tr('Xem nhân sự khác'), description: tr('Xem danh sách và hồ sơ nhân sự khác.'), group: 'hrm' },
  'attendance.checkin':       { label: 'Check-in / check-out', description: tr('Chấm công trong ngày.'), group: 'attendance' },
  'attendance.view_others':   { label: tr('Xem chấm công người khác'), description: tr('Tra cứu chấm công toàn đội / công ty.'), group: 'attendance' },
  'leave.create':             { label: tr('Tạo đơn nghỉ phép'), description: tr('Gửi yêu cầu nghỉ phép.'), group: 'leave' },
  'leave.approve':            { label: tr('Duyệt nghỉ phép'), description: tr('Duyệt hoặc từ chối đơn nghỉ.'), group: 'leave' },
  'settings.erp':             { label: tr('Cài đặt ERP'), description: tr('Thay đổi cấu hình ERP.'), group: 'system' },
};

export const ERP_PERMISSION_GROUPS: Array<{ id: string; label: string; actions: ErpPermissionAction[] }> = [
  { id: 'general', label: tr('Tổng quan'), actions: ['erp.access'] },
  { id: 'projects', label: tr('Dự án'), actions: ['project.create', 'project.update', 'project.delete', 'project.archive'] },
  { id: 'tasks', label: tr('Công việc'), actions: ['task.create', 'task.update', 'task.assign_self', 'task.assign_others', 'task.edit_any', 'task.delete', 'task.comment'] },
  { id: 'calendar', label: tr('Lịch'), actions: ['calendar.view', 'calendar.create_personal', 'calendar.create_meeting', 'calendar.update', 'calendar.delete', 'calendar.view_team'] },
  { id: 'notes', label: tr('Ghi chú'), actions: ['note.create', 'note.update', 'note.delete', 'note.share', 'note.edit_workspace'] },
  { id: 'hrm', label: tr('Nhân sự'), actions: ['department.manage', 'position.manage', 'employee.edit_self', 'employee.edit_others', 'employee.view_others'] },
  { id: 'attendance', label: tr('Chấm công'), actions: ['attendance.checkin', 'attendance.view_others'] },
  { id: 'leave', label: tr('Nghỉ phép'), actions: ['leave.create', 'leave.approve'] },
  { id: 'system', label: tr('Hệ thống'), actions: ['settings.erp'] },
];

export function isErpPermissionAction(action: string): action is ErpPermissionAction {
  return Object.prototype.hasOwnProperty.call(ERP_PERMISSIONS, action);
}

export function sanitizeErpPermissionOverrides(input: unknown): ErpPermissionOverrides {
  if (!input || typeof input !== 'object') return {};
  const result: ErpPermissionOverrides = {};
  for (const [action, mode] of Object.entries(input as Record<string, unknown>)) {
    if (!isErpPermissionAction(action)) continue;
    if (mode === 'allow' || mode === 'deny') result[action] = mode;
  }
  return result;
}

export function parseErpPermissionOverridesFromExtraJson(extraJson?: string | null): ErpPermissionOverrides {
  if (!extraJson) return {};
  try {
    const parsed = JSON.parse(extraJson);
    return sanitizeErpPermissionOverrides(parsed?.action_permissions);
  } catch {
    return {};
  }
}

export function stringifyErpPermissionOverridesToExtraJson(
  extraJson?: string | null,
  overrides?: ErpPermissionOverrides,
): string {
  let parsed: Record<string, unknown> = {};
  if (extraJson) {
    try {
      const next = JSON.parse(extraJson);
      if (next && typeof next === 'object' && !Array.isArray(next)) parsed = next;
    } catch {
      parsed = {};
    }
  }
  const sanitized = sanitizeErpPermissionOverrides(overrides);
  if (Object.keys(sanitized).length > 0) parsed.action_permissions = sanitized;
  else delete parsed.action_permissions;
  return JSON.stringify(parsed);
}

/** Check if a role has permission to perform action. */
export function erpCan(role: ErpRole, action: string): boolean {
  const allowed = ERP_PERMISSIONS[action];
  if (!allowed) return false;
  return allowed.includes(role);
}

/** Check permission after applying any per-employee override from profile.extra_json. */
export function erpCanWithOverrides(role: ErpRole, action: string, overrides?: ErpPermissionOverrides): boolean {
  if (isErpPermissionAction(action)) {
    const override = overrides?.[action];
    if (override === 'allow') return true;
    if (override === 'deny') return false;
  }
  return erpCan(role, action);
}

