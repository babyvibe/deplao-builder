import { ipcMain } from 'electron';
import ErpNotificationService from '../../../src/services/erp/ErpNotificationService';
import { withErpAuth, erpValidate } from './erpIpcMiddleware';

export function registerErpNotificationIpc(): void {
  const svc = () => ErpNotificationService.getInstance();

  ipcMain.handle('erp:notify:listInbox', withErpAuth('erp.access', async (input: any, ctx) => ({
    notifications: svc().listInbox(ctx.employeeId, !!input?.unreadOnly, {
      limit: input?.limit,
      offset: input?.offset,
    }),
  })));

  // Chỉ thông báo của người gọi (id thông báo của người khác bị bỏ qua)
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

  // ── Thông báo qua Zalo (Quản lý công việc → Cài đặt): owner / admin ──
  // `zalo` (không phải `status`): khoá `status` trong kết quả REST bị hiểu là mã HTTP
  ipcMain.handle('erp:notify:zaloStatus', withErpAuth('settings.erp', async () => ({
    zalo: svc().getZaloStatus(),
  })));

  // Chỉ trường có gửi: { enabled?, accountId?, types? }
  ipcMain.handle('erp:notify:setZaloSettings', withErpAuth('settings.erp', async (input: any) => ({
    settings: svc().setZaloSettings(input?.settings ?? {}),
  })));

  // Gửi thử tới một nhân viên; gửi không được → lỗi (chữ cho người dùng)
  ipcMain.handle('erp:notify:testZalo', withErpAuth('settings.erp', async (input: any) => {
    const employeeId = erpValidate.string(input?.employeeId, 'employeeId', { max: 200 });
    const result = await svc().sendZaloTest(employeeId);
    if (!result.ok) throw new Error(result.error || 'Gửi thử không được');
    return { sent: true };
  }));
}

