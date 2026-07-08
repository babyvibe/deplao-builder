import { ipcMain } from 'electron';
import HttpRelayService from '../../src/services/http/HttpRelayService';
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

    Logger.log('[relayIpc] Registered 7 relay IPC channels');
}
