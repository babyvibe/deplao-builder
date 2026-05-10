/**
 * FacebookService.ts
 * Orchestrator singleton per account
 * Tương tự ZaloService — quản lý lifecycle session + listener + API calls
 */

import {
  FBSessionData, FBAccountStatus, FBSendOptions, FBSendResult,
  FBReactionAction, FBAttachmentUploadResult, FBThread, FBMQTTMessage
} from './FacebookTypes';
import { initSession, checkCookieAlive } from './FacebookSession';
import { sendMessage, unsendMessage, addReaction } from './FacebookMessageSender';
import { uploadAttachment } from './FacebookAttachment';
import {
  getThreadList, parseThreadNodes,
  changeThreadName, changeThreadEmoji, changeNickname
} from './FacebookThreadManager';
import { FacebookMQTTListener } from './FacebookMQTTListener';
import EventBroadcaster from '../EventBroadcaster';
import DatabaseService from '../DatabaseService';
import Logger from '../../utils/Logger';

export class FacebookService {
  private static instances = new Map<string, FacebookService>();

  private accountId: string;
  private cookie: string;
  private dataFB: FBSessionData | null = null;
  private listener: FacebookMQTTListener | null = null;
  private status: FBAccountStatus = 'disconnected';
  private statusChangeCallback?: (status: FBAccountStatus) => void;
  /** Cached real Facebook UID — resolved once from DB, used for broadcasts */
  private _facebookId: string | null = null;

