"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSyncIpc = registerSyncIpc;
const electron_1 = require("electron");
const HttpClientService_1 = __importDefault(require("../../src/services/HttpClientService"));
const HttpConnectionManager_1 = __importDefault(require("../../src/services/HttpConnectionManager"));
const WorkspaceManager_1 = __importDefault(require("../../src/utils/WorkspaceManager"));
const DataSyncService_1 = __importDefault(require("../../src/services/DataSyncService"));
const DatabaseService_1 = __importDefault(require("../../src/services/DatabaseService"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
/** Get the HttpClientService for the currently active remote workspace. */
function getActiveHttpClient() {
    const activeWs = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
    if (activeWs?.type === 'remote') {
        const svc = HttpConnectionManager_1.default.getInstance().getServiceForWorkspace(activeWs.id);
        if (svc)
            return svc;
    }
    // Fallback to legacy singleton
    return HttpClientService_1.default.getInstance();
}
/** Check if the current context is employee/remote mode. */
function isRemoteMode() {
    const activeWs = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
    return activeWs?.type === 'remote';
}
function registerSyncIpc() {
    // ─── Full Sync (Employee requests from Boss) ────────────────────
    electron_1.ipcMain.handle('sync:requestFullSync', async (_event, params) => {
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
                    DatabaseService_1.default.getInstance().run(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('employee_last_sync_ts', ?, ?)`, [String(appliedSyncTs), new Date(appliedSyncTs).toISOString()]);
                }
                catch { }
            }
            return result;
        }
        catch (err) {
            Logger_1.default.error(`[syncIpc] requestFullSync error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Delta Sync (Employee requests incremental from Boss) ───────
    electron_1.ipcMain.handle('sync:requestDeltaSync', async (_event, params) => {
        try {
            if (!isRemoteMode()) {
                return { success: false, error: 'Chỉ dùng ở chế độ Nhân viên' };
            }
            let sinceTs = params?.sinceTs || 0;
            if (!sinceTs) {
                const row = DatabaseService_1.default.getInstance().query(`SELECT value FROM app_settings WHERE key = 'employee_last_sync_ts'`);
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
                    DatabaseService_1.default.getInstance().run(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('employee_last_sync_ts', ?, ?)`, [String(appliedSyncTs), new Date(appliedSyncTs).toISOString()]);
                }
                catch { }
            }
            return result;
        }
        catch (err) {
            Logger_1.default.error(`[syncIpc] requestDeltaSync error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Reset Employee DB ──────────────────────────────────────────
    electron_1.ipcMain.handle('sync:resetEmployeeDB', async (_event, params) => {
        try {
            if (!isRemoteMode()) {
                return { success: false, error: 'Chỉ dùng ở chế độ Nhân viên' };
            }
            DataSyncService_1.default.getInstance().resetEmployeeDB(params.zaloIds);
            try {
                DatabaseService_1.default.getInstance().run(`DELETE FROM app_settings WHERE key = 'employee_last_sync_ts'`);
            }
            catch { }
            return { success: true };
        }
        catch (err) {
            Logger_1.default.error(`[syncIpc] resetEmployeeDB error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Get Sync Status ────────────────────────────────────────────
    electron_1.ipcMain.handle('sync:getStatus', async () => {
        try {
            const row = DatabaseService_1.default.getInstance().query(`SELECT value FROM app_settings WHERE key = 'employee_last_sync_ts'`);
            const lastSyncTs = row[0]?.value ? Number(row[0].value) : 0;
            return { success: true, lastSyncTs };
        }
        catch (err) {
            return { success: true, lastSyncTs: 0 };
        }
    });
    // ─── Request Media from Boss ────────────────────────────────────
    electron_1.ipcMain.handle('sync:requestMedia', async (_event, params) => {
        try {
            if (!isRemoteMode()) {
                return { success: false, error: 'Chỉ dùng ở chế độ Nhân viên' };
            }
            return await getActiveHttpClient().requestMedia(params.filePath);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
}
//# sourceMappingURL=syncIpc.js.map