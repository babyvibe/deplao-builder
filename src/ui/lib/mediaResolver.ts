/**
 * MediaResolver.ts - Abstract media access across channels
 * 
 * Facebook stores media in `msg.attachments` (JSON array).
 * Zalo stores media in `msg.content` (JSON object) + `msg.local_paths`.
 * 
 * UI code gọi resolver thay vì tự check msg.channel === 'facebook'.
 */

import { isFacebook, isTelegram } from '@/lib/channelHelper';
import { isTelegramMetaAttachment } from '../../shared/telegramAttachmentTypes';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MediaAttachment {
  type?: string;        // 'photo', 'video', 'file', 'audio', 'animated_image'
  url?: string;         // CDN URL
  href?: string;        // Alternative URL
  thumb?: string;       // Thumbnail URL
  localPath?: string;   // Local file path (after download)
  name?: string;        // File name
  file_name?: string;   // Telegram persistence field
  fileSize?: number;    // File size in bytes
  file_size?: number;   // Telegram persistence field
  mimeType?: string;
  mime_type?: string;
  is_sticker?: boolean;
  sticker_format?: 'tgs' | 'webm' | 'mp4' | 'webp' | string;
  emoji?: string;
  is_channel_post?: boolean;
  post_author?: string;
  views?: number;
  forwards?: number;
  comments?: number;
  discussion_channel_id?: string;
  recent_repliers?: string[];
  comments_max_id?: number;
  comments_read_max_id?: number;
  grouped_id?: string;
  // Video specific
  width?: number;
  height?: number;
  duration?: number;
  // E2EE
  directPath?: string;
  encKey?: string;
}

export interface MediaUrlResult {
  remoteUrl: string;
  localUrl: string;
  thumbUrl: string;
}

export interface FileMetadata {
  title: string;
  href: string;
  fileSize: number;
  ext: string;
}

export interface StatusDisplay {
  text: string;
  showCheckmark: boolean;
}

// ─── Message interface (minimal, matches existing MessageItem) ────────────────

interface MsgLike {
  channel?: string;
  msg_type?: string;
  content?: string;
  attachments?: string;   // JSON string of MediaAttachment[]
  local_paths?: string;   // JSON string of local file paths
  is_sent?: number;
  is_self?: number;
  sender_id?: string;
  owner_zalo_id?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParse(json: string | undefined): any[] {
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}

// ─── Core Resolver Functions ─────────────────────────────────────────────────

/**
 * Extract all attachments from message.
 * Facebook: parse msg.attachments JSON array.
 * Telegram: parse msg.attachments JSON array (Bot API saves file_id, User API saves media info).
 * Zalo: return empty (Zalo uses content params instead).
 */
export function extractAttachments(msg: MsgLike): MediaAttachment[] {
  if (isFacebook(msg.channel) || isTelegram(msg.channel)) {
    return safeParse(msg.attachments);
  }
  return [];
}

/**
 * Get first attachment of given type (or any type if not specified).
 */
export function getFirstAttachment(msg: MsgLike, type?: string): MediaAttachment | null {
  const atts = extractAttachments(msg);
  if (type) return atts.find(a => a.type === type) || null;
  // Presentation-only Telegram metadata is stored alongside media but must
  // never shadow the actual photo/video/file attachment.
  return atts.find(a => !isTelegramMetaAttachment(a)) || null;
}

/**
 * Get remote URL for image/video/media.
 * Facebook/Telegram: from attachments[].url
 * Zalo: from content.params.hd/rawUrl/href (parsed by caller)
 */
export function getRemoteMediaUrl(msg: MsgLike): string {
  if (!isFacebook(msg.channel) && !isTelegram(msg.channel)) return '';
  const att = getFirstAttachment(msg);
  return att?.url || att?.href || att?.thumb || '';
}

/**
 * Get local file path for media.
 * Facebook/Telegram: from attachments[].localPath, fallback to msg.local_paths JSON
 * Zalo: from local_paths JSON or content.params.localPath
 */
export function getLocalMediaPath(msg: MsgLike, mediaType?: string): string {
  if (isFacebook(msg.channel) || isTelegram(msg.channel)) {
    const atts = extractAttachments(msg);
    if (mediaType) {
      const typed = atts.find(a => a.type === mediaType);
      if (typed?.localPath) return typed.localPath;
    }
    const firstMedia = atts.find(a => !isTelegramMetaAttachment(a));
    if (firstMedia?.localPath) return firstMedia.localPath;

    // Fallback: check local_paths column (Telegram stores paths here after download)
    if (msg.local_paths) {
      try {
        const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths) : msg.local_paths;
        return lp?.main || lp?.video || lp?.voice || lp?.file || '';
      } catch {}
    }
    return '';
  }
  // Zalo: caller handles from local_paths or content
  return '';
}

/**
 * Get thumbnail URL.
 * Facebook/Telegram: from attachments[].thumb
 * Zalo: from content.params.thumbnailUrl
 */
