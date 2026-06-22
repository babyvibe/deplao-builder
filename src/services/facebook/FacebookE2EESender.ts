/**
 * FacebookE2EESender.ts
 * Port từ Python `api` class trong _send_e2ee.py
 *
 * Gửi tin nhắn E2EE mã hóa cho hội thoại 1:1 qua Go bridge.
 * Hỗ trợ standalone mode (tự tạo bridge) hoặc reuse mode (dùng chung bridge với listener).
 */

import { FacebookE2EEBridge, BridgeError, BridgeNotReadyError } from './FacebookE2EEBridge';
import {
  normalizeChatJid,
  chatJidFromUserId,
  parseE2EECookies,
  resolveE2EEBinaryPath,
} from './FacebookUtils';
import { FBE2EESendResult } from './FacebookTypes';
import Logger from '../../utils/Logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type E2EESenderMode = 'standalone' | 'reuse';

export interface E2EESenderOptions {
  /** Reuse bridge từ listener (recommended) hoặc tự tạo standalone */
  mode?: E2EESenderMode;
  /** Bridge instance (required for reuse mode) */
  bridge?: FacebookE2EEBridge;
  /** Facebook cookie string (required for standalone mode) */
  cookie?: string;
  /** Log level for bridge (default: 'none') */
  logLevel?: string;
  /** E2EE session memory-only (default: true) */
  e2eeMemoryOnly?: boolean;
  /** Custom binary path override */
  binaryPath?: string;
}

// ─── Main Class ───────────────────────────────────────────────────────────────

export class FacebookE2EESender {
  private bridge: FacebookE2EEBridge | null = null;
  private ownsBridge: boolean = false;
  private connected: boolean = false;

  /** Cached bridge reference (reuse mode) */
  private sharedBridge: FacebookE2EEBridge | null = null;

  constructor(private opts: E2EESenderOptions = {}) {
    if (opts.mode === 'reuse' && opts.bridge) {
      this.sharedBridge = opts.bridge;
    }
  }

  // ─── Bridge access ───────────────────────────────────────────────────────

  private getBridge(): FacebookE2EEBridge {
    if (this.sharedBridge) return this.sharedBridge;
    if (this.bridge && this.bridge.isAlive()) return this.bridge;
    throw new BridgeNotReadyError();
  }

  // ─── Connect (standalone mode) ──────────────────────────────────────────

