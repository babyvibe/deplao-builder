import { ipcMain, BrowserWindow } from 'electron';
import * as http from 'http';
import WorkspaceManager, { Workspace } from '../../src/utils/WorkspaceManager';
import AppModeManager from '../../src/utils/AppModeManager';
import DatabaseService from '../../src/services/DatabaseService';
import FileStorageService from '../../src/services/FileStorageService';
import HttpConnectionManager from '../../src/services/HttpConnectionManager';
import HttpRelayService from '../../src/services/HttpRelayService';
import ConnectionManager from '../../src/utils/ConnectionManager';
import EventBroadcaster from '../../src/services/EventBroadcaster';
import Logger from '../../src/utils/Logger';

/**
 * HTTP POST helper for remote login requests.
 */
function httpPost(url: string, body: any, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
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
            res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(responseBody));
                } catch {
                    reject(new Error('Phản hồi không hợp lệ từ boss server'));
                }
            });
        });

        req.on('error', (err: any) => {
            if (err.code === 'ECONNREFUSED') {
                reject(new Error('Không thể kết nối — kiểm tra lại IP và Port, đảm bảo boss đã bật Relay Server'));
            } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
                reject(new Error('Hết thời gian kết nối — kiểm tra lại mạng'));
            } else {
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
export function registerWorkspaceIpc(mainWindow: BrowserWindow | null): void {
    const wm = () => WorkspaceManager.getInstance();

    // ─── List ────────────────────────────────────────────────────────

    ipcMain.handle('workspace:list', async () => {
        try {
            const workspaces = wm().listWorkspaces();
            return { success: true, workspaces };
        } catch (err: any) {
            Logger.error(`[workspaceIpc] list error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Get Active ──────────────────────────────────────────────────

    ipcMain.handle('workspace:getActive', async () => {
        try {
            const workspace = wm().getActiveWorkspace();
            return { success: true, workspace };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Create ──────────────────────────────────────────────────────

    ipcMain.handle('workspace:create', async (_e, params: {
        name: string;
        type: 'local' | 'remote';
        icon?: string;
        bossUrl?: string;
        token?: string;
        employeeId?: string;
        employeeName?: string;
        autoConnect?: boolean;
        relayPort?: number;
    }) => {
        try {
            return wm().createWorkspace(params);
        } catch (err: any) {
            Logger.error(`[workspaceIpc] create error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Update ──────────────────────────────────────────────────────

    ipcMain.handle('workspace:update', async (_e, { id, updates }: {
        id: string;
        updates: Partial<Omit<Workspace, 'id' | 'createdAt'>>;
    }) => {
        try {
            return wm().updateWorkspace(id, updates);
        } catch (err: any) {
            Logger.error(`[workspaceIpc] update error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Delete ──────────────────────────────────────────────────────

    ipcMain.handle('workspace:delete', async (_e, { id }: { id: string }) => {
        try {
            // Record whether this is the currently active workspace BEFORE deleting
            const wasActive = wm().getActiveWorkspaceId() === id;

            const result = wm().deleteWorkspace(id);

            if (result.success && wasActive) {
                // WorkspaceManager already updated activeWorkspaceId to the first remaining.
                // Now we need to: switch DB + notify renderer (same as workspace:switch).
                const newActiveWs = wm().getActiveWorkspace();
                if (newActiveWs) {
                    AppModeManager.getInstance().clearOverride();
                    const newDbPath = wm().resolveDbPath(newActiveWs.dbPath || 'deplao-tool.db');
                    await DatabaseService.getInstance().switchToWorkspaceDb(newDbPath);
                    FileStorageService.resetBaseDir();

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('workspace:switched', {
                            workspace: newActiveWs,
                        });
                    }
                    Logger.log(`[workspaceIpc] Deleted active workspace → switched to "${newActiveWs.name}"`);
                }
            }

            return result;
        } catch (err: any) {
            Logger.error(`[workspaceIpc] delete error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Switch ──────────────────────────────────────────────────────

    ipcMain.handle('workspace:switch', async (_e, { id }: { id: string }) => {
        const prevWorkspaceId = wm().getActiveWorkspaceId();
        try {
            const result = wm().switchWorkspace(id);
            if (result.success && result.workspace) {
                // Clear AppModeManager override so it derives mode from workspace
                AppModeManager.getInstance().clearOverride();

                // Flush pending DB writes before switching
                DatabaseService.getInstance().forceFlush();

                // Clear event hooks to prevent accumulation across switches
                EventBroadcaster.clearBeforeSendHooks();

                // Switch DatabaseService to the new workspace's DB
                const newDbPath = wm().resolveDbPath(result.workspace.dbPath || 'deplao-tool.db');
                await DatabaseService.getInstance().switchToWorkspaceDb(newDbPath);

                // Reset FileStorageService cache so media resolves to the new workspace's folder
                FileStorageService.resetBaseDir();

                // Re-hook HttpRelayService into EventBroadcaster (clearBeforeSendHooks removed them)
                try {
                    const relay = HttpRelayService.getInstance();
                    if (relay.getStatus().running) {
                        relay.hookEventBroadcaster();
                    }
                } catch {}

                // Sync latest cookies from active ConnectionManager connections into the newly loaded DB
                // (Zalo may have refreshed cookies while boss was on a different workspace)
                try {
                    const db = DatabaseService.getInstance();
                    for (const [zaloId, conn] of ConnectionManager.getAllConnections()) {
                        if (conn.auth) {
                            const authObj = typeof conn.auth === 'string' ? JSON.parse(conn.auth) : conn.auth;
                            if (authObj?.cookies) {
                                db.run(
                                    `UPDATE accounts SET cookies = ?, imei = ?, user_agent = ? WHERE zalo_id = ?`,
                                    [authObj.cookies, authObj.imei || '', authObj.userAgent || '', zaloId]
                                );
                            }
                        }
                    }
                } catch (err: any) {
                    Logger.warn(`[workspaceIpc] Cookie sync from ConnectionManager failed: ${err.message}`);
                }

                Logger.log(`[workspaceIpc] switch → workspace=${result.workspace.id} name="${result.workspace.name}" type=${result.workspace.type} dbPath=${newDbPath} cachedAssigned=${result.workspace.cachedAssignedAccounts?.length || 0} cachedAccountsData=${result.workspace.cachedAccountsData?.length || 0} cachedPermissions=${result.workspace.cachedPermissions?.length || 0}`);

                // ── Auto-reconnect for remote workspaces ─────────
                if (result.workspace.type === 'remote' && result.workspace.bossUrl && result.workspace.token) {
                    const scm = HttpConnectionManager.getInstance();
                    if (!scm.isConnected(id)) {
                        Logger.log(`[workspaceIpc] Remote workspace "${result.workspace.name}" not connected — auto-reconnecting...`);
                        try {
                            await scm.connect(id, result.workspace.bossUrl, result.workspace.token);
                        } catch (err: any) {
                            Logger.warn(`[workspaceIpc] Auto-reconnect failed for "${result.workspace!.name}": ${err.message}`);
                        }
                    } else {
                        Logger.log(`[workspaceIpc] Remote workspace "${result.workspace.name}" already connected`);
                    }
                    // Merge snapshot data into workspace object so renderer gets it in ONE event
                    const snapshot = scm.getSnapshot(id);
                    if (snapshot) {
                        (result.workspace as any)._connected = true;
                        (result.workspace as any)._snapshot = snapshot;
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
        } catch (err: any) {
            try {
                const currentActiveId = wm().getActiveWorkspaceId();
                if (currentActiveId === id && prevWorkspaceId && prevWorkspaceId !== id) {
                    wm().restoreActiveWorkspace(prevWorkspaceId);
                }
            } catch { /* ignore rollback helper failure */ }
            const msg = err?.message || String(err) || 'Unknown switch error';
            Logger.error(`[workspaceIpc] switch error: ${msg}`, err);
            return { success: false, error: msg };
        }
    });

    // ─── Is Multi-Workspace ──────────────────────────────────────────

    ipcMain.handle('workspace:isMulti', async () => {
        return { isMulti: wm().isMultiWorkspace() };
    });

    // ─── Get DB Path for workspace ───────────────────────────────────

    ipcMain.handle('workspace:getDbPath', async (_e, { id }: { id: string }) => {
        try {
            const ws = wm().getWorkspaceById(id);
            if (!ws) return { success: false, error: 'Workspace not found' };
            const dbPath = wm().resolveDbPath(ws.dbPath || 'deplao-tool.db');
            return { success: true, dbPath };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Connect Remote Workspace ────────────────────────────────────

    ipcMain.handle('workspace:connectRemote', async (_e, {
        id, bossUrl, token,
    }: { id: string; bossUrl: string; token: string }) => {
        try {
            const ws = wm().getWorkspaceById(id);
            if (!ws) return { success: false, error: 'Workspace không tồn tại' };
            if (ws.type !== 'remote') return { success: false, error: 'Workspace này không phải remote' };

            // Persist updated connection params
            wm().updateWorkspace(id, { bossUrl, token });

            const result = await HttpConnectionManager.getInstance().connect(id, bossUrl, token);
            if (result.success) {
                // If this is the active workspace, update AppModeManager
                if (wm().getActiveWorkspaceId() === id) {
                    AppModeManager.getInstance().clearOverride();
                }
                // Notify renderer with status
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('workspace:connectionStatus', {
                        workspaceId: id, connected: true, latency: 0,
                    });
                }
            }
            return result;
        } catch (err: any) {
            Logger.error(`[workspaceIpc] connectRemote error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Disconnect Remote Workspace ─────────────────────────────────

    ipcMain.handle('workspace:disconnectRemote', async (_e, { id }: { id: string }) => {
        try {
            HttpConnectionManager.getInstance().disconnect(id);
            return { success: true };
        } catch (err: any) {
            Logger.error(`[workspaceIpc] disconnectRemote error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Get Connection Status for a workspace ────────────────────────

    ipcMain.handle('workspace:getConnectionStatus', async (_e, { id }: { id: string }) => {
        try {
            const status = HttpConnectionManager.getInstance().getStatus(id);
            return { success: true, ...status };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Get All Connection Statuses ────────────────────────────────

    ipcMain.handle('workspace:getAllStatuses', async () => {
        try {
            const statuses = HttpConnectionManager.getInstance().getAllStatuses();
            return { success: true, statuses };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Remote Login (Employee → Boss authentication) ──────────────

    ipcMain.handle('workspace:loginRemote', async (_e, {
        bossUrl, username, password,
    }: { bossUrl: string; username: string; password: string }) => {
        try {
            // Normalize URL
            let url = bossUrl.trim();
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = `http://${url}`;
            }
            // Remove trailing slash
            url = url.replace(/\/+$/, '');

            Logger.log(`[workspaceIpc] loginRemote → ${url}/api/auth/login (user: ${username})`);

            return await httpPost(`${url}/api/auth/login`, { username, password });
        } catch (err: any) {
            Logger.error(`[workspaceIpc] loginRemote error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