export function getThumbUrl(msg: MsgLike): string {
  if (!isFacebook(msg.channel) && !isTelegram(msg.channel)) return '';
  const att = getFirstAttachment(msg);
  return att?.thumb || att?.url || '';
}

/**
 * Get file metadata (title, href, size, ext).
 * Facebook: from attachments[0].name/url/fileSize
 * Zalo: from content.params.title/href/fileSize/fileExt
 */
export function getFileMetadata(msg: MsgLike): FileMetadata {
  if (isFacebook(msg.channel) || isTelegram(msg.channel)) {
    const att = getFirstAttachment(msg, 'file') || getFirstAttachment(msg);
    const name = att?.name || att?.file_name || '';
    let title = name;
    if (!title || title === 'File') {
      try {
        const parsed = JSON.parse(msg.content || '{}');
        title = parsed.title || '';
      } catch {}
    }
    if (!title || title === 'File') {
      const match = (msg.content || '').match(/📎\s*(.+)/);
      title = match?.[1] || 'File';
    }
    return {
      title,
      href: att?.url || att?.href || '',
      fileSize: att?.fileSize || att?.file_size || 0,
      ext: title.includes('.') ? title.split('.').pop() || '' : '',
    };
  }
  return { title: '', href: '', fileSize: 0, ext: '' };
}

/**
 * Get video local path.
 * Facebook/Telegram: from attachments[].localPath where type='video'
 * Zalo: from content.params.localPath
 */
export function getVideoLocalPath(msg: MsgLike): string {
  if (isFacebook(msg.channel) || isTelegram(msg.channel)) {
    const attachments = extractAttachments(msg);
    const attachment = attachments.find(item => ['video', 'gif', 'video_note'].includes(item.type || ''));
    return attachment?.localPath || getLocalMediaPath(msg, attachment?.type || 'video');
  }
  return '';
}

/**
 * Get voice/audio local path.
 * Facebook/Telegram: from attachments[].localPath where type='audio'
 * Zalo: from content.params.localPath
 */
export function getAudioLocalPath(msg: MsgLike): string {
  if (isFacebook(msg.channel) || isTelegram(msg.channel)) {
    const attachments = extractAttachments(msg);
    const attachment = attachments.find(item => item.type === 'audio' || item.type === 'voice');
    return attachment?.localPath || getLocalMediaPath(msg, attachment?.type || 'audio');
  }
  return '';
}

/**
 * Get sticker data.
 * Facebook: from attachments[] where type='sticker'
 * Zalo: from content.params.stickerId/normalUrl
 */
export function getStickerData(msg: MsgLike): { url: string; localPath?: string; directPath?: string; encKey?: string } | null {
  if (isFacebook(msg.channel) || isTelegram(msg.channel)) {
    const att = extractAttachments(msg).find(a =>
      a.type === 'sticker' || a.type === 'animated_image' || a.directPath
    );
    if (!att) return null;
    return {
      url: att.url || '',
      localPath: att.localPath,
      directPath: att.directPath,
      encKey: att.encKey,
    };
  }
  return null;
}

/**
 * Return Telegram sticker metadata without inferring it from the downloaded
 * extension. The listener persists is_sticker from DocumentAttributeSticker.
 */
export function getTelegramStickerMedia(msg: MsgLike): {
  localPath: string;
  remoteUrl: string;
  format: string;
} | null {
  if (!isTelegram(msg.channel)) return null;
  const attachment = extractAttachments(msg).find((item) =>
    item.is_sticker === true || item.type === 'sticker'
  );
  if (!attachment) return null;

  let localPath = attachment.localPath || '';
  if (!localPath) {
    try {
      const paths = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}')
        : (msg.local_paths || {});
      localPath = paths.sticker || paths.file || paths.main || paths.video || '';
    } catch {}
  }
  const source = localPath || attachment.url || attachment.href || '';
  const mimeType = attachment.mime_type || attachment.mimeType || '';
  const format = attachment.sticker_format ||
    (mimeType.includes('tgsticker') || mimeType.includes('lottie') ? 'tgs' :
      mimeType.includes('webm') ? 'webm' :
        mimeType.includes('mp4') ? 'mp4' :
          source.toLowerCase().endsWith('.tgs') ? 'tgs' :
            source.toLowerCase().endsWith('.webm') ? 'webm' :
              source.toLowerCase().endsWith('.mp4') ? 'mp4' : 'webp');
  return { localPath, remoteUrl: attachment.url || attachment.href || '', format };
}

