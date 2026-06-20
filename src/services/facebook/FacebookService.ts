/**
 * FacebookService.ts
 * Orchestrator singleton per account
 * Tương tự ZaloService — quản lý lifecycle session + listener + API calls
 */

import {
  FBSessionData, FBAccountStatus, FBSendOptions, FBSendResult,
  FBReactionAction, FBAttachmentUploadResult, FBThread, FBMQTTMessage,
  FBE2EEStatus, FBE2EEMessageRaw,
} from './FacebookTypes';
import { initSession, checkCookieAlive, fetchUserAvatarFromProfile, getUserInfoFacebookHtml } from './FacebookSession';
import { sendMessage as sendMessageREST, unsendMessage, addReaction, editMessage, forwardMessage, pinMessage, unpinMessage, createPoll, votePoll } from './FacebookMessageSender';
import { uploadAttachment } from './FacebookAttachment';
import {
  getThreadList, parseThreadNodes, fetchThreadMessages,
  changeThreadName, changeThreadEmoji, changeNickname,
  addGroupAdmin, removeGroupAdmin, changeApprovalMode,
  approvePendingMember, getGroupLink, setGroupLink,
} from './FacebookThreadManager';
import { blockUser, unblockUser } from './FacebookBlock';
import { changeThreadTheme } from './FacebookChangeTheme';
import { createNote } from './FacebookCreateNotes';
import { FacebookMQTTListener } from './FacebookMQTTListener';
import { FacebookE2EEBridge } from './FacebookE2EEBridge';
import { FacebookE2EESender } from './FacebookE2EESender';
import { parseE2EECookies, resolveE2EEBinaryPath, normalizeChatJid } from './FacebookUtils';
import EventBroadcaster from '../event/EventBroadcaster';
import DatabaseService from '../database/DatabaseService';
import FileStorageService from '../file/FileStorageService';
import { createProxyAgent } from '../../utils/ProxyHelper';
import { secureGet } from '../secure/SecureSettingsService';
import path from 'path';
import Logger from '../../utils/Logger';

// ─── Cookie key helper ─────────────────────────────────────────────────

function fbCookieKey(accountId: string): string {
  return `fb_cookie_${accountId}`;
}

export class FacebookService {
  private static instances = new Map<string, FacebookService>();

  private accountId: string;
  private cookie: string;
  private proxyId: number | null = null;
  private httpsAgent: any = undefined;
  private dataFB: FBSessionData | null = null;
  private _connectPromise: Promise<void> | null = null;
  private listener: FacebookMQTTListener | null = null;
  private status: FBAccountStatus = 'disconnected';
  private statusChangeCallback?: (status: FBAccountStatus) => void;
  /** Cached real Facebook UID — resolved once from DB, used for broadcasts */
  private _facebookId: string | null = null;

  // ─── E2EE Bridge ──────────────────────────────────────────────────────────
  private e2eeBridge: FacebookE2EEBridge | null = null;
  private e2eeSender: FacebookE2EESender | null = null;
  private e2eeStatus: FBE2EEStatus = 'disconnected';
  private e2eeEnabled: boolean = true; // Có thể disable nếu không tìm thấy binary
  /** Track thread IDs known to be E2EE-encrypted (auto-populated on error) */
  private e2eeThreads: Set<string> = new Set();
  /** Debounce avatar refresh — chỉ 1 lần mỗi user/session */
  private avatarRefreshDebounce = new Set<string>();
  /** Bridge instance ID — tăng mỗi lần startE2EEBridge, dùng để detect stale reconnect timers (BUG #6 fix) */
  private e2eeBridgeGen: number = 0;

  private constructor(accountId: string, cookie: string, proxyId?: number | null) {
    this.accountId = accountId;
    this.cookie = cookie;
    this.proxyId = proxyId ?? null;
    this.httpsAgent = this.resolveProxyAgent();
  }

  /** Tạo proxy agent từ proxyId */
  private resolveProxyAgent(): any {
    if (!this.proxyId) return undefined;
    try {
      const proxy = DatabaseService.getInstance().getProxyById(this.proxyId);
      if (proxy) return createProxyAgent(proxy);
    } catch {}
    return undefined;
  }

  /** Cập nhật proxy (gọi khi user đổi proxy cho account) */
  public setProxy(proxyId: number | null): void {
    this.proxyId = proxyId;
    this.httpsAgent = this.resolveProxyAgent();
  }

  /** Get real Facebook UID for broadcasts (cached) */
  private getFacebookId(): string {
    if (!this._facebookId) {
      try {
        const fbAcc = DatabaseService.getInstance().getFBAccount(this.accountId);
        if (fbAcc?.facebook_id) this._facebookId = fbAcc.facebook_id;
      } catch {}
    }
    return this._facebookId || this.accountId;
  }

  /**
   * Lấy hoặc tạo instance, đồng thời đảm bảo đã connect
   */
  /**
   * Resolve raw account ID về internal UUID để làm key trong instances map.
   * Tránh trùng lặp instance khi caller truyền numeric FB UID thay vì UUID.
   */
  private static resolveInstanceKey(rawId: string): string {
    if (!rawId) return rawId;
    // Nếu đã là UUID (có dấu gạch ngang) → trả về nguyên
    if (rawId.includes('-')) return rawId;
    // Nếu là Facebook UID (all digits) → tìm UUID từ DB
    if (/^\d+$/.test(rawId)) {
      try {
        const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(rawId);
        if (fbAcc?.id) return fbAcc.id;
      } catch {}
    }
    return rawId;
  }

  public static async getInstance(accountId: string, cookie?: string, proxyId?: number | null): Promise<FacebookService> {
    // Luôn resolve về internal UUID để tránh duplicate instance
    const instanceKey = FacebookService.resolveInstanceKey(accountId);

    if (!FacebookService.instances.has(instanceKey)) {
      // Nếu không có cookie, thử lấy từ secure storage
      if (!cookie) {
        try {
          // Sử dụng instanceKey (đã resolve) để lookup cookie
          cookie = secureGet(fbCookieKey(instanceKey)) || undefined;
          // Fallback: lấy từ DB (cookie_encrypted)
          if (!cookie) {
            const acc = DatabaseService.getInstance().getFBAccount(instanceKey);
            if (acc?.cookie_encrypted) cookie = acc.cookie_encrypted;
          }
        } catch {}
      }
      if (!cookie) throw new Error(`[FacebookService] Cookie required for new instance: ${accountId}`);
      const service = new FacebookService(instanceKey, cookie, proxyId);
      FacebookService.instances.set(instanceKey, service);
      // Tự động kết nối
      await service.connect();
    }
    return FacebookService.instances.get(instanceKey)!;
  }

  public static removeInstance(accountId: string): void {
    const instanceKey = FacebookService.resolveInstanceKey(accountId);
    const instance = FacebookService.instances.get(instanceKey);
    if (instance) {
      instance.disconnect().catch(() => {});
      FacebookService.instances.delete(instanceKey);
    }
  }

  public static getAllInstances(): FacebookService[] {
    return Array.from(FacebookService.instances.values());
  }

  public onStatusChange(cb: (status: FBAccountStatus) => void): void {
    this.statusChangeCallback = cb;
  }

  private setStatus(status: FBAccountStatus): void {
    this.status = status;
    EventBroadcaster.emit('fb:onConnectionStatus', {
      fbAccountId: this.getFacebookId(),
      status,
    });
    this.statusChangeCallback?.(status);
  }

  /**
   * Kết nối: init session + start MQTT listener
   */
  public async connect(): Promise<void> {
    // Nếu đang kết nối, trả về promise đang chạy
    if (this._connectPromise) return this._connectPromise;
    if (this.status === 'connected') return;

    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  private async _doConnect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      Logger.log(`[FacebookService:${this.accountId}] Already connected/connecting`);
      return;
    }

    this.setStatus('connecting');
    Logger.log(`[FacebookService:${this.accountId}] Connecting...`);

    // Cleanup old listener trước khi tạo mới — tránh memory leak + timer chồng chéo
    if (this.listener) {
      try {
        this.listener.disconnect();
      } catch {}
      this.listener = null;
    }

    try {
      // 1. Init session (with proxy support)
      this.dataFB = await initSession(this.cookie, this.httpsAgent);

      const fbId = this.dataFB.FacebookID;
      if (!fbId || fbId.includes('Unable') || !fbId.match(/^\d+$/)) {
        this.setStatus('cookie_expired');
        throw new Error('Cookie expired or invalid — cannot parse FacebookID');
      }

      // 2. Fetch latest seqId via GraphQL to avoid ERROR_QUEUE_OVERFLOW
      // Sending seq=0 asks Facebook to sync ALL messages → overflow on accounts with many messages
      let seqId = '0';
      try {
        const { getLastSeqId } = await import('./FacebookThreadManager');
        seqId = await getLastSeqId(this.dataFB, this.httpsAgent);
        Logger.log(`[FacebookService:${this.accountId}] Got lastSeqId=${seqId}`);
      } catch (seqErr: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Failed to get lastSeqId, using 0: ${seqErr.message}`);
      }

      // Load known E2EE threads from DB (persists across restarts)
      try {
        const e2eeIds = DatabaseService.getInstance().getE2EEThreadIds(this.accountId);
        if (e2eeIds.length > 0) {
          e2eeIds.forEach(id => this.e2eeThreads.add(id));
          Logger.log(`[FacebookService:${this.accountId}] Loaded ${e2eeIds.length} E2EE threads from DB`);
        }
      } catch (dbErr: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Failed to load E2EE threads: ${dbErr.message}`);
      }

      // 3. Start MQTT listener (with proxy support)
      this.listener = new FacebookMQTTListener(this.dataFB, this.accountId, seqId, this.httpsAgent);

      this.listener.on('message', (msg: FBMQTTMessage) => {
        this.handleIncomingMessage(msg);
      });

      this.listener.on('threadEvent', (data: any) => {
        this.handleThreadEvent(data);
      });

