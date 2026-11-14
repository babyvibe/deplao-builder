import { ipcMain } from 'electron';
import IntegrationRegistry from '../../../src/services/integrations/IntegrationRegistry';
import { paymentsTunnelStatus, paymentsWebhookAddress, startPaymentsTunnel, stopPaymentsTunnel } from '../../../src/services/integrations/PaymentsTunnel';
import TunnelService from '../../../src/services/tunnel/TunnelService';
import WorkspaceManager from '../../../src/utils/app/WorkspaceManager';
import Logger from '../../../src/utils/Logger';
import { proxyToBossWithResult } from '../network/proxyHelper';
import { tr } from '../../../src/shared/i18n';

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
        if (data.success === false) return data.error || data.message || tr('Thao tác thất bại');
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
            if (isEmployeeMode()) return { success: false, error: tr('Không khả dụng ở chế độ nhân viên') };
            const item = IntegrationRegistry.getConfig(id);
            if (!item) return { success: false, error: 'Không tìm thấy' };
            return { success: true, integration: item };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // Employee: integrations live on Boss → proxy and wait for the result (new id, missing integration module permission errors…) instead of
    // returning { success: true } at once and failing silently.
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

    // Employee: integrations (credentials, adapters) exist only on Boss → test / run actions (Quick integration, product sync
    // of the AI Assistant) must run on Boss and need the integration module permission (proxyActionPolicy). Boss commands run on behalf of an employee
    // (_fromRelay) always run locally. POS actions can scan many pages → wait up to 2 minutes, like Public API.
    const runsOnBoss = (args: any): boolean => isEmployeeMode() && !args?._fromRelay;
    const BOSS_ACTION_TIMEOUT_MS = 120_000;

    // ─── Test connection ──────────────────────────────────────────────────────
    ipcMain.handle('integration:test', async (_e, args: { id: string; _fromRelay?: boolean }) => {
        if (runsOnBoss(args)) {
            const res = await proxyToBossWithResult('integration:test', { id: args?.id }, { timeoutMs: BOSS_ACTION_TIMEOUT_MS });
            // Forwarded errors ({ success:false, error }) → the integration page reads `message`
            return res?.success === false && !res.message ? { ...res, message: res.error || tr('Không kiểm tra được kết nối trên Boss') } : res;
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

    // ─── Automatic webhook registration (KiotViet / Sapo) ─────────────────────────────
    // Runs on Boss: the credentials + webhook receiving address (the 'payments' service) live on Boss; employees need the integration module permission.
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

    // ─── Tunnel (port for receiving payment webhooks) ────────────────────────────────
    // Logic lives in src/services/integrations/PaymentsTunnel.ts (shared with Settings → Internet & Cloud → Internet address):
    // Cloudflare automatic → the 'payments' service of the shared tunnel; other modes → a separate Quick Tunnel for the port.
    ipcMain.handle('tunnel:start', () => startPaymentsTunnel());

    ipcMain.handle('tunnel:stop', () => stopPaymentsTunnel());

    ipcMain.handle('tunnel:status', () => paymentsTunnelStatus());

    // ─── Tunnel: get all ─────────────────────────────────────────────────────
    ipcMain.handle('tunnel:getAll', () => ({
        tunnels: TunnelService.getAllTunnels(),
    }));
}