export function getTelegramPostMeta(msg: MsgLike): {
  postAuthor: string;
  views: number;
  forwards: number;
  comments: number;
  discussionChannelId: string;
  /** id người bình luận gần đây (ảnh nhỏ ở thanh bình luận, như Telegram) */
  recentRepliers: string[];
  /** Bình luận mới nhất / mình đã đọc tới (0 = chưa từng mở phần bình luận) → chấm "chưa đọc" */
  commentsMaxId: number;
  commentsReadMaxId: number;
} | null {
  if (!isTelegram(msg.channel)) return null;
  const attachment = extractAttachments(msg).find((item) =>
    item.type === 'telegram_post' || item.is_channel_post === true
  );
  if (!attachment) return null;
  return {
    postAuthor: String(attachment.post_author || ''),
    views: Math.max(0, Number(attachment.views || 0)),
    forwards: Math.max(0, Number(attachment.forwards || 0)),
    comments: Math.max(0, Number(attachment.comments || 0)),
    discussionChannelId: String(attachment.discussion_channel_id || ''),
    recentRepliers: Array.isArray(attachment.recent_repliers) ? attachment.recent_repliers.map(String).filter(Boolean) : [],
    commentsMaxId: Math.max(0, Number(attachment.comments_max_id || 0)),
    commentsReadMaxId: Math.max(0, Number(attachment.comments_read_max_id || 0)),
  };
}

export interface TelegramForwardMeta {
  /** user / channel / chat; hidden = người gốc ẩn tài khoản khi chuyển tiếp (chỉ có tên) */
  fromType: 'user' | 'channel' | 'chat' | 'hidden';
  fromId: string;
  fromName: string;
  fromUsername: string;
  /** Chữ ký người đăng của bài kênh gốc */
  postAuthor: string;
}

/** Tin Telegram được chuyển tiếp (attachments type telegram_forward, TelegramUserListener) → nguồn gốc; không phải → null. */
export function getTelegramForwardMeta(msg: MsgLike): TelegramForwardMeta | null {
  if (!isTelegram(msg.channel)) return null;
  const attachment = extractAttachments(msg).find((item) => item.type === 'telegram_forward') as Record<string, any> | undefined;
  if (!attachment) return null;
  const fromType = ['user', 'channel', 'chat', 'hidden'].includes(String(attachment.from_type))
    ? attachment.from_type as TelegramForwardMeta['fromType']
    : 'user';
  return {
    fromType,
    fromId: String(attachment.from_id || ''),
    fromName: String(attachment.from_name || ''),
    fromUsername: String(attachment.from_username || ''),
    postAuthor: String(attachment.post_author || ''),
  };
}

/**
 * Get status display text.
 * Facebook: always "✓ Đã gửi" (no read receipts)
 * Telegram: "✓ Đã xem" if status='read', otherwise "✓ Đã gửi"
 * Zalo: based on is_sent/is_read flags
 */
export function getStatusDisplay(msg: MsgLike, isSelf: boolean): StatusDisplay {
  if (isFacebook(msg.channel)) {
    if (msg.is_sent === 1 || isSelf) {
      return { text: '✓ Đã gửi', showCheckmark: true };
    }
    return { text: '', showCheckmark: false };
  }
  if (isTelegram(msg.channel)) {
    if (msg.is_sent === 1 || isSelf) {
      const isRead = (msg as any).status === 'read';
      return { text: isRead ? '✓ Đã xem' : '✓ Đã gửi', showCheckmark: true };
    }
    return { text: '', showCheckmark: false };
  }
  return { text: '', showCheckmark: false };
}

/**
 * Check if message is a file attachment (not image/video/sticker).
 * Facebook: check attachments type
 * Zalo: check msg_type === 'file'
 */
export function isFileAttachment(msg: MsgLike): boolean {
  if (isFacebook(msg.channel)) {
    const att = getFirstAttachment(msg);
    return att?.type === 'file';
  }
  return msg.msg_type === 'file';
}

/**
 * Check if media should be grouped in gallery layout.
 * Facebook: all media types except sticker
 * Zalo: images only
 */
export function isGroupableMedia(msg: MsgLike): boolean {
  if (isFacebook(msg.channel)) {
    const att = getFirstAttachment(msg);
    return !!att && att.type !== 'sticker';
  }
  return msg.msg_type === 'image';
}

/**
 * Get remote video URL for playback.
 * Facebook: from attachments[].url
 * Zalo: from content.params (caller parses)
 */
export function getVideoRemoteUrl(msg: MsgLike): string {
  if (isFacebook(msg.channel)) {
    const att = getFirstAttachment(msg, 'video') || getFirstAttachment(msg);
    return att?.url || att?.href || att?.thumb || '';
  }
  return ''; // Zalo: caller handles
}

/**
 * Get image local paths (for gallery display).
 * Facebook: from attachments[].localPath where type='photo'
 * Zalo: from local_paths JSON
 */
export function getImageLocalPaths(msg: MsgLike): string[] {
  if (isFacebook(msg.channel)) {
    return extractAttachments(msg)
      .filter(a => a.type === 'photo' && a.localPath)
      .map(a => a.localPath!);
  }
  return []; // Zalo: caller handles
}

/**
 * Get image remote URLs (for gallery display).
 * Facebook: from attachments[].url where type='photo'
 * Zalo: from content params
 */
export function getImageRemoteUrls(msg: MsgLike): string[] {
  if (isFacebook(msg.channel)) {
    return extractAttachments(msg)
      .filter(a => a.type === 'photo' && a.url)
      .map(a => a.url!);
  }
  return []; // Zalo: caller handles
}
