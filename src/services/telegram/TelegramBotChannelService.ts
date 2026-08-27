/**
 * TelegramBotChannelService.ts - Kênh chat Telegram Bot
 *
 * Handles inbox messages: save to DB, download media, broadcast UI events.
 * Also exposes all Bot API send/action methods.
 *
 * Polling is owned by TelegramBotIngressService (TG-015).
 * This service registers as an inbox consumer of the ingress.
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import FileStorageService from '../file/FileStorageService';
import { shouldFetchAvatar, markAvatarFetched, markAvatarSuccess, resetAvatarCache } from '../../utils/avatarFetchCache';
import * as BotIngress from './TelegramBotIngressService';
import type { BotAccount, NormalizedUpdate, BotUpdateConsumer } from './TelegramBotIngressService';
import { getTelegramMessagePreview } from './TelegramMessagePreview';

const TELEGRAM_API = 'https://api.telegram.org';
const REQUEST_TIMEOUT = 30000;

/** Renderer may pass Electron's local-media:// URL. The Bot API needs a real file path. */
function resolveBotUploadPath(filePath: string): string {
  let candidate = filePath;
  if (candidate.startsWith('local-media:///')) candidate = candidate.replace('local-media:///', '');
  else if (candidate.startsWith('local-media://')) candidate = candidate.replace('local-media://', '');
  // DB local_paths may be relative to the configured storage folder.
  return FileStorageService.resolveAbsolutePath(candidate);
}

