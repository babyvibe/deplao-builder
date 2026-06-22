/**
 * facebookIpc.ts
 * IPC handlers cho tất cả Facebook operations
 * Pattern: ipcMain.handle('fb:channel', async (_event, params) => { ... })
 */

import { ipcMain } from 'electron';
import { v4 as uuid } from 'uuid';
import DatabaseService from '../../src/services/database/DatabaseService';
import FacebookConnectionManager from '../../src/utils/FacebookConnectionManager';
import { initSession, fetchBasicProfileFromHome, fetchFBHomepage, getUserInfoFacebookHtml } from '../../src/services/facebook/FacebookSession';
import { loginWithCredentials } from '../../src/services/facebook/FacebookLoginHelper';
import { secureGet, secureSet, secureDelete } from '../../src/services/secure/SecureSettingsService';
import FileStorageService from '../../src/services/file/FileStorageService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import Logger from '../../src/utils/Logger';
import FacebookService from "../../src/services/facebook/FacebookService";

// ─── Cookie secure storage helpers ───────────────────────────────────────────

function fbCookieKey(accountId: string): string {
  return `fb_cookie_${accountId}`;
}

/**
 * Resolve accountId: nếu là Facebook UID (all digits) → tìm UUID từ fb_accounts.
 * Nếu đã là UUID → trả về nguyên. Dùng cho tất cả handlers nhận accountId từ UI.
 */
function resolveInternalId(accountId: string): string {
  // Nếu trông giống Facebook UID (all digits) → lookup UUID
  if (/^\d+$/.test(accountId)) {
    const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(accountId);
    if (fbAcc?.id) return fbAcc.id;
  }
  return accountId;
}

/**
 * Luôn resolve numeric Facebook ID — dùng làm tên thư mục lưu media.
 * Không fallback về internal UUID: nếu service null hoặc chưa init,
 * tra DB để lấy facebook_id thật.
 */
function resolveRealFacebookId(internalId: string, service: any): string {
  const fbId = service?.getRealFacebookId();
  if (fbId) return fbId;
  const fbAcc = DatabaseService.getInstance().getFBAccount(internalId);
  return fbAcc?.facebook_id || internalId;
}

/** Open-source build: giữ hàm để không vỡ import ở main process. */
export function setFBMainWindow(_win: any) {}

/**
 * Lấy FacebookService từ ConnectionManager, tự động reconnect nếu chưa có.
 * Tất cả handlers gọi hàm này thay vì FacebookConnectionManager.get() trực tiếp.
 * Tránh lỗi "Account not connected" khi mạng drop rồi online lại nhưng
 * ConnectionManager chưa kịp đồng bộ.
 */
