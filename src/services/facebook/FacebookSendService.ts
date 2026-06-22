/**
 * FacebookSendService.ts
 * Shared service gửi tin nhắn Facebook — dùng chung cho IPC handler VÀ workflow engine.
 *
 * Mục đích: tránh lặp logic giữa electron/ipc/facebookIpc.ts và WorkflowEngineService.ts.
 * Tất cả thao tác gửi + lưu DB + emit UI đều qua service này.
 */

import { FacebookService } from './FacebookService';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FBSendCommonParams {
  /** Raw account ID (có thể là numeric FB UID hoặc internal UUID) */
  accountId: string;
  /** Thread/conversation ID */
  threadId: string;
  /** 'user' = 1:1, 'group' = group, undefined = auto-detect */
  typeChat?: 'user' | null;
  /** ID của tin nhắn đang reply (nếu có) */
  replyToMessageId?: string;
}

export interface FBSendTextParams extends FBSendCommonParams {
  body: string;
}

export interface FBSendResult {
  success: boolean;
  messageId?: string;
  timestamp?: number;
  error?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class FacebookSendService {

  /**
   * Resolve account ID: numeric FB UID → internal UUID.
   * UUID (có dấu gạch ngang) giữ nguyên.
   */
  static resolveAccountId(rawId: string): string {
    if (!rawId) return '';
    if (rawId.includes('-')) return rawId;
    if (/^\d+$/.test(rawId)) {
      try {
        const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(rawId);
        if (fbAcc?.id) return fbAcc.id;
      } catch {}
    }
    return rawId;
  }

  /**
   * Lấy FacebookService instance đã được resolve account ID.
   * Tự động resolve numeric → UUID trước khi lookup.
   */
  static async getService(accountId: string): Promise<FacebookService> {
    const resolved = FacebookSendService.resolveAccountId(accountId);
    return FacebookService.getInstance(resolved);
  }

  /**
   * Auto-detect 1:1 user chat từ threadId format.
   * Facebook user ID là all digits, group ID chứa dấu '_'.
   */
  static isUserThread(threadId: string): boolean {
    return /^\d+$/.test(String(threadId));
  }

  // ─── Send text message ──────────────────────────────────────────────────

  /**
   * Gửi tin nhắn text + tự động save DB + emit UI.
   * Dùng chung cho cả IPC handler và workflow engine.
   *
   * Lưu ý routing:
   * - 1:1 E2EE: FacebookService.sendMessage() tự động route qua bridge nếu thread
   *   nằm trong danh sách e2eeThreads.
   * - Group: bridge MQTT route, fallback REST.
   * - KHÔNG auto-detect user/group từ thread ID format vì cả user và group Facebook
   *   đều dùng numeric ID, không phân biệt được bằng regex.
   */
  static async sendTextMessage(params: FBSendTextParams): Promise<FBSendResult> {
    const accountId = FacebookSendService.resolveAccountId(params.accountId);
    const service = await FacebookSendService.getService(accountId);
    const threadId = String(params.threadId);
    const body = String(params.body || '');

    // ── Delegate to FacebookService.sendMessage() ──────────────────────────
    // FacebookService.sendMessage() đã có routing đúng:
    //   - 1:1 E2EE → bridge E2EE (dựa trên e2eeThreads tracking)
    //   - Group → bridge MQTT (fallback REST)
    // KHÔNG tự route ở đây vì isUserThread() không phân biệt được user vs group.
    const isUserMessage = params.typeChat === 'user';
    const SEND_TIMEOUT_MS = 30000; // 30s — enough for bridge E2EE + REST fallback
    let result: any;
    try {
      result = await Promise.race([
        service.sendMessage(threadId, body, {
          typeChat: params.typeChat ?? undefined,
          replyToMessageId: params.replyToMessageId,
        } as any),
        new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error(`Gửi tin nhắn timeout sau ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS)
        ),
      ]);
    } catch (err: any) {
      return { success: false, error: err.message };
    }

    // ── Save DB + emit UI ──
    if (result?.success && result?.messageId) {
      // Safety: mark as locally sent để ngăn self-echo duplicate
      // (sendMessage đã gọi markMessageLocallySent internally, đây là double-safety)
      service.markMessageLocallySent(result.messageId);
      await FacebookSendService.persistSentMessage({
        accountId,
        threadId,
        messageId: result.messageId,
        body,
        fbSenderId: service.getRealFacebookId() || accountId,
        timestamp: result.timestamp || Date.now(),
        type: 'text',
        isUserMessage,
        replyToMessageId: params.replyToMessageId,
      });
    }

    return {
      success: result?.success === true,
      messageId: result?.messageId,
      ...(result?.error ? { error: result.error } : {}),
    };
  }

  // ─── Persist sent message to DB + emit UI event ─────────────────────────

  /**
   * Lưu tin nhắn đã gửi vào DB và broadcast cho UI.
   * Dùng chung cho tất cả loại tin nhắn (text, image, video, file, audio).
   */
  static async persistSentMessage(params: {
    accountId: string;       // internal UUID
    threadId: string;
    messageId: string;
    body?: string | null;
    fbSenderId: string;      // real Facebook UID
    timestamp: number;
    type: string;            // 'text' | 'image' | 'video' | 'file' | 'audio'
    isUserMessage: boolean;
    replyToMessageId?: string;
    attachments?: string;    // JSON string
    localPath?: string;      // relative path to local file
  }): Promise<void> {
    const db = DatabaseService.getInstance();
    const {
      accountId, threadId, messageId, body, fbSenderId,
      timestamp, type, isUserMessage, replyToMessageId,
      attachments, localPath,
    } = params;

    // Resolve quote_data nếu là reply
    let broadcastQuoteData: string | undefined;
    if (replyToMessageId) {
      try {
        const origRow = db.queryOne<any>(
          `SELECT body, type FROM fb_messages WHERE id = ? AND account_id = ?`,
          [replyToMessageId, accountId]
        );
        if (origRow) {
          broadcastQuoteData = JSON.stringify({
            msgId: replyToMessageId,
            msg: origRow.body || '',
            senderId: '',
            msgType: origRow.type || 'text',
          });
        } else {
          const origRow2 = db.queryOne<any>(
            `SELECT content, msg_type FROM messages WHERE msg_id = ?`,
            [replyToMessageId]
          );
          if (origRow2) {
            broadcastQuoteData = JSON.stringify({
              msgId: replyToMessageId,
              msg: origRow2.content || '',
              senderId: '',
              msgType: origRow2.msg_type || 'text',
            });
          }
        }
      } catch {}
    }

    // Save to fb_messages table
    try {
      db.saveFBMessage({
        id: messageId,
        account_id: accountId,
        thread_id: threadId,
        sender_id: fbSenderId,
        body: body || null,
        timestamp,
        type,
        attachments: attachments || '[]',
        is_self: 1,
        is_unsent: 0,
        ...(replyToMessageId ? { reply_to_id: replyToMessageId } : {}),
      });
      Logger.info(`[FacebookSendService] Saved to DB: msgId=${messageId} type=${type} thread=${threadId}`);
    } catch (dbErr: any) {
      Logger.warn(`[FacebookSendService] DB save error: ${dbErr.message}`);
    }

    // Update local_paths nếu có file local
    if (localPath) {
      try {
        db.updateLocalPaths(fbSenderId, messageId, { main: localPath });
      } catch {}
    }

    // Emit UI event
    try {
      const attachPayload = attachments
        ? (() => { try { const parsed = JSON.parse(attachments); return parsed[0] || null; } catch { return null; } })()
        : null;

      EventBroadcaster.emit('fb:onMessage', {
        fbAccountId: fbSenderId,
        message: {
          messageID: messageId,
          replyToID: threadId,
          body: type === 'text' ? body : null,
          userID: fbSenderId,
          timestamp: String(timestamp),
          type: isUserMessage ? 'user' : 'group',
          ...(attachPayload ? {
            attachments: {
              id: 1,
              url: null,
              attachmentType: attachPayload.type || type,
              name: attachPayload.name || '',
              ...(attachPayload.localPath || localPath ? { localPath: attachPayload.localPath || localPath } : {}),
            },
          } : {}),
          isSelf: true,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(broadcastQuoteData ? { quote_data: broadcastQuoteData } : {}),
        },
      });

      // Emit localPath riêng cho media
      if (localPath) {
        EventBroadcaster.emit('event:localPath', {
          zaloId: fbSenderId,
          msgId: messageId,
          threadId,
          localPaths: { main: localPath },
        });
      }
    } catch (emitErr: any) {
      Logger.warn(`[FacebookSendService] Emit error: ${emitErr.message}`);
    }
  }
}

export default FacebookSendService;