function appendBotUpload(form: any, field: string, filePath: string): void {
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    form.append(field, filePath);
    return;
  }
  const resolvedPath = resolveBotUploadPath(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File không tồn tại: ${path.basename(resolvedPath)}`);
  }
  form.append(field, fs.createReadStream(resolvedPath));
}

// Re-export BotAccount from ingress for backward compatibility
export type TelegramBotAccount = BotAccount;

/** Map accountId → registered account (for send methods) */
const registeredAccounts = new Map<string, BotAccount>();

const events = new EventEmitter();

// ─── Event types ─────────────────────────────────────────────────────────────

export interface TelegramMessage {
  accountId: string;
  threadId: string;      // = chat_id
  threadType: number;    // 0=user, 1=group
  senderId: string;
  senderName: string;
  messageId: string;
  content: string;
  msgType: string;       // 'text', 'photo', 'video', 'document', 'sticker', 'audio', 'voice'
  timestamp: number;
  isSelf: boolean;
  attachments?: any[];
  replyToMessageId?: string;
}

// ─── Ingress consumer (inbox handler) ───────────────────────────────────────

/**
 * Handle an inbound message from the ingress service.
 * Called by TelegramBotIngressService for each 'message' update.
 */
async function handleInboundMessage(account: BotAccount, message: any): Promise<void> {
  if (!message) { Logger.warn('[TelegramBot] handleInboundMessage: null message'); return; }

  const chatId = String(message.chat?.id || '');
  const fromId = String(message.from?.id || '');
  const fromName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || fromId;
  const isGroup = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
  const isChannel = message.chat?.type === 'channel';
  const threadType = isGroup ? 1 : 0;
  const timestamp = (message.date || Math.floor(Date.now() / 1000)) * 1000;
  const messageId = String(message.message_id || Date.now());

  Logger.log(`[TelegramBot] handleInboundMessage: chatId=${chatId} from=${fromName} msgId=${messageId} hasText=${!!message.text} hasPhoto=${!!message.photo} hasVideo=${!!message.video} hasDocument=${!!message.document} hasSticker=${!!message.sticker}`);

  // Determine message type + content
  let content = '';
  let msgType = 'text';
  let attachments: any[] = [];

  if (message.text) {
    content = message.text;
    msgType = 'text';
  } else if (message.photo) {
    msgType = 'photo';
    content = message.caption || '';
    attachments = message.photo.map((p: any) => ({
      type: 'photo',
      file_id: p.file_id,
      file_unique_id: p.file_unique_id,
      width: p.width,
      height: p.height,
      file_size: p.file_size,
    }));
  } else if (message.video) {
    msgType = 'video';
    content = message.caption || '';
    attachments = [{
      type: 'video',
      file_id: message.video.file_id,
      file_unique_id: message.video.file_unique_id,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
      file_size: message.video.file_size,
    }];
  } else if (message.animation) {
    // GIF/Animation
    msgType = 'gif';
    content = message.caption || '';
    attachments = [{
      type: 'gif',
      file_id: message.animation.file_id,
      file_unique_id: message.animation.file_unique_id,
      width: message.animation.width,
      height: message.animation.height,
      duration: message.animation.duration,
      file_size: message.animation.file_size,
      mime_type: message.animation.mime_type || '',
    }];
  } else if (message.document) {
    msgType = 'file';
    content = message.caption || '';
    attachments = [{
      type: 'file',
      file_id: message.document.file_id,
      file_unique_id: message.document.file_unique_id,
      file_name: message.document.file_name,
      mime_type: message.document.mime_type,
      file_size: message.document.file_size,
    }];
  } else if (message.sticker) {
    const isAnimated = message.sticker.is_animated === true;
    const isVideo = message.sticker.is_video === true;
    msgType = 'sticker';
    attachments = [{
      type: 'sticker',
      is_sticker: true,
      sticker_format: isAnimated ? 'tgs' : isVideo ? 'webm' : 'webp',
      mime_type: isAnimated ? 'application/x-tgsticker' : isVideo ? 'video/webm' : 'image/webp',
      file_id: message.sticker.file_id,
      file_unique_id: message.sticker.file_unique_id,
      emoji: message.sticker.emoji,
      width: message.sticker.width,
      height: message.sticker.height,
    }];
  } else if (message.video_note) {
    // Round video message
    msgType = 'video_note';
    attachments = [{
      type: 'video_note',
      file_id: message.video_note.file_id,
      file_unique_id: message.video_note.file_unique_id,
      length: message.video_note.length,
      duration: message.video_note.duration,
      file_size: message.video_note.file_size,
    }];
  } else if (message.audio) {
    msgType = 'audio';
    attachments = [{
      type: 'audio',
      file_id: message.audio.file_id,
      duration: message.audio.duration,
      title: message.audio.title,
      file_size: message.audio.file_size,
    }];
  } else if (message.voice) {
    msgType = 'voice';
    attachments = [{
      type: 'voice',
      file_id: message.voice.file_id,
      duration: message.voice.duration,
      file_size: message.voice.file_size,
    }];
  } else if (message.contact) {
    msgType = 'contact';
    content = message.contact.phone_number || '';
    attachments = [{
      type: 'contact',
      phone_number: message.contact.phone_number,
      first_name: message.contact.first_name,
      last_name: message.contact.last_name || '',
      user_id: message.contact.user_id || '',
    }];
  } else if (message.location) {
    msgType = 'location';
    content = message.location.title || `${message.location.latitude}, ${message.location.longitude}`;
    attachments = [{
      type: 'location',
      latitude: message.location.latitude,
      longitude: message.location.longitude,
    }];
  } else if (message.venue) {
    msgType = 'venue';
    content = message.venue.title || '';
    attachments = [{
      type: 'venue',
      title: message.venue.title,
      address: message.venue.address || '',
      latitude: message.venue.location?.latitude,
      longitude: message.venue.location?.longitude,
    }];
  } else if (message.poll) {
    msgType = 'poll';
    content = message.poll.question || '';
    attachments = [{
      type: 'poll',
      question: message.poll.question,
      options: message.poll.options?.map((o: any) => o.text) || [],
      is_anonymous: message.poll.is_anonymous,
      poll_id: message.poll.id || '',
    }];
  }

  // Reply-to
  let replyToMessageId: string | undefined;
  if (message.reply_to_message?.message_id) {
    replyToMessageId = String(message.reply_to_message.message_id);
  }

  const tgMsg: TelegramMessage = {
    accountId: account.accountId,
    threadId: chatId,
    threadType,
    senderId: fromId,
    senderName: fromName,
    messageId,
    content,
    msgType,
    timestamp,
    isSelf: false, // Bot never sends via polling
    attachments,
    replyToMessageId,
  };

  // Save to DB
  await saveMessage(tgMsg, account.botToken);

  // Download media (background, non-blocking)
  // For photos, use the largest size (last element in array)
  const downloadAtt = msgType === 'photo' ? attachments[attachments.length - 1] : attachments[0];
  if (downloadAtt?.file_id) {
    const fileId = downloadAtt.file_id;
    const fileName = downloadAtt.file_name || `${msgType}_${messageId}`;
    downloadBotMedia(account.botToken, fileId, fileName, msgType, account.accountId, messageId, chatId).catch(err => {
      Logger.warn(`[TelegramBotChannel] Media download failed: ${err.message}`);
    });
  }

  // Broadcast event to UI
  EventBroadcaster.emit('event:message', {
    zaloId: account.accountId,
    channel: 'telegram_bot',
    message: {
      channel: 'telegram_bot',
      type: threadType,
      threadId: chatId,
      isSelf: false,
      data: {
        uidFrom: fromId,
        idTo: chatId,
        msgId: messageId,
        content,
        preview: getTelegramMessagePreview(msgType, content),
        msgType,
        channel: 'telegram_bot',
        isChannel,
        ts: String(timestamp),
        dName: fromName,
        attachments,
      },
    },
  });

  Logger.log(`[TelegramBotChannel] ${account.accountId}: msg from ${fromName} in ${chatId}: ${content.slice(0, 50)}`);
}

// ─── Database ────────────────────────────────────────────────────────────────

async function saveMessage(msg: TelegramMessage, botToken?: string): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  try {
    // Save to unified messages table
    const displayContent = msg.content || (() => {
      if (msg.msgType === 'photo') return '🖼️ Hình ảnh';
      if (msg.msgType === 'video') return '🎬 Video';
      if (msg.msgType === 'audio') return '🎵 Audio';
      if (msg.msgType === 'voice') return '🎤 Voice';
      if (msg.msgType === 'sticker') return '🎨 Sticker';
      if (msg.msgType !== 'text') return '📎 Tệp đính kèm';
      return '';
    })();

    // Resolve quote_data nếu có reply
    let quoteData: string | undefined;
    if (msg.replyToMessageId) {
      try {
        const orig = db.queryOne<any>(
          `SELECT content, msg_type, sender_id FROM messages WHERE msg_id = ? AND owner_zalo_id = ?`,
          [msg.replyToMessageId, msg.accountId]
        );
        if (orig) {
          quoteData = JSON.stringify({
            msgId: msg.replyToMessageId,
            msg: orig.content || '',
            senderId: orig.sender_id || '',
            msgType: orig.msg_type || 'text',
          });
        }
      } catch {}
    }

    db.run(`
      INSERT OR IGNORE INTO messages
        (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, quote_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram_bot', ?, ?)
    `, [
      msg.messageId,
      msg.accountId,
      msg.threadId,
      msg.threadType,
      msg.senderId,
      displayContent,
      msg.msgType,
      msg.timestamp,
      msg.isSelf ? 1 : 0,
      JSON.stringify(msg.attachments || []),
      msg.isSelf ? 'sent' : 'received',
      msg.replyToMessageId || null,
      quoteData || null,
    ]);

    // Store the original caption in messages; use a stable media label for the
    // conversation row so a phone number caption cannot masquerade as text.
    const preview = getTelegramMessagePreview(msg.msgType, msg.content);

    // Update contacts
    db.run(`
      INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
      VALUES (?, ?, ?, '', 0, ?, ?, ?, ?, 'telegram_bot')
      ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
        display_name = CASE WHEN excluded.display_name != '' AND contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
        last_message = excluded.last_message,
        last_message_time = excluded.last_message_time,
        unread_count = CASE WHEN ? = 0 THEN contacts.unread_count + 1 ELSE contacts.unread_count END,
        channel = 'telegram_bot'
    `, [
      msg.accountId, msg.threadId, msg.senderName,
      msg.threadType === 1 ? 'group' : 'user',
      msg.isSelf ? 0 : 1, preview, msg.timestamp,
      msg.isSelf ? 0 : 1, // for the ON CONFLICT update
    ]);

    // Fetch avatar cho contact mới (background)
    if (!msg.isSelf) {
      fetchBotContactAvatar(msg.accountId, msg.threadId, msg.senderName, botToken).catch(() => {});
    }
  } catch (err: any) {
    Logger.error(`[TelegramBotChannel] saveMessage error: ${err.message}`);
  }
}

// ─── Contact Avatar (Bot API) ────────────────────────────────────────────────

/**
 * Fetch avatar cho contact qua Bot API (getUserProfilePhotos)
 */
async function fetchBotContactAvatar(
  accountId: string,
  chatId: string,
  senderName: string,
  botToken: string,
): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  try {
    // Kiểm tra đã có avatar chưa
    const existing = db.queryOne<any>(
      `SELECT avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_bot'`,
      [accountId, chatId]
    );
    if (existing?.avatar_url) {
      markAvatarSuccess(accountId, chatId);
      return;
    }

    // Kiểm tra cache
    if (!shouldFetchAvatar(accountId, chatId)) return;
    markAvatarFetched(accountId, chatId);

    // Bot API: getUserProfilePhotos
    try {
      const res = await axios.get(`${TELEGRAM_API}/bot${botToken}/getUserProfilePhotos`, {
        params: { user_id: chatId, limit: 1 },
        timeout: REQUEST_TIMEOUT,
      });

      if (res.data?.ok && res.data?.result?.photos?.length > 0) {
        const photo = res.data.result.photos[0];
        const fileId = photo[photo.length - 1]?.file_id; // Lấy size lớn nhất
        if (fileId) {
          // Get file path
          const fileRes = await axios.get(`${TELEGRAM_API}/bot${botToken}/getFile`, {
            params: { file_id: fileId },
            timeout: REQUEST_TIMEOUT,
          });
          if (fileRes.data?.ok && fileRes.data?.result?.file_path) {
            const filePath = fileRes.data.result.file_path;
            const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
            const response = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const buffer = Buffer.from(response.data);
            if (buffer.length > 0) {
              const filename = `telegram_bot_avatar_${chatId}_${Date.now()}.jpg`;
              const localPath = await saveAvatarToDisk(buffer, filename);
              if (localPath) {
                const normalized = localPath.replace(/\\/g, '/');
                const mediaUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
                db.run(`UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_bot'`,
                  [mediaUrl, accountId, chatId]);
                EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'bot_avatar_user' });
              }
            }
          }
        }
      }
    } catch {}

    // Also try to get chat photo for groups
    try {
      const chatRes = await axios.get(`${TELEGRAM_API}/bot${botToken}/getChat`, {
        params: { chat_id: chatId },
        timeout: REQUEST_TIMEOUT,
      });
      if (chatRes.data?.ok && chatRes.data?.result?.photo) {
        const photoId = chatRes.data.result.photo.small_file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/bot${botToken}/getFile`, {
          params: { file_id: photoId },
          timeout: REQUEST_TIMEOUT,
        });
        if (fileRes.data?.ok && fileRes.data?.result?.file_path) {
          const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${fileRes.data.result.file_path}`;
          const response = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });
          const buffer = Buffer.from(response.data);
          if (buffer.length > 0) {
            const filename = `telegram_bot_avatar_${chatId}_${Date.now()}.jpg`;
            const localPath = await saveAvatarToDisk(buffer, filename);
            if (localPath) {
              const normalized = localPath.replace(/\\/g, '/');
              const mediaUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
              db.run(`UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_bot'`,
                [mediaUrl, accountId, chatId]);
                EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'bot_avatar_group' });
            }
          }
        }
      }
    } catch {}
  } catch {}
}

