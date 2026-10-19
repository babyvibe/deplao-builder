import { ipcMain, BrowserWindow, safeStorage } from 'electron';
import * as http from 'http';
import * as https from 'https';
import WorkspaceManager, { Workspace } from '../../src/utils/WorkspaceManager';
import AppModeManager from '../../src/utils/AppModeManager';
import DatabaseService from '../../src/services/database/DatabaseService';
import FileStorageService from '../../src/services/file/FileStorageService';
import HttpConnectionManager from '../../src/services/http/HttpConnectionManager';
import HttpRelayService from '../../src/services/http/HttpRelayService';
import ConnectionManager from '../../src/utils/ConnectionManager';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import Logger from '../../src/utils/Logger';
import { credentialsChanged, isWrongPasswordLogin, normalizeBossUrl } from '../../src/shared/employeeConnection';

/**
 * Tạm dừng đồng bộ DB lên Cloudflare quanh thao tác đổi / xoá file DB của workspace (dbsync nhả file trước, kiểm tra
 * lại DB sau). Không nạp được module (hoặc đồng bộ đang tắt) → chạy thẳng.
 */
function withCloudDbPaused<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    let cloudDb: { pauseFor<R>(reason: string, fn: () => Promise<R> | R): Promise<R> } | null = null;
    try {
        cloudDb = (require('../../src/services/cloudflare/dbsync') as typeof import('../../src/services/cloudflare/dbsync')).cloudDb;
    } catch {
        cloudDb = null;
    }
    return cloudDb ? cloudDb.pauseFor(reason, fn) : fn();
}

/** employee_id trong payload JWT (không verify — Boss đã verify khi cấp token). */
function employeeIdFromToken(token: string): string | null {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64').toString());
        return payload?.employee_id ? String(payload.employee_id) : null;
    } catch {
        return null;
    }
}

/**
 * HTTP/HTTPS POST helper for remote login requests.
 * Automatically uses https module for https:// URLs.
 * Adds bypass-tunnel-reminder header for loca.lt tunnels.
 */
