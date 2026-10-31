import { ipcMain } from 'electron';
import ErpEmployeeService from '../../../src/services/erp/ErpEmployeeService';
import HttpRelayService from '../../../src/services/http/HttpRelayService';
import type { ErpAuthCtx } from '../../../src/services/erp/ErpAuthContext';
import { ERP_ROLE_NAMES, profileDeleteAction, profilePatchActions } from '../../../src/services/erp/erpAccessRules';
import { withErpAuth, erpValidate, requireErpPermission } from './erpIpcMiddleware';

const LEAVE_STATUS = ['approved', 'rejected'] as const;
const LEAVE_TYPE = ['annual', 'sick', 'unpaid', 'other'] as const;

/**
 * Phần nhạy cảm của bản sửa hồ sơ ERP (erpAccessRules.profilePatchActions — chỉ xét trường THẬT SỰ đổi): đổi vai trò /
 * quyền riêng → settings.erp; tự đổi trường tổ chức của chính mình → employee.edit_others.
 */
function ensureProfilePatchAllowed(patch: Record<string, any>, current: Record<string, any> | undefined, isSelf: boolean, ctx: ErpAuthCtx) {
  if (patch.erp_role !== undefined) erpValidate.enum(patch.erp_role, 'erp_role', ERP_ROLE_NAMES);
  for (const action of profilePatchActions(patch, current, isSelf)) requireErpPermission(action, ctx);
}

