import { ipcMain } from 'electron';
import IntegrationRegistry from '../../src/services/integrations/IntegrationRegistry';
import { paymentsTunnelStatus, paymentsWebhookAddress, startPaymentsTunnel, stopPaymentsTunnel } from '../../src/services/integrations/PaymentsTunnel';
import TunnelService from '../../src/services/tunnel/TunnelService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import { proxyToBossWithResult } from './proxyHelper';

function isEmployeeMode(): boolean {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') return true;
    } catch {}
    return false;
}

export function registerIntegrationIpc(): void {
    const extractActionError = (data: any): string | null => {
        if (!data || typeof data !== 'object') return null;
        if (data.success === false) return data.error || data.message || 'Thao tác thất bại';
        if (typeof data.error === 'string' && data.error.trim()) return data.error;
        return null;
    };

    // ─── List all integrations (no credentials) ───────────────────────────────
    ipcMain.handle('integration:list', async () => {
        try {
            if (isEmployeeMode()) return { success: true, integrations: [], webhookPort: 0 };
            const items = IntegrationRegistry.listConfigs();
            const port  = IntegrationRegistry.getWebhookPort();
            return { success: true, integrations: items, webhookPort: port };
        } catch (e: any) {
            Logger.error(`[IntegrationIpc] list: ${e.message}`);
            return { success: false, error: e.message, integrations: [] };
        }
    });

    // ─── Get single (masked credentials) ─────────────────────────────────────
    ipcMain.handle('integration:get', async (_e, { id }: { id: string }) => {
        try {
            if (isEmployeeMode()) return { success: false, error: 'Không khả dụng ở chế độ nhân viên' };
            const item = IntegrationRegistry.getConfig(id);
            if (!item) return { success: false, error: 'Không tìm thấy' };
            return { success: true, integration: item };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // Nhân viên: tích hợp nằm trên Boss — proxy chờ kết quả (id mới, lỗi thiếu quyền module integration…) thay vì
    // trả { success: true } ngay rồi lỗi im lặng.
    // ─── Save (create or update) ──────────────────────────────────────────────
    ipcMain.handle('integration:save', async (_e, { integration }: { integration: any }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('integration:save', { integration });
            const id = IntegrationRegistry.saveConfig(integration);
            return { success: true, id };
        } catch (e: any) {
            Logger.error(`[IntegrationIpc] save: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    // ─── Delete ───────────────────────────────────────────────────────────────
    ipcMain.handle('integration:delete', async (_e, { id }: { id: string }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('integration:delete', { id });
            IntegrationRegistry.deleteConfig(id);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Toggle enabled ───────────────────────────────────────────────────────
    ipcMain.handle('integration:toggle', async (_e, { id, enabled }: { id: string; enabled: boolean }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('integration:toggle', { id, enabled });
            IntegrationRegistry.toggleEnabled(id, enabled);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // Nhân viên: tích hợp (credential, adapter) chỉ có trên Boss — test / chạy thao tác (Tích hợp nhanh, đồng bộ sản phẩm
    // của Trợ lý AI) phải chạy trên Boss, cần quyền module integration (proxyActionPolicy). Lệnh Boss chạy hộ nhân viên
    // (_fromRelay) luôn chạy tại chỗ. Thao tác POS có thể quét nhiều trang → chờ tới 2 phút như Public API.
    const runsOnBoss = (args: any): boolean => isEmployeeMode() && !args?._fromRelay;
    const BOSS_ACTION_TIMEOUT_MS = 120_000;

    // ─── Test connection ──────────────────────────────────────────────────────
    ipcMain.handle('integration:test', async (_e, args: { id: string; _fromRelay?: boolean }) => {
        if (runsOnBoss(args)) {
            const res = await proxyToBossWithResult('integration:test', { id: args?.id }, { timeoutMs: BOSS_ACTION_TIMEOUT_MS });
            // Lỗi chuyển tiếp ({ success:false, error }) → trang tích hợp đọc `message`
            return res?.success === false && !res.message ? { ...res, message: res.error || 'Không kiểm tra được kết nối trên Boss' } : res;
        }
        const { id } = args || ({} as any);
        try {
            const result = await IntegrationRegistry.testConnection(id);
            return { success: true, ...result };
        } catch (e: any) {
            return { success: false, message: e.message };
        }
    });

    // ─── Execute action ───────────────────────────────────────────────────────
    ipcMain.handle('integration:execute', async (_e, args: { id: string; action: string; params: any; _fromRelay?: boolean }) => {
        if (runsOnBoss(args)) {
            return proxyToBossWithResult('integration:execute', { id: args?.id, action: args?.action, params: args?.params || {} }, { timeoutMs: BOSS_ACTION_TIMEOUT_MS });
        }
        const { id, action, params } = args || ({} as any);
        try {
            const data = await IntegrationRegistry.executeAction(id, action, params || {});
            Logger.info(`[IntegrationIpc] execute ${action} response: ${JSON.stringify(data)?.slice(0, 1200)}`);
            const nestedError = extractActionError(data);
            if (nestedError) {
                Logger.warn(`[IntegrationIpc] execute ${action} (nested error): ${nestedError}`);
                return { success: false, error: nestedError, data };
            }
            return { success: true, data };
        } catch (e: any) {
            Logger.error(`[IntegrationIpc] execute ${action}: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    // ─── Execute by type ──────────────────────────────────────────────────────
    ipcMain.handle('integration:executeByType', async (_e, args: { type: string; action: string; params: any; _fromRelay?: boolean }) => {
        if (runsOnBoss(args)) {
            return proxyToBossWithResult('integration:executeByType', { type: args?.type, action: args?.action, params: args?.params || {} }, { timeoutMs: BOSS_ACTION_TIMEOUT_MS });
        }
        const { type, action, params } = args || ({} as any);
        try {
            const data = await IntegrationRegistry.executeActionByType(type, action, params || {});
            Logger.info(`[IntegrationIpc] executeByType ${type}.${action} response: ${JSON.stringify(data)?.slice(0, 1200)}`);
            const nestedError = extractActionError(data);
            if (nestedError) {
                Logger.warn(`[IntegrationIpc] executeByType ${type}.${action} (nested error): ${nestedError}`);
                return { success: false, error: nestedError, data };
            }
            return { success: true, data };
        } catch (e: any) {
            Logger.error(`[IntegrationIpc] executeByType ${type}.${action}: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    // ─── Đăng ký webhook tự động (KiotViet / Sapo) ─────────────────────────────
    // Chạy trên Boss: credential + địa chỉ nhận webhook (dịch vụ 'payments') nằm ở Boss; nhân viên cần quyền module integration.
    ipcMain.handle('integration:listWebhooks', async (_e, args: { id: string; _fromRelay?: boolean }) => {
        if (runsOnBoss(args)) {
            return proxyToBossWithResult('integration:listWebhooks', { id: args?.id }, { timeoutMs: BOSS_ACTION_TIMEOUT_MS });
        }
        try {
            return await IntegrationRegistry.listPosWebhooks(String(args?.id || ''), paymentsWebhookAddress());
        } catch (e: any) {
            Logger.error(`[IntegrationIpc] listWebhooks: ${e.message}`);
            return { success: false, error: e.message, webhooks: [] };
        }
    });

    ipcMain.handle('integration:registerWebhooks', async (_e, args: { id: string; events: string[]; _fromRelay?: boolean }) => {
        if (runsOnBoss(args)) {
            return proxyToBossWithResult('integration:registerWebhooks', { id: args?.id, events: args?.events || [] }, { timeoutMs: BOSS_ACTION_TIMEOUT_MS });
        }
        try {
            const events = Array.isArray(args?.events) ? args.events.map(String) : [];
            return await IntegrationRegistry.registerPosWebhooks(String(args?.id || ''), events, paymentsWebhookAddress());
        } catch (e: any) {
            Logger.error(`[IntegrationIpc] registerWebhooks: ${e.message}`);
            return { success: false, error: e.message, webhooks: [] };
        }
    });

    ipcMain.handle('integration:removeWebhook', async (_e, args: { id: string; webhookId: string; _fromRelay?: boolean }) => {
        if (runsOnBoss(args)) {
            return proxyToBossWithResult('integration:removeWebhook', { id: args?.id, webhookId: args?.webhookId }, { timeoutMs: BOSS_ACTION_TIMEOUT_MS });
        }
        try {
            return await IntegrationRegistry.removePosWebhook(String(args?.id || ''), String(args?.webhookId || ''), paymentsWebhookAddress());
        } catch (e: any) {
            Logger.error(`[IntegrationIpc] removeWebhook: ${e.message}`);
            return { success: false, error: e.message, webhooks: [] };
        }
    });

    // ─── Get webhook port ─────────────────────────────────────────────────────
    ipcMain.handle('integration:getWebhookPort', async () => {
        return { success: true, port: IntegrationRegistry.getWebhookPort() };
    });

    // ─── Tunnel (cổng nhận webhook thanh toán) ────────────────────────────────
    // Logic ở src/services/integrations/PaymentsTunnel.ts (dùng chung với Cài đặt → Internet & Đám mây → Địa chỉ Internet):
    // Cloudflare tự động → dịch vụ 'payments' của tunnel dùng chung; chế độ khác → Quick Tunnel riêng của cổng.
    ipcMain.handle('tunnel:start', () => startPaymentsTunnel());

    ipcMain.handle('tunnel:stop', () => stopPaymentsTunnel());

    ipcMain.handle('tunnel:status', () => paymentsTunnelStatus());

    // ─── Tunnel: get all ─────────────────────────────────────────────────────
    ipcMain.handle('tunnel:getAll', () => ({
        tunnels: TunnelService.getAllTunnels(),
    }));
}

