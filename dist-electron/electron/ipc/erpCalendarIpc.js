"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerErpCalendarIpc = registerErpCalendarIpc;
const electron_1 = require("electron");
const ErpCalendarService_1 = __importDefault(require("../../src/services/erp/ErpCalendarService"));
const erpIpcMiddleware_1 = require("./erpIpcMiddleware");
function registerErpCalendarIpc() {
    const svc = () => ErpCalendarService_1.default.getInstance();
    electron_1.ipcMain.handle('erp:calendar:listEvents', (0, erpIpcMiddleware_1.withErpAuth)('calendar.view', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.int(input?.from, 'from');
        erpIpcMiddleware_1.erpValidate.int(input?.to, 'to');
        return { events: svc().listEventsForEmployee(ctx.employeeId, {
                from: Number(input.from),
                to: Number(input.to),
                limit: input?.limit,
                offset: input?.offset,
            }) };
    }));
    electron_1.ipcMain.handle('erp:calendar:createEvent', (0, erpIpcMiddleware_1.withErpAuth)('calendar.create_personal', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.input?.title, 'title', { max: 300 });
        erpIpcMiddleware_1.erpValidate.int(input?.input?.start_at, 'start_at');
        if (input?.input?.end_at !== undefined && input?.input?.end_at !== null && input?.input?.end_at !== '') {
            erpIpcMiddleware_1.erpValidate.int(input?.input?.end_at, 'end_at');
        }
        return { event: svc().createEvent(input.input, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:calendar:updateEvent', (0, erpIpcMiddleware_1.withErpAuth)('calendar.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        return { event: svc().updateEventForEmployee(input.id, input.patch ?? {}, ctx.employeeId) };
    }));
    electron_1.ipcMain.handle('erp:calendar:deleteEvent', (0, erpIpcMiddleware_1.withErpAuth)('calendar.delete', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.id, 'id');
        svc().deleteEventForEmployee(input.id, ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:calendar:checkConflict', (0, erpIpcMiddleware_1.withErpAuth)('calendar.view', async (input, ctx) => {
        const requestedEmployeeIds = Array.isArray(input?.employeeIds)
            ? input.employeeIds
            : (Array.isArray(input?.organizerIds) ? input.organizerIds : []);
        const employeeIds = ctx.employeeId === 'boss'
            ? requestedEmployeeIds
            : Array.from(new Set(requestedEmployeeIds.filter((employeeId) => employeeId === ctx.employeeId)));
        if (ctx.employeeId !== 'boss' && requestedEmployeeIds.some((employeeId) => employeeId && employeeId !== ctx.employeeId)) {
            throw new Error('Bạn không có quyền kiểm tra lịch của người khác');
        }
        erpIpcMiddleware_1.erpValidate.int(input?.start_at, 'start_at');
        erpIpcMiddleware_1.erpValidate.int(input?.end_at, 'end_at');
        return { conflicts: svc().checkConflict(employeeIds.length ? employeeIds : [ctx.employeeId], Number(input.start_at), Number(input.end_at), input.excludeEventId) };
    }));
    electron_1.ipcMain.handle('erp:calendar:respond', (0, erpIpcMiddleware_1.withErpAuth)('calendar.update', async (input, ctx) => {
        erpIpcMiddleware_1.erpValidate.string(input?.eventId, 'eventId');
        erpIpcMiddleware_1.erpValidate.enum(input?.status, 'status', ['accepted', 'declined', 'tentative']);
        svc().respondToEvent(input.eventId, ctx.employeeId, input.status);
        return {};
    }));
}
//# sourceMappingURL=erpCalendarIpc.js.map