/**
 * FacebookMQTTListener.ts
 * Ported from the Python _messaging/_listening.py
 * Listens for realtime messages over MQTT over WebSocket
 */

import mqtt, { MqttClient } from 'mqtt';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { FBSessionData, FBMQTTMessage, FBConnectionStatus } from './FacebookTypes';
import { isFbUnavailableTemplate, templateFromStoryAttachment, type FbTemplate } from '../../shared/facebook/facebookTemplate';
import {
  generateSessionId, generateClientId
} from './FacebookUtils';
import Logger from '../../utils/Logger';

const FB_MQTT_ENDPOINT = 'wss://edge-chat.facebook.com/chat';
const FB_TOPICS = ['/t_ms', '/thread_typing', '/orca_typing_notifications', '/orca_presence'];

export interface FBThreadEvent {
  type: 'name' | 'emoji' | 'nickname';
  threadId: string;
  actorFbId: string;
  timestamp: string;
  name?: string;
  emoji?: string;
  nickname?: string;
  targetUserId?: string;
}

export interface FBGroupParticipantEvent {
  type: 'added' | 'left';
  threadId: string;
  actorFbId: string;
  /** Single participant for 'left', array for 'added' */
  participantId?: string;
  participants?: Array<{ participantFbId: string }>;
}

export interface FBDeliveryReceipt {
  messageId: string;
  threadId: string;
  actorFbId: string;
  timestampMs: number;
}

/** The other person has read the conversation up to this time (ReadReceipt delta). */
export interface FBReadReceipt {
  threadId: string;
  actorFbId: string;
  watermarkTimestampMs: number;
}

export interface FBPresenceEntry {
  userId: string;
  status: 'active' | 'inactive' | 'offline';
  timestampMs: number;
}

export interface FBPresenceData {
  entries: FBPresenceEntry[];
}

export interface FBListenerEvents {
  message: (msg: FBMQTTMessage) => void;
  threadEvent: (data: FBThreadEvent) => void;
  participantEvent: (data: FBGroupParticipantEvent) => void;
  deliveryReceipt: (data: FBDeliveryReceipt) => void;
  readReceipt: (data: FBReadReceipt) => void;
  presence: (data: FBPresenceData) => void;
  typing: (data: { threadId: string; userId: string; state: number }) => void;
  reaction: (data: { messageId: string; reaction: string; actorFbId: string; threadId: string }) => void;
  connectionStatus: (status: FBConnectionStatus) => void;
  error: (err: Error) => void;
  /** Emitted when the MQTT seqId is updated - FacebookService uses it as the cache fallback */
  seqId: (seqId: string) => void;
  /** Emitted on ERROR_QUEUE_OVERFLOW - FacebookService uses it to prevent creating a new listener */
  overflow: (seqId: string) => void;
}