function httpPost(url: string, body: any, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error('URL không hợp lệ'));
            return;
        }
        const data = JSON.stringify(body);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;
        const isTunnel = parsed.hostname.includes('loca.lt') ||
                         parsed.hostname.includes('localtunnel') ||
                         parsed.hostname.includes('ngrok') ||
                         parsed.hostname.includes('serveo');

        const req = (transport as typeof https).request({
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? '443' : '80'),
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...(isTunnel ? { 'bypass-tunnel-reminder': 'true' } : {}),
            },
            timeout: timeoutMs,
        }, (res) => {
            let responseBody = '';
            res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(responseBody));
                } catch {
                    // HTML interstitial or non-JSON response
                    const preview = responseBody.slice(0, 200);
                    reject(new Error(`Phản hồi không hợp lệ từ boss server: ${preview}`));
                }
            });
        });

        req.on('error', (err: any) => {
            if (err.code === 'ECONNREFUSED') {
                reject(new Error('Không thể kết nối - kiểm tra lại IP và Port, đảm bảo boss đã bật Relay Server'));
            } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
                reject(new Error('Hết thời gian kết nối - kiểm tra lại mạng'));
            } else {
                reject(new Error(`Lỗi kết nối: ${err.message}`));
            }
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Hết thời gian kết nối (${timeoutMs / 1000}s) - kiểm tra lại địa chỉ Boss`));
        });

        req.write(data);
        req.end();
    });
}

/** Đăng nhập nhân viên vào Boss (POST /api/auth/login) — dùng chung cho loginRemote và loginRemoteSaved. */
async function loginToBoss(bossUrl: string, username: string, password: string): Promise<any> {
    try {
        // Normalize URL
        let url = String(bossUrl || '').trim();
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
}

// ─── Mật khẩu nhân viên đã lưu (safeStorage) ────────────────────────

/** Mã hoá được bằng khoá của hệ điều hành (Windows DPAPI / macOS Keychain / Linux keyring) — không thì không lưu. */
function canEncryptPasswords(): boolean {
    try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        // Linux không có keyring → Electron dùng khoá cố định ('basic_text') — coi như không mã hoá được
        if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
        return true;
    } catch {
        return false;
    }
}

/** Boss lưu username chữ thường (EmployeeService) → so khớp không phân biệt hoa thường. */
function normalizeUsername(value: unknown): string {
    return String(value ?? '').toLowerCase().trim();
}

/**
 * registerWorkspaceIpc - IPC handlers for Workspace CRUD + switching.
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
            const before = wm().getWorkspaceById(id);
            const prevCreds = before ? { bossUrl: before.bossUrl, token: before.token } : null;
            const result = wm().updateWorkspace(id, updates);
            // Đổi Boss URL / token của remote workspace → main báo renderer (employee:credentials)
            // và kết nối lại bằng cấu hình mới nếu đang giữ kết nối — REST client không bao giờ lệch main.
            if (result.success && before?.type === 'remote' && updates && ('bossUrl' in updates || 'token' in updates)) {
                const after = wm().getWorkspaceById(id);
                if (after && credentialsChanged(prevCreds, { bossUrl: after.bossUrl, token: after.token })) {
                    HttpConnectionManager.getInstance().onCredentialsChanged(id);
                }
            }
            return result;
        } catch (err: any) {
            Logger.error(`[workspaceIpc] update error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Delete ──────────────────────────────────────────────────────

    ipcMain.handle('workspace:delete', async (_e, { id }: { id: string }) => withCloudDbPaused('workspace-delete', async () => {
        try {
            // Record whether this is the currently active workspace BEFORE deleting
            const wasActive = wm().getActiveWorkspaceId() === id;
            const wasRemote = wm().getWorkspaceById(id)?.type === 'remote';

            const result = wm().deleteWorkspace(id);

            // Xoá remote workspace = ngắt hẳn kết nối tới Boss (heartbeat + Socket.IO + lịch thử lại)
            if (result.success && wasRemote) {
                try { HttpConnectionManager.getInstance().disconnect(id); } catch { /* ignore */ }
            }

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
    }));

    // ─── Switch ──────────────────────────────────────────────────────

    ipcMain.handle('workspace:switch', async (_e, { id }: { id: string }) => withCloudDbPaused('workspace-switch', async () => {
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

                // Public API v1: đăng ký lại hook sự kiện (clearBeforeSendHooks đã xoá)
                try {
                    require('../../src/services/api/ApiPlatform').default.getInstance().rehookEvents();
                } catch {}

                // Workflow: đăng ký lại hook trigger (tin nhắn, thanh toán…) — thiếu bước này workflow ngừng chạy tới khi mở lại app
                try {
                    require('../../src/services/workflow/WorkflowEngineService').default.getInstance().rehookEvents();
                } catch (err: any) {
                    Logger.error(`[workspaceIpc] Workflow rehookEvents failed: ${err?.message || err}`);
                }

                // Plugin: dừng plugin của workspace cũ, chạy plugin đã bật của workspace mới (nền).
                try {
                    void require('../../src/services/plugins/PluginsPlatform').default.getInstance().onWorkspaceChanged();
                } catch {}

                // Sync latest cookies from active ConnectionManager connections into the newly loaded DB
                // (Zalo may have refreshed cookies while boss was on a different workspace)
                try {
                    const db = DatabaseService.getInstance();
                    for (const [zaloId, conn] of ConnectionManager.getAllConnections()) {
                        if (conn.auth) {
                            const authObj = typeof conn.auth === 'string' ? JSON.parse(conn.auth) : conn.auth;
                            if (authObj?.cookies) {
                                // Mã hoá như saveAccount (trước đây ghi cookie thô)
                                db.updateAccountAuth(zaloId, authObj.cookies, authObj.imei || '', authObj.userAgent || '');
                            }
                        }
                    }
                } catch (err: any) {
                    Logger.warn(`[workspaceIpc] Cookie sync from ConnectionManager failed: ${err.message}`);
                }

                Logger.log(`[workspaceIpc] switch → workspace=${result.workspace.id} name="${result.workspace.name}" type=${result.workspace.type} dbPath=${newDbPath} cachedAssigned=${result.workspace.cachedAssignedAccounts?.length || 0} cachedAccountsData=${result.workspace.cachedAccountsData?.length || 0} cachedPermissions=${result.workspace.cachedPermissions?.length || 0}`);

                // Bản sao để gửi renderer: KHÔNG gắn _connected/_snapshot vào object cấu hình
                // (object đó được saveConfig() ghi xuống workspaces.json).
                const switchedWorkspace: any = { ...result.workspace };

                // ── Auto-reconnect for remote workspaces ─────────
                if (result.workspace.type === 'remote' && result.workspace.bossUrl && result.workspace.token) {
                    const scm = HttpConnectionManager.getInstance();
                    if (!scm.isConnected(id)) {
                        Logger.log(`[workspaceIpc] Remote workspace "${result.workspace.name}" not connected - auto-reconnecting...`);
                        try {
                            // Đang kết nối dở (auto-connect / thử lại) → dùng chung lần đó
                            await scm.connect(id, result.workspace.bossUrl, result.workspace.token);
                        } catch (err: any) {
                            Logger.warn(`[workspaceIpc] Auto-reconnect failed for "${result.workspace!.name}": ${err.message}`);
                        }
                    } else {
                        Logger.log(`[workspaceIpc] Remote workspace "${result.workspace.name}" already connected`);
                    }
                    // Merge snapshot data into workspace object so renderer gets it in ONE event
                    // _connected reflects ACTUAL connection status, not snapshot existence
                    const snapshot = scm.getSnapshot(id);
                    const status = scm.getStatus(id);
                    switchedWorkspace._connected = status.connected;
                    switchedWorkspace._authExpired = status.authExpired;
                    if (snapshot) {
                        switchedWorkspace._snapshot = snapshot;
                    }
                }

                // Notify renderer to reload state (renderer init RestQueryService từ URL/token trong payload này)
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('workspace:switched', {
                        workspace: switchedWorkspace,
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
    }));

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

    // Đường DUY NHẤT để (đăng nhập lại rồi) kết nối: lưu CẢ URL lẫn token vào cấu hình workspace
    // (nguồn sự thật) rồi kết nối qua main → main phát employee:credentials → renderer init REST.
    ipcMain.handle('workspace:connectRemote', async (_e, {
        id, bossUrl, token,
    }: { id: string; bossUrl: string; token: string }) => {
        try {
            const ws = wm().getWorkspaceById(id);
            if (!ws) return { success: false, error: 'Workspace không tồn tại' };
            if (ws.type !== 'remote') return { success: false, error: 'Workspace này không phải remote' };

            const url = normalizeBossUrl(bossUrl);
            if (!url || !token) return { success: false, error: 'Thiếu địa chỉ Boss hoặc token' };

            // Persist updated connection params
            const changed = credentialsChanged({ bossUrl: ws.bossUrl, token: ws.token }, { bossUrl: url, token });
            wm().updateWorkspace(id, { bossUrl: url, token });

            const scm = HttpConnectionManager.getInstance();
            // REST client theo cấu hình mới ngay cả khi lần kết nối này lỗi (main sẽ tự thử lại bằng cấu hình mới)
            if (changed) scm.emitCredentials(id, 'updated');

            const isActive = wm().getActiveWorkspaceId() === id;
            if (isActive) {
                const employeeId = employeeIdFromToken(token);
                if (employeeId) AppModeManager.getInstance().setEmployeeId(employeeId);
            }

            const result = await scm.connect(id, url, token);
            if (result.success) {
                // If this is the active workspace, update AppModeManager
                if (wm().getActiveWorkspaceId() === id) {
                    AppModeManager.getInstance().clearOverride();
                }
                // Trạng thái 'workspace:connectionStatus' do HttpConnectionManager phát (nguồn duy nhất)
            }
            return { success: result.success, error: result.error, authExpired: !!result.authExpired };
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

    // ─── Renderer báo mạng có lại (window 'online') → kiểm tra kết nối Boss ngay ──

    ipcMain.handle('workspace:networkOnline', async () => {
        try {
            HttpConnectionManager.getInstance().handleSystemEvent('network-online');
            return { success: true };
        } catch (err: any) {
            Logger.error(`[workspaceIpc] networkOnline error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Làm mới snapshot nhân viên (quyền + tài khoản được giao) — 403 ACCOUNT_FORBIDDEN / resync ──

    ipcMain.handle('workspace:refreshSnapshot', async (_e, { id, reason }: { id: string; reason?: string }) => {
        try {
            if (!id) return { success: false, error: 'Thiếu workspace id' };
            return await HttpConnectionManager.getInstance().refreshSnapshot(id, reason || 'renderer');
        } catch (err: any) {
            Logger.error(`[workspaceIpc] refreshSnapshot error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Remote Login (Employee → Boss authentication) ──────────────

    ipcMain.handle('workspace:loginRemote', async (_e, {
        bossUrl, username, password,
    }: { bossUrl: string; username: string; password: string }) => {
        return loginToBoss(bossUrl, username, password);
    });

    // ─── Mật khẩu nhân viên đã lưu ("Kết nối lại" không phải gõ lại) ──
    // Main giữ bản mã safeStorage trong workspaces.json, NGOÀI object Workspace (không theo workspace:list / getActive /
    // switched… sang renderer). Renderer chỉ biết có / không; mật khẩu không bao giờ quay lại renderer.

    ipcMain.handle('workspace:rememberPassword', async (_e, { id, password }: { id: string; password: string }) => {
        try {
            const ws = wm().getWorkspaceById(id);
            if (!ws || ws.type !== 'remote') return { success: false, error: 'Workspace không tồn tại' };
            if (typeof password !== 'string' || !password) return { success: false, error: 'Thiếu mật khẩu' };
            if (!canEncryptPasswords()) {
                // Không mã hoá được bằng khoá hệ điều hành → không lưu (bỏ cả bản cũ nếu có)
                wm().clearSavedPassword(id);
                Logger.warn('[workspaceIpc] safeStorage không khả dụng — không lưu mật khẩu nhân viên');
                return { success: true, saved: false };
            }
            const enc = safeStorage.encryptString(password).toString('base64');
            // Gắn với tên đăng nhập hiện tại của workspace (TopBar cập nhật employeeUsername trước khi gọi)
            wm().setSavedPassword(id, { enc, username: normalizeUsername(ws.employeeUsername), savedAt: Date.now() });
            return { success: true, saved: true };
        } catch (err: any) {
            Logger.error(`[workspaceIpc] rememberPassword error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('workspace:hasSavedPassword', async (_e, { id }: { id: string }) => {
        try {
            return { success: true, saved: !!wm().getSavedPassword(id) };
        } catch (err: any) {
            return { success: false, saved: false, error: err.message };
        }
    });

    ipcMain.handle('workspace:forgetPassword', async (_e, { id }: { id: string }) => {
        try {
            wm().clearSavedPassword(id);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // Đăng nhập bằng mật khẩu đã lưu: main giải mã rồi làm đúng như loginRemote (cùng dạng kết quả)
    ipcMain.handle('workspace:loginRemoteSaved', async (_e, {
        id, bossUrl, username,
    }: { id: string; bossUrl: string; username: string }) => {
        const unusable = (error: string, cleared = false) => ({
            success: false, error, code: 'NO_SAVED_PASSWORD', ...(cleared ? { savedPasswordCleared: true } : {}),
        });
        try {
            const ws = wm().getWorkspaceById(id);
            if (!ws || ws.type !== 'remote') return { success: false, error: 'Workspace không tồn tại' };
            const saved = wm().getSavedPassword(id);
            if (!saved) return unusable('Chưa lưu mật khẩu — vui lòng nhập mật khẩu');
            const user = normalizeUsername(username);
            if (!user) return { success: false, error: 'Vui lòng nhập tên đăng nhập' };
            if (saved.username && saved.username !== user) {
                return unusable('Mật khẩu đã lưu thuộc tài khoản khác — vui lòng nhập mật khẩu');
            }
            if (!canEncryptPasswords()) return unusable('Máy không giải mã được mật khẩu đã lưu — vui lòng nhập mật khẩu');
            let password = '';
            try {
                password = safeStorage.decryptString(Buffer.from(saved.enc, 'base64'));
            } catch {
                // Khoá hệ điều hành đã đổi (đổi tài khoản Windows, cài lại máy…) → bản mã vô dụng
                wm().clearSavedPassword(id);
                return unusable('Không đọc được mật khẩu đã lưu — vui lòng nhập lại', true);
            }
            const result = await loginToBoss(bossUrl, username, password);
            if (isWrongPasswordLogin(result)) {
                // Quản lý đã đổi mật khẩu → bỏ bản đã lưu, lần sau nhập mật khẩu mới
                wm().clearSavedPassword(id);
                return { ...result, savedPasswordCleared: true };
            }
            return result;
        } catch (err: any) {
            Logger.error(`[workspaceIpc] loginRemoteSaved error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