export function registerErpHrmIpc(): void {
  const svc = () => ErpEmployeeService.getInstance();

  // ─── Departments ─────────────────────────────────────────────────────────
  ipcMain.handle('erp:department:list', withErpAuth('erp.access', async () => ({
    departments: svc().listDepartments(),
  })));

  ipcMain.handle('erp:department:create', withErpAuth('department.manage', async (input: any) => {
    erpValidate.string(input?.name, 'name', { max: 120 });
    return { department: svc().createDepartment(input) };
  }));

  ipcMain.handle('erp:department:update', withErpAuth('department.manage', async (input: any) => {
    erpValidate.int(input?.id, 'id');
    return { department: svc().updateDepartment(Number(input.id), input.patch ?? {}) };
  }));

  ipcMain.handle('erp:department:delete', withErpAuth('department.manage', async (input: any) => {
    erpValidate.int(input?.id, 'id');
    svc().deleteDepartment(Number(input.id));
    return {};
  }));

  // ─── Positions ───────────────────────────────────────────────────────────
  ipcMain.handle('erp:position:list', withErpAuth('erp.access', async () => ({
    positions: svc().listPositions(),
  })));

  ipcMain.handle('erp:position:create', withErpAuth('position.manage', async (input: any) => {
    erpValidate.string(input?.name, 'name', { max: 120 });
    return { position: svc().createPosition(input) };
  }));

  ipcMain.handle('erp:position:update', withErpAuth('position.manage', async (input: any) => {
    erpValidate.int(input?.id, 'id');
    return { position: svc().updatePosition(Number(input.id), input.patch ?? {}) };
  }));

  ipcMain.handle('erp:position:delete', withErpAuth('position.manage', async (input: any) => {
    erpValidate.int(input?.id, 'id');
    svc().deletePosition(Number(input.id));
    return {};
  }));

  // ─── Profiles ────────────────────────────────────────────────────────────
  // Hồ sơ người khác (SĐT, email, địa chỉ, ngày sinh) cần employee.view_others — như danh sách hồ sơ theo phòng ban
  ipcMain.handle('erp:employee:getProfile', withErpAuth('erp.access', async (input: any, ctx) => {
    const eid = input?.employeeId || ctx.employeeId;
    erpValidate.string(eid, 'employeeId');
    if (eid !== ctx.employeeId) requireErpPermission('employee.view_others', ctx);
    return { profile: svc().getProfile(eid) };
  }));

  ipcMain.handle('erp:employee:updateProfile', withErpAuth(null, async (input: any, ctx) => {
    erpValidate.string(input?.employeeId, 'employeeId');
    const isSelf = input.employeeId === ctx.employeeId;
    requireErpPermission(isSelf ? 'employee.edit_self' : 'employee.edit_others', ctx);
    const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
    ensureProfilePatchAllowed(patch, svc().getProfile(input.employeeId) as any, isSelf, ctx);
    const profile = svc().upsertProfile(input.employeeId, patch);
    HttpRelayService.getInstance().refreshEmployeeState(input.employeeId, 'erp-profile-updated');
    return { profile };
  }));

  ipcMain.handle('erp:employee:listByDepartment', withErpAuth('employee.view_others', async (input: any) => ({
    profiles: svc().listProfilesByDepartment(input?.departmentId),
  })));

  ipcMain.handle('erp:employee:deleteProfile', withErpAuth('employee.edit_others', async (input: any, ctx) => {
    erpValidate.string(input?.employeeId, 'employeeId');
    // Xoá hồ sơ của người có vai trò trên member = hạ vai trò của họ → cần quyền cấu hình ERP như khi đổi vai trò
    const action = profileDeleteAction(svc().getProfile(input.employeeId)?.erp_role);
    if (action) requireErpPermission(action, ctx);
    svc().deleteProfile(input.employeeId);
    HttpRelayService.getInstance().refreshEmployeeState(input.employeeId, 'erp-profile-deleted');
    return {};
  }));

  // ─── Attendance ──────────────────────────────────────────────────────────
  ipcMain.handle('erp:attendance:checkIn', withErpAuth('attendance.checkin', async (input: any, ctx) => ({
    attendance: svc().checkIn(ctx.employeeId, input?.note),
  })));

  ipcMain.handle('erp:attendance:checkOut', withErpAuth('attendance.checkin', async (input: any, ctx) => ({
    attendance: svc().checkOut(ctx.employeeId, input?.note),
  })));

  ipcMain.handle('erp:attendance:today', withErpAuth('erp.access', async (_input: any, ctx) => ({
    attendance: svc().getTodayAttendance(ctx.employeeId) ?? null,
  })));

  ipcMain.handle('erp:attendance:list', withErpAuth(null, async (input: any, ctx) => {
    // Special mode: renderer requests ALL employees (boss/manager dashboard)
    if (input?.all === true) {
      requireErpPermission('attendance.view_others', ctx);
      return { list: svc().listAttendance({ from: input?.from, to: input?.to }) };
    }
    const targetEmp = input?.employeeId || ctx.employeeId;
    if (targetEmp !== ctx.employeeId) requireErpPermission('attendance.view_others', ctx);
    return { list: svc().listAttendance({ employeeId: targetEmp, from: input?.from, to: input?.to }) };
  }));

  // ─── Leave ───────────────────────────────────────────────────────────────
  ipcMain.handle('erp:leave:create', withErpAuth('leave.create', async (input: any, ctx) => {
    erpValidate.string(input?.input?.start_date, 'start_date');
    erpValidate.string(input?.input?.end_date, 'end_date');
    if (input.input.leave_type) erpValidate.enum(input.input.leave_type, 'leave_type', LEAVE_TYPE);
    return { leave: svc().createLeave(input.input, ctx.employeeId) };
  }));

  ipcMain.handle('erp:leave:listMy', withErpAuth('erp.access', async (_input: any, ctx) => ({
    leaves: svc().listMyLeaves(ctx.employeeId),
  })));

  ipcMain.handle('erp:leave:listPending', withErpAuth('leave.approve', async (_input: any, ctx) => ({
    leaves: svc().listPendingForManager(ctx.employeeId),
  })));

  // Chỉ quản lý trực tiếp của người xin nghỉ (hoặc Boss) — cùng phạm vi với listPending
  ipcMain.handle('erp:leave:decide', withErpAuth('leave.approve', async (input: any, ctx) => {
    erpValidate.int(input?.id, 'id');
    erpValidate.enum(input?.status, 'status', LEAVE_STATUS);
    return { leave: svc().decideLeaveForEmployee(Number(input.id), input.status, ctx.employeeId, input.note) };
  }));

  ipcMain.handle('erp:leave:cancel', withErpAuth('leave.create', async (input: any, ctx) => {
    erpValidate.int(input?.id, 'id');
    svc().cancelLeave(Number(input.id), ctx.employeeId);
    return {};
  }));

  // ─── Seat status ─────────────────────────────────────────────────────────
  ipcMain.handle('erp:license:seatStatus', withErpAuth('erp.access', async () => {
    let used = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const DatabaseService = require('../../../src/services/database/DatabaseService').default;
      const row: any = DatabaseService.getInstance().queryOne(`SELECT COUNT(*) AS c FROM erp_employee_profiles`);
      used = Number(row?.c ?? 0);
    } catch {}
    const limit = Math.max(used + 9999, 9999);
    return { seat: { limit, used, remaining: Math.max(0, limit - used) } };
  }));
}