async function getFBServiceOrReconnect(internalId: string): Promise<FacebookService | null> {
  let service = FacebookConnectionManager.get(internalId);
  if (service) return service;

  Logger.warn(`[facebookIpc] Service ${internalId} not in ConnectionManager — attempting auto-reconnect...`);
  const account = DatabaseService.getInstance().getFBAccount(internalId);
  if (!account) return null;

  const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;
  if (!cookie) return null;

  let proxyId: number | null | undefined;
  try {
    const accRow = DatabaseService.getInstance().queryOne<any>('SELECT proxy_id FROM accounts WHERE zalo_id = ?', [account.facebook_id || internalId]);
    proxyId = accRow?.proxy_id ?? null;
  } catch { proxyId = null; }

  try {
    service = await FacebookConnectionManager.getOrCreate(internalId, cookie, proxyId);
    Logger.log(`[facebookIpc] Auto-reconnect success for ${internalId}`);
    return service;
  } catch (err: any) {
    Logger.warn(`[facebookIpc] Auto-reconnect failed for ${internalId}: ${err.message}`);
    return null;
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function registerFacebookIpc(): void {

  /**
   * Shared helper: verify cookie, save account to DB, connect.
   * Dùng chung cho cả cookie-based và credentials-based login.
   */
  async function _addFBAccountCommon(cookie: string, proxyId: number | null | undefined): Promise<{
    success: boolean; account?: any; facebookId?: string; name?: string; error?: string;
  }> {
    // Resolve proxy agent để dùng cho initSession
    let httpsAgent: any = undefined;
    if (proxyId) {
      try {
        const proxy = DatabaseService.getInstance().getProxyById(proxyId);
        if (proxy) {
          const { createProxyAgent } = require('../../src/utils/ProxyHelper');
          httpsAgent = createProxyAgent(proxy);
        }
      } catch {}
    }

    // 1. Verify cookie alive + init session (with proxy)
    const sessionData = await initSession(cookie, httpsAgent);
    const fbId = sessionData.FacebookID;

    if (!fbId || fbId === '0' || fbId.includes('Unable') || !fbId.match(/^\d+$/)) {
      return { success: false, error: 'Cookie không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại Facebook và copy cookie mới.' };
    }

    // 2. Nếu account đã tồn tại (trong fb_accounts), xoá record cũ để thêm lại
    const existing = DatabaseService.getInstance().getFBAccounts()
      .find((a: any) => a.facebook_id === fbId);
    if (existing) {
      Logger.log(`[facebookIpc] _addFBAccountCommon — account ${fbId} đã tồn tại, xoá cũ và thêm lại`);
      await FacebookConnectionManager.disconnect(existing.id).catch(() => {});
      secureDelete(fbCookieKey(existing.id));
      DatabaseService.getInstance().deleteFBAccount(existing.id);
      DatabaseService.getInstance().deleteAccount(fbId);
    }

    // 3. Lấy tên + avatar
    let name = fbId;
    let avatarUrl = '';
    try {
      const html = await fetchFBHomepage(cookie);
      const profile = await fetchBasicProfileFromHome(html);
      name = profile.name || fbId;
      avatarUrl = profile.avatarUrl || '';
    } catch {}

    // 4. Lưu vào DB (cookie mã hóa)
    const accountId = uuid();
    secureSet(fbCookieKey(accountId), cookie);

    DatabaseService.getInstance().saveFBAccount({
      id: accountId,
      facebook_id: fbId,
      name,
      avatar_url: avatarUrl,
      cookie_encrypted: cookie,
      session_data: JSON.stringify(sessionData),
      status: 'disconnected',
    });

    // Also sync to unified accounts table — use fbId as zalo_id (for license matching)
    DatabaseService.getInstance()['run'](
      `INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, imei, user_agent, cookies, is_active, channel, proxy_id, created_at)
       VALUES (?, ?, ?, '', 0, '', '', '', 1, 'facebook', ?, datetime('now'))
       ON CONFLICT(zalo_id) DO UPDATE SET
         full_name = excluded.full_name, avatar_url = excluded.avatar_url,
         channel = 'facebook', is_active = 1, proxy_id = excluded.proxy_id`,
      [fbId, name, avatarUrl, proxyId ?? null]
    );

    // 5. Connect (with proxy) — getOrCreate đã tự động connect
    await FacebookConnectionManager.getOrCreate(accountId, cookie, proxyId);

    const account = DatabaseService.getInstance().getFBAccount(accountId);
    return { success: true, account, facebookId: fbId, name };
  }

  /**
   * Thêm tài khoản Facebook bằng cookie
   */
  ipcMain.handle('fb:addAccount', async (_event, { cookie, proxyId }: { cookie: string; proxyId?: number | null }) => {
    try {
      return await _addFBAccountCommon(cookie, proxyId);
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:addAccount error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Thêm tài khoản Facebook bằng username/password (+ 2FA optional)
   * Gọi loginWithCredentials → lấy cookie → tạo account qua _addFBAccountCommon
   */
  ipcMain.handle('fb:addAccountWithCredentials', async (_event, params: {
    username: string; password: string; twoFASecret?: string; proxyId?: number | null;
  }) => {
    try {
      // Resolve proxy agent cho loginWithCredentials
      let httpsAgent: any = undefined;
      if (params.proxyId) {
        try {
          const proxy = DatabaseService.getInstance().getProxyById(params.proxyId);
          if (proxy) {
            const { createProxyAgent } = require('../../src/utils/ProxyHelper');
            httpsAgent = createProxyAgent(proxy);
          }
        } catch {}
      }

      // 1. Đăng nhập lấy cookie
      const loginResult = await loginWithCredentials(
        params.username, params.password, params.twoFASecret, httpsAgent
      );

      // 2FA challenge — yêu cầu UI cung cấp twoFASecret
      if (loginResult.error?.error_subcode === 1348162) {
        return {
          success: false,
          need2FA: true,
          error: loginResult.error.description || 'Tài khoản yêu cầu xác thực 2 yếu tố (2FA). Vui lòng nhập mã bí mật 2FA.',
          errorTitle: loginResult.error.title,
        };
      }

      // Lỗi đăng nhập khác (sai mật khẩu, checkpoint, ...)
      if (!loginResult.success) {
        Logger.warn(`[facebookIpc] loginWithCredentials failed:`, JSON.stringify(loginResult.error));
        return {
          success: false,
          error: loginResult.error?.description || loginResult.error?.title || 'Đăng nhập thất bại',
          errorTitle: loginResult.error?.title,
        };
      }

      // 2. Thành công — tạo account với cookie vừa lấy được
      const cookie = loginResult.success.setCookies;
      if (!cookie) {
        return { success: false, error: 'Đăng nhập thành công nhưng không lấy được cookie.' };
      }

      return await _addFBAccountCommon(cookie, params.proxyId);
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:addAccountWithCredentials error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Xóa tài khoản Facebook
   */
  ipcMain.handle('fb:removeAccount', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      await FacebookConnectionManager.disconnect(internalId);
      secureDelete(fbCookieKey(internalId));
      DatabaseService.getInstance().deleteFBAccount(internalId);
      // Also remove from unified accounts table (zalo_id = fbId)
      DatabaseService.getInstance().deleteAccount(accountId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Cập nhật cookie cho tài khoản Facebook hiện có
   */
  ipcMain.handle('fb:updateCookie', async (_event, { accountId, cookie }: { accountId: string; cookie: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const account = DatabaseService.getInstance().getFBAccount(internalId);
      if (!account) return { success: false, error: 'Tài khoản không tồn tại' };

      // Verify cookie alive + init session
      const sessionData = await initSession(cookie);
      const fbId = sessionData.FacebookID;
      if (!fbId || !fbId.match(/^\d+$/) || fbId.includes('Unable')) {
        return { success: false, error: 'Cookie không hợp lệ hoặc đã hết hạn' };
      }

      // Fetch updated profile
      let name = account.name || fbId;
      let avatarUrl = account.avatar_url || '';
      try {
        const html = await fetchFBHomepage(cookie);
        const profile = await fetchBasicProfileFromHome(html);
        if (profile.name) name = profile.name;
        if (profile.avatarUrl) avatarUrl = profile.avatarUrl;
      } catch {}

      // Update cookie in secure storage
      secureSet(fbCookieKey(internalId), cookie);

      // Update cookie_encrypted fallback (raw cookie) để reconnect vẫn hoạt động
      // khi safeStorage key thay đổi
      DatabaseService.getInstance().run(
        `UPDATE fb_accounts SET cookie_encrypted = ?, updated_at = ? WHERE id = ?`,
        [cookie, Date.now(), internalId]
      );

      // Update session + profile
      DatabaseService.getInstance().updateFBAccountSession(internalId, JSON.stringify(sessionData));
      DatabaseService.getInstance().updateFBAccountProfile(internalId, name, avatarUrl, fbId);

      // Update unified accounts table (zalo_id = fbId)
      DatabaseService.getInstance()['run'](
        `UPDATE accounts SET full_name = ?, avatar_url = ? WHERE zalo_id = ?`,
        [name, avatarUrl, fbId]
      );

      Logger.log(`[facebookIpc] fb:updateCookie success for ${internalId}`);
      return { success: true };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:updateCookie error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Refresh profile (tên, avatar) cho tài khoản Facebook hiện có
   */
  ipcMain.handle('fb:refreshProfile', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const account = DatabaseService.getInstance().getFBAccount(internalId);
      if (!account) return { success: false, error: 'Tài khoản không tồn tại' };

      const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;
      if (!cookie) return { success: false, error: 'Không tìm thấy cookie. Vui lòng cập nhật cookie.' };

      let name = account.name || account.facebook_id;
      let avatarUrl = account.avatar_url || '';
      try {
        const html = await fetchFBHomepage(cookie);
        const profile = await fetchBasicProfileFromHome(html);
        if (profile.name) name = profile.name;
        if (profile.avatarUrl) avatarUrl = profile.avatarUrl;
      } catch (err: any) {
        Logger.warn(`[facebookIpc] fb:refreshProfile fetch error: ${err.message}`);
      }

      // Update FB account table
      DatabaseService.getInstance().updateFBAccountProfile(internalId, name, avatarUrl, account.facebook_id);

      // Update unified accounts table (zalo_id = fbId)
      DatabaseService.getInstance()['run'](
        `UPDATE accounts SET full_name = ?, avatar_url = ? WHERE zalo_id = ?`,
        [name, avatarUrl, account.facebook_id]
      );

      Logger.log(`[facebookIpc] fb:refreshProfile success for ${account.facebook_id}: ${name}`);
      return { success: true, name, avatarUrl, facebookId: account.facebook_id };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:refreshProfile error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Refresh avatar cho 1 contact Facebook (user 1-1).
   * Dùng khi avatar CDN hết hạn (403). Re-fetch thread list từ GraphQL
   * để lấy avatar URL mới, update DB, trả về URL.
   */
  ipcMain.handle('fb:refreshContactAvatar', async (_event, { accountId, userId }: { accountId: string; userId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const cookie = secureGet(fbCookieKey(internalId));
      if (!cookie) return { success: false, error: 'Không tìm thấy cookie. Vui lòng cập nhật cookie.', avatarUrl: null };

      const service = FacebookConnectionManager.get(internalId);
      if (!service || !service.isConnected()) {
        // Nếu service chưa connect, vẫn có thể gọi refreshContactAvatar
        // bằng cách tạo temporary service không persistent
        return { success: false, error: 'Tài khoản chưa kết nối', avatarUrl: null };
      }

      const avatarUrl = await service.refreshContactAvatar(userId);
      if (avatarUrl) {
        return { success: true, avatarUrl };
      }
      return { success: false, error: 'Không thể lấy avatar mới', avatarUrl: null };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:refreshContactAvatar error: ${err.message}`);
      return { success: false, error: err.message, avatarUrl: null };
    }
  });

  /**
   * Lấy thông tin user (tên + avatar) từ Facebook profile HTML
   * Dùng cho E2EE / hội thoại mới không có contact info
   */
  ipcMain.handle('fb:getUserInfoFacebookHtml', async (_event, { accountId, userId }: { accountId: string; userId: string }) => {
    try {
      // Chỉ cho phép user ID dạng số (không phải group chat)
      if (!/^\d+$/.test(userId)) return { success: false, error: 'Chỉ hỗ trợ user 1-1' };
      const internalId = resolveInternalId(accountId);
      const cookie = secureGet(fbCookieKey(internalId));
      if (!cookie) return { success: false, error: 'Cookie not found' };
      const info = await getUserInfoFacebookHtml(cookie, userId);
      if (info) {
        Logger.log(`[facebookIpc] fb:getUserInfoFacebookHtml: resolved ${userId} → name="${info.name}"`);
        // Lưu vào DB nếu có tên
        if (info.name) {
          DatabaseService.getInstance()['run']?.(
            `UPDATE contacts SET display_name = ?, avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
            [info.name, info.avatarUrl || null, internalId, userId]
          );
        }
        return { success: true, name: info.name, avatarUrl: info.avatarUrl };
      }
      return { success: false, error: 'Không thể lấy thông tin user' };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:getUserInfoFacebookHtml error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Lấy danh sách tài khoản FB
   */
  ipcMain.handle('fb:getAccounts', async () => {
    try {
      const accounts = DatabaseService.getInstance().getFBAccounts();
      return { success: true, accounts };
    } catch (err: any) {
      return { success: false, accounts: [], error: err.message };
    }
  });

  /**
   * Connect MQTT listener cho account
   */
  ipcMain.handle('fb:connect', async (_event, { accountId }: { accountId: string }) => {
    try {

      const internalId = resolveInternalId(accountId);
      const account = DatabaseService.getInstance().getFBAccount(internalId);
      if (!account) return { success: false, error: 'Account not found' };

      // Đọc proxyId từ unified accounts table
      let proxyId: number | null | undefined;
      try {
        const accRow = DatabaseService.getInstance().queryOne<any>('SELECT proxy_id FROM accounts WHERE zalo_id = ?', [account.facebook_id || accountId]);
        proxyId = accRow?.proxy_id ?? null;
      } catch { proxyId = null; }

      // Test cookie health trước
      const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;
      if (!cookie) return { success: false, error: 'No cookie found for this account' };

      try {
        const { checkCookieAlive } = require('../../src/services/facebook/FacebookSession');
        const alive = await checkCookieAlive(cookie);
        if (!alive) return { success: false, error: 'Cookie đã hết hạn. Vui lòng đăng nhập lại Facebook và copy cookie mới.' };
      } catch (healthErr: any) {
        Logger.warn(`[facebookIpc] fb:connect health check failed: ${healthErr.message}, proceeding anyway`);
      }

      const service = await FacebookConnectionManager.getOrCreate(internalId, cookie, proxyId);

      // Reset retry count để lần mất kết nối sau bắt đầu lại từ attempt 0
      if (service.isConnected()) {
        service.resetListenerRetryCount?.();
        DatabaseService.getInstance().setListenerActive(account.facebook_id || internalId, true);
        Logger.log(`[facebookIpc] fb:connect ${internalId}: connected + retry reset`);
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Disconnect MQTT listener
   */
  ipcMain.handle('fb:disconnect', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      await FacebookConnectionManager.disconnect(internalId);
      DatabaseService.getInstance().updateFBAccountStatus(internalId, 'disconnected');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Health check
   */
  ipcMain.handle('fb:checkHealth', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: true, alive: false, listenerConnected: false, reason: 'not_initialized' };
      const health = await service.checkHealth();
      return { success: true, ...health };
    } catch (err: any) {
      return { success: false, alive: false, listenerConnected: false, error: err.message };
    }
  });

  /**
   * Gửi tin nhắn (C1: auto-route 1:1 qua E2EE)
   * Dùng chung FacebookSendService.sendTextMessage() với workflow engine.
   */
   ipcMain.handle('fb:sendMessage', async (_event, params: {
    accountId: string; threadId: string; body: string; options?: any;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      Logger.log(`[facebookIpc] fb:sendMessage accountId=${params.accountId} → internalId=${internalId} threadId=${params.threadId} body="${params.body?.slice(0,50)}"`);

      // Auto-reconnect nếu service chưa có trong ConnectionManager
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) {
        return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      }

      const { FacebookSendService } = require('../../src/services/facebook/FacebookSendService');

      const TIMEOUT_MS = 60000;
      const result = (await Promise.race([
        FacebookSendService.sendTextMessage({
          accountId: internalId,
          threadId: params.threadId,
          body: params.body,
          typeChat: params.options?.typeChat ?? null, // ← pass typeChat từ UI
          replyToMessageId: params.options?.replyToMessageId,
        }),
        new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error(`Gửi tin nhắn timeout sau ${TIMEOUT_MS / 1000}s. Vui lòng thử lại.`)), TIMEOUT_MS)
        ),
      ])) as any;

      return result;
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:sendMessage error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Gửi attachment (C2: auto-route 1:1 qua E2EE)
   */
  ipcMain.handle('fb:sendAttachment', async (_event, params: {
    accountId: string; threadId: string; filePath: string; body?: string; typeChat?: 'user' | null; fileType?: 'image' | 'video' | 'audio' | 'file';
    replyToMessageId?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      // C2: 1:1 → gửi qua E2EE bridge
      const isUserMessage = params.typeChat === 'user';
      if (isUserMessage) {
        if (!service.isE2EEConnected()) {
          try {
            await service.retryE2EE();
          } catch {}
        }
        if (!service.isE2EEConnected()) {
          return {
            success: false,
            error: 'Không thể gửi file 1:1 trên Facebook: E2EE bridge chưa kết nối. ' +
              'Build binary: clone mautrix/meta vào bridge-e2ee/, chạy go build, ' +
              'hoặc set biến môi trường FBCHAT_E2EE_BIN',
          };
        }

        const { normalizeChatJid } = require('../../src/services/facebook/FacebookUtils');
        const chatJid = normalizeChatJid(params.threadId);
        const fileName = require('path').basename(params.filePath);
        // Ưu tiên fileType hint từ renderer (voice recording gửi fileType='audio' để tránh nhầm .webm là video)
        const isImage = params.fileType === 'image' || (!params.fileType && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(fileName));
        const isVideo = params.fileType === 'video' || (!params.fileType && /\.(mp4|webm|mov|avi)$/i.test(fileName));
        const isAudio = params.fileType === 'audio' || (!params.fileType && /\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(fileName));

        let result: any;
        if (isImage) {
          result = await service.sendE2EEImage(chatJid, params.filePath, params.body);
        } else if (isVideo) {
          result = await service.sendE2EEVideo(chatJid, params.filePath, params.body);
        } else if (isAudio) {
          result = await service.sendE2EEAudio(chatJid, params.filePath);
        } else {
          result = await service.sendE2EEFile(chatJid, params.filePath, fileName);
        }

        Logger.log(`[facebookIpc] fb:sendAttachment E2EE 1:1 FULL response: ${JSON.stringify(result)}`);

        // Bridge does NOT echo self-sent messages → save message directly
        // with localPath to the original file so UI can display immediately
        if (result.success && result.messageId) {
          try {
            const attachType = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file';
            const fbId = resolveRealFacebookId(internalId, service);

            // Copy sent file to media storage
            let localRelPath: string | undefined;
            try {
              const fs = require('fs');
              const buffer = fs.readFileSync(params.filePath);
              const ext = require('path').extname(fileName) || '.bin';
              const savedName = `sent_${result.messageId.slice(-8)}_${Date.now()}${ext}`;
              const absPath = await FileStorageService.saveBuffer(fbId, buffer, savedName);
              localRelPath = FileStorageService.toRelativePath(absPath);
              Logger.log(`[facebookIpc] E2EE sent media saved: ${localRelPath}`);
            } catch (fsErr: any) {
              Logger.warn(`[facebookIpc] E2EE sent media copy failed: ${fsErr.message}`);
            }

            // Save message to DB with localPath in attachments
            // body = null for media messages — DB's saveFBMessage auto-generates displayContent
            DatabaseService.getInstance().saveFBMessage({
              id: result.messageId,
              account_id: internalId,
              thread_id: params.threadId,
              sender_id: fbId,
              body: params.body || null,
              timestamp: result.timestamp || Date.now(),
              type: attachType,
              attachments: JSON.stringify([{
                type: attachType,
                name: fileName,
                ...(localRelPath ? { localPath: localRelPath } : {}),
              }]),
              is_self: 1,
              is_unsent: 0,
              ...(params.replyToMessageId ? { reply_to_id: params.replyToMessageId } : {}),
            });

            // Update local_paths in unified messages table
            if (localRelPath) {
              DatabaseService.getInstance().updateLocalPaths(fbId, result.messageId, { main: localRelPath });
            }

            // Notify UI: add message to chat store + set localPath for image render
            EventBroadcaster.emit('fb:onMessage', {
              fbAccountId: fbId,
              message: {
                messageID: result.messageId,
                replyToID: params.threadId,
                body: null,
                userID: fbId,
                timestamp: String(result.timestamp || Date.now()),
                type: 'user',
                attachments: {
                  id: 1,
                  url: null,
                  attachmentType: attachType,
                  name: fileName,
                  ...(localRelPath ? { localPath: localRelPath } : {}),
                },
                isSelf: true,
                ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
              },
            });
            if (localRelPath) {
              EventBroadcaster.emit('event:localPath', {
                zaloId: fbId,
                msgId: result.messageId,
                threadId: params.threadId,
                localPaths: { main: localRelPath },
              });
            }
          } catch (dbErr: any) {
            Logger.warn(`[facebookIpc] E2EE self-save error: ${dbErr.message}`);
          }
        }
        return { ...result, fileName };
      }

      // Group: upload + send via REST (existing logic)
      const uploaded = await service.uploadAttachment(params.filePath);
      if (!uploaded) return { success: false, error: 'Upload thất bại' };

      const attachType = uploaded.attachmentType.startsWith('image') ? 'image'
        : uploaded.attachmentType.startsWith('video') ? 'video'
        : uploaded.attachmentType.startsWith('audio') ? 'audio'
        : 'file';

      let result = await service.sendMessage(params.threadId, params.body || '', {
        typeAttachment: attachType as any,
        attachmentId: uploaded.attachmentId,
        typeChat: params.typeChat,
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
      });

      // E2EE error detection → retry via bridge. Handles case where typeChat was not set
      // but conversation is actually E2EE-encrypted 1:1.
      if (!result.success && /disabled|vô hiệu hoá|encrypted/i.test(result.error || '')) {
        Logger.warn(`[facebookIpc] fb:sendAttachment E2EE error detected, retrying via bridge for thread=${params.threadId}`);
        if (!service.isE2EEConnected()) {
          try { await service.retryE2EE(); } catch {}
        }
        if (service.isE2EEConnected()) {
          const { normalizeChatJid } = require('../../src/services/facebook/FacebookUtils');
          const chatJid = normalizeChatJid(params.threadId);
          const isImage = params.fileType === 'image' || /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(require('path').basename(params.filePath));
          const isVideo = params.fileType === 'video' || /\.(mp4|webm|mov|avi)$/i.test(require('path').basename(params.filePath));
          const isAudio = params.fileType === 'audio' || /\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(require('path').basename(params.filePath));
          result = isImage
            ? await service.sendE2EEImage(chatJid, params.filePath, params.body)
            : isVideo
              ? await service.sendE2EEVideo(chatJid, params.filePath, params.body)
              : isAudio
                ? await service.sendE2EEAudio(chatJid, params.filePath)
                : await service.sendE2EEFile(chatJid, params.filePath, require('path').basename(params.filePath));
        }
      }

      // Save sent attachment message to DB immediately
      if (result.success && result.messageId) {
        try {
          const fileName = require('path').basename(params.filePath);
          const bodyPreview = attachType === 'image' ? '🖼️ Hình ảnh'
            : attachType === 'video' ? '🎬 Video'
            : attachType === 'audio' ? '🎵 Audio'
            : `📎 ${fileName}`;
          DatabaseService.getInstance().saveFBMessage({
            id: result.messageId,
            account_id: internalId,
            thread_id: params.threadId,
            sender_id: resolveRealFacebookId(internalId, service),
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
            ...(params.replyToMessageId ? { reply_to_id: params.replyToMessageId } : {}),
          });
        } catch (dbErr: any) {
          Logger.warn(`[facebookIpc] fb:sendAttachment DB save error: ${dbErr.message}`);
        }
      }

      return { ...result, fileName: require('path').basename(params.filePath) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Gửi nhiều ảnh/file cùng 1 request (batch attachments)
   */
  ipcMain.handle('fb:sendAttachments', async (_event, params: {
    accountId: string; threadId: string; filePaths: string[]; body?: string; typeChat?: 'user' | null;
    replyToMessageId?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      // C2: 1:1 → gửi qua E2EE bridge
      const isUserMessage = params.typeChat === 'user';
      if (isUserMessage) {
        if (!service.isE2EEConnected()) {
          try { await service.retryE2EE(); } catch {}
        }
        if (!service.isE2EEConnected()) {
          return {
            success: false, uploadedCount: 0, totalCount: params.filePaths.length,
            error: 'Không thể gửi file 1:1: E2EE bridge chưa kết nối.',
          };
        }

        const { normalizeChatJid } = require('../../src/services/facebook/FacebookUtils');
        const chatJid = normalizeChatJid(params.threadId);
        const path = require('path');
        const results: Array<{ success: boolean; messageId?: string; timestamp?: number; filePath: string; fileName: string; isImage: boolean; isVideo: boolean; isAudio: boolean }> = [];
        let failCount = 0;

        // Gửi từng file qua E2EE bridge, collect all results
        for (const fp of params.filePaths) {
          const fileName = path.basename(fp);
          const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(fileName);
          const isVideo = /\.(mp4|webm|mov|avi)$/i.test(fileName);
          const isAudio = /\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(fileName);
          let r: any;
          if (isImage) {
            r = await service.sendE2EEImage(chatJid, fp, params.body);
          } else if (isVideo) {
            r = await service.sendE2EEVideo(chatJid, fp, params.body);
          } else if (isAudio) {
            r = await service.sendE2EEAudio(chatJid, fp);
          } else {
            r = await service.sendE2EEFile(chatJid, fp, fileName);
          }
          if (!r.success) { failCount++; }
          results.push({ ...r, filePath: fp, fileName, isImage, isVideo, isAudio });
        }

        const fbId = resolveRealFacebookId(internalId, service);

        // Save each successfully sent image as its own message (bridge echoes separately)
        for (const r of results) {
          if (!r.success || !r.messageId) continue;
          Logger.log(`[facebookIpc] fb:sendAttachments E2EE saving msgId=${r.messageId} file=${r.fileName}`);
          try {
            const attachType = r.isImage ? 'image' : r.isVideo ? 'video' : r.isAudio ? 'audio' : 'file';

            // Copy sent file to media storage
            let localRelPath: string | undefined;
            try {
              const buffer = require('fs').readFileSync(r.filePath);
              const ext = path.extname(r.fileName) || '.bin';
              const savedName = `sent_${r.messageId.slice(-8)}_${Date.now()}${ext}`;
              const absPath = await FileStorageService.saveBuffer(fbId, buffer, savedName);
              localRelPath = FileStorageService.toRelativePath(absPath);
              Logger.log(`[facebookIpc] E2EE batch sent media saved: ${localRelPath}`);
            } catch (fsErr: any) {
              Logger.warn(`[facebookIpc] E2EE batch media copy failed for ${r.fileName}: ${fsErr.message}`);
            }

            DatabaseService.getInstance().saveFBMessage({
              id: r.messageId,
              account_id: internalId,
              thread_id: params.threadId,
              sender_id: fbId,
              body: params.body || null,
              timestamp: r.timestamp || Date.now(),
              type: attachType,
              attachments: JSON.stringify([{
                type: attachType,
                name: r.fileName,
                ...(localRelPath ? { localPath: localRelPath } : {}),
              }]),
              is_self: 1,
              is_unsent: 0,
              ...(params.replyToMessageId ? { reply_to_id: params.replyToMessageId } : {}),
            });

            if (localRelPath) {
              DatabaseService.getInstance().updateLocalPaths(fbId, r.messageId, { main: localRelPath });
            }

            EventBroadcaster.emit('fb:onMessage', {
              fbAccountId: fbId,
              message: {
                messageID: r.messageId,
                replyToID: params.threadId,
                body: null,
                userID: fbId,
                timestamp: String(r.timestamp || Date.now()),
                type: 'user',
                attachments: {
                  id: 1,
                  url: null,
                  attachmentType: attachType,
                  name: r.fileName,
                  ...(localRelPath ? { localPath: localRelPath } : {}),
                },
                isSelf: true,
                ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
              },
            });
            if (localRelPath) {
              EventBroadcaster.emit('event:localPath', {
                zaloId: fbId,
                msgId: r.messageId,
                threadId: params.threadId,
                localPaths: { main: localRelPath },
              });
            }
          } catch (dbErr: any) {
            Logger.warn(`[facebookIpc] fb:sendAttachments E2EE save error for ${r.fileName}: ${dbErr.message}`);
          }
        }

        return {
          success: failCount < params.filePaths.length,
          uploadedCount: params.filePaths.length - failCount,
          totalCount: params.filePaths.length,
        };
      }

      // Group: upload + send via REST (existing logic)
      // 1. Upload all files in parallel
      const uploadResults = await Promise.all(
        params.filePaths.map(fp => service.uploadAttachment(fp))
      );
      const successful = uploadResults
        .map((u, i) => u ? { uploaded: u, filePath: params.filePaths[i] } : null)
        .filter(Boolean) as Array<{ uploaded: any; filePath: string }>;

      if (successful.length === 0) return { success: false, error: 'Tất cả upload thất bại' };

      // 2. Send ONE message with all attachment IDs
      const attachmentIds = successful.map(({ uploaded }) => {
        const t = uploaded.attachmentType?.startsWith('image') ? 'image'
          : uploaded.attachmentType?.startsWith('video') ? 'video'
          : uploaded.attachmentType?.startsWith('audio') ? 'audio'
          : 'file';
        return { id: uploaded.attachmentId, type: t as any };
      });

      const result = await service.sendMessage(params.threadId, params.body || '', {
        attachmentIds,
        typeChat: params.typeChat,
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
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
          const db = DatabaseService.getInstance();
          db.saveFBMessage({
            id: result.messageId,
            account_id: internalId,
            thread_id: params.threadId,
            sender_id: resolveRealFacebookId(internalId, service),
            body: params.body || '🖼️ Hình ảnh',
            timestamp: result.timestamp || Date.now(),
            type: 'image',
            attachments: allAttachmentsJson,
            is_self: 1,
            is_unsent: 0,
            ...(params.replyToMessageId ? { reply_to_id: params.replyToMessageId } : {}),
          });
          // Force-update attachments in case MQTT echo already inserted with partial data
          db.run?.(`UPDATE messages SET attachments = ? WHERE msg_id = ?`, [allAttachmentsJson, result.messageId]);
          db.run?.(`UPDATE fb_messages SET attachments = ? WHERE id = ?`, [allAttachmentsJson, result.messageId]);
          Logger.log(`[facebookIpc] fb:sendAttachments saved ${successful.length} attachments for ${result.messageId}`);
        } catch (dbErr: any) {
          Logger.warn(`[facebookIpc] fb:sendAttachments DB save error: ${dbErr.message}`);
        }
      }

      return { ...result, uploadedCount: successful.length, totalCount: params.filePaths.length };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Thu hồi tin nhắn
   */
  ipcMain.handle('fb:unsendMessage', async (_event, params: {
    accountId: string; messageId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const result = await service.unsendMessage(params.messageId);
      if (result.success) {
        DatabaseService.getInstance().updateFBMessageUnsent(params.messageId);
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Reaction (C3: auto-route 1:1 E2EE reactions qua bridge)
   */
  ipcMain.handle('fb:addReaction', async (_event, params: {
    accountId: string; messageId: string; emoji: string; action: 'add' | 'remove';
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      let success = false;

      // Try bridge reaction first (works for group via sendReaction)
      if (service.isE2EEConnected()) {
        // Look up thread_id from message DB for context
        const db = DatabaseService.getInstance();
        const msg = db.queryOne?.('SELECT thread_id, sender_id FROM fb_messages WHERE id = ? AND account_id = ?',
          [params.messageId, internalId]) as any;

        if (msg?.thread_id) {
          // Thread ID is numeric (all digits) = 1:1 E2EE chat → route via E2EE reaction
          if (/^\d+$/.test(msg.thread_id)) {
            const { normalizeChatJid } = require('../../src/services/facebook/FacebookUtils');
            const chatJid = normalizeChatJid(msg.thread_id);
            const senderJid = normalizeChatJid(resolveRealFacebookId(internalId, service));
            try {
              const result = await service.sendE2EEReaction(chatJid, params.messageId, senderJid, params.emoji);
              if (result.success) success = true;
            } catch {}
          } else {
            // Group message (non-numeric thread ID) — try bridge sendReaction
            try {
              const result = await service.sendBridgeReaction(msg.thread_id, params.messageId, params.emoji);
              if (result.success) success = true;
            } catch {}
          }
        }
      }

      // Fallback to GraphQL mutation if bridge didn't succeed
      if (!success) {
        const result = await service.addReaction(params.messageId, params.emoji, params.action);
        if (result.success) success = true;
      }

      // Save to local DB for persistence (even if Facebook API fails, keep local state)
      if (params.emoji) {
        // Build reactions payload in old format { userId: emoji }
        const fbId = resolveRealFacebookId(internalId, service);
        const reactionsPayload: Record<string, string> = {};
        reactionsPayload[fbId || internalId] = params.emoji;
        DatabaseService.getInstance().updateFBMessageReaction(params.messageId, JSON.stringify(reactionsPayload));
      }

      return { success };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Chỉnh sửa nội dung tin nhắn đã gửi (I1)
   */
  ipcMain.handle('fb:editMessage', async (_event, params: {
    accountId: string; messageId: string; text: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.editMessage(params.messageId, params.text);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Lấy danh sách threads
   */
  ipcMain.handle('fb:getThreads', async (_event, params: {
    accountId: string; forceRefresh?: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      // Lấy từ DB trước (cache)
      const cached = DatabaseService.getInstance().getFBThreads(internalId);

      if (!params.forceRefresh && cached.length > 0) {
        return { success: true, threads: cached };
      }

      // Refresh từ Facebook API
      const service = FacebookConnectionManager.get(internalId);
      if (service && service.isConnected()) {
        const threads = await service.getThreadList();
        DatabaseService.getInstance().saveFBThreads(internalId, threads);
        const updated = DatabaseService.getInstance().getFBThreads(internalId);
        return { success: true, threads: updated };
      }

      return { success: true, threads: cached };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:getThreads error: ${err.message}`);
      return { success: false, threads: [], error: err.message };
    }
  });

  /**
   * Lấy messages từ DB local
   */
  ipcMain.handle('fb:getMessages', async (_event, params: {
    accountId: string; threadId: string; limit?: number; offset?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const messages = DatabaseService.getInstance().getFBMessages(
        internalId, params.threadId, params.limit || 50, params.offset || 0
      );
      return { success: true, messages };
    } catch (err: any) {
      return { success: false, messages: [], error: err.message };
    }
  });

  /**
   * Đánh dấu đã đọc (C5: gửi lên Facebook server qua bridge)
   */
  ipcMain.handle('fb:markAsRead', async (_event, params: {
    accountId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      DatabaseService.getInstance().markFBThreadAsRead(internalId, params.threadId);

      // C5: Also send read receipt to Facebook server
      const service = FacebookConnectionManager.get(internalId);
      if (service) {
        service.markReadOnServer(params.threadId).catch(() => {});
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Đổi tên nhóm
   */
  ipcMain.handle('fb:changeThreadName', async (_event, params: {
    accountId: string; threadId: string; name: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const ok = await service.changeThreadName(params.threadId, params.name);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Đổi emoji nhóm
   */
  ipcMain.handle('fb:changeThreadEmoji', async (_event, params: {
    accountId: string; threadId: string; emoji: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const ok = await service.changeThreadEmoji(params.threadId, params.emoji);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Đổi nickname thành viên
   */
  ipcMain.handle('fb:changeNickname', async (_event, params: {
    accountId: string; threadId: string; userId: string; nickname: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const ok = await service.changeNickname(params.threadId, params.userId, params.nickname);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Đăng nhập bằng username/password
   */
  ipcMain.handle('fb:loginWithCredentials', async (_event, params: {
    username: string; password: string; twoFASecret?: string;
  }) => {
    try {
      const result = await loginWithCredentials(params.username, params.password, params.twoFASecret);
      return { success: !!result.success, result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── E2EE Handlers ──────────────────────────────────────────────────────

  /**
   * Gửi tin nhắn E2EE (1:1 encrypted)
   */
  ipcMain.handle('fb:sendE2EEMessage', async (_event, params: {
    accountId: string; chatJid: string; text: string; replyToId?: string; replyToSenderJid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      const sender = service.getE2EESender();
      if (!sender) return { success: false, error: 'E2EE bridge not connected' };

      const result = await sender.send(
        params.chatJid,
        params.text,
        params.replyToId || '',
        params.replyToSenderJid || '',
      );

      // Save sent message to DB — strip @msgr JID from chatJid để nhất quán
      // với handleE2EEMessage (dùng stripped numeric ID làm thread_id)
      if (result.success && result.messageId) {
        try {
          const strippedThreadId = params.chatJid ? params.chatJid.replace(/@.*$/, '') : params.chatJid;
          DatabaseService.getInstance().saveFBMessage({
            id: result.messageId,
            account_id: internalId,
            thread_id: strippedThreadId, // ← numeric ID, nhất quán với receive path
            sender_id: resolveRealFacebookId(internalId, service),
            body: params.text,
            timestamp: result.timestamp || Date.now(),
            type: 'text',
            is_self: 1,
            is_unsent: 0,
            ...(params.replyToId ? { reply_to_id: params.replyToId } : {}),
          });
        } catch (dbErr: any) {
          Logger.warn(`[facebookIpc] fb:sendE2EEMessage DB save error: ${dbErr.message}`);
        }
      }

      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Kiểm tra trạng thái E2EE bridge
   */
  ipcMain.handle('fb:getE2EEStatus', async (_event, params: {
    accountId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: true, status: 'disconnected', available: false };

      return {
        success: true,
        status: service.getE2EEStatus(),
        connected: service.isE2EEConnected(),
        available: service.isE2EEAvailable(),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Bật/tắt E2EE bridge thủ công
   */
  ipcMain.handle('fb:toggleE2EE', async (_event, params: {
    accountId: string; enable: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      if (params.enable) {
        // E2EE is auto-started during connect — manual reconnect nếu cần
        await service.disconnect();
        await service.connect();
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Gửi typing indicator (C6)
   */
  ipcMain.handle('fb:sendTyping', async (_event, params: {
    accountId: string; threadId: string; isTyping: boolean; isGroup?: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      await service.sendTyping(params.threadId, params.isTyping, params.isGroup || false);
      return { success: true };
    } catch (err: any) {
      // Typing is best-effort — no error returned
      return { success: true };
    }
  });

  /**
   * Gửi seen/delivered receipt (C5)
   */
  ipcMain.handle('fb:sendSeen', async (_event, params: {
    accountId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      await service.markReadOnServer(params.threadId);
      return { success: true };
    } catch (err: any) {
      return { success: true };
    }
  });

  /**
   * Chuyển tiếp tin nhắn (I2)
   */
  ipcMain.handle('fb:forwardMessage', async (_event, params: {
    accountId: string; messageId: string; targetThreadId: string; isGroup?: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.forwardMessage(params.messageId, params.targetThreadId, params.isGroup || false);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Ghim tin nhắn (I3)
   */
  ipcMain.handle('fb:pinMessage', async (_event, params: {
    accountId: string; messageId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.pinMessage(params.messageId, params.threadId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Bỏ ghim tin nhắn (I3)
   */
  ipcMain.handle('fb:unpinMessage', async (_event, params: {
    accountId: string; messageId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.unpinMessage(params.messageId, params.threadId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Tạo poll (I6)
   */
  ipcMain.handle('fb:createPoll', async (_event, params: {
    accountId: string; threadId: string; question: string; options: string[];
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.createPoll(params.threadId, params.question, params.options);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Bỏ phiếu poll (I6)
   */
  ipcMain.handle('fb:votePoll', async (_event, params: {
    accountId: string; pollId: string; optionIds: string[];
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.votePoll(params.pollId, params.optionIds);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Fetch tin nhắn lịch sử từ Facebook API (C7)
   * Khác với fb:getMessages (đọc từ DB local), cái này gọi API GraphQL
   * Tự động lưu tin nhắn fetch được vào DB để dùng offline.
   */
  ipcMain.handle('fb:fetchThreadMessages', async (_event, params: {
    accountId: string; threadId: string; limit?: number; beforeCursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const result = await service.fetchThreadMessages(params.threadId, params.limit, params.beforeCursor);
      // Lưu tin nhắn vào DB để dùng offline
      if (result.success && result.messages?.length) {
        const db = DatabaseService.getInstance();
        for (const msg of result.messages) {
          db.saveFBMessage({
            id: msg.id,
            account_id: internalId,
            thread_id: params.threadId,
            sender_id: msg.senderId,
            sender_name: msg.senderName || '',
            body: msg.body || null,
            timestamp: msg.timestampMs,
            type: msg.attachments?.length ? 'file' : 'text',
            attachments: msg.attachments?.length ? JSON.stringify(msg.attachments) : '[]',
            reply_to_id: msg.replyToMessageId || '',
            is_self: String(msg.senderId) === internalId ? 1 : 0,
            is_unsent: msg.isUnsent ? 1 : 0,
            reactions: msg.reactions?.length ? JSON.stringify(msg.reactions) : '{}',
          });
        }
        Logger.log(`[fb:fetchThreadMessages] Saved ${result.messages.length} messages to DB`);
      }
      return result;
    } catch (err: any) {
      return { success: false, messages: [], error: err.message };
    }
  });

  // ─── Scan Data Handlers ─────────────────────────────────────────────────

  /**
   * Quét thành viên nhóm Facebook
   */
  ipcMain.handle('fb:scanGroupMembers', async (_event, params: {
    accountId: string; groupId: string; cursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanGroupMembers(internalId, params.groupId, params.cursor);
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Quét nhóm theo từ khóa
   */
  ipcMain.handle('fb:scanGroupKeyword', async (_event, params: {
    accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanSearchComet(internalId, { keyword: params.keyword, type: 'group', cursor: params.cursor, filters: params.filters, bsid: params.bsid, tsid: params.tsid });
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Quét fanpage theo từ khóa
   */
  ipcMain.handle('fb:scanFanpageKeyword', async (_event, params: {
    accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanSearchComet(internalId, { keyword: params.keyword, type: 'page', cursor: params.cursor, filters: params.filters, bsid: params.bsid, tsid: params.tsid });
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Quét bình luận bài viết
   */
  ipcMain.handle('fb:scanPostComments', async (_event, params: {
    accountId: string; postId: string; cursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanPostComments(internalId, params.postId, params.cursor);
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Quét bài viết theo từ khóa
   */
  ipcMain.handle('fb:scanPostKeyword', async (_event, params: {
    accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanSearchComet(internalId, { keyword: params.keyword, type: 'post', cursor: params.cursor, filters: params.filters, bsid: params.bsid, tsid: params.tsid });
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Quét bài đăng từ timeline profile/fanpage/group
   */
  ipcMain.handle('fb:scanPostTimeline', async (_event, params: {
    accountId: string; sourceId: string; sourceType: 'profile' | 'fanpage' | 'group'; cursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanPostTimeline(internalId, params.sourceId, params.sourceType, params.cursor);
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Reset scan cache (clear context + docId cache)
   */
  // ─── Batch Scan Handlers ─────────────────────────────────────────────

  /**
   * Quét thành viên nhiều nhóm cùng lúc (batch)
   */
  ipcMain.handle('fb:scanGroupMembersBatch', async (_event, params: {
    accountId: string; groupIds: string[]; threadCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanGroupMembersBatch(internalId, params.groupIds, params.threadCount || 5);
      return result;
    } catch (err: any) {
      return { success: false, items: [], errors: [err.message], error: err.message };
    }
  });

  /**
   * Quét bình luận nhiều bài viết cùng lúc (batch)
   */
  ipcMain.handle('fb:scanPostCommentsBatch', async (_event, params: {
    accountId: string; postIds: string[]; threadCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanPostCommentsBatch(internalId, params.postIds, params.threadCount || 5);
      return result;
    } catch (err: any) {
      return { success: false, items: [], errors: [err.message], error: err.message };
    }
  });

  // ─── Scan Log Handlers ───────────────────────────────────────────────

  /**
   * Lưu 1 entry scan history
   */
  ipcMain.handle('fb:saveScanLog', async (_event, params: {
    accountId: string; tabId?: string; tabName?: string; scanType: string; input: string;
    status: 'success' | 'error'; itemsCount?: number;
    error?: string; requestPayload?: string;
    responsePreview?: string; requestHeaders?: string; responseHeaders?: string;
    docId?: string; threadCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanLogService } = require('../../src/services/facebook/FacebookScanLogService');
      FacebookScanLogService.init();
      const id = FacebookScanLogService.save({
        accountId: internalId,
        tabId: params.tabId || '',
        tabName: params.tabName || '',
        scanType: params.scanType,
        input: params.input,
        status: params.status,
        itemsCount: params.itemsCount || 0,
        error: params.error || '',
        requestPayload: params.requestPayload || '{}',
        responsePreview: params.responsePreview || '',
        requestHeaders: params.requestHeaders || '',
        responseHeaders: params.responseHeaders || '',
        docId: params.docId || '',
        threadCount: params.threadCount || 1,
        createdAt: Date.now(),
      });
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Lấy lịch sử scan
   */
  ipcMain.handle('fb:getScanLogs', async (_event, params: {
    accountId: string; tabId?: string; limit?: number; offset?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanLogService } = require('../../src/services/facebook/FacebookScanLogService');
      const result = FacebookScanLogService.getList(internalId, params.tabId, params.limit || 50, params.offset || 0);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, logs: [], total: 0, error: err.message };
    }
  });

  ipcMain.handle('fb:scanResetCache', async () => {
    try {
      const { FacebookScanService } = require('../../src/services/facebook/FacebookScanService');
      const service = FacebookScanService.getInstance();
      service.clearCache();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Scan Tab Handlers ────────────────────────────────────────────────

  /**
   * Lưu/cập nhật tab
   */
  ipcMain.handle('fb:scanSaveTab', async (_event, params: {
    id: string; accountId: string; name: string; scanType: string;
    config: string; status?: string; itemsCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      FacebookScanTabService.init();
      // Preserve original created_at if tab already exists
      const existing = FacebookScanTabService.getTab(params.id);
      const ok = FacebookScanTabService.saveTab({
        id: params.id,
        accountId: internalId,
        name: params.name,
        scanType: params.scanType,
        config: params.config,
        status: (params.status as any) || 'active',
        itemsCount: params.itemsCount || 0,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      });
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Lấy danh sách tabs
   */
  ipcMain.handle('fb:scanGetTabs', async (_event, params: {
    accountId: string; status?: string; limit?: number; offset?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const result = FacebookScanTabService.getTabs(internalId, params.status as any, params.limit, params.offset);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, tabs: [], total: 0, error: err.message };
    }
  });

  /**
   * Lấy 1 tab
   */
  ipcMain.handle('fb:scanGetTab', async (_event, params: { id: string }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const tab = FacebookScanTabService.getTab(params.id);
      return { success: !!tab, tab };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Cập nhật trạng thái tab (active/archived/deleted)
   */
  ipcMain.handle('fb:scanUpdateTabStatus', async (_event, params: { id: string; status: string }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const ok = FacebookScanTabService.updateTabStatus(params.id, params.status as any);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Xoá hẳn tab + data + request logs
   */
  ipcMain.handle('fb:scanDeleteTab', async (_event, params: { id: string }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const ok = FacebookScanTabService.deleteTab(params.id);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Cập nhật updated_at cho tab (đẩy lên đầu danh sách)
   */
  ipcMain.handle('fb:scanTouchTab', async (_event, params: { id: string }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const ok = FacebookScanTabService.touchTab(params.id);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Lưu data cho tab
   */
  ipcMain.handle('fb:scanSaveTabData', async (_event, params: {
    tabId: string; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean };
  }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const id = FacebookScanTabService.saveTabData(params.tabId, params.items, params.pageInfo);
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Lấy data đã lưu cho tab (items + pageInfo từ lần scan gần nhất)
   */
  ipcMain.handle('fb:scanGetTabData', async (_event, params: { tabId: string }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const rows = FacebookScanTabService.getTabData(params.tabId, 1);
      if (rows.length > 0) {
        const latest = rows[0];
        return {
          success: true,
          items: JSON.parse(latest.items || '[]'),
          pageInfo: JSON.parse(latest.page_info || '{}'),
        };
      }
      return { success: true, items: [], pageInfo: { endCursor: null, hasNextPage: false } };
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Lưu request log cho tab
   */
  ipcMain.handle('fb:scanSaveRequestLog', async (_event, params: {
    tabId: string; requestPayload: string; responsePreview: string;
    requestHeaders?: string; responseHeaders?: string;
    status: string; error?: string; itemsCount?: number;
  }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const id = FacebookScanTabService.saveRequestLog(params.tabId, {
        requestPayload: params.requestPayload,
        responsePreview: params.responsePreview,
        status: params.status as any,
        error: params.error,
        itemsCount: params.itemsCount,
      });
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Lấy request logs của tab
   */
  ipcMain.handle('fb:scanGetRequestLogs', async (_event, params: { tabId: string; limit?: number; offset?: number }) => {
    try {
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const result = FacebookScanTabService.getRequestLogs(params.tabId, params.limit, params.offset);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, logs: [], total: 0, error: err.message };
    }
  });

  /**
   * Thống kê scan
   */
  ipcMain.handle('fb:scanGetStats', async (_event, params: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanTabService } = require('../../src/services/facebook/FacebookScanTabService');
      const stats = FacebookScanTabService.getStats(internalId);
      return { success: true, ...stats };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  Logger.log('[facebookIpc] All handlers registered');
}

/**
 * Block người dùng (N4)
 */
ipcMain.handle('fb:blockUser', async (_event, params: {
  accountId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.blockUser(params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Unblock người dùng (N4)
 */
ipcMain.handle('fb:unblockUser', async (_event, params: {
  accountId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.unblockUser(params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Đổi theme hội thoại (N1)
 */
ipcMain.handle('fb:changeThreadTheme', async (_event, params: {
  accountId: string; threadId: string; theme: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.changeThreadTheme(params.threadId, params.theme);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Tạo Messenger Note (N2)
 */
ipcMain.handle('fb:createNote', async (_event, params: {
  accountId: string; text: string; backgroundColor?: string; textColor?: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.createNote(params.text, params.backgroundColor, params.textColor);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// ─── N3: Group Admin Operations ─────────────────────────────────────────────

/**
 * Thêm admin nhóm (N3)
 */
ipcMain.handle('fb:addGroupAdmin', async (_event, params: {
  accountId: string; threadId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.addGroupAdmin(params.threadId, params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Xóa admin nhóm (N3)
 */
ipcMain.handle('fb:removeGroupAdmin', async (_event, params: {
  accountId: string; threadId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.removeGroupAdmin(params.threadId, params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Bật/tắt duyệt thành viên (N3)
 */
ipcMain.handle('fb:changeApprovalMode', async (_event, params: {
  accountId: string; threadId: string; approved: boolean;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.changeApprovalMode(params.threadId, params.approved);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Duyệt/từ chối thành viên (N3)
 */
ipcMain.handle('fb:approvePendingMember', async (_event, params: {
  accountId: string; threadId: string; userId: string; approve: boolean;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.approvePendingMember(params.threadId, params.userId, params.approve);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Lấy link mời nhóm (N3)
 */
ipcMain.handle('fb:getGroupLink', async (_event, params: {
  accountId: string; threadId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.getGroupLink(params.threadId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Bật/tắt link mời nhóm (N3)
 */
ipcMain.handle('fb:setGroupLink', async (_event, params: {
  accountId: string; threadId: string; enable: boolean;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.setGroupLink(params.threadId, params.enable);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Auto-reconnect tất cả FB accounts khi app khởi động.
 * - Bỏ qua account đã connected
 * - Test cookie health trước khi connect
 * - Nếu cookie expired → bỏ qua (không thử)
 */
export async function reconnectAllFBAccounts(): Promise<void> {
  try {
    const accounts = DatabaseService.getInstance().getFBAccounts();
    Logger.log(`[facebookIpc] reconnectAllFBAccounts: ${accounts.length} FB accounts found`);
    for (const acc of accounts) {
      try {
        // Bỏ qua account đã connected
        const existing = FacebookConnectionManager.get(acc.id);
        if (existing && existing.isConnected()) {
          Logger.log(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: already connected, skipping`);
          continue;
        }

        const cookie = secureGet(fbCookieKey(acc.id)) || acc.cookie_encrypted;
        if (!cookie) {
          Logger.warn(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: no cookie found, skipping`);
          continue;
        }

        // Test cookie health trước khi connect
        try {
          const { checkCookieAlive } = require('../../src/services/facebook/FacebookSession');
          const alive = await checkCookieAlive(cookie);
          if (!alive) {
            Logger.warn(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: cookie expired, skipping`);
            continue;
          }
        } catch (healthErr: any) {
          Logger.warn(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: health check failed: ${healthErr.message}, trying anyway`);
        }

        // Đọc proxy_id từ unified accounts table
        let proxyId: number | null | undefined;
        try {
          const accRow = DatabaseService.getInstance().queryOne<any>('SELECT proxy_id FROM accounts WHERE zalo_id = ?', [acc.facebook_id || acc.id]);
          proxyId = accRow?.proxy_id ?? null;
        } catch { proxyId = null; }

        const service = await FacebookConnectionManager.getOrCreate(acc.id, cookie, proxyId);
        // Reset retry count sau khi connect thành công
        if (service.isConnected()) {
          service.resetListenerRetryCount?.();
        }
        Logger.log(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: connected successfully`);
      } catch (err: any) {
        Logger.warn(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    Logger.warn(`[facebookIpc] reconnectAllFBAccounts error: ${err.message}`);
  }
}

