import { ipcMain } from 'electron';
import ErpCalendarService from '../../src/services/erp/ErpCalendarService';
import { withErpAuth, erpValidate } from './erpIpcMiddleware';

export function registerErpCalendarIpc(): void {
  const svc = () => ErpCalendarService.getInstance();

  ipcMain.handle('erp:calendar:listEvents', withErpAuth('calendar.view', async (input: any, ctx) => {
    erpValidate.int(input?.from, 'from');
    erpValidate.int(input?.to,   'to');
    return { events: svc().listEventsForEmployee(ctx.employeeId, {
      from: Number(input.from),
      to:   Number(input.to),
      limit: input?.limit,
      offset: input?.offset,
    }) };
  }));

  ipcMain.handle('erp:calendar:createEvent', withErpAuth('calendar.create_personal', async (input: any, ctx) => {
    erpValidate.string(input?.input?.title, 'title', { max: 300 });
    erpValidate.int(input?.input?.start_at, 'start_at');
    if (input?.input?.end_at !== undefined && input?.input?.end_at !== null && input?.input?.end_at !== '') {
      erpValidate.int(input?.input?.end_at, 'end_at');
    }
    return { event: svc().createEvent(input.input, ctx.employeeId) };
  }));

  ipcMain.handle('erp:calendar:updateEvent', withErpAuth('calendar.update', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    return { event: svc().updateEventForEmployee(input.id, input.patch ?? {}, ctx.employeeId) };
  }));

  ipcMain.handle('erp:calendar:deleteEvent', withErpAuth('calendar.delete', async (input: any, ctx) => {
    erpValidate.string(input?.id, 'id');
    svc().deleteEventForEmployee(input.id, ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:calendar:checkConflict', withErpAuth('calendar.view', async (input: any, ctx) => {
    const requestedEmployeeIds: string[] = Array.isArray(input?.employeeIds)
      ? input.employeeIds
      : (Array.isArray(input?.organizerIds) ? input.organizerIds : []);
    const employeeIds = ctx.employeeId === 'boss'
      ? requestedEmployeeIds
      : Array.from(new Set(requestedEmployeeIds.filter((employeeId: string) => employeeId === ctx.employeeId)));
    if (ctx.employeeId !== 'boss' && requestedEmployeeIds.some((employeeId: string) => employeeId && employeeId !== ctx.employeeId)) {
      throw new Error('Bạn không có quyền kiểm tra lịch của người khác');
    }
    erpValidate.int(input?.start_at, 'start_at');
    erpValidate.int(input?.end_at,   'end_at');
    return { conflicts: svc().checkConflict(
      employeeIds.length ? employeeIds : [ctx.employeeId], Number(input.start_at), Number(input.end_at), input.excludeEventId,
    ) };
  }));

  ipcMain.handle('erp:calendar:respond', withErpAuth('calendar.update', async (input: any, ctx) => {
    erpValidate.string(input?.eventId, 'eventId');
    erpValidate.enum(input?.status, 'status', ['accepted', 'declined', 'tentative'] as const);
    svc().respondToEvent(input.eventId, ctx.employeeId, input.status);
    return {};
  }));
}

