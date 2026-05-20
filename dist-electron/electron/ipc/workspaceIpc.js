"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWorkspaceIpc = registerWorkspaceIpc;
const electron_1 = require("electron");
const http = __importStar(require("http"));
const WorkspaceManager_1 = __importDefault(require("../../src/utils/WorkspaceManager"));
const AppModeManager_1 = __importDefault(require("../../src/utils/AppModeManager"));
const DatabaseService_1 = __importDefault(require("../../src/services/DatabaseService"));
const FileStorageService_1 = __importDefault(require("../../src/services/FileStorageService"));
const HttpConnectionManager_1 = __importDefault(require("../../src/services/HttpConnectionManager"));
const HttpRelayService_1 = __importDefault(require("../../src/services/HttpRelayService"));
const ConnectionManager_1 = __importDefault(require("../../src/utils/ConnectionManager"));
const EventBroadcaster_1 = __importDefault(require("../../src/services/EventBroadcaster"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
/**
 * HTTP POST helper for remote login requests.
 */
function httpPost(url, body, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            reject(new Error('URL không hợp lệ'));
            return;
        }
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port || '80',
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: timeoutMs,
        }, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => { responseBody += chunk.toString(); });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(responseBody));
                }
                catch {
                    reject(new Error('Phản hồi không hợp lệ từ boss server'));
                }
            });
        });
        req.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                reject(new Error('Không thể kết nối — kiểm tra lại IP và Port, đảm bảo boss đã bật Relay Server'));
            }
            else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
                reject(new Error('Hết thời gian kết nối — kiểm tra lại mạng'));
            }
            else {
                reject(new Error(`Lỗi kết nối: ${err.message}`));
            }
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Hết thời gian kết nối (10s) — kiểm tra lại IP/Port'));
        });
        req.write(data);
        req.end();
    });
}
/**
 * registerWorkspaceIpc — IPC handlers for Workspace CRUD + switching.
 * 8 channels total.
 */
