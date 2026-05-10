import { ipcMain } from 'electron';
import HttpRelayService from '../../src/services/HttpRelayService';
import Logger from '../../src/utils/Logger';

export function registerRelayIpc(): void {
    const relay = () => HttpRelayService.getInstance();

    ipcMain.handle('relay:startServer', async (_e, { port }: { port?: number } = {}) => {
        try {
            return await relay().start(port);
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

    Logger.log('[relayIpc] Registered 4 relay IPC channels');
}
