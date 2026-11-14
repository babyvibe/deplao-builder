import { ipcMain } from 'electron';
import ErpNotificationService from '../../../src/services/erp/ErpNotificationService';
import { withErpAuth, erpValidate } from './erpIpcMiddleware';
import { tr } from '../../../src/shared/i18n';

export function registerErpNotificationIpc(): void {
  const svc = () => ErpNotificationService.getInstance();

  ipcMain.handle('erp:notify:listInbox', withErpAuth('erp.access', async (input: any, ctx) => ({
    notifications: svc().listInbox(ctx.employeeId, !!input?.unreadOnly, {
      limit: input?.limit,
      offset: input?.offset,
    }),
  })));

  // Only the caller's notifications (notification ids of other people are ignored)
  ipcMain.handle('erp:notify:markRead', withErpAuth('erp.access', async (input: any, ctx) => {
    const ids: number[] = Array.isArray(input?.ids) ? input.ids.map(Number).filter(Number.isFinite) : [];
    svc().markRead(ids, ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:notify:markAllRead', withErpAuth('erp.access', async (_input: any, ctx) => {
    svc().markAllRead(ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:notify:unreadCount', withErpAuth('erp.access', async (_input: any, ctx) => ({
    count: svc().getUnreadCount(ctx.employeeId),
  })));

  ipcMain.handle('erp:notify:delete', withErpAuth('erp.access', async (input: any, ctx) => {
    const ids: number[] = Array.isArray(input?.ids) ? input.ids.map(Number).filter(Number.isFinite) : [];
    svc().delete(ids, ctx.employeeId);
    return {};
  }));

  ipcMain.handle('erp:notify:deleteAll', withErpAuth('erp.access', async (_input: any, ctx) => {
    svc().deleteAll(ctx.employeeId);
    return {};
  }));

  // ── Notifications via Zalo (Task management → Settings): owner / admin ──
  // `zalo` (not `status`): the `status` key in the REST result was read as an HTTP status code
  ipcMain.handle('erp:notify:zaloStatus', withErpAuth('settings.erp', async () => ({
    zalo: svc().getZaloStatus(),
  })));

  // Only the fields that are sent: { enabled?, accountId?, types? }
  ipcMain.handle('erp:notify:setZaloSettings', withErpAuth('settings.erp', async (input: any) => ({
    settings: svc().setZaloSettings(input?.settings ?? {}),
  })));

  // Send a test to one employee; if it fails → error (text shown to the user)
  ipcMain.handle('erp:notify:testZalo', withErpAuth('settings.erp', async (input: any) => {
    const employeeId = erpValidate.string(input?.employeeId, 'employeeId', { max: 200 });
    const result = await svc().sendZaloTest(employeeId);
    if (!result.ok) throw new Error(result.error || tr('Gửi thử không được'));
    return { sent: true };
  }));
}

