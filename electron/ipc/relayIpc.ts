import { ipcMain } from 'electron';
import HttpRelayService from '../../src/services/http/HttpRelayService';
import DatabaseService from '../../src/services/database/DatabaseService';
import Logger from '../../src/utils/Logger';
import os from 'os';

/** Lấy địa chỉ IPv4 local (không loopback) */
function getLocalIp(): string {
    try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            const ifaces = nets[name];
            if (!ifaces) continue;
            for (const iface of ifaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
    } catch {}
    return '127.0.0.1';
}

export function registerRelayIpc(): void {
    const relay = () => HttpRelayService.getInstance();

    ipcMain.handle('relay:startServer', async (_e, { port }: { port?: number } = {}) => {
        try {
            const res = await relay().start(port);
            if (res.success) {
                return { ...res, host: getLocalIp() };
            }
            return res;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:stopServer', async () => {
        try {
            return relay().stop();
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:getServerStatus', async () => {
        try {
            return { success: true, ...relay().getStatus() };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:kickEmployee', async (_e, { employeeId }: { employeeId: string }) => {
        try {
            relay().kickEmployee(employeeId);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:startTunnel', async () => {
        try {
            return await relay().startTunnel();
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:stopTunnel', async () => {
        try {
            return await relay().stopTunnel();
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:getTunnelStatus', async () => {
        try {
            return { success: true, ...relay().getTunnelStatus() };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Tunnel provider config (cloudflare | ngrok static domain) ──────────────
    ipcMain.handle('relay:getTunnelConfig', async () => {
        try {
            const db = DatabaseService.getInstance();
            return {
                success: true,
                provider: db.getSetting('relay_tunnel_provider') || 'cloudflare',
                authtoken: db.getSetting('relay_ngrok_authtoken') || '',
                domain: db.getSetting('relay_ngrok_domain') || '',
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:setTunnelConfig', async (_e, cfg: { provider?: string; authtoken?: string; domain?: string } = {}) => {
        try {
            const db = DatabaseService.getInstance();
            if (cfg.provider !== undefined) db.setSetting('relay_tunnel_provider', cfg.provider);
            if (cfg.authtoken !== undefined) db.setSetting('relay_ngrok_authtoken', cfg.authtoken);
            if (cfg.domain !== undefined) db.setSetting('relay_ngrok_domain', cfg.domain);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    Logger.log('[relayIpc] Registered 9 relay IPC channels');
}