      this.listener.on('participantEvent', (data: any) => {
        this.handleGroupParticipantEvent(data);
      });

      this.listener.on('deliveryReceipt', (data: any) => {
        this.handleDeliveryReceipt(data);
      });

      this.listener.on('presence', (data: any) => {
        this.handlePresenceEvent(data);
      });

      this.listener.on('typing', (data: { threadId: string; userId: string; state: number }) => {
        EventBroadcaster.emit('fb:onTyping', {
          fbAccountId: this.getFacebookId(),
          threadId: data.threadId,
          userId: data.userId,
          isTyping: data.state === 1,
        });
      });

      this.listener.on('unsend', (data: { messageId: string; threadId: string }) => {
        if (data?.messageId) {
          try {
            DatabaseService.getInstance().updateFBMessageUnsent(data.messageId);
          } catch {}
          EventBroadcaster.emit('fb:onUnsend', {
            fbAccountId: this.getFacebookId(),
            messageId: data.messageId,
            threadId: data.threadId || '',
          });
        }
      });

      this.listener.on('reaction', (data: { messageId: string; reaction: string; actorFbId: string; threadId: string }) => {
        if (data?.messageId && data?.reaction) {
          this.persistReactionToDB(data.messageId, data.actorFbId || '', data.reaction);
          EventBroadcaster.emit('fb:onReaction', {
            fbAccountId: this.getFacebookId(),
            messageId: data.messageId,
            threadId: data.threadId || '',
            userId: data.actorFbId || '',
            emoji: data.reaction,
          });
        }
      });

      this.listener.on('connectionStatus', (s: FBAccountStatus) => {
        switch (s) {
          case 'connected':
            this.setStatus('connected');
            break;
          case 'disconnected':
            // Khi MQTT close → chuyển về disconnected để UI không hiển thị "đã kết nối"
            this.setStatus('disconnected');
            break;
          case 'cookie_expired':
            Logger.warn(`[FacebookService:${this.accountId}] MQTT health check — cookie expired`);
            this.setStatus('cookie_expired');
            try {
              const fbId = this.getFacebookId();
              if (fbId) {
                DatabaseService.getInstance().setListenerActive(fbId, false);
                EventBroadcaster.broadcastListenerDead(fbId, 'cookie_expired');
              }
            } catch {}
            break;
          case 'max_retries':
            Logger.warn(`[FacebookService:${this.accountId}] MQTT max retries (8) exhausted — marking dead`);
            this.setStatus('error');
            try {
              const fbId = this.getFacebookId();
              if (fbId) {
                DatabaseService.getInstance().setListenerActive(fbId, false);
                EventBroadcaster.broadcastListenerDead(fbId, 'max_retries');
              }
            } catch {}
            break;
          case 'error':
            this.setStatus('error');
            break;
        }
      });

      this.listener.on('error', (err: Error) => {
        Logger.warn(`[FacebookService:${this.accountId}] Listener error: ${err.message}`);
      });

      // Gắn health check callback — listener sẽ gọi định kỳ khi đang Phase 2 retry
      // để phát hiện cookie hết hạn và dừng retry đúng lúc
      const fbService = this;
      this.listener.setHealthCheckFn(async () => {
        try {
          return await fbService.checkCookieHealth();
        } catch {
          return true; // Không chắc chắn → cứ retry tiếp
        }
      });

      this.listener.connect();

      Logger.log(`[FacebookService:${this.accountId}] Connected (fbId=${fbId})`);

