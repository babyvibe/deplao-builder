import axios from 'axios';
import { ipcMain, BrowserWindow } from 'electron';
import LoginService from '../../../src/services/login/LoginService';
import DatabaseService from '../../../src/services/database/DatabaseService';
import ConnectionManager from '../../../src/utils/connection/ConnectionManager';
import FacebookConnectionManager from '../../../src/utils/connection/FacebookConnectionManager';
import EventBroadcaster from '../../../src/services/event/EventBroadcaster';
import Logger from '../../../src/utils/Logger';
import ZaloLoginHelper from '../../../src/utils/zalo/ZaloLoginHelper';
import * as TelegramUserListener from '../../../src/services/telegram/TelegramUserListener';
import * as TelegramBotChannelService from '../../../src/services/telegram/bot/TelegramBotChannelService';
import { applyZaloBusinessFlag } from '../../../src/utils/zalo/zaloBusinessFlag';
import { signOutFacebookAccount } from '../facebook/facebookIpc';
import { tr } from '../../../src/shared/i18n';
function postLoginSetup(_zaloId: string, _mainWindow: BrowserWindow | null, _name?: string, _phone?: string) {
    // No-op in open-source build.
}

export function registerLoginIpc(mainWindow: BrowserWindow | null) {
    const loginService = new LoginService();

    // Keep the callback so the helper's internal contract does not change, but do nothing more.
    ZaloLoginHelper.setQRSuccessCallback((zaloId, _isNewAccount) => {
        postLoginSetup(zaloId, mainWindow);
    });


    // ─── QR login ─────────────────────────────────────────────────────────
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

    // ─── Abort QR (when the user wants to refresh manually) ────────────────────────
    ipcMain.handle('login:qr:abort', async (_event, { tempId }) => {
        try {
            const ZaloLoginHelper = require('../../../src/utils/zalo/ZaloLoginHelper').default;
            ZaloLoginHelper.abortQR(tempId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Sign in with JSON auth (1 paste box) ────────────────────────────
    // Format: { "imei": "...", "cookies": "...", "userAgent": "..." }
    ipcMain.handle('login:auth', async (_event, { authJson, proxyId }) => {
        try {
            if (!authJson) return { success: false, error: tr('Thiếu auth JSON') };
            let parsed: any;
            try {
                parsed = typeof authJson === 'string' ? JSON.parse(authJson) : authJson;
            } catch {
                return { success: false, error: tr('Auth JSON không hợp lệ') };
            }
            const { imei, cookies, userAgent } = parsed;
            if (!imei || !cookies || !userAgent) {
                return { success: false, error: tr('Auth JSON thiếu trường: imei, cookies, hoặc userAgent') };
            }

            Logger.log(`[loginIpc] Starting auth JSON login...`);
            const accountInfo = await loginService.loginCookies(imei, cookies, userAgent, proxyId ?? null);

            // Find the zaloId from ConnectionManager
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
                // Attach the proxy if there is one
                if (proxyId) {
                    DatabaseService.getInstance().setAccountProxy(zaloId, proxyId);
                }
                // The Zalo Business flag is read from the profile just fetched (if it cannot be read, keep the saved value)
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

    // ─── Sign in with Cookies/IMEI (legacy - 3 boxes) ───────────────────────────
    ipcMain.handle('login:cookies', async (_event, { imei, cookies, userAgent }) => {
        try {
            if (!imei || !cookies || !userAgent) {
                return { success: false, error: tr('Thiếu thông tin đăng nhập (imei, cookies, userAgent)') };
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
                // The Zalo Business flag is read from the profile just fetched (if it cannot be read, keep the saved value)
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

    // ─── Reconnect an account (reconnect) ───────────────────────────────
    ipcMain.handle('login:connect', async (_event, { auth }) => {
        // Find the zaloId from the cookies so listener_active can be marked when it fails
        let zaloId = '';
        try {
            const cookiesB64 = Buffer.from(auth?.cookies || '').toString('base64');
            for (const [id, conn] of ConnectionManager.getAllConnections()) {
                if (conn.authKey === cookiesB64) { zaloId = id; break; }
            }
            // If it is not in ConnectionManager yet, try the DB
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

    // ─── Disconnect account ───────────────────────────────────────────────
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

    // ─── Disconnect all ─────────────────────────────────────────────
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

    // ─── Get the list of saved accounts ──────────────────────────────────
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
            // Add the online/offline status
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

    // ─── Delete account (optionally delete all data) ─────────────────────────
    ipcMain.handle('login:removeAccount', async (_event, { zaloId, deleteData }) => {
        try {
            // Check if it is a Facebook account → clean up through FacebookConnectionManager
            const accounts = DatabaseService.getInstance().getAccounts();
            const account = accounts.find((a: any) => a.zalo_id === zaloId);
            const isFB = account?.channel === 'facebook';
            const isTelegramUser = account?.channel === 'telegram_user';
            const isTelegramBot = account?.channel === 'telegram_bot';

            if (isFB) {
                // Facebook: find the fb_account UUID → sign out (disconnect, delete the cookie + session in fb_accounts; a raw cookie still
                // left behind would reconnect the removed account by itself the next time the app opens). The FB table is handled by deleteAccountData when all data is deleted.
                const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(zaloId);
                if (fbAcc?.id) await signOutFacebookAccount(fbAcc.id);
            } else if (isTelegramUser) {
                // MTProto is independent from ConnectionManager. Stop the
                // live GramJS client before removing its local session.
                TelegramUserListener.stopListener(zaloId);
            } else if (isTelegramBot) {
                // The Bot API is not in ConnectionManager either: stop receiving messages for the bot before removing it. Before, the bot fell into
                // the Zalo branch, so messages kept being pulled for the deleted account until the next app launch.
                TelegramBotChannelService.stopBot(zaloId);
            } else {
                // Zalo cleanup
                const ZaloLoginHelper = require('../../../src/utils/zalo/ZaloLoginHelper').default;
                ZaloLoginHelper.markRemoved(zaloId);
                if (ConnectionManager.getConnection(zaloId)) {
                    await loginService.disconnectUser(zaloId);
                }
            }

            if (deleteData) {
                // Delete all DB + media data
                DatabaseService.getInstance().deleteAccountData(zaloId);
                const FileStorageService = require('../../../src/services/file/FileStorageService').default;
                FileStorageService.deleteAccountMedia(zaloId);
            } else {
                // Legacy: only mark inactive
                DatabaseService.getInstance().deleteAccount(zaloId);
            }
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Get the auto-delete media config for the account ──────────────────────
    ipcMain.handle('login:getMediaAutoDelete', async (_event, { zaloId }) => {
        try {
            const config = DatabaseService.getInstance().getMediaAutoDeleteConfig(zaloId);
            return { success: true, config };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Save the auto-delete media config + run cleanup now ───────────────
    ipcMain.handle('login:setMediaAutoDelete', async (_event, { zaloId, enabled, days }) => {
        try {
            const config = { enabled, days: Math.max(1, days) };
            DatabaseService.getInstance().setMediaAutoDeleteConfig(zaloId, config);

            // If enabled, run the cleanup immediately
            if (enabled) {
                const FileStorageService = require('../../../src/services/file/FileStorageService').default;
                const deleted = FileStorageService.cleanupOldMedia(zaloId, days);
                // R2 takes over (media is being saved to R2 + freeing disk space is on + the account is in scope): cleanup runs in the background and only
                // deletes the on-machine copy of files that already exist on R2. Otherwise (including R2 on but keeping files on the machine), clean up as before.
                let viaR2 = false;
                try { viaR2 = !!require('../../../src/services/cloudflare/media').handlesAccountMediaCleanup(zaloId); } catch { viaR2 = false; }
                const message = viaR2
                    ? tr('Đã lưu cấu hình. Media đang được lưu lên Cloudflare R2: chỉ xoá bản trên máy của file đã có trên R2, chạy nền hằng ngày.')
                    : tr('Đã xoá {{deleted}} thư mục media cũ. Cấu hình sẽ tự động chạy hàng ngày.', { deleted });
                return { success: true, config, cleanedDirs: deleted, message };
            }

            return { success: true, config };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Run media cleanup for all accounts (called from the scheduler) ────────
    ipcMain.handle('login:runAllMediaCleanup', async () => {
        try {
            const DatabaseService = require('../../../src/services/database/DatabaseService').default;
            const FileStorageService = require('../../../src/services/file/FileStorageService').default;
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

    // ─── Listener health check (WebSocket readyState) ──────────────
    // Called from the client every 1 minute (heartbeat) or after a network reconnect
    // Batch support: zaloIds can be a string or string[]
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

    // ─── Restart all saved accounts ───────────────────────────────────────
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

    // ─── Check + refresh the avatar for Zalo accounts ───────────────────────
    // Check whether the avatar URL is still valid (HTTP HEAD). If it fails (403/etc) then
    // call the Zalo API fetchAccountInfo() to get the new URL + update the DB.
    ipcMain.handle('login:checkAndRefreshAvatar', async (_event, { zaloId }) => {
        try {
            if (!zaloId) return { success: false, refreshed: false, error: 'Missing zaloId' };

            const conn = ConnectionManager.getConnection(zaloId);
            if (!conn || !conn.connected) {
                return { success: false, refreshed: false, reason: 'not_connected' };
            }

            // Read the account from the DB to get the current avatar_url
            const accounts = DatabaseService.getInstance().getAccounts();
            const account = accounts.find((a: any) => a.zalo_id === zaloId);
            if (!account) return { success: false, refreshed: false, error: 'Account not found' };

            const currentAvatarUrl: string = account.avatar_url || '';

            // Check the current URL if there is one
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

            // URL expired or missing → call the Zalo API to refresh
            const accountInfo = await conn.api.fetchAccountInfo();
            // The Zalo Business flag is updated every time the profile is read, whether or not the avatar changed
            applyZaloBusinessFlag(zaloId, accountInfo);
            const newAvatar = accountInfo?.profile?.avatar || (accountInfo as any)?.avatar || '';
            const newName = accountInfo?.profile?.displayName || (accountInfo as any)?.displayName || '';

            if (newAvatar && newAvatar !== currentAvatarUrl) {
                // Update the DB with the new avatar + name
                const phone = accountInfo?.profile?.phoneNumber || (accountInfo as any)?.phoneNumber || '';
                DatabaseService.getInstance().updateAccountInfo(zaloId, phone, null, newAvatar, newName || undefined);

                Logger.log(`[AvatarCheck] ${zaloId}: refreshed avatar: ${newAvatar.substring(0, 60)}...${newName ? ', name: ' + newName : ''}`);
                return { success: true, refreshed: true, avatar_url: newAvatar, full_name: newName || undefined };
            }

            if (newAvatar && newAvatar === currentAvatarUrl) {
                // Same URL but still valid now → only update the timestamp
                Logger.log(`[AvatarCheck] ${zaloId}: avatar unchanged, still valid`);
                return { success: true, refreshed: false };
            }

            // fetchAccountInfo returned an empty avatar
            Logger.warn(`[AvatarCheck] ${zaloId}: fetchAccountInfo returned empty avatar`);
            return { success: true, refreshed: false, reason: 'empty_avatar_response' };
        } catch (error: any) {
            Logger.error(`[AvatarCheck] ${zaloId}: error: ${error.message}`);
            return { success: false, refreshed: false, error: error.message };
        }
    });
}
