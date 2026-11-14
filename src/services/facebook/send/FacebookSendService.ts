/**
 * FacebookSendService.ts
 * Shared Facebook message-sending service, used by both the IPC handler AND the workflow engine.
 *
 * Purpose: avoid duplicating logic between electron/ipc/facebook/facebookIpc.ts and WorkflowEngineService.ts.
 * All sending + DB saving + UI emitting goes through this service.
 */

import { FacebookService } from '../FacebookService';
import { resolveThreadKind } from '../FacebookThreadKind';
import { normalizeChatJid } from '../FacebookUtils';
import DatabaseService from '../../database/DatabaseService';
import EventBroadcaster from '../../event/EventBroadcaster';
import FileStorageService from '../../file/FileStorageService';
import Logger from '../../../utils/Logger';
import { tr } from '../../../shared/i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FBSendCommonParams {
  /** Raw account ID (either a numeric FB UID or an internal UUID) */
  accountId: string;
  /** Thread/conversation ID */
  threadId: string;
  /** 'user' = 1:1, 'group' = group, undefined = auto-detect */
  typeChat?: 'user' | null;
  /** ID of the message being replied to (if any) */
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

type FBAttachmentKind = 'image' | 'video' | 'audio' | 'file';
const ATTACHMENT_KINDS: readonly FBAttachmentKind[] = ['image', 'video', 'audio', 'file'];

// ─── Service ──────────────────────────────────────────────────────────────────

export class FacebookSendService {

  /**
   * Resolve the account ID: numeric FB UID → internal UUID.
   * A UUID (containing hyphens) is kept as is.
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
   * Get the FacebookService instance for an account ID that has been resolved.
   * Automatically resolves numeric → UUID before the lookup.
   */
  static async getService(accountId: string): Promise<FacebookService> {
    const resolved = FacebookSendService.resolveAccountId(accountId);
    return FacebookService.getInstance(resolved);
  }

  /**
   * Auto-detect a 1:1 user chat from the threadId format.
   * A Facebook user ID is all digits; a group ID contains '_'.
   */
  static isUserThread(threadId: string): boolean {
    return /^\d+$/.test(String(threadId));
  }

  // ─── Send text message ──────────────────────────────────────────────────

