import { ipcMain, BrowserWindow } from 'electron';
import LoginService from '../../src/services/LoginService';
import DatabaseService from '../../src/services/DatabaseService';
import ConnectionManager from '../../src/utils/ConnectionManager';
import FacebookConnectionManager from '../../src/utils/FacebookConnectionManager';
import EventBroadcaster from '../../src/services/EventBroadcaster';
import Logger from '../../src/utils/Logger';
import ZaloLoginHelper from '../../src/utils/ZaloLoginHelper';
function postLoginSetup(_zaloId: string, _mainWindow: BrowserWindow | null, _name?: string, _phone?: string) {
    // No-op in open-source build.
}

export function registerLoginIpc(mainWindow: BrowserWindow | null) {
    const loginService = new LoginService();

    // Giữ callback để không thay đổi contract nội bộ của helper, nhưng không làm gì thêm.
    ZaloLoginHelper.setQRSuccessCallback((zaloId, _isNewAccount) => {
        postLoginSetup(zaloId, mainWindow);
    });


    // ─── Đăng nhập QR ─────────────────────────────────────────────────────
    ipcMain.handle('login:qr', async (_event, { tempId }) => {
        try {
            console.log(`[loginIpc] Starting QR login for tempId: ${tempId}`);
            loginService.loginQR(tempId).catch((err) => {
                console.error(`[loginIpc] QR login error: ${err.message}`);
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Abort QR (khi user muốn refresh thủ công) ────────────────────────
    ipcMain.handle('login:qr:abort', async (_event, { tempId }) => {
        try {
            const ZaloLoginHelper = require('../../src/utils/ZaloLoginHelper').default;
            ZaloLoginHelper.abortQR(tempId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Đăng nhập bằng JSON auth (1 ô paste) ────────────────────────────
    // Format: { "imei": "...", "cookies": "...", "userAgent": "..." }
    ipcMain.handle('login:auth', async (_event, { authJson }) => {
        try {
            if (!authJson) return { success: false, error: 'Thiếu auth JSON' };
            let parsed: any;
            try {
                parsed = typeof authJson === 'string' ? JSON.parse(authJson) : authJson;
            } catch {
                return { success: false, error: 'Auth JSON không hợp lệ' };
            }
            const { imei, cookies, userAgent } = parsed;
            if (!imei || !cookies || !userAgent) {
                return { success: false, error: 'Auth JSON thiếu trường: imei, cookies, hoặc userAgent' };
            }

            Logger.log(`[loginIpc] Starting auth JSON login...`);
            const accountInfo = await loginService.loginCookies(imei, cookies, userAgent);

            // Tìm zaloId từ ConnectionManager
            let zaloId = '';
            const cookiesB64 = Buffer.from(cookies).toString('base64');
            for (const [id, conn] of ConnectionManager.getAllConnections()) {
                if (conn.authKey === cookiesB64) { zaloId = id; break; }
            }

            if (zaloId) {
                const bizPkgId = accountInfo?.profile?.bizPkg?.pkgId ?? accountInfo?.bizPkg?.pkgId ?? 0;
                const fullName = accountInfo?.profile?.displayName || accountInfo?.name || '';
                const phoneNum = accountInfo?.profile?.phoneNumber || accountInfo?.phoneNumber || '';
                DatabaseService.getInstance().saveAccount({
                    zalo_id: zaloId,
                    full_name: fullName,
                    avatar_url: accountInfo?.profile?.avatar || accountInfo?.avatar || '',
                    phone: phoneNum,
                    is_business: bizPkgId > 0 ? 1 : 0,
                    imei,
                    user_agent: userAgent,
                    cookies,
                    is_active: 1,
                    created_at: new Date().toISOString(),
                });
                DatabaseService.getInstance().setListenerActive(zaloId, true);
                postLoginSetup(zaloId, mainWindow, fullName, phoneNum);
            }

            return { success: true, accountInfo, zaloId };
        } catch (error: any) {
            Logger.error(`[loginIpc] auth JSON login error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    // ─── Đăng nhập Cookies/IMEI (legacy — 3 ô) ───────────────────────────
    ipcMain.handle('login:cookies', async (_event, { imei, cookies, userAgent }) => {
        try {
            if (!imei || !cookies || !userAgent) {
                return { success: false, error: 'Thiếu thông tin đăng nhập (imei, cookies, userAgent)' };
            }

            Logger.log(`[loginIpc] Starting cookies login...`);
            const accountInfo = await loginService.loginCookies(imei, cookies, userAgent);

            const connection = ConnectionManager.getAllConnections();
            let zaloId = '';
            for (const [id, conn] of connection) {
                const authKey = Buffer.from(cookies).toString('base64');
                if (conn.authKey === authKey) {
                    zaloId = id;
                    break;
                }
            }

            if (zaloId) {
                const bizPkgId2 = accountInfo?.profile?.bizPkg?.pkgId ?? accountInfo?.bizPkg?.pkgId ?? 0;
                const fullName2 = accountInfo?.profile?.displayName || accountInfo?.name || '';
                const phoneNum2 = accountInfo?.profile?.phoneNumber || accountInfo?.phoneNumber || '';
                DatabaseService.getInstance().saveAccount({
                    zalo_id: zaloId,
                    full_name: fullName2,
                    avatar_url: accountInfo?.profile?.avatar || accountInfo?.avatar || '',
                    phone: phoneNum2,
                    is_business: bizPkgId2 > 0 ? 1 : 0,
                    imei,
                    user_agent: userAgent,
                    cookies,
                    is_active: 1,
                    created_at: new Date().toISOString(),
                });
                DatabaseService.getInstance().setListenerActive(zaloId, true);
                postLoginSetup(zaloId, mainWindow, fullName2, phoneNum2);
            }

            return { success: true, accountInfo, zaloId };
        } catch (error: any) {
            Logger.error(`[loginIpc] Cookies login error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    // ─── Kết nối lại tài khoản (reconnect) ───────────────────────────────
    ipcMain.handle('login:connect', async (_event, { auth }) => {
        // Tìm zaloId từ cookies để có thể mark listener_active khi thất bại
        let zaloId = '';
        try {
            const cookiesB64 = Buffer.from(auth?.cookies || '').toString('base64');
            for (const [id, conn] of ConnectionManager.getAllConnections()) {
                if (conn.authKey === cookiesB64) { zaloId = id; break; }
            }
            // Nếu chưa có trong ConnectionManager, thử lấy từ DB
            if (!zaloId && auth?.cookies) {
                const accounts = DatabaseService.getInstance().getAccounts();
                const match = accounts.find((a: any) => a.cookies === auth.cookies);
                if (match) zaloId = match.zalo_id;
            }
        } catch {}


        try {
            const success = await loginService.connectUser(auth);
            if (!success && zaloId) {
                DatabaseService.getInstance().setListenerActive(zaloId, false);
                EventBroadcaster.broadcastListenerDead(zaloId, 'connect_failed');
            }
            return { success };
        } catch (error: any) {
            Logger.error(`[loginIpc] connect error: ${error.message}`);
            if (zaloId) {
                DatabaseService.getInstance().setListenerActive(zaloId, false);
                EventBroadcaster.broadcastListenerDead(zaloId, 'connect_error');
            }
            return { success: false, error: error.message };
        }
    });

    // ─── Ngắt kết nối tài khoản ───────────────────────────────────────────
    ipcMain.handle('login:disconnect', async (_event, { zaloId }) => {
        try {
            await loginService.disconnectUser(zaloId);
            return { success: true };
        } catch (error: any) {
            Logger.error(`[loginIpc] disconnect error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    // ─── Ngắt kết nối tất cả ─────────────────────────────────────────────
    ipcMain.handle('login:disconnectAll', async () => {
        try {
            const connections = ConnectionManager.getAllConnections();
            for (const zaloId of connections.keys()) {
                await loginService.disconnectUser(zaloId);
            }
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Lấy danh sách tài khoản đã lưu ──────────────────────────────────
    ipcMain.handle('login:getAccounts', async () => {
        try {
            const accounts = DatabaseService.getInstance().getAccounts();
            // Build FB account lookup (fbId → uuid) for connection status checks
            let fbIdToUuid: Record<string, string> = {};
            try {
                const fbAccounts = DatabaseService.getInstance().getFBAccounts();
                for (const fb of fbAccounts) {
                    if (fb.facebook_id && fb.id) fbIdToUuid[fb.facebook_id] = fb.id;
                }
            } catch {}
            // Thêm trạng thái online/offline
            const accountsWithStatus = accounts.map((acc) => {
                const isFB = (acc as any).channel === 'facebook';
                // For FB: zalo_id = fbId, need UUID for connection manager lookup
                const fbUuid = isFB ? fbIdToUuid[acc.zalo_id] : undefined;
                return {
                    ...acc,
                    isOnline: isFB
                        ? !!(fbUuid && FacebookConnectionManager.get(fbUuid)?.isConnected())
                        : ConnectionManager.isConnected(acc.zalo_id),
                    isConnected: isFB
                        ? !!(fbUuid && FacebookConnectionManager.get(fbUuid)?.isConnected())
                        : ConnectionManager.getConnection(acc.zalo_id) !== undefined,
                    // For FB accounts, zalo_id IS the facebook_id now — expose for display
                    ...(isFB ? { facebook_id: acc.zalo_id } : {}),
                };
            });
            return { success: true, accounts: accountsWithStatus };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Xóa tài khoản ────────────────────────────────────────────────────
    ipcMain.handle('login:removeAccount', async (_event, { zaloId }) => {
        try {
            const ZaloLoginHelper = require('../../src/utils/ZaloLoginHelper').default;
            // Đánh dấu trước khi ngắt — ngăn auto-reconnect khi listener nhận close event
            ZaloLoginHelper.markRemoved(zaloId);

            // Disconnect
            if (ConnectionManager.getConnection(zaloId)) {
                await loginService.disconnectUser(zaloId);
            }
            // Mark as inactive in DB
            DatabaseService.getInstance().deleteAccount(zaloId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Kiểm tra sức khỏe listener (WebSocket readyState) ──────────────
    // Gọi từ client mỗi 1 phút (heartbeat) hoặc sau khi reconnect mạng
    // Hỗ trợ batch: zaloIds có thể là string hoặc string[]
    ipcMain.handle('login:checkHealth', async (_event, { zaloIds }) => {
        try {
            const ids: string[] = Array.isArray(zaloIds) ? zaloIds : [zaloIds];
            const results = ConnectionManager.checkListenerHealth(ids);
            return { success: true, results };
        } catch (error: any) {
            Logger.error(`[loginIpc] checkHealth error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    // ─── Khởi động lại tất cả tài khoản đã lưu ───────────────────────────
    ipcMain.handle('login:reconnectAll', async () => {
        try {
            const accounts = DatabaseService.getInstance().getAccounts();
            const results = [];

            for (const acc of accounts) {
                try {
                    const auth = {
                        imei: acc.imei,
                        cookies: acc.cookies,
                        userAgent: acc.user_agent,
                    };
                    await loginService.connectUser(auth);
                    results.push({ zaloId: acc.zalo_id, success: true });
                } catch (err: any) {
                    results.push({ zaloId: acc.zalo_id, success: false, error: err.message });
                }
            }

            return { success: true, results };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Tải tin nhắn cũ của phiên đăng nhập (requestOldMessages) ────────
    // Gọi listener.requestOldMessages cho cả User và Group threads
    ipcMain.handle('login:requestOldMessages', async (_event, { zaloId }) => {
        try {
            const conn = ConnectionManager.getConnection(zaloId);
            if (!conn || !conn.connected) {
                return { success: false, error: 'Tài khoản không online' };
            }
            const { ThreadType } = await import('zca-js');
            conn.api.listener.requestOldMessages(ThreadType.User, null);
            conn.api.listener.requestOldMessages(ThreadType.Group, null);
            Logger.log(`[loginIpc] requestOldMessages triggered for ${zaloId}`);
            return { success: true };
        } catch (error: any) {
            Logger.error(`[loginIpc] requestOldMessages error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });
}