// ─── Media Download (Bot API) ────────────────────────────────────────────────

/**
 * Download media từ Telegram Bot API qua getFile.
 * Bot API: getFile(file_id) → file_path → download URL
 */
async function downloadBotMedia(
  botToken: string,
  fileId: string,
  filename: string,
  msgType: string,
  accountId: string,
  messageId: string,
  threadId: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await downloadBotMediaOnce(botToken, fileId, filename, msgType, accountId, messageId, threadId);
      return;
    } catch (error: any) {
      lastError = error;
      if (attempt < 3) {
        Logger.warn(`[TelegramBotChannel] Media download retry ${attempt}/3 msg=${messageId}: ${error?.message || String(error)}`);
        await new Promise(resolve => setTimeout(resolve, 1_000 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Media download failed'));
}

async function downloadBotMediaOnce(
  botToken: string,
  fileId: string,
  filename: string,
  msgType: string,
  accountId: string,
  messageId: string,
  threadId: string,
): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) throw new Error('Database unavailable');

  try {
    // Step 1: Get file path from Telegram
    const fileRes = await axios.get(`${TELEGRAM_API}/bot${botToken}/getFile`, {
      params: { file_id: fileId },
      timeout: REQUEST_TIMEOUT,
    });

    if (!fileRes.data?.ok || !fileRes.data?.result?.file_path) {
      throw new Error(`getFile failed for ${fileId}`);
    }

    const filePath = fileRes.data.result.file_path;

    // Step 2: Download file
    const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });

    const buffer = Buffer.from(response.data);
    if (buffer.length === 0) throw new Error('Downloaded Telegram media is empty');

    // Step 3: Save to disk
    const ext = getMediaExtension(msgType, filePath || filename);
    const safeFilename = `${accountId}_${threadId}_${messageId}${ext}`;
    const localPath = await saveMediaToDisk(buffer, safeFilename, msgType);
    if (!localPath) throw new Error('Could not save Telegram media');

    // Step 4: Update local_paths trong DB
    const localPaths: Record<string, string> = {};
    if (msgType === 'photo') localPaths.main = localPath;
    else if (msgType === 'video') localPaths.video = localPath;
    else if (msgType === 'audio' || msgType === 'voice') localPaths.voice = localPath;
    else localPaths.file = localPath;

    db.run(
      `UPDATE messages SET local_paths = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_bot'`,
      [JSON.stringify(localPaths), messageId, accountId, threadId]
    );

    // Broadcast local path update to UI
    EventBroadcaster.emit('event:localPath', {
      zaloId: accountId,
      msgId: messageId,
      threadId,
      localPaths,
    });

    Logger.log(`[TelegramBotChannel] Downloaded ${msgType} for msg ${messageId}: ${localPath}`);
  } catch (err: any) {
    Logger.warn(`[TelegramBotChannel] downloadBotMedia error: ${err.message}`);
    throw err;
  }
}