export class FacebookMQTTListener extends EventEmitter {
  private dataFB: FBSessionData;
  private accountId: string;
  private client: MqttClient | null = null;
  private syncToken: string | null = null;
  private lastSeqId: string = '0';
  private retryCount: number = 0;
  /** Max reconnect attempts before marking dead (like Zalo MAX_RECONNECT_ATTEMPTS=5; FB uses 8) */
  private readonly MAX_RECONNECT_ATTEMPTS: number = 8;
  /** Phase 2 threshold: after N attempts, switch to a steady 60 s retry instead of increasing the delay */
  private readonly PHASE2_THRESHOLD: number = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting: boolean = false;
  /** Guard timer: if connect() hangs for too long, reset isConnecting so the next retry can run */
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect: boolean = true;
  private reconnectDelay: number = 3000;
  private overflowRetryCount: number = 0;
  private httpsAgent: any = undefined;
  /** Periodic timer checking cookie health while in phase 2 (slow retry) */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Counts consecutive queue errors - used by ERROR_QUEUE_NOT_FOUND */
  private queueErrorCount: number = 0;
  /** Guard flag: stops scheduleReconnect from being called twice by the offline + close cascade (BUG #1 fix) */
  private _reconnectPending: boolean = false;
  /** Time of the last pong received from the MQTT server (used to detect a silent disconnect) */
  private lastPongTime: number = 0;
  /** Periodic ping timer to check the connection is still alive (BUG #2 fix) */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Phase 3 threshold: after N phase 2 retries, switch to a retry every 5 minutes (BUG #4 fix) */
  private readonly PHASE3_THRESHOLD: number = 30;
  /** Total retries since the listener was created (not reset on success - to track aging) */
  private totalRetryCount: number = 0;
  /**
   * Callback that FacebookService uses to check cookie health during a long retry run.
   * If the cookie has really expired → the listener emits 'cookie_expired' and stops retrying.
   */
  private _healthCheckFn: (() => Promise<boolean>) | null = null;

  constructor(dataFB: FBSessionData, accountId: string, initialSeqId: string = '0', httpsAgent?: any) {
    super();
    this.dataFB = dataFB;
    this.accountId = accountId;
    this.lastSeqId = initialSeqId;
    this.httpsAgent = httpsAgent;
  }

  /**
   * Updates the session data (after the cookie is refreshed)
   */
  public updateSession(dataFB: FBSessionData): void {
    this.dataFB = dataFB;
  }

  /**
   * Connects the MQTT WebSocket
   */
  public connect(): void {
    if (this.isConnecting || (this.client && this.client.connected)) {
      Logger.log(`[FBMqtt:${this.accountId}] Already connecting/connected`);
      return;
    }

    // Cleanup previous client if any
    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;
    this._reconnectPending = false; // Reset guard (BUG #1 fix)

    // ── Timeout guard: if connect hangs for more than 45 s, reset isConnecting ──
    this.clearConnectTimeout();
    this.connectTimeout = setTimeout(() => {
      if (this.isConnecting) {
        Logger.warn(`[FBMqtt:${this.accountId}] Connect timed out after 45s - resetting`);
        this.isConnecting = false;
        if (this.client) {
          try { this.client.removeAllListeners(); this.client.end(true); } catch {}
          this.client = null;
        }
        this.scheduleReconnect();
      }
    }, 45000);

    const sessionId = generateSessionId();
    const clientId = generateClientId();

    // Facebook MQTT username payload - same as paho-mqtt in Python
    const userPayload = {
      u: this.dataFB.FacebookID,
      s: sessionId,
      chat_on: true,
      fg: false,
      d: clientId,
      ct: 'websocket',
      aid: 219994525426954,        // Facebook web app ID
      mqtt_sid: '',
      cp: 3,
      ecp: 10,
      st: FB_TOPICS,
      pm: [],
      dc: '',
      no_auto_fg: true,
      gas: null,
      pack: [],
    };

    const wsUrl = `${FB_MQTT_ENDPOINT}?region=eag&sid=${sessionId}`;

    Logger.log(`[FBMqtt:${this.accountId}] Connecting to ${wsUrl} ...`);

    const wsHeaders = {
          'Cookie': this.dataFB.cookieFacebook,
          'Origin': 'https://www.facebook.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Host': 'edge-chat.facebook.com',
        };

    try {
      this.client = mqtt.connect(wsUrl, {
        // ─── MQTT Protocol ─────────────────────────────────────────────
        protocolId: 'MQIsdp',       // MQTT 3.1 (required by Facebook)
        protocolVersion: 3,
        clientId: `mqttwsclient`,
        clean: true,
        keepalive: 10,
        connectTimeout: 20000,
        reconnectPeriod: 0,          // Manages reconnect itself

        // ─── Auth ──────────────────────────────────────────────────────
        username: JSON.stringify(userPayload),
        // No password set - Facebook does not need one

        // ─── Custom WebSocket creation ─────────────────────────────────
        // Facebook's MQTT WS endpoint does NOT return Sec-WebSocket-Protocol.
        // mqtt.js v5 requests 'mqttv3.1' subprotocol by default → ws module
        // rejects with "Server sent no subprotocol". Fix: skip protocols.
        createWebsocket: (url: string, _protocols: string[], _opts: any) => {
          const wsOptions: any = {
            headers: wsHeaders,
            rejectUnauthorized: true,
          };
          // Proxy support for the MQTT WebSocket connection
          if (this.httpsAgent) {
            wsOptions.agent = this.httpsAgent;
          }
          return new WebSocket(url, wsOptions) as any;
        },
      } as any);

      this.setupEvents();
    } catch (err: any) {
      Logger.error(`[FBMqtt:${this.accountId}] Connect constructor error: ${err.message}`);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private setupEvents(): void {
    if (!this.client) return;

    this.client.on('connect', (connack: any) => {
      Logger.log(`[FBMqtt:${this.accountId}] MQTT connected! connack=${JSON.stringify(connack)}`);
      this.isConnecting = false;
      this.clearConnectTimeout();
      this.retryCount = 0;
      this.reconnectDelay = 3000;
      // Do NOT reset overflowRetryCount here - it is only reset when the queue is created successfully
      // (inside handleMQTTMessage when syncToken + firstDeltaSeqId are received).
      // Resetting here causes an endless overflow loop, because the counter is always back at 0 before publishQueue.
      this.lastPongTime = Date.now(); // Reset pong timer on connect (BUG #2 fix)
      this.emit('connectionStatus', 'connected' as FBConnectionStatus);

      // ── Start ping/pong tracking (BUG #2 fix) ────────────────────
      this.startPingPong();

      // Subscribe explicitly to topics (in addition to `st` field in username)
      this.client?.subscribe(FB_TOPICS, { qos: 1 }, (err) => {
        if (err) {
          Logger.warn(`[FBMqtt:${this.accountId}] Subscribe error: ${err.message}`);
        } else {
          Logger.log(`[FBMqtt:${this.accountId}] Subscribed to ${FB_TOPICS.join(', ')}`);
        }
      });

      // Send sync queue request
      this.publishQueue();
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      try {
        // ─── Orca presence (I7) ──────────────────────────────────────
        if (topic === '/orca_presence') {
          this.handlePresence(payload);
          return;
        }

        // ─── Thread typing indicator ─────────────────────────────────
        if (topic === '/thread_typing') {
          this.handleThreadTyping(payload);
          return;
        }

        const text = payload.toString('utf8');
        // Phase 8: Log topic only — payload may contain message content
        Logger.log(`[FBMqtt:${this.accountId}] msg on ${topic} (${text.length} bytes)`);
        const j = JSON.parse(text);
        this.handleMQTTMessage(j);
      } catch {
        // Binary/non-JSON payload - ignore
      }
    });

    this.client.on('error', (err: Error) => {
      // Facebook's MQTT server sends non-standard puback flags - ignore parse errors
      if (err.message?.includes('header flag bits')) {
        Logger.log(`[FBMqtt:${this.accountId}] Ignoring non-standard packet header: ${err.message}`);
        return;
      }
      Logger.warn(`[FBMqtt:${this.accountId}] error event: ${err.message}`);
      this.isConnecting = false;
      this.clearConnectTimeout();
      this.stopPingPong(); // Clean up ping timer (BUG #2 fix)
      this.emit('error', err);
      // BUG #7 fix: emit disconnected status so UI updates immediately
      this.emit('connectionStatus', 'disconnected' as FBConnectionStatus);
      // An error can happen without a close event → schedule a reconnect to be safe
      this.scheduleReconnect();
    });

    this.client.on('disconnect', (packet: any) => {
      Logger.warn(`[FBMqtt:${this.accountId}] disconnect packet: ${JSON.stringify(packet)}`);
      this.isConnecting = false;
      this.clearConnectTimeout();
      this.stopPingPong(); // Clean up ping timer (BUG #2 fix)
      // The server sends DISCONNECT itself → a reconnect is needed
      this.emit('connectionStatus', 'disconnected' as FBConnectionStatus);
      this.scheduleReconnect();
    });

    // BUG #1 fix: close event - only reconnect if offline didn't already schedule
    this.client.on('close', () => {
      Logger.log(`[FBMqtt:${this.accountId}] MQTT closed`);
      this.isConnecting = false;
      this.clearConnectTimeout();
      this.stopPingPong(); // Clean up ping timer (BUG #2 fix)
      if (!this._reconnectPending) {
        this.emit('connectionStatus', 'disconnected' as FBConnectionStatus);
        this.scheduleReconnect();
      }
    });

    // BUG #1 fix: offline event - mark reconnect pending, only schedule if not already
    this.client.on('offline', () => {
      Logger.log(`[FBMqtt:${this.accountId}] MQTT offline`);
      this.isConnecting = false;
      this.clearConnectTimeout();
      this.stopPingPong(); // Clean up ping timer (BUG #2 fix)
      this.emit('connectionStatus', 'disconnected' as FBConnectionStatus);
      this.scheduleReconnect();
    });

    // Debug: CONNACK rejection detection
    this.client.on('packetreceive', (packet: any) => {
      if (packet?.cmd === 'connack') {
        Logger.log(`[FBMqtt:${this.accountId}] CONNACK received: returnCode=${packet.returnCode} reasonCode=${packet.reasonCode}`);
        if (packet.returnCode && packet.returnCode !== 0) {
          Logger.error(`[FBMqtt:${this.accountId}] CONNACK rejected! code=${packet.returnCode}`);
        }
      }
    });
  }

  private publishQueue(): void {
    if (!this.client || !this.client.connected) {
      Logger.warn(`[FBMqtt:${this.accountId}] publishQueue: client not connected`);
      return;
    }

    const queue: any = {
      sync_api_version: 10,
      max_deltas_able_to_process: 500,
      delta_batch_size: 500,
      encoding: 'JSON',
      entity_fbid: this.dataFB.FacebookID,
      orca_version: '1.2.0',
    };

    let topic: string;
    if (!this.syncToken) {
      topic = '/messenger_sync_create_queue';
      // Avoid ERROR_QUEUE_OVERFLOW: if there was already an overflow before, do not send
      // initial_titan_sequence_id so Facebook picks a suitable starting point itself.
      // If seqId=0 or the seq is too low, Facebook tries to sync all messages → overflow.
      if (this.overflowRetryCount === 0 && this.lastSeqId !== '0') {
        queue.initial_titan_sequence_id = this.lastSeqId;
      } else {
        Logger.log(`[FBMqtt:${this.accountId}] Omitting initial_titan_sequence_id (overflowRetryCount=${this.overflowRetryCount}, lastSeqId=${this.lastSeqId}) - letting Facebook choose starting point`);
      }
      queue.device_params = null;
    } else {
      topic = '/messenger_sync_get_diffs';
      queue.last_seq_id = this.lastSeqId;
      queue.sync_token = this.syncToken;
    }

    Logger.log(`[FBMqtt:${this.accountId}] Publishing to ${topic} seq=${this.lastSeqId}`);
    this.client.publish(topic, JSON.stringify(queue), { qos: 1 }, (err) => {
      if (err) {
        Logger.warn(`[FBMqtt:${this.accountId}] Publish error: ${err.message}`);
      }
    });
  }

  private handleMQTTMessage(j: any): void {
    // Sync token + first delta seq
    if (j.syncToken && j.firstDeltaSeqId) {
      this.syncToken = j.syncToken;
      this.lastSeqId = String(j.firstDeltaSeqId);
      this.overflowRetryCount = 0; // Queue created successfully
      Logger.log(`[FBMqtt:${this.accountId}] Got syncToken, seqId=${this.lastSeqId} - listening for deltas`);
      this.emit('seqId', this.lastSeqId); // Cache fallback in FacebookService
      return;
    }

    // Update last seq ID
    if (j.lastIssuedSeqId) {
      this.lastSeqId = String(j.lastIssuedSeqId);
      this.emit('seqId', this.lastSeqId); // Cache fallback in FacebookService
    }

    // Error codes
    if (j.errorCode) {
      const code = j.errorCode;
      Logger.warn(`[FBMqtt:${this.accountId}] MQTT errorCode: ${code}`);

      if (code === 'ERROR_QUEUE_OVERFLOW') {
        // Queue overflow = server-side queue is full. Must disconnect, fetch latest seqId
        // via GraphQL, then reconnect with that seqId so Facebook only syncs recent messages.
        Logger.warn(`[FBMqtt:${this.accountId}] ERROR_QUEUE_OVERFLOW - fetching latest seqId then reconnect`);
        this.emit('overflow', this.lastSeqId); // Notify FacebookService to prevent creating a new listener
        this.syncToken = null;
        // Force-close current connection but allow reconnect
        this.shouldReconnect = true;
        if (this.client) {
          try { this.client.removeAllListeners(); this.client.end(true); } catch {}
          this.client = null;
        }
        this.isConnecting = false;
        this.overflowRetryCount = (this.overflowRetryCount || 0) + 1;
        if (this.overflowRetryCount > 3) {
          Logger.error(`[FBMqtt:${this.accountId}] ERROR_QUEUE_OVERFLOW persists after ${this.overflowRetryCount} full reconnects - giving up permanently. Bridge will handle MQTT traffic.`);
          this.shouldReconnect = false; // Stop completely, no more reconnects
          this._reconnectPending = false;
          this.overflowRetryCount = 0;
          this.emit('connectionStatus', 'error' as FBConnectionStatus);
          return;
        }
        // Fetch latest seqId before reconnecting - this is the key fix!
        // Without correct seqId, Facebook tries to sync all messages → overflow again.
        const delay = Math.min(10000 * Math.pow(3, this.overflowRetryCount - 1), 60000);
        Logger.log(`[FBMqtt:${this.accountId}] Will fetch seqId + reconnect in ${Math.round(delay / 1000)}s (overflow attempt ${this.overflowRetryCount}/3)`);
        this.reconnectTimer = setTimeout(async () => {
          if (!this.shouldReconnect) return;
          try {
            const { getLastSeqId } = await import('./FacebookThreadManager');
            const freshSeqId = await getLastSeqId(this.dataFB);
            Logger.log(`[FBMqtt:${this.accountId}] Fetched freshSeqId=${freshSeqId} for overflow recovery`);
            this.lastSeqId = freshSeqId || '0';
          } catch (e: any) {
            Logger.warn(`[FBMqtt:${this.accountId}] Failed to fetch seqId: ${e.message}, using last known`);
            // Keep whatever lastSeqId we had before, don't reset to 0
          }
          this.connect();
        }, delay);
        return;
      }

      if (code === 100 || code === 'ERROR_QUEUE_NOT_FOUND') {
        // Queue not found - reset sync token and re-create on same connection
        Logger.log(`[FBMqtt:${this.accountId}] Queue error (${code}), resetting syncToken and re-creating queue...`);
        this.syncToken = null;
        // Don't reset lastSeqId to '0' - keep current value to avoid overflow
        this.queueErrorCount += 1;
        if (this.queueErrorCount < 5) {
          setTimeout(() => this.publishQueue(), 1000);
        } else {
          Logger.warn(`[FBMqtt:${this.accountId}] Too many queue errors, full reconnect...`);
          this.queueErrorCount = 0;
          this.disconnect();
          this.retryCount = 0;
          this.scheduleReconnect(true);
        }
      }
      return;
    }

    // Delta messages
    if (j.deltas) {
      for (const delta of j.deltas) {
        this.processDelta(delta);
      }
    }
  }

  private processDelta(delta: any): void {
    // ─── 0. Read receipt: the other person has read up to this time (watermark) ────────
    if (delta.class === 'ReadReceipt' && delta.actorFbId) {
      const threadKey = delta.threadKey || {};
      const threadId = threadKey.otherUserFbId || threadKey.threadFbId || '0';
      const watermark = Number(delta.watermarkTimestampMs || delta.actionTimestampMs) || 0;
      if (threadId && threadId !== '0' && watermark) {
        this.emit('readReceipt', {
          threadId: String(threadId),
          actorFbId: String(delta.actorFbId),
          watermarkTimestampMs: watermark,
        });
      }
      return;
    }

    // ─── 1. Delivery receipt (no messageMetadata) ────────────────────────────
    if (delta.deliveredReceiptMessageId) {
      const threadKey = delta.threadKey || {};
      const threadId = threadKey.otherUserFbId || threadKey.threadFbId || '0';
      if (threadId && threadId !== '0') {
        this.emit('deliveryReceipt', {
          messageId: delta.deliveredReceiptMessageId,
          threadId: String(threadId),
          actorFbId: delta.actorFbId || '',
          timestampMs: delta.deliveredWatermarkTimestampMs || Date.now(),
        });
      }
      return;
    }

    // ─── 2. Participant left (no messageMetadata) ────────────────────────────
    if (delta.leftParticipantFbId) {
      const threadKey = delta.threadKey || {};
      const threadId = threadKey.otherUserFbId || threadKey.threadFbId || '0';
      if (threadId && threadId !== '0') {
        this.emit('participantEvent', {
          type: 'left',
          threadId: String(threadId),
          actorFbId: delta.actorFbId || '',
          participantId: delta.leftParticipantFbId,
        });
      }
      return;
    }

    // ─── 3. Participant added (no messageMetadata) ───────────────────────────
    if (delta.addedParticipants?.length > 0) {
      const threadKey = delta.threadKey || {};
      const threadId = threadKey.otherUserFbId || threadKey.threadFbId || '0';
      if (threadId && threadId !== '0') {
        this.emit('participantEvent', {
          type: 'added',
          threadId: String(threadId),
          actorFbId: delta.actorFbId || '',
          participants: delta.addedParticipants,
        });
      }
      return;
    }

    // ─── 4. Deltas requiring messageMetadata ─────────────────────────────────
    if (!delta?.messageMetadata) {
      // Phase 8: Log delta type only — may contain message content
      Logger.log(`[FBMqtt:${this.accountId}] Unhandled delta: ${delta?.operation || delta?.type || 'unknown'}`);
      return;
    }

    const meta = delta.messageMetadata;
    const threadKey = meta.threadKey || {};
    const replyToID = threadKey.otherUserFbId || threadKey.threadFbId || '0';
    const threadType = threadKey.otherUserFbId ? 'user' : 'group';

    // 4a. Thread name change - has `name` field but no `body` or `attachments`
    if (delta.name && !delta.body && !delta.attachments?.length) {
      this.emit('threadEvent', {
        type: 'name',
        threadId: String(replyToID),
        name: delta.name,
        actorFbId: meta.actorFbId,
        timestamp: meta.timestamp || String(Date.now()),
      });
      return;
    }

    // 4b. Thread emoji change
    if (delta.emoji && !delta.body && !delta.attachments?.length) {
      this.emit('threadEvent', {
        type: 'emoji',
        threadId: String(replyToID),
        emoji: delta.emoji,
        actorFbId: meta.actorFbId,
        timestamp: meta.timestamp || String(Date.now()),
      });
      return;
    }

    // 4c. Nickname change (delta with `nickname` field)
    if (delta.nickname && !delta.body && !delta.attachments?.length) {
      this.emit('threadEvent', {
        type: 'nickname',
        threadId: String(replyToID),
        nickname: delta.nickname,
        actorFbId: meta.actorFbId,
        targetUserId: delta.subjectId || '',
        timestamp: meta.timestamp || String(Date.now()),
      });
      return;
    }

    // 4d. Reaction - delta with `messageReaction` field (non-E2EE group/user reactions)
    if (delta.messageReaction) {
      const rxn = delta.messageReaction;
      this.emit('reaction', {
        messageId: rxn.messageId || rxn.message_id || meta.messageId || '',
        reaction: rxn.reaction || '',
        actorFbId: rxn.actorFbId || meta.actorFbId || '',
        threadId: String(replyToID),
      });
      return;
    }

    // 4eii. Admin activity messages (pin, poll, group info changes from adminText) - skip
    // Facebook sends admin-generated text such as "Tiến đã ghim một tin nhắn." (the person pinned a message.) inside
    // messageMetadata.adminText. These are NOT real user messages - just localized
    // informational text that the bridge handles internally.
    if (delta.messageMetadata?.adminText) {
      Logger.log(`[FBMqtt:${this.accountId}] Admin message: "${(delta.messageMetadata.adminText as string).slice(0, 100)}" - skipping (admin activity, not a user message)`);
      return;
    }

    // 4f. Unsend/Recall - delta with message_type='unsent', no body, no attachments
    const isUnsentDelta = !delta.body && !delta.attachments?.length && (
      delta.message_type === 'unsent' ||
      delta.is_unsent === true ||
      delta.is_unsent === 1
    );
    if (isUnsentDelta) {
      Logger.log(`[FBMqtt:${this.accountId}] Unsend delta: messageId=${meta.messageId} actor=${meta.actorFbId} threadId=${replyToID}`);
      this.emit('unsend', {
        messageId: meta.messageId,
        threadId: String(replyToID),
        actorFbId: meta.actorFbId,
      });
      return;
    }

    // 4e. Existing: message with body or attachments - parse attachment + emit
    // Track attachment index for synthetic ID generation when no real fbid/ID exists
    let _attIndex = 0;
    const parseAttachment = (att: any) => {
      // The sticker id is in mercury.sticker_attachment.id, not in the outer att.id
      const stickerId = att?.mercury?.sticker_attachment?.id;
      let id: string | number = att.fbid || att.id || stickerId || -(++_attIndex);
      let url: string | null = null;
      let attachmentType: string | undefined;
      let name: string | undefined;
      let fileSize: number | undefined;
      let mimeType: string | undefined;
      let template: FbTemplate | undefined;

      try {
        const mercury = att?.mercury || {};
        // Prefer blob_attachment (image / video / file / audio)
        const blob = mercury.blob_attachment;
        // Fallback sticker_attachment - a sticker has no blob, it is mercury.sticker_attachment
        const sticker = !blob ? mercury.sticker_attachment : null;
        const typename: string = blob?.__typename || sticker?.__typename || '';

        if (typename === 'Sticker') {
          attachmentType = 'sticker';
          url = sticker?.url || sticker?.preview_image?.uri || sticker?.image?.uri || att?.url || null;
          Logger.log(`[FBMqtt:${this.accountId}] [STICKER] parsed sticker: attId=${att.id || att.fbid} stickerId=${stickerId}`);
        } else if (typename === 'MessagePhoto' || typename === 'MessageAnimatedImage' || typename === 'MessageImage') {
          attachmentType = 'image';
          // MessageAnimatedImage (GIF) typically has animated_image.uri or original_image.uri
          // as the actual GIF URL, NOT in large_preview/preview/thumbnail (those are static previews)
          url = blob?.animated_image?.uri || blob?.original_image?.uri
             || blob?.large_preview?.uri || blob?.preview?.uri || blob?.thumbnail?.uri
             || sticker?.url || sticker?.preview_image?.uri || sticker?.image?.uri
             || att?.url || null;
        } else if (typename === 'MessageVideo') {
          attachmentType = 'video';
          // playable_url la video that, large_image/preview chi la thumbnail
          url = blob?.playable_url || blob?.browse_url || blob?.large_image?.uri || blob?.preview?.uri || null;
        } else if (typename === 'MessageAudio') {
          attachmentType = 'audio';
          url = blob?.playback_url || null;
        } else if (typename === 'MessageFile' || typename === 'MessageDocument') {
          attachmentType = 'file';
          url = blob?.url || blob?.meta?.url || null;
          name = blob?.filename || blob?.name || att?.name || undefined;
          fileSize = blob?.filesize ?? att?.fileSize ?? undefined;
          mimeType = blob?.content_type ?? att?.mimeType ?? undefined;
        } else if (typename) {
          attachmentType = 'file';
          url = blob?.url || blob?.preview?.uri || null;
          name = blob?.filename || blob?.name || undefined;
        } else if (mercury.extensible_attachment) {
          // Page / bot sample messages, shares, product cards…: before, these were not read → the `text` message was empty
          const ext = mercury.extensible_attachment;
          const parsed = templateFromStoryAttachment(ext);
          if (isFbUnavailableTemplate(parsed)) {
            // Facebook only sends the replacement card "File đính kèm không hiển thị" (Attachment not shown) over MQTT (the bridge normally receives the full copy, which writes
            // later will replace it: saveFBMessage). Writes the structure for diagnosis, not the message content.
            const story = ext?.story_attachment || {};
            Logger.log(`[FBMqtt:${this.accountId}] template placeholder: attKeys=${Object.keys(att || {}).join(',')} extKeys=${Object.keys(ext || {}).join(',')} storyKeys=${Object.keys(story).join(',')} style=${JSON.stringify(story.style_list || [])} target=${story.target?.__typename || '-'}`);
          }
          if (parsed) {
            template = parsed;
            attachmentType = 'template';
            url = parsed.url || null;
            if (typeof id === 'number' && id < 0 && ext.legacy_attachment_id) id = String(ext.legacy_attachment_id);
          }
        }
      } catch {}

      return { id, url, attachmentType, name, fileSize, mimeType, ...(template ? { template } : {}) };
    };

    // Parse ALL attachments (batch image sends have multiple)
    const allAttachments = delta.attachments?.length > 0
      ? (delta.attachments as any[]).map(parseAttachment)
      : [];

    // Extract replied-to message info from MQTT delta (Facebook sends
    // replied_to_message.messageMetadata for reply messages)
    const repliedDelta = (delta as any).replied_to_message || (delta as any).repliedToMessage;
    const repliedToMsg: string | undefined =
      repliedDelta?.messageMetadata?.messageId || undefined;
    const repliedToSender: string | undefined =
      repliedDelta?.messageMetadata?.actorFbId || undefined;

    const primaryAtt = allAttachments[0] || { id: 0, url: null };

    const msg: FBMQTTMessage = {
      body: delta.body || null,
      timestamp: meta.timestamp || String(Date.now()),
      userID: meta.actorFbId,
      messageID: meta.messageId,
      replyToID: String(replyToID),
      replyToMessageId: repliedToMsg,
      replyToSenderId: repliedToSender,
      type: threadType === 'user' ? 'user' : 'group',
      attachments: primaryAtt,
      ...(allAttachments.length > 1 ? { allAttachments } : {}),
    };

    if ('attachmentType' in primaryAtt && (primaryAtt as any).attachmentType === 'sticker') {
      Logger.log(`[FBMqtt:${this.accountId}] [STICKER] emitting message: msgId=${msg.messageID} threadId=${replyToID} userId=${msg.userID}`);
    }

    this.emit('message', msg);
  }

  /**
   * Handle Orca presence data from `/orca_presence` topic (I7)
   * Facebook sends presence as a JSON array of { userId, status, timestampMs } objects.
   * The payload is NOT a standard JSON-RPC wrapper - it's a flat JSON payload.
   */
  private handlePresence(payload: Buffer): void {
    try {
      const text = payload.toString('utf8');
      let entries: FBPresenceEntry[] = [];

      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        // Array format: [{ userId, status }, ...]
        entries = parsed.map((p: any) => ({
          userId: String(p.userId || p.uid || ''),
          status: (p.status === 'active' || p.status === 'inactive') ? p.status : 'active',
          timestampMs: parseInt(p.timestampMs || p.t || Date.now()),
        }));
      } else if (parsed?.data && Array.isArray(parsed.data)) {
        entries = parsed.data.map((p: any) => ({
          userId: String(p.userId || p.uid || ''),
          status: (p.status === 'active' || p.status === 'inactive') ? p.status : 'active',
          timestampMs: parseInt(p.timestampMs || p.t || Date.now()),
        }));
      } else if (parsed?.list && Array.isArray(parsed.list)) {
        entries = parsed.list.map((p: any) => ({
          userId: String(p.userId || p.uid || ''),
          status: (p.status === 'active' || p.status === 'inactive') ? p.status : 'active',
          timestampMs: parseInt(p.timestampMs || p.t || Date.now()),
        }));
      } else if (parsed?.userId) {
        // Single entry
        entries = [{
          userId: String(parsed.userId),
          status: (parsed.status === 'active' || parsed.status === 'inactive') ? parsed.status : 'active',
          timestampMs: parseInt(parsed.timestampMs || parsed.t || Date.now()),
        }];
      }

      if (entries.length > 0) {
        Logger.log(`[FBMqtt:${this.accountId}] Presence: ${entries.length} entries`);
        this.emit('presence', { entries });
      }
    } catch {
      // Non-JSON payload - ignore
    }
  }

  /**
   * Handle thread typing indicator from `/thread_typing` topic
   * Payload format: {"sender_fbid":100004209480093,"state":1,"type":"typ","thread":"2181504075928906"}
   * state=1 → typing started, state=0 → typing stopped
   */
  private handleThreadTyping(payload: Buffer): void {
    try {
      const text = payload.toString('utf8');
      const data = JSON.parse(text);
      if (data?.sender_fbid && data?.thread) {
        this.emit('typing', {
          threadId: String(data.thread),
          userId: String(data.sender_fbid),
          state: data.state === 1 ? 1 : 0,
        });
      }
    } catch {
      // Invalid JSON - ignore
    }
  }

  private scheduleReconnect(fullReset: boolean = false): void {
    if (!this.shouldReconnect) return;

    // ── BUG #1 fix: guard against double-scheduling from the offline + close cascade ──
    if (this._reconnectPending) {
      Logger.log(`[FBMqtt:${this.accountId}] Reconnect already pending - skipping duplicate`);
      return;
    }
    this._reconnectPending = true;

    // ── Check max retries ──────────────────────────────────────────
    // BUG #4 fix: do not stop completely after MAX_RECONNECT_ATTEMPTS any more.
    // Instead, switch to phase 3: retry every 5 minutes indefinitely.
    // Only stop for real when the cookie has expired or the user disconnects on purpose.
    if (this.retryCount >= this.MAX_RECONNECT_ATTEMPTS && this.retryCount < this.PHASE3_THRESHOLD) {
      Logger.warn(`[FBMqtt:${this.accountId}] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached - entering slow retry phase...`);
    }

    // ── Test connection health before each retry ────────────────────
    // If there is a health check function, check whether the cookie is still alive.
    // Cookie dead → no need to retry any more, emit cookie_expired at once.
    if (this._healthCheckFn && this.retryCount > 0) {
      this._healthCheckFn().then(alive => {
        if (!alive) {
          Logger.warn(`[FBMqtt:${this.accountId}] Pre-retry health check failed - cookie expired`);
          this.clearHealthCheck();
          this.shouldReconnect = false;
          this._reconnectPending = false;
          this.emit('connectionStatus', 'cookie_expired' as FBConnectionStatus);
        }
      }).catch(() => {});
    }

    // ─── Three-phase reconnect backoff ──────────────────────────────────
    // Phase 1 (attempts 0..PHASE2_THRESHOLD): exponential 3s→4.5s→...→60s
    // Phase 2 (attempts > PHASE2_THRESHOLD, ≤ PHASE3_THRESHOLD): steady 60s
    // Phase 3 (attempts > PHASE3_THRESHOLD): steady 5min indefinitely (BUG #4 fix)
    //   → Never stops completely, unless the cookie has expired or the user disconnects.

    // Moving from Phase 1 → Phase 2: start the health check timer
    if (this.retryCount === this.PHASE2_THRESHOLD && !this.healthCheckTimer && this._healthCheckFn) {
      Logger.log(`[FBMqtt:${this.accountId}] Entering phase 2 - starting health check every 5min`);
      this.healthCheckTimer = setInterval(async () => {
        if (!this.shouldReconnect) {
          this.clearHealthCheck();
          return;
        }
        try {
          const alive = await this._healthCheckFn!();
          if (!alive) {
            Logger.warn(`[FBMqtt:${this.accountId}] Health check failed - cookie expired, stopping retry`);
            this.clearHealthCheck();
            this.shouldReconnect = false;
            this._reconnectPending = false;
            this.emit('connectionStatus', 'cookie_expired' as FBConnectionStatus);
          }
        } catch {
          // Health check error - keep retrying anyway
        }
      }, 5 * 60 * 1000); // every 5 minutes
    }

    const delay = fullReset ? 30000 : this.reconnectDelay;

    if (this.retryCount < this.PHASE2_THRESHOLD) {
      // Phase 1: exponential backoff 3s → 60s
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 60000);
    } else if (this.retryCount < this.PHASE3_THRESHOLD) {
      // Phase 2: steady 60 s (no longer increasing)
      this.reconnectDelay = 60000;
    } else {
      // Phase 3: steady 5 minutes indefinitely (BUG #4 fix)
      this.reconnectDelay = 5 * 60 * 1000;
    }
    this.retryCount += 1;
    this.totalRetryCount += 1;

    Logger.log(`[FBMqtt:${this.accountId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.retryCount}, total ${this.totalRetryCount})`);

    this.reconnectTimer = setTimeout(() => {
      this._reconnectPending = false; // Reset guard before connecting
      if (this.shouldReconnect) {
        if (fullReset) {
          this.syncToken = null;
        }
        this.connect();
      }
    }, delay);
  }

  /**
   * Disconnects the MQTT connection
   */
  public disconnect(): void {
    this.shouldReconnect = false;
    this._reconnectPending = false; // Reset guard (BUG #1 fix)
    this.clearHealthCheck();
    this.clearConnectTimeout();
    this.stopPingPong(); // Clean up ping timer (BUG #2 fix)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        this.client.removeAllListeners();
        this.client.end(true);
      } catch {}
      this.client = null;
    }
    this.isConnecting = false;
    Logger.log(`[FBMqtt:${this.accountId}] Disconnected`);
  }

  /**
   * Checks whether it is currently connected
   */
  public isConnected(): boolean {
    return !!(this.client && this.client.connected);
  }

  /**
   * Attaches the cookie health check function (provided by FacebookService).
   * While the listener is in Phase 2 (a long retry run), it calls this function periodically
   * to detect an expired cookie → emits 'cookie_expired' and stops retrying.
   */
  public setHealthCheckFn(fn: () => Promise<boolean>): void {
    this._healthCheckFn = fn;
  }

  /**
   * Resets the reconnect state (on a manual reconnect by the user or a successful connect).
   * Goes back to phase 1 (fast backoff) so the next disconnect gets a quick response.
   */
  public resetRetryCount(): void {
    this.retryCount = 0;
    this.reconnectDelay = 3000;
    this.shouldReconnect = true;
    this._reconnectPending = false; // Reset guard (BUG #1 fix)
    this.overflowRetryCount = 0;
    this.clearHealthCheck();
  }

  /**
   * Cancels the health check timer when the listener fully disconnects
   */
  private clearHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Cancels the connect timeout guard
   */
  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  // ─── Ping/Pong Health Tracking (BUG #2 fix) ──────────────────────────────

  /**
   * Starts sending a periodic ping to check that the MQTT connection is still alive.
   * The MQTT protocol supports PINGREQ/PINGRESP - mqtt.js handles it internally,
   * but we track the time of the last pong to detect a silent disconnect.
   */
  private startPingPong(): void {
    this.stopPingPong();
    this.lastPongTime = Date.now();

    // Track incoming packets to detect pong responses
    if (this.client) {
      this.client.on('packetreceive', this._onPacketReceive);
    }

    // Send an application-level ping every 30 s through an MQTT publish (dummy message)
    // The Facebook MQTT server will respond, or at least keep the connection alive
    this.pingTimer = setInterval(() => {
      if (!this.client?.connected) {
        Logger.warn(`[FBMqtt:${this.accountId}] Ping check: client not connected`);
        this.handlePingTimeout();
        return;
      }

      // Check the time since the last pong
      const timeSinceLastPong = Date.now() - this.lastPongTime;
      if (timeSinceLastPong > 120000) {
        // 2 minutes without any packet → the connection may be dead
        Logger.warn(`[FBMqtt:${this.accountId}] No MQTT activity for ${Math.round(timeSinceLastPong / 1000)}s - connection may be dead`);
        this.handlePingTimeout();
      }
    }, 30000); // Check every 30 s
  }

  private _onPacketReceive = (_packet: any) => {
    // Any packet from the server also updates lastPongTime
    this.lastPongTime = Date.now();
  };

  private handlePingTimeout(): void {
    this.stopPingPong();
    // Force disconnect and reconnect to recover the connection
    if (this.client) {
      try {
        this.client.removeAllListeners();
        this.client.end(true);
      } catch {}
      this.client = null;
    }
    this.isConnecting = false;
    this.emit('connectionStatus', 'disconnected' as FBConnectionStatus);
    this.scheduleReconnect();
  }

  private stopPingPong(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.client) {
      this.client.off('packetreceive', this._onPacketReceive);
    }
  }

  /**
   * Checks whether the MQTT connection is really still alive.
   * Different from isConnected(): this method checks both:
   * 1. client.connected (MQTT level)
   * 2. the time since the last packet (application level)
   * Returns true if the connection is really healthy.
   */
  public isActuallyConnected(): boolean {
    if (!this.client?.connected) return false;
    // No packet for 2 minutes → treat it as dead
    const timeSinceLastPong = Date.now() - this.lastPongTime;
    if (this.lastPongTime > 0 && timeSinceLastPong > 120000) return false;
    return true;
  }
}

