import { ipcMain } from 'electron';
import HttpClientService from '../../src/services/HttpClientService';
import HttpConnectionManager from '../../src/services/HttpConnectionManager';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import DataSyncService from '../../src/services/DataSyncService';
import DatabaseService from '../../src/services/DatabaseService';
import Logger from '../../src/utils/Logger';

/** Get the HttpClientService for the currently active remote workspace. */
function getActiveHttpClient(): HttpClientService {
    const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
    if (activeWs?.type === 'remote') {
        const svc = HttpConnectionManager.getInstance().getServiceForWorkspace(activeWs.id);
        if (svc) return svc;
    }
    // Fallback to legacy singleton
    return HttpClientService.getInstance();
}

/** Check if the current context is employee/remote mode. */
function isRemoteMode(): boolean {
    const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
    return activeWs?.type === 'remote';
}

export function registerSyncIpc() {
    // ─── Full Sync (Employee requests from Boss) ────────────────────
    ipcMain.handle('sync:requestFullSync', async (_event, params: { zaloIds: string[] }) => {
        try {
            if (!isRemoteMode()) {
                return { success: false, error: 'Chỉ dùng ở chế độ Nhân viên' };
            }
            const { zaloIds } = params;
            if (!zaloIds || zaloIds.length === 0) {
                return { success: false, error: 'Không có tài khoản được gán' };
            }

            const client = getActiveHttpClient();
            const result = await client.performFullSync(zaloIds);
            if (result.success) {
                const appliedSyncTs = result.syncTs || Date.now();
                try {
                    DatabaseService.getInstance().run(
                        `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('employee_last_sync_ts', ?, ?)`,
                        [String(appliedSyncTs), new Date(appliedSyncTs).toISOString()]
                    );
                } catch {}
            }
            return result;
        } catch (err: any) {
            Logger.error(`[syncIpc] requestFullSync error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Delta Sync (Employee requests incremental from Boss) ───────
    ipcMain.handle('sync:requestDeltaSync', async (_event, params?: { sinceTs?: number }) => {
        try {
            if (!isRemoteMode()) {
                return { success: false, error: 'Chỉ dùng ở chế độ Nhân viên' };
            }

            let sinceTs = params?.sinceTs || 0;
            if (!sinceTs) {
                const row = DatabaseService.getInstance().query<any>(
                    `SELECT value FROM app_settings WHERE key = 'employee_last_sync_ts'`
                );
                sinceTs = row[0]?.value ? Number(row[0].value) : 0;
            }

            if (!sinceTs) {
                return { success: false, error: 'Chưa đồng bộ lần đầu, cần Full Sync trước' };
            }

            const client = getActiveHttpClient();
            const result = await client.performDeltaSync(sinceTs);
            if (result.success) {
                const appliedSyncTs = result.syncTs || Date.now();
                try {
                    DatabaseService.getInstance().run(
                        `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('employee_last_sync_ts', ?, ?)`,
                        [String(appliedSyncTs), new Date(appliedSyncTs).toISOString()]
                    );
                } catch {}
            }
            return result;
        } catch (err: any) {
            Logger.error(`[syncIpc] requestDeltaSync error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Reset Employee DB ──────────────────────────────────────────
    ipcMain.handle('sync:resetEmployeeDB', async (_event, params: { zaloIds: string[] }) => {
        try {
            if (!isRemoteMode()) {
                return { success: false, error: 'Chỉ dùng ở chế độ Nhân viên' };
            }
            DataSyncService.getInstance().resetEmployeeDB(params.zaloIds);
            try {
                DatabaseService.getInstance().run(
                    `DELETE FROM app_settings WHERE key = 'employee_last_sync_ts'`
                );
            } catch {}
            return { success: true };
        } catch (err: any) {
            Logger.error(`[syncIpc] resetEmployeeDB error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Get Sync Status ────────────────────────────────────────────
    ipcMain.handle('sync:getStatus', async () => {
        try {
            const row = DatabaseService.getInstance().query<any>(
                `SELECT value FROM app_settings WHERE key = 'employee_last_sync_ts'`
            );
            const lastSyncTs = row[0]?.value ? Number(row[0].value) : 0;
            return { success: true, lastSyncTs };
        } catch (err: any) {
            return { success: true, lastSyncTs: 0 };
        }
    });

    // ─── Request Media from Boss ────────────────────────────────────
    ipcMain.handle('sync:requestMedia', async (_event, params: { filePath: string }) => {
        try {
            if (!isRemoteMode()) {
                return { success: false, error: 'Chỉ dùng ở chế độ Nhân viên' };
            }
            return await getActiveHttpClient().requestMedia(params.filePath);
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });
}

