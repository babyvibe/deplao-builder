import axios from 'axios';
import { ipcMain, BrowserWindow } from 'electron';
import LoginService from '../../src/services/login/LoginService';
import DatabaseService from '../../src/services/database/DatabaseService';
import ConnectionManager from '../../src/utils/ConnectionManager';
import FacebookConnectionManager from '../../src/utils/FacebookConnectionManager';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import Logger from '../../src/utils/Logger';
import ZaloLoginHelper from '../../src/utils/ZaloLoginHelper';
import * as TelegramUserListener from '../../src/services/telegram/TelegramUserListener';
import * as TelegramBotChannelService from '../../src/services/telegram/TelegramBotChannelService';
import { applyZaloBusinessFlag } from '../../src/utils/zaloBusinessFlag';
import { signOutFacebookAccount } from './facebookIpc';
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
    ipcMain.handle('login:qr', async (_event, { tempId, proxyId }) => {
        try {
            console.log(`[loginIpc] Starting QR login for tempId: ${tempId}`);
            loginService.loginQR(tempId, proxyId ?? null).catch((err) => {
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
    ipcMain.handle('login:auth', async (_event, { authJson, proxyId }) => {
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
            const accountInfo = await loginService.loginCookies(imei, cookies, userAgent, proxyId ?? null);

            // Tìm zaloId từ ConnectionManager
            let zaloId = '';
            const cookiesB64 = Buffer.from(cookies).toString('base64');
            for (const [id, conn] of ConnectionManager.getAllConnections()) {
                if (conn.authKey === cookiesB64) { zaloId = id; break; }
            }

            if (zaloId) {
                const fullName = accountInfo?.profile?.displayName || accountInfo?.name || '';
                const phoneNum = accountInfo?.profile?.phoneNumber || accountInfo?.phoneNumber || '';
                DatabaseService.getInstance().saveAccount({
                    zalo_id: zaloId,
                    full_name: fullName,
                    avatar_url: accountInfo?.profile?.avatar || accountInfo?.avatar || '',
                    phone: phoneNum,
                    imei,
                    user_agent: userAgent,
                    cookies,
                    is_active: 1,
                    created_at: new Date().toISOString(),
                });
                // Gắn proxy nếu có
                if (proxyId) {
                    DatabaseService.getInstance().setAccountProxy(zaloId, proxyId);
                }
                // Cờ Zalo Business đọc từ hồ sơ vừa lấy (không đọc được thì giữ giá trị đang lưu)
                applyZaloBusinessFlag(zaloId, accountInfo);
                DatabaseService.getInstance().setListenerActive(zaloId, true);
                postLoginSetup(zaloId, mainWindow, fullName, phoneNum);
            }

            return { success: true, accountInfo, zaloId };
        } catch (error: any) {
            Logger.error(`[loginIpc] auth JSON login error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    // ─── Đăng nhập Cookies/IMEI (legacy - 3 ô) ───────────────────────────
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
                const fullName2 = accountInfo?.profile?.displayName || accountInfo?.name || '';
                const phoneNum2 = accountInfo?.profile?.phoneNumber || accountInfo?.phoneNumber || '';
                DatabaseService.getInstance().saveAccount({
                    zalo_id: zaloId,
                    full_name: fullName2,
                    avatar_url: accountInfo?.profile?.avatar || accountInfo?.avatar || '',
                    phone: phoneNum2,
                    imei,
                    user_agent: userAgent,
                    cookies,
                    is_active: 1,
                    created_at: new Date().toISOString(),
                });
                // Cờ Zalo Business đọc từ hồ sơ vừa lấy (không đọc được thì giữ giá trị đang lưu)
                applyZaloBusinessFlag(zaloId, accountInfo);
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
            const account = DatabaseService.getInstance().getAccounts().find((item: any) => item.zalo_id === zaloId);
            if (account?.channel === 'telegram_user') {
                TelegramUserListener.stopListener(zaloId);
            } else {
                await loginService.disconnectUser(zaloId);
            }
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
            TelegramUserListener.stopAllListeners();
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
                const isTelegramUser = (acc as any).channel === 'telegram_user';
                const isTelegramBot = (acc as any).channel === 'telegram_bot';
                // For FB: zalo_id = fbId, need UUID for connection manager lookup
                const fbUuid = isFB ? fbIdToUuid[acc.zalo_id] : undefined;
                const isTelegramConnected = isTelegramUser && TelegramUserListener.isConnected(acc.zalo_id);
                const isBotConnected = isTelegramBot && TelegramBotChannelService.isBotPolling(acc.zalo_id);
                return {
                    ...acc,
                    send2me_id: DatabaseService.getInstance().resolveMyDocumentsId(acc),
                    proxy_id: (acc as any).proxy_id ?? null,
                    listenerActive: !!(acc as any).listener_active,
                    isOnline: isFB
                        ? !!(fbUuid && FacebookConnectionManager.get(fbUuid)?.isConnected())
                        : isTelegramUser
                            ? isTelegramConnected
                            : isTelegramBot
                                ? isBotConnected
                                : ConnectionManager.isConnected(acc.zalo_id),
                    isConnected: isFB
                        ? !!(fbUuid && FacebookConnectionManager.get(fbUuid)?.isConnected())
                        : isTelegramUser
                            ? isTelegramConnected
                            : isTelegramBot
                                ? isBotConnected
                                : ConnectionManager.getConnection(acc.zalo_id) !== undefined,
                    // For FB accounts, zalo_id IS the facebook_id now - expose for display
                    ...(isFB ? { facebook_id: acc.zalo_id } : {}),
                };
            });
            return { success: true, accounts: accountsWithStatus };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Xoá tài khoản (có tuỳ chọn xoá hết dữ liệu) ─────────────────────────
    ipcMain.handle('login:removeAccount', async (_event, { zaloId, deleteData }) => {
        try {
            // Check nếu là Facebook account → cleanup qua FacebookConnectionManager
            const accounts = DatabaseService.getInstance().getAccounts();
            const account = accounts.find((a: any) => a.zalo_id === zaloId);
            const isFB = account?.channel === 'facebook';
            const isTelegramUser = account?.channel === 'telegram_user';
            const isTelegramBot = account?.channel === 'telegram_bot';

            if (isFB) {
                // Facebook: tìm fb_account UUID → đăng xuất (ngắt kết nối, xoá cookie + phiên trong fb_accounts — còn cookie
                // thô thì lần mở app sau tài khoản đã gỡ tự kết nối lại). Bảng FB do deleteAccountData xử lý khi xoá hết dữ liệu.
                const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(zaloId);
                if (fbAcc?.id) await signOutFacebookAccount(fbAcc.id);
            } else if (isTelegramUser) {
                // MTProto is independent from ConnectionManager. Stop the
                // live GramJS client before removing its local session.
                TelegramUserListener.stopListener(zaloId);
            } else if (isTelegramBot) {
                // Bot API cũng không thuộc ConnectionManager: dừng nhận tin của bot trước khi gỡ. Trước đây bot rơi vào
                // nhánh Zalo nên vẫn kéo tin cho tài khoản đã xoá tới lần mở app sau.
                TelegramBotChannelService.stopBot(zaloId);
            } else {
                // Zalo cleanup
                const ZaloLoginHelper = require('../../src/utils/ZaloLoginHelper').default;
                ZaloLoginHelper.markRemoved(zaloId);
                if (ConnectionManager.getConnection(zaloId)) {
                    await loginService.disconnectUser(zaloId);
                }
            }

            if (deleteData) {
                // Xoá toàn bộ dữ liệu DB + media
                DatabaseService.getInstance().deleteAccountData(zaloId);
                const FileStorageService = require('../../src/services/file/FileStorageService').default;
                FileStorageService.deleteAccountMedia(zaloId);
            } else {
                // Legacy: chỉ mark inactive
                DatabaseService.getInstance().deleteAccount(zaloId);
            }
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Lấy cấu hình auto-delete media cho tài khoản ──────────────────────
    ipcMain.handle('login:getMediaAutoDelete', async (_event, { zaloId }) => {
        try {
            const config = DatabaseService.getInstance().getMediaAutoDeleteConfig(zaloId);
            return { success: true, config };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Lưu cấu hình auto-delete media + chạy cleanup ngay ───────────────
    ipcMain.handle('login:setMediaAutoDelete', async (_event, { zaloId, enabled, days }) => {
        try {
            const config = { enabled, days: Math.max(1, days) };
            DatabaseService.getInstance().setMediaAutoDeleteConfig(zaloId, config);

            // Nếu enabled, chạy cleanup ngay lập tức
            if (enabled) {
                const FileStorageService = require('../../src/services/file/FileStorageService').default;
                const deleted = FileStorageService.cleanupOldMedia(zaloId, days);
                // R2 nhận việc (đang lưu media lên R2 + bật giải phóng ổ đĩa + tài khoản trong phạm vi): dọn chạy nền và chỉ
                // xoá bản trên máy của file đã có trên R2. Còn lại (kể cả R2 bật nhưng giữ file trên máy) dọn như trước.
                let viaR2 = false;
                try { viaR2 = !!require('../../src/services/cloudflare/media').handlesAccountMediaCleanup(zaloId); } catch { viaR2 = false; }
                const message = viaR2
                    ? 'Đã lưu cấu hình. Media đang được lưu lên Cloudflare R2: chỉ xoá bản trên máy của file đã có trên R2, chạy nền hằng ngày.'
                    : `Đã xoá ${deleted} thư mục media cũ. Cấu hình sẽ tự động chạy hàng ngày.`;
                return { success: true, config, cleanedDirs: deleted, message };
            }

            return { success: true, config };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Chạy cleanup media cho tất cả tài khoản (gọi từ scheduler) ────────
    ipcMain.handle('login:runAllMediaCleanup', async () => {
        try {
            const DatabaseService = require('../../src/services/database/DatabaseService').default;
            const FileStorageService = require('../../src/services/file/FileStorageService').default;
            const db = DatabaseService.getInstance();
            const accounts = db.getAccounts();
            const results: Array<{ zaloId: string; cleaned: number; config: any }> = [];

            for (const acc of accounts) {
                const config = db.getMediaAutoDeleteConfig(acc.zalo_id);
                if (config?.enabled && config.days > 0) {
                    const cleaned = FileStorageService.cleanupOldMedia(acc.zalo_id, config.days);
                    results.push({ zaloId: acc.zalo_id, cleaned, config });
                }
            }

            Logger.log(`[MediaCleanup] Ran cleanup for ${results.length} accounts`);
            return { success: true, results };
        } catch (error: any) {
            Logger.error(`[MediaCleanup] Error: ${error.message}`);
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
                // Only reconnect Zalo accounts — Telegram/FB have their own reconnect
                const ch = (acc as any).channel || 'zalo';
                if (ch !== 'zalo') continue;
                try {
                    const auth = {
                        imei: acc.imei,
                        cookies: acc.cookies,
                        userAgent: acc.user_agent,
                        proxyId: (acc as any).proxy_id ?? null,
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

    // ─── Check + refresh avatar cho tài khoản Zalo ───────────────────────
    // Kiểm tra avatar URL còn hạn không (HTTP HEAD). Nếu lỗi (403/etc) thì
    // gọi Zalo API fetchAccountInfo() để lấy URL mới + cập nhật DB.
    ipcMain.handle('login:checkAndRefreshAvatar', async (_event, { zaloId }) => {
        try {
            if (!zaloId) return { success: false, refreshed: false, error: 'Missing zaloId' };

            const conn = ConnectionManager.getConnection(zaloId);
            if (!conn || !conn.connected) {
                return { success: false, refreshed: false, reason: 'not_connected' };
            }

            // Đọc account từ DB để lấy avatar_url hiện tại
            const accounts = DatabaseService.getInstance().getAccounts();
            const account = accounts.find((a: any) => a.zalo_id === zaloId);
            if (!account) return { success: false, refreshed: false, error: 'Account not found' };

            const currentAvatarUrl: string = account.avatar_url || '';

            // Kiểm tra URL hiện tại nếu có
            if (currentAvatarUrl) {
                try {
                    const headResp = await axios.head(currentAvatarUrl, {
                        timeout: 5000,
                        validateStatus: () => true,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                    });
                    if (headResp.status === 200) {
                        Logger.log(`[AvatarCheck] ${zaloId}: avatar URL still valid (${currentAvatarUrl.substring(0, 60)}...)`);
                        return { success: true, refreshed: false };
                    }
                    Logger.log(`[AvatarCheck] ${zaloId}: avatar URL returned status ${headResp.status}, refreshing...`);
                } catch (headErr: any) {
                    Logger.log(`[AvatarCheck] ${zaloId}: avatar HEAD request failed (${headErr.message}), refreshing...`);
                }
            } else {
                Logger.log(`[AvatarCheck] ${zaloId}: no avatar URL on file, fetching...`);
            }

            // URL expired hoặc không có → gọi Zalo API để refresh
            const accountInfo = await conn.api.fetchAccountInfo();
            // Cờ Zalo Business cập nhật mỗi lần đọc được hồ sơ, không phụ thuộc avatar có đổi hay không
            applyZaloBusinessFlag(zaloId, accountInfo);
            const newAvatar = accountInfo?.profile?.avatar || (accountInfo as any)?.avatar || '';
            const newName = accountInfo?.profile?.displayName || (accountInfo as any)?.displayName || '';

            if (newAvatar && newAvatar !== currentAvatarUrl) {
                // Update DB với avatar + name mới
                const phone = accountInfo?.profile?.phoneNumber || (accountInfo as any)?.phoneNumber || '';
                DatabaseService.getInstance().updateAccountInfo(zaloId, phone, null, newAvatar, newName || undefined);

                Logger.log(`[AvatarCheck] ${zaloId}: refreshed avatar: ${newAvatar.substring(0, 60)}...${newName ? ', name: ' + newName : ''}`);
                return { success: true, refreshed: true, avatar_url: newAvatar, full_name: newName || undefined };
            }

            if (newAvatar && newAvatar === currentAvatarUrl) {
                // URL giống nhau nhưng bây giờ vẫn valid → chỉ update timestamp
                Logger.log(`[AvatarCheck] ${zaloId}: avatar unchanged, still valid`);
                return { success: true, refreshed: false };
            }

            // fetchAccountInfo trả về avatar rỗng
            Logger.warn(`[AvatarCheck] ${zaloId}: fetchAccountInfo returned empty avatar`);
            return { success: true, refreshed: false, reason: 'empty_avatar_response' };
        } catch (error: any) {
            Logger.error(`[AvatarCheck] ${zaloId}: error: ${error.message}`);
            return { success: false, refreshed: false, error: error.message };
        }
    });
}