      // 4. Start E2EE bridge (cho 1:1 encrypted messages)
      await this.startE2EEBridge(fbId);
    } catch (err: any) {
      Logger.error(`[FacebookService:${this.accountId}] Connect error: ${err.message}`);
      if (this.status !== 'cookie_expired') {
        this.setStatus('error');
      }
      throw err;
    }
  }

  /**
   * Ngắt kết nối
   */
  public async disconnect(): Promise<void> {
    // Disconnect E2EE bridge first
    await this.stopE2EEBridge();

    if (this.listener) {
      this.listener.disconnect();
      this.listener = null;
    }
    this.setStatus('disconnected');
    Logger.log(`[FacebookService:${this.accountId}] Disconnected`);
  }

  /**
   * Health check: kiểm tra cookie + listener
   */
  public async checkHealth(): Promise<{ alive: boolean; listenerConnected: boolean; reason?: string }> {
    try {
      const cookieAlive = await checkCookieAlive(this.cookie, this.httpsAgent);
      const listenerConnected = this.listener?.isConnected() || false;

      if (!cookieAlive) {
        return { alive: false, listenerConnected, reason: 'cookie_expired' };
      }
      return { alive: true, listenerConnected };
    } catch (err: any) {
      return { alive: false, listenerConnected: false, reason: err.message };
    }
  }

  /**
   * Kiểm tra riêng cookie health (không check listener).
   * Dùng cho health check callback trong FacebookMQTTListener.
   * Return true nếu cookie còn sống, false nếu hết hạn.
   */
  public async checkCookieHealth(): Promise<boolean> {
    try {
      return await checkCookieAlive(this.cookie, this.httpsAgent);
    } catch {
      return false;
    }
  }

  /**
   * Cập nhật cookie (sau khi user re-login)
   */
  public async updateCookie(newCookie: string): Promise<void> {
    this.cookie = newCookie;
    await this.disconnect();
    await this.connect();
  }

  private handleIncomingMessage(msg: FBMQTTMessage): void {
    const threadId = msg.replyToID && msg.replyToID !== '0' ? msg.replyToID : null;
    const ts = parseInt(msg.timestamp) || Date.now();
    const isSelf = this.dataFB?.FacebookID && msg.userID === this.dataFB.FacebookID ? 1 : 0;

    Logger.log(`[FacebookService:${this.accountId}] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} userID=${msg.userID} isSelf=${isSelf} body="${(msg.body || '').slice(0,50)}" hasAttachment=${!!msg.attachments?.attachmentType} isE2EE=${msg.isE2EE} fbId=${this.dataFB?.FacebookID}`);
    Logger.log(`[FacebookService:${this.accountId}] [DEBUG] handleIncomingMessage: attachmentType=${msg.attachments?.attachmentType || '(none)'} attachmentUrl=${msg.attachments?.url || '(none)'} allAttachments=${msg.allAttachments?.length || 0}`);
    if (isSelf && msg.isE2EE) {
      Logger.log(`[FacebookService:${this.accountId}] [DEBUG] handleIncomingMessage SELF-ECHO E2EE: attachments=${JSON.stringify(msg.attachments).slice(0,200)} allAttachments=${msg.allAttachments ? JSON.stringify(msg.allAttachments).slice(0,200) : 'none'}`);
    }

    // BUG-2 FIX: Skip DB save for self-sent E2EE media echoes with incomplete data.
    // When user sends media via E2EE, the IPC handler (fb:sendAttachment/fb:sendAttachments)
    // saves the message to DB with correct attachment data (localPath, fileName, etc.).
    // The Go bridge then echoes the message back as an event, but the echo may carry
    // only placeholder data (e.g. body="🎬 Video" with no directPath/mediaKey, or
    // the body may be set to an auto-generated preview string like "🎬 Video"/"🎵 Audio").
    //
    // Skip the ENTIRE echo (DB save + broadcast) when:
    //   - It's a self-sent E2EE message
    //   - AND the data is unreliable (no directPath = incomplete echo, OR
    //     body is an icon-based preview string that would corrupt the display)
    const isSelfEchoMedia = isSelf && msg.isE2EE && (
      // Case 1: has attachmentType but no directPath → incomplete echo from bridge
      (!!(msg.attachments?.attachmentType) && !msg.attachments?.directPath) ||
      // Case 2: body is an icon-based preview string set by bridge (not real user text)
      // Matches 🖼 🎬 🎵 🎨 📎 icons used in attachmentPreview / lastMsgPreview
      (/^[🎵🎬🎨📎🖼]/.test(msg.body || ''))
    );
    if (isSelfEchoMedia) {
      Logger.log(`[FacebookService:${this.accountId}] SELF-ECHO E2EE media with incomplete data — skipping DB save (was already saved by IPC handler)`);
      return;
    }

    // Persist to DB
    if (threadId && msg.messageID) {
      try {
        const db = DatabaseService.getInstance();
        const hasAttachment = !!(msg.attachments?.id && msg.attachments.id !== 0 &&
          (msg.attachments.url || msg.attachments.attachmentType));

        // Determine type from attachment (use primary attachment)
        // Map E2EE sticker type to 'image' since FBMessageType doesn't include 'sticker'
        let rawType: string;
        if (!hasAttachment) {
          // No attachment → text message (body may be null/empty for deleted content)
          rawType = 'text';
        } else {
          rawType = msg.attachments.attachmentType || 'image';
        }
        const msgType = rawType;

        // Build attachment payload — support multiple attachments (batch image send)
        let attachmentPayload: string | undefined;
        if (msg.allAttachments && msg.allAttachments.length > 1) {
          attachmentPayload = JSON.stringify(msg.allAttachments.map(a => ({
            type: a.attachmentType || msgType,
            url: a.url,
            id: String(a.id),
            ...(a.name ? { name: a.name } : {}),
            ...(a.fileSize != null ? { fileSize: a.fileSize } : {}),
            ...(a.mimeType ? { mimeType: a.mimeType } : {}),
            // E2EE media download fields
            ...(a.directPath ? { directPath: a.directPath } : {}),
            ...(a.mediaKey ? { mediaKey: a.mediaKey } : {}),
            ...(a.mediaSha256 ? { mediaSha256: a.mediaSha256 } : {}),
            ...(a.mediaEncSha256 ? { mediaEncSha256: a.mediaEncSha256 } : {}),
          })));
        } else if (hasAttachment) {
          attachmentPayload = JSON.stringify([{
            type: msgType,
            url: msg.attachments.url,
            id: String(msg.attachments.id),
            ...(msg.attachments.name ? { name: msg.attachments.name } : {}),
            ...(msg.attachments.fileSize != null ? { fileSize: msg.attachments.fileSize } : {}),
            ...(msg.attachments.mimeType ? { mimeType: msg.attachments.mimeType } : {}),
            // E2EE media download fields (for re-download after restart)
            ...(msg.attachments.directPath ? { directPath: msg.attachments.directPath } : {}),
            ...(msg.attachments.mediaKey ? { mediaKey: msg.attachments.mediaKey } : {}),
            ...(msg.attachments.mediaSha256 ? { mediaSha256: msg.attachments.mediaSha256 } : {}),
            ...(msg.attachments.mediaEncSha256 ? { mediaEncSha256: msg.attachments.mediaEncSha256 } : {}),
          }]);
        }

        // Human-readable preview for last_message display
        const attachmentPreview = msgType === 'image' ? '🖼️ Hình ảnh'
          : msgType === 'video' ? '🎬 Video'
          : msgType === 'audio' ? '🎵 Audio'
          : rawType === 'sticker' ? '🎨 Sticker'
          : msg.attachments?.name ? `📎 ${msg.attachments.name}`
          : '📎 Tệp đính kèm';

        if (msgType === 'sticker') {
          Logger.log(`[FacebookService:${this.accountId}] [STICKER] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} rawType=${rawType} msgType=${msgType} hasAttachment=${hasAttachment} url=${(msg.attachments?.url || '').slice(0,100)}`);
        }
        Logger.log(`[FacebookService:${this.accountId}] Calling saveFBMessage: account_id=${this.accountId} thread_id=${threadId} type=${msgType} hasAttachment=${hasAttachment} reply_to_id=${msg.replyToMessageId || '(none)'}`);
        // @ts-ignore
        db.saveFBMessage({
          id: msg.messageID,
          account_id: this.accountId,
          thread_id: threadId,
          sender_id: msg.userID || '',
          body: msg.body || null,
          timestamp: ts,
          type: msgType,
          attachments: attachmentPayload,
          reply_to_id: msg.replyToMessageId,
          is_self: isSelf,
          is_unsent: 0,
        });

        // Note: fb_threads preview is updated inside saveFBMessage

        // Sync to unified contacts table
        const fbThread = db.queryOne?.(`SELECT name, type FROM fb_threads WHERE id = ? AND account_id = ?`, [threadId, this.accountId]) as any;
        let threadName = fbThread?.name || '';
        const contactType = fbThread?.type === 'group' ? 'group' : 'user';
        const fbIdForContacts = this.getFacebookId();

        // For 1:1 user contacts with no thread name (e.g. newly discovered E2EE thread),
        // try to resolve from existing contacts table
        if (!threadName && contactType === 'user') {
          const existingContact = db.queryOne?.(
            `SELECT display_name FROM contacts WHERE contact_id = ? AND channel = 'facebook' AND display_name != '' LIMIT 1`,
            [threadId]
          ) as { display_name?: string } | undefined;
          if (existingContact?.display_name) {
            threadName = existingContact.display_name;
          }
        }

        const lastMsgText = msg.body || (hasAttachment ? attachmentPreview : '');
        Logger.log(`[FacebookService:${this.accountId}] Syncing contacts: owner=${fbIdForContacts} thread=${threadId} name=${threadName} type=${contactType}`);
        db.run?.(
          `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
           VALUES (?, ?, ?, '', 0, ?, ?, ?, ?, 'facebook')
           ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
             display_name = CASE WHEN excluded.display_name != '' AND contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
             last_message = excluded.last_message,
             last_message_time = excluded.last_message_time,
             unread_count = CASE WHEN ? = 0 THEN contacts.unread_count + 1 ELSE contacts.unread_count END,
             channel = 'facebook'`,
          [this.getFacebookId(), threadId, threadName, contactType, isSelf ? 0 : 1, lastMsgText.slice(0, 200), ts, isSelf]
        );
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] DB persist error: ${err.message}`);
      }

      // Fire-and-forget: nếu là user 1-1 chưa có tên, fetch từ HTML
      if (msg.userID && /^\d+$/.test(msg.userID)) {
        this.checkAndFetchUserInfo(msg.userID);
      }

      // Fire-and-forget download non-E2EE attachments to local storage (like Zalo pattern)
      // Check primary AND allAttachments — batch sends may have URL only in allAttachments
      const hasDownloadableUrl = msg.attachments?.url
        ? !msg.attachments.directPath
        : msg.allAttachments?.some(a => a.url && !a.directPath) ?? false;
      if (hasDownloadableUrl) {
        this.downloadNonE2EEAttachments(msg, threadId).catch(err =>
          Logger.warn(`[FacebookService:${this.accountId}] downloadNonE2EEAttachments error: ${err.message}`)
        );
      }
    }

    // Broadcast — include isSelf + quote_data (if reply) so UI can display immediately
    let broadcastQuoteData: string | undefined;
    if (msg.replyToMessageId) {
      try {
        const dbInst = DatabaseService.getInstance();
        // Look up original message from fb_messages first, then unified messages
        const origRow = dbInst.queryOne<any>(
          `SELECT body, type FROM fb_messages WHERE id = ? AND account_id = ?`,
          [msg.replyToMessageId, this.accountId]
        );
        if (origRow) {
          broadcastQuoteData = JSON.stringify({
            msgId: msg.replyToMessageId,
            msg: origRow.body || '',
            senderId: msg.replyToSenderId || '',
            msgType: origRow.type || 'text',
          });
          Logger.log(`[FacebookService:${this.accountId}] [QUOTE] broadcast reply_to_id=${msg.replyToMessageId} content="${(origRow.body || '').slice(0,100)}"`);
        } else {
          // Fallback to unified messages table
          const origRow2 = dbInst.queryOne<any>(
            `SELECT content, msg_type FROM messages WHERE msg_id = ?`,
            [msg.replyToMessageId]
          );
          if (origRow2) {
            broadcastQuoteData = JSON.stringify({
              msgId: msg.replyToMessageId,
              msg: origRow2.content || '',
              senderId: msg.replyToSenderId || '',
              msgType: origRow2.msg_type || 'text',
            });
          }
        }
      } catch {}
    }
    EventBroadcaster.emit('fb:onMessage', {
      fbAccountId: this.getFacebookId(),
      message: {
        ...msg,
        isSelf: !!isSelf,
        ...(broadcastQuoteData ? { quote_data: broadcastQuoteData } : {}),
      },
    });
    Logger.log(`[FacebookService:${this.accountId}] ${isSelf ? '[ECHO]' : 'Incoming'} message from ${msg.userID}: ${msg.body?.slice(0, 50) || (msg.attachments?.attachmentType ? `[${msg.attachments.attachmentType}${msg.attachments.name ? ': ' + msg.attachments.name : ''}]` : '[attachment]')}`);
  }

  // ─── MQTT Delta Event Handlers (I4) ──────────────────────────────────────

  /** Handle thread info changes (name, emoji, nickname) from MQTT delta */
  private handleThreadEvent(data: any): void {
    if (!data?.threadId) return;

    try {
      const db = DatabaseService.getInstance();
      const fbIdForContacts = this.getFacebookId();

      if (data.type === 'name' && data.name) {
        // Update fb_threads table
        db.run?.(
          `UPDATE fb_threads SET name = ? WHERE id = ? AND account_id = ?`,
          [data.name, data.threadId, this.accountId]
        );
        // Update unified contacts table — use display_name
        db.run?.(
          `UPDATE contacts SET display_name = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
          [data.name, fbIdForContacts, data.threadId]
        );

        EventBroadcaster.emit('fb:onThreadInfoUpdate', {
          fbAccountId: fbIdForContacts,
          threadId: data.threadId,
          type: 'name',
          name: data.name,
        });
      } else if (data.type === 'emoji' && data.emoji) {
        db.run?.(
          `UPDATE fb_threads SET emoji = ? WHERE id = ? AND account_id = ?`,
          [data.emoji, data.threadId, this.accountId]
        );

        EventBroadcaster.emit('fb:onThreadInfoUpdate', {
          fbAccountId: fbIdForContacts,
          threadId: data.threadId,
          type: 'emoji',
          emoji: data.emoji,
        });
      }
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] handleThreadEvent error: ${err.message}`);
    }
  }

  /** Handle group participant changes (added / left) from MQTT delta */
  private handleGroupParticipantEvent(data: any): void {
    if (!data?.threadId) return;

    try {
      const db = DatabaseService.getInstance();
      const fbIdForContacts = this.getFacebookId();

      if (data.type === 'left') {
        // Decrement participant count in fb_threads
        db.run?.(
          `UPDATE fb_threads SET participant_count = MAX(0, participant_count - 1) WHERE id = ? AND account_id = ?`,
          [data.threadId, this.accountId]
        );
      } else if (data.type === 'added' && data.participants?.length > 0) {
        db.run?.(
          `UPDATE fb_threads SET participant_count = participant_count + ? WHERE id = ? AND account_id = ?`,
          [data.participants.length, data.threadId, this.accountId]
        );
      }

      EventBroadcaster.emit('fb:onGroupEvent', {
        fbAccountId: fbIdForContacts,
        threadId: data.threadId,
        type: data.type === 'left' ? 'participant_left' : 'participant_added',
        participantId: data.participantId,
        participants: data.participants,
        actorFbId: data.actorFbId,
      });
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] handleGroupParticipantEvent error: ${err.message}`);
    }
  }

  /** Handle delivery receipt (seen) from MQTT delta */
  private handleDeliveryReceipt(data: any): void {
    if (!data?.threadId || !data?.actorFbId) return;

    // Skip self-receipts (when our own messages are delivered)
    if (data.actorFbId === this.getFacebookId()) return;

    EventBroadcaster.emit('fb:onSeen', {
      fbAccountId: this.getFacebookId(),
      threadId: data.threadId,
      userId: data.actorFbId,
      timestamp: data.timestampMs || Date.now(),
    });
  }

  /** Handle Orca presence data from MQTT (I7) */
  private handlePresenceEvent(data: any): void {
    if (!data?.entries?.length) return;

    EventBroadcaster.emit('fb:onPresence', {
      fbAccountId: this.getFacebookId(),
      entries: data.entries,
    });
  }

  // ─── E2EE Bridge Management ────────────────────────────────────────────────

  /**
   * Khởi động E2EE bridge cho 1:1 encrypted messages.
   * NON-FATAL: nếu binary không tồn tại → groups vẫn hoạt động bình thường.
   */
  private async startE2EEBridge(fbId: string): Promise<void> {
    if (!this.e2eeEnabled) {
      Logger.log(`[FacebookService:${this.accountId}] E2EE disabled — skipping bridge`);
      return;
    }

    let binaryPath: string;
    try {
      binaryPath = resolveE2EEBinaryPath();
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge binary not found: ${err.message}`);
      Logger.warn(`[FacebookService:${this.accountId}] → 1:1 encrypted messages will NOT be available.`);
      Logger.warn(`[FacebookService:${this.accountId}] → Group messages still work via MQTT.`);
      this.e2eeEnabled = false;
      return;
    }

    this.setE2EEStatus('connecting');

    try {
      // 1. Spawn Go bridge
      this.e2eeBridge = new FacebookE2EEBridge(binaryPath);
      this.e2eeBridge.spawn();
      const bridgeInstance = this.e2eeBridge;
      const bridgeGen = ++this.e2eeBridgeGen; // BUG #6 fix: track instance for stale timer detection

      // 2. Parse E2EE cookies
      let cookies: Record<string, string>;
      try {
        cookies = parseE2EECookies(this.cookie);
      } catch (err: any) {
        Logger.error(`[FacebookService:${this.accountId}] E2EE: ${err.message}`);
        this.e2eeBridge.close().catch(() => {});
        this.e2eeBridge = null;
        this.setE2EEStatus('error');
        // Still non-fatal — groups work
        return;
      }

      // 3. newClient + connect + connectE2EE
      await this.e2eeBridge.newClient({
        cookies,
        logLevel: 'none',
        e2eeMemoryOnly: true,
      });

      // Timeout ngắn để không block group messaging nếu bridge không respond
      const info = await this.e2eeBridge.connect(30000);
      Logger.log(`[FacebookService:${this.accountId}] E2EE bridge connected: user=${JSON.stringify((info as any)?.user?.id ?? '?')}`);

      await this.e2eeBridge.connectE2EE(20000);
      Logger.log(`[FacebookService:${this.accountId}] E2EE pairing complete`);

      this.setE2EEStatus('connected');

      // 4. Create sender (reuses bridge)
      this.e2eeSender = new FacebookE2EESender({ mode: 'reuse', bridge: this.e2eeBridge });

      // 5. Listen for events from bridge
      this.e2eeBridge.on('event', (evt: any) => {
        this.handleBridgeEvent(evt);
      });

      // BUG #6 fix: dùng bridgeGen để detect stale timer
      this.e2eeBridge.on('closed', (code: number | null) => {
        Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge closed (code=${code}, gen=${bridgeGen})`);
        // Chỉ clear nếu bridge hiện tại vẫn là instance này
        if (this.e2eeBridge === bridgeInstance) {
          this.e2eeBridge = null;
        }
        this.setE2EEStatus('disconnected');
        // Auto-reconnect nếu service vẫn connected và bridge chưa được thay thế
        if (this.isConnected()) {
          Logger.log(`[FacebookService:${this.accountId}] E2EE bridge closed — attempting reconnect in 10s...`);
          setTimeout(() => {
            // BUG #6 fix: chỉ reconnect nếu bridge instance không thay đổi
            // và e2eeBridgeGen không tăng (không có bridge mới được tạo)
            if (this.isConnected() && this.e2eeBridgeGen === bridgeGen && !this.e2eeBridge?.isAlive()) {
              this.startE2EEBridge(fbId).catch(() => {});
            }
          }, 10000);
        }
      });

      this.e2eeBridge.on('error', (err: Error) => {
        Logger.error(`[FacebookService:${this.accountId}] E2EE bridge error: ${err.message}`);
      });

    } catch (err: any) {
      Logger.error(`[FacebookService:${this.accountId}] E2EE bridge start failed: ${err.message}`);
      if (this.e2eeBridge) {
        this.e2eeBridge.close().catch(() => {});
        this.e2eeBridge = null;
      }
      this.e2eeSender = null;
      this.setE2EEStatus('error');
      // NON-FATAL: groups still work via MQTT
    }
  }

  private async stopE2EEBridge(): Promise<void> {
    if (this.e2eeBridge) {
      await this.e2eeBridge.close().catch(() => {});
      this.e2eeBridge = null;
    }
    this.e2eeSender = null;
    this.setE2EEStatus('disconnected');
  }

  /**
   * Xử lý tất cả events từ Go bridge.
   * e2eeMessage → normalize → same handleIncomingMessage() as MQTT
   */
  private handleBridgeEvent(evt: any): void {
    const type = evt?.type;
    const data = evt?.data;
    Logger.log(`[FacebookService:${this.accountId}] [BRIDGE_EVENT] type=${type} data=${JSON.stringify(data).slice(0, 200)}`);

    switch (type) {
      case 'e2eeMessage':
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG] handleBridgeEvent: received e2eeMessage event`);
        this.handleE2EEMessage(data);
        break;

      case 'message':
        // Non-E2EE message from bridge (same as MQTT) — normalize & route
        this.handleBridgeGroupMessage(data);
        break;

      case 'ready':
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge ready (isNewSession=${data?.isNewSession})`);
        break;

      case 'e2eeConnected':
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge: e2eeConnected`);
        this.setE2EEStatus('connected');
        break;

      case 'disconnected':
        Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge: disconnected ${JSON.stringify(data)}`);
        break;

      case 'error':
        Logger.error(`[FacebookService:${this.accountId}] E2EE bridge event error: ${JSON.stringify(data)}`);
        break;

      case 'raw':
        // Raw MQTT delta forwarded by bridge — log at debug level only
        break;

      // ─── Bridge event types (C8) ────────────────────────────────────────
      case 'reaction': {
        // data: { messageId, threadId, userId, emoji, action }
        if (data?.messageId) {
          const userId = data.userId || data.senderId || '';
          if (data.emoji) {
            this.persistReactionToDB(data.messageId, userId, data.emoji);
          }
          EventBroadcaster.emit('fb:onReaction', {
            fbAccountId: this.getFacebookId(),
            messageId: data.messageId,
            threadId: data.threadId || data.chatJid || '',
            userId,
            emoji: data.emoji || '',
          });
        }
        break;
      }

      case 'unsend': {
        // data: { messageId, threadId }
        if (data?.messageId) {
          try {
            DatabaseService.getInstance().updateFBMessageUnsent(data.messageId);
          } catch {}
          EventBroadcaster.emit('fb:onUnsend', {
            fbAccountId: this.getFacebookId(),
            messageId: data.messageId,
            threadId: data.threadId || data.chatJid || '',
          });
        }
        break;
      }

      case 'seen': {
        // data: { threadId, userId, timestampMs }
        if (data?.threadId) {
          EventBroadcaster.emit('fb:onSeen', {
            fbAccountId: this.getFacebookId(),
            threadId: data.threadId,
            userId: data.userId || '',
            timestamp: data.timestampMs || Date.now(),
          });
        }
        break;
      }

      case 'typing': {
        // data: { threadId, userId, isTyping }
        if (data?.threadId) {
          EventBroadcaster.emit('fb:onTyping', {
            fbAccountId: this.getFacebookId(),
            threadId: data.threadId,
            userId: data.userId || '',
            isTyping: data.isTyping !== false,
          });
        }
        break;
      }

      case 'e2eeReceipt':
        // Delivery receipt for E2EE messages — informational only
        // The bridge handles delivery tracking internally
        break;

      case 'messageUnsend': {
        // E2EE 1:1 message unsend from bridge
        // data: { isE2EE, messageId, threadId }
        if (data?.messageId) {
          const stripJid = (id: string) => id.replace(/@.*$/, '');
          const threadId = data.threadId ? stripJid(String(data.threadId)) : '';
          try {
            DatabaseService.getInstance().updateFBMessageUnsent(data.messageId);
          } catch {}
          EventBroadcaster.emit('fb:onUnsend', {
            fbAccountId: this.getFacebookId(),
            messageId: data.messageId,
            threadId,
          });
        }
        break;
      }

      case 'e2eeReaction': {
        // E2EE 1:1 reaction from bridge
        // data: { chatJid, messageId, reaction, senderId, senderJid }
        if (data?.messageId && data?.reaction) {
          const stripJid = (id: string) => id.replace(/@.*$/, '');
          const threadId = data.chatJid ? stripJid(String(data.chatJid)) : '';
          const userId = String(data.senderId || data.senderJid?.replace(/:.*$/, '') || '');
          this.persistReactionToDB(data.messageId, userId, data.reaction);
          EventBroadcaster.emit('fb:onReaction', {
            fbAccountId: this.getFacebookId(),
            messageId: data.messageId,
            threadId,
            userId,
            emoji: data.reaction,
          });
        }
        break;
      }

      case 'messageEdit': {
        // E2EE 1:1 message edit from bridge
        // data: { messageId, threadId, newText, editCount, timestampMs }
        if (data?.messageId && data?.newText !== undefined) {
          const stripJid = (id: string) => id.replace(/@.*$/, '');
          // threadId=0 means bridge couldn't determine thread — pass empty string
          // so store will search across all threads by messageId
          const threadId = data.threadId != null && data.threadId !== 0
            ? stripJid(String(data.threadId))
            : '';
          try {
            DatabaseService.getInstance().updateFBMessageEdit(
              data.messageId,
              data.newText,
              data.editCount || 0,
              data.timestampMs || Date.now()
            );
          } catch (err: any) {
            Logger.warn(`[FacebookService:${this.accountId}] messageEdit DB error: ${err.message}`);
          }
          EventBroadcaster.emit('fb:onEdit', {
            fbAccountId: this.getFacebookId(),
            messageId: data.messageId,
            threadId,
            newText: data.newText,
            editCount: data.editCount || 0,
            timestampMs: data.timestampMs || Date.now(),
          });
        }
        break;
      }

      default:
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge unknown event: ${type}`);
    }
  }

  /**
   * Normalize E2EE message từ bridge → FBMQTTMessage → handleIncomingMessage()
   * Shape tương thích với MQTT message để UI xử lý thống nhất.
   */
  // @ts-ignore — gọi từ handleBridgeEvent
  private handleE2EEMessage(data: FBE2EEMessageRaw): void {
    if (!data) {
      Logger.log(`[FacebookService:${this.accountId}] handleE2EEMessage: data is null/undefined`);
      return;
    }

    // Log FULL raw bridge data for debugging
    Logger.log(`[FacebookService:${this.accountId}] [DEBUG] handleE2EEMessage FULL: ${JSON.stringify(data)}`);
    if (data.attachments?.length) {
      Logger.log(`[FacebookService:${this.accountId}] [DEBUG] E2EE raw attachments: ${JSON.stringify(data.attachments)}`);
      // Check for E2EE media download fields specifically
      for (let i = 0; i < data.attachments.length; i++) {
        const a = data.attachments[i] as any;
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG] Attachment[${i}]: type=${a.type || a.attachmentType} url=${a.url || '(none)'} directPath=${a.directPath ? 'YES' : 'MISSING'} mediaKey=${a.mediaKey ? 'YES' : 'MISSING'} fileName=${a.fileName || '(none)'} mimeType=${a.mimeType || '(none)'} fileSize=${a.fileSize ?? '(none)'}`);
      }
    }

    // Strip @msgr JID suffix from threadId for DB consistency
    // fb_threads stores plain numeric IDs, not JIDs
    // threadId tu bridge co the la number hoac string
    const stripJid = (id: string) => id.replace(/@.*$/, '');
    const threadId = data.threadId != null
      ? stripJid(String(data.threadId))
      : '';

    const msg: FBMQTTMessage = {
      body: data.text || null,
      timestamp: String(data.timestampMs || Date.now()),
      userID: data.senderId != null ? String(data.senderId) : '',
      messageID: data.id || '',
      replyToID: threadId,
      type: 'user', // E2EE luôn là 1:1
      attachments: {
        id: 0,
        url: null,
      },
      isE2EE: true,
      chatJid: data.chatJid,
      senderJid: data.senderJid,
      // Extract replyTo info from bridge data — tin nhắn trả lời tin nhắn khác
      replyToMessageId: data.replyTo?.messageId,
      replyToSenderId: data.replyTo?.senderId != null ? String(data.replyTo.senderId) : undefined,
    };

    // Parse attachments nếu có
    // Go bridge Attachment struct sends: type (lowercase), url, fileName, mimeType,
    // fileSize, width, height, stickerId, mediaKey, mediaSha256, directPath, ...
    // KHÔNG có trường "id" hay "attachmentType" — cần map đúng tên
    // E2EE media (image/video/audio/file) không có URL mà có directPath + mediaKey
    // để download qua bridge — cần preserve để lưu DB và download sau này
    if (data.attachments?.length) {
      const raw = data.attachments as any[];
      const mapped = raw.map((a: any, idx: number) => ({
        id: a.stickerId || idx + 1,                    // Go: không có id, dùng index
        url: a.url || null,                             // Go: url (null với E2EE image)
        attachmentType: a.type || a.attachmentType,     // Go: "type" (lowercase) — image/video/file/audio
        name: a.fileName || a.name,                     // Go: "fileName" (not "name")
        fileSize: a.fileSize,
        mimeType: a.mimeType,
        // Preserve E2EE media download fields (needed for downloadE2EEAttachments and DB persistence)
        directPath: a.directPath,
        mediaKey: a.mediaKey,
        mediaSha256: a.mediaSha256,
        mediaEncSha256: a.mediaEncSha256,
      }));

      msg.attachments = mapped[0];
      if (mapped.length > 1) {
        msg.allAttachments = mapped;
      }

      Logger.log(`[FacebookService:${this.accountId}] [DEBUG] After mapping: attachmentType=${msg.attachments.attachmentType} hasDirectPath=${!!msg.attachments.directPath} hasMediaKey=${!!msg.attachments.mediaKey}`);
    } else {
      Logger.log(`[FacebookService:${this.accountId}] [DEBUG] No attachments in E2EE message data`);
    }

    Logger.log(`[FacebookService:${this.accountId}] [DEBUG] E2EE normalized msg: type=${msg.attachments?.attachmentType||'text'} hasAttachment=${!!(msg.attachments?.attachmentType)} calling handleIncomingMessage`);
    this.handleIncomingMessage(msg);

    // Auto-download E2EE media (image/video/audio/file) sau khi save message
    const e2eeAttachments = data.attachments as any[] | undefined;
    if (e2eeAttachments?.length && msg.messageID) {
      this.downloadE2EEAttachments(e2eeAttachments, msg.messageID, threadId);
    } else {
    }
  }

  /**
   * Handle non-E2EE group messages from bridge (bridge can also receive these)
   */
  private handleBridgeGroupMessage(data: any): void {
    if (!data?.id) return;

    // Handle admin messages (pin, poll, group info changes) as system notifications.
    // The bridge processes the raw delta internally (e.g. deltaUpdatePinnedMessagesV2)
    // and ALSO emits a human-readable message event with isAdminMsg=true.
    // We save these as type='system' so the UI renders them as centered notification text,
    // NOT as regular chat bubbles.
    if (data.isAdminMsg) {
      this.handleAdminGroupMessage(data);
      return;
    }

    const stripJid = (id: string) => id.replace(/@.*$/, '');
    const threadId = data.threadId ? stripJid(String(data.threadId)) : '0';

    const msg: FBMQTTMessage = {
      body: data.text || null,
      timestamp: String(data.timestampMs || Date.now()),
      userID: data.senderId != null ? String(data.senderId) : '',
      messageID: data.id,
      replyToID: threadId,
      replyToMessageId: data.replyTo?.messageId,
      type: 'group',
      attachments: { id: 0, url: null },
    };

    this.handleIncomingMessage(msg);
  }

  /**
   * Handle admin activity messages (pin, poll, group info changes) from bridge as system notifications.
   * Saves with type='system' and broadcasts msg_type='system' so the UI renders them as centered
   * notification text in the chat, NOT as regular message bubbles.
   */
  private handleAdminGroupMessage(data: any): void {
    const stripJid = (id: string) => id.replace(/@.*$/, '');
    const threadId = data.threadId ? stripJid(String(data.threadId)) : '0';
    const fbId = this.getFacebookId();
    const ts = parseInt(data.timestampMs) || Date.now();
    const isSelf = data.senderId === fbId ? 1 : 0;

    Logger.log(`[FacebookService:${this.accountId}] Saving admin message as system: msgId=${data.id} threadId=${threadId} text="${(data.text || '').slice(0, 100)}"`);

    // Save to DB with type='system' — saveFBMessage handles fb_messages + unified messages + thread preview + contacts
    try {
      DatabaseService.getInstance().saveFBMessage({
        id: data.id,
        account_id: this.accountId,
        thread_id: threadId,
        sender_id: String(data.senderId || ''),
        body: data.text || null,
        timestamp: ts,
        type: 'system',
        attachments: undefined,
        reply_to_id: undefined,
        is_self: isSelf,
        is_unsent: 0,
      });
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] handleAdminGroupMessage DB error: ${err.message}`);
    }

    // Broadcast as system notification — UI's normalizeFBMessage respects msg_type override
    EventBroadcaster.emit('fb:onMessage', {
      fbAccountId: fbId,
      message: {
        messageID: data.id,
        body: data.text || null,
        timestamp: String(data.timestampMs || Date.now()),
        userID: String(data.senderId || ''),
        replyToID: threadId,
        type: data.threadType === 2 ? 'group' : 'user',
        attachments: { id: 0, url: null },
        isSelf: false,
        msg_type: 'system',
      },
    });
  }

  /**
   * Tải xuống và giải mã E2EE media attachments (image/video/audio/file) từ Go bridge.
   * Lưu file đã giải mã vào local storage và cập nhật DB.
   */
  private async downloadE2EEAttachments(attachments: any[], messageId: string, threadId: string): Promise<void> {
    if (!this.e2eeBridge?.isAlive()) {
      return;
    }

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      if (!att.directPath || !att.mediaKey) {
        if (att.type === 'sticker') {
          Logger.warn(`[FacebookService:${this.accountId}] [E2EE] Sticker missing directPath/mediaKey — bridge không cung cấp dữ liệu download cho sticker, cần fix Go bridge (mautrix-meta) để extract sticker attachment fields`);
        }
        continue;
      }

      try {
        const result = await this.e2eeBridge.downloadE2EEAttachment({
          directPath: att.directPath,
          mediaKey: att.mediaKey,
          mediaSha256: att.mediaSha256 || '',
          mediaEncSha256: att.mediaEncSha256 || '',
          mediaType: att.type || 'image',
          mimeType: att.mimeType || '',
          fileSize: att.fileSize || 0,
        });

        if (result?.data) {
          const buffer = Buffer.from(result.data, 'base64');
          const ext = this.getExtFromMime(result.mimeType) || '.bin';
          const filename = `e2ee_${messageId.slice(-8)}_${Date.now()}${ext}`;

          const localPath = await FileStorageService.saveBuffer(
            this.getFacebookId() || this.accountId,
            buffer,
            filename,
          );

          const relativePath = FileStorageService.toRelativePath(localPath);
          const fbId = this.getFacebookId() || this.accountId;

          DatabaseService.getInstance().updateLocalPaths(
            fbId,
            messageId,
            { main: relativePath },
          );

          // Notify UI to re-render with local path
          EventBroadcaster.emit('event:localPath', {
            zaloId: fbId,
            msgId: messageId,
            threadId,
            localPaths: { main: relativePath },
          });

          Logger.log(`[FacebookService:${this.accountId}] E2EE media saved: ${relativePath}`);
        }
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] E2EE download failed: ${err.message}`);
      }
    }
  }

  /**
   * Kiểm tra contact đã có tên chưa, nếu chưa thì fetch từ Facebook HTML.
   * Fire-and-forget — gọi khi nhận message đầu tiên, update DB sau đó.
   * Chỉ áp dụng cho user 1-1 (group không support).
   */
  private async checkAndFetchUserInfo(fbUserId: string): Promise<void> {
    try {
      // Check DB trước: nếu đã có tên và avatar thì skip
      const db = DatabaseService.getInstance();
      const existing = db.queryOne?.(
        `SELECT display_name, avatar_url FROM contacts WHERE contact_id = ? AND channel = 'facebook' LIMIT 1`,
        [fbUserId]
      ) as { display_name?: string; avatar_url?: string } | undefined;
      if (existing?.display_name && existing?.avatar_url) return;

      const session = this.requireSession();
      const info = await getUserInfoFacebookHtml(session.cookieFacebook, fbUserId);
      if (!info || (!info.name && !info.avatarUrl)) return;
      Logger.log(`[FacebookService:${this.accountId}] checkAndFetchUserInfo: ${fbUserId} → name="${info.name}"`);
      if (info.name) {
        db.run?.(
          `UPDATE contacts SET display_name = ?, avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
          [info.name, info.avatarUrl || '', this.getFacebookId(), fbUserId]
        );
      } else if (info.avatarUrl) {
        db.run?.(
          `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
          [info.avatarUrl, this.getFacebookId(), fbUserId]
        );
      }
      // Broadcast để UI cập nhật ngay
      EventBroadcaster.emit('fb:onContactUpdate', {
        fbAccountId: this.getFacebookId(),
        contactId: fbUserId,
        name: info.name || '',
        avatarUrl: info.avatarUrl || '',
      });
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] checkAndFetchUserInfo error: ${err.message}`);
    }
  }

  /**
   * Download non-E2EE image/file attachments to local storage (same as Zalo pattern).
   * FB CDN URLs expire, so we download immediately on receive while the URL is fresh.
   */
  private async downloadNonE2EEAttachments(msg: FBMQTTMessage, threadId: string): Promise<void> {
    const fbId = this.getFacebookId() || this.accountId;
    const cookies = this.dataFB?.cookieFacebook;
    const localPaths: Record<string, string> = {};
    const attachments = msg.allAttachments?.length ? msg.allAttachments : [msg.attachments];

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      if (!att.url || att.directPath) continue;

      try {
        const url = String(att.url);
        const ext = (() => { try { return path.extname(new URL(url).pathname) || '.bin'; } catch { return '.bin'; } })();
        const filename = `fb_${msg.messageID.slice(-8)}_${Date.now()}${ext}`;

        // Dùng đúng method theo loại file — audio/file không thể dùng downloadImage
        const attType = att.attachmentType || '';
        let localPath: string;
        if (attType === 'image' || attType === 'sticker') {
          localPath = await FileStorageService.downloadImage(fbId, url, filename, cookies, undefined, 'https://www.facebook.com/');
        } else if (attType === 'video') {
          localPath = await FileStorageService.downloadVideo(fbId, url, filename, cookies, undefined);
        } else {
          // audio, file, unknown → dùng downloadFile
          localPath = await FileStorageService.downloadFile(fbId, url, filename, cookies, undefined);
        }
        if (localPath) {
          localPaths[`att_${i}`] = localPath;
        }
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Failed to download attachment ${i}: ${err.message}`);
      }
    }

    if (Object.keys(localPaths).length > 0) {
      DatabaseService.getInstance().updateLocalPaths(fbId, msg.messageID, localPaths);
      EventBroadcaster.emit('event:localPath', {
        zaloId: fbId,
        msgId: msg.messageID,
        threadId,
        localPaths,
      });
    }
  }

  /** Lấy extension file từ MIME type */
  private getExtFromMime(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'audio/mpeg': '.mp3',
      'audio/ogg': '.ogg',
      'audio/mp4': '.m4a',
      'application/pdf': '.pdf',
    };
    return map[mime] || '';
  }

  private setE2EEStatus(status: FBE2EEStatus): void {
    this.e2eeStatus = status;
    EventBroadcaster.emit('fb:onE2EEStatus', {
      fbAccountId: this.getFacebookId(),
      status,
    });
  }

  /**
   * Retry E2EE bridge connection on-demand (e.g., when user tries to send 1:1 message).
   * Resets state and re-attempts bridge startup.
   */
  public async retryE2EE(): Promise<void> {
    // Clean up stale bridge
    await this.stopE2EEBridge();
    // Reset flags so startE2EEBridge will attempt again
    this.e2eeEnabled = true;
    this.e2eeStatus = 'disconnected';

    const fbId = this.getFacebookId() || this.dataFB?.FacebookID;
    if (!fbId) return;
    await this.startE2EEBridge(fbId);
  }

  // ─── E2EE Public Methods ──────────────────────────────────────────────────

  /** Gửi tin nhắn E2EE 1:1 */
  public async sendE2EEMessage(
    chatJid: string,
    text: string,
    opts?: FBSendOptions,
  ): Promise<FBSendResult> {
    if (!this.e2eeSender) {
      return { success: false, error: 'E2EE not connected' };
    }
    const result = await this.e2eeSender.send(
      chatJid,
      text,
      opts?.replyToMessageId || '',
    );
    return {
      success: result.success,
      messageId: result.messageId,
      timestamp: result.timestamp,
      error: result.error,
    };
  }

  /** Kiểm tra E2EE có đang kết nối */
  public isE2EEConnected(): boolean {
    return this.e2eeStatus === 'connected' && this.e2eeBridge?.isAlive() === true;
  }

  /** Lấy trạng thái E2EE hiện tại */
  public getE2EEStatus(): FBE2EEStatus {
    return this.e2eeStatus;
  }

  /** Lấy sender instance (for external use) */
  public getE2EESender(): FacebookE2EESender | null {
    return this.e2eeSender;
  }

  /** Gửi ảnh qua E2EE 1:1 */
  public async sendE2EEImage(
    chatJid: string,
    imagePath: string,
    caption?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendImage(chatJid, imagePath, caption);
  }

  /** Gửi video qua E2EE 1:1 */
  public async sendE2EEVideo(
    chatJid: string,
    videoPath: string,
    caption?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendVideo(chatJid, videoPath, caption);
  }

  /** Gửi audio qua E2EE 1:1 */
  public async sendE2EEAudio(
    chatJid: string,
    audioPath: string,
    mimeType?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendAudio(chatJid, audioPath, mimeType);
  }

  /** Gửi file qua E2EE 1:1 */
  public async sendE2EEFile(
    chatJid: string,
    filePath: string,
    fileName?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendFile(chatJid, filePath, fileName);
  }

  /** Gửi reaction cho tin nhắn E2EE 1:1 */
  public async sendE2EEReaction(
    chatJid: string,
    messageId: string,
    senderJid: string,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendReaction(chatJid, messageId, senderJid, emoji);
  }

  /** Gửi sticker qua E2EE 1:1 (C4) */
  public async sendE2EESticker(
    chatJid: string,
    stickerId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendSticker(chatJid, stickerId);
  }

  /** Gửi typing indicator qua bridge */
  public async sendTyping(
    threadId: string,
    isTyping: boolean,
    isGroup: boolean = false,
  ): Promise<void> {
    if (this.e2eeBridge?.isAlive()) {
      try {
        await this.e2eeBridge.sendTyping({ threadId, isTyping, isGroup });
      } catch {}
    }
  }

  /** Đánh dấu thread đã đọc trên Facebook server (qua bridge) */
  public async markReadOnServer(threadId: string): Promise<void> {
    if (this.e2eeBridge?.isAlive()) {
      try {
        await this.e2eeBridge.markRead({ threadId });
      } catch {}
    }
  }

  /** Gửi tin nhắn vào group qua bridge (non-E2EE) */
  public async sendBridgeMessage(
    threadId: string,
    text: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.e2eeBridge?.isAlive()) {
      return { success: false, error: 'Bridge not connected' };
    }
    try {
      const result = await this.e2eeBridge.sendMessage({ threadId, text });
      return { success: true, messageId: result.messageId, error: undefined };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Gửi ảnh vào group qua bridge (non-E2EE) */
  public async sendBridgeImage(
    threadId: string,
    imagePath: string,
    caption?: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.e2eeBridge?.isAlive()) {
      return { success: false, error: 'Bridge not connected' };
    }
    try {
      const result = await this.e2eeBridge.sendImage({ threadId, imagePath, caption });
      return { success: true, messageId: result.messageId, error: undefined };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Gửi file vào group qua bridge (non-E2EE) */
  public async sendBridgeFile(
    threadId: string,
    filePath: string,
    fileName?: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.e2eeBridge?.isAlive()) {
      return { success: false, error: 'Bridge not connected' };
    }
    try {
      const result = await this.e2eeBridge.sendFile({ threadId, filePath, fileName });
      return { success: true, messageId: result.messageId, error: undefined };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Gửi reaction vào group qua bridge (non-E2EE) */
  public async sendBridgeReaction(
    threadId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.e2eeBridge?.isAlive()) {
      return { success: false, error: 'Bridge not connected' };
    }
    try {
      await this.e2eeBridge.sendReaction({ threadId, messageId, emoji });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Check if E2EE is available (binary exists + enabled) */
  public isE2EEAvailable(): boolean {
    return this.e2eeEnabled;
  }

  // ─── Public API methods ──────────────────────────────────────────────────────

  private requireSession(): FBSessionData {
    if (!this.dataFB) throw new Error('Not connected — call connect() first');
    return this.dataFB;
  }

  /**
   * Gửi tin nhắn với E2EE auto-detect.
   * Nếu thread là 1:1 và đã biết là E2EE → gửi qua bridge trực tiếp.
   * Nếu REST API trả lỗi E2EE ("conversation disabled") → đánh dấu thread + retry qua bridge.
   */
  public async sendMessage(threadId: string, body: string, opts?: FBSendOptions): Promise<FBSendResult> {
    // Pass httpsAgent to all sub-calls for proxy support
    const agent = this.httpsAgent;
    const is1on1 = opts?.typeChat === 'user';

    // ── Ensure connection is alive before sending ─────────────────────────
    // Kiểm tra listener thực sự còn alive, nếu không thì auto-reconnect.
    // Tránh gửi request qua 1 kết nối đã chết → treo 30s + mất kết nối.
    const ready = await this.ensureConnected();
    if (!ready) {
      return { success: false, error: 'Mất kết nối Facebook. Vui lòng kết nối lại tài khoản.' };
    }
    // ───────────────────────────────────────────────────────────────────────

    // ── 1:1 messages: try E2EE bridge FIRST ─────────────────────────────
    // Facebook Messenger 1:1 luôn yêu cầu E2EE. Gửi qua REST sẽ thất bại
    // hoặc gửi không mã hoá. Luôn ưu tiên bridge, chỉ fallback REST khi
    // bridge không available.
    if (is1on1) {
      if (this.e2eeBridge?.isAlive()) {
        try {
          const bridgeResult = await this.e2eeBridge.sendE2EEMessage({
            chatJid: normalizeChatJid(threadId),
            text: body,
            replyToId: opts?.replyToMessageId || '',
          });
          if (bridgeResult?.messageId) {
            Logger.log(`[FacebookService:${this.accountId}] 1:1 message sent via bridge E2EE: msgId=${bridgeResult.messageId}`);
            this.e2eeThreads.add(threadId);
            return {
              success: true,
              messageId: bridgeResult.messageId,
              timestamp: bridgeResult.timestampMs,
            };
          }
          Logger.warn(`[FacebookService:${this.accountId}] Bridge E2EE send returned no messageId, falling back to REST`);
        } catch (bridgeErr: any) {
          Logger.warn(`[FacebookService:${this.accountId}] Bridge E2EE send failed, falling back to REST: ${bridgeErr.message}`);
        }
      }
      // Bridge not alive — retry E2EE rồi thử lại
      if (!this.isE2EEConnected()) {
        try { await this.retryE2EE(); } catch {}
      }
      if (this.isE2EEConnected()) {
        try {
          return await this.sendE2EEMessage(normalizeChatJid(threadId), body, opts);
        } catch (err: any) {
          Logger.warn(`[FacebookService:${this.accountId}] E2EE retry also failed: ${err.message}`);
        }
      }
    }

    // ── Group messages (non-E2EE): send via bridge MQTT first ────────────
    // Bridge's MQTT path ổn định hơn REST API. REST API có thể treo hoặc bị
    // Facebook rate-limit dẫn đến mất kết nối.
    if (!is1on1 && this.e2eeBridge?.isAlive()) {
      try {
        const bridgeResult = await this.e2eeBridge.sendMessage({
          threadId,
          text: body,
          replyToId: opts?.replyToMessageId || '',
        });
        if (bridgeResult?.messageId) {
          Logger.log(`[FacebookService:${this.accountId}] Group message sent via bridge MQTT: msgId=${bridgeResult.messageId}`);
          return {
            success: true,
            messageId: bridgeResult.messageId,
            timestamp: bridgeResult.timestampMs,
          };
        }
        Logger.warn(`[FacebookService:${this.accountId}] Bridge sendMessage returned no messageId, falling back to REST`);
      } catch (bridgeErr: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Bridge sendMessage failed, falling back to REST: ${bridgeErr.message}`);
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    // Try REST as fallback (cho cả 1:1 và group)
    const result = await sendMessageREST(this.requireSession(), threadId, body, opts, agent);

    // Check for E2EE-related error and auto-retry
    if (!result.success && result.error && this.isE2EEDisabledError(result.error)) {
      Logger.warn(`[FacebookService:${this.accountId}] E2EE disabled error for thread=${threadId}, marking as E2EE and retrying via bridge`);
      this.e2eeThreads.add(threadId);
      try {
        DatabaseService.getInstance().markFBThreadE2EE(threadId, this.accountId);
      } catch {}
      return this.sendE2EEWithFallback(threadId, body, opts);
    }

    return result;
  }

  /**
   * Kiểm tra error message có phải do E2EE conversation không
   */
  private isE2EEDisabledError(error: string): boolean {
    const disabledPatterns = ['disabled', 'vô hiệu hoá', 'encrypted', 'e2ee'];
    const lower = error.toLowerCase();
    return disabledPatterns.some(p => lower.includes(p));
  }

  /**
   * Gửi tin nhắn qua E2EE bridge, tự động retry bridge nếu cần
   */
  private async sendE2EEWithFallback(threadId: string, body: string, opts?: FBSendOptions): Promise<FBSendResult> {
    if (!this.isE2EEConnected()) {
      try {
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge not connected, retrying...`);
        await this.retryE2EE();
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] E2EE retry failed: ${err.message}`);
      }
    }
    if (this.isE2EEConnected()) {
      try {
        const chatJid = normalizeChatJid(threadId);
        return await this.sendE2EEMessage(chatJid, body, opts);
      } catch (err: any) {
        return { success: false, error: `E2EE send failed: ${err.message}` };
      }
    }
    return {
      success: false,
      error: 'Hội thoại này đã được mã hoá 1-1 (E2EE) nhưng bridge chưa kết nối. Vui lòng build fbchat-bridge-e2ee.',
    };
  }

  public async unsendMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    return unsendMessage(this.requireSession(), messageId, this.httpsAgent);
  }

  public async addReaction(messageId: string, emoji: string, action?: FBReactionAction) {
    return addReaction(this.requireSession(), messageId, emoji, action, this.httpsAgent);
  }

  public async editMessage(messageId: string, newText: string): Promise<{ success: boolean; error?: string }> {
    return editMessage(this.requireSession(), messageId, newText, this.httpsAgent);
  }

  public async forwardMessage(messageId: string, targetThreadId: string, isGroup: boolean = false): Promise<{ success: boolean; error?: string }> {
    return forwardMessage(this.requireSession(), messageId, targetThreadId, isGroup, this.httpsAgent);
  }

  public async pinMessage(messageId: string, threadId: string): Promise<{ success: boolean; error?: string }> {
    return pinMessage(this.requireSession(), messageId, threadId, this.httpsAgent);
  }

  public async unpinMessage(messageId: string, threadId: string): Promise<{ success: boolean; error?: string }> {
    return unpinMessage(this.requireSession(), messageId, threadId, this.httpsAgent);
  }

  public async createPoll(threadId: string, question: string, options: string[]): Promise<{ success: boolean; pollId?: string; error?: string }> {
    return createPoll(this.requireSession(), threadId, question, options, this.httpsAgent);
  }

  public async votePoll(pollId: string, optionIds: string[]): Promise<{ success: boolean; error?: string }> {
    return votePoll(this.requireSession(), pollId, optionIds, this.httpsAgent);
  }

  public async uploadAttachment(filePath: string): Promise<FBAttachmentUploadResult | null> {
    return uploadAttachment(this.requireSession(), filePath, this.httpsAgent);
  }

  public async getThreadList(): Promise<FBThread[]> {
    const session = this.requireSession();
    const result = await getThreadList(session, undefined, this.httpsAgent);
    return parseThreadNodes(result.dataGet, this.accountId, session.FacebookID);
  }

  /**
   * Refresh avatar cho 1 contact Facebook (user 1-1).
   * Chiến lược 3 lớp, đảm bảo luôn lấy được avatar:
   *   1. Scrape profile page → URL CDN fresh (không phụ thuộc cache GraphQL)
   *   2. Download ảnh về local với Facebook cookie → local path không bh hết hn
   *   3. Fallback: re-fetch thread list GraphQL → URL CDN fresh
   *
   * Dùng khi avatar CDN c (403) — URL oe ã ht hn.
   */
  public async refreshContactAvatar(fbUserId: string): Promise<string | null> {
    // Server-side debounce: chỉ refresh 1 lần mỗi user/session
    if (this.avatarRefreshDebounce.has(fbUserId)) {
      Logger.log(`[FacebookService:${this.accountId}] refreshContactAvatar: skipped (debounced) for ${fbUserId}`);
      return null;
    }
    this.avatarRefreshDebounce.add(fbUserId);

    const session = this.requireSession();
    const db = DatabaseService.getInstance();
    const cookie = session.cookieFacebook;
    const fbId = session.FacebookID;

    try {
      // Bc 1: Scrape profile page ca user Facebook ly URL CDN fresh nht
      let freshCdnUrl = await fetchUserAvatarFromProfile(cookie, fbUserId);

      // Bc 2: Nu profile page khng c, th re-fetch thread list t GraphQL
      if (!freshCdnUrl) {
        try {
          const result = await getThreadList(session, undefined, this.httpsAgent);
          const threads = parseThreadNodes(result.dataGet, this.accountId, session.FacebookID);
          const thread = threads.find(t => t.id === fbUserId);
          freshCdnUrl = thread?.metadata?.avatar_url || null;
        } catch (e) {
          Logger.warn(`[FacebookService:${this.accountId}] refreshContactAvatar GraphQL fallback error: ${e}`);
        }
      }

      if (!freshCdnUrl) {
        Logger.warn(`[FacebookService:${this.accountId}] refreshContactAvatar: could not get any avatar URL for ${fbUserId}`);
        return null;
      }

      // Bc 3: Download v local vi Facebook cookie gii quyt vnh vin vn oe
      try {
        const localPath = await FileStorageService.downloadImage(
          fbId,
          freshCdnUrl,
          `fb_avatar_${fbUserId}.jpg`,
          cookie,
          undefined,
          'https://www.facebook.com/',
        );
        if (localPath) {
          // Thnh cng → update DB vi local path (vn vnh vin)
          db.run?.(
            `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
            [localPath, fbId, fbUserId]
          );
          Logger.log(`[FacebookService:${this.accountId}] refreshContactAvatar: saved locally for ${fbUserId}: ${localPath}`);
          return localPath;
        }
      } catch (dlErr) {
        Logger.warn(`[FacebookService:${this.accountId}] refreshContactAvatar: download failed, fallback to CDN URL`);
      }

      // Fallback: update DB vi URL CDN mi (fresh, valid trong vi gi)
      db.run?.(
        `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
        [freshCdnUrl, fbId, fbUserId]
      );
      // Update fb_threads metadata
      const existing = db.queryOne?.(
        `SELECT metadata FROM fb_threads WHERE id = ? AND account_id = ?`,
        [fbUserId, this.accountId]
      ) as { metadata?: string } | undefined;
      const meta = existing?.metadata ? JSON.parse(existing.metadata) : {};
      meta.avatar_url = freshCdnUrl;
      db.run?.(
        `UPDATE fb_threads SET metadata = ? WHERE id = ? AND account_id = ?`,
        [JSON.stringify(meta), fbUserId, this.accountId]
      );
      Logger.log(`[FacebookService:${this.accountId}] refreshContactAvatar: updated CDN URL for ${fbUserId}`);
      return freshCdnUrl;
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] refreshContactAvatar error: ${err.message}`);
    }
    return null;
  }

  /**
   * Lấy thông tin user Facebook (tên + avatar) từ profile page HTML.
   * Dùng cho E2EE / hội thoại mới không có contact info trong DB.
   */
  public async getUserInfoFacebookHtml(fbUserId: string): Promise<{ name: string; avatarUrl: string } | null> {
    try {
      const session = this.requireSession();
      return await getUserInfoFacebookHtml(session.cookieFacebook, fbUserId);
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] getUserInfoFacebookHtml error: ${err.message}`);
      return null;
    }
  }

  public async changeThreadName(threadId: string, name: string): Promise<boolean> {
    return changeThreadName(this.requireSession(), threadId, name, this.httpsAgent);
  }

  public async changeThreadEmoji(threadId: string, emoji: string): Promise<boolean> {
    return changeThreadEmoji(this.requireSession(), threadId, emoji, this.httpsAgent);
  }

  public async changeNickname(threadId: string, userId: string, nickname: string): Promise<boolean> {
    return changeNickname(this.requireSession(), threadId, userId, nickname, this.httpsAgent);
  }

  public async fetchThreadMessages(
    threadId: string,
    limit?: number,
    beforeCursor?: string | null,
  ): Promise<{
    success: boolean;
    messages?: any[];
    cursor?: { before?: string; after?: string; hasMore?: boolean };
    error?: string;
  }> {
    return fetchThreadMessages(this.requireSession(), threadId, limit, beforeCursor, this.httpsAgent);
  }

  // ─── Phase 3 Operations ─────────────────────────────────────────────────────

  /** Chặn người dùng (N4) */
  public async blockUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return blockUser(this.requireSession(), userId, this.httpsAgent);
  }

  /** Bỏ chặn người dùng (N4) */
  public async unblockUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return unblockUser(this.requireSession(), userId, this.httpsAgent);
  }

  /** Đổi theme hội thoại (N1) */
  public async changeThreadTheme(threadId: string, theme: string): Promise<{ success: boolean; error?: string }> {
    return changeThreadTheme(this.requireSession(), threadId, theme, this.httpsAgent);
  }

  /** Tạo Messenger Note (N2) */
  public async createNote(text: string, backgroundColor?: string, textColor?: string): Promise<{ success: boolean; noteId?: string; error?: string }> {
    return createNote(this.requireSession(), text, backgroundColor, textColor, this.httpsAgent);
  }

  /** Thêm admin nhóm (N3) */
  public async addGroupAdmin(threadId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    return addGroupAdmin(this.requireSession(), threadId, userId);
  }

  /** Xóa admin nhóm (N3) */
  public async removeGroupAdmin(threadId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    return removeGroupAdmin(this.requireSession(), threadId, userId);
  }

  /** Bật/tắt duyệt thành viên (N3) */
  public async changeApprovalMode(threadId: string, approved: boolean): Promise<{ success: boolean; error?: string }> {
    return changeApprovalMode(this.requireSession(), threadId, approved, this.httpsAgent);
  }

  /** Duyệt/từ chối thành viên (N3) */
  public async approvePendingMember(threadId: string, userId: string, approve: boolean): Promise<{ success: boolean; error?: string }> {
    return approvePendingMember(this.requireSession(), threadId, userId, approve, this.httpsAgent);
  }

  /** Lấy link mời nhóm (N3) */
  public async getGroupLink(threadId: string): Promise<{ success: boolean; link?: string; error?: string }> {
    return getGroupLink(this.requireSession(), threadId, this.httpsAgent);
  }

  /** Bật/tắt link mời nhóm (N3) */
  public async setGroupLink(threadId: string, enable: boolean): Promise<{ success: boolean; error?: string }> {
    return setGroupLink(this.requireSession(), threadId, enable, this.httpsAgent);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Persist a reaction update to fb_messages DB.
   * Reads current reactions, merges the new one (userId → emoji), saves back.
   */
  private persistReactionToDB(messageId: string, userId: string, emoji: string): void {
    if (!messageId || !userId || !emoji) return;
    try {
      const db = DatabaseService.getInstance();
      const row = db.queryOne<any>(`SELECT reactions FROM fb_messages WHERE id = ?`, [messageId]);
      if (!row) return;

      let raw = row.reactions;
      let parsed: any = {};
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
      } else if (raw && typeof raw === 'object') {
        parsed = raw;
      }

      // Normalize to old format { userId: emojiChar } for simple merge
      let oldFormat: Record<string, string> = {};
      if (parsed.emoji && typeof parsed.emoji === 'object') {
        // New format → flatten to old format
        for (const [emo, emoData] of Object.entries(parsed.emoji as any)) {
          for (const [uid] of Object.entries((emoData as any).users || {})) {
            oldFormat[uid] = emo;
          }
        }
      } else {
        // Already old format { userId: emojiChar }
        for (const [uid, emo] of Object.entries(parsed)) {
          if (typeof emo === 'string') oldFormat[uid] = emo;
        }
      }

      // Apply the new reaction
      if (emoji) {
        oldFormat[userId] = emoji;
      } else {
        delete oldFormat[userId];
      }

      // Save back as old format (FE parseReactionsFull handles both formats)
      db.updateFBMessageReaction(messageId, JSON.stringify(oldFormat));
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] persistReactionToDB error: ${err.message}`);
    }
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  public getStatus(): FBAccountStatus { return this.status; }
  public getAccountId(): string { return this.accountId; }
  public getRealFacebookId(): string | null { return this.dataFB?.FacebookID || null; }
  public isConnected(): boolean { return this.status === 'connected'; }

  /**
   * Kiểm tra MQTT listener thực sự còn kết nối không (BUG #3 fix).
   * Khác với isConnected() chỉ check status flag — method này check actual socket.
   * Dùng trước khi gửi tin nhắn để đảm bảo kết nối thực sự alive.
   */
  public isListenerActuallyConnected(): boolean {
    if (!this.listener) return false;
    return this.listener.isActuallyConnected();
  }

  /**
   * Kiểm tra kết nối và tự động reconnect nếu listener đã chết (BUG #3 fix).
   * Gọi trước mỗi lần send message để đảm bảo connection thực sự alive.
   * Trả về true nếu sẵn sàng gửi, false nếu không thể gửi.
   */
  public async ensureConnected(): Promise<boolean> {
    // Service says connected → verify listener thực sự alive
    if (this.status === 'connected' && this.isListenerActuallyConnected()) {
      return true;
    }

    // Service says connected but listener actually dead → force reconnect
    if (this.status === 'connected' && !this.isListenerActuallyConnected()) {
      Logger.warn(`[FacebookService:${this.accountId}] Status is 'connected' but listener is dead — forcing reconnect`);
      try {
        // Ngắt listener cũ và tạo lại
        if (this.listener) {
          this.listener.disconnect();
          this.listener = null;
        }
        await this._doConnect();
        return this.isListenerActuallyConnected();
      } catch (err: any) {
        Logger.error(`[FacebookService:${this.accountId}] ensureConnected reconnect failed: ${err.message}`);
        return false;
      }
    }

    // Not connected at all → try to connect
    if (this.status !== 'connected' && this.status !== 'connecting') {
      Logger.log(`[FacebookService:${this.accountId}] Not connected — attempting connect`);
      try {
        await this.connect();
        return this.isListenerActuallyConnected();
      } catch (err: any) {
        Logger.error(`[FacebookService:${this.accountId}] ensureConnected failed: ${err.message}`);
        return false;
      }
    }

    // Already connecting → wait a bit
    if (this.status === 'connecting') {
      Logger.log(`[FacebookService:${this.accountId}] Already connecting — waiting...`);
      if (this._connectPromise) {
        try {
          await Promise.race([this._connectPromise, new Promise(r => setTimeout(r, 15000))]);
        } catch {}
      }
      return this.isListenerActuallyConnected();
    }

    return false;
  }

  /** Reset retry count của MQTT listener (gọi khi user manual reconnect từ dashboard) */
  public resetListenerRetryCount(): void {
    if (this.listener) {
      this.listener.resetRetryCount();
      Logger.log(`[FacebookService:${this.accountId}] Listener retry count reset`);
    }
  }
}

export default FacebookService;