  /**
   * Send a text message + automatically save to the DB + emit to the UI.
   * Shared by the IPC handler and the workflow engine.
   *
   * Routing notes:
   * - 1:1 E2EE: FacebookService.sendMessage() automatically routes through the bridge if the thread
   *   is in the e2eeThreads list.
   * - Group: MQTT bridge route, REST fallback.
   * - Do NOT auto-detect user/group from the thread ID format, because both Facebook users and groups
   *   use numeric IDs, which a regex cannot tell apart.
   */
  static async sendTextMessage(params: FBSendTextParams): Promise<FBSendResult> {
    const accountId = FacebookSendService.resolveAccountId(params.accountId);
    const service = await FacebookSendService.getService(accountId);
    const threadId = String(params.threadId);
    const body = String(params.body || '');

    // ── Delegate to FacebookService.sendMessage() ──────────────────────────
    // FacebookService.sendMessage() already has the correct routing:
    //   - 1:1 E2EE → E2EE bridge (based on the e2eeThreads tracking)
    //   - Group → bridge MQTT (fallback REST)
    // Do NOT route here, because isUserThread() cannot tell a user from a group
    // Resolve once here so the type used to persist/emit matches the type used
    // to send. In particular, an omitted typeChat may resolve to a user in DB.
    const hasTypeChat = Object.prototype.hasOwnProperty.call(params, 'typeChat');
    const route = await resolveThreadKind(
      threadId,
      hasTypeChat ? params.typeChat : undefined,
      accountId,
    );
    if (route.kind === 'unknown') {
      return { success: false, error: route.error };
    }
    const isUserMessage = route.kind === 'user';
    const SEND_TIMEOUT_MS = 30000; // 30s - enough for bridge E2EE + REST fallback
    let result: any;
    try {
      // DEPLAO_ADAPTER: Preserve typeChat tri-state.
      // null = explicitly group, 'user' = explicitly user, undefined = resolve from DB.
      // NEVER use ?? which converts null → undefined.
      result = await Promise.race([
        service.sendMessage(threadId, body, {
          // Pass the resolved discriminator. FacebookService will not need a
          // second DB lookup and persistence below stays consistent.
          typeChat: isUserMessage ? 'user' : null,
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
      // Safety: mark as locally sent to prevent a self-echo duplicate
      // (sendMessage already called markMessageLocallySent internally; this is double safety)
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
      ...(result?.uncertain ? { uncertain: true } : {}),
    };
  }

  // ─── Send attachment (consolidated route matrix) ─────────────────────────

  /**
   * Send an attachment (image/video/audio/file) with the correct route matrix:
   * - user → E2EE bridge (sendE2EEImage/Video/Audio/File)
   * - group → upload + REST send
   * - unknown → structured error
   *
   * NO fallback between routes. If E2EE fails → return an error.
   * If REST fails → return an error.
   */
  static async sendAttachment(params: {
    accountId: string;
    threadId: string;
    filePath: string;
    body?: string;
    typeChat?: 'user' | null;
    fileType?: 'image' | 'video' | 'audio' | 'file';
    replyToMessageId?: string;
  }): Promise<FBSendResult> {
    const accountId = FacebookSendService.resolveAccountId(params.accountId);
    const threadId = String(params.threadId);

    // ── File validation ───────────────────────────────────────────────────
    // DEPLAO_ADAPTER: Validate file before routing to prevent wasted uploads
    // and bridge calls. Mirror Go bridge's readAndValidateLocalPath checks.
    const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB — matches bridge limit
    const ALLOWED_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|mp4|webm|mov|avi|mp3|wav|ogg|m4a|aac|flac|wma|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar|7z)$/i;
    const fs = require('fs');
    const filePath = params.filePath;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return { success: false, error: tr('Đường dẫn không phải là file: {{filePath}}', { filePath }) };
      }
      if (stat.size === 0) {
        return { success: false, error: tr('File trống (0 bytes)') };
      }
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        return { success: false, error: tr('File quá lớn ({{sizeMB}} MiB). Giới hạn: 25 MiB.', { sizeMB }) };
      }
    } catch (err: any) {
      return { success: false, error: tr('Không thể đọc file: {{message}}', { message: err.message }) };
    }

    const fileName = require('path').basename(filePath);
    if (!ALLOWED_EXTENSIONS.test(fileName)) {
      return { success: false, error: tr('Định dạng file không hỗ trợ: {{v1}}', { v1: require('path').extname(fileName) || tr('(không có ext)') }) };
    }

    // ── Route by thread kind ──────────────────────────────────────────────
    const hasTypeChat = params.typeChat !== undefined;
    const suppliedTypeChat = hasTypeChat ? params.typeChat : undefined;
    const route = await resolveThreadKind(threadId, suppliedTypeChat, accountId);
    if (route.kind === 'unknown') {
      return { success: false, error: route.error };
    }

    const isUserMessage = route.kind === 'user';
    const inferredType = FacebookSendService.guessAttachmentType(fileName);
    if (params.fileType !== undefined && !ATTACHMENT_KINDS.includes(params.fileType)) {
      return { success: false, error: tr('Loại file không hợp lệ: {{v1}}', { v1: String(params.fileType) }) };
    }
    // `webm` can legally carry either audio or video. All other explicit UI
    // values must agree with the validated file extension so we never invoke
    // an image/video bridge method for an unrelated document.
    const isWebmAudio = /\.webm$/i.test(fileName) && params.fileType === 'audio';
    if (params.fileType && params.fileType !== inferredType && !isWebmAudio) {
      return {
        success: false,
        error: tr('Loại file không khớp định dạng: {{fileType}} không phù hợp với {{v1}}', { fileType: params.fileType, v1: require('path').extname(fileName) }),
      };
    }
    const attachType: FBAttachmentKind = params.fileType || inferredType;
    const service = await FacebookSendService.getService(accountId);

    // ═════════════════════════════════════════════════════════════════════
    // USER ROUTING — E2EE, unless this session has already established that
    // this particular 1:1 is a normal REST conversation.
    // ═════════════════════════════════════════════════════════════════════
    if (isUserMessage && !service.isKnownNonE2EEThread(threadId)) {
      if (!service.isE2EEConnected()) {
        try { await service.retryE2EE(); } catch {}
      }
      if (!service.isE2EEConnected()) {
        return {
          success: false,
          error: tr('Không thể gửi file 1:1: E2EE bridge chưa kết nối.'),
        };
      }

      const chatJid = normalizeChatJid(threadId);
      let result: any;
      try {
        if (attachType === 'image') {
          result = await service.sendE2EEImage(chatJid, params.filePath, params.body);
        } else if (attachType === 'video') {
          result = await service.sendE2EEVideo(chatJid, params.filePath, params.body);
        } else if (attachType === 'audio') {
          result = await service.sendE2EEAudio(chatJid, params.filePath);
        } else {
          result = await service.sendE2EEFile(chatJid, params.filePath, fileName);
        }
      } catch (err: any) {
        // DEPLAO_ADAPTER: No REST fallback for E2EE failures.
        return { success: false, error: `E2EE send failed: ${err.message}` };
      }

      if (result?.success && result?.messageId) {
        // Save to DB + emit UI
        const fbSenderId = service.getRealFacebookId() || accountId;
        let localRelPath: string | undefined;
        try {
          const fs = require('fs');
          const buffer = fs.readFileSync(params.filePath);
          const ext = require('path').extname(fileName) || '.bin';
          const savedName = `sent_${result.messageId.slice(-8)}_${Date.now()}${ext}`;
          const absPath = await FileStorageService.saveBuffer(fbSenderId, buffer, savedName);
          localRelPath = FileStorageService.toRelativePath(absPath);
        } catch {}

        await FacebookSendService.persistSentMessage({
          accountId,
          threadId,
          messageId: result.messageId,
          body: params.body || null,
          fbSenderId,
          timestamp: result.timestamp || Date.now(),
          type: attachType,
          isUserMessage: true,
          replyToMessageId: params.replyToMessageId,
          attachments: JSON.stringify([{
            type: attachType,
            name: fileName,
            ...(localRelPath ? { localPath: localRelPath } : {}),
          }]),
          localPath: localRelPath,
        });
      }

      return {
        success: result?.success === true,
        messageId: result?.messageId,
        timestamp: result?.timestamp,
        ...(result?.error ? { error: result.error } : {}),
      };
    }

    // ═════════════════════════════════════════════════════════════════════
    // GROUP + known normal 1:1 ROUTING — REST ONLY
    // ═════════════════════════════════════════════════════════════════════
    const uploaded = await service.uploadAttachment(params.filePath);
    if (!uploaded) return { success: false, error: tr('Upload thất bại') };

    const restAttachType = uploaded.attachmentType?.startsWith('image') ? 'image'
      : uploaded.attachmentType?.startsWith('video') ? 'video'
      : uploaded.attachmentType?.startsWith('audio') ? 'audio'
      : 'file';

    let result: any;
    try {
      result = await service.sendMessage(threadId, params.body || '', {
        typeAttachment: restAttachType as any,
        attachmentId: uploaded.attachmentId,
        // `route` was resolved above. Pass its explicit discriminator instead
        // of asking FacebookService to resolve a second time from mutable DB
        // metadata.
        typeChat: isUserMessage ? 'user' : null,
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
      });
    } catch (err: any) {
      return { success: false, error: `REST attachment send failed: ${err.message}` };
    }

    if (result?.success && result?.messageId) {
      const fbSenderId = service.getRealFacebookId() || accountId;
      await FacebookSendService.persistSentMessage({
        accountId,
        threadId,
        messageId: result.messageId,
        body: params.body || null,
        fbSenderId,
        timestamp: result.timestamp || Date.now(),
        type: restAttachType,
        isUserMessage,
        replyToMessageId: params.replyToMessageId,
        attachments: JSON.stringify([{
          type: restAttachType,
          id: uploaded.attachmentId,
          name: fileName,
          url: uploaded.attachmentUrl || null,
        }]),
      });
    }

    return {
      success: result?.success === true,
      messageId: result?.messageId,
      timestamp: result?.timestamp,
      ...(result?.error ? { error: result.error } : {}),
    };
  }

  /**
   * Guess attachment type from filename extension.
   */
  private static guessAttachmentType(fileName: string): FBAttachmentKind {
    if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(fileName)) return 'image';
    if (/\.(mp4|webm|mov|avi)$/i.test(fileName)) return 'video';
    if (/\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(fileName)) return 'audio';
    return 'file';
  }

  // ─── Persist sent message to DB + emit UI event ─────────────────────────

  /**
   * Save the sent message to the DB and broadcast it to the UI.
   * Shared by all message types (text, image, video, file, audio).
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

    // Resolve quote_data if this is a reply
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

    // Update local_paths if there is a local file
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

      // Emit localPath separately for media
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