function registerWorkspaceIpc(mainWindow) {
    const wm = () => WorkspaceManager_1.default.getInstance();
    // ─── List ────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workspace:list', async () => {
        try {
            const workspaces = wm().listWorkspaces();
            return { success: true, workspaces };
        }
        catch (err) {
            Logger_1.default.error(`[workspaceIpc] list error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Get Active ──────────────────────────────────────────────────
    electron_1.ipcMain.handle('workspace:getActive', async () => {
        try {
            const workspace = wm().getActiveWorkspace();
            return { success: true, workspace };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Create ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workspace:create', async (_e, params) => {
        try {
            return wm().createWorkspace(params);
        }
        catch (err) {
            Logger_1.default.error(`[workspaceIpc] create error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Update ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workspace:update', async (_e, { id, updates }) => {
        try {
            return wm().updateWorkspace(id, updates);
        }
        catch (err) {
            Logger_1.default.error(`[workspaceIpc] update error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Delete ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workspace:delete', async (_e, { id }) => {
        try {
            // Record whether this is the currently active workspace BEFORE deleting
            const wasActive = wm().getActiveWorkspaceId() === id;
            const result = wm().deleteWorkspace(id);
            if (result.success && wasActive) {
                // WorkspaceManager already updated activeWorkspaceId to the first remaining.
                // Now we need to: switch DB + notify renderer (same as workspace:switch).
                const newActiveWs = wm().getActiveWorkspace();
                if (newActiveWs) {
                    AppModeManager_1.default.getInstance().clearOverride();
                    const newDbPath = wm().resolveDbPath(newActiveWs.dbPath || 'deplao-tool.db');
                    await DatabaseService_1.default.getInstance().switchToWorkspaceDb(newDbPath);
                    FileStorageService_1.default.resetBaseDir();
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('workspace:switched', {
                            workspace: newActiveWs,
                        });
                    }
                    Logger_1.default.log(`[workspaceIpc] Deleted active workspace → switched to "${newActiveWs.name}"`);
                }
            }
            return result;
        }
        catch (err) {
            Logger_1.default.error(`[workspaceIpc] delete error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Switch ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('workspace:switch', async (_e, { id }) => {
        const prevWorkspaceId = wm().getActiveWorkspaceId();
        try {
            const result = wm().switchWorkspace(id);
            if (result.success && result.workspace) {
                // Clear AppModeManager override so it derives mode from workspace
                AppModeManager_1.default.getInstance().clearOverride();
                // Flush pending DB writes before switching
                DatabaseService_1.default.getInstance().forceFlush();
                // Clear event hooks to prevent accumulation across switches
                EventBroadcaster_1.default.clearBeforeSendHooks();
                // Switch DatabaseService to the new workspace's DB
                const newDbPath = wm().resolveDbPath(result.workspace.dbPath || 'deplao-tool.db');
                await DatabaseService_1.default.getInstance().switchToWorkspaceDb(newDbPath);
                // Reset FileStorageService cache so media resolves to the new workspace's folder
                FileStorageService_1.default.resetBaseDir();
                // Re-hook HttpRelayService into EventBroadcaster (clearBeforeSendHooks removed them)
                try {
                    const relay = HttpRelayService_1.default.getInstance();
                    if (relay.getStatus().running) {
                        relay.hookEventBroadcaster();
                    }
                }
                catch { }
                // Sync latest cookies from active ConnectionManager connections into the newly loaded DB
                // (Zalo may have refreshed cookies while boss was on a different workspace)
                try {
                    const db = DatabaseService_1.default.getInstance();
                    for (const [zaloId, conn] of ConnectionManager_1.default.getAllConnections()) {
                        if (conn.auth) {
                            const authObj = typeof conn.auth === 'string' ? JSON.parse(conn.auth) : conn.auth;
                            if (authObj?.cookies) {
                                db.run(`UPDATE accounts SET cookies = ?, imei = ?, user_agent = ? WHERE zalo_id = ?`, [authObj.cookies, authObj.imei || '', authObj.userAgent || '', zaloId]);
                            }
                        }
                    }
                }
                catch (err) {
                    Logger_1.default.warn(`[workspaceIpc] Cookie sync from ConnectionManager failed: ${err.message}`);
                }
                Logger_1.default.log(`[workspaceIpc] switch → workspace=${result.workspace.id} name="${result.workspace.name}" type=${result.workspace.type} dbPath=${newDbPath} cachedAssigned=${result.workspace.cachedAssignedAccounts?.length || 0} cachedAccountsData=${result.workspace.cachedAccountsData?.length || 0} cachedPermissions=${result.workspace.cachedPermissions?.length || 0}`);
                // ── Auto-reconnect for remote workspaces ─────────
                if (result.workspace.type === 'remote' && result.workspace.bossUrl && result.workspace.token) {
                    const scm = HttpConnectionManager_1.default.getInstance();
                    if (!scm.isConnected(id)) {
                        Logger_1.default.log(`[workspaceIpc] Remote workspace "${result.workspace.name}" not connected — auto-reconnecting...`);
                        try {
                            await scm.connect(id, result.workspace.bossUrl, result.workspace.token);
                        }
                        catch (err) {
                            Logger_1.default.warn(`[workspaceIpc] Auto-reconnect failed for "${result.workspace.name}": ${err.message}`);
                        }
                    }
                    else {
                        Logger_1.default.log(`[workspaceIpc] Remote workspace "${result.workspace.name}" already connected`);
                    }
                    // Merge snapshot data into workspace object so renderer gets it in ONE event
                    const snapshot = scm.getSnapshot(id);
                    if (snapshot) {
                        result.workspace._connected = true;
                        result.workspace._snapshot = snapshot;
                    }
                }
                // Notify renderer to reload state
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('workspace:switched', {
                        workspace: result.workspace,
                    });
                }
            }
            return result;
        }
        catch (err) {
            try {
                const currentActiveId = wm().getActiveWorkspaceId();
                if (currentActiveId === id && prevWorkspaceId && prevWorkspaceId !== id) {
                    wm().restoreActiveWorkspace(prevWorkspaceId);
                }
            }
            catch { /* ignore rollback helper failure */ }
            const msg = err?.message || String(err) || 'Unknown switch error';
            Logger_1.default.error(`[workspaceIpc] switch error: ${msg}`, err);
            return { success: false, error: msg };
        }
    });
    // ─── Is Multi-Workspace ──────────────────────────────────────────
    electron_1.ipcMain.handle('workspace:isMulti', async () => {
        return { isMulti: wm().isMultiWorkspace() };
    });
    // ─── Get DB Path for workspace ───────────────────────────────────
    electron_1.ipcMain.handle('workspace:getDbPath', async (_e, { id }) => {
        try {
            const ws = wm().getWorkspaceById(id);
            if (!ws)
                return { success: false, error: 'Workspace not found' };
            const dbPath = wm().resolveDbPath(ws.dbPath || 'deplao-tool.db');
            return { success: true, dbPath };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Connect Remote Workspace ────────────────────────────────────
    electron_1.ipcMain.handle('workspace:connectRemote', async (_e, { id, bossUrl, token, }) => {
        try {
            const ws = wm().getWorkspaceById(id);
            if (!ws)
                return { success: false, error: 'Workspace không tồn tại' };
            if (ws.type !== 'remote')
                return { success: false, error: 'Workspace này không phải remote' };
            // Persist updated connection params
            wm().updateWorkspace(id, { bossUrl, token });
            const result = await HttpConnectionManager_1.default.getInstance().connect(id, bossUrl, token);
            if (result.success) {
                // If this is the active workspace, update AppModeManager
                if (wm().getActiveWorkspaceId() === id) {
                    AppModeManager_1.default.getInstance().clearOverride();
                }
                // Notify renderer with status
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('workspace:connectionStatus', {
                        workspaceId: id, connected: true, latency: 0,
                    });
                }
            }
            return result;
        }
        catch (err) {
            Logger_1.default.error(`[workspaceIpc] connectRemote error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Disconnect Remote Workspace ─────────────────────────────────
    electron_1.ipcMain.handle('workspace:disconnectRemote', async (_e, { id }) => {
        try {
            HttpConnectionManager_1.default.getInstance().disconnect(id);
            return { success: true };
        }
        catch (err) {
            Logger_1.default.error(`[workspaceIpc] disconnectRemote error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    // ─── Get Connection Status for a workspace ────────────────────────
    electron_1.ipcMain.handle('workspace:getConnectionStatus', async (_e, { id }) => {
        try {
            const status = HttpConnectionManager_1.default.getInstance().getStatus(id);
            return { success: true, ...status };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Get All Connection Statuses ────────────────────────────────
    electron_1.ipcMain.handle('workspace:getAllStatuses', async () => {
        try {
            const statuses = HttpConnectionManager_1.default.getInstance().getAllStatuses();
            return { success: true, statuses };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    // ─── Remote Login (Employee → Boss authentication) ──────────────
    electron_1.ipcMain.handle('workspace:loginRemote', async (_e, { bossUrl, username, password, }) => {
        try {
            // Normalize URL
            let url = bossUrl.trim();
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = `http://${url}`;
            }
            // Remove trailing slash
            url = url.replace(/\/+$/, '');
            Logger_1.default.log(`[workspaceIpc] loginRemote → ${url}/api/auth/login (user: ${username})`);
            return await httpPost(`${url}/api/auth/login`, { username, password });
        }
        catch (err) {
            Logger_1.default.error(`[workspaceIpc] loginRemote error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}
//# sourceMappingURL=workspaceIpc.js.map