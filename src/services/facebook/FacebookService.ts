/**
 * FacebookService.ts
 * Orchestrator singleton per account
 * Similar to ZaloService - manages the session lifecycle + listener + API calls
 */

import {
  FBSessionData, FBAccountStatus, FBSendOptions, FBSendResult,
  FBReactionAction, FBAttachmentUploadResult, FBThread, FBMQTTMessage,
  FBE2EEStatus, FBE2EEMessageRaw, FBE2EESendResult,
} from './FacebookTypes';
import { getFacebookAvatarById, initSession } from './FacebookSession';
import { getFacebookUserInfo } from './FacebookUserInfo';
import { sendMessage as sendMessageREST, unsendMessage, addReaction, editMessage, forwardMessage, pinMessage, unpinMessage, createPoll, votePoll } from './send/FacebookMessageSender';
import { uploadAttachment } from './send/FacebookAttachment';
import {
  getThreadList, getThreadListPage, parseThreadNodes, fetchThreadMessages,
  changeThreadName, changeThreadEmoji, changeNickname,
  addGroupAdmin, removeGroupAdmin, changeApprovalMode,
  approvePendingMember, getGroupLink, setGroupLink,
} from './FacebookThreadManager';
import { blockUser, unblockUser } from './actions/FacebookBlock';
import { changeThreadTheme } from './actions/FacebookChangeTheme';
import { createNote } from './actions/FacebookCreateNotes';
import { FacebookMQTTListener } from './FacebookMQTTListener';
import { FacebookE2EEBridge, BridgeInitialData, type BridgeHistoryPage } from './e2ee/FacebookE2EEBridge';
import {
  activityMs, isLightSpeedMessageId, messageInRange, nextHistoryAnchor, type FbHistorySyncRange,
} from '../../shared/facebook/facebookHistorySync';
import { FacebookHumanPacer, sleepUnlessStopped, type PacerWait } from './send/FacebookHumanPacer';
import {
  FB_TEMPLATE_MSG_TYPE, fbTemplateText, fbUnsupportedText, isFbUnavailableTemplate, templateFromBridgeAttachment, withTemplateText,
  type FbTemplate,
} from '../../shared/facebook/facebookTemplate';
import { FacebookE2EESender, e2eeSendOutcome } from './e2ee/FacebookE2EESender';
import { parseE2EECookies, resolveE2EEBinaryPath, normalizeChatJid } from './FacebookUtils';
import { FacebookE2EEStateStore } from './e2ee/FacebookE2EEStateStore';
import { resolveThreadKind } from './FacebookThreadKind';
import { FacebookEventPipeline, EventPriority, bridgeEventKey } from './FacebookEventPipeline';
import { createRepeatFilter, reactionRepeat, unsendRepeat, type RepeatFilter } from './FacebookEventRepeats';
import { metricInc } from './FacebookMetrics';
import EventBroadcaster from '../event/EventBroadcaster';
import { messageTimestampById, recordPeerReceipt } from '../receipts/peerReceipts';
import { mediaProgressReporter } from '../media/mediaProgress';
import DatabaseService, { type FbSaveOutcome } from '../database/DatabaseService';
import FileStorageService from '../file/FileStorageService';
import { createProxyAgent } from '../../utils/connection/ProxyHelper';
import { secureGet } from '../secure/SecureSettingsService';
import path from 'path';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

// ─── Cookie key helper ─────────────────────────────────────────────────

function fbCookieKey(accountId: string): string {
  return `fb_cookie_${accountId}`;
}

/** Compare signed Facebook CDN URLs without treating unrelated image URLs as equal. */
function isSameFacebookAvatar(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  try {
    const a = new URL(left);
    const b = new URL(right);
    const aHash = a.searchParams.get('oh');
    const bHash = b.searchParams.get('oh');
    return !!aHash && aHash === bHash;
  } catch {
    return false;
  }
}

/** GraphQL page when the conversation has no Messenger message yet in the machine to use as the mark for FetchMessagesTask (~1 Messenger web page). */
const HISTORY_GRAPHQL_PAGE = 20;
/** If the newest message on the machine is older than the conversation's latest activity by more than this, the machine is missing messages at the start of the conversation. */
const HISTORY_TOP_GAP_MS = 60_000;
const HISTORY_RISK_TEXT = tr('Facebook có dấu hiệu hạn chế / yêu cầu xác minh — đã tạm dừng tải lịch sử 30 phút để bảo vệ tài khoản');
/** Where a history page comes from: the LightSpeed FetchMessagesTask (bridge) or GraphQL (when there is no message to use as the mark yet). */
type FbHistorySource = 'lightspeed' | 'graphql';
type FbHistoryPageResult =
  | { success: true; saved: number; received: number; stored: number; count: number; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string; source: FbHistorySource }
  | { success: false; code: 'BRIDGE_DOWN' | 'BRIDGE_OLD' | 'E2EE' | 'FETCH' | 'RISK' | 'COOLDOWN' | 'BUSY' | 'CANCELLED'; error: string; source?: FbHistorySource };

export class FacebookService {
  private static instances = new Map<string, FacebookService>();
  /** In-flight getInstance/connect per account — see FB-03 (no zombie instance). */
  private static pendingConnections = new Map<string, Promise<FacebookService>>();

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
  /** Last known good MQTT seqId - used as the fallback when getLastSeqId fails,
   *  to avoid connecting with seqId=0 → ERROR_QUEUE_OVERFLOW */
  private _lastGoodSeqId: string = '0';
  /** Counts how many times the MQTT listener hit a persistent ERROR_QUEUE_OVERFLOW.
   *  When > 0, ensureConnected() no longer creates a new MQTT listener,
   *  it only uses the bridge status to decide whether a message can be sent. */
  private _mqttOverflowCount: number = 0;

  // ─── E2EE Bridge ──────────────────────────────────────────────────────────
  private e2eeBridge: FacebookE2EEBridge | null = null;
  private e2eeSender: FacebookE2EESender | null = null;
  private e2eeStatus: FBE2EEStatus = 'disconnected';
  /** Serialize on-demand restarts so repeated sends cannot race bridge generations. */
  private e2eeRetryPromise: Promise<void> | null = null;
  private e2eeEnabled: boolean = true; // Can be disabled if the binary is not found
  /** Track thread IDs known to be E2EE-encrypted (auto-populated on error) */
  private e2eeThreads: Set<string> = new Set();
  /** The history loading pace "giống người dùng thật" (like a real user), shared by the background sync and the load on scroll of this account. */
  private readonly historyPacer = new FacebookHumanPacer();
  /** Track thread IDs known to be NON-E2EE (sent through the bridge sendMessage / MQTT successfully) */
  private _nonE2EEThreads: Set<string> = new Set();
  /** Debounce avatar refresh - only once per user / session */
  private avatarRefreshDebounce = new Set<string>();
  /** Bridge instance ID - incremented each time startE2EEBridge runs, used to detect stale reconnect timers (BUG #6 fix) */
  private e2eeBridgeGen: number = 0;
  /** Heartbeat timer that checks the bridge is still responsive (BUG #8 fix) */
  private _e2eeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Debounced recovery after the E2EE socket disconnects while the process lives. */
  private _e2eeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive automatic reconnects; prevents a failed handshake from churning every 5s. */
  private _e2eeReconnectAttempts: number = 0;
  /** Counts consecutive heartbeat failures - after 2 → kill + respawn */
  private _e2eeHeartbeatFailCount: number = 0;
  /** Track message IDs sent locally via this service instance.
   *  Used to prevent a self-echo duplicate when the bridge / MQTT echoes back a message that was just sent.
   *  Each entry is deleted by itself after 60 s to avoid a memory leak. */
  private _recentlySentMessageIds: Set<string> = new Set();
  /** Reaction / unsend reported by both MQTT and the bridge: a repeat is not written / replayed (FacebookEventRepeats). */
  private _eventRepeats: RepeatFilter | null = null;
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

  /** Create a proxy agent from proxyId */
  private resolveProxyAgent(): any {
    if (!this.proxyId) return undefined;
    try {
      const proxy = DatabaseService.getInstance().getProxyById(this.proxyId);
      if (proxy) return createProxyAgent(proxy);
    } catch {}
    return undefined;
  }

  /** Update the proxy (called when the user changes the proxy for the account) */
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
   * Gets or creates the instance, and makes sure it is connected
   */
  /**
   * Resolves a raw account ID to the internal UUID to use as the key in the instances map.
   * Avoids duplicate instances when the caller passes a numeric FB UID instead of a UUID.
   */
  private static resolveInstanceKey(rawId: string): string {
    if (!rawId) return rawId;
    // If it is already a UUID (has hyphens) → return it as is
    if (rawId.includes('-')) return rawId;
    // If it is a Facebook UID (all digits) → look up the UUID in the DB
    if (/^\d+$/.test(rawId)) {
      try {
        const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(rawId);
        if (fbAcc?.id) return fbAcc.id;
      } catch {}
    }
    return rawId;
  }

