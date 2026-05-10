import { ipcMain } from 'electron';
import ErpNotificationService from '../../src/services/erp/ErpNotificationService';
import { withErpAuth, erpValidate } from './erpIpcMiddleware';

export function registerErpNotificationIpc(): void {
  const svc = () => ErpNotificationService.getInstance();

  ipcMain.handle('erp:notify:listInbox', withErpAuth('erp.access', async (input: any, ctx) => ({
    notifications: svc().listInbox(ctx.employeeId, !!input?.unreadOnly, {
      limit: input?.limit,
      offset: input?.offset,
    }),
  })));

  ipcMain.handle('erp:notify:markRead', withErpAuth('erp.access', async (input: any) => {
    const ids: number[] = Array.isArray(input?.ids) ? input.ids.map(Number).filter(Number.isFinite) : [];
    svc().markRead(ids);
    return {};
  }));

  ipcMain.handle('erp:notify:markAllRead', withErpAuth('erp.access', async (_input: any, ctx) => {
    svc().markAllRead(ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:notify:unreadCount', withErpAuth('erp.access', async (_input: any, ctx) => ({
    count: svc().getUnreadCount(ctx.employeeId),
  })));
}

