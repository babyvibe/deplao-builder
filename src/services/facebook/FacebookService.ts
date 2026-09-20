/**
 * FacebookService.ts
 * Orchestrator singleton per account
 * Tương tự ZaloService - quản lý lifecycle session + listener + API calls
 */

import {
  FBSessionData, FBAccountStatus, FBSendOptions, FBSendResult,
  FBReactionAction, FBAttachmentUploadResult, FBThread, FBMQTTMessage,
  FBE2EEStatus, FBE2EEMessageRaw,
} from './FacebookTypes';
import { initSession, fetchUserAvatarFromProfile, getUserInfoFacebookHtml } from './FacebookSession';
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
import { FacebookE2EEStateStore } from './FacebookE2EEStateStore';
import { resolveThreadKind } from './FacebookThreadKind';
import { FacebookEventPipeline, EventPriority } from './FacebookEventPipeline';
import { metricInc } from './FacebookMetrics';
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
  /** Cached real Facebook UID - resolved once from DB, used for broadcasts */
  private _facebookId: string | null = null;
  /** Last known good MQTT seqId - dùng làm fallback khi getLastSeqId thất bại,
   *  tránh connect với seqId=0 → ERROR_QUEUE_OVERFLOW */
  private _lastGoodSeqId: string = '0';
  /** Đếm số lần MQTT listener bị ERROR_QUEUE_OVERFLOW persistent.
   *  Khi > 0, ensureConnected() sẽ không tạo mới MQTT listener nữa,
   *  chỉ dùng bridge status để quyết định có thể gửi tin hay không. */
  private _mqttOverflowCount: number = 0;

  // ─── E2EE Bridge ──────────────────────────────────────────────────────────
  private e2eeBridge: FacebookE2EEBridge | null = null;
  private e2eeSender: FacebookE2EESender | null = null;
  private e2eeStatus: FBE2EEStatus = 'disconnected';
  /** Serialize on-demand restarts so repeated sends cannot race bridge generations. */
  private e2eeRetryPromise: Promise<void> | null = null;
  private e2eeEnabled: boolean = true; // Có thể disable nếu không tìm thấy binary
  /** Track thread IDs known to be E2EE-encrypted (auto-populated on error) */
  private e2eeThreads: Set<string> = new Set();
  /** Track thread IDs known to be NON-E2EE (gửi qua bridge sendMessage/MQTT thành công) */
  private _nonE2EEThreads: Set<string> = new Set();
  /** Debounce avatar refresh - chỉ 1 lần mỗi user/session */
  private avatarRefreshDebounce = new Set<string>();
  /** Bridge instance ID - tăng mỗi lần startE2EEBridge, dùng để detect stale reconnect timers (BUG #6 fix) */
  private e2eeBridgeGen: number = 0;
  /** Heartbeat timer kiểm tra bridge còn responsive không (BUG #8 fix) */
  private _e2eeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Đếm số lần heartbeat fail liên tiếp - sau 2 lần → kill + respawn */
  private _e2eeHeartbeatFailCount: number = 0;
  /** Track message IDs sent locally via this service instance.
   *  Dùng để ngăn self-echo duplicate khi bridge/MQTT echo ngược tin nhắn vừa gửi.
   *  Mỗi entry tự xoá sau 60s để tránh memory leak. */
  private _recentlySentMessageIds: Set<string> = new Set();
  /** E2EE device state store — persists E2EE state across app restarts */
  private e2eeStateStore: FacebookE2EEStateStore | null = null;
  /** Phase 5: Sequential event pipeline — processes bridge events one-at-a-time */
  private eventPipeline!: FacebookEventPipeline;

  private constructor(accountId: string, cookie: string, proxyId?: number | null) {
    this.accountId = accountId;
    this.cookie = cookie;
    this.proxyId = proxyId ?? null;
    this.httpsAgent = this.resolveProxyAgent();
    this.eventPipeline = new FacebookEventPipeline(accountId);
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

  public static async removeInstance(accountId: string): Promise<void> {
    const instanceKey = FacebookService.resolveInstanceKey(accountId);
    const instance = FacebookService.instances.get(instanceKey);
    if (instance) {
      await instance.disconnect().catch(() => {});
      FacebookService.instances.delete(instanceKey);
    }
    // Clear after disconnect, whose shutdown flushes the final pending snapshot.
    // This also covers disconnected accounts with no in-memory service.
    await FacebookE2EEStateStore.clearForAccount(instanceKey).catch(() => {});
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

    // ── Sync DB marking with connection state ───────────────────────────
    // Đảm bảo listener_active + fb_accounts.status luôn đồng bộ,
    // tránh tình trạng UI hiển thị sai hoặc auto-reconnect bỏ qua account
    // do DB marking cũ từ vòng lặp overflow trước đó.
    try {
      const db = DatabaseService.getInstance();
      const fbId = this.getFacebookId();

      if (status === 'connected') {
        // MQTT connected → đánh dấu listener active + fb_accounts connected
        db.setListenerActive(fbId, true);
        db.updateFBAccountStatus(this.accountId, 'connected');
        Logger.log(`[FacebookService:${this.accountId}] DB marking: listener_active=1, status=connected`);
      } else if (status === 'disconnected' || status === 'error' || status === 'cookie_expired') {
        db.setListenerActive(fbId, false);
        db.updateFBAccountStatus(this.accountId, 'disconnected');
        Logger.log(`[FacebookService:${this.accountId}] DB marking: listener_active=0, status=disconnected (reason: ${status})`);
      }
    } catch (dbErr: any) {
      Logger.warn(`[FacebookService:${this.accountId}] setStatus DB sync error: ${dbErr.message}`);
    }
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

    // Cleanup old listener trước khi tạo mới - tránh memory leak + timer chồng chéo
    if (this.listener) {
      try {
        this.listener.disconnect();
      } catch {}
      this.listener = null;
    }

    try {
      // 1. Init session (with proxy support)
      // initSession() now validates REQUIRED_SESSION_FIELDS + FacebookID là số
      // và throw error nếu thiếu - không cần check thủ công
      this.dataFB = await initSession(this.cookie, this.httpsAgent);

      // 2. Fetch latest seqId via GraphQL to avoid ERROR_QUEUE_OVERFLOW
      // Sending seq=0 asks Facebook to sync ALL messages → overflow on accounts with many messages
      let seqId = this._lastGoodSeqId || '0';
      try {
        const { getLastSeqId } = await import('./FacebookThreadManager');
        seqId = await getLastSeqId(this.dataFB, this.httpsAgent);
        if (seqId && seqId !== '0') this._lastGoodSeqId = seqId;
        Logger.log(`[FacebookService:${this.accountId}] Got lastSeqId=${seqId}`);
      } catch (seqErr: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Failed to get lastSeqId, using cached seqId=${seqId}: ${seqErr.message}`);
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
        this.handleIncomingMessage(msg).catch(err =>
      Logger.warn(`[FacebookService:${this.accountId}] Bridge group message persist error: ${err.message}`)
    );
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
            Logger.warn(`[FacebookService:${this.accountId}] MQTT health check - cookie expired`);
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
            Logger.warn(`[FacebookService:${this.accountId}] MQTT max retries (8) exhausted - marking dead`);
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

      // Cache seqId để dùng làm fallback cho lần connect sau (tránh overflow cycle)
      this.listener.on('seqId', (newSeqId: string) => {
        if (newSeqId && newSeqId !== '0') {
          this._lastGoodSeqId = newSeqId;
        }
      });

      // Track ERROR_QUEUE_OVERFLOW - nếu overflow persist + bridge alive,
      // dừng hẳn MQTT listener vì bridge có MQTT riêng xử lý mọi traffic
      this.listener.on('overflow', (_seqId: string) => {
        this._mqttOverflowCount++;
        Logger.warn(`[FacebookService:${this.accountId}] MQTT overflow #${this._mqttOverflowCount} - will skip MQTT reconnect if persistent`);
        // Khi overflow > 2 lần và bridge đã connected → dừng MQTT listener hẳn
        // Bridge có MQTT nội bộ riêng, không cần TypeScript MQTT listener nữa
        if (this._mqttOverflowCount > 2 && this.e2eeBridge?.isAlive()) {
          Logger.warn(`[FacebookService:${this.accountId}] Persistent MQTT overflow + bridge alive → disabling MQTT listener, relying on bridge`);
          if (this.listener) {
            this.listener.disconnect();
            // Giữ listener = null để ensureConnected không thử tạo lại
          }
        }
      });

      // Gắn health check callback - listener sẽ gọi định kỳ khi đang Phase 2 retry
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

      const fbId = this.dataFB.FacebookID;
      Logger.log(`[FacebookService:${this.accountId}] Connected (fbId=${fbId})`);

      // 4. Start E2EE bridge (cho 1:1 encrypted messages).  A listener
      // reconnect must not overwrite a still-running bridge process: doing so
      // leaves the old child alive and races its device/socket lifecycle.
      if (!this.e2eeBridge?.isAlive()) {
        await this.startE2EEBridge(fbId);
      } else if (!this.isE2EEConnected()) {
        Logger.warn(`[FacebookService:${this.accountId}] Account reconnected while E2EE socket is recovering; preserving current bridge for serialized send recovery`);
      }
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
    this.e2eeStateStore = null;

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
      const cookieAlive = await this.checkCookieHealth();
      const listenerConnected = this.listener?.isConnected() || false;

      if (!cookieAlive) {
        return { alive: false, listenerConnected, reason: 'cookie_expired' };
      }
      return { alive: true, listenerConnected, ...(listenerConnected ? {} : { reason: 'transport_disconnected' }) };
    } catch (err: any) {
      return { alive: false, listenerConnected: false, reason: err.message };
    }
  }

  /**
   * Kiểm tra riêng cookie health (không check listener).
   * Dùng cho health check callback trong FacebookMQTTListener. Network failure
   * is deliberately *not* treated as an expired cookie: during an offline
   * period that would permanently stop the listener's own reconnect loop.
   */
  public async checkCookieHealth(): Promise<boolean> {
    try {
      await initSession(this.cookie, this.httpsAgent);
      return true;
    } catch (err: any) {
      const message = String(err?.message || err || '');
      const transientNetworkError = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|\b(?:network|socket|fetch failed|timeout)\b/i.test(message);
      if (transientNetworkError) {
        Logger.warn(`[FacebookService:${this.accountId}] Cookie health check deferred because network is unavailable: ${message}`);
        return true;
      }
      Logger.warn(`[FacebookService:${this.accountId}] Cookie health check rejected session: ${message}`);
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

  private async handleIncomingMessage(msg: FBMQTTMessage): Promise<void> {
    const threadId = msg.replyToID && msg.replyToID !== '0' ? msg.replyToID : null;
    const ts = parseInt(msg.timestamp) || Date.now();
    const isSelf = this.dataFB?.FacebookID && msg.userID === this.dataFB.FacebookID ? 1 : 0;

    // ── Self-echo dedup: skip messages we already saved+broadcast locally ──
    // Khi gửi tin qua bridge (E2EE hoặc MQTT), bridge echo ngược lại message
    // qua event stream. Send path đã save DB + emit fb:onMessage rồi →
    // không cần làm lại. Dùng recently-sent set để phân biệt echo vs
    // message từ thiết bị khác (phone gửi → không có trong set → process).
    if (isSelf && msg.messageID && this._recentlySentMessageIds.has(msg.messageID)) {
      this._recentlySentMessageIds.delete(msg.messageID);
      Logger.log(`[FacebookService:${this.accountId}] Self-echo dedup: skipped msgId=${msg.messageID} (already saved+broadcast locally)`);
      return;
    }

    Logger.log(`[FacebookService:${this.accountId}] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} userID=${msg.userID} isSelf=${isSelf} body="${(msg.body || '').slice(0,50)}" hasAttachment=${!!msg.attachments?.attachmentType} isE2EE=${msg.isE2EE} fbId=${this.dataFB?.FacebookID}`);

    // ── Self-echo media guard: skip E2EE media echoes with incomplete data ──
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
    //
    // IMPORTANT: Only media types that require download (image, video, audio, file)
    // legitimately need directPath. Link/sticker type attachments do NOT have directPath
    // by design - they must NOT be caught by the "no directPath" check.
    // See BUG https://github.com/deplao/builder/issues/...
    const MEDIA_DOWNLOAD_TYPES = new Set(['image', 'video', 'audio', 'file']);
    const isSelfEchoMedia = isSelf && msg.isE2EE && (
      // Case 1: has media-type attachment requiring download but no directPath → incomplete echo
      (!!(msg.attachments?.attachmentType) && MEDIA_DOWNLOAD_TYPES.has(msg.attachments.attachmentType) && !msg.attachments?.directPath) ||
      // Case 2: body is an icon-based preview string set by bridge (not real user text)
      // Matches 🖼 🎬 🎵 🎨 📎 icons used in attachmentPreview / lastMsgPreview
      (/^[🎵🎬🎨📎🖼]/.test(msg.body || ''))
    );
    if (isSelfEchoMedia) {
      Logger.log(`[FacebookService:${this.accountId}] SELF-ECHO E2EE media with incomplete data - skipping DB save (was already saved by IPC handler)`);
      return;
    }

    // ── Fallback body for link-type attachments ──────────────────────────────
    // Khi bridge gửi link message (đặc biệt là group), data.text có thể rỗng
    // và URL chỉ nằm trong attachment. Đảm bảo body luôn có nội dung để UI hiển thị.
    if (!msg.body && msg.attachments?.attachmentType === 'link' && msg.attachments?.url) {
      msg.body = msg.attachments.url;
      Logger.log(`[FacebookService:${this.accountId}] [LINK] body was empty, using attachment URL: ${msg.body.slice(0, 100)}`);
    }
    // ──────────────────────────────────────────────────────────────────────────

    // ── Pre-fetch contact info for unknown users ──────────────────────────────
    // Trước khi save message, đảm bảo sender đã có display_name trong DB.
    // Tránh hiển thị UID thay vì tên người dùng trên client.
    if (msg.userID && /^\d+$/.test(String(msg.userID)) && !isSelf) {
      try {
        const db = DatabaseService.getInstance();
        const existingSender = db.queryOne?.(
          `SELECT display_name FROM contacts WHERE contact_id = ? AND channel = 'facebook' AND display_name != '' LIMIT 1`,
          [String(msg.userID)]
        ) as { display_name?: string } | undefined;
        if (!existingSender?.display_name) {
          // Chưa có tên → fetch trước khi save để broadcast có thông tin đầy đủ
          await this.checkAndFetchUserInfo(String(msg.userID));
        }
      } catch {}
    }
    // ────────────────────────────────────────────────────────────────────────────

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

        // Build attachment payload - support multiple attachments (batch image send)
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
        // 'gif' comes from E2EE bridge (Go sets att.Type="gif" when GifPlayback=true)
        // Also handle 'sticker' from E2EE bridge attachment type
        const attachmentPreview = msgType === 'image' ? '🖼️ Hình ảnh'
          : msgType === 'gif' ? '🖼️ GIF'
          : msgType === 'video' ? '🎬 Video'
          : msgType === 'audio' ? '🎵 Audio'
          : rawType === 'sticker' ? '🎨 Sticker'
          : msg.attachments?.name ? `📎 ${msg.attachments.name}`
          : '📎 Tệp đính kèm';

        if (msgType === 'sticker') {
          Logger.log(`[FacebookService:${this.accountId}] [STICKER] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} rawType=${rawType} msgType=${msgType} hasAttachment=${hasAttachment} url=${(msg.attachments?.url || '').slice(0,100)}`);
        }
        if (msgType === 'gif') {
          Logger.log(`[FacebookService:${this.accountId}] [GIF] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} hasAttachment=${hasAttachment} directPath=${!!msg.attachments?.directPath} url=${(msg.attachments?.url || '').slice(0,100)}`);
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
      // Check primary AND allAttachments - batch sends may have URL only in allAttachments
      // Skip link type attachments - URL links don't need local download
      const isLinkType = (a: any) => a?.attachmentType === 'link';
      const hasDownloadableUrl = msg.attachments?.url
        ? !msg.attachments.directPath && !isLinkType(msg.attachments)
        : msg.allAttachments?.some(a => a.url && !a.directPath && !isLinkType(a)) ?? false;
      if (hasDownloadableUrl) {
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] Triggering downloadNonE2EEAttachments: msgId=${msg.messageID} threadId=${threadId} primaryUrl=${(msg.attachments?.url || '').slice(0,60)}...`);
        this.downloadNonE2EEAttachments(msg, threadId).catch(err =>
          Logger.warn(`[FacebookService:${this.accountId}] downloadNonE2EEAttachments error: ${err.message}`)
        );
      } else {
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] hasDownloadableUrl=false: id=${!!msg.attachments?.id} id!==0=${msg.attachments?.id !== 0} url=${!!msg.attachments?.url} directPath=${!!msg.attachments?.directPath}`);
      }
    }

    // Broadcast - include isSelf + quote_data (if reply) so UI can display immediately
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

    // ── Resolve contact name + avatar for broadcast ─────────────────────────
    // Đảm bảo FE có display_name + avatar_url ngay khi nhận fb:onMessage,
    // tránh hiển thị UID và avatar trống cho contact mới.
    let broadcastContactName: string | undefined;
    let broadcastContactAvatar: string | undefined;
    if (threadId) {
      try {
        const dbInst = DatabaseService.getInstance();
        const fbThread = dbInst.queryOne?.(
          `SELECT name, type, metadata FROM fb_threads WHERE id = ? AND account_id = ?`,
          [threadId, this.accountId]
        ) as { name?: string; type?: string; metadata?: string } | undefined;
        if (fbThread?.name) {
          broadcastContactName = fbThread.name;
        }
        // Lấy avatar từ fb_threads.metadata (JSON: { avatar_url: "..." })
        if (fbThread?.metadata) {
          try {
            const meta = JSON.parse(fbThread.metadata);
            if (meta.avatar_url) broadcastContactAvatar = meta.avatar_url;
          } catch {}
        }
        if (fbThread?.type !== 'group') {
          const ct = dbInst.queryOne?.(
            `SELECT display_name, avatar_url FROM contacts WHERE contact_id = ? AND channel = 'facebook' AND display_name != '' LIMIT 1`,
            [threadId]
          ) as { display_name?: string; avatar_url?: string } | undefined;
          if (ct?.display_name) {
            broadcastContactName = ct.display_name;
            if (ct.avatar_url) broadcastContactAvatar = ct.avatar_url;
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
      ...(broadcastContactName ? { contactName: broadcastContactName } : {}),
      ...(broadcastContactAvatar ? { contactAvatar: broadcastContactAvatar } : {}),
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
        // Update unified contacts table - use display_name
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

  /**
   * Đánh dấu message ID đã được gửi local (đã save DB + broadcast).
   * Dùng để ngăn self-echo từ bridge/MQTT tạo duplicate trong handleIncomingMessage.
   * Tự động expire sau 60s.
   */
  public markMessageLocallySent(messageId: string): void {
    if (!messageId) return;
    this._recentlySentMessageIds.add(messageId);
    setTimeout(() => {
      this._recentlySentMessageIds.delete(messageId);
    }, 60000);
    Logger.log(`[FacebookService:${this.accountId}] Marked locally sent: ${messageId} (set size=${this._recentlySentMessageIds.size})`);
  }

  /**
   * Khởi động E2EE bridge cho 1:1 encrypted messages.
   * NON-FATAL: nếu binary không tồn tại → groups vẫn hoạt động bình thường.
   */
  private async startE2EEBridge(fbId: string): Promise<void> {
    if (!this.e2eeEnabled) {
      Logger.log(`[FacebookService:${this.accountId}] E2EE disabled - skipping bridge`);
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
      this.e2eeBridge = FacebookE2EEBridge.create(binaryPath);
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
        // Still non-fatal - groups work
        return;
      }

      // 3. Hello handshake (Phase 2: validate bridge before newClient)
      try {
        const hello = await this.e2eeBridge.hello(10000);
        Logger.log(`[FacebookService:${this.accountId}] Bridge hello: protocol=${hello.protocolVersion} version=${hello.bridgeVersion}`);
      } catch (err: any) {
        Logger.error(`[FacebookService:${this.accountId}] Bridge hello failed: ${err.message}`);
        metricInc('fb_bridge_hello_failure', this.accountId);
        this.e2eeBridge.close().catch(() => {});
        this.e2eeBridge = null;
        this.setE2EEStatus('error');
        return;
      }

      // 4. Load E2EE device state from secure storage (Phase 3)
      this.e2eeStateStore = new FacebookE2EEStateStore(this.accountId);
      let deviceData: string | undefined;
      // First boot must publish a snapshot too; memory-only mode would lose
      // the new identity before it ever reaches secure storage.
      const e2eeMemoryOnly = false;
      try {
        deviceData = await this.e2eeStateStore.load();
        if (deviceData) {
          Logger.log(`[FacebookService:${this.accountId}] Restored E2EE device state from secure storage`);
        } else {
          Logger.log(`[FacebookService:${this.accountId}] No saved E2EE state - will bootstrap new device`);
        }
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Failed to load E2EE state: ${err.message}`);
      }

      // 5. newClient + connect + connectE2EE
      // A laptop sleep can leave the old child process/socket half-open. The
      // bridge RPC default is 120s; without a bound here, an on-demand retry
      // keeps e2eeRetryPromise pending forever and every later chat send sees
      // "not connected" until the user manually stops/reconnects the account.
      Logger.log(`[FacebookService:${this.accountId}] E2EE startup: newClient`);
      const newClientResult = await this.e2eeBridge.newClient({
        cookies,
        logLevel: 'error',
        e2eeMemoryOnly,
        ...(deviceData ? { deviceData } : {}),
      }, 25_000);
      Logger.log(`[FacebookService:${this.accountId}] E2EE startup: newClient ready`);
      if (newClientResult?.deviceData) {
        this.e2eeStateStore.save(newClientResult.deviceData);
        await this.e2eeStateStore.flushPending();
      }

      // Attach the bounded listener before connect/connectE2EE. A socket can
      // replay events immediately after connect, so attaching it afterwards
      // creates a silent loss window during every reconnect.
      await this.eventPipeline.stop(true).catch(() => {});
      this.eventPipeline = new FacebookEventPipeline(this.accountId);
      this.eventPipeline.setGeneration(bridgeGen);
      this.e2eeBridge.on('event', (evt: any) => {
        if (this.e2eeBridge !== bridgeInstance || this.e2eeBridgeGen !== bridgeGen) {
          metricInc('fb_bridge_generation_stale_event', this.accountId);
          return;
        }
        if (evt?.type === 'deviceDataChanged' && evt?.data?.deviceData && this.e2eeStateStore) {
          this.e2eeStateStore.save(evt.data.deviceData);
        }
        const eventId = evt?.data?.messageId || evt?.data?.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const priority = this.getEventPriority(evt?.type || '');
        const accepted = this.eventPipeline.enqueue(eventId, priority, bridgeGen, () => this.handleBridgeEvent(evt));
        if (!accepted && priority === EventPriority.HIGH) {
          Logger.error(`[FacebookService:${this.accountId}] Critical bridge event was rejected; restarting bridge for recovery`);
          void bridgeInstance.close();
        }
      });

      // Timeout ngắn để không block group messaging nếu bridge không respond
      Logger.log(`[FacebookService:${this.accountId}] E2EE startup: connect`);
      const info = await this.e2eeBridge.connect(30000);
      Logger.log(`[FacebookService:${this.accountId}] E2EE bridge connected: user=${JSON.stringify((info as any)?.user?.id ?? '?')}`);

      Logger.log(`[FacebookService:${this.accountId}] E2EE startup: connectE2EE`);
      await this.e2eeBridge.connectE2EE(20000);
      Logger.log(`[FacebookService:${this.accountId}] E2EE pairing complete`);

      this.setE2EEStatus('connected');

      // 5. Create sender (reuses bridge)
      this.e2eeSender = new FacebookE2EESender({ mode: 'reuse', bridge: this.e2eeBridge });

      // BUG #6 fix: dùng bridgeGen để detect stale timer
      this.e2eeBridge.on('closed', (code: number | null) => {
        if (this.e2eeBridge !== bridgeInstance || this.e2eeBridgeGen !== bridgeGen) return;
        Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge closed (code=${code}, gen=${bridgeGen})`);
        this._clearE2EEHeartbeat();
        // Chỉ clear nếu bridge hiện tại vẫn là instance này
        if (this.e2eeBridge === bridgeInstance) {
          this.e2eeBridge = null;
        }
        this.setE2EEStatus('disconnected');
        // Auto-reconnect nếu service vẫn connected và bridge chưa được thay thế
        if (this.isConnected()) {
          Logger.log(`[FacebookService:${this.accountId}] E2EE bridge closed - attempting reconnect in 10s...`);
          metricInc('fb_bridge_restart', this.accountId);
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

      // 7. Start heartbeat to detect hung bridge process (BUG #8 fix)
      this._startE2EEHeartbeat(bridgeInstance, bridgeGen, fbId);

    } catch (err: any) {
      Logger.error(`[FacebookService:${this.accountId}] E2EE bridge start failed: ${err.message}`);
      this._clearE2EEHeartbeat();
      if (this.e2eeBridge) {
        this.e2eeBridge.close().catch(() => {});
        this.e2eeBridge = null;
      }
      this.e2eeSender = null;
      this.setE2EEStatus('error');
      // NON-FATAL: groups still work via MQTT
      // Auto-retry sau 30s nếu service vẫn connected (BUG #10 fix)
      if (this.isConnected() || this.status === 'connecting') {
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge init failed - will retry in 30s`);
        const currentGen = this.e2eeBridgeGen;
        setTimeout(() => {
          if ((this.isConnected() || this.status === 'connecting') && this.e2eeBridgeGen === currentGen) {
            this.startE2EEBridge(fbId).catch(() => {});
          }
        }, 30000);
      }
    }
  }

  private async stopE2EEBridge(): Promise<void> {
    this._clearE2EEHeartbeat();
    // Phase 5: Stop event pipeline
    await this.eventPipeline.stop(true).catch(() => {});
    // Phase 3: Flush pending state before closing bridge
    if (this.e2eeStateStore) {
      await this.e2eeStateStore.flushPending();
    }
    if (this.e2eeBridge) {
      await this.e2eeBridge.close().catch(() => {});
      this.e2eeBridge = null;
    }
    this.e2eeSender = null;
    this.setE2EEStatus('disconnected');
  }

  /** Heartbeat: định kỳ kiểm tra bridge còn responsive không (BUG #8 fix) */
  private _startE2EEHeartbeat(bridgeInstance: FacebookE2EEBridge, bridgeGen: number, fbId: string): void {
    this._clearE2EEHeartbeat();
    this._e2eeHeartbeatFailCount = 0;
    this._e2eeHeartbeatTimer = setInterval(async () => {
      // Chỉ check nếu bridge instance không thay đổi (tránh stale timer)
      if (this.e2eeBridge !== bridgeInstance || this.e2eeBridgeGen !== bridgeGen) {
        this._clearE2EEHeartbeat();
        return;
      }
      try {
        // Gọi isConnected với timeout 5s - nếu bridge treo, call() sẽ timeout
        await Promise.race([
          bridgeInstance.call('isConnected', {}, 5000),
          new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat_timeout')), 6000)),
        ]);
        this._e2eeHeartbeatFailCount = 0; // Reset on success
      } catch {
        this._e2eeHeartbeatFailCount++;
        Logger.warn(`[FacebookService:${this.accountId}] E2EE heartbeat fail #${this._e2eeHeartbeatFailCount}`);
        if (this._e2eeHeartbeatFailCount >= 2) {
          Logger.error(`[FacebookService:${this.accountId}] E2EE bridge unresponsive - killing + respawning`);
          this._clearE2EEHeartbeat();
          if (this.e2eeBridge === bridgeInstance) {
            // Kill hung process
            bridgeInstance.close().catch(() => {});
            this.e2eeBridge = null;
          }
          // Trigger reconnect (same as 'closed' handler)
          if (this.isConnected()) {
            setTimeout(() => {
              if (this.isConnected() && this.e2eeBridgeGen === bridgeGen && !this.e2eeBridge?.isAlive()) {
                this.startE2EEBridge(fbId).catch(() => {});
              }
            }, 5000);
          }
        }
      }
    }, 30000); // Check mỗi 30s
  }

  private _clearE2EEHeartbeat(): void {
    if (this._e2eeHeartbeatTimer) {
      clearInterval(this._e2eeHeartbeatTimer);
      this._e2eeHeartbeatTimer = null;
    }
    this._e2eeHeartbeatFailCount = 0;
  }

  /**
   * Map event type to pipeline priority for bounded queue management.
   */
  private getEventPriority(eventType: string): EventPriority {
    switch (eventType) {
      case 'e2eeMessage':
      case 'message':
      case 'messageUnsend':
        return EventPriority.HIGH;
      case 'reaction':
      case 'e2eeReaction':
      case 'messageEdit':
      case 'e2eeReceipt':
        return EventPriority.NORMAL;
      case 'typing':
      case 'presence':
      case 'seen':
      case 'raw':
        return EventPriority.LOW;
      default:
        return EventPriority.NORMAL;
    }
  }

  /**
   * Xử lý tất cả events từ Go bridge.
   * e2eeMessage → normalize → same handleIncomingMessage() as MQTT
   */
  private async handleBridgeEvent(evt: any): Promise<void> {
    const type = evt?.type;
    const data = evt?.data;
    // Phase 8: Log event type only — no raw data (may contain message content/cookies)
    Logger.log(`[FacebookService:${this.accountId}] [BRIDGE_EVENT] type=${type}`);

    switch (type) {
      case 'e2eeMessage':
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG] handleBridgeEvent: received e2eeMessage event`);
        await this.handleE2EEMessage(data);
        break;

      case 'message':
        // Non-E2EE message from bridge (same as MQTT) - normalize & route
        this.handleBridgeGroupMessage(data);
        break;

      case 'ready':
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge ready (isNewSession=${data?.isNewSession})`);
        break;

      case 'deviceDataChanged':
        // DEPLAO_ADAPTER: device state persistence is handled in the listener
        // callback (line 1019) before this switch. Log at debug level only.
        break;

      case 'e2eeConnected':
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge: e2eeConnected`);
        this.setE2EEStatus('connected');
        break;

      case 'disconnected':
        Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge: disconnected ${JSON.stringify(data)}`);
        // The process can stay alive while its internal LightSpeed socket is
        // offline. Do not report that stale bridge as ready for a new send.
        this.setE2EEStatus('disconnected');
        break;

      case 'reconnected':
        // Meta's LightSpeed socket owns its own reconnect loop. Do not spawn a
        // second bridge here: that would create two device/socket lifecycles.
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge LightSpeed socket reconnected`);
        this.setE2EEStatus('connected');
        break;

      case 'error':
        {
          const message = String(data?.message || data?.error || 'Unknown bridge error');
          const code = Number(data?.code || 0);
          // A DatabaseQuery timeout while handling the connect acknowledgement
          // is a transport-side Meta failure. messagix closes that socket and
          // reconnects internally, so it is neither an expired login nor an
          // application failure. Keep permanent/decryption failures prominent.
          const transientSocketSync = code === 0 && /(?:timeout waiting for response|failed to ensure db \d+ is synced|failed to handle connect ack|lightspeed socket request)/i.test(message);
          if (transientSocketSync) {
            // DEPLAO_ADAPTER: Transient socket sync errors are handled internally
            // by Meta's LightSpeed reconnect loop. The Facebook account itself
            // remains connected, but this E2EE socket cannot send until it has
            // re-established its state. Keep that distinction visible to the
            // send path without marking the account/cookie as failed.
            this.setE2EEStatus('connecting');
            Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge socket sync timed out (transient, Meta reconnect in progress)`);
          } else {
            Logger.error(`[FacebookService:${this.accountId}] E2EE bridge event error${code ? ` (code=${code})` : ''}: ${message}`);
          }
        }
        break;

      case 'raw':
        // Raw MQTT delta forwarded by bridge - log at debug level only
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
        // Delivery receipt for E2EE messages - informational only
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
          // threadId=0 means bridge couldn't determine thread - pass empty string
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
  // @ts-ignore - gọi từ handleBridgeEvent
  private async handleE2EEMessage(data: FBE2EEMessageRaw): Promise<void> {
    if (!data) {
      Logger.log(`[FacebookService:${this.accountId}] handleE2EEMessage: data is null/undefined`);
      return;
    }

    // Phase 8: Log metadata only — never log full message body/content
    Logger.log(`[FacebookService:${this.accountId}] [E2EE_RECV] msgId=${data?.id} sender=${data?.senderId} thread=${data?.threadId} hasText=${!!data?.text} hasAttach=${!!data?.attachments?.length}`);
    if (data.attachments?.length) {
      // Phase 8: Log attachment metadata only — no URLs, no content
      for (let i = 0; i < data.attachments.length; i++) {
        const a = data.attachments[i] as any;
        Logger.log(`[FacebookService:${this.accountId}] [E2EE_ATTACH] type=${a.type || a.attachmentType} hasDirectPath=${!!a.directPath} hasMediaKey=${!!a.mediaKey} mimeType=${a.mimeType || '(none)'}`);
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
      mentions: data.mentions || [],
      attachments: {
        id: 0,
        url: null,
      },
      isE2EE: true,
      chatJid: data.chatJid,
      senderJid: data.senderJid,
      // Extract replyTo info from bridge data - tin nhắn trả lời tin nhắn khác
      replyToMessageId: data.replyTo?.messageId,
      replyToSenderId: data.replyTo?.senderId != null ? String(data.replyTo.senderId) : undefined,
    };

    // Parse attachments nếu có
    // Go bridge Attachment struct sends: type (lowercase), url, fileName, mimeType,
    // fileSize, width, height, stickerId, mediaKey, mediaSha256, directPath, ...
    // KHÔNG có trường "id" hay "attachmentType" - cần map đúng tên
    // E2EE media (image/video/audio/file) không có URL mà có directPath + mediaKey
    // để download qua bridge - cần preserve để lưu DB và download sau này
    if (data.attachments?.length) {
      const raw = data.attachments as any[];
      const mapped = raw.map((a: any, idx: number) => ({
        id: a.stickerId || idx + 1,                    // Go: không có id, dùng index
        url: a.url || null,                             // Go: url (null với E2EE image)
        attachmentType: a.type || a.attachmentType,     // Go: "type" (lowercase) - image/video/file/audio
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
    // ⚠️ PHẢI await handleIncomingMessage trước khi download E2EE media,
    // để fb:onMessage broadcast đến UI trước event:localPath.
    // Nếu không → race: event:localPath fired trước khi message có trong store
    // → local_paths bị mất → video không bao giờ play được.
    await this.handleIncomingMessage(msg);

    // Auto-download E2EE media (image/video/audio/file) sau khi save message
    const e2eeAttachments = data.attachments as any[] | undefined;
    if (e2eeAttachments?.length && msg.messageID) {
      // ⚠️ PHẢI await để catch lỗi download, đặc biệt video.
      // Không fire-and-forget - nếu bridge không support download video,
      // cần log để debug.
      try {
        await this.downloadE2EEAttachments(e2eeAttachments, msg.messageID, threadId);
      } catch (err: any) {
        Logger.error(`[FacebookService:${this.accountId}] E2EE download error: ${err.message}`);
      }
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

    // Parse attachments tu bridge data (non-E2EE group messages)
    // Bridge gui attachments array: [{ type, url, fileName, mimeType, fileSize, ... }]
    if (data.attachments?.length) {
      const raw = data.attachments as any[];
      const mapped = raw.map((a: any, idx: number) => ({
        id: idx + 1,
        url: a.url || null,
        attachmentType: a.type || a.attachmentType || 'file',
        name: a.fileName || a.name || '',
        fileSize: a.fileSize,
        mimeType: a.mimeType,
      }));
      msg.attachments = mapped[0];
      if (mapped.length > 1) {
        msg.allAttachments = mapped;
      }
    }

    this.handleIncomingMessage(msg).catch(err =>
      Logger.warn(`[FacebookService:${this.accountId}] Bridge group message persist error: ${err.message}`)
    );
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

    // Save to DB with type='system' - saveFBMessage handles fb_messages + unified messages + thread preview + contacts
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

    // Broadcast as system notification - UI's normalizeFBMessage respects msg_type override
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
          Logger.warn(`[FacebookService:${this.accountId}] [E2EE] Sticker missing directPath/mediaKey - bridge không cung cấp dữ liệu download cho sticker, cần fix Go bridge (mautrix-meta) để extract sticker attachment fields`);
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
        } else {
          Logger.warn(`[FacebookService:${this.accountId}] E2EE download returned no data - mediaType=${att.type || 'image'} mimeType=${att.mimeType || ''} size=${att.fileSize || 0}. Go bridge may not support downloading this media type.`);
        }
      } catch (err: any) {
        if (/too large|exceed/i.test(err.message)) {
          metricInc('fb_e2ee_media_rejected_too_large', this.accountId, { mediaType: att.type });
        }
        Logger.warn(`[FacebookService:${this.accountId}] E2EE download failed: ${err.message}`);
      }
    }
  }

  /**
   * Kiểm tra contact đã có tên chưa, nếu chưa thì fetch từ Facebook HTML.
   * Fire-and-forget - gọi khi nhận message đầu tiên, update DB sau đó.
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
      const fbId = this.getFacebookId();
      if (info.name) {
        db.run?.(
          `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
           VALUES (?, ?, ?, ?, 0, 'user', 0, '', 0, 'facebook')
           ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
             display_name = excluded.display_name,
             avatar_url = excluded.avatar_url`,
          [fbId, fbUserId, info.name, info.avatarUrl || '']
        );
      } else if (info.avatarUrl) {
        db.run?.(
          `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
          [info.avatarUrl, fbId, fbUserId]
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

    Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] downloadNonE2EEAttachments: msgId=${msg.messageID} attachments=${attachments.length} threadId=${threadId}`);

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: url=${(att.url || '').slice(0,80)}... directPath=${!!att.directPath} attachmentType=${att.attachmentType || '?'}`);
      if (!att.url || att.directPath) {
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: SKIP - no URL or has directPath`);
        continue;
      }
      // Link type attachments (URL shares) don't need local download
      if (att.attachmentType === 'link') {
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: SKIP - type=link, no download needed`);
        continue;
      }

      try {
        const url = String(att.url);
        const ext = (() => { try { return path.extname(new URL(url).pathname) || '.bin'; } catch { return '.bin'; } })();
        const filename = `fb_${msg.messageID.slice(-8)}_${Date.now()}${ext}`;
        Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: url=${url.slice(0,100)}... ext=${ext} filename=${filename}`);

        // Dùng đúng method theo loại file - audio/file không thể dùng downloadImage
        const attType = att.attachmentType || '';
        let localPath: string;
        if (attType === 'image' || attType === 'sticker') {
          Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: calling downloadImage`);
          localPath = await FileStorageService.downloadImage(fbId, url, filename, cookies, undefined, 'https://www.facebook.com/');
        } else if (attType === 'video') {
          // MQTT video URL thường là thumbnail (.jpg), không phải video thật
          // Nếu URL kết thúc bằng đuôi ảnh → skip download (ko có video để tải)
          const videoExt = ext.toLowerCase();
          if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(videoExt)) {
            Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: SKIP - URL is image thumbnail (${ext}), not actual video`);
            continue;
          }
          Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: calling downloadVideo`);
          localPath = await FileStorageService.downloadVideo(fbId, url, filename, cookies, undefined);
        } else {
          // audio, file, unknown → dùng downloadFile
          Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: calling downloadFile (type=${attType})`);
          localPath = await FileStorageService.downloadFile(fbId, url, filename, cookies, undefined);
        }
        if (localPath) {
          Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: SUCCESS - localPath=${localPath}`);
          localPaths[`att_${i}`] = localPath;
        } else {
          Logger.warn(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: download returned empty path`);
        }
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: ERROR - ${err.message}`);
      }
    }

    if (Object.keys(localPaths).length > 0) {
      Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] Broadcasting event:localPath with ${Object.keys(localPaths).length} paths`);
      DatabaseService.getInstance().updateLocalPaths(fbId, msg.messageID, localPaths);
      EventBroadcaster.emit('event:localPath', {
        zaloId: fbId,
        msgId: msg.messageID,
        threadId,
        localPaths,
      });
    } else {
      Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] No local paths to broadcast`);
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
   * @throws Error nếu bridge không thể khởi động - caller nên kiểm tra isE2EEConnected()
   */
  public async retryE2EE(): Promise<void> {
    // A stalled send can otherwise start several stop/spawn sequences at the
    // same time. Those sequences invalidate one another's bridge generation
    // and make every caller wait without a useful error.
    if (this.e2eeRetryPromise) return this.e2eeRetryPromise;

    const retry = (async () => {
      Logger.log(`[FacebookService:${this.accountId}] Restarting E2EE bridge on demand`);
      await this.stopE2EEBridge();
      this.e2eeEnabled = true;
      this.e2eeStatus = 'disconnected';

      const fbId = this.getFacebookId() || this.dataFB?.FacebookID;
      if (!fbId) {
        throw new Error('Cannot retry E2EE: no Facebook ID available');
      }
      await this.startE2EEBridge(fbId);
      if (!this.isE2EEConnected()) {
        throw new Error('E2EE bridge retry failed - bridge not connected after startup');
      }
    })();
    this.e2eeRetryPromise = retry;
    try {
      await retry;
    } finally {
      if (this.e2eeRetryPromise === retry) this.e2eeRetryPromise = null;
    }
  }

  // ─── E2EE Public Methods ──────────────────────────────────────────────────

  /**
   * `not connected` is returned before the bridge hands a message to Meta.
   * It is safe to rebuild the bridge and retry once. Timeouts and all other
   * errors are deliberately not retried because their outcome is ambiguous.
   */
  private isSafeE2EEReconnectError(error: unknown): boolean {
    const message = String((error as any)?.message || error || '').toLowerCase();
    if (!message || /timeout|timed out|etimedout/.test(message)) return false;
    return /(?:e2ee\s+)?(?:bridge\s+)?not connected\b|bridge not ready\b|bridge exited\b|write after end\b|broken pipe\b|connection reset\b/.test(message);
  }

  /** Restart once and bound the wait so a queued chat message cannot hang. */
  private async recoverE2EEForSend(): Promise<string | null> {
    this.setE2EEStatus('disconnected');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.retryE2EE(),
        new Promise<void>((_, reject) => {
          // The startup path has three bounded bridge RPCs: newClient (25s),
          // connect (30s), and connectE2EE (20s). The old 20s wrapper fired
          // while a healthy reconnect was still in progress, leaving the
          // shared retry promise wedged after resume from sleep.
          timer = setTimeout(() => reject(new Error('E2EE reconnect timed out after 80s')), 80_000);
        }),
      ]);
      return this.isE2EEConnected() ? null : 'E2EE bridge chưa sẵn sàng sau khi kết nối lại.';
    } catch (err: any) {
      return String(err?.message || err || 'E2EE reconnect failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A bounded send attempt; recovery is kept outside to prevent unsafe retry. */
  private async sendE2EETextOnce(
    chatJid: string,
    text: string,
    replyToMessageId: string = '',
    replyToSenderJid: string = '',
  ): Promise<{ messageId?: string; timestampMs?: number }> {
    if (!this.isE2EEConnected() || !this.e2eeBridge?.isAlive()) {
      throw new Error('E2EE send failed: not connected');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.e2eeBridge.sendE2EEMessage({ chatJid, text, replyToId: replyToMessageId, replyToSenderJid }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('E2EE send timeout')), 15_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Gửi tin nhắn E2EE 1:1 */
  public async sendE2EEMessage(
    chatJid: string,
    text: string,
    opts?: FBSendOptions,
    replyToSenderJid: string = '',
  ): Promise<FBSendResult> {
    const normalizedChatJid = normalizeChatJid(chatJid);
    const sendOnce = () => this.sendE2EETextOnce(
      normalizedChatJid,
      text,
      opts?.replyToMessageId || '',
      replyToSenderJid ? normalizeChatJid(replyToSenderJid) : '',
    );

    try {
      const result = await sendOnce();
      return { success: true, messageId: result.messageId, timestamp: result.timestampMs || Date.now() };
    } catch (err: any) {
      if (!this.isSafeE2EEReconnectError(err)) {
        return { success: false, error: String(err?.message || err || 'Unknown E2EE send error') };
      }

      Logger.warn(`[FacebookService:${this.accountId}] E2EE pre-flight disconnect; reconnecting before one safe resend`);
      const recoveryError = await this.recoverE2EEForSend();
      if (recoveryError) {
        return { success: false, error: `E2EE đang kết nối lại: ${recoveryError}` };
      }

      try {
        const result = await sendOnce();
        return { success: true, messageId: result.messageId, timestamp: result.timestampMs || Date.now() };
      } catch (retryErr: any) {
        return { success: false, error: `E2EE send failed after reconnect: ${String(retryErr?.message || retryErr || 'unknown error')}` };
      }
    }
  }

  /** Kiểm tra E2EE có đang kết nối */
  public isE2EEConnected(): boolean {
    return this.e2eeStatus === 'connected' && this.e2eeBridge?.isAlive() === true;
  }

  /** A normal 1:1 is only considered known after a REST probe succeeded in
   * this session. Unknown 1:1 conversations must not be downgraded after an
   * ambiguous E2EE attempt. */
  public isKnownNonE2EEThread(threadId: string): boolean {
    return this._nonE2EEThreads.has(threadId);
  }

  /** Lấy trạng thái E2EE hiện tại */
  public getE2EEStatus(): FBE2EEStatus {
    return this.e2eeStatus;
  }

  /** Lấy sender instance (for external use) */
  public getE2EESender(): FacebookE2EESender | null {
    return this.e2eeSender;
  }

  /**
   * Attachment upload has the same stale-bridge failure mode as text sends.
   * Retry only the deterministic pre-flight disconnect once; never replay a
   * timeout or an upload error because Facebook may already have accepted it.
   */
  private async sendE2EEMediaWithRecovery(
    sendOnce: () => Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }>,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    let result = await sendOnce();
    if (result.success || !this.isSafeE2EEReconnectError(result.error)) return result;

    Logger.warn(`[FacebookService:${this.accountId}] E2EE media pre-flight disconnect; reconnecting before one safe resend`);
    const recoveryError = await this.recoverE2EEForSend();
    if (recoveryError) return { success: false, error: `E2EE đang kết nối lại: ${recoveryError}` };

    result = await sendOnce();
    if (!result.success && this.isSafeE2EEReconnectError(result.error)) {
      return { ...result, error: `E2EE media send failed after reconnect: ${result.error || 'not connected'}` };
    }
    return result;
  }

  /** Gửi ảnh qua E2EE 1:1 */
  public async sendE2EEImage(
    chatJid: string,
    imagePath: string,
    caption?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    const result = await this.sendE2EEMediaWithRecovery(async () => {
      if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
      return this.e2eeSender.sendImage(chatJid, imagePath, caption);
    });
    if (result.success && result.messageId) this.markMessageLocallySent(result.messageId);
    return result;
  }

  /** Gửi video qua E2EE 1:1 */
  public async sendE2EEVideo(
    chatJid: string,
    videoPath: string,
    caption?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    const result = await this.sendE2EEMediaWithRecovery(async () => {
      if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
      return this.e2eeSender.sendVideo(chatJid, videoPath, caption);
    });
    if (result.success && result.messageId) this.markMessageLocallySent(result.messageId);
    return result;
  }

  /** Gửi audio qua E2EE 1:1 */
  public async sendE2EEAudio(
    chatJid: string,
    audioPath: string,
    mimeType?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    const result = await this.sendE2EEMediaWithRecovery(async () => {
      if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
      return this.e2eeSender.sendAudio(chatJid, audioPath, mimeType);
    });
    if (result.success && result.messageId) this.markMessageLocallySent(result.messageId);
    return result;
  }

  /** Gửi file qua E2EE 1:1 */
  public async sendE2EEFile(
    chatJid: string,
    filePath: string,
    fileName?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    const result = await this.sendE2EEMediaWithRecovery(async () => {
      if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
      return this.e2eeSender.sendFile(chatJid, filePath, fileName);
    });
    if (result.success && result.messageId) this.markMessageLocallySent(result.messageId);
    return result;
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
    if (!this.e2eeBridge?.isAlive()) return;
    try {
      // Route by thread kind: 1:1 → E2EE typing, group → normal typing
      const resolved = await resolveThreadKind(threadId, undefined, this.accountId);
      if (resolved.kind === 'user') {
        // E2EE 1:1
        if (this.isE2EEConnected()) {
          await this.e2eeBridge.sendE2EETyping({
            chatJid: normalizeChatJid(threadId),
            isTyping,
          });
        }
      } else if (resolved.kind === 'group') {
        // Group — best effort, no await needed
        this.e2eeBridge.sendTypingIndicator({
          threadId,
          isTyping,
          isGroup: true,
        }).catch(() => {});
      }
      // Unknown kind → don't send (safe default)
    } catch {
      // Typing is best-effort — don't throw
    }
  }

  /** Đánh dấu thread đã đọc trên Facebook server */
  public async markReadOnServer(threadId: string): Promise<{ success: boolean; error?: string }> {
    const route = await resolveThreadKind(threadId, undefined, this.accountId);
    if (route.kind === 'unknown') return { success: false, error: route.error };
    if (!this.e2eeBridge?.isAlive()) return { success: false, error: 'Facebook bridge chưa sẵn sàng.' };
    try {
      // Prefer the newest message timestamp. Date.now() can incorrectly mark
      // newer server messages as read after a delayed local event.
      const newest = DatabaseService.getInstance().queryOne?.(
        `SELECT MAX(timestamp) AS timestamp FROM fb_messages WHERE thread_id = ? AND account_id = ?`,
        [threadId, this.accountId],
      ) as { timestamp?: number } | undefined;
      await this.e2eeBridge.markRead({
        threadId,
        watermarkTs: Number(newest?.timestamp) || Date.now(),
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
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
    if (!this.dataFB) throw new Error('Not connected - call connect() first');
    return this.dataFB;
  }

  /**
   * Gửi tin nhắn với E2EE auto-detect.
   *
   * Routing strategy:
   *   1. Xác định 1:1 vs group: opts.typeChat → nếu không có → query fb_threads.type
   *   2. 1:1 → E2EE trước (bridge sendE2EEMessage). Nếu bridge E2EE chưa connect → retry trước.
   *   3. 1:1 E2EE success → đánh dấu thread là E2EE. E2EE fail → REST API fallback.
   *   4. GROUP → REST API. Nếu REST fail → bridge sendMessage fallback.
   *
   * TẤT CẢ các path thành công đều gọi markMessageLocallySent() để ngăn self-echo duplicate.
   */
  public async sendMessage(threadId: string, body: string, opts?: FBSendOptions): Promise<FBSendResult> {
    const agent = this.httpsAgent;
    // ── Resolve 1:1 vs group (Phase 4: use resolveThreadKind) ───────────
    // DEPLAO_ADAPTER: No numeric-ID inference. Caller supplies typeChat or we
    // resolve from DB. Unknown → structured error, never guess.
    const resolved = await resolveThreadKind(threadId, opts?.typeChat, this.accountId);
    if (resolved.kind === 'unknown') {
      metricInc('fb_thread_kind_unknown', this.accountId);
      return { success: false, error: resolved.error };
    }
    const is1on1 = resolved.kind === 'user';

    // ── Ensure connection is alive before sending ─────────────────────────
    const ready = await this.ensureConnected();
    if (!ready) {
      return { success: false, error: 'Mất kết nối Facebook. Vui lòng kết nối lại tài khoản.' };
    }

    // ═════════════════════════════════════════════════════════════════════
    // 1:1 ROUTING — E2EE ONLY, no REST fallback
    // ═════════════════════════════════════════════════════════════════════
    // DEPLAO_ADAPTER: Per plan §8 — once a thread is resolved as 'user',
    // we send via E2EE bridge exclusively. If E2EE fails, return the error
    // directly. We do NOT fallback to REST for 1:1 conversations.
    // The only exception is the initial probe: if the thread is NOT yet known
    // as E2EE, we try E2EE first; if E2EE probe fails, we try REST once to
    // discover whether this is actually a non-E2EE user thread.
    // If REST succeeds → mark as non-E2EE for future sends.

    if (is1on1) {
      // ── PATH A: E2EE first (skip if thread already known non-E2EE) ────
      if (!this._nonE2EEThreads.has(threadId)) {
        let e2eeReady = this.isE2EEConnected();
        let e2eeRecoveryError = '';
        if (!e2eeReady) {
          Logger.log(`[FacebookService:${this.accountId}] 1:1 send - E2EE not ready, retrying...`);
          e2eeRecoveryError = (await this.recoverE2EEForSend()) || '';
          e2eeReady = this.isE2EEConnected();
          if (e2eeRecoveryError) {
            Logger.warn(`[FacebookService:${this.accountId}] 1:1 E2EE reconnect failed: ${e2eeRecoveryError}`);
          }
        }

        if (e2eeReady) {
          try {
            const r = await this.sendE2EEMessage(normalizeChatJid(threadId), body, opts);
            if (r.success && r.messageId) {
              // E2EE success → mark thread as E2EE
              if (!this.e2eeThreads.has(threadId)) {
                this.e2eeThreads.add(threadId);
                try { DatabaseService.getInstance().markFBThreadE2EE(threadId, this.accountId); } catch {}
                this._nonE2EEThreads.delete(threadId);
              }
              this.markMessageLocallySent(r.messageId);
              Logger.log(`[FacebookService:${this.accountId}] 1:1 E2EE OK: msgId=${r.messageId} - marked thread as E2EE`);
              return { success: true, messageId: r.messageId, timestamp: r.timestamp };
            }
            throw new Error(r.error || 'E2EE send did not return a message ID.');
          } catch (err: any) {
            // DEPLAO_ADAPTER: A thread that has already succeeded with E2EE
            // must NEVER be downgraded to REST merely because a send failed.
            if (this.e2eeThreads.has(threadId)) {
              return { success: false, error: `Không thể gửi tin nhắn E2EE: ${err.message}` };
            }
            // DEPLAO_ADAPTER: If E2EE timed out, the message may have been
            // sent but response lost. Do NOT fallback to REST to avoid duplicate.
            // Only fallback for real connection errors (not timeout).
            if (/timeout|ETIMEDOUT/i.test(err.message || '')) {
              Logger.warn(`[FacebookService:${this.accountId}] 1:1 E2EE timed out — NOT retrying REST (may duplicate)`);
              return { success: false, error: `E2EE send timeout — tin nhắn có thể đã gửi. Vui lòng kiểm tra.` };
            }
            // Do not infer transport from a generic bridge failure. The remote
            // operation may have succeeded even though its response was lost.
            // A normal 1:1 may use REST only when we have not attempted E2EE
            // (bridge unavailable) or a future explicit capability signal.
            return { success: false, error: `E2EE send failed: ${err.message}` };
          }
        }

        // A fulfilled bridge response without a message ID is equally
        // ambiguous. Never turn it into a REST send.
        if (e2eeReady) {
          return { success: false, error: 'E2EE send did not return a message ID.' };
        }

        // A known E2EE thread must never be sent through REST merely because
        // its socket is reconnecting. The request may be retried manually once
        // the bridge recovers, without risking a duplicate or protocol error.
        if (this.e2eeThreads.has(threadId)) {
          return {
            success: false,
            error: e2eeRecoveryError
              ? `E2EE đang kết nối lại: ${e2eeRecoveryError}`
              : 'E2EE đang kết nối lại. Vui lòng thử lại sau vài giây.',
          };
        }
      }

      // ── PATH B: REST probe (only for threads not yet known as E2EE) ──
      // If this thread is already known E2EE, we already returned above.
      // If REST succeeds → mark as non-E2EE, return success.
      // If REST fails → return error. No E2EE retry (avoids PATH C loop).
      const restResult = await sendMessageREST(this.requireSession(), threadId, body, opts, agent);
      if (restResult.success && restResult.messageId) {
        if (!this._nonE2EEThreads.has(threadId)) {
          this._nonE2EEThreads.add(threadId);
          Logger.log(`[FacebookService:${this.accountId}] 1:1 REST OK - marked thread as non-E2EE`);
        }
        this.markMessageLocallySent(restResult.messageId);
        return restResult;
      }

      // Both E2EE probe and REST probe failed → return REST error
      return restResult;
    }

    // ═════════════════════════════════════════════════════════════════════
    // GROUP ROUTING — REST ONLY, no bridge fallback
    // ═════════════════════════════════════════════════════════════════════
    // DEPLAO_ADAPTER: Group messages go through REST exclusively.
    // Bridge sendMessage for groups is unreliable and not part of the plan.

    const result = await sendMessageREST(this.requireSession(), threadId, body, opts, agent);
    if (result.success && result.messageId) {
      this.markMessageLocallySent(result.messageId);
      return result;
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
        return {
          success: false,
          error: 'Hội thoại này đã được mã hoá 1-1 (E2EE) nhưng bridge chưa kết nối. Vui lòng build fbchat-bridge-e2ee.',
        };
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

  private async resolveMessageThreadKind(messageId: string): Promise<{ threadId?: string; senderId?: string; kind: 'user' | 'group' | 'unknown'; error?: string }> {
    const message = DatabaseService.getInstance().queryOne?.(
      'SELECT thread_id, sender_id FROM fb_messages WHERE id = ? AND account_id = ?',
      [messageId, this.accountId],
    ) as { thread_id?: string; sender_id?: string } | undefined;
    if (!message?.thread_id) return { kind: 'unknown', error: 'Không tìm thấy hội thoại của tin nhắn.' };
    const resolved = await resolveThreadKind(message.thread_id, undefined, this.accountId);
    return { threadId: message.thread_id, senderId: message.sender_id, ...resolved };
  }

  public async unsendMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    const route = await this.resolveMessageThreadKind(messageId);
    if (route.kind === 'unknown' || !route.threadId) return { success: false, error: route.error };
    if (route.kind === 'user') {
      if (!this.isE2EEConnected()) return { success: false, error: 'E2EE bridge chưa sẵn sàng.' };
      try {
        await this.e2eeBridge!.unsendE2EEMessage({ chatJid: normalizeChatJid(route.threadId), messageId });
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
    return unsendMessage(this.requireSession(), messageId, this.httpsAgent);
  }

  public async addReaction(messageId: string, emoji: string, action?: FBReactionAction) {
    const route = await this.resolveMessageThreadKind(messageId);
    if (route.kind === 'unknown' || !route.threadId) return { success: false, error: route.error };
    if (route.kind === 'user') {
      if (!this.isE2EEConnected()) return { success: false, error: 'E2EE bridge chưa sẵn sàng.' };
      // The encrypted message key is tied to the original sender JID. An
      // internal Deplao account UUID is not a valid JID.
      if (!route.senderId) return { success: false, error: 'Thiếu người gửi của tin nhắn E2EE.' };
      return this.sendE2EEReaction(
        normalizeChatJid(route.threadId),
        messageId,
        normalizeChatJid(route.senderId),
        action === 'remove' ? '' : emoji,
      );
    }
    return addReaction(this.requireSession(), messageId, emoji, action, this.httpsAgent);
  }

  public async editMessage(messageId: string, newText: string): Promise<{ success: boolean; error?: string }> {
    const route = await this.resolveMessageThreadKind(messageId);
    if (route.kind === 'unknown' || !route.threadId) return { success: false, error: route.error };
    if (route.kind === 'user') {
      if (!this.isE2EEConnected()) return { success: false, error: 'E2EE bridge chưa sẵn sàng.' };
      try {
        await this.e2eeBridge!.editE2EEMessage({ chatJid: normalizeChatJid(route.threadId), messageId, newText });
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
    return editMessage(this.requireSession(), messageId, newText, this.httpsAgent);
  }

  public async forwardMessage(
    messageId: string,
    targetThreadId: string,
    typeChat?: 'user' | null,
  ): Promise<{ success: boolean; error?: string }> {
    const route = await resolveThreadKind(targetThreadId, typeChat, this.accountId);
    if (route.kind === 'unknown') {
      return { success: false, error: route.error };
    }
    if (route.kind === 'user') {
      // The GraphQL forward mutation is not valid for encrypted 1:1. Callers
      // must resend content through FacebookSendService, where media/text are
      // routed to the E2EE bridge safely.
      return { success: false, error: 'Không thể chuyển tiếp native vào chat 1:1. Hãy gửi lại nội dung qua luồng E2EE.' };
    }
    return forwardMessage(this.requireSession(), messageId, targetThreadId, true, this.httpsAgent);
  }

  private async requireGroupOperation(threadId: string, operation: string): Promise<{ success: true } | { success: false; error: string }> {
    const route = await resolveThreadKind(threadId, undefined, this.accountId);
    if (route.kind === 'unknown') return { success: false, error: route.error || 'Không xác định được hội thoại.' };
    if (route.kind === 'user') {
      return { success: false, error: `${operation} chưa hỗ trợ trong chat 1:1 E2EE.` };
    }
    return { success: true };
  }

  public async pinMessage(messageId: string, threadId: string): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, 'Ghim tin nhắn');
    if (!allowed.success) return allowed;
    return pinMessage(this.requireSession(), messageId, threadId, this.httpsAgent);
  }

  public async unpinMessage(messageId: string, threadId: string): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, 'Bỏ ghim tin nhắn');
    if (!allowed.success) return allowed;
    return unpinMessage(this.requireSession(), messageId, threadId, this.httpsAgent);
  }

  public async createPoll(threadId: string, question: string, options: string[]): Promise<{ success: boolean; pollId?: string; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, 'Tạo khảo sát');
    if (!allowed.success) return allowed;
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
   * Dùng khi avatar CDN c (403) - URL oe ã ht hn.
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
   * Khác với isConnected() chỉ check status flag - method này check actual socket.
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
    // A live child process is not proof that Facebook is reachable: its
    // internal LightSpeed socket can be disconnected after the computer comes
    // back online.  Continue with the listener/session health checks below so
    // a stale bridge never masks a necessary account reconnect.

    // ── OVERFLOW PATH: MQTT queue persistently overflow → không tạo listener mới ──
    // Nếu _mqttOverflowCount > 2, việc tạo listener mới chỉ gây thêm overflow.
    // Bridge không alive → refresh session để dùng REST API.
    if (this._mqttOverflowCount > 2) {
      Logger.warn(`[FacebookService:${this.accountId}] MQTT overflow persistent (${this._mqttOverflowCount}x) - using REST only`);
      try {
        this.dataFB = await initSession(this.cookie, this.httpsAgent);
        Logger.log(`[FacebookService:${this.accountId}] Session refreshed for overflow fallback`);
        if (this.status !== 'connected') this.setStatus('connected');
        return true;
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] Session refresh failed: ${err.message}`);
        return false;
      }
    }

    // Service says connected → verify listener thực sự alive
    if (this.status === 'connected' && this.isListenerActuallyConnected()) {
      return true;
    }

    // ── Safety net: nếu listener thực sự alive (đang nhận MQTT) dù status sai ──
    // Có thể bị set sai khi _doConnect() catch block setStatus('error') trong khi
    // MQTT đã connect thành công, hoặc MQTT reconnect thành công nhưng có 1 event
    // 'disconnected' cũ từ listener cũ đến sau. Tránh reconnect không cần thiết.
    if (this.isListenerActuallyConnected()) {
      Logger.warn(`[FacebookService:${this.accountId}] Listener alive but status=${this.status} - correcting to 'connected'`);
      this.setStatus('connected');
      return true;
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Service says connected but listener actually dead → force reconnect
    if (this.status === 'connected' && !this.isListenerActuallyConnected()) {
      Logger.warn(`[FacebookService:${this.accountId}] Status is 'connected' but listener is dead - forcing reconnect`);
      try {
        // Ngắt listener cũ và tạo lại
        if (this.listener) {
          this.listener.disconnect();
          this.listener = null;
        }
        // connect() intentionally no-ops while status is `connected`; clear
        // that stale status before asking it to build a fresh session/listener.
        this._connectPromise = null;
        this.setStatus('disconnected');
        await this.connect(); // ← dùng connect() có guard, không gọi _doConnect() trực tiếp
        // Đợi listener thực sự connected + ổn định
        return await this.waitForStableConnection(30000);
      } catch (err: any) {
        Logger.error(`[FacebookService:${this.accountId}] ensureConnected reconnect failed: ${err.message}`);
        return false;
      }
    }

    // Not connected at all → try to connect
    if (this.status !== 'connected' && this.status !== 'connecting') {
      Logger.log(`[FacebookService:${this.accountId}] Not connected - attempting connect`);
      try {
        await this.connect();
        // Đợi listener thực sự connected + ổn định, vì connect() → _doConnect() start MQTT async
        return await this.waitForStableConnection(30000);
      } catch (err: any) {
        Logger.error(`[FacebookService:${this.accountId}] ensureConnected failed: ${err.message}`);
        return false;
      }
    }

    // Already connecting → wait a bit
    if (this.status === 'connecting') {
      Logger.log(`[FacebookService:${this.accountId}] Already connecting - waiting...`);
      if (this._connectPromise) {
        try {
          const waitPromise = this._connectPromise;
          await Promise.race([waitPromise, new Promise(r => setTimeout(r, 15000))]);
        } catch {}
      }
      // Đợi thêm listener thực sự connected + ổn định (phòng trường hợp _connectPromise resolve
      // nhưng MQTT chưa kịp handshake và lập tức bị overflow)
      return await this.waitForStableConnection(15000);
    }

    return false;
  }

  /**
   * Đợi MQTT listener thực sự connected với timeout.
   * _doConnect() start MQTT listener async (this.listener.connect()) và không đợi
   * WebSocket handshake hoàn tất. Hàm này poll isListenerActuallyConnected() định kỳ
   * để tránh false-positive khi MQTT chưa kịp connect.
   * KHÔNG check this.status vì listener có thể connected dù status bị sai
   * (do catch block setStatus('error') trong _doConnect()).
   */
  private async waitForListenerReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isListenerActuallyConnected()) {
        // Correct status if it got out of sync
        if (this.status !== 'connected') {
          this.setStatus('connected');
        }
        return true;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return this.isListenerActuallyConnected();
  }

  /**
   * Đợi MQTT listener connected + verify stability.
   * Gọi waitForListenerReady trước, sau đó đợi thêm 1s và kiểm tra listener
   * còn connected không. Tránh race condition khi MQTT vừa connect xong
   * nhưng lập tức bị ERROR_QUEUE_OVERFLOW → disconnect → reconnect timer.
   *
   * Nếu listener connected ổn định (vẫn alive sau 1s) → return true.
   * Nếu listener chết sau connected → retry waitForListenerReady (tối đa 2 lần).
   */
  private async waitForStableConnection(timeoutMs: number): Promise<boolean> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ready = await this.waitForListenerReady(timeoutMs);
      if (!ready) return false;

      // Stability window: đợi 1s để verify connection không bị overflow ngay
      await new Promise(r => setTimeout(r, 1000));

      if (this.isListenerActuallyConnected()) {
        if (this.status !== 'connected') this.setStatus('connected');
        Logger.log(`[FacebookService:${this.accountId}] Connection stable after ${attempt} attempt(s)`);
        return true;
      }

      // Connection died during stability window (likely overflow) → retry
      Logger.warn(`[FacebookService:${this.accountId}] Connection lost during stability check (attempt ${attempt}/${MAX_ATTEMPTS}) - retrying`);
    }

    Logger.warn(`[FacebookService:${this.accountId}] Connection unstable after ${MAX_ATTEMPTS} attempts - giving up`);
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