  public static async getInstance(accountId: string, cookie?: string, proxyId?: number | null): Promise<FacebookService> {
    // Always resolve to the internal UUID to avoid duplicate instances
    const instanceKey = FacebookService.resolveInstanceKey(accountId);

    const existing = FacebookService.instances.get(instanceKey);
    if (existing) return existing;

    // FB-03: single-flight creation. A failed connect() must not leave a
    // zombie instance in the static map — callers would keep receiving it as
    // if it were ready and every later attempt would silently no-op.
    const inFlight = FacebookService.pendingConnections.get(instanceKey);
    if (inFlight) return inFlight;

    const task = (async (): Promise<FacebookService> => {
      let instanceCookie = cookie;
      // If there is no cookie, try to get it from secure storage
      if (!instanceCookie) {
        try {
          // Use instanceKey (already resolved) to look up the cookie
          instanceCookie = secureGet(fbCookieKey(instanceKey)) || undefined;
          // Fallback: get it from the DB (cookie_encrypted)
          if (!instanceCookie) {
            const acc = DatabaseService.getInstance().getFBAccount(instanceKey);
            if (acc?.cookie_encrypted) instanceCookie = acc.cookie_encrypted;
          }
        } catch {}
      }
      if (!instanceCookie) throw new Error(`[FacebookService] Cookie required for new instance: ${accountId}`);
      const service = new FacebookService(instanceKey, instanceCookie, proxyId);
      try {
        // Auto-connect. Only publish the instance once connect() has
        // finished; a thrown connect leaves nothing behind to poison the map.
        await service.connect();
      } catch (err) {
        await service.disconnect().catch(() => {});
        throw err;
      }
      FacebookService.instances.set(instanceKey, service);
      return service;
    })().finally(() => {
      if (FacebookService.pendingConnections.get(instanceKey) === task) {
        FacebookService.pendingConnections.delete(instanceKey);
      }
    });
    FacebookService.pendingConnections.set(instanceKey, task);
    return task;
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
    // Make sure listener_active + fb_accounts.status always stay in sync,
    // avoids the UI showing the wrong state or auto-reconnect skipping the account
    // because of old DB marking from the earlier overflow loop.
    try {
      const db = DatabaseService.getInstance();
      const fbId = this.getFacebookId();

      if (status === 'connected') {
        // MQTT connected → mark the listener active + fb_accounts connected
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
   * Connect: init the session + start the MQTT listener
   */
  public async connect(): Promise<void> {
    // If already connecting, return the running promise
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

    // Clean up the old listener before creating a new one - avoids a memory leak + overlapping timers
    if (this.listener) {
      try {
        this.listener.disconnect();
      } catch {}
      this.listener = null;
    }

    try {
      // 1. Init session (with proxy support)
      // initSession() now validates REQUIRED_SESSION_FIELDS + that FacebookID is a number
      // and throws an error if one is missing - no need to check by hand
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

      this.listener.on('readReceipt', (data: any) => {
        // The other person has read up to the mark → ✓✓ (seen) mark next to the time of the message I sent
        if (!data?.threadId || !data?.actorFbId || String(data.actorFbId) === this.getFacebookId()) return;
        recordPeerReceipt(this.getFacebookId(), String(data.threadId), { readTs: Number(data.watermarkTimestampMs) || 0 });
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
        if (data?.messageId && this.acceptRepeatable(unsendRepeat(data.messageId))) {
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
        if (data?.messageId && data?.reaction && this.acceptReactionEvent(data.messageId, data.actorFbId || '', data.reaction)) {
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
            // When MQTT closes → switch to disconnected so the UI does not show "đã kết nối" (connected)
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

      // Cache the seqId to use as the fallback for the next connect (avoids an overflow cycle)
      this.listener.on('seqId', (newSeqId: string) => {
        if (newSeqId && newSeqId !== '0') {
          this._lastGoodSeqId = newSeqId;
        }
      });

      // Track ERROR_QUEUE_OVERFLOW - if the overflow persists and the bridge is alive,
      // stop the MQTT listener completely, since the bridge has its own MQTT that handles all traffic
      this.listener.on('overflow', (_seqId: string) => {
        this._mqttOverflowCount++;
        Logger.warn(`[FacebookService:${this.accountId}] MQTT overflow #${this._mqttOverflowCount} - will skip MQTT reconnect if persistent`);
        // When overflow > 2 times and the bridge is already connected → stop the MQTT listener completely
        // The bridge has its own internal MQTT, so the TypeScript MQTT listener is no longer needed
        if (this._mqttOverflowCount > 2 && this.e2eeBridge?.isAlive()) {
          Logger.warn(`[FacebookService:${this.accountId}] Persistent MQTT overflow + bridge alive → disabling MQTT listener, relying on bridge`);
          if (this.listener) {
            this.listener.disconnect();
            // Keep listener = null so ensureConnected does not try to create it again
          }
        }
      });

      // Attach the health check callback - the listener will call it periodically while in Phase 2 retry
      // to detect an expired cookie and stop retrying at the right time
      const fbService = this;
      this.listener.setHealthCheckFn(async () => {
        try {
          return await fbService.checkCookieHealth();
        } catch {
          return true; // Not sure → keep retrying
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
   * Disconnects
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
   * Health check: checks the cookie + the listener
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
   * Checks the cookie health on its own (does not check the listener).
   * Used by the health check callback in FacebookMQTTListener. A network failure
   * is deliberately *not* treated as an expired cookie: during an offline
   * period that would permanently stop the listener's own reconnect loop.
   */
  public async checkCookieHealth(): Promise<boolean> {
    try {
      await initSession(this.cookie, this.httpsAgent);
      return true;
    } catch (err: any) {
      const message = String(err?.message || err || '');
      // FB-04: only an authentication rejection may be read as "cookie
      // expired". DNS/socket/timeout and server-side 429/5xx (including a
      // captive portal or a proxy error page) are transient — reporting them
      // as expired permanently stops the listener as if the user had logged out.
      const transientNetworkError =
        /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|\b(?:network|socket|fetch failed|timeout)\b/i.test(message)
        || /\b(?:status code\s*429|status code\s*5\d\d|too many requests|service unavailable|bad gateway|gateway timeout)\b/i.test(message)
        || /\b(?:429|500|502|503|504)\b/.test(message) && /\b(?:status|http|code)\b/i.test(message);
      if (transientNetworkError) {
        Logger.warn(`[FacebookService:${this.accountId}] Cookie health check deferred because network is unavailable: ${message}`);
        return true;
      }
      Logger.warn(`[FacebookService:${this.accountId}] Cookie health check rejected session: ${message}`);
      return false;
    }
  }

  /**
   * Updates the cookie (after the user logs in again)
   */
  public async updateCookie(newCookie: string): Promise<void> {
    this.cookie = newCookie;
    await this.disconnect();
    await this.connect();
  }

  private async handleIncomingMessage(msg: FBMQTTMessage): Promise<void> {
    const threadId = msg.replyToID && msg.replyToID !== '0' ? msg.replyToID : null;
    const ts = parseInt(msg.timestamp) || Date.now();
    // The MQTT actor is the source of truth for the sender.  Do not use the
    // active account as a fallback here: doing so turns an incoming message
    // into a self-sent message when Messenger returns identity variants.
    const normalizeFacebookId = (value: unknown): string => String(value ?? '').trim().replace(/@.*$/, '');
    const senderId = normalizeFacebookId(msg.userID);
    const persistedAccountId = normalizeFacebookId(this.getFacebookId());
    const sessionAccountId = normalizeFacebookId(this.dataFB?.FacebookID);
    // getFacebookId() is the persisted account identity.  Only use the
    // session identity while the persisted value has not been initialized.
    const ownId = /^\d+$/.test(persistedAccountId) ? persistedAccountId : sessionAccountId;
    const isSelf = senderId !== '' && ownId !== '' && senderId === ownId ? 1 : 0;

    if (senderId) {
      msg.userID = senderId;
    }

    // ── Self-echo dedup: skip messages we already saved+broadcast locally ──
    // When a message is sent through the bridge (E2EE or MQTT), the bridge echoes the message back
    // through the event stream. The send path has already saved to the DB + emitted fb:onMessage, so
    // there is no need to redo it. The recently-sent set is used to tell an echo apart from
    // a message from another device (the phone sent it → not in the set → process it).
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
    // When the bridge sends a link message (especially in a group), data.text can be empty
    // and the URL is only in the attachment. Make sure the body always has content for the UI to show.
    if (!msg.body && msg.attachments?.attachmentType === 'link' && msg.attachments?.url) {
      msg.body = msg.attachments.url;
      Logger.log(`[FacebookService:${this.accountId}] [LINK] body was empty, using attachment URL: ${msg.body.slice(0, 100)}`);
    }
    // ── Page sample message (card + buttons): content = the card's text ──────────────────
    // The conversation list, search, notifications and workflows read `body`; the full card is in attachments.
    const primaryTemplate = msg.attachments?.attachmentType === 'template' ? msg.attachments.template : undefined;
    if (!msg.body && primaryTemplate) {
      msg.body = fbTemplateText(primaryTemplate) || null;
    }
    // The bridge cannot show the content (E2EE view-once, payment…) → replacement text, do not save an empty bubble
    if (!msg.body && !msg.attachments?.attachmentType && msg.unsupported) {
      msg.body = fbUnsupportedText(msg.unsupported);
    }
    // ──────────────────────────────────────────────────────────────────────────

    // ── Pre-fetch contact info for unknown users ──────────────────────────────
    // Before saving the message, make sure the sender already has a display_name in the DB.
    // Avoids showing a UID instead of the user's name on the client.
    if (msg.userID && /^\d+$/.test(String(msg.userID)) && !isSelf) {
      try {
        const db = DatabaseService.getInstance();
        const existingSender = db.queryOne?.(
          `SELECT display_name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook' AND display_name != '' LIMIT 1`,
          [this.getFacebookId(), String(msg.userID)]
        ) as { display_name?: string } | undefined;
        if (!existingSender?.display_name) {
          // No name yet → fetch first, so the broadcast has complete info
          await this.checkAndFetchUserInfo(String(msg.userID));
        }
      } catch {}
    }
    // ────────────────────────────────────────────────────────────────────────────

    // Persist to DB
    // MQTT and the bridge (LightSpeed) both receive each ordinary message, a few tens of ms apart. The later copy changes nothing in the DB → dropped
    // without being replayed (before, each message was added to unread / reports / workflow runs / API events twice); an empty row can be fixed
    // or the "File đính kèm không hiển thị" (Attachment not shown) card → replayed with `repeat` (the renderer only patches the message, it does not report it again).
    let saveOutcome: FbSaveOutcome = 'new';
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
        // Page sample message → `fb.template` (the renderer draws the card + buttons from the attachments)
        const msgType = rawType === 'template' ? FB_TEMPLATE_MSG_TYPE : rawType;

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
            ...(a.template ? { ...a.template, type: 'template' } : {}),
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
            ...(msg.attachments.template ? { ...msg.attachments.template, type: 'template' } : {}),
          }]);
        }

        if (msgType === 'sticker') {
          Logger.log(`[FacebookService:${this.accountId}] [STICKER] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} rawType=${rawType} msgType=${msgType} hasAttachment=${hasAttachment} url=${(msg.attachments?.url || '').slice(0,100)}`);
        }
        if (msgType === 'gif') {
          Logger.log(`[FacebookService:${this.accountId}] [GIF] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} hasAttachment=${hasAttachment} directPath=${!!msg.attachments?.directPath} url=${(msg.attachments?.url || '').slice(0,100)}`);
        }
        Logger.log(`[FacebookService:${this.accountId}] Calling saveFBMessage: account_id=${this.accountId} thread_id=${threadId} type=${msgType} hasAttachment=${hasAttachment} reply_to_id=${msg.replyToMessageId || '(none)'}`);
        // @ts-ignore
        saveOutcome = db.saveFBMessage({
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
        }) || 'new';

        // Note: fb_threads preview is updated inside saveFBMessage

        // saveFBMessage owns the unified contact update. Keeping a second
        // update here caused every received realtime message to increment the
        // unread counter twice.
      } catch (err: any) {
        Logger.warn(`[FacebookService:${this.accountId}] DB persist error: ${err.message}`);
      }

      if (saveOutcome === 'duplicate') {
        Logger.log(`[FacebookService:${this.accountId}] Duplicate delivery skipped: msgId=${msg.messageID} (already received from the other source)`);
        return;
      }

      // For a direct Page/person thread, resolve the conversation identity,
      // not the message actor. A Page can send as the logged-in account, so
      // using msg.userID here would copy that account's avatar to the thread.
      try {
        const knownThread = DatabaseService.getInstance().queryOne?.(
          `SELECT type FROM fb_threads WHERE id = ? AND account_id = ?`,
          [threadId, this.accountId],
        ) as { type?: string } | undefined;
        if (knownThread?.type !== 'group' && /^\d+$/.test(threadId)) {
          this.checkAndFetchUserInfo(threadId);
        }
      } catch {}

      // Keep sender data for group participant lookup only. It is never used
      // as the avatar source for the conversation row above.
      if (msg.userID && /^\d+$/.test(msg.userID) && msg.userID !== threadId) {
        this.checkAndFetchUserInfo(msg.userID);
      }

      // Fire-and-forget download non-E2EE attachments to local storage (like Zalo pattern)
      // Check primary AND allAttachments - batch sends may have URL only in allAttachments
      // Skip link type attachments - URL links don't need local download
      const isLinkType = (a: any) => a?.attachmentType === 'link' || a?.attachmentType === 'template';
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
    // Make sure the FE has display_name + avatar_url as soon as fb:onMessage arrives,
    // to avoid showing a UID and an empty avatar for a new contact.
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
        // Get the avatar from fb_threads.metadata (JSON: { avatar_url: "..." })
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
        ...(saveOutcome === 'repaired' ? { repeat: true } : {}),
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

    // The other person has received up to the mark → ✓✓ (received) mark next to the time of the message I sent
    recordPeerReceipt(this.getFacebookId(), String(data.threadId), { deliveredTs: Number(data.timestampMs) || 0 });

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
   * Marks a message ID as sent locally (already saved to the DB + broadcast).
   * Used to stop a self-echo from the bridge / MQTT creating a duplicate in handleIncomingMessage.
   * Expires automatically after 60 s.
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
   * Starts the E2EE bridge for 1:1 encrypted messages.
   * NON-FATAL: if the binary does not exist → groups still work normally.
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
        const eventId = bridgeEventKey(evt);
        const priority = this.getEventPriority(evt?.type || '');
        // A duplicate (already / being handled) being dropped is normal: restart the bridge only when an important event is dropped because the queue is
        // full
        const duplicate = this.eventPipeline.isDuplicate(eventId);
        const accepted = this.eventPipeline.enqueue(eventId, priority, bridgeGen, () => this.handleBridgeEvent(evt));
        if (!accepted && !duplicate && priority === EventPriority.HIGH) {
          Logger.error(`[FacebookService:${this.accountId}] Critical bridge event was rejected; restarting bridge for recovery`);
          void bridgeInstance.close();
        }
      });

      // Short timeout so group messaging is not blocked if the bridge does not respond
      Logger.log(`[FacebookService:${this.accountId}] E2EE startup: connect`);
      const info = await this.e2eeBridge.connect(30000);
      Logger.log(`[FacebookService:${this.accountId}] E2EE bridge connected: user=${JSON.stringify((info as any)?.user?.id ?? '?')}`);

      Logger.log(`[FacebookService:${this.accountId}] E2EE startup: connectE2EE`);
      // Pairing may need to restore encrypted session state after a desktop
      // restart. The bridge's supported timeout is 60s; the old 20s deadline
      // killed a healthy in-progress connection and forced a manual toggle.
      await this.e2eeBridge.connectE2EE(60_000);
      const readiness = await bridgeInstance.call('isConnected', {}, 5_000) as {
        connected?: boolean;
        e2eeConnected?: boolean;
      };
      // The normal Messenger transport is handled by FacebookMQTTListener. The
      // bridge's LightSpeed connection can remain false on valid cookie sessions
      // while its independent encrypted socket is healthy, so it must not gate
      // encrypted message reception.
      if (readiness.e2eeConnected !== true) {
        throw new Error(`E2EE handshake incomplete (e2eeConnected=${readiness.e2eeConnected})`);
      }
      Logger.log(`[FacebookService:${this.accountId}] E2EE pairing complete`);

      // A failed handshake retries automatically. Do not re-persist the same
      // bridge inbox on every failed attempt; on large databases that creates
      // constant writes and log traffic while no encrypted socket is usable.
      this.persistBridgeHistory(info.initialData);
      this.setE2EEStatus('connected');
      this._e2eeReconnectAttempts = 0;
      this._clearE2EEReconnect();

      // 5. Create sender (reuses bridge)
      this.e2eeSender = new FacebookE2EESender({ mode: 'reuse', bridge: this.e2eeBridge });

      // BUG #6 fix: use bridgeGen to detect a stale timer
      this.e2eeBridge.on('closed', (code: number | null) => {
        if (this.e2eeBridge !== bridgeInstance || this.e2eeBridgeGen !== bridgeGen) return;
        Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge closed (code=${code}, gen=${bridgeGen})`);
        this._clearE2EEHeartbeat();
        // Only clear if the current bridge is still this instance
        if (this.e2eeBridge === bridgeInstance) {
          this.e2eeBridge = null;
        }
        this.setE2EEStatus('disconnected');
        this._scheduleE2EEReconnect('bridge process closed', 3_000);
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
      this._scheduleE2EEReconnect('startup failed', 5_000);
    }
  }

  private async stopE2EEBridge(): Promise<void> {
    this._clearE2EEReconnect();
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
    // close() emits the normal "closed" listener too. A deliberate stop
    // (toggle, retry, shutdown) must not leave its reconnect timer behind.
    this._clearE2EEReconnect();
    this.e2eeSender = null;
    this.setE2EEStatus('disconnected');
  }

  /** Heartbeat: periodically checks whether the bridge is still responsive (BUG #8 fix) */
  private _startE2EEHeartbeat(bridgeInstance: FacebookE2EEBridge, bridgeGen: number, fbId: string): void {
    this._clearE2EEHeartbeat();
    this._e2eeHeartbeatFailCount = 0;
    this._e2eeHeartbeatTimer = setInterval(async () => {
      // Only check if the bridge instance has not changed (avoids a stale timer)
      if (this.e2eeBridge !== bridgeInstance || this.e2eeBridgeGen !== bridgeGen) {
        this._clearE2EEHeartbeat();
        return;
      }
      try {
        // Call isConnected with a 5 s timeout - if the bridge hangs, call() will time out
        const probe = await Promise.race([
          bridgeInstance.call('isConnected', {}, 5000),
          new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat_timeout')), 6000)),
        ]);
        // A well-formed RPC response alone is not proof that the encrypted
        // transport is healthy. Do not use the bridge's normal LightSpeed
        // state here: regular Facebook messages use FacebookMQTTListener and
        // this bridge can receive E2EE while LightSpeed remains disconnected.
        const e2eeConnected = (probe as any)?.e2eeConnected;
        if (e2eeConnected !== true) {
          throw new Error(`bridge reports encrypted socket disconnected (e2ee=${e2eeConnected})`);
        }
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
          this._scheduleE2EEReconnect('heartbeat failed', 1_000);
        }
      }
    }, 30000); // Check every 30 s
  }

  private _clearE2EEHeartbeat(): void {
    if (this._e2eeHeartbeatTimer) {
      clearInterval(this._e2eeHeartbeatTimer);
      this._e2eeHeartbeatTimer = null;
    }
    this._e2eeHeartbeatFailCount = 0;
  }

  /** Restart a stale E2EE transport once; all paths share retryE2EE serialization. */
  private _scheduleE2EEReconnect(reason: string, delayMs: number): void {
    if (!this.e2eeEnabled || (!this.isConnected() && this.status !== 'connecting')) return;
    if (this._e2eeReconnectTimer) return;

    const scheduledGeneration = this.e2eeBridgeGen;
    const attempt = this._e2eeReconnectAttempts++;
    const retryDelayMs = Math.min(Math.max(delayMs, 5_000) * (2 ** attempt), 5 * 60_000);
    Logger.warn(`[FacebookService:${this.accountId}] E2EE ${reason}; reconnecting in ${Math.round(retryDelayMs / 1000)}s (attempt ${attempt + 1})`);
    metricInc('fb_bridge_restart', this.accountId);
    this._e2eeReconnectTimer = setTimeout(() => {
      this._e2eeReconnectTimer = null;
      if (!this.e2eeEnabled || this.isE2EEConnected() || this.e2eeBridgeGen !== scheduledGeneration) return;
      this.retryE2EE().catch((err: any) => {
        Logger.warn(`[FacebookService:${this.accountId}] Scheduled E2EE reconnect failed: ${err.message}`);
      });
    }, retryDelayMs);
  }

  private _clearE2EEReconnect(): void {
    if (this._e2eeReconnectTimer) {
      clearTimeout(this._e2eeReconnectTimer);
      this._e2eeReconnectTimer = null;
    }
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
   * Saves history messages from the bridge (the inbox pages / a conversation's history pages) as history: does not emit fb:onMessage, does not
   * increase unread. `range` (if given) drops messages outside the time range. Returns: stored = number of messages written, fresh = new messages (not yet
   * on the machine), received = messages in the range.
   */
  private persistBridgeMessages(
    messages: NonNullable<BridgeInitialData['messages']>,
    range?: FbHistorySyncRange,
  ): { stored: number; fresh: number; received: number } {
    const db = DatabaseService.getInstance();
    const ownFacebookId = String(this.getFacebookId());
    let stored = 0;
    let fresh = 0;
    let received = 0;
    for (const message of messages) {
      const id = String(message?.id || '');
      const threadId = String(message?.threadId ?? '').replace(/@.*$/, '');
      if (!id || !threadId) continue;
      const timestamp = Number(message.timestampMs || Date.now());
      if (range && !messageInRange(timestamp, range)) continue;
      received += 1;
      let exists = false;
      try {
        exists = !!db.queryOne?.(
          `SELECT 1 AS found FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND channel = 'facebook' LIMIT 1`,
          [id, ownFacebookId],
        );
      } catch { /* only to count new messages */ }
      const senderId = String(message.senderId ?? '');
      const { attachments, type, body } = this.bridgeHistoryContent(message);
      db.saveFBMessage({
        id,
        account_id: this.accountId,
        thread_id: threadId,
        sender_id: senderId,
        body,
        timestamp,
        type,
        attachments: JSON.stringify(attachments),
        reply_to_id: message.replyTo?.messageId || '',
        is_self: senderId !== '' && senderId === ownFacebookId ? 1 : 0,
        is_unsent: message.isUnsent ? 1 : 0,
        is_history: true,
      });
      stored += 1;
      if (!exists) fresh += 1;
    }
    return { stored, fresh, received };
  }

  /**
   * The content of one history message from the bridge, with the same rules as a realtime message (handleIncomingMessage): template cards are stored
   * in the standard form (buttons classified), body = the card's text / the link's URL / the replacement text; system messages → `system`.
   */
  private bridgeHistoryContent(message: NonNullable<BridgeInitialData['messages']>[number]): {
    attachments: any[]; type: string; body: string | null;
  } {
    const attachments = (Array.isArray(message.attachments) ? message.attachments : []).flatMap((a: any) => {
      if (a?.type !== 'template') return a ? [a] : [];
      // A "chữ + nút" (text + buttons) message: the text is the message content, the card only has buttons → merge the text into the card
      const template = withTemplateText(templateFromBridgeAttachment(a), message.text);
      return template ? [template] : [];
    });
    const primary = attachments[0];
    const primaryType = String(primary?.type || 'text');
    const template: FbTemplate | null = primaryType === 'template' ? primary : null;
    const type = message.isAdminMsg ? 'system' : template ? FB_TEMPLATE_MSG_TYPE : primaryType;
    const body = message.text
      || (template ? fbTemplateText(template) : '')
      || (primaryType === 'link' && primary?.url ? String(primary.url) : '')
      || (message.unsupported && !primary ? fbUnsupportedText(message.unsupported) : '')
      || null;
    return { attachments, type, body };
  }

  /**
   * Saves a page of GraphQL messages (fetchThreadMessages) as history: shared by fb:fetchThreadMessages and the first page of the history
   * load when the conversation has no message to use as the mark yet: the message type is taken from the first attachment, template messages → fb.template;
   * a row that already exists gets its sender / direction fixed (an old copy may have been saved wrongly). `range` (if given) drops messages outside it. Returns like persistBridgeMessages.
   */
  public persistGraphQLHistory(threadId: string, messages: any[], range?: FbHistorySyncRange): { stored: number; fresh: number; received: number } {
    const db = DatabaseService.getInstance();
    const ownFacebookId = String(this.getRealFacebookId() || this.getFacebookId()).replace(/@.*$/, '');
    let stored = 0;
    let fresh = 0;
    let received = 0;
    for (const msg of Array.isArray(messages) ? messages : []) {
      if (!msg?.id) continue;
      if (range && !messageInRange(msg.timestampMs, range)) continue;
      received += 1;
      let exists = false;
      try {
        exists = !!db.queryOne?.(
          `SELECT 1 AS found FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND channel = 'facebook' LIMIT 1`,
          [String(msg.id), ownFacebookId],
        );
      } catch { /* only to count new messages */ }
      const senderId = String(msg.senderId || '').replace(/@.*$/, '');
      const isSelf = senderId !== '' && senderId === ownFacebookId ? 1 : 0;
      // Type taken from the first attachment (before, every attachment became `file`); template messages → fb.template
      const primary = msg.attachments?.[0];
      const msgType = msg.isAdmin ? 'system'
        : primary?.type === 'template' ? FB_TEMPLATE_MSG_TYPE
        : primary?.type || 'text';
      db.saveFBMessage({
        id: msg.id,
        account_id: this.accountId,
        thread_id: threadId,
        sender_id: senderId,
        sender_name: msg.senderName || '',
        body: msg.body || (primary?.type === 'template' ? fbTemplateText(primary) : null) || null,
        timestamp: msg.timestampMs,
        type: msgType,
        attachments: msg.attachments?.length ? JSON.stringify(msg.attachments) : '[]',
        reply_to_id: msg.replyToMessageId || '',
        is_self: isSelf,
        is_unsent: msg.isUnsent ? 1 : 0,
        reactions: msg.reactions?.length ? JSON.stringify(msg.reactions) : '{}',
        is_history: true,
      });

      if (senderId) {
        // saveFBMessage is intentionally insert-only for duplicate events.
        // Reconcile existing rows while the history API still has the
        // canonical participant id, so messages stored by an older client
        // immediately regain the correct sender and direction on refresh.
        db.run(
          `UPDATE fb_messages
           SET sender_id = ?, sender_name = CASE WHEN ? != '' THEN ? ELSE sender_name END, is_self = ?
           WHERE id = ? AND account_id = ?`,
          [senderId, msg.senderName || '', msg.senderName || '', isSelf, msg.id, this.accountId],
        );
        db.run(
          `UPDATE messages SET sender_id = ?, is_sent = ?, status = ?
           WHERE msg_id = ? AND owner_zalo_id = ? AND channel = 'facebook'`,
          [senderId, isSelf, isSelf ? 'sent' : 'received', msg.id, ownFacebookId],
        );
      }
      stored += 1;
      if (!exists) fresh += 1;
    }
    return { stored, fresh, received };
  }

  /**
   * Persist data from the bridge inbox page without emitting fb:onMessage.
   * These rows are history, so they must not replay automations after a restart
   * or when the user explicitly reloads Facebook.
   */
  private persistBridgeHistory(data?: BridgeInitialData): { threads: number; messages: number } {
    if (!data) return { threads: 0, messages: 0 };
    const db = DatabaseService.getInstance();
    const threads = Array.isArray(data.threads) ? data.threads : [];
    const messages = Array.isArray(data.messages) ? data.messages : [];

    if (threads.length > 0) {
      for (const thread of threads) {
        const rawType = Number(thread?.type);
        if ((rawType === 15 || rawType === 16) && thread?.id !== undefined && thread?.id !== null) {
          this.e2eeThreads.add(String(thread.id));
        }
      }
      db.saveFBThreads(this.accountId, threads
        .filter(thread => thread?.id !== undefined && thread?.id !== null)
        .map(thread => {
          const rawType = Number(thread.type);
          return {
            id: String(thread.id),
            account_id: this.accountId,
            name: String(thread.name || ''),
            type: rawType === 2 || rawType === 16 ? 'group' : 'user',
            participant_count: 0,
            last_message_preview: thread.snippet || '',
            last_message_at: Number(thread.lastActivityTimestampMs || 0),
            unread_count: 0,
            is_muted: false,
            is_e2ee: rawType === 15 || rawType === 16 ? 1 : 0,
          };
        }), { preserveUnread: true });
    }

    const savedMessages = this.persistBridgeMessages(messages).stored;

    if (threads.length || savedMessages) {
      Logger.log(`[FacebookService:${this.accountId}] Persisted bridge history: ${threads.length} threads, ${savedMessages} messages`);
    }
    return { threads: threads.length, messages: savedMessages };
  }

  /**
   * Handles all events from the Go bridge.
   * e2eeMessage → normalise → the same handleIncomingMessage() as MQTT
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
        this._e2eeReconnectAttempts = 0;
        this._clearE2EEReconnect();
        break;

      case 'disconnected':
        Logger.warn(`[FacebookService:${this.accountId}] E2EE bridge: disconnected ${JSON.stringify(data)}`);
        // The process can stay alive while its internal LightSpeed socket is
        // offline. Do not report that stale bridge as ready for a new send.
        this.setE2EEStatus('disconnected');
        if (data?.isE2EE === true) {
          // whatsmeow has dropped specifically. Waiting for the 30-second
          // heartbeat left encrypted inbound messages unavailable until the
          // user manually toggled the dashboard control.
          this._scheduleE2EEReconnect('encrypted socket disconnected', 1_000);
        }
        break;

      case 'reconnected':
        // Meta's LightSpeed socket owns its own reconnect loop. Do not spawn a
        // second bridge here: that would create two device/socket lifecycles.
        // LightSpeed (messagix) is the NON-E2EE transport — see
        // bridge/events.go RawEventSourceLightSpeed. Its reconnect must not be
        // reported as E2EE ready; only the whatsmeow `e2eeConnected` event (or
        // a healthy isConnected probe) may do that. Otherwise sends queue on a
        // bridge that cannot yet encrypt (FB-01).
        Logger.log(`[FacebookService:${this.accountId}] E2EE bridge LightSpeed socket reconnected`);
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
          if (!this.acceptReactionEvent(data.messageId, String(userId), data.emoji || '')) break;
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
        if (data?.messageId && this.acceptRepeatable(unsendRepeat(data.messageId))) {
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

      case 'e2eeReceipt': {
        // End-to-end encrypted message (whatsmeow Receipt): type '' = received, 'read' / 'played' = seen, by message id.
        // 'read-self' / 'sender' (another device of my own) are skipped.
        const userOf = (jid: unknown) => String(jid || '').replace(/@.*$/, '').replace(/[.:].*$/, '');
        const threadId = String(data?.chat || '').replace(/@.*$/, '');
        const receiptType = String(data?.type ?? '');
        const owner = this.getFacebookId();
        if (!threadId || userOf(data?.sender) === owner) break;
        const isDelivered = receiptType === '' || receiptType === 'delivered';
        const isRead = receiptType === 'read' || receiptType === 'played';
        if (!isDelivered && !isRead) break;
        const ts = messageTimestampById(owner, threadId, Array.isArray(data?.messageIds) ? data.messageIds : [], 'facebook');
        if (ts) recordPeerReceipt(owner, threadId, isRead ? { readTs: ts } : { deliveredTs: ts });
        break;
      }

      case 'readReceipt': {
        // Bridge (LightSpeed, ordinary messages): the reader + the time they read up to. Reads by myself (another device) are skipped.
        const readerId = String(data?.readerId ?? '');
        const threadId = String(data?.threadId ?? '');
        const watermark = Number(data?.readWatermarkTimestampMs) || 0;
        if (threadId && watermark && readerId && readerId !== this.getFacebookId()) {
          recordPeerReceipt(this.getFacebookId(), threadId, { readTs: watermark });
        }
        break;
      }

      case 'messageUnsend': {
        // E2EE 1:1 message unsend from bridge
        // data: { isE2EE, messageId, threadId }
        if (data?.messageId && this.acceptRepeatable(unsendRepeat(data.messageId))) {
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
          if (!this.acceptReactionEvent(data.messageId, userId, data.reaction)) break;
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
   * Normalises an E2EE message from the bridge → FBMQTTMessage → handleIncomingMessage()
   * The shape is compatible with an MQTT message so the UI handles both the same way.
   */
  // @ts-ignore - called from handleBridgeEvent
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
      type: 'user', // E2EE is always 1:1
      mentions: data.mentions || [],
      attachments: {
        id: 0,
        url: null,
      },
      isE2EE: true,
      chatJid: data.chatJid,
      senderJid: data.senderJid,
      // Extract replyTo info from the bridge data - a message replying to another message
      replyToMessageId: data.replyTo?.messageId,
      replyToSenderId: data.replyTo?.senderId != null ? String(data.replyTo.senderId) : undefined,
      ...(data.unsupported ? { unsupported: String(data.unsupported) } : {}),
    };

    // Parse attachments if there are any
    // Go bridge Attachment struct sends: type (lowercase), url, fileName, mimeType,
    // fileSize, width, height, stickerId, mediaKey, mediaSha256, directPath, ...
    // There is NO "id" or "attachmentType" field - the names need mapping correctly
    // E2EE media (image/video/audio/file) has no URL, but has directPath + mediaKey
    // to download through the bridge - keep them to store in the DB and download later
    if (data.attachments?.length) {
      const raw = data.attachments as any[];
      const mapped = raw.map((a: any, idx: number) => ({
        id: a.stickerId || idx + 1,                    // Go: no id, use the index
        url: a.url || null,                             // Go: url (null for an E2EE image)
        attachmentType: a.type || a.attachmentType,     // Go: "type" (lowercase) - image/video/file/audio
        name: a.fileName || a.name,                     // Go: "fileName" (not "name")
        fileSize: a.fileSize,
        mimeType: a.mimeType,
        // Preserve E2EE media download fields (needed for downloadE2EEAttachments and DB persistence)
        directPath: a.directPath,
        mediaKey: a.mediaKey,
        mediaSha256: a.mediaSha256,
        mediaEncSha256: a.mediaEncSha256,
        ...(a?.type === 'template' && templateFromBridgeAttachment(a) ? { template: templateFromBridgeAttachment(a)! } : {}),
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
    // ⚠️ MUST await handleIncomingMessage before downloading E2EE media,
    // so fb:onMessage is broadcast to the UI before event:localPath.
    // Otherwise there is a race: event:localPath fires before the message is in the store
    // → local_paths gets lost → the video can never play.
    await this.handleIncomingMessage(msg);

    // Auto-download E2EE media (image/video/audio/file) sau khi save message
    const e2eeAttachments = data.attachments as any[] | undefined;
    if (e2eeAttachments?.length && msg.messageID) {
      // ⚠️ MUST await to catch download errors, especially for video.
      // Not fire-and-forget - if the bridge does not support video download,
      // it has to be logged to debug.
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
      ...(data.unsupported ? { unsupported: String(data.unsupported) } : {}),
    };

    // Parse attachments tu bridge data (non-E2EE group messages)
    // Bridge gui attachments array: [{ type, url, fileName, mimeType, fileSize, ... }]
    // Template card ("template": title, description, image, buttons, carousel) is kept in `template`.
    if (data.attachments?.length) {
      const raw = data.attachments as any[];
      const mapped = raw.flatMap((a: any, idx: number) => {
        // "chữ + nút" (text + buttons) message of the Page: the text is the message content, the card only has buttons → merge the text into the card (draw the text + the buttons)
        const template = a?.type === 'template' ? withTemplateText(templateFromBridgeAttachment(a), data.text) : null;
        if (isFbUnavailableTemplate(template)) {
          // LightSpeed also only has the replacement card "File đính kèm không hiển thị" (Attachment not shown) → diagnosis (XMA type, no content written)
          Logger.log(`[FacebookService:${this.accountId}] bridge template placeholder: msgId=${data.id} xmaType=${a?.xmaType || '-'}`);
        }
        if (a?.type === 'template' && !template) return [];
        return [{
          id: idx + 1,
          url: (template ? template.url : a.url) || null,
          attachmentType: a.type || a.attachmentType || 'file',
          name: a.fileName || a.name || '',
          fileSize: a.fileSize,
          mimeType: a.mimeType,
          ...(template ? { template } : {}),
        }];
      });
      if (mapped.length) {
        msg.attachments = mapped[0];
        if (mapped.length > 1) {
          msg.allAttachments = mapped;
        }
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
   * Downloads and decrypts E2EE media attachments (image/video/audio/file) from the Go bridge.
   * Saves the decrypted file to local storage and updates the DB.
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
   * Checks whether the contact already has a name; if not, fetches it through the UID-keyed endpoint.
   * Fire-and-forget - called when the first message arrives, the DB is updated afterwards.
   * Only applies to 1-1 users (groups are not supported).
   */
  private async checkAndFetchUserInfo(fbUserId: string): Promise<void> {
    try {
      // Check the DB first: if there is already a name and an avatar, skip
      const db = DatabaseService.getInstance();
      const fbId = this.getFacebookId();
      const existing = db.queryOne?.(
        `SELECT display_name, avatar_url FROM contacts
         WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook' LIMIT 1`,
        [fbId, fbUserId]
      ) as { display_name?: string; avatar_url?: string } | undefined;
      const accountAvatar = db.queryOne?.(
        `SELECT avatar_url FROM fb_accounts WHERE id = ?`,
        [this.accountId],
      ) as { avatar_url?: string } | undefined;
      if (existing?.display_name && existing?.avatar_url
        && !isSameFacebookAvatar(existing.avatar_url, accountAvatar?.avatar_url)) return;

      const info = await this.resolveFacebookUserInfo(fbUserId);
      if (!info || (!info.name && !info.avatarUrl)) return;
      Logger.log(`[FacebookService:${this.accountId}] checkAndFetchUserInfo: ${fbUserId} → name="${info.name}"`);
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
      // Broadcast so the UI updates at once
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
    // Video downloading: the bubble shows a progress ring + "x / y MB", report done AFTER the event:localPath has been sent
    const videoProgress = mediaProgressReporter(fbId, threadId, msg.messageID);
    let videoDownloading = false;

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

        // Use the right method for the file type - audio / file cannot use downloadImage
        const attType = att.attachmentType || '';
        let localPath: string;
        if (attType === 'image' || attType === 'sticker') {
          Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: calling downloadImage`);
          localPath = await FileStorageService.downloadImage(fbId, url, filename, cookies, undefined, 'https://www.facebook.com/');
        } else if (attType === 'video') {
          // The MQTT video URL is usually a thumbnail (.jpg), not the real video
          // If the URL ends with an image extension → skip the download (there is no video to download)
          const videoExt = ext.toLowerCase();
          if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(videoExt)) {
            Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: SKIP - URL is image thumbnail (${ext}), not actual video`);
            continue;
          }
          Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] att[${i}]: calling downloadVideo`);
          if (!videoDownloading) videoProgress.queued();
          videoDownloading = true;
          localPath = await FileStorageService.downloadVideo(fbId, url, filename, cookies, undefined, videoProgress.progress);
        } else {
          // audio, file, unknown → use downloadFile
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
      if (videoDownloading) videoProgress.done();
    } else {
      Logger.log(`[FacebookService:${this.accountId}] [DEBUG_DOWNLOAD] No local paths to broadcast`);
      if (videoDownloading) videoProgress.failed();
    }
  }

  /** Gets the file extension from the MIME type */
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
   * Retries the E2EE bridge connection on demand (e.g., when the user tries to send a 1:1 message).
   * Resets the state and retries the bridge startup.
   * @throws Error if the bridge cannot start - the caller should check isE2EEConnected()
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

  /** Enable or stop the optional E2EE bridge without reconnecting MQTT. */
  public async setE2EEEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.e2eeEnabled = false;
      await this.stopE2EEBridge();
      this.setE2EEStatus('disconnected');
      return;
    }

    // `retryE2EE` owns the serialized stop/start path and verifies that the
    // bridge has completed its E2EE handshake before reporting success.
    await this.retryE2EE();
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
          // connect (30s), and connectE2EE (60s). The old 20s wrapper fired
          // while a healthy reconnect was still in progress, leaving the
          // shared retry promise wedged after resume from sleep.
          timer = setTimeout(() => reject(new Error('E2EE reconnect timed out after 80s')), 80_000);
        }),
      ]);
      return this.isE2EEConnected() ? null : tr('E2EE bridge chưa sẵn sàng sau khi kết nối lại.');
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
  ): Promise<FBE2EESendResult> {
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

  /** Sends a 1:1 E2EE message */
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
      return e2eeSendOutcome(await sendOnce());
    } catch (err: any) {
      if (!this.isSafeE2EEReconnectError(err)) {
        return { success: false, error: String(err?.message || err || 'Unknown E2EE send error') };
      }

      Logger.warn(`[FacebookService:${this.accountId}] E2EE pre-flight disconnect; reconnecting before one safe resend`);
      const recoveryError = await this.recoverE2EEForSend();
      if (recoveryError) {
        return { success: false, error: tr('E2EE đang kết nối lại: {{recoveryError}}', { recoveryError }) };
      }

      try {
        return e2eeSendOutcome(await sendOnce());
      } catch (retryErr: any) {
        return { success: false, error: `E2EE send failed after reconnect: ${String(retryErr?.message || retryErr || 'unknown error')}` };
      }
    }
  }

  /** Checks whether E2EE is connected */
  public isE2EEConnected(): boolean {
    return this.e2eeStatus === 'connected' && this.e2eeBridge?.isAlive() === true;
  }

  /** A normal 1:1 is only considered known after a REST probe succeeded in
   * this session. Unknown 1:1 conversations must not be downgraded after an
   * ambiguous E2EE attempt. */
  public isKnownNonE2EEThread(threadId: string): boolean {
    return this._nonE2EEThreads.has(threadId);
  }

  /** Gets the current E2EE state */
  public getE2EEStatus(): FBE2EEStatus {
    return this.e2eeStatus;
  }

  /** Gets the sender instance (for external use) */
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
    if (recoveryError) return { success: false, error: tr('E2EE đang kết nối lại: {{recoveryError}}', { recoveryError }) };

    result = await sendOnce();
    if (!result.success && this.isSafeE2EEReconnectError(result.error)) {
      return { ...result, error: `E2EE media send failed after reconnect: ${result.error || 'not connected'}` };
    }
    return result;
  }

  /** Sends an image over 1:1 E2EE */
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

  /** Sends a video over 1:1 E2EE */
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

  /** Sends audio over 1:1 E2EE */
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

  /** Sends a file over 1:1 E2EE */
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

  /** Sends a reaction to a 1:1 E2EE message */
  public async sendE2EEReaction(
    chatJid: string,
    messageId: string,
    senderJid: string,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendReaction(chatJid, messageId, senderJid, emoji);
  }

  /** Sends a sticker over 1:1 E2EE (C4) */
  public async sendE2EESticker(
    chatJid: string,
    stickerId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.e2eeSender) return { success: false, error: 'E2EE not connected' };
    return this.e2eeSender.sendSticker(chatJid, stickerId);
  }

  /** Sends a typing indicator through the bridge */
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

  /** Marks the thread as read on the Facebook server */
  public async markReadOnServer(threadId: string): Promise<{ success: boolean; error?: string }> {
    const route = await resolveThreadKind(threadId, undefined, this.accountId);
    if (route.kind === 'unknown') return { success: false, error: route.error };
    if (!this.e2eeBridge?.isAlive()) return { success: false, error: tr('Facebook bridge chưa sẵn sàng.') };
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

  /**
   * Creates a Messenger group (the quick action "Tạo nhóm" (Create group)) through the bridge. A Messenger group needs at least 2 people
   * besides the account. The conversation is recorded as `group` right away: message routing (resolveThreadKind)
   * reads the conversation type from the DB.
   */
  public async createGroup(
    participants: string[],
    name: string,
  ): Promise<{ success: boolean; threadId?: string; renameError?: string; error?: string }> {
    const ids = Array.from(new Set((participants || []).map(String).filter(id => /^\d+$/.test(id))));
    if (ids.length < 2) return { success: false, error: tr('Chọn ít nhất 2 người — nhóm Messenger cần từ 3 người trở lên') };
    if (!this.e2eeBridge?.isAlive()) {
      return { success: false, error: tr('Bridge Messenger chưa kết nối — kết nối lại tài khoản Facebook rồi thử lại') };
    }
    if (!this.e2eeBridge.supportsCapability('createGroup')) {
      return { success: false, error: tr('Bản bridge Messenger hiện tại chưa hỗ trợ tạo nhóm — hãy cập nhật ứng dụng') };
    }
    try {
      const result = await this.e2eeBridge.createGroup({ participants: ids, name: String(name || '').trim() });
      const threadId = String(result?.threadId || '');
      if (!/^\d+$/.test(threadId) || threadId === '0') {
        return { success: false, error: tr('Facebook không trả về nhóm vừa tạo') };
      }
      const fbId = this.getFacebookId();
      const db = DatabaseService.getInstance();
      if (fbId && db) {
        const title = String(name || '').trim() || tr('Nhóm mới');
        db.run?.(
          `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
           VALUES (?, ?, ?, '', 0, 'group', 0, ?, ?, 'facebook')
           ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
             contact_type = 'group',
             display_name = CASE WHEN COALESCE(contacts.display_name, '') = '' THEN excluded.display_name ELSE contacts.display_name END,
             last_message_time = MAX(COALESCE(contacts.last_message_time, 0), excluded.last_message_time)`,
          [fbId, threadId, title, tr('Bạn đã tạo nhóm'), Date.now()],
        );
        EventBroadcaster.emit('db:unreadChanged', { zaloId: fbId, source: 'facebook_create_group' });
      }
      Logger.log(`[FacebookService:${this.accountId}] Created group ${threadId} with ${ids.length} people`);
      return { success: true, threadId, ...(result?.renameError ? { renameError: result.renameError } : {}) };
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] createGroup failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** Sends a message to a group through the bridge (non-E2EE) */
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

  /** Sends an image to a group through the bridge (non-E2EE) */
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

  /** Sends a file to a group through the bridge (non-E2EE) */
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

  /** Sends a reaction to a group through the bridge (non-E2EE) */
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
   * Sends a message with E2EE auto-detect.
   *
   * Routing strategy:
   *   1. Work out 1:1 vs group: opts.typeChat → if missing, query fb_threads.type
   *   2. 1:1 → E2EE first (bridge sendE2EEMessage). If the E2EE bridge is not connected yet → retry first.
   *   3. 1:1 E2EE success → mark the thread as E2EE. E2EE fails → REST API fallback.
   *   4. GROUP → REST API. If REST fails → bridge sendMessage fallback.
   *
   * EVERY successful path calls markMessageLocallySent() to stop a self-echo duplicate.
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
      return { success: false, error: tr('Mất kết nối Facebook. Vui lòng kết nối lại tài khoản.') };
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
            if (r.uncertain) {
              // The message may have been delivered. It is neither marked as
              // locally sent (a delivered echo must still reach the chat) nor
              // retried through REST.
              Logger.warn(`[FacebookService:${this.accountId}] 1:1 E2EE send unacknowledged: msgId=${r.messageId}`);
              return r;
            }
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
              return { success: false, error: tr('Không thể gửi tin nhắn E2EE: {{message}}', { message: err.message }) };
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
              ? tr('E2EE đang kết nối lại: {{e2eeRecoveryError}}', { e2eeRecoveryError })
              : tr('E2EE đang kết nối lại. Vui lòng thử lại sau vài giây.'),
          };
        }

        // The bridge was available but its encrypted handshake did not finish.
        // A REST probe in this state is invalid for modern 1:1 Messenger chats
        // and merely turns the real connection problem into Facebook's opaque
        // "conversation disabled" error. Preserve the actionable E2EE status.
        if (e2eeRecoveryError) {
          return {
            success: false,
            error: tr('E2EE đang kết nối lại: {{e2eeRecoveryError}}', { e2eeRecoveryError }),
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
   * Checks whether the error message is caused by an E2EE conversation
   */
  private isE2EEDisabledError(error: string): boolean {
    const disabledPatterns = ['disabled', 'vô hiệu hoá', 'encrypted', 'e2ee'];
    const lower = error.toLowerCase();
    return disabledPatterns.some(p => lower.includes(p));
  }

  /**
   * Sends a message through the E2EE bridge, automatically retrying the bridge if needed
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
          error: tr('Hội thoại này đã được mã hoá 1-1 (E2EE) nhưng bridge chưa kết nối. Vui lòng build fbchat-bridge-e2ee.'),
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
      error: tr('Hội thoại này đã được mã hoá 1-1 (E2EE) nhưng bridge chưa kết nối. Vui lòng build fbchat-bridge-e2ee.'),
    };
  }

  private async resolveMessageThreadKind(messageId: string): Promise<{ threadId?: string; senderId?: string; kind: 'user' | 'group' | 'unknown'; error?: string }> {
    const message = DatabaseService.getInstance().queryOne?.(
      'SELECT thread_id, sender_id FROM fb_messages WHERE id = ? AND account_id = ?',
      [messageId, this.accountId],
    ) as { thread_id?: string; sender_id?: string } | undefined;
    if (!message?.thread_id) return { kind: 'unknown', error: tr('Không tìm thấy hội thoại của tin nhắn.') };
    const resolved = await resolveThreadKind(message.thread_id, undefined, this.accountId);
    return { threadId: message.thread_id, senderId: message.sender_id, ...resolved };
  }

  public async unsendMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    const route = await this.resolveMessageThreadKind(messageId);
    if (route.kind === 'unknown' || !route.threadId) return { success: false, error: route.error };
    if (route.kind === 'user') {
      if (!this.isE2EEConnected()) return { success: false, error: tr('E2EE bridge chưa sẵn sàng.') };
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
      if (!this.isE2EEConnected()) return { success: false, error: tr('E2EE bridge chưa sẵn sàng.') };
      // The encrypted message key is tied to the original sender JID. An
      // internal Deplao account UUID is not a valid JID.
      if (!route.senderId) return { success: false, error: tr('Thiếu người gửi của tin nhắn E2EE.') };
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
      if (!this.isE2EEConnected()) return { success: false, error: tr('E2EE bridge chưa sẵn sàng.') };
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
      return { success: false, error: tr('Không thể chuyển tiếp native vào chat 1:1. Hãy gửi lại nội dung qua luồng E2EE.') };
    }
    return forwardMessage(this.requireSession(), messageId, targetThreadId, true, this.httpsAgent);
  }

  private async requireGroupOperation(threadId: string, operation: string): Promise<{ success: true } | { success: false; error: string }> {
    const route = await resolveThreadKind(threadId, undefined, this.accountId);
    if (route.kind === 'unknown') return { success: false, error: route.error || tr('Không xác định được hội thoại.') };
    if (route.kind === 'user') {
      return { success: false, error: tr('{{operation}} chưa hỗ trợ trong chat 1:1 E2EE.', { operation }) };
    }
    return { success: true };
  }

  public async pinMessage(messageId: string, threadId: string): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Ghim tin nhắn'));
    if (!allowed.success) return allowed;
    return pinMessage(this.requireSession(), messageId, threadId, this.httpsAgent);
  }

  public async unpinMessage(messageId: string, threadId: string): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Bỏ ghim tin nhắn'));
    if (!allowed.success) return allowed;
    return unpinMessage(this.requireSession(), messageId, threadId, this.httpsAgent);
  }

  public async createPoll(threadId: string, question: string, options: string[]): Promise<{ success: boolean; pollId?: string; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Tạo khảo sát'));
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
   * Repair contacts that have no avatar or inherited the account avatar.
   * This runs after an explicit inbox reload, so old incorrect rows are fixed
   * without issuing profile requests for every healthy conversation.
   */
  public async refreshSuspectThreadAvatars(threadIds: string[]): Promise<number> {
    const session = this.requireSession();
    const db = DatabaseService.getInstance();
    const ownerId = this.getFacebookId();
    const account = db.queryOne?.(
      `SELECT avatar_url FROM fb_accounts WHERE id = ?`,
      [this.accountId],
    ) as { avatar_url?: string } | undefined;
    const candidates = [...new Set(threadIds.map(String))].filter(id => /^\d+$/.test(id)).filter(id => {
      const thread = db.queryOne?.(
        `SELECT type, metadata FROM fb_threads WHERE id = ? AND account_id = ?`,
        [id, this.accountId],
      ) as { type?: string; metadata?: string } | undefined;
      if (thread?.type === 'group') return false;
      const contact = db.queryOne?.(
        `SELECT avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
        [ownerId, id],
      ) as { avatar_url?: string } | undefined;
      return !contact?.avatar_url || isSameFacebookAvatar(contact.avatar_url, account?.avatar_url);
    });

    let repaired = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const id = candidates[cursor++];
        try {
          const avatarUrl = await getFacebookAvatarById(session.cookieFacebook, id, this.httpsAgent);
          if (!avatarUrl || isSameFacebookAvatar(avatarUrl, account?.avatar_url)) continue;
          db.run?.(
            `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
            [avatarUrl, ownerId, id],
          );
          const row = db.queryOne?.(
            `SELECT metadata FROM fb_threads WHERE id = ? AND account_id = ?`,
            [id, this.accountId],
          ) as { metadata?: string } | undefined;
          let metadata: Record<string, any> = {};
          try { metadata = row?.metadata ? JSON.parse(row.metadata) : {}; } catch {}
          metadata.avatar_url = avatarUrl;
          db.run?.(
            `UPDATE fb_threads SET metadata = ? WHERE id = ? AND account_id = ?`,
            [JSON.stringify(metadata), id, this.accountId],
          );
          EventBroadcaster.emit('fb:onContactUpdate', {
            fbAccountId: ownerId,
            contactId: id,
            name: '',
            avatarUrl,
          });
          repaired++;
        } catch (err: any) {
          Logger.debug(`[FacebookService:${this.accountId}] Page avatar refresh failed for ${id}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
    if (repaired) Logger.log(`[FacebookService:${this.accountId}] Repaired ${repaired} Facebook/Page avatar(s)`);
    return repaired;
  }

  /** Reload the bridge inbox page, including conversations absent from web GraphQL. */
  /** End-to-end encrypted conversation (Facebook does not let a new device read old messages). */
  public isE2EEThread(threadId: string): boolean {
    const id = String(threadId || '').replace(/@.*$/, '');
    if (this.e2eeThreads.has(id)) return true;
    try {
      const db = DatabaseService.getInstance();
      const row = db.queryOne?.(
        `SELECT is_e2ee FROM fb_threads WHERE id = ? AND account_id = ?`, [id, this.accountId],
      ) as { is_e2ee?: number } | undefined;
      if (Number(row?.is_e2ee) === 1) return true;
      // A 1:1 end-to-end encrypted chat usually has no fb_threads row (markFBThreadE2EE only UPDATEs) → the flag is lost after a restart
      // again. It is recognised from the messages on the machine: E2EE messages carry the bridge's numeric id, while ordinary Messenger messages always have a "mid.$…" id. If there are messages but
      // none of them has "mid.$" = all E2EE, with no ordinary history to load: before, it fell through to GraphQL, Facebook returned an error →
      // the chat frame showed "Lỗi - Thử lại" (Error - Retry) on every open. A conversation that also has ordinary messages (already switched to E2EE) still loads the older part.
      const owner = String(this.getFacebookId() || '');
      const kinds = db.queryOne?.(
        `SELECT EXISTS(SELECT 1 FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook') AS any_msg,
                EXISTS(SELECT 1 FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook'
                         AND msg_id GLOB 'mid.$*') AS regular`,
        [owner, id, owner, id],
      ) as { any_msg?: number; regular?: number } | undefined;
      return Number(kinds?.any_msg) === 1 && Number(kinds?.regular) === 0;
    } catch {
      return false;
    }
  }

  /** One page of the conversation list (for syncing over a time range beyond the 50 newest conversations). */
  public async getThreadListPage(before: number | null) {
    const session = this.requireSession();
    return getThreadListPage(session, this.accountId, before, 50, this.httpsAgent);
  }

  /**
   * The bridge's LightSpeed socket (ordinary Messenger) has finished syncing - needed for loading history. Different from the E2EE socket: E2EE can
   * run while LightSpeed is stuck at the initial sync step (messagix reconnects by itself).
   */
  public async isBridgeLightSpeedReady(): Promise<boolean> {
    const bridge = this.e2eeBridge;
    if (!bridge?.isAlive()) return false;
    try {
      const state = await bridge.call('isConnected', {}, 5_000) as { connected?: boolean } | undefined;
      return state?.connected === true;
    } catch {
      return false;
    }
  }

  /** The account's history-loading pacer (background sync uses it to rest when switching conversations / the list pages). */
  public historyPacing(): FacebookHumanPacer {
    return this.historyPacer;
  }

  /**
   * Anchor for FetchMessagesTask: the Messenger message id (`mid.$…`) from the caller; if there is none (start of the sync, opening a conversation, the oldest
   * visible message is an E2EE message) → the newest Messenger message on the machine ≤ the time mark. null = no usable anchor → GraphQL.
   * `latestKnownMs`: the newest activity of the conversation - if the newest message on the machine is clearly older, the machine is missing messages at the start;
   * going back from that mark would skip them → also returns null.
   */
  private resolveHistoryAnchor(
    threadId: string,
    anchor: { timestampMs: number; messageId: string },
    latestKnownMs?: number,
  ): { timestampMs: number; messageId: string } | null {
    if (isLightSpeedMessageId(anchor.messageId) && anchor.timestampMs > 0) {
      return { timestampMs: anchor.timestampMs, messageId: anchor.messageId };
    }
    let row: { msg_id?: string; timestamp?: number } | undefined;
    try {
      row = DatabaseService.getInstance().queryOne?.(
        `SELECT msg_id, timestamp FROM messages
         WHERE owner_zalo_id = ? AND channel = 'facebook' AND thread_id = ? AND msg_id LIKE 'mid.$%' AND timestamp <= ?
         ORDER BY timestamp DESC LIMIT 1`,
        [String(this.getFacebookId()), threadId, anchor.timestampMs > 0 ? anchor.timestampMs : Number.MAX_SAFE_INTEGER],
      ) as { msg_id?: string; timestamp?: number } | undefined;
    } catch {
      return null;
    }
    const timestampMs = activityMs(row?.timestamp);
    if (!row || !timestampMs || !isLightSpeedMessageId(row.msg_id)) return null;
    const latest = activityMs(latestKnownMs);
    if (latest && timestampMs < latest - HISTORY_TOP_GAP_MS) return null;
    return { timestampMs, messageId: String(row.msg_id) };
  }

  /**
   * The newest page of the conversation through GraphQL - used when the machine has no Messenger message yet to anchor FetchMessagesTask. The later pages
   * anchor on the oldest message of this page (the `mid.$…` id is shared by GraphQL / LightSpeed). Called after the pacer has let it through.
   */
  private async fetchGraphQLHistoryPage(threadId: string, range?: FbHistorySyncRange): Promise<FbHistoryPageResult> {
    this.historyPacer.recordRequest();
    const startedAt = Date.now();
    let res: Awaited<ReturnType<FacebookService['fetchThreadMessages']>>;
    try {
      res = await this.fetchThreadMessages(threadId, HISTORY_GRAPHQL_PAGE);
    } catch (err: any) {
      res = { success: false, error: err?.message || String(err) };
    }
    if (!res.success) {
      const message = res.error || tr('Facebook không trả lời');
      if (this.historyPacer.recordResult(false, Date.now() - startedAt, message) === 'risk') {
        Logger.warn(`[FacebookService:${this.accountId}] history paused 30 min after a risk signal: ${message}`);
        return { success: false, code: 'RISK', error: HISTORY_RISK_TEXT, source: 'graphql' };
      }
      return { success: false, code: 'FETCH', error: message, source: 'graphql' };
    }
    this.historyPacer.recordResult(true, Date.now() - startedAt);
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const { stored, fresh, received } = this.persistGraphQLHistory(threadId, messages, range);
    let oldest: { id: string; ts: number } | null = null;
    for (const m of messages) {
      const ts = activityMs(m?.timestampMs);
      if (ts && isLightSpeedMessageId(m?.id) && (!oldest || ts < oldest.ts)) oldest = { id: String(m.id), ts };
    }
    Logger.log(`[FacebookService:${this.accountId}] history page via GraphQL thread=${threadId}: ${messages.length} messages`);
    return {
      success: true,
      saved: fresh,
      received,
      stored,
      count: messages.length,
      // A page that is not full = the conversation has only that many messages; full → continue with FetchMessagesTask from the oldest message
      hasMoreBefore: !!oldest && (messages.length >= HISTORY_GRAPHQL_PAGE || !!res.cursor?.hasMore),
      minTimestampMs: oldest?.ts || 0,
      minMessageId: oldest?.id,
      source: 'graphql',
    };
  }

  /**
   * One page of messages older than `anchor` in a conversation - saved right away as history. anchor.timestampMs = 0 → the newest page.
   * Goes through the bridge (LightSpeed FetchMessagesTask, like Messenger web), anchored on a real message: Messenger web / mautrix-meta
   * always send the id + time of the oldest message available (mautrix-meta does not load a conversation that has no message yet); an empty anchor
   * ("messages before time X" without an id) makes Facebook return nothing - before, sync / opening a conversation gave 0 messages. If no message
   * is available as the mark yet → the newest page through GraphQL (resolveHistoryAnchor / fetchGraphQLHistoryPage).
   * Every request goes through the account's pacer: `background` (background sync) rests like a reader + takes breaks;
   * `interactive` (scrolling / opening a conversation) only waits a few seconds, and when the budget runs out it reports BUSY. Coded errors: BRIDGE_DOWN /
   * BRIDGE_OLD / E2EE / FETCH / RISK (a sign of being blocked → paused for 30 minutes) / COOLDOWN / BUSY / CANCELLED.
   */
  public async fetchHistoryPage(
    threadId: string,
    anchor: { timestampMs: number; messageId: string },
    range?: FbHistorySyncRange,
    opts: {
      mode?: 'background' | 'interactive';
      shouldStop?: () => boolean;
      onWait?: (wait: PacerWait) => void;
      /** The newest known activity of the conversation (the first page of the sync) - used to detect that the machine is missing messages at the start of the conversation. */
      latestKnownMs?: number;
    } = {},
  ): Promise<FbHistoryPageResult> {
    const cooldown = this.historyPacer.cooldownRemaining();
    if (cooldown > 0) {
      return {
        success: false,
        code: 'COOLDOWN',
        error: tr('Đang tạm dừng tải lịch sử Facebook để bảo vệ tài khoản (còn {{v1}} phút)', { v1: Math.ceil(cooldown / 60_000) }),
      };
    }
    const id = String(threadId || '').replace(/@.*$/, '');
    if (!/^\d+$/.test(id)) return { success: false, code: 'FETCH', error: tr('Mã hội thoại không hợp lệ') };
    if (this.isE2EEThread(id)) {
      return { success: false, code: 'E2EE', error: tr('Hội thoại mã hoá đầu cuối: Facebook không cho thiết bị mới tải tin cũ') };
    }
    const ref = this.resolveHistoryAnchor(id, anchor, opts.latestKnownMs);
    if (ref) {
      const bridge = this.e2eeBridge;
      if (!bridge?.isAlive()) {
        return { success: false, code: 'BRIDGE_DOWN', error: tr('Bridge Facebook chưa chạy (đang kết nối lại) — thử lại sau ít phút') };
      }
      if (!bridge.supportsCapability('fetchMessages')) {
        return { success: false, code: 'BRIDGE_OLD', error: tr('Bridge Facebook bản cũ chưa hỗ trợ tải lịch sử — khởi động lại Deplao sau khi cập nhật') };
      }
    }
    // A real user's pace before asking Facebook
    if (opts.mode === 'interactive') {
      const plan = this.historyPacer.planInteractivePage();
      if ('busy' in plan) return { success: false, code: 'BUSY', error: tr('Đang tải nhiều tin cũ — thử lại sau ít phút') };
      if (plan.ms > 0 && !(await sleepUnlessStopped(plan.ms, opts.shouldStop))) {
        return { success: false, code: 'CANCELLED', error: tr('Đã huỷ') };
      }
    } else {
      const plan = this.historyPacer.planBackgroundPage();
      if (plan.ms > 0) {
        opts.onWait?.(plan);
        if (!(await sleepUnlessStopped(plan.ms, opts.shouldStop))) return { success: false, code: 'CANCELLED', error: tr('Đã huỷ') };
      }
    }
    if (!ref) return this.fetchGraphQLHistoryPage(id, range);
    // The bridge may have been rebuilt during the rest → use the one currently running
    const liveBridge = this.e2eeBridge;
    if (!liveBridge?.isAlive()) {
      return { success: false, code: 'BRIDGE_DOWN', error: tr('Bridge Facebook chưa chạy (đang kết nối lại) — thử lại sau ít phút') };
    }
    this.historyPacer.recordRequest();
    const startedAt = Date.now();
    let page: BridgeHistoryPage;
    try {
      page = await liveBridge.fetchMessages({
        threadId: id,
        beforeTimestampMs: ref.timestampMs,
        beforeMessageId: ref.messageId,
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      if (this.historyPacer.recordResult(false, Date.now() - startedAt, message) === 'risk') {
        Logger.warn(`[FacebookService:${this.accountId}] history paused 30 min after a risk signal: ${message}`);
        return { success: false, code: 'RISK', error: HISTORY_RISK_TEXT, source: 'lightspeed' };
      }
      // The bridge's LightSpeed socket is not connected (can happen while the encrypted socket still runs): no conversation can be loaded
      if (/LightSpeed socket is not connected|client not initiali[sz]ed|Messenger client is not initiali[sz]ed/i.test(message)) {
        return { success: false, code: 'BRIDGE_DOWN', error: tr('Kết nối Messenger thường của bridge (dùng để tải lịch sử, khác kết nối E2EE) chưa sẵn sàng — Facebook chưa trả lời bước đồng bộ ban đầu. Tin nhắn và E2EE vẫn hoạt động; thử lại sau ít phút'), source: 'lightspeed' };
      }
      return { success: false, code: 'FETCH', error: message, source: 'lightspeed' };
    }
    this.historyPacer.recordResult(true, Date.now() - startedAt);
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    const { stored, fresh, received } = this.persistBridgeMessages(messages, range);
    return {
      success: true,
      saved: fresh,
      received,
      stored,
      count: messages.length,
      hasMoreBefore: !!page?.hasMoreBefore,
      minTimestampMs: activityMs(page?.minTimestampMs) || (messages.length ? Math.min(...messages.map(m => activityMs(m.timestampMs) || Infinity)) : 0),
      minMessageId: page?.minMessageId || undefined,
      source: 'lightspeed',
    };
  }

  /**
   * The history of a conversation over a time range: loads page by page going back (saved right away) until Facebook reports the end or the oldest
   * message is before the start of the range, with no limit on the number of messages. `shouldStop` allows cancelling midway.
   */
  public async syncThreadHistory(
    threadId: string,
    range: FbHistorySyncRange,
    opts: {
      shouldStop?: () => boolean;
      onPage?: (page: { saved: number; received: number }) => void;
      onWait?: (wait: PacerWait) => void;
      /** The newest known activity of the conversation (conversation list) - the first page detects that the machine is missing messages at the start. */
      latestKnownMs?: number;
    } = {},
  ): Promise<{ saved: number; received: number; pages: number; complete: boolean; error?: string; code?: string }> {
    let anchor = { timestampMs: range.toTs ?? 0, messageId: '' };
    let saved = 0;
    let received = 0;
    let pages = 0;
    let retried = false;
    for (;;) {
      if (opts.shouldStop?.()) return { saved, received, pages, complete: false };
      const res = await this.fetchHistoryPage(threadId, anchor, range, {
        mode: 'background',
        shouldStop: opts.shouldStop,
        onWait: opts.onWait,
        // Range up to now: compare the newest message on the machine with the newest activity (an end in the past does not need this)
        latestKnownMs: pages === 0 && range.toTs == null ? opts.latestKnownMs : undefined,
      });
      // tsconfig strict:false does not narrow the union by `success` → use 'error' in res
      if ('error' in res) {
        if (res.code === 'CANCELLED') return { saved, received, pages, complete: false };
        // Facebook is slow to reply once: retry once (the pacer already waited longer after the error)
        if (res.code === 'FETCH' && !retried) {
          retried = true;
          continue;
        }
        return { saved, received, pages, complete: false, error: res.error, code: res.code };
      }
      retried = false;
      pages += 1;
      saved += res.saved;
      received += res.received;
      opts.onPage?.({ saved: res.saved, received: res.received });
      const next = nextHistoryAnchor(
        { count: res.count, hasMoreBefore: res.hasMoreBefore, minTimestampMs: res.minTimestampMs, minMessageId: res.minMessageId },
        anchor,
        range,
      );
      if (!next) return { saved, received, pages, complete: true };
      anchor = next;
    }
  }

  public async syncBridgeHistory(): Promise<{ threads: number; messages: number }> {
    if (!this.e2eeBridge?.isAlive()) return { threads: 0, messages: 0 };
    try {
      return this.persistBridgeHistory(await this.e2eeBridge.syncHistory());
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] syncBridgeHistory error: ${err.message}`);
      return { threads: 0, messages: 0 };
    }
  }

  /**
   * Refreshes the avatar of 1 Facebook contact (1-1 user).
   * A 3-layer strategy that always gets an avatar:
   *   1. The profile endpoint keyed by UID → a fresh CDN URL
   *   2. Download the image locally with the Facebook cookie → the local path does not expire any more
   *   3. Fallback: re-fetch the GraphQL thread list → a fresh CDN URL
   *
   * Used when the avatar CDN returns 403 - the URL has expired.
   */
  public async refreshContactAvatar(fbUserId: string): Promise<string | null> {
    // Server-side debounce: only refresh once per user / session
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
      // E2EE contacts are available directly from the bridge. Prefer that
      // task before the public image redirect, which can return 404 for some
      // Messenger-only identities.
      const bridgeInfo = await this.getE2EEUserInfo(fbUserId);
      let freshCdnUrl = bridgeInfo?.avatarUrl || await getFacebookAvatarById(cookie, fbUserId, this.httpsAgent);
      if (!freshCdnUrl) {
        freshCdnUrl = (await getFacebookUserInfo(session, fbUserId, this.httpsAgent))?.avatarUrl || null;
      }

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
   * Gets a Facebook user's info (name + avatar) through the endpoint keyed by UID.
   * The old method name is kept so the released IPC / renderer keeps working.
   */
  public async getUserInfoFacebook(fbUserId: string): Promise<{ name: string; avatarUrl: string } | null> {
    try {
      return await this.resolveFacebookUserInfo(fbUserId);
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] getUserInfoFacebook error: ${err.message}`);
      return null;
    }
  }

  /** Use the Messenger bridge when an E2EE session can authoritatively resolve a contact. */
  private async getE2EEUserInfo(fbUserId: string): Promise<{ name: string; avatarUrl: string } | null> {
    if (!/^\d+$/.test(fbUserId) || !this.isE2EEConnected() || !this.e2eeBridge?.supportsCapability('getUserInfo')) {
      return null;
    }
    try {
      const info = await this.e2eeBridge.getUserInfo(fbUserId);
      if (String(info?.id ?? '') !== fbUserId || !String(info?.name || '').trim()) {
        Logger.warn(`[FacebookService:${this.accountId}] Bridge user info did not match requested UID ${fbUserId}`);
        return null;
      }
      return { name: info.name.trim(), avatarUrl: String(info.profilePictureUrl || '') };
    } catch (err: any) {
      Logger.warn(`[FacebookService:${this.accountId}] Bridge getUserInfo failed for ${fbUserId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Resolve an identity without reading profile HTML. Bridge data is preferred
   * for active E2EE conversations; the UID-keyed web endpoint is a bounded
   * fallback for normal conversations and older bridge binaries.
   */
  private async resolveFacebookUserInfo(fbUserId: string): Promise<{ name: string; avatarUrl: string } | null> {
    const bridgeInfo = await this.getE2EEUserInfo(fbUserId);
    if (bridgeInfo) return bridgeInfo;

    const session = this.requireSession();
    const profile = await getFacebookUserInfo(session, fbUserId, this.httpsAgent);
    if (!profile) return null;
    // /picture is addressed to the UID, but a 404 is not fatal: user_info
    // already supplied an identity-safe thumbnail.
    const exactAvatar = await getFacebookAvatarById(session.cookieFacebook, fbUserId, this.httpsAgent);
    return { name: profile.name, avatarUrl: exactAvatar || profile.avatarUrl };
  }

  /** @deprecated Use getUserInfoFacebook. Kept for integrations built before the UID endpoint. */
  public async getUserInfoFacebookHtml(fbUserId: string): Promise<{ name: string; avatarUrl: string } | null> {
    return this.getUserInfoFacebook(fbUserId);
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

  /** Blocks a user (N4) */
  public async blockUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return blockUser(this.requireSession(), userId, this.httpsAgent);
  }

  /** Unblocks a user (N4) */
  public async unblockUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return unblockUser(this.requireSession(), userId, this.httpsAgent);
  }

  /** Changes the conversation theme (N1) */
  public async changeThreadTheme(threadId: string, theme: string): Promise<{ success: boolean; error?: string }> {
    return changeThreadTheme(this.requireSession(), threadId, theme, this.httpsAgent);
  }

  /** Creates a Messenger Note (N2); default privacy FRIENDS, as in fbchat-v2. */
  public async createNote(text: string, privacy?: string): Promise<{ success: boolean; noteId?: string; error?: string }> {
    return createNote(this.requireSession(), text, privacy, this.httpsAgent);
  }

  /** Adds a group admin (N3) */
  public async addGroupAdmin(threadId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Thêm quản trị viên'));
    if (!allowed.success) return allowed;
    return addGroupAdmin(this.requireSession(), threadId, userId);
  }

  /** Removes a group admin (N3) */
  public async removeGroupAdmin(threadId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Xóa quản trị viên'));
    if (!allowed.success) return allowed;
    return removeGroupAdmin(this.requireSession(), threadId, userId);
  }

  /** Turns member approval on / off (N3) */
  public async changeApprovalMode(threadId: string, approved: boolean): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Đổi chế độ duyệt thành viên'));
    if (!allowed.success) return allowed;
    return changeApprovalMode(this.requireSession(), threadId, approved, this.httpsAgent);
  }

  /** Approves / rejects a member (N3) */
  public async approvePendingMember(threadId: string, userId: string, approve: boolean): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, approve ? tr('Duyệt thành viên') : tr('Từ chối thành viên'));
    if (!allowed.success) return allowed;
    return approvePendingMember(this.requireSession(), threadId, userId, approve, this.httpsAgent);
  }

  /** Gets the group invite link (N3) */
  public async getGroupLink(threadId: string): Promise<{ success: boolean; link?: string; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Lấy link mời nhóm'));
    if (!allowed.success) return allowed;
    return getGroupLink(this.requireSession(), threadId, this.httpsAgent);
  }

  /** Turns the group invite link on / off (N3) */
  public async setGroupLink(threadId: string, enable: boolean): Promise<{ success: boolean; error?: string }> {
    const allowed = await this.requireGroupOperation(threadId, tr('Đổi link mời nhóm'));
    if (!allowed.success) return allowed;
    return setGroupLink(this.requireSession(), threadId, enable, this.httpsAgent);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Persist a reaction update to fb_messages DB.
   * Reads current reactions, merges the new one (userId → emoji), saves back.
   */
  /** false = the event (reaction / unsend) was just reported in exactly the same way by the other source (MQTT / bridge) → skipped, not written and not replayed. */
  private acceptRepeatable(event: { key: string; value: string }): boolean {
    if (!this._eventRepeats) this._eventRepeats = createRepeatFilter();
    return this._eventRepeats.accept(event.key, event.value);
  }

  private acceptReactionEvent(messageId: string, userId: string, emoji: string): boolean {
    return this.acceptRepeatable(reactionRepeat(messageId, userId, emoji));
  }

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
   * Checks whether the MQTT listener is really still connected (BUG #3 fix).
   * Unlike isConnected(), which only checks the status flag, this method checks the actual socket.
   * Used before sending a message to make sure the connection is really alive.
   */
  public isListenerActuallyConnected(): boolean {
    if (!this.listener) return false;
    return this.listener.isActuallyConnected();
  }

  /**
   * Checks the connection and automatically reconnects if the listener has died (BUG #3 fix).
   * Called before every message send to make sure the connection is really alive.
   * Returns true if ready to send, false if it cannot send.
   */
  public async ensureConnected(): Promise<boolean> {
    // A live child process is not proof that Facebook is reachable: its
    // internal LightSpeed socket can be disconnected after the computer comes
    // back online.  Continue with the listener/session health checks below so
    // a stale bridge never masks a necessary account reconnect.

    // ── OVERFLOW PATH: MQTT queue persistently overflowing → do not create a new listener ──
    // If _mqttOverflowCount > 2, creating a new listener only causes more overflow.
    // Bridge is not alive → refresh the session to use the REST API.
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

    // Service says connected → verify the listener is really alive
    if (this.status === 'connected' && this.isListenerActuallyConnected()) {
      return true;
    }

    // ── Safety net: if the listener is really alive (receiving MQTT) even though the status is wrong ──
    // The status may have been set wrongly by the catch block of _doConnect() calling setStatus('error') while
    // MQTT had connected successfully, or MQTT reconnected successfully but one event
    // 'disconnected' from the old listener arrived late. This avoids an unnecessary reconnect.
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
        // Tear down the old listener and create it again
        if (this.listener) {
          this.listener.disconnect();
          this.listener = null;
        }
        // connect() intentionally no-ops while status is `connected`; clear
        // that stale status before asking it to build a fresh session/listener.
        this._connectPromise = null;
        this.setStatus('disconnected');
        await this.connect(); // ← uses connect() with a guard, does not call _doConnect() directly
        // Wait until the listener is really connected + stable
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
        // Wait until the listener is really connected + stable, because connect() → _doConnect() starts MQTT async
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
      // Wait for the listener to really connect + stabilise (in case _connectPromise resolves
      // but MQTT has not finished the handshake and immediately overflows)
      return await this.waitForStableConnection(15000);
    }

    return false;
  }

  /**
   * Waits for the MQTT listener to really connect, with a timeout.
   * _doConnect() starts the MQTT listener async (this.listener.connect()) and does not wait
   * for the WebSocket handshake to finish. This function polls isListenerActuallyConnected() periodically
   * to avoid a false positive when MQTT has not connected yet.
   * Does NOT check this.status, because the listener can be connected even though the status was set wrongly
   * (by the catch block calling setStatus('error') in _doConnect()).
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
   * Waits for the MQTT listener to connect + verifies stability.
   * Calls waitForListenerReady first, then waits 1 more s and checks whether the listener
   * is still connected. Avoids a race when MQTT has just connected
   * but immediately hits ERROR_QUEUE_OVERFLOW → disconnect → reconnect timer.
   *
   * If the listener is connected and stable (still alive after 1 s) → return true.
   * If the listener dies after connecting → retry waitForListenerReady (at most 2 times).
   */
  private async waitForStableConnection(timeoutMs: number): Promise<boolean> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ready = await this.waitForListenerReady(timeoutMs);
      if (!ready) return false;

      // Stability window: wait 1 s to verify the connection is not overflowed straight away
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

  /** Resets the MQTT listener's retry count (called when the user reconnects manually from the dashboard) */
  public resetListenerRetryCount(): void {
    if (this.listener) {
      this.listener.resetRetryCount();
      Logger.log(`[FacebookService:${this.accountId}] Listener retry count reset`);
    }
  }
}

export default FacebookService;
