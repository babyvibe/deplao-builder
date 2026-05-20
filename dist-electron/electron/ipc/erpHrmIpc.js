"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerErpHrmIpc = registerErpHrmIpc;
const electron_1 = require("electron");
const ErpEmployeeService_1 = __importDefault(require("../../src/services/erp/ErpEmployeeService"));
const HttpRelayService_1 = __importDefault(require("../../src/services/HttpRelayService"));
const erpIpcMiddleware_1 = require("./erpIpcMiddleware");
const LEAVE_STATUS = ['approved', 'rejected'];
const LEAVE_TYPE = ['annual', 'sick', 'unpaid', 'other'];
function registerErpHrmIpc() {
    const svc = () => ErpEmployeeService_1.default.getInstance();
    // ─── Departments ─────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:department:list', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async () => ({
        departments: svc().listDepartments(),
    })));
    electron_1.ipcMain.handle('erp:department:create', (0, erpIpcMiddleware_1.withErpAuth)('department.manage', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.name, 'name', { max: 120 });
        return { department: svc().createDepartment(input) };
    }));
    electron_1.ipcMain.handle('erp:department:update', (0, erpIpcMiddleware_1.withErpAuth)('department.manage', async (input) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        return { department: svc().updateDepartment(Number(input.id), input.patch ?? {}) };
    }));
    electron_1.ipcMain.handle('erp:department:delete', (0, erpIpcMiddleware_1.withErpAuth)('department.manage', async (input) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        svc().deleteDepartment(Number(input.id));
        return {};
    }));
    // ─── Positions ───────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:position:list', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async () => ({
        positions: svc().listPositions(),
    })));
    electron_1.ipcMain.handle('erp:position:create', (0, erpIpcMiddleware_1.withErpAuth)('position.manage', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.name, 'name', { max: 120 });
        return { position: svc().createPosition(input) };
    }));
    electron_1.ipcMain.handle('erp:position:update', (0, erpIpcMiddleware_1.withErpAuth)('position.manage', async (input) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        return { position: svc().updatePosition(Number(input.id), input.patch ?? {}) };
    }));
    electron_1.ipcMain.handle('erp:position:delete', (0, erpIpcMiddleware_1.withErpAuth)('position.manage', async (input) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        svc().deletePosition(Number(input.id));
        return {};
    }));
    // ─── Profiles ────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:employee:getProfile', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input, ctx) => {
        const eid = input?.employeeId || ctx.employeeId;
        erpIpcMiddleware_1.erpValidate.string(eid, 'employeeId');
        return { profile: svc().getProfile(eid) };
    }));
    electron_1.ipcMain.handle('erp:employee:updateProfile', (0, erpIpcMiddleware_1.withErpAuth)(null, async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.employeeId, 'employeeId');
        const isSelf = input.employeeId === ctx.employeeId;
        const action = isSelf ? 'employee.edit_self' : 'employee.edit_others';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { erpCan } = require('../../src/services/erp/permissions');
        if (!erpCan(ctx.role, action))
            throw new Error(`Permission denied: ${action}`);
        const profile = svc().upsertProfile(input.employeeId, input.patch ?? {});
        HttpRelayService_1.default.getInstance().refreshEmployeeState(input.employeeId, 'erp-profile-updated');
        return { profile };
    }));
    electron_1.ipcMain.handle('erp:employee:listByDepartment', (0, erpIpcMiddleware_1.withErpAuth)('employee.view_others', async (input) => ({
        profiles: svc().listProfilesByDepartment(input?.departmentId),
    })));
    electron_1.ipcMain.handle('erp:employee:deleteProfile', (0, erpIpcMiddleware_1.withErpAuth)('employee.edit_others', async (input) => {
        erpIpcMiddleware_1.erpValidate.string(input?.employeeId, 'employeeId');
        svc().deleteProfile(input.employeeId);
        HttpRelayService_1.default.getInstance().refreshEmployeeState(input.employeeId, 'erp-profile-deleted');
        return {};
    }));
    // ─── Attendance ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:attendance:checkIn', (0, erpIpcMiddleware_1.withErpAuth)('attendance.checkin', async (input, ctx) => ({
        attendance: svc().checkIn(ctx.employeeId, input?.note),
    })));
    electron_1.ipcMain.handle('erp:attendance:checkOut', (0, erpIpcMiddleware_1.withErpAuth)('attendance.checkin', async (input, ctx) => ({
        attendance: svc().checkOut(ctx.employeeId, input?.note),
    })));
    electron_1.ipcMain.handle('erp:attendance:today', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (_input, ctx) => ({
        attendance: svc().getTodayAttendance(ctx.employeeId) ?? null,
    })));
    electron_1.ipcMain.handle('erp:attendance:list', (0, erpIpcMiddleware_1.withErpAuth)(null, async (input, ctx) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { erpCan } = require('../../src/services/erp/permissions');
        // Special mode: renderer requests ALL employees (boss/manager dashboard)
        if (input?.all === true) {
            if (!erpCan(ctx.role, 'attendance.view_others'))
                throw new Error('Permission denied: attendance.view_others');
            return { list: svc().listAttendance({ from: input?.from, to: input?.to }) };
        }
        const targetEmp = input?.employeeId || ctx.employeeId;
        if (targetEmp !== ctx.employeeId) {
            if (!erpCan(ctx.role, 'attendance.view_others'))
                throw new Error('Permission denied: attendance.view_others');
        }
        return { list: svc().listAttendance({ employeeId: targetEmp, from: input?.from, to: input?.to }) };
    }));
    // ─── Leave ───────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:leave:create', (0, erpIpcMiddleware_1.withErpAuth)('leave.create', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.input?.start_date, 'start_date');
        erpIpcMiddleware_1.erpValidate.string(input?.input?.end_date, 'end_date');
        if (input.input.leave_type)
            erpIpcMiddleware_1.erpValidate.enum(input.input.leave_type, 'leave_type', LEAVE_TYPE);
        return { leave: svc().createLeave(input.input, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:leave:listMy', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (_input, ctx) => ({
        leaves: svc().listMyLeaves(ctx.employeeId),
    })));
    electron_1.ipcMain.handle('erp:leave:listPending', (0, erpIpcMiddleware_1.withErpAuth)('leave.approve', async (_input, ctx) => ({
        leaves: svc().listPendingForManager(ctx.employeeId),
    })));
    electron_1.ipcMain.handle('erp:leave:decide', (0, erpIpcMiddleware_1.withErpAuth)('leave.approve', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        erpIpcMiddleware_1.erpValidate.enum(input?.status, 'status', LEAVE_STATUS);
        return { leave: svc().decideLeave(Number(input.id), input.status, ctx.employeeId, input.note) };
    }));
    electron_1.ipcMain.handle('erp:leave:cancel', (0, erpIpcMiddleware_1.withErpAuth)('leave.create', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.int(input?.id, 'id');
        svc().cancelLeave(Number(input.id), ctx.employeeId);
        return {};
    }));
    // ─── Seat status ─────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('erp:license:seatStatus', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async () => {
        let used = 0;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const DatabaseService = require('../../src/services/DatabaseService').default;
            const row = DatabaseService.getInstance().queryOne(`SELECT COUNT(*) AS c FROM erp_employee_profiles`);
            used = Number(row?.c ?? 0);
        }
        catch { }
        const limit = Math.max(used + 9999, 9999);
        return { seat: { limit, used, remaining: Math.max(0, limit - used) } };
    }));
}
//# sourceMappingURL=erpHrmIpc.js.map