import { ipcMain, BrowserWindow } from 'electron';
import IntegrationRegistry from '../../src/services/integrations/IntegrationRegistry';
import TunnelService from '../../src/services/tunnel/TunnelService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import { proxyToBoss } from './proxyHelper';

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

    // ─── Save (create or update) ──────────────────────────────────────────────
    ipcMain.handle('integration:save', async (_e, { integration }: { integration: any }) => {
        try {
            if (isEmployeeMode()) {
                proxyToBoss('integration:save', { integration });
                return { success: true };
            }
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
            if (isEmployeeMode()) {
                proxyToBoss('integration:delete', { id });
                return { success: true };
            }
            IntegrationRegistry.deleteConfig(id);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Toggle enabled ───────────────────────────────────────────────────────
    ipcMain.handle('integration:toggle', async (_e, { id, enabled }: { id: string; enabled: boolean }) => {
        try {
            if (isEmployeeMode()) {
                proxyToBoss('integration:toggle', { id, enabled });
                return { success: true };
            }
            IntegrationRegistry.toggleEnabled(id, enabled);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Test connection ──────────────────────────────────────────────────────
    ipcMain.handle('integration:test', async (_e, { id }: { id: string }) => {
        try {
            const result = await IntegrationRegistry.testConnection(id);
            return { success: true, ...result };
        } catch (e: any) {
            return { success: false, message: e.message };
        }
    });

    // ─── Execute action ───────────────────────────────────────────────────────
    ipcMain.handle('integration:execute', async (_e, { id, action, params }: { id: string; action: string; params: any }) => {
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
    ipcMain.handle('integration:executeByType', async (_e, { type, action, params }: { type: string; action: string; params: any }) => {
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

    // ─── Get webhook port ─────────────────────────────────────────────────────
    ipcMain.handle('integration:getWebhookPort', async () => {
        return { success: true, port: IntegrationRegistry.getWebhookPort() };
    });

    // ─── Tunnel: start ────────────────────────────────────────────────────────
    ipcMain.handle('tunnel:start', async () => {
        try {
            const port = IntegrationRegistry.getWebhookPort();
            const url = await TunnelService.start(port, 'Webhook Gateway');
            // Notify all renderer windows of the tunnel URL change
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tunnel:changed', { port, url }));
            return { success: true, url };
        } catch (e: any) {
            Logger.error(`[TunnelIpc] start: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    // ─── Tunnel: stop ─────────────────────────────────────────────────────────
    ipcMain.handle('tunnel:stop', async () => {
        try {
            const port = IntegrationRegistry.getWebhookPort();
            await TunnelService.stop(port);
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tunnel:changed', { port, url: null }));
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // ─── Tunnel: status ───────────────────────────────────────────────────────
    ipcMain.handle('tunnel:status', () => {
        const port = IntegrationRegistry.getWebhookPort();
        return {
            active: TunnelService.isActive(port),
            url: TunnelService.getUrl(port),
        };
    });

    // ─── Tunnel: get all ─────────────────────────────────────────────────────
    ipcMain.handle('tunnel:getAll', () => ({
        tunnels: TunnelService.getAllTunnels(),
    }));
}

