"use strict";
/**
 * facebookIpc.ts
 * IPC handlers cho tất cả Facebook operations
 * Pattern: ipcMain.handle('fb:channel', async (_event, params) => { ... })
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setFBMainWindow = setFBMainWindow;
exports.registerFacebookIpc = registerFacebookIpc;
exports.reconnectAllFBAccounts = reconnectAllFBAccounts;
const electron_1 = require("electron");
const uuid_1 = require("uuid");
const DatabaseService_1 = __importDefault(require("../../src/services/DatabaseService"));
const FacebookConnectionManager_1 = __importDefault(require("../../src/utils/FacebookConnectionManager"));
const FacebookSession_1 = require("../../src/services/facebook/FacebookSession");
const FacebookLoginHelper_1 = require("../../src/services/facebook/FacebookLoginHelper");
const SecureSettingsService_1 = require("../../src/services/SecureSettingsService");
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
// ─── Cookie secure storage helpers ───────────────────────────────────────────
function fbCookieKey(accountId) {
    return `fb_cookie_${accountId}`;
}
/**
 * Resolve accountId: nếu là Facebook UID (all digits) → tìm UUID từ fb_accounts.
 * Nếu đã là UUID → trả về nguyên. Dùng cho tất cả handlers nhận accountId từ UI.
 */
