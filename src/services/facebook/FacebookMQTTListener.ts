/**
 * FacebookMQTTListener.ts
 * Port từ Python _messaging/_listening.py
 * Lắng nghe tin nhắn realtime qua MQTT over WebSocket
 */

import mqtt, { MqttClient } from 'mqtt';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { FBSessionData, FBMQTTMessage, FBConnectionStatus } from './FacebookTypes';
import {
  generateSessionId, generateClientId
} from './FacebookUtils';
import Logger from '../../utils/Logger';

const FB_MQTT_ENDPOINT = 'wss://edge-chat.facebook.com/chat';
const FB_TOPICS = ['/t_ms', '/thread_typing', '/orca_typing_notifications', '/orca_presence'];

export interface FBListenerEvents {
  message: (msg: FBMQTTMessage) => void;
  connectionStatus: (status: FBConnectionStatus) => void;
  error: (err: Error) => void;
}

export class FacebookMQTTListener extends EventEmitter {
  private dataFB: FBSessionData;
  private accountId: string;
  private client: MqttClient | null = null;
  private syncToken: string | null = null;
  private lastSeqId: string = '0';
  private retryCount: number = 0;
  private maxRetries: number = 8;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;
  private reconnectDelay: number = 3000;
  private overflowRetryCount: number = 0;

  constructor(dataFB: FBSessionData, accountId: string, initialSeqId: string = '0') {
    super();
    this.dataFB = dataFB;
    this.accountId = accountId;
    this.lastSeqId = initialSeqId;
  }

  /**
   * Cập nhật session data (sau khi refresh cookie)
   */
  public updateSession(dataFB: FBSessionData): void {
    this.dataFB = dataFB;
  }