  /**
   * Standalone connect: spawn bridge → newClient → connect → connectE2EE
   */
  public async connect(enableE2EE: boolean = true): Promise<{ user?: { id: string } }> {
    if (this.sharedBridge) {
      throw new Error('connect() chỉ dùng cho standalone mode. Reuse mode dùng chung bridge listener.');
    }
    if (this.connected) {
      return { user: { id: 'already' } };
    }
    if (!this.opts.cookie) {
      throw new Error('Cookie is required for standalone E2EE sender.');
    }

    const binaryPath = this.opts.binaryPath || resolveE2EEBinaryPath();
    this.bridge = FacebookE2EEBridge.create(binaryPath);
    this.bridge.spawn();
    this.ownsBridge = true;

    try {
      const cookies = parseE2EECookies(this.opts.cookie);
      await this.bridge.newClient({
        cookies,
        platform: 'facebook',
        logLevel: this.opts.logLevel || 'none',
        e2eeMemoryOnly: this.opts.e2eeMemoryOnly ?? true,
      });

      const info = await this.bridge.connect(120000);

      if (enableE2EE) {
        await this.bridge.connectE2EE(60000);
      }

      this.connected = true;
      Logger.log(`[FBE2EESender] Ready (user=${(info as any)?.user?.id ?? '?'})`);
      return info as any;
    } catch (err: any) {
      Logger.warn(`[FBE2EESender] Connect failed: ${err.message}`);
      if (this.bridge) {
        try { await this.bridge.close(); } catch {}
        this.bridge = null;
      }
      throw err;
    }
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  /**
   * Gửi tin nhắn E2EE
   *
   * @param chatJid  JID đầy đủ (`{userId}@msgr`) hoặc Facebook user ID
   * @param text     Nội dung tin nhắn
   * @param replyMessageId    (optional) message ID để reply
   * @param replySenderJid    (optional) sender JID của message được reply
   */
  public async send(
    chatJid: string | number,
    text: string,
    replyMessageId: string = '',
    replySenderJid: string | number = '',
  ): Promise<{
    success: boolean;
    messageId?: string;
    timestamp?: number;
    error?: string;
  }> {
    try {
      const normalizedJid = normalizeChatJid(chatJid);
      const normalizedReplySenderJid = replySenderJid
        ? normalizeChatJid(replySenderJid)
        : '';

      const bridge = this.getBridge();
      const result: FBE2EESendResult = await bridge.sendE2EEMessage({
        chatJid: normalizedJid,
        text,
        replyToId: replyMessageId || '',
        replyToSenderJid: normalizedReplySenderJid,
      });

      return {
        success: true,
        messageId: result.messageId,
        timestamp: result.timestampMs || Date.now(),
      };
    } catch (err: any) {
      if (err instanceof BridgeError || err instanceof BridgeNotReadyError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err.message || 'Unknown E2EE send error' };
    }
  }

  /**
   * Gửi E2EE message đến user (convenience — tự động build JID)
   */
  public async sendToUser(
    userId: string | number,
    text: string,
    replyMessageId: string = '',
    replySenderJid: string | number = '',
  ): Promise<{
    success: boolean;
    messageId?: string;
    timestamp?: number;
    error?: string;
  }> {
    return this.send(
      chatJidFromUserId(userId),
      text,
      replyMessageId,
      replySenderJid,
    );
  }

  /**
   * Reply to an E2EE event (convenience — extracts chatJid, messageId, senderJid)
   */
  public async reply(
    eventData: { chatJid?: string; id?: string; messageId?: string; senderJid?: string },
    text: string,
  ): Promise<{
    success: boolean;
    messageId?: string;
    timestamp?: number;
    error?: string;
  }> {
    return this.send(
      eventData.chatJid || '',
      text,
      eventData.id || eventData.messageId || '',
      eventData.senderJid || '',
    );
  }

  /**
   * Gửi reaction cho tin nhắn E2EE 1:1
   */
  public async sendReaction(
    chatJid: string | number,
    messageId: string,
    senderJid: string | number,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const bridge = this.getBridge();
      await bridge.sendE2EEReaction({
        chatJid: normalizeChatJid(chatJid),
        messageId,
        senderJid: senderJid ? normalizeChatJid(senderJid) : '',
        emoji,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'E2EE reaction error' };
    }
  }

  /**
   * Gửi ảnh qua E2EE 1:1
   */
  public async sendImage(
    chatJid: string | number,
    imagePath: string,
    caption?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    try {
      const bridge = this.getBridge();
      const result = await bridge.sendE2EEImage({
        chatJid: normalizeChatJid(chatJid),
        imagePath,
        caption,
      });
      return { success: true, messageId: result.messageId, timestamp: result.timestampMs };
    } catch (err: any) {
      return { success: false, error: err.message || 'E2EE image send error' };
    }
  }

  /**
   * Gửi video qua E2EE 1:1
   */
  public async sendVideo(
    chatJid: string | number,
    videoPath: string,
    caption?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    try {
      const bridge = this.getBridge();
      const result = await bridge.sendE2EEVideo({
        chatJid: normalizeChatJid(chatJid),
        videoPath,
        caption,
      });
      return { success: true, messageId: result.messageId, timestamp: result.timestampMs };
    } catch (err: any) {
      return { success: false, error: err.message || 'E2EE video send error' };
    }
  }

  /**
   * Gửi audio qua E2EE 1:1
   */
  public async sendAudio(
    chatJid: string | number,
    audioPath: string,
    mimeType?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    try {
      const bridge = this.getBridge();
      const result = await bridge.sendE2EEAudio({
        chatJid: normalizeChatJid(chatJid),
        audioPath,
        mimeType,
      });
      return { success: true, messageId: result.messageId, timestamp: result.timestampMs };
    } catch (err: any) {
      return { success: false, error: err.message || 'E2EE audio send error' };
    }
  }

  /**
   * Gửi file/tài liệu qua E2EE 1:1
   */
  public async sendFile(
    chatJid: string | number,
    filePath: string,
    fileName?: string,
  ): Promise<{ success: boolean; messageId?: string; timestamp?: number; error?: string }> {
    try {
      const bridge = this.getBridge();
      const result = await bridge.sendE2EEDocument({
        chatJid: normalizeChatJid(chatJid),
        filePath,
        fileName,
      });
      return { success: true, messageId: result.messageId, timestamp: result.timestampMs };
    } catch (err: any) {
      return { success: false, error: err.message || 'E2EE file send error' };
    }
  }

  /**
   * Gửi sticker qua E2EE 1:1 (C4)
   */
  public async sendSticker(
    chatJid: string | number,
    stickerId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const bridge = this.getBridge();
      await bridge.sendE2EESticker({
        chatJid: normalizeChatJid(chatJid),
        stickerId,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'E2EE sticker send error' };
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  public async close(): Promise<void> {
    if (this.ownsBridge && this.bridge) {
      await this.bridge.close();
      this.bridge = null;
      this.connected = false;
    }
  }

  public isConnected(): boolean {
    if (this.sharedBridge) return this.sharedBridge.isAlive();
    return this.connected && this.bridge?.isAlive() === true;
  }
}

export default FacebookE2EESender;
