"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerErpNotificationIpc = registerErpNotificationIpc;
const electron_1 = require("electron");
const ErpNotificationService_1 = __importDefault(require("../../src/services/erp/ErpNotificationService"));
const erpIpcMiddleware_1 = require("./erpIpcMiddleware");
function registerErpNotificationIpc() {
    const svc = () => ErpNotificationService_1.default.getInstance();
    electron_1.ipcMain.handle('erp:notify:listInbox', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input, ctx) => ({
        notifications: svc().listInbox(ctx.employeeId, !!input?.unreadOnly, {
            limit: input?.limit,
            offset: input?.offset,
        }),
    })));
    electron_1.ipcMain.handle('erp:notify:markRead', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (input) => {
        const ids = Array.isArray(input?.ids) ? input.ids.map(Number).filter(Number.isFinite) : [];
        svc().markRead(ids);
        return {};
    }));
    electron_1.ipcMain.handle('erp:notify:markAllRead', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (_input, ctx) => {
        svc().markAllRead(ctx.employeeId);
        return {};
    }));
    electron_1.ipcMain.handle('erp:notify:unreadCount', (0, erpIpcMiddleware_1.withErpAuth)('erp.access', async (_input, ctx) => ({
        count: svc().getUnreadCount(ctx.employeeId),
    })));
}
//# sourceMappingURL=erpNotificationIpc.js.map