function resolveInternalId(accountId) {
    // Nếu trông giống Facebook UID (all digits) → lookup UUID
    if (/^\d+$/.test(accountId)) {
        const fbAcc = DatabaseService_1.default.getInstance().getFBAccountByFacebookId(accountId);
        if (fbAcc?.id)
            return fbAcc.id;
    }
    return accountId;
}
/** Open-source build: giữ hàm để không vỡ import ở main process. */
function setFBMainWindow(_win) { }
// ─── Handlers ────────────────────────────────────────────────────────────────
function registerFacebookIpc() {
    /**
     * Thêm tài khoản Facebook bằng cookie
     */
    electron_1.ipcMain.handle('fb:addAccount', async (_event, { cookie }) => {
        try {
            // 1. Verify cookie alive + init session
            const sessionData = await (0, FacebookSession_1.initSession)(cookie);
            const fbId = sessionData.FacebookID;
            if (!fbId || fbId.includes('Unable') || !fbId.match(/^\d+$/)) {
                return { success: false, error: 'Cookie không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại Facebook và copy cookie mới.' };
            }
            // 2. Check if account already exists
            const existing = DatabaseService_1.default.getInstance().getFBAccounts()
                .find((a) => a.facebook_id === fbId);
            if (existing) {
                return { success: false, error: `Tài khoản Facebook ${fbId} đã được thêm rồi.` };
            }
            // 3. Lấy tên + avatar
            let name = fbId;
            let avatarUrl = '';
            try {
                const html = await (0, FacebookSession_1.fetchFBHomepage)(cookie);
                const profile = await (0, FacebookSession_1.fetchBasicProfileFromHome)(html);
                name = profile.name || fbId;
                avatarUrl = profile.avatarUrl || '';
            }
            catch { }
            // 4. Lưu vào DB (cookie mã hóa)
            const accountId = (0, uuid_1.v4)();
            (0, SecureSettingsService_1.secureSet)(fbCookieKey(accountId), cookie);
            DatabaseService_1.default.getInstance().saveFBAccount({
                id: accountId,
                facebook_id: fbId,
                name,
                avatar_url: avatarUrl,
                cookie_encrypted: '',
                session_data: JSON.stringify(sessionData),
                status: 'disconnected',
            });
            // Also sync to unified accounts table — use fbId as zalo_id (for license matching)
            DatabaseService_1.default.getInstance()['run'](`INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, imei, user_agent, cookies, is_active, channel, created_at)
         VALUES (?, ?, ?, '', 0, '', '', '', 1, 'facebook', datetime('now'))
         ON CONFLICT(zalo_id) DO UPDATE SET
           full_name = excluded.full_name, avatar_url = excluded.avatar_url,
           channel = 'facebook', is_active = 1`, [fbId, name, avatarUrl]);
            // 5. Connect
            const service = FacebookConnectionManager_1.default.getOrCreate(accountId, cookie);
            service.connect().catch((err) => {
                Logger_1.default.warn(`[facebookIpc] Auto-connect failed for ${accountId}: ${err.message}`);
            });
            const account = DatabaseService_1.default.getInstance().getFBAccount(accountId);
            return { success: true, account, facebookId: fbId, name };
        }
        catch (err) {
            Logger_1.default.error(`[facebookIpc] fb:addAccount error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    /**
     * Xóa tài khoản Facebook
     */
    electron_1.ipcMain.handle('fb:removeAccount', async (_event, { accountId }) => {
        try {
            const internalId = resolveInternalId(accountId);
            await FacebookConnectionManager_1.default.disconnect(internalId);
            (0, SecureSettingsService_1.secureDelete)(fbCookieKey(internalId));
            DatabaseService_1.default.getInstance().deleteFBAccount(internalId);
            // Also remove from unified accounts table (zalo_id = fbId)
            DatabaseService_1.default.getInstance().deleteAccount(accountId);
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Cập nhật cookie cho tài khoản Facebook hiện có
     */
    electron_1.ipcMain.handle('fb:updateCookie', async (_event, { accountId, cookie }) => {
        try {
            const internalId = resolveInternalId(accountId);
            const account = DatabaseService_1.default.getInstance().getFBAccount(internalId);
            if (!account)
                return { success: false, error: 'Tài khoản không tồn tại' };
            // Verify cookie alive + init session
            const sessionData = await (0, FacebookSession_1.initSession)(cookie);
            const fbId = sessionData.FacebookID;
            if (!fbId || !fbId.match(/^\d+$/) || fbId.includes('Unable')) {
                return { success: false, error: 'Cookie không hợp lệ hoặc đã hết hạn' };
            }
            // Fetch updated profile
            let name = account.name || fbId;
            let avatarUrl = account.avatar_url || '';
            try {
                const html = await (0, FacebookSession_1.fetchFBHomepage)(cookie);
                const profile = await (0, FacebookSession_1.fetchBasicProfileFromHome)(html);
                if (profile.name)
                    name = profile.name;
                if (profile.avatarUrl)
                    avatarUrl = profile.avatarUrl;
            }
            catch { }
            // Update cookie in secure storage
            (0, SecureSettingsService_1.secureSet)(fbCookieKey(internalId), cookie);
            // Update session + profile
            DatabaseService_1.default.getInstance().updateFBAccountSession(internalId, JSON.stringify(sessionData));
            DatabaseService_1.default.getInstance().updateFBAccountProfile(internalId, name, avatarUrl, fbId);
            // Update unified accounts table (zalo_id = fbId)
            DatabaseService_1.default.getInstance()['run'](`UPDATE accounts SET full_name = ?, avatar_url = ? WHERE zalo_id = ?`, [name, avatarUrl, fbId]);
            Logger_1.default.log(`[facebookIpc] fb:updateCookie success for ${internalId}`);
            return { success: true };
        }
        catch (err) {
            Logger_1.default.error(`[facebookIpc] fb:updateCookie error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    /**
     * Refresh profile (tên, avatar) cho tài khoản Facebook hiện có
     */
    electron_1.ipcMain.handle('fb:refreshProfile', async (_event, { accountId }) => {
        try {
            const internalId = resolveInternalId(accountId);
            const account = DatabaseService_1.default.getInstance().getFBAccount(internalId);
            if (!account)
                return { success: false, error: 'Tài khoản không tồn tại' };
            const cookie = (0, SecureSettingsService_1.secureGet)(fbCookieKey(internalId)) || account.cookie_encrypted;
            if (!cookie)
                return { success: false, error: 'Không tìm thấy cookie. Vui lòng cập nhật cookie.' };
            let name = account.name || account.facebook_id;
            let avatarUrl = account.avatar_url || '';
            try {
                const html = await (0, FacebookSession_1.fetchFBHomepage)(cookie);
                const profile = await (0, FacebookSession_1.fetchBasicProfileFromHome)(html);
                if (profile.name)
                    name = profile.name;
                if (profile.avatarUrl)
                    avatarUrl = profile.avatarUrl;
            }
            catch (err) {
                Logger_1.default.warn(`[facebookIpc] fb:refreshProfile fetch error: ${err.message}`);
            }
            // Update FB account table
            DatabaseService_1.default.getInstance().updateFBAccountProfile(internalId, name, avatarUrl, account.facebook_id);
            // Update unified accounts table (zalo_id = fbId)
            DatabaseService_1.default.getInstance()['run'](`UPDATE accounts SET full_name = ?, avatar_url = ? WHERE zalo_id = ?`, [name, avatarUrl, account.facebook_id]);
            Logger_1.default.log(`[facebookIpc] fb:refreshProfile success for ${account.facebook_id}: ${name}`);
            return { success: true, name, avatarUrl, facebookId: account.facebook_id };
        }
        catch (err) {
            Logger_1.default.error(`[facebookIpc] fb:refreshProfile error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
    /**
     * Lấy danh sách tài khoản FB
     */
    electron_1.ipcMain.handle('fb:getAccounts', async () => {
        try {
            const accounts = DatabaseService_1.default.getInstance().getFBAccounts();
            return { success: true, accounts };
        }
        catch (err) {
            return { success: false, accounts: [], error: err.message };
        }
    });
    /**
     * Connect MQTT listener cho account
     */
    electron_1.ipcMain.handle('fb:connect', async (_event, { accountId }) => {
        try {
            const internalId = resolveInternalId(accountId);
            const account = DatabaseService_1.default.getInstance().getFBAccount(internalId);
            if (!account)
                return { success: false, error: 'Account not found' };
            const cookie = (0, SecureSettingsService_1.secureGet)(fbCookieKey(internalId)) || account.cookie_encrypted;
            const service = FacebookConnectionManager_1.default.getOrCreate(internalId, cookie);
            await service.connect();
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Disconnect MQTT listener
     */
    electron_1.ipcMain.handle('fb:disconnect', async (_event, { accountId }) => {
        try {
            const internalId = resolveInternalId(accountId);
            await FacebookConnectionManager_1.default.disconnect(internalId);
            DatabaseService_1.default.getInstance().updateFBAccountStatus(internalId, 'disconnected');
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Health check
     */
    electron_1.ipcMain.handle('fb:checkHealth', async (_event, { accountId }) => {
        try {
            const internalId = resolveInternalId(accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: true, alive: false, listenerConnected: false, reason: 'not_initialized' };
            const health = await service.checkHealth();
            return { success: true, ...health };
        }
        catch (err) {
            return { success: false, alive: false, listenerConnected: false, error: err.message };
        }
    });
    /**
     * Gửi tin nhắn
     */
    electron_1.ipcMain.handle('fb:sendMessage', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            Logger_1.default.log(`[facebookIpc] fb:sendMessage accountId=${params.accountId} → internalId=${internalId} threadId=${params.threadId} body="${params.body?.slice(0, 50)}"`);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            const result = await service.sendMessage(params.threadId, params.body, params.options);
            Logger_1.default.log(`[facebookIpc] fb:sendMessage result: ${JSON.stringify(result)}`);
            // Save sent message to DB immediately (don't wait for MQTT echo)
            if (result.success && !result.messageId) {
                Logger_1.default.warn(`[facebookIpc] fb:sendMessage succeeded but NO messageId returned! Cannot save to DB. Full result: ${JSON.stringify(result)}`);
            }
            if (result.success && result.messageId) {
                try {
                    const db = DatabaseService_1.default.getInstance();
                    db.saveFBMessage({
                        id: result.messageId,
                        account_id: internalId,
                        thread_id: params.threadId,
                        sender_id: service.getRealFacebookId() || params.accountId,
                        body: params.body,
                        timestamp: result.timestamp || Date.now(),
                        type: 'text',
                        is_self: 1,
                        is_unsent: 0,
                    });
                    Logger_1.default.log(`[facebookIpc] fb:sendMessage saved to DB: msgId=${result.messageId}`);
                }
                catch (dbErr) {
                    Logger_1.default.warn(`[facebookIpc] fb:sendMessage DB save error: ${dbErr.message}`);
                }
            }
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Gửi attachment
     */
    electron_1.ipcMain.handle('fb:sendAttachment', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            // 1. Upload file
            const uploaded = await service.uploadAttachment(params.filePath);
            if (!uploaded)
                return { success: false, error: 'Upload thất bại' };
            // 2. Send with attachment ID
            const attachType = uploaded.attachmentType.startsWith('image') ? 'image'
                : uploaded.attachmentType.startsWith('video') ? 'video'
                    : uploaded.attachmentType.startsWith('audio') ? 'audio'
                        : 'file';
            const result = await service.sendMessage(params.threadId, params.body || '', {
                typeAttachment: attachType,
                attachmentId: uploaded.attachmentId,
                typeChat: params.typeChat,
            });
            // Save sent attachment message to DB immediately
            if (result.success && !result.messageId) {
                Logger_1.default.warn(`[facebookIpc] fb:sendAttachment succeeded but NO messageId returned! Full result: ${JSON.stringify(result)}`);
            }
            if (result.success && result.messageId) {
                try {
                    const fileName = require('path').basename(params.filePath);
                    const bodyPreview = attachType === 'image' ? '🖼️ Hình ảnh'
                        : attachType === 'video' ? '🎬 Video'
                            : attachType === 'audio' ? '🎵 Audio'
                                : `📎 ${fileName}`;
                    DatabaseService_1.default.getInstance().saveFBMessage({
                        id: result.messageId,
                        account_id: internalId,
                        thread_id: params.threadId,
                        sender_id: service.getRealFacebookId() || params.accountId,
                        body: params.body || bodyPreview,
                        timestamp: result.timestamp || Date.now(),
                        type: attachType,
                        attachments: JSON.stringify([{
                                type: attachType,
                                id: uploaded.attachmentId,
                                name: fileName,
                                url: uploaded.attachmentUrl || null,
                            }]),
                        is_self: 1,
                        is_unsent: 0,
                    });
                }
                catch (dbErr) {
                    Logger_1.default.warn(`[facebookIpc] fb:sendAttachment DB save error: ${dbErr.message}`);
                }
            }
            return { ...result, fileName: require('path').basename(params.filePath) };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Gửi nhiều ảnh/file cùng 1 request (batch attachments)
     */
    electron_1.ipcMain.handle('fb:sendAttachments', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            // 1. Upload all files in parallel
            const uploadResults = await Promise.all(params.filePaths.map(fp => service.uploadAttachment(fp)));
            const successful = uploadResults
                .map((u, i) => u ? { uploaded: u, filePath: params.filePaths[i] } : null)
                .filter(Boolean);
            if (successful.length === 0)
                return { success: false, error: 'Tất cả upload thất bại' };
            // 2. Send ONE message with all attachment IDs
            const attachmentIds = successful.map(({ uploaded }) => {
                const t = uploaded.attachmentType?.startsWith('image') ? 'image'
                    : uploaded.attachmentType?.startsWith('video') ? 'video'
                        : uploaded.attachmentType?.startsWith('audio') ? 'audio'
                            : 'file';
                return { id: uploaded.attachmentId, type: t };
            });
            const result = await service.sendMessage(params.threadId, params.body || '', {
                attachmentIds,
                typeChat: params.typeChat,
            });
            // 3. Save to DB — MQTT echo may have already inserted with partial attachments (race),
            //    so save first then force-UPDATE attachments to ensure all images are stored.
            if (result.success && result.messageId) {
                try {
                    const path = require('path');
                    const allAttachmentsJson = JSON.stringify(successful.map(({ uploaded, filePath }) => ({
                        type: attachmentIds.find(a => a.id === uploaded.attachmentId)?.type || 'image',
                        id: uploaded.attachmentId,
                        name: path.basename(filePath),
                        url: uploaded.attachmentUrl || null,
                    })));
                    const db = DatabaseService_1.default.getInstance();
                    db.saveFBMessage({
                        id: result.messageId,
                        account_id: internalId,
                        thread_id: params.threadId,
                        sender_id: service.getRealFacebookId() || params.accountId,
                        body: params.body || '🖼️ Hình ảnh',
                        timestamp: result.timestamp || Date.now(),
                        type: 'image',
                        attachments: allAttachmentsJson,
                        is_self: 1,
                        is_unsent: 0,
                    });
                    // Force-update attachments in case MQTT echo already inserted with partial data
                    db.run?.(`UPDATE messages SET attachments = ? WHERE msg_id = ?`, [allAttachmentsJson, result.messageId]);
                    db.run?.(`UPDATE fb_messages SET attachments = ? WHERE id = ?`, [allAttachmentsJson, result.messageId]);
                    Logger_1.default.log(`[facebookIpc] fb:sendAttachments saved ${successful.length} attachments for ${result.messageId}`);
                }
                catch (dbErr) {
                    Logger_1.default.warn(`[facebookIpc] fb:sendAttachments DB save error: ${dbErr.message}`);
                }
            }
            return { ...result, uploadedCount: successful.length, totalCount: params.filePaths.length };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Thu hồi tin nhắn
     */
    electron_1.ipcMain.handle('fb:unsendMessage', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            const result = await service.unsendMessage(params.messageId);
            if (result.success) {
                DatabaseService_1.default.getInstance().updateFBMessageUnsent(params.messageId);
            }
            return result;
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Reaction
     */
    electron_1.ipcMain.handle('fb:addReaction', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            return await service.addReaction(params.messageId, params.emoji, params.action);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Lấy danh sách threads
     */
    electron_1.ipcMain.handle('fb:getThreads', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            // Lấy từ DB trước (cache)
            const cached = DatabaseService_1.default.getInstance().getFBThreads(internalId);
            if (!params.forceRefresh && cached.length > 0) {
                return { success: true, threads: cached };
            }
            // Refresh từ Facebook API
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (service && service.isConnected()) {
                const threads = await service.getThreadList();
                DatabaseService_1.default.getInstance().saveFBThreads(internalId, threads);
                const updated = DatabaseService_1.default.getInstance().getFBThreads(internalId);
                return { success: true, threads: updated };
            }
            return { success: true, threads: cached };
        }
        catch (err) {
            Logger_1.default.error(`[facebookIpc] fb:getThreads error: ${err.message}`);
            return { success: false, threads: [], error: err.message };
        }
    });
    /**
     * Lấy messages từ DB local
     */
    electron_1.ipcMain.handle('fb:getMessages', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const messages = DatabaseService_1.default.getInstance().getFBMessages(internalId, params.threadId, params.limit || 50, params.offset || 0);
            return { success: true, messages };
        }
        catch (err) {
            return { success: false, messages: [], error: err.message };
        }
    });
    /**
     * Đánh dấu đã đọc
     */
    electron_1.ipcMain.handle('fb:markAsRead', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            DatabaseService_1.default.getInstance().markFBThreadAsRead(internalId, params.threadId);
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Đổi tên nhóm
     */
    electron_1.ipcMain.handle('fb:changeThreadName', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            const ok = await service.changeThreadName(params.threadId, params.name);
            return { success: ok };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Đổi emoji nhóm
     */
    electron_1.ipcMain.handle('fb:changeThreadEmoji', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            const ok = await service.changeThreadEmoji(params.threadId, params.emoji);
            return { success: ok };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Đổi nickname thành viên
     */
    electron_1.ipcMain.handle('fb:changeNickname', async (_event, params) => {
        try {
            const internalId = resolveInternalId(params.accountId);
            const service = FacebookConnectionManager_1.default.get(internalId);
            if (!service)
                return { success: false, error: 'Account not connected' };
            const ok = await service.changeNickname(params.threadId, params.userId, params.nickname);
            return { success: ok };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    /**
     * Đăng nhập bằng username/password
     */
    electron_1.ipcMain.handle('fb:loginWithCredentials', async (_event, params) => {
        try {
            const result = await (0, FacebookLoginHelper_1.loginWithCredentials)(params.username, params.password, params.twoFASecret);
            return { success: !!result.success, result };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    Logger_1.default.log('[facebookIpc] All handlers registered');
}
/**
 * Auto-reconnect tất cả FB accounts khi app khởi động
 */
async function reconnectAllFBAccounts() {
    try {
        const accounts = DatabaseService_1.default.getInstance().getFBAccounts();
        for (const acc of accounts) {
            try {
                const cookie = (0, SecureSettingsService_1.secureGet)(fbCookieKey(acc.id)) || acc.cookie_encrypted;
                if (!cookie)
                    continue;
                const service = FacebookConnectionManager_1.default.getOrCreate(acc.id, cookie);
                service.connect().catch((err) => {
                    Logger_1.default.warn(`[facebookIpc] Auto-reconnect ${acc.id} failed: ${err.message}`);
                });
            }
            catch (err) {
                Logger_1.default.warn(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: ${err.message}`);
            }
        }
    }
    catch (err) {
        Logger_1.default.warn(`[facebookIpc] reconnectAllFBAccounts error: ${err.message}`);
    }
}
//# sourceMappingURL=facebookIpc.js.map