  /**
   * Kết nối MQTT WebSocket
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

    const sessionId = generateSessionId();
    const clientId = generateClientId();

    // Facebook MQTT username payload — giống paho-mqtt Python
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
        reconnectPeriod: 0,          // Tự quản lý reconnect

        // ─── Auth ──────────────────────────────────────────────────────
        username: JSON.stringify(userPayload),
        // Không set password — Facebook không cần

        // ─── Custom WebSocket creation ─────────────────────────────────
        // Facebook's MQTT WS endpoint does NOT return Sec-WebSocket-Protocol.
        // mqtt.js v5 requests 'mqttv3.1' subprotocol by default → ws module
        // rejects with "Server sent no subprotocol". Fix: skip protocols.
        createWebsocket: (url: string, _protocols: string[], _opts: any) => {
          return new WebSocket(url, {
            headers: wsHeaders,
            rejectUnauthorized: true,
          }) as any;
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
      this.retryCount = 0;
      this.reconnectDelay = 3000;
      this.overflowRetryCount = 0;
      this.emit('connectionStatus', 'connected' as FBConnectionStatus);

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
        const text = payload.toString('utf8');
        Logger.log(`[FBMqtt:${this.accountId}] msg on ${topic}: ${text.slice(0, 200)}`);
        const j = JSON.parse(text);
        this.handleMQTTMessage(j);
      } catch {
        // Binary/non-JSON payload — ignore
      }
    });

    this.client.on('error', (err: Error) => {
      // Facebook's MQTT server sends non-standard puback flags — ignore parse errors
      if (err.message?.includes('header flag bits')) {
        Logger.log(`[FBMqtt:${this.accountId}] Ignoring non-standard packet header: ${err.message}`);
        return;
      }
      Logger.warn(`[FBMqtt:${this.accountId}] error event: ${err.message}`);
      this.isConnecting = false;
      this.emit('error', err);
    });

    this.client.on('disconnect', (packet: any) => {
      Logger.warn(`[FBMqtt:${this.accountId}] disconnect packet: ${JSON.stringify(packet)}`);
    });

    this.client.on('close', () => {
      Logger.log(`[FBMqtt:${this.accountId}] MQTT closed`);
      this.isConnecting = false;
      this.emit('connectionStatus', 'disconnected' as FBConnectionStatus);
      this.scheduleReconnect();
    });

    this.client.on('offline', () => {
      Logger.log(`[FBMqtt:${this.accountId}] MQTT offline`);
      this.emit('connectionStatus', 'disconnected' as FBConnectionStatus);
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
      max_deltas_able_to_process: 1000,
      delta_batch_size: 500,
      encoding: 'JSON',
      entity_fbid: this.dataFB.FacebookID,
      orca_version: '1.2.0',
    };

    let topic: string;
    if (!this.syncToken) {
      topic = '/messenger_sync_create_queue';
      queue.initial_titan_sequence_id = this.lastSeqId;
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
      Logger.log(`[FBMqtt:${this.accountId}] Got syncToken, seqId=${this.lastSeqId} — listening for deltas`);
      return;
    }

    // Update last seq ID
    if (j.lastIssuedSeqId) {
      this.lastSeqId = String(j.lastIssuedSeqId);
    }

    // Error codes
    if (j.errorCode) {
      const code = j.errorCode;
      Logger.warn(`[FBMqtt:${this.accountId}] MQTT errorCode: ${code}`);

      if (code === 'ERROR_QUEUE_OVERFLOW') {
        // Queue overflow = server-side queue is full. Must disconnect, fetch latest seqId
        // via GraphQL, then reconnect with that seqId so Facebook only syncs recent messages.
        Logger.warn(`[FBMqtt:${this.accountId}] ERROR_QUEUE_OVERFLOW — fetching latest seqId then reconnect`);
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
          Logger.error(`[FBMqtt:${this.accountId}] ERROR_QUEUE_OVERFLOW persists after ${this.overflowRetryCount} full reconnects — giving up. User must reconnect manually.`);
          this.overflowRetryCount = 0;
          this.emit('connectionStatus', 'error' as FBConnectionStatus);
          return;
        }
        // Fetch latest seqId before reconnecting — this is the key fix!
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
        // Queue not found — reset sync token and re-create on same connection
        Logger.log(`[FBMqtt:${this.accountId}] Queue error (${code}), resetting syncToken and re-creating queue...`);
        this.syncToken = null;
        // Don't reset lastSeqId to '0' — keep current value to avoid overflow
        this.retryCount += 1;
        if (this.retryCount < this.maxRetries) {
          setTimeout(() => this.publishQueue(), 1000);
        } else {
          Logger.warn(`[FBMqtt:${this.accountId}] Too many queue errors, full reconnect...`);
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
    if (!delta?.messageMetadata) return;

    const meta = delta.messageMetadata;
    const threadKey = meta.threadKey || {};
    const replyToID = threadKey.otherUserFbId || threadKey.threadFbId || '0';
    const type = threadKey.otherUserFbId ? 'user' : 'thread';

    const parseAttachment = (att: any) => {
      let id: string | number = att.fbid || att.id || 0;
      let url: string | null = null;
      let attachmentType: string | undefined;
      let name: string | undefined;
      let fileSize: number | undefined;
      let mimeType: string | undefined;

      try {
        const blob = att?.mercury?.blob_attachment;
        const typename: string = blob?.__typename || '';
        if (typename === 'MessagePhoto' || typename === 'MessageAnimatedImage' || typename === 'MessageImage') {
          attachmentType = 'image';
          url = blob?.large_preview?.uri || blob?.preview?.uri || blob?.thumbnail?.uri || null;
        } else if (typename === 'MessageVideo') {
          attachmentType = 'video';
          url = blob?.large_image?.uri || blob?.preview?.uri || null;
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
        }
      } catch {}

      return { id, url, attachmentType, name, fileSize, mimeType };
    };

    // Parse ALL attachments (batch image sends have multiple)
    const allAttachments = delta.attachments?.length > 0
      ? (delta.attachments as any[]).map(parseAttachment)
      : [];

    const primaryAtt = allAttachments[0] || { id: 0, url: null };

    const msg: FBMQTTMessage = {
      body: delta.body || null,
      timestamp: meta.timestamp || String(Date.now()),
      userID: meta.actorFbId,
      messageID: meta.messageId,
      replyToID: String(replyToID),
      type: type === 'user' ? 'user' : 'group',
      attachments: primaryAtt,
      ...(allAttachments.length > 1 ? { allAttachments } : {}),
    };

    this.emit('message', msg);
  }

  private scheduleReconnect(fullReset: boolean = false): void {
    if (!this.shouldReconnect) return;
    if (this.retryCount >= this.maxRetries) {
      Logger.warn(`[FBMqtt:${this.accountId}] Max retries (${this.maxRetries}) reached — FB may have detected bot/session expired`);
      this.shouldReconnect = false;
      // Emit cookie_expired so UI notifies user to re-login
      this.emit('connectionStatus', 'cookie_expired' as FBConnectionStatus);
      return;
    }

    const delay = fullReset ? 30000 : this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 60000); // Gentler backoff
    this.retryCount += 1;

    Logger.log(`[FBMqtt:${this.accountId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.retryCount}/${this.maxRetries})`);

    this.reconnectTimer = setTimeout(() => {
      if (this.shouldReconnect) {
        if (fullReset) {
          this.syncToken = null;
        }
        this.connect();
      }
    }, delay);
  }

  /**
   * Ngắt kết nối MQTT
   */
  public disconnect(): void {
    this.shouldReconnect = false;
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
   * Kiểm tra có đang kết nối không
   */
  public isConnected(): boolean {
    return !!(this.client && this.client.connected);
  }

  /**
   * Reset reconnect counter (khi user manually reconnect)
   */
  public resetRetryCount(): void {
    this.retryCount = 0;
    this.reconnectDelay = 5000;
  }
}