function getMediaExtension(msgType: string, filename: string): string {
  if (msgType === 'photo') return '.jpg';
  if (msgType === 'video') return '.mp4';
  if (msgType === 'audio' || msgType === 'voice') return '.ogg';
  if (msgType === 'sticker') {
    const lowerName = filename.toLowerCase();
    if (lowerName.endsWith('.tgs')) return '.tgs';
    if (lowerName.endsWith('.webm')) return '.webm';
    if (lowerName.endsWith('.mp4')) return '.mp4';
    return '.webp';
  }
  // File: get from filename
  const dot = filename.lastIndexOf('.');
  if (dot > 0) return filename.substring(dot);
  return '.bin';
}

async function saveAvatarToDisk(buffer: Buffer, filename: string): Promise<string | null> {
  try {
    const baseDir = FileStorageService.getBaseDir();
    const avatarsDir = path.join(baseDir, '_avatars', 'telegram');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }
    const filePath = path.join(avatarsDir, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch {
    return null;
  }
}

async function saveMediaToDisk(buffer: Buffer, filename: string, msgType: string): Promise<string | null> {
  try {
    const baseDir = FileStorageService.getBaseDir();

    let subfolder = 'files';
    if (msgType === 'photo') subfolder = 'images';
    else if (msgType === 'video') subfolder = 'videos';
    else if (msgType === 'audio') subfolder = 'voices';
    else if (msgType === 'sticker') subfolder = 'stickers';

    // Extract accountId from filename (format: accountId_threadId_msgId.ext)
    const parts = filename.split('_');
    const accountId = parts[0] || 'unknown';

    const mediaDir = path.join(baseDir, accountId, subfolder);
    if (!fs.existsSync(mediaDir)) {
      fs.mkdirSync(mediaDir, { recursive: true });
    }

    const filePath = path.join(mediaDir, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Gửi tin nhắn qua Telegram Bot
 */
export async function sendMessage(accountId: string, chatId: string, text: string, parseMode?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  if (!bot.botToken) return { success: false, error: 'Bot token missing' };

  try {
    const payload: Record<string, any> = { chat_id: chatId, text };
    if (parseMode) payload.parse_mode = parseMode;

    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendMessage`, payload, {
      timeout: REQUEST_TIMEOUT,
    });

    // Validate response
    if (!res.data?.ok) {
      Logger.warn(`[TelegramBot] sendMessage failed: ${res.data?.description || 'unknown error'}`);
      return { success: false, error: res.data?.description || 'Telegram API error' };
    }

    const result = res.data?.result;
    const msgId = result?.message_id ? String(result.message_id) : '';

    if (!msgId) {
      // Message was sent but we didn't get a message_id back
      Logger.warn(`[TelegramBot] sendMessage: no message_id in response, result=${JSON.stringify(result)}`);
      return { success: true }; // Still success, but without msgId
    }

    // Detect threadType: Telegram group/channel IDs are negative
    const threadType = chatId.startsWith('-') ? 1 : 0;

    // Save sent message to DB
    await saveMessage({
      accountId,
      threadId: chatId,
      threadType,
      senderId: accountId,
      senderName: bot.botFirstName,
      messageId: msgId,
      content: text,
      msgType: 'text',
      timestamp: Date.now(),
      isSelf: true,
    });

    // Emit event so UI updates (self-sent messages won't come via polling)
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_bot',
      message: {
        channel: 'telegram_bot',
        type: threadType,
        threadId: chatId,
        isSelf: true,
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: text,
          preview: text,
          msgType: 'text',
          channel: 'telegram_bot',
          ts: String(Date.now()),
          dName: bot.botFirstName,
        },
      },
    });

    return { success: true, messageId: msgId };
  } catch (err: any) {
    Logger.error(`[TelegramBot] sendMessage error: ${err.message}`);
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Helper: save a self-sent bot message to DB and emit event for UI.
 */
async function saveSentBotMessage(
  accountId: string,
  chatId: string,
  msgId: string,
  content: string,
  msgType: string,
  attachments: any[] = [],
): Promise<void> {
  if (!msgId) return;
  const threadType = chatId.startsWith('-') ? 1 : 0;
  const bot = registeredAccounts.get(accountId);
  const botName = bot?.botFirstName || 'Bot';

  await saveMessage({
    accountId,
    threadId: chatId,
    threadType,
    senderId: accountId,
    senderName: botName,
    messageId: msgId,
    content: content || '',
    msgType,
    timestamp: Date.now(),
    isSelf: true,
    attachments,
  });

  try {
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_bot',
      message: {
        channel: 'telegram_bot',
        type: threadType,
        threadId: chatId,
        isSelf: true,
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: content || '',
          preview: getTelegramMessagePreview(msgType, content || ''),
          msgType,
          channel: 'telegram_bot',
          ts: String(Date.now()),
          dName: botName,
          attachments,
        },
      },
    });
  } catch {}
}

/**
 * Gửi ảnh qua Telegram Bot
 */
export async function sendPhoto(accountId: string, chatId: string, photoPath: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  if (!bot.botToken) return { success: false, error: 'Bot token missing' };

  try {
    const fs = require('fs');
    const FormDataNode = require('form-data');
    const form = new FormDataNode();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'photo', photoPath);
    if (caption) form.append('caption', caption);

    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: REQUEST_TIMEOUT,
    });

    Logger.log(`[TelegramBot] sendPhoto response: ok=${res.data?.ok}, message_id=${res.data?.result?.message_id}, result_keys=${Object.keys(res.data?.result || {}).join(',')}`);

    if (!res.data?.ok) {
      return { success: false, error: res.data?.description || 'Telegram API error' };
    }

    const result = res.data?.result;
    // Telegram photo response: result.message_id exists at top level
    const msgId = result?.message_id ? String(result.message_id) : '';
    if (!msgId) {
      Logger.warn(`[TelegramBot] sendPhoto: no message_id in response, result=${JSON.stringify(result).slice(0, 200)}`);
    }

    // Save sent photo to DB and emit event
    if (msgId) {
      const threadType = chatId.startsWith('-') ? 1 : 0;
      // Extract photo attachments from API response
      const photoAttachments = (result?.photo || []).map((p: any) => ({
        type: 'photo',
        file_id: p.file_id,
        file_unique_id: p.file_unique_id,
        width: p.width,
        height: p.height,
        file_size: p.file_size,
      }));
      await saveMessage({
        accountId,
        threadId: chatId,
        threadType,
        senderId: accountId,
        senderName: bot.botFirstName,
        messageId: msgId,
        content: caption || '',
        msgType: 'photo',
        timestamp: Date.now(),
        isSelf: true,
        attachments: photoAttachments,
      });

      // Emit event FIRST so UI adds message to store
      try {
        const { EventBroadcaster } = require('../event/EventBroadcaster');
        EventBroadcaster.emit('event:message', {
          zaloId: accountId,
          channel: 'telegram_bot',
          message: {
            channel: 'telegram_bot',
            type: threadType,
            threadId: chatId,
            isSelf: true,
            data: {
              uidFrom: accountId,
              idTo: chatId,
              msgId,
              content: caption || '',
              preview: getTelegramMessagePreview('photo', caption || ''),
              msgType: 'photo',
              channel: 'telegram_bot',
              ts: String(Date.now()),
              dName: bot.botFirstName,
              attachments: photoAttachments,
            },
          },
        });
      } catch {}

      // Download photo AFTER event is emitted (so message is in store when localPath arrives)
      if (photoAttachments.length > 0) {
        const largestPhoto = photoAttachments[photoAttachments.length - 1];
        downloadBotMedia(bot.botToken, largestPhoto.file_id, `photo_${msgId}.jpg`, 'photo', accountId, msgId, chatId).catch(() => {});
      }
    }

    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi video qua Telegram Bot
 */
export async function sendVideo(accountId: string, chatId: string, videoPath: string, caption?: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  if (!bot.botToken) return { success: false, error: 'Bot token missing' };
  try {
    const fs = require('fs');
    const FormDataNode = require('form-data');
    const form = new FormDataNode();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'video', videoPath);
    if (caption) form.append('caption', caption);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendVideo`, form, {
      headers: form.getHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
    if (!res.data?.ok) return { success: false, error: res.data?.description || 'Telegram API error' };
    const msgId = res.data?.result?.message_id ? String(res.data.result.message_id) : '';
    if (msgId) {
      const videoAttachments = res.data?.result?.video ? [{
        type: 'video', file_id: res.data.result.video.file_id,
        file_unique_id: res.data.result.video.file_unique_id,
        width: res.data.result.video.width, height: res.data.result.video.height,
        duration: res.data.result.video.duration, file_size: res.data.result.video.file_size,
      }] : [];
      await saveSentBotMessage(accountId, chatId, msgId, caption || '', 'video', videoAttachments);
    }
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi document/file qua Telegram Bot
 */
export async function sendDocument(accountId: string, chatId: string, filePath: string, caption?: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  if (!bot.botToken) return { success: false, error: 'Bot token missing' };
  try {
    const fs = require('fs');
    const FormDataNode = require('form-data');
    const form = new FormDataNode();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'document', filePath);
    if (caption) form.append('caption', caption);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendDocument`, form, {
      headers: form.getHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
    if (!res.data?.ok) return { success: false, error: res.data?.description || 'Telegram API error' };
    const msgId = res.data?.result?.message_id ? String(res.data.result.message_id) : '';
    if (msgId) {
      const docAttachments = res.data?.result?.document ? [{
        type: 'file', file_id: res.data.result.document.file_id,
        file_unique_id: res.data.result.document.file_unique_id,
        file_name: res.data.result.document.file_name,
        mime_type: res.data.result.document.mime_type,
        file_size: res.data.result.document.file_size,
      }] : [];
      await saveSentBotMessage(accountId, chatId, msgId, caption || '', 'file', docAttachments);
    }
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi audio qua Telegram Bot
 */
export async function sendAudio(accountId: string, chatId: string, audioPath: string, caption?: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  if (!bot.botToken) return { success: false, error: 'Bot token missing' };
  try {
    const fs = require('fs');
    const FormDataNode = require('form-data');
    const form = new FormDataNode();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'audio', audioPath);
    if (caption) form.append('caption', caption);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendAudio`, form, {
      headers: form.getHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
    if (!res.data?.ok) return { success: false, error: res.data?.description || 'Telegram API error' };
    const msgId = res.data?.result?.message_id ? String(res.data.result.message_id) : '';
    if (msgId) {
      const audioAttachments = res.data?.result?.audio ? [{
        type: 'audio', file_id: res.data.result.audio.file_id,
        duration: res.data.result.audio.duration,
        title: res.data.result.audio.title,
        file_size: res.data.result.audio.file_size,
      }] : [];
      await saveSentBotMessage(accountId, chatId, msgId, caption || '', 'audio', audioAttachments);
    }
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Chuyển tiếp tin nhắn
 */
export async function forwardMessage(accountId: string, chatId: string, fromChatId: string, messageId: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/forwardMessage`, {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true, messageId: String(res.data.result?.message_id || '') };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Xóa tin nhắn
 */
export async function deleteMessage(accountId: string, chatId: string, messageId: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Thêm reaction
 */
export async function addReaction(accountId: string, chatId: string, messageId: string, emoji: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/setMessageReaction`, {
      chat_id: chatId,
      message_id: messageId,
      reaction: JSON.stringify([{ type: 'emoji', emoji }]),
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Ghim tin nhắn
 */
export async function pinMessage(accountId: string, chatId: string, messageId: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/pinChatMessage`, {
      chat_id: chatId,
      message_id: messageId,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Tạo poll
 */
export async function sendPoll(accountId: string, chatId: string, question: string, options: string[]): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendPoll`, {
      chat_id: chatId,
      question,
      options: JSON.stringify(options),
      is_anonymous: false,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true, messageId: String(res.data.result?.message_id || '') };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Sửa tin nhắn
 */
export async function editMessage(accountId: string, chatId: string, messageId: string, text: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Gửi sticker
 */
export async function sendSticker(accountId: string, chatId: string, stickerPath: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'sticker', stickerPath);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendSticker`, form, {
      headers: form.getHeaders(), timeout: 30000,
    });
    if (!res.data?.ok) return { success: false, error: res.data?.description || 'Telegram API error' };
    const msgId = String(res.data?.result?.message_id || '');
    if (msgId) {
      const stickerAttachments = res.data?.result?.sticker ? [{
        type: 'sticker', is_sticker: true,
        sticker_format: res.data.result.sticker.is_animated ? 'tgs' : res.data.result.sticker.is_video ? 'webm' : 'webp',
        mime_type: res.data.result.sticker.is_animated ? 'application/x-tgsticker' : res.data.result.sticker.is_video ? 'video/webm' : 'image/webp',
        file_id: res.data.result.sticker.file_id,
        file_unique_id: res.data.result.sticker.file_unique_id,
        emoji: res.data.result.sticker.emoji,
      }] : [];
      await saveSentBotMessage(accountId, chatId, msgId, '', 'sticker', stickerAttachments);
    }
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi voice message
 */
export async function sendVoice(accountId: string, chatId: string, voicePath: string, caption?: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'voice', voicePath);
    if (caption) form.append('caption', caption);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendVoice`, form, {
      headers: form.getHeaders(), timeout: 30000,
    });
    if (!res.data?.ok) return { success: false, error: res.data?.description || 'Telegram API error' };
    const msgId = String(res.data?.result?.message_id || '');
    if (msgId) {
      const voiceAttachments = res.data?.result?.voice ? [{
        type: 'voice', file_id: res.data.result.voice.file_id,
        duration: res.data.result.voice.duration,
        file_size: res.data.result.voice.file_size,
      }] : [];
      await saveSentBotMessage(accountId, chatId, msgId, caption || '', 'voice', voiceAttachments);
    }
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi animation/GIF
 */
export async function sendAnimation(accountId: string, chatId: string, animPath: string, caption?: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'animation', animPath);
    if (caption) form.append('caption', caption);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendAnimation`, form, {
      headers: form.getHeaders(), timeout: 30000,
    });
    if (!res.data?.ok) return { success: false, error: res.data?.description || 'Telegram API error' };
    const msgId = String(res.data?.result?.message_id || '');
    if (msgId) {
      const animAttachments = res.data?.result?.animation ? [{
        type: 'gif', file_id: res.data.result.animation.file_id,
        file_unique_id: res.data.result.animation.file_unique_id,
        width: res.data.result.animation.width,
        height: res.data.result.animation.height,
        duration: res.data.result.animation.duration,
        file_size: res.data.result.animation.file_size,
        mime_type: res.data.result.animation.mime_type || '',
      }] : [];
      await saveSentBotMessage(accountId, chatId, msgId, caption || '', 'gif', animAttachments);
    }
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi video note (round video)
 */
export async function sendVideoNote(accountId: string, chatId: string, videoPath: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'video_note', videoPath);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendVideoNote`, form, {
      headers: form.getHeaders(), timeout: 30000,
    });
    if (!res.data?.ok) return { success: false, error: res.data?.description || 'Telegram API error' };
    const msgId = String(res.data?.result?.message_id || '');
    if (msgId) {
      const vnAttachments = res.data?.result?.video_note ? [{
        type: 'video_note',
        file_id: res.data.result.video_note.file_id,
        file_unique_id: res.data.result.video_note.file_unique_id,
        length: res.data.result.video_note.length,
        duration: res.data.result.video_note.duration,
        file_size: res.data.result.video_note.file_size,
      }] : [];
      await saveSentBotMessage(accountId, chatId, msgId, '', 'video_note', vnAttachments);
    }
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi contact
 */
export async function sendContact(accountId: string, chatId: string, phone: string, firstName: string, lastName?: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const payload: Record<string, any> = { chat_id: chatId, phone_number: phone, first_name: firstName };
    if (lastName) payload.last_name = lastName;
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendContact`, payload, { timeout: REQUEST_TIMEOUT });
    return { success: true, messageId: String(res.data?.result?.message_id || '') };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Gửi location
 */
export async function sendLocation(accountId: string, chatId: string, latitude: number, longitude: number): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendLocation`, {
      chat_id: chatId, latitude, longitude,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true, messageId: String(res.data?.result?.message_id || '') };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Hiển thị typing indicator
 */
export async function sendChatAction(accountId: string, chatId: string, action: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/sendChatAction`, {
      chat_id: chatId, action: action || 'typing',
    }, { timeout: 5000 });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Bỏ ghim tin nhắn
 */
export async function unpinChatMessage(accountId: string, chatId: string, messageId?: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const payload: Record<string, any> = { chat_id: chatId };
    if (messageId) payload.message_id = messageId;
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/unpinChatMessage`, payload, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Lấy số lượng thành viên nhóm
 */
export async function getChatMemberCount(accountId: string, chatId: string): Promise<ActionResult & { count?: number }> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const res = await axios.get(`${TELEGRAM_API}/bot${bot.botToken}/getChatMemberCount`, {
      params: { chat_id: chatId }, timeout: REQUEST_TIMEOUT,
    });
    if (res.data?.ok) return { success: true, count: res.data.result };
    return { success: false, error: res.data?.description || 'Failed' };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Hạn chế thành viên (mute/restrict)
 */
export async function restrictChatMember(accountId: string, chatId: string, userId: string, permissions: {
  canSendMessages?: boolean; canSendAudios?: boolean; canSendDocuments?: boolean;
  canSendPhotos?: boolean; canSendVideos?: boolean; canSendVideoNotes?: boolean;
  canSendVoiceNotes?: boolean; canSendPolls?: boolean; canSendOtherMessages?: boolean;
  canAddWebPagePreviews?: boolean; canChangeInfo?: boolean; canInviteUsers?: boolean;
  canPinMessages?: boolean;
}, untilDate?: number): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    const payload: Record<string, any> = {
      chat_id: chatId, user_id: userId,
      permissions: { ...permissions },
    };
    if (untilDate) payload.until_date = untilDate;
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/restrictChatMember`, payload, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Edit caption của media message
 */
export async function editMessageCaption(accountId: string, chatId: string, messageId: string, caption: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };
  try {
    await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/editMessageCaption`, {
      chat_id: chatId, message_id: messageId, caption,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

type ActionResult = { success: boolean; messageId?: string; error?: string };

/**
 * Start bot: registers inbox consumer with ingress and starts polling.
 */
export function startBot(account: TelegramBotAccount): void {
  if (registeredAccounts.has(account.accountId)) return;
  registeredAccounts.set(account.accountId, account);
  DatabaseService.getInstance()?.repairTelegramLastMessagePreviews(account.accountId, 'telegram_bot');

  // Create the inbox consumer for this account
  const consumer: BotUpdateConsumer = async (acc, update) => {
    Logger.log(`[TelegramBot] Received update: kind=${update.kind} accountId=${acc.accountId}`);
    // Handle both regular messages and channel posts
    if ((update.kind === 'message' || update.kind === 'channel_post') && update.message) {
      Logger.log(`[TelegramBot] Processing message from ${update.message.fromName}: ${(update.message.text || '').slice(0, 50)}`);
      await handleInboundMessage(acc, update.message.raw);
    }
  };

  BotIngress.startBot(account);
  BotIngress.registerConsumer(account.accountId, consumer);

  // Store consumer reference for cleanup
  (account as any)._inboxConsumer = consumer;

  // Emit connected event so UI knows bot is online
  try {
    const { EventBroadcaster } = require('../event/EventBroadcaster');
    EventBroadcaster.emit('event:connected', {
      zaloId: account.accountId,
      accountInfo: {
        full_name: account.botFirstName || account.botUsername || 'Telegram Bot',
        channel: 'telegram_bot',
      },
    });
  } catch {}

  Logger.log(`[TelegramBotChannel] Registered inbox consumer for ${account.accountId} (@${account.botUsername})`);
}

/**
 * Stop bot: unregisters consumer and stops ingress.
 */
export function stopBot(accountId: string): void {
  const account = registeredAccounts.get(accountId);
  if (account) {
    const consumer = (account as any)._inboxConsumer;
    if (consumer) BotIngress.unregisterConsumer(accountId, consumer);
  }
  registeredAccounts.delete(accountId);
  BotIngress.stopBot(accountId);

  // Emit disconnected event so UI knows bot is offline
  try {
    const { EventBroadcaster } = require('../event/EventBroadcaster');
    EventBroadcaster.emit('event:disconnected', {
      zaloId: accountId,
      reason: 'manual_disconnect',
    });
  } catch {}

  Logger.log(`[TelegramBotChannel] Stopped for ${accountId}`);
}

/**
 * Stop all bots
 */
export function stopAllBots(): void {
  for (const [id] of registeredAccounts) {
    stopBot(id);
  }
}

/**
 * Get active bot status
 */
export function getActiveBots(): TelegramBotAccount[] {
  return Array.from(registeredAccounts.values());
}

/**
 * Check if a bot is actively polling (not just registered).
 * Returns true if the bot's ingress poller is running.
 */
export function isBotPolling(accountId: string): boolean {
  return registeredAccounts.has(accountId) && BotIngress.isPollerRunning(accountId);
}

/**
 * Attempt to reconnect a bot if it's registered but not polling.
 * Returns true if reconnection was attempted.
 */
export function tryReconnectBot(accountId: string): boolean {
  const account = registeredAccounts.get(accountId);
  if (!account) return false;

  // Check if already polling
  if (BotIngress.isPollerRunning(accountId)) return false;

  // Re-register with ingress
  try {
    BotIngress.startBot(account);
    Logger.log(`[TelegramBotChannel] Reconnected bot ${accountId}`);
    return true;
  } catch (err: any) {
    Logger.warn(`[TelegramBotChannel] Failed to reconnect bot ${accountId}: ${err.message}`);
    return false;
  }
}

/**
 * Validate bot token bằng getMe
 */
export async function validateBotToken(botToken: string): Promise<{ success: boolean; bot?: any; error?: string }> {
  return BotIngress.validateBotToken(botToken);
}

// ─── Group Management API ────────────────────────────────────────────────────

/**
 * Lấy thông tin nhóm (tên, avatar, mô tả, thành viên)
 */
export async function getChat(accountId: string, chatId: string): Promise<ActionResult & { chat?: any }> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const res = await axios.get(`${TELEGRAM_API}/bot${bot.botToken}/getChat`, {
      params: { chat_id: chatId },
      timeout: REQUEST_TIMEOUT,
    });
    if (res.data?.ok) {
      return { success: true, chat: res.data.result };
    }
    return { success: false, error: res.data?.description || 'Failed' };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Lấy danh sách admin nhóm
 */
export async function getChatAdministrators(accountId: string, chatId: string): Promise<ActionResult & { admins?: any[] }> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const res = await axios.get(`${TELEGRAM_API}/bot${bot.botToken}/getChatAdministrators`, {
      params: { chat_id: chatId },
      timeout: REQUEST_TIMEOUT,
    });
    if (res.data?.ok) {
      return { success: true, admins: res.data.result };
    }
    return { success: false, error: res.data?.description || 'Failed' };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Lấy thông tin 1 thành viên trong nhóm
 */
export async function getChatMember(accountId: string, chatId: string, userId: string): Promise<ActionResult & { member?: any }> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const res = await axios.get(`${TELEGRAM_API}/bot${bot.botToken}/getChatMember`, {
      params: { chat_id: chatId, user_id: userId },
      timeout: REQUEST_TIMEOUT,
    });
    if (res.data?.ok) {
      return { success: true, member: res.data.result };
    }
    return { success: false, error: res.data?.description || 'Failed' };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Kick/ban thành viên khỏi nhóm
 */
export async function banChatMember(accountId: string, chatId: string, userId: string, untilDate?: number): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const payload: Record<string, any> = { chat_id: chatId, user_id: userId };
    if (untilDate) payload.until_date = untilDate;
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/banChatMember`, payload, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Bỏ ban thành viên
 */
export async function unbanChatMember(accountId: string, chatId: string, userId: string, onlyIfBanned?: boolean): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const payload: Record<string, any> = { chat_id: chatId, user_id: userId };
    if (onlyIfBanned !== undefined) payload.only_if_banned = onlyIfBanned;
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/unbanChatMember`, payload, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Promote/demote thành viên (admin, deputy)
 */
export async function promoteChatMember(accountId: string, chatId: string, userId: string, perms?: {
  canChangeInfo?: boolean; canDeleteMessages?: boolean; canInviteUsers?: boolean;
  canRestrictMembers?: boolean; canPinMessages?: boolean; canPromoteMembers?: boolean;
  canManageVideoChats?: boolean; canManageChat?: boolean;
}): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const payload: Record<string, any> = { chat_id: chatId, user_id: userId };
    if (perms) Object.assign(payload, perms);
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/promoteChatMember`, payload, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Rời khỏi nhóm
 */
export async function leaveChat(accountId: string, chatId: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/leaveChat`, { chat_id: chatId }, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Đổi avatar nhóm
 */
export async function setChatPhoto(accountId: string, chatId: string, photoPath: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', chatId);
    appendBotUpload(form, 'photo', photoPath);

    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/setChatPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Tạo link mời nhóm
 */
export async function exportChatInviteLink(accountId: string, chatId: string): Promise<ActionResult & { link?: string }> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/exportChatInviteLink`, { chat_id: chatId }, { timeout: REQUEST_TIMEOUT });
    if (res.data?.ok) {
      return { success: true, link: res.data.result };
    }
    return { success: false, error: res.data?.description || 'Failed' };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Xóa avatar nhóm
 */
export async function deleteChatPhoto(accountId: string, chatId: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/deleteChatPhoto`, { chat_id: chatId }, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

/**
 * Đặt mô tả nhóm
 */
export async function setChatDescription(accountId: string, chatId: string, description: string): Promise<ActionResult> {
  const bot = registeredAccounts.get(accountId);
  if (!bot) return { success: false, error: 'Bot not active' };

  try {
    const res = await axios.post(`${TELEGRAM_API}/bot${bot.botToken}/setChatDescription`, {
      chat_id: chatId, description,
    }, { timeout: REQUEST_TIMEOUT });
    return { success: !!res.data?.ok };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}