  private constructor(accountId: string, cookie: string) {
    this.accountId = accountId;
    this.cookie = cookie;
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

  public static getInstance(accountId: string, cookie?: string): FacebookService {
    if (!FacebookService.instances.has(accountId)) {
      if (!cookie) throw new Error(`[FacebookService] Cookie required for new instance: ${accountId}`);
      FacebookService.instances.set(accountId, new FacebookService(accountId, cookie));
    }
    return FacebookService.instances.get(accountId)!;
  }

  public static removeInstance(accountId: string): void {
    const instance = FacebookService.instances.get(accountId);
    if (instance) {
      instance.disconnect().catch(() => {});
      FacebookService.instances.delete(accountId);
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
    if (this.status === 'connected' || this.status === 'connecting') {
      Logger.log(`[FacebookService:${this.accountId}] Already connected/connecting`);
      return;
    }

    this.setStatus('connecting');
    Logger.log(`[FacebookService:${this.accountId}] Connecting...`);

    try {
      // 1. Init session
      this.dataFB = await initSession(this.cookie);

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
        seqId = await getLastSeqId(this.dataFB);
        Logger.log(`[FacebookService:${this.accountId}] Got lastSeqId=${seqId}`);
      } catch (seqErr: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Failed to get lastSeqId, using 0: ${seqErr.message}`);
      }

      // 3. Start MQTT listener
      this.listener = new FacebookMQTTListener(this.dataFB, this.accountId, seqId);

      this.listener.on('message', (msg: FBMQTTMessage) => {
        this.handleIncomingMessage(msg);
      });

      this.listener.on('connectionStatus', (s: FBAccountStatus) => {
        if (s === 'connected') {
          this.setStatus('connected');
        } else if (s === 'cookie_expired') {
          Logger.warn(`[FacebookService:${this.accountId}] MQTT max retries — cookie expired or bot detected`);
          this.setStatus('cookie_expired');
        } else if (s === 'error') {
          this.setStatus('error');
        }
      });

      this.listener.on('error', (err: Error) => {
        Logger.warn(`[FacebookService:${this.accountId}] Listener error: ${err.message}`);
      });

      this.listener.connect();

      Logger.log(`[FacebookService:${this.accountId}] Connected (fbId=${fbId})`);
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
      const cookieAlive = await checkCookieAlive(this.cookie);
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

    Logger.log(`[FacebookService:${this.accountId}] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} userID=${msg.userID} isSelf=${isSelf} body="${(msg.body || '').slice(0,50)}" fbId=${this.dataFB?.FacebookID}`);

    // Persist to DB
    if (threadId && msg.messageID) {
      try {
        const db = DatabaseService.getInstance();
        const hasAttachment = !!(msg.attachments?.id && msg.attachments.id !== 0 &&
          (msg.attachments.url || msg.attachments.attachmentType));

        // Determine type from attachment (use primary attachment)
        const msgType = hasAttachment
          ? (msg.attachments.attachmentType || 'image')
          : 'text';

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
          })));
        } else if (hasAttachment) {
          attachmentPayload = JSON.stringify([{
            type: msgType,
            url: msg.attachments.url,
            id: String(msg.attachments.id),
            ...(msg.attachments.name ? { name: msg.attachments.name } : {}),
            ...(msg.attachments.fileSize != null ? { fileSize: msg.attachments.fileSize } : {}),
            ...(msg.attachments.mimeType ? { mimeType: msg.attachments.mimeType } : {}),
          }]);
        }

        // Human-readable preview for last_message display
        const attachmentPreview = msgType === 'image' ? '🖼️ Hình ảnh'
          : msgType === 'video' ? '🎬 Video'
          : msgType === 'audio' ? '🎵 Audio'
          : msg.attachments?.name ? `📎 ${msg.attachments.name}`
          : '📎 Tệp đính kèm';

        Logger.log(`[FacebookService:${this.accountId}] Calling saveFBMessage: account_id=${this.accountId} thread_id=${threadId} type=${msgType} hasAttachment=${hasAttachment}`);
        // @ts-ignore
        db.saveFBMessage({
          id: msg.messageID,
          account_id: this.accountId,
          thread_id: threadId,
          sender_id: msg.userID || '',
          body: msg.body || (hasAttachment ? attachmentPreview : undefined),
          timestamp: ts,
          type: msgType,
          attachments: attachmentPayload,
          is_self: isSelf,
          is_unsent: 0,
        });

        // Note: fb_threads preview is updated inside saveFBMessage

        // Sync to unified contacts table
        const fbThread = db.queryOne?.(`SELECT name, type FROM fb_threads WHERE id = ? AND account_id = ?`, [threadId, this.accountId]) as any;
        const threadName = fbThread?.name || '';
        const contactType = fbThread?.type === 'group' ? 'group' : 'user';
        const fbIdForContacts = this.getFacebookId();
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
    }

    // Broadcast — include isSelf so UI can place message on correct side
    EventBroadcaster.emit('fb:onMessage', {
      fbAccountId: this.getFacebookId(),
      message: { ...msg, isSelf: !!isSelf },
    });
    Logger.log(`[FacebookService:${this.accountId}] ${isSelf ? '[ECHO]' : 'Incoming'} message from ${msg.userID}: ${msg.body?.slice(0, 50) || (msg.attachments?.attachmentType ? `[${msg.attachments.attachmentType}${msg.attachments.name ? ': ' + msg.attachments.name : ''}]` : '[attachment]')}`);
  }

  // ─── Public API methods ──────────────────────────────────────────────────────

  private requireSession(): FBSessionData {
    if (!this.dataFB) throw new Error('Not connected — call connect() first');
    return this.dataFB;
  }

  public async sendMessage(threadId: string, body: string, opts?: FBSendOptions): Promise<FBSendResult> {
    return sendMessage(this.requireSession(), threadId, body, opts);
  }

  public async unsendMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    return unsendMessage(this.requireSession(), messageId);
  }

  public async addReaction(messageId: string, emoji: string, action?: FBReactionAction) {
    return addReaction(this.requireSession(), messageId, emoji, action);
  }

  public async uploadAttachment(filePath: string): Promise<FBAttachmentUploadResult | null> {
    return uploadAttachment(this.requireSession(), filePath);
  }

  public async getThreadList(): Promise<FBThread[]> {
    const session = this.requireSession();
    const result = await getThreadList(session);
    return parseThreadNodes(result.dataGet, this.accountId, session.FacebookID);
  }

  public async changeThreadName(threadId: string, name: string): Promise<boolean> {
    return changeThreadName(this.requireSession(), threadId, name);
  }

  public async changeThreadEmoji(threadId: string, emoji: string): Promise<boolean> {
    return changeThreadEmoji(this.requireSession(), threadId, emoji);
  }

  public async changeNickname(threadId: string, userId: string, nickname: string): Promise<boolean> {
    return changeNickname(this.requireSession(), threadId, userId, nickname);
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  public getStatus(): FBAccountStatus { return this.status; }
  public getAccountId(): string { return this.accountId; }
  public getRealFacebookId(): string | null { return this.dataFB?.FacebookID || null; }
  public isConnected(): boolean { return this.status === 'connected'; }
}

export default FacebookService;

