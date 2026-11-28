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
import { prepareM4aVoiceNote, prepareOggVoiceNote, removeConverted } from '../../media/voiceNotes';
import { mentionAttachments } from '../../../shared/facebook/facebookSpecialMessages';
import FileStorageService from '../../file/FileStorageService';
import { isE2EEServerRejection, isNormalSendRejection } from './facebookSendFallback';
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
  /** @mentions inside body (group messages). */
  mentions?: Array<{ userId: string; offset: number; length: number }>;
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
          // @mentions only exist in groups (an encrypted 1:1 has nobody to mention)
          ...(!isUserMessage && params.mentions?.length ? { mentions: params.mentions } : {}),
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
        ...(!isUserMessage && params.mentions?.length ? { attachments: JSON.stringify(mentionAttachments(params.mentions)) } : {}),
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
   * - user → E2EE bridge (sendE2EEImage/Video/Audio/File), unless the 1:1 is known as a normal chat
   * - group / known normal 1:1 → upload + REST send
   * - unknown → structured error
   *
   * A 1:1 tries the other way once only after a clear refusal (send/facebookSendFallback.ts): Messenger's server refuses the
   * E2EE send with an error code → upload + normal send; Facebook refuses the normal send of a known normal 1:1 → the E2EE send.
   * The way that went through is remembered. Timeouts / lost connections are never sent the other way.
   */
  static async sendAttachment(params: {
    accountId: string;
    threadId: string;
    filePath: string;
    body?: string;
    typeChat?: 'user' | null;
    fileType?: 'image' | 'video' | 'audio' | 'file';
    replyToMessageId?: string;
    /** In-app voice recording: sent as a voice message (OGG / Opus in encrypted chats, M4A voice clip otherwise). */
    voice?: boolean;
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

    /** E2EE send of the file to the 1:1 (voice recording: OGG / Opus voice message). Never throws. */
    const sendEncrypted = async (): Promise<any> => {
      const chatJid = normalizeChatJid(threadId);
      try {
        if (attachType === 'image') return await service.sendE2EEImage(chatJid, params.filePath, params.body);
        if (attachType === 'video') return await service.sendE2EEVideo(chatJid, params.filePath, params.body);
        if (attachType === 'audio' && params.voice) {
          const note = await prepareOggVoiceNote(params.filePath);
          try {
            return await service.sendE2EEAudio(chatJid, note.path, note.converted ? note.mimeType : undefined, {
              ptt: true, durationSec: note.durationSec,
            });
          } finally {
            removeConverted(note);
          }
        }
        if (attachType === 'audio') return await service.sendE2EEAudio(chatJid, params.filePath);
        return await service.sendE2EEFile(chatJid, params.filePath, fileName);
      } catch (err: any) {
        return { success: false, error: `E2EE send failed: ${err.message}` };
      }
    };
    /** Save the E2EE-sent file (a copy on this machine) to the DB + emit to the UI. */
    const persistEncrypted = async (result: { messageId: string; timestamp?: number }) => {
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
    };
    /** Error of Messenger's server when it refused the E2EE send ('' = not refused). */
    let refusedEncrypted = '';

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

      const result = await sendEncrypted();
      if (!result?.success && isE2EEServerRejection(result?.error)) {
        // Messenger's server refused the encrypted file: nothing was delivered → upload + normal send once (below)
        Logger.warn(`[FacebookSendService] 1:1 E2EE ${attachType} refused by the server (${result.error}) → normal send once`);
        refusedEncrypted = String(result.error);
      } else {
        if (result?.success && result?.messageId) {
          service.rememberE2EEThread(threadId);
          await persistEncrypted(result);
        }
        return {
          success: result?.success === true,
          messageId: result?.messageId,
          timestamp: result?.timestamp,
          ...(result?.error ? { error: result.error } : {}),
        };
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // GROUP + known normal 1:1 ROUTING (and a 1:1 whose E2EE send was refused) — REST
    // ═════════════════════════════════════════════════════════════════════
    // A voice recording goes up as Messenger's own voice clip (M4A); without ffmpeg the recording is sent as it is
    const voiceNote = attachType === 'audio' && params.voice ? await prepareM4aVoiceNote(params.filePath) : null;
    let uploaded: Awaited<ReturnType<typeof service.uploadAttachment>>;
    try {
      uploaded = voiceNote
        ? await service.uploadAttachment(voiceNote.path, { voiceClip: true })
        : await service.uploadAttachment(params.filePath);
    } finally {
      removeConverted(voiceNote);
    }
    if (!uploaded) return { success: false, error: tr('Upload thất bại') };

    const restAttachType = uploaded.attachmentType?.startsWith('image') ? 'image'
      : uploaded.attachmentType?.startsWith('video') ? 'video'
      : uploaded.attachmentType?.startsWith('audio') ? 'audio'
      : 'file';

    let result: any;
    try {
      const restOpts = {
        typeAttachment: restAttachType as any,
        attachmentId: uploaded.attachmentId,
        // `route` was resolved above. Pass its explicit discriminator instead
        // of asking FacebookService to resolve a second time from mutable DB
        // metadata.
        typeChat: isUserMessage ? 'user' as const : null,
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
      };
      // After a refused E2EE send: straight to the normal send (sendMessage would try E2EE again)
      result = refusedEncrypted
        ? await service.sendNormalMessage(threadId, params.body || '', restOpts)
        : await service.sendMessage(threadId, params.body || '', restOpts);
    } catch (err: any) {
      return { success: false, error: `REST attachment send failed: ${err.message}` };
    }

    // A 1:1 known as normal that Messenger upgraded to E2EE: Facebook refused the normal send → the E2EE send once
    if (isUserMessage && !refusedEncrypted && !result?.success && isNormalSendRejection(result) && service.e2eeReadyForRetry()) {
      Logger.warn(`[FacebookSendService] 1:1 normal ${restAttachType} send refused (${result.error}) → E2EE send once`);
      const encrypted = await sendEncrypted();
      if (encrypted?.success && encrypted?.messageId) {
        service.rememberE2EEThread(threadId);
        await persistEncrypted(encrypted);
        return { success: true, messageId: encrypted.messageId, timestamp: encrypted.timestamp };
      }
      return { success: false, error: `${result.error || 'Normal send failed'}; E2EE send failed: ${encrypted?.error || 'unknown error'}` };
    }
    if (refusedEncrypted && !result?.success) {
      return { success: false, error: `E2EE send failed: ${refusedEncrypted}; normal send failed: ${result?.error || 'unknown error'}` };
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
  /**
   * Send a Messenger sticker. Ordinary threads send the sticker id; encrypted 1:1 chats carry the sticker image itself
   * (downloaded first when only its link is known). The sent sticker is saved and shown like a received one.
   */
  static async sendSticker(params: {
    accountId: string;
    threadId: string;
    stickerId: string;
    url?: string;
    localPath?: string;
    typeChat?: 'user' | null;
  }): Promise<FBSendResult> {
    const accountId = FacebookSendService.resolveAccountId(params.accountId);
    const threadId = String(params.threadId);
    const stickerId = /^\d+$/.test(String(params.stickerId || '')) ? String(params.stickerId) : '';
    // A sticker received in an encrypted chat has no Messenger id, only its image: it can be sent to encrypted chats only
    if (!stickerId && !params.localPath && !params.url) return { success: false, error: tr('Nhãn dán không hợp lệ') };
    const service = await FacebookSendService.getService(accountId);
    const hasTypeChat = Object.prototype.hasOwnProperty.call(params, 'typeChat');
    const route = await resolveThreadKind(threadId, hasTypeChat ? params.typeChat : undefined, accountId);
    if (route.kind === 'unknown') return { success: false, error: route.error };
    const isUserMessage = route.kind === 'user';
    const fbSenderId = service.getRealFacebookId() || accountId;
    let result: { success: boolean; messageId?: string; timestamp?: number; error?: string; rejected?: boolean };

    /** E2EE send of the sticker image (the stored copy, downloaded first when only its link is known). */
    const sendEncryptedSticker = async (): Promise<{ success: boolean; messageId?: string; error?: string }> => {
      const fs = require('fs');
      const storedPath = params.localPath ? FileStorageService.resolveAbsolutePath(params.localPath) : '';
      let imagePath = storedPath && fs.existsSync(storedPath) ? storedPath : '';
      if (!imagePath && params.url) {
        try {
          imagePath = await FileStorageService.downloadImage(fbSenderId, params.url, `fb_sticker_${stickerId || Date.now()}.png`, undefined, undefined, 'https://www.facebook.com/');
          imagePath = imagePath ? FileStorageService.resolveAbsolutePath(imagePath) || imagePath : '';
        } catch { imagePath = ''; }
      }
      if (!imagePath) return { success: false, error: tr('Không tải được ảnh nhãn dán') };
      const mime = /\.webp$/i.test(imagePath) ? 'image/webp' : /\.gif$/i.test(imagePath) ? 'image/gif' : 'image/png';
      return service.sendE2EESticker(normalizeChatJid(threadId), imagePath, mime);
    };

    if (isUserMessage && !service.isKnownNonE2EEThread(threadId)) {
      if (!service.isE2EEConnected()) {
        try { await service.retryE2EE(); } catch {}
      }
      if (!service.isE2EEConnected()) return { success: false, error: tr('Không thể gửi 1:1: E2EE bridge chưa kết nối.') };
      result = await sendEncryptedSticker();
      if (result.success && result.messageId) {
        service.rememberE2EEThread(threadId);
      } else if (isE2EEServerRejection(result.error) && stickerId) {
        // Messenger's server refused the encrypted sticker: nothing was delivered → the normal send (sticker id) once
        Logger.warn(`[FacebookSendService] 1:1 E2EE sticker refused by the server (${result.error}) → normal send once`);
        const encryptedError = result.error;
        result = await service.sendNormalMessage(threadId, '', { typeChat: 'user', stickerId });
        if (!result.success) result = { ...result, error: `E2EE send failed: ${encryptedError}; normal send failed: ${result.error || 'unknown error'}` };
      }
    } else {
      if (!stickerId) return { success: false, error: tr('Nhãn dán này chỉ gửi được trong chat mã hóa đầu cuối') };
      result = await service.sendMessage(threadId, '', { typeChat: isUserMessage ? 'user' : null, stickerId } as any);
      // A 1:1 known as normal that Messenger upgraded to E2EE: Facebook refused the normal send → the E2EE sticker once
      if (isUserMessage && !result?.success && isNormalSendRejection(result) && service.e2eeReadyForRetry()) {
        Logger.warn(`[FacebookSendService] 1:1 normal sticker send refused (${result.error}) → E2EE send once`);
        const normalError = result.error;
        const encrypted = await sendEncryptedSticker();
        if (encrypted.success && encrypted.messageId) service.rememberE2EEThread(threadId);
        result = encrypted.success ? encrypted : { ...encrypted, error: `${normalError || 'Normal send failed'}; E2EE send failed: ${encrypted.error || 'unknown error'}` };
      }
    }
    if (result?.success && result.messageId) {
      service.markMessageLocallySent(result.messageId);
      await FacebookSendService.persistSentMessage({
        accountId, threadId, messageId: result.messageId, body: null, fbSenderId,
        timestamp: result.timestamp || Date.now(), type: 'sticker', isUserMessage,
        attachments: JSON.stringify([{ type: 'sticker', url: params.url || null, ...(stickerId ? { id: stickerId, stickerId } : {}) }]),
        // The image the encrypted chat carried: the sent bubble shows it without a link
        ...(params.localPath ? { localPath: params.localPath } : {}),
      });
    }
    return {
      success: result?.success === true,
      messageId: result?.messageId,
      ...(result?.error ? { error: result.error } : {}),
    };
  }

  /**
   * Stickers this account sent or received lately (newest first, unique), for the sticker tab. Stickers of encrypted
   * chats have no Messenger id (stickerId ''), only their image: they can be sent to encrypted chats.
   */
  static recentStickers(accountId: string, limit = 60): Array<{ stickerId: string; key: string; url: string; localPath?: string }> {
    const db = DatabaseService.getInstance();
    const owner = db.fbOwnerId(FacebookSendService.resolveAccountId(accountId));
    const rows = db.query<{ attachments?: string; local_paths?: string }>(
      `SELECT attachments, local_paths FROM messages
       WHERE owner_zalo_id = ? AND channel = 'facebook' AND msg_type = 'sticker' AND COALESCE(is_recalled, 0) = 0
       ORDER BY timestamp DESC LIMIT 600`,
      [owner],
    ) || [];
    const out: Array<{ stickerId: string; key: string; url: string; localPath?: string }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      let att: any = null;
      try { att = (JSON.parse(row.attachments || '[]') || [])[0]; } catch {}
      const rawId = String(att?.stickerId || (/^\d{6,}$/.test(String(att?.id || '')) ? att.id : '') || '');
      const stickerId = /^\d+$/.test(rawId) ? rawId : '';
      let localPath = '';
      try { const paths = JSON.parse(row.local_paths || '{}'); localPath = paths.att_0 || paths.main || ''; } catch {}
      const url = String(att?.url || '');
      if (!url && !localPath) continue;
      // Without a Messenger id (encrypted chat) the image itself tells two stickers apart
      const key = stickerId || String(att?.mediaSha256 || '') || localPath || url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ stickerId, key, url, ...(localPath ? { localPath } : {}) });
      if (out.length >= limit) break;
    }
    return out;
  }

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
