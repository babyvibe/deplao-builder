/**
 * facebookIpc.ts
 * IPC handlers cho tất cả Facebook operations
 * Pattern: ipcMain.handle('fb:channel', async (_event, params) => { ... })
 */

import { ipcMain } from 'electron';
import { v4 as uuid } from 'uuid';
import DatabaseService from '../../src/services/DatabaseService';
import FacebookConnectionManager from '../../src/utils/FacebookConnectionManager';
import { initSession, fetchBasicProfileFromHome, fetchFBHomepage } from '../../src/services/facebook/FacebookSession';
import { loginWithCredentials } from '../../src/services/facebook/FacebookLoginHelper';
import { secureGet, secureSet, secureDelete } from '../../src/services/SecureSettingsService';
import Logger from '../../src/utils/Logger';

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

/** Open-source build: giữ hàm để không vỡ import ở main process. */
export function setFBMainWindow(_win: any) {}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function registerFacebookIpc(): void {

  /**
   * Thêm tài khoản Facebook bằng cookie
   */
  ipcMain.handle('fb:addAccount', async (_event, { cookie }: { cookie: string }) => {
    try {
      // 1. Verify cookie alive + init session
      const sessionData = await initSession(cookie);
      const fbId = sessionData.FacebookID;

      if (!fbId || fbId.includes('Unable') || !fbId.match(/^\d+$/)) {
        return { success: false, error: 'Cookie không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại Facebook và copy cookie mới.' };
      }

      // 2. Check if account already exists
      const existing = DatabaseService.getInstance().getFBAccounts()
        .find((a: any) => a.facebook_id === fbId);
      if (existing) {
        return { success: false, error: `Tài khoản Facebook ${fbId} đã được thêm rồi.` };
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
        cookie_encrypted: '',
        session_data: JSON.stringify(sessionData),
        status: 'disconnected',
      });

      // Also sync to unified accounts table — use fbId as zalo_id (for license matching)
      DatabaseService.getInstance()['run'](
        `INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, imei, user_agent, cookies, is_active, channel, created_at)
         VALUES (?, ?, ?, '', 0, '', '', '', 1, 'facebook', datetime('now'))
         ON CONFLICT(zalo_id) DO UPDATE SET
           full_name = excluded.full_name, avatar_url = excluded.avatar_url,
           channel = 'facebook', is_active = 1`,
        [fbId, name, avatarUrl]
      );

      // 5. Connect
      const service = FacebookConnectionManager.getOrCreate(accountId, cookie);
      service.connect().catch((err: any) => {
        Logger.warn(`[facebookIpc] Auto-connect failed for ${accountId}: ${err.message}`);
      });


      const account = DatabaseService.getInstance().getFBAccount(accountId);
      return { success: true, account, facebookId: fbId, name };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:addAccount error: ${err.message}`);
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

      const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;
      const service = FacebookConnectionManager.getOrCreate(internalId, cookie);
      await service.connect();
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
   * Gửi tin nhắn
   */
   ipcMain.handle('fb:sendMessage', async (_event, params: {
    accountId: string; threadId: string; body: string; options?: any;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      Logger.log(`[facebookIpc] fb:sendMessage accountId=${params.accountId} → internalId=${internalId} threadId=${params.threadId} body="${params.body?.slice(0,50)}"`);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };
      const result = await service.sendMessage(params.threadId, params.body, params.options);
      Logger.log(`[facebookIpc] fb:sendMessage result: ${JSON.stringify(result)}`);

      // Save sent message to DB immediately (don't wait for MQTT echo)
      if (result.success && !result.messageId) {
        Logger.warn(`[facebookIpc] fb:sendMessage succeeded but NO messageId returned! Cannot save to DB. Full result: ${JSON.stringify(result)}`);
      }
      if (result.success && result.messageId) {
        try {
          const db = DatabaseService.getInstance();
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
          Logger.log(`[facebookIpc] fb:sendMessage saved to DB: msgId=${result.messageId}`);
        } catch (dbErr: any) {
          Logger.warn(`[facebookIpc] fb:sendMessage DB save error: ${dbErr.message}`);
        }
      }

      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Gửi attachment
   */
  ipcMain.handle('fb:sendAttachment', async (_event, params: {
    accountId: string; threadId: string; filePath: string; body?: string; typeChat?: 'user' | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };

      // 1. Upload file
      const uploaded = await service.uploadAttachment(params.filePath);
      if (!uploaded) return { success: false, error: 'Upload thất bại' };

      // 2. Send with attachment ID
      const attachType = uploaded.attachmentType.startsWith('image') ? 'image'
        : uploaded.attachmentType.startsWith('video') ? 'video'
        : uploaded.attachmentType.startsWith('audio') ? 'audio'
        : 'file';

      const result = await service.sendMessage(params.threadId, params.body || '', {
        typeAttachment: attachType as any,
        attachmentId: uploaded.attachmentId,
        typeChat: params.typeChat,
      });

      // Save sent attachment message to DB immediately
      if (result.success && !result.messageId) {
        Logger.warn(`[facebookIpc] fb:sendAttachment succeeded but NO messageId returned! Full result: ${JSON.stringify(result)}`);
      }
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
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };

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
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };
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
   * Reaction
   */
  ipcMain.handle('fb:addReaction', async (_event, params: {
    accountId: string; messageId: string; emoji: string; action: 'add' | 'remove';
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };
      return await service.addReaction(params.messageId, params.emoji, params.action);
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
   * Đánh dấu đã đọc
   */
  ipcMain.handle('fb:markAsRead', async (_event, params: {
    accountId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      DatabaseService.getInstance().markFBThreadAsRead(internalId, params.threadId);
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
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };
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
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };
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
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: false, error: 'Account not connected' };
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

  Logger.log('[facebookIpc] All handlers registered');
}

/**
 * Auto-reconnect tất cả FB accounts khi app khởi động
 */
export async function reconnectAllFBAccounts(): Promise<void> {
  try {
    const accounts = DatabaseService.getInstance().getFBAccounts();
    for (const acc of accounts) {
      try {
        const cookie = secureGet(fbCookieKey(acc.id)) || acc.cookie_encrypted;
        if (!cookie) continue;
        const service = FacebookConnectionManager.getOrCreate(acc.id, cookie);
        service.connect().catch((err: any) => {
          Logger.warn(`[facebookIpc] Auto-reconnect ${acc.id} failed: ${err.message}`);
        });
      } catch (err: any) {
        Logger.warn(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    Logger.warn(`[facebookIpc] reconnectAllFBAccounts error: ${err.message}`);
  }
}

