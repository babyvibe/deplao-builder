/**
 * messageParser.ts - Helpers that parse message content (content, quote, media URL, etc.)
 * Shared by ChatWindow, MessageBubbles, and other components.
 */
import React from 'react';
import { convertZaloEmojis } from './emojiUtils';
import { zinstantPreviewText } from '../../../../shared/zalo/zaloZinstant';
import { isLinkableUrl, trimUrlEnd } from '../../../../shared/chat/urlText';
import { tr, appLocale } from '../../../../shared/i18n';

export { trimUrlEnd };

/**
 * Parses msg.content into plain text for the preview.
 * Priority: content.msg > content.message > content.content > content.title > raw text
 */
export function parseTxt(content: string): string {
  if (!content || content === 'null') return '';
  try {
    const p = JSON.parse(content);
    if (p === null || p === undefined) return '';
    if (typeof p === 'string') return convertZaloEmojis(p);
    if (typeof p !== 'object') return convertZaloEmojis(String(p));
    if (p?.action === 'zinstant.bankcard') return tr('🏦 [Tài khoản ngân hàng]');
    if (p?.content && typeof p.content === 'string') return convertZaloEmojis(p.content);
    if (p?.msg && typeof p.msg === 'string') return convertZaloEmojis(p.msg);
    if (p?.message && typeof p.message === 'string') return convertZaloEmojis(p.message);
    if (p?.title && typeof p.title === 'string' && !p.href && !p.thumb) return convertZaloEmojis(p.title);
    return '';
  } catch { return convertZaloEmojis(content); }
}

/** A native mention range, stored with the message attachments. */
export interface MentionRange {
  offset: number;
  length: number;
  userId?: string;
  username?: string;
  isAll?: boolean;
}

/** Kept as an alias while older call sites migrate to platform-neutral mentions. */
export type TelegramMentionRange = MentionRange;

/** Read native Zalo, Telegram and Facebook mention entities without a DB migration. */
export function getMentionRanges(attachments: unknown): MentionRange[] {
  let parsed = attachments;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((attachment: any) =>
      attachment?.type === 'telegram_mention' || attachment?.type === 'zalo_mention' || attachment?.type === 'fb_mention'
    )
    .map((attachment: any) => ({
      offset: Number(attachment.offset),
      length: Number(attachment.length),
      userId: attachment.user_id && String(attachment.user_id) !== '-1'
        ? String(attachment.user_id)
        : undefined,
      username: attachment.username ? String(attachment.username).replace(/^@/, '') : undefined,
      isAll: attachment.kind === 'all' || String(attachment.user_id || '') === '-1',
    }))
    .filter((mention: MentionRange) =>
      Number.isInteger(mention.offset) && mention.offset >= 0
      && Number.isInteger(mention.length) && mention.length > 0
    )
    .sort((a: MentionRange, b: MentionRange) => a.offset - b.offset);
}

/** Backwards-compatible name for callers that only render Telegram messages. */
export function getTelegramMentionRanges(attachments: unknown): TelegramMentionRange[] {
  return getMentionRanges(attachments);
}

/**
 * URLs detected in a message: shared by linkifyText and findUrlRanges. Brackets and single quotes INSIDE a link still belong to the link
 * (Shopee: "…-Samsung-Galaxy-A56-5G-(8GB-128GB)-Hàng-Chính-Hãng…", Wikipedia "…_(định_hướng)"); extra punctuation / closing brackets
 * at the end are removed by trimUrlEnd (shared/chat/urlText). Before, a link stopped at the first ")": the second half of a Shopee link became
 * plain text.
 */
const LINK_URL_REGEX = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|[a-zA-Z0-9._-]+\.(com|vn|net|org|io|dev|app|me|co|xyz|info|tv|gg|link|page|site|online|tech|store|fun|icu|top|cc|pw|tk|ml|ga|cf|gq)(?:\/[^\s<>"]*)?)/g;

/**
 * Email addresses (e.g. ten.khach@gmail.com): the WHOLE address is matched before URLs / mentions are checked. Before, the "@" of an
 * email was treated as a mention and the domain "gmail.com" became its own link, so the email showed as a blue tag.
 */
// Lookbehind: only tries from the start of a run of characters, does not rescan every position inside a long string (messages containing base64...)
const EMAIL_REGEX = /(?<![a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/g;
const EMAIL_EXACT_REGEX = new RegExp(`^(?:${EMAIL_REGEX.source})$`);

function collectRanges(text: string, source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!text) return ranges;
  const re = new RegExp(source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Positions [start, end) of the email addresses in the text. */
export function findEmailRanges(text: string): Array<[number, number]> {
  return collectRanges(text, EMAIL_REGEX.source);
}

/**
 * Positions [start, end) of the URLs in the text (same regex + tail trimming as linkifyText). Used so that an "@" inside a
 * URL (e.g. threads.com/@user/post/…) is not treated as a mention. A domain inside an email (gmail.com of a@gmail.com) is not a URL.
 */
export function findUrlRanges(text: string): Array<[number, number]> {
  if (!text) return [];
  const emails = findEmailRanges(text);
  const ranges: Array<[number, number]> = [];
  const re = new RegExp(LINK_URL_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    const url = trimUrlEnd(m[0]);
    if (!isLinkableUrl(url)) continue;
    ranges.push([m.index, m.index + url.length]);
    // The part just cut off (punctuation, closing brackets) is scanned again as plain text
    re.lastIndex = m.index + url.length;
  }
  return ranges.filter(([start, end]) => !emails.some(([emailStart, emailEnd]) => start >= emailStart && end <= emailEnd));
}

/** URL + email: an "@" inside these ranges belongs to the link / email address, not a mention. */
export function findLinkRanges(text: string): Array<[number, number]> {
  return [...findUrlRanges(text), ...findEmailRanges(text)].sort((a, b) => a[0] - b[0]);
}

/**
 * Tapping a link in a message: the in-app link opener (lib/chat/links/chatLinks registers itself when loaded: Zalo / Telegram group links open the
 * conversation inside the app). If not registered yet (tests, screen not loaded), it opens in the machine's browser as before.
 */
let chatLinkOpener: ((url: string) => void) | null = null;
export function setChatLinkOpener(opener: ((url: string) => void) | null): void {
  chatLinkOpener = opener;
}
function openMessageLink(url: string): void {
  if (chatLinkOpener) chatLinkOpener(url);
  else { try { window.electronAPI?.shell?.openExternal?.(url); } catch {} }
}

/** Link in a message (URL, email). chat-link: light sky blue in the dark theme, no underline (index.css); the light theme stays as it is. */
const LINK_CLASS = 'chat-link text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer break-all';

/**
 * Detects URLs and @mentions in the text → returns React nodes.
 * - URLs: clickable links
 * - @name: blue highlight (mention in a group chat)
 * - @@, @@@: NOT matched (only @ + at least 1 letter/digit is matched)
 * - email (a@gmail.com): ONE mailto: link for the whole address: not a mention, and the domain does not become a separate link
 */
export function linkifyText(text: string, options: { detectMentions?: boolean } = {}): React.ReactNode[] {
  if (!text) return [text];
  const detectMentions = options.detectMentions !== false;
  // URL regex (unchanged)
  const urlRegex = LINK_URL_REGEX;
  // @mention regex: @ + at least 1 letter/digit/underscore. The boundary is
  // validated below because this pattern is combined with the URL pattern.
  const mentionRegex = /@([a-zA-Z0-9_][a-zA-Z0-9_]*)/g;
  // Combined: email first (the whole address), then URL, mention last (URL takes priority over mention)
  const combinedRegex = new RegExp(
    detectMentions
      ? `(${EMAIL_REGEX.source})|(${urlRegex.source})|(${mentionRegex.source})`
      : `(${EMAIL_REGEX.source})|(${urlRegex.source})`,
    'g'
  );

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combinedRegex.exec(text)) !== null) {
    // Add the text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];

    // Email: one mailto: link for the whole address (tapping opens the mail app, as in Telegram), the domain is not split into its own link,
    // "@" is not a mention
    if (EMAIL_EXACT_REGEX.test(raw)) {
      const mailto = `mailto:${raw}`;
      parts.push(
        React.createElement('a', {
          key: `mail-${match.index}`,
          href: mailto,
          className: LINK_CLASS,
          onClick: (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            openMessageLink(mailto);
          },
          title: raw,
        }, raw)
      );
      lastIndex = match.index + raw.length;
      continue;
    }

    // Do not turn the second @ in @@name (or an @ embedded in a word) into a
    // mention. Telegram only treats a standalone @username token as a link.
    const before = match.index > 0 ? text[match.index - 1] : '';
    const isMention = detectMentions
      && raw.startsWith('@')
      && before !== '@'
      && !/[a-zA-Z0-9_]/.test(before);

    if (isMention) {
      // @mention: blue highlight, does NOT create a link
      parts.push(
        React.createElement('span', {
          key: `mention-${match.index}`,
          className: 'text-blue-400 font-medium cursor-default',
          title: raw,
        }, raw)
      );
    } else if (raw.startsWith('@')) {
      // This was a regex hit inside @@name / a word. Keep it as plain text.
      parts.push(raw);
    } else {
      // URL link: extra punctuation / closing brackets at the end are removed (trimUrlEnd); the removed part is scanned again as plain text
      const url = trimUrlEnd(raw);
      if (!isLinkableUrl(url)) {
        parts.push(raw);
        lastIndex = match.index + raw.length;
        continue;
      }
      const href = url.startsWith('http') ? url : `https://${url}`;
      parts.push(
        React.createElement('a', {
          key: `link-${match.index}`,
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: LINK_CLASS,
          onClick: (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            openMessageLink(href);
          },
          title: href,
        }, url)
      );
      lastIndex = match.index + url.length;
      combinedRegex.lastIndex = lastIndex;
      continue;
    }
    lastIndex = match.index + raw.length;
  }

  // Add the remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

/**
 * Parses content for display in the bubble, including the attachment markers.
 * Unlike parseTxt: parseContent returns '[Đính kèm]' (Attachment) for links / files / params.
 */
export function parseContent(content: string, msgType?: string, channel?: string | null): string {
  if (!content || content === 'null') return '';
  // Telegram keeps the text the sender typed (":))" stays ":))" as in Telegram); text emoticon codes are a Zalo convention
  if (typeof channel === 'string' && channel.startsWith('telegram')) {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed !== 'object' || parsed === null) return content;
    } catch {
      return content;
    }
  }
  // Official Account news / notifications (zinstant): the OA's text instead of "[Đính kèm]" (Attachment) / a JSON string
  const zinstant = zinstantPreviewText(content, msgType);
  if (zinstant) return zinstant;
  // Location message (chat.location.new): show description or coordinates
  if (msgType === 'chat.location.new') {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.description) return `📍 ${parsed.description}`;
      const params = typeof parsed?.params === 'string' ? JSON.parse(parsed.params) : (parsed?.params || {});
      if (params?.latitude && params?.longitude) return `📍 ${params.latitude.slice(0, 8)}, ${params.longitude.slice(0, 8)}`;
    } catch {}
    return tr('📍 [Vị trí]');
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed === null || parsed === undefined) return '';
    if (typeof parsed === 'string') return convertZaloEmojis(parsed);
    if (typeof parsed !== 'object') return convertZaloEmojis(String(parsed));
    if (parsed?.action === 'zinstant.bankcard') return tr('🏦 [Tài khoản ngân hàng]');
    if (parsed?.content && typeof parsed.content === 'string') return convertZaloEmojis(parsed.content);
    if (parsed?.msg && typeof parsed.msg === 'string') return convertZaloEmojis(parsed.msg);
    if (parsed?.message && typeof parsed.message === 'string') return convertZaloEmojis(parsed.message);
    if (parsed?.href || parsed?.thumb || parsed?.params) return tr('[Đính kèm]');
    if (parsed?.title) return parsed.title;
    return JSON.stringify(parsed);
  } catch {
    return convertZaloEmojis(content) || '';
  }
}

/** Fake caption generated by the app / platform for media messages (not text the sender typed). */
const MEDIA_CAPTION_PLACEHOLDER = /^(?:[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?\s*)?\[?(?:hình ảnh|ảnh|image|photo|video|sticker|gif|file|tệp|ghi âm|voice|link)\]?$/iu;

function cleanQuoteCaption(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text === 'null' || /^https?:\/\//i.test(text)) return '';
  if (MEDIA_CAPTION_PLACEHOLDER.test(text) || /^\[[^\]]*\]$/.test(text)) return '';
  return text;
}

function captionFromQuotePart(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return cleanQuoteCaption(obj.title) || cleanQuoteCaption(obj.caption) || cleanQuoteCaption(obj.description);
  }
  const text = String(value).trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') return cleanQuoteCaption(parsed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return captionFromQuotePart(parsed);
    } catch {
      /* not JSON → treated as plain text */
    }
    return '';
  }
  return cleanQuoteCaption(text);
}

/**
 * Caption of a quoted photo / video / sticker: so the quote block shows both the image and the text, as
 * in Telegram. Zalo: `attach.title` (msg empty); Telegram / Facebook: `msg` is the plain text; if missing it is taken from the content of the
 * original message (`originalContent`, JSON with a title or plain text). Returns '' when there is only a label such as "[Hình ảnh]" (Image).
 */
export function getQuotedMediaCaption(
  quote: { msg?: unknown; attach?: unknown } | null | undefined,
  originalContent?: unknown,
): string {
  if (!quote) return captionFromQuotePart(originalContent);
  return captionFromQuotePart(quote.attach) || captionFromQuotePart(quote.msg) || captionFromQuotePart(originalContent);
}

/** A Telegram attachment that is only extra information (album, channel post, mention...), not the content of the message. */
const TELEGRAM_META_ATTACHMENTS = new Set(['telegram_grouped_media', 'telegram_post', 'telegram_mention', 'telegram_forward']);
/** Text the app sets itself when a Telegram message has no caption (listener / file sent): the quote shows the right type label instead of this text. */
const TELEGRAM_QUOTE_PLACEHOLDERS = new Set(['🎵 Audio', '📎 Tệp đính kèm', '📎 File', '🎬 Video', '🖼️ Hình ảnh', '🎤 Tin nhắn thoại']);

export interface TelegramQuoteMedia {
  /** Label when the message has no caption: "Video", "😌 Sticker", "🎤 Tin nhắn thoại" (Voice message), "📎 bao-gia.pdf"... */
  label: string;
  /** Thumbnail already in the message (blurred cover of a video / GIF / round video, data URL). */
  thumb: string;
  /** Prefix placed before the message text (poll: the question; contact: the name). */
  prefix?: string;
  sticker?: boolean;
}

/**
 * A quoted Telegram message is labelled by its type (as in Telegram): video / GIF / round video show their cover image, a sticker shows its emoji, voice,
 * music, files show their name... Before, only the Zalo labels (chat.video.msg, chat.sticker...) existed → replying to a Telegram video / sticker showed "[Tin nhắn]" (Message). `attach` = the attachments of the original message (a JSON string or an array) in quote_data.
 */
export function telegramQuoteMedia(msgType: string | undefined, attach: unknown): TelegramQuoteMedia | null {
  let list: any[] = [];
  try {
    const parsed = typeof attach === 'string' ? JSON.parse(attach || '[]') : attach;
    list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
  } catch { list = []; }
  const media = list.find((item: any) => item && typeof item === 'object' && !TELEGRAM_META_ATTACHMENTS.has(String(item.type || ''))) || {};
  const kind = String(media.type || '');
  const type = String(msgType || '');
  const thumb = typeof media.stripped_thumb === 'string' && media.stripped_thumb.startsWith('data:image/') ? media.stripped_thumb : '';
  const fileName = String(media.title || media.file_name || media.name || '').trim();
  if (type === 'video_note' || kind === 'video_note') return { label: tr('Tin nhắn video'), thumb };
  if (kind === 'gif' || kind === 'animation') return { label: 'GIF', thumb };
  if (type === 'video' || kind === 'video') return { label: tr('Video'), thumb };
  if (type === 'sticker' || kind === 'sticker') {
    return { label: media.emoji ? tr('{{emoji}} Sticker', { emoji: media.emoji }) : tr('Sticker'), thumb: '', sticker: true };
  }
  if (kind === 'voice') return { label: tr('🎤 Tin nhắn thoại'), thumb: '' };
  if (type === 'audio' || kind === 'audio') return { label: `🎵 ${fileName || tr('Âm thanh')}`, thumb: '' };
  if (type === 'file' || kind === 'file' || kind === 'document') return { label: `📎 ${fileName || tr('File')}`, thumb: '' };
  if (type === 'telegram.poll' || kind === 'poll') {
    return { label: `📊 ${String(media.question || '').trim() || tr('Bình chọn')}`, thumb: '', prefix: '📊 ' };
  }
  if (type === 'telegram.location' || kind === 'location') return { label: tr('📍 Vị trí'), thumb: '', prefix: '📍 ' };
  if (type === 'telegram.contact' || kind === 'contact') return { label: `👤 ${String(media.name || '').trim() || tr('Liên hệ')}`, thumb: '', prefix: '👤 ' };
  if (type === 'deleted') return { label: tr('Tin đã xoá'), thumb: '' };
  return null;
}

/** The text of a quoted Telegram message is text the app sets itself (not a caption the sender typed). */
export function isTelegramQuotePlaceholder(text: string): boolean {
  return TELEGRAM_QUOTE_PLACEHOLDERS.has(String(text || '').trim());
}

/**
 * Shows the content of a quoted message: msgType from the DB first, then parses the structure of msg.
 * Used for the quote / reply preview.
 */
export function parseQuoteMsg(msg: string, msgType?: string): string {
  if (!msg || msg === 'null') {
    // msg is empty but msgType gives the type → return the fallback at once
    if (msgType === 'chat.recommended' || msgType === 'chat.link') return '[Link]';
    if (msgType === 'share.file' || msgType === 'file') return '[File]';
    if (msgType === 'share.link') return '[Link]';
    if (msgType === 'chat.photo' || msgType === 'photo' || msgType === 'image') return tr('[Hình ảnh]');
    if (msgType === 'chat.video.msg') return '[Video]';
    if (msgType === 'chat.voice') return tr('🎤 [Ghi âm]');
    if (msgType === 'chat.sticker') return '[Sticker]';
    if (msgType === 'chat.poll') return tr('[Bình chọn]');
    if (msgType === 'chat.webcontent') return tr('🏦 [Tài khoản ngân hàng]');
    if (msgType === 'chat.location.new') return tr('📍 [Vị trí]');
    return '';
  }

  // If msgType is in the DB → use it to determine the type first
  if (msgType) {
    // For special types, check msgType before parsing msg
    if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') {
      return tr('[Hình ảnh]');
    }
    if (msgType === 'chat.video.msg') {
      return '[Video]';
    }
    if (msgType === 'chat.voice') {
      return tr('🎤 [Ghi âm]');
    }
    if (msgType === 'chat.sticker') {
      return '[Sticker]';
    }
    if (msgType === 'chat.poll') {
      return tr('[Bình chọn]');
    }
    if (msgType === 'chat.webcontent' || msgType === 'chat.webcontent.v2') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.action === 'zinstant.bankcard') return tr('🏦 [Tài khoản ngân hàng]');
      } catch {}
      const zinstant = zinstantPreviewText(msg, msgType);
      if (zinstant) return zinstant;
    }
    // chat.recommended / chat.link = shared link, parse msg to get the title
    if (msgType === 'chat.recommended' || msgType === 'chat.link') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object') {
          let paramsObj = parsed.params;
          if (typeof paramsObj === 'string') { try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; } }
          const title = parsed.title || paramsObj?.mediaTitle || parsed.description;
          if (title) return `Link: ${title}`;
        }
      } catch {}
      return '[Link]';
    }
    // For share.file and share.link → need to parse msg to get the title
    if (msgType === 'share.file' || msgType === 'share.link' || msgType === 'file') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object' && parsed.title) {
          return `File: ${parsed.title}`;
        }
      } catch {}
      return msgType === 'share.link' ? '[Link]' : '[File]';
    }
  }

  // Try parsing JSON to get the text or analyse the structure
  try {
    const parsed = JSON.parse(msg);

    // If the parse gives a plain string → this is a text message
    if (typeof parsed === 'string') return parsed;

    if (parsed && typeof parsed === 'object') {
      // Parse params if present
      let paramsObj = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }

      // 1. Check the text message first (msg/content field)
      if (parsed.msg && typeof parsed.msg === 'string') return String(parsed.msg);
      if (parsed.content && typeof parsed.content === 'string') return String(parsed.content);

      // 2. Check LINK with action="recommened.link"
      if (parsed.action === 'recommened.link' || parsed.action === 'recommended.link') {
        // Prefer the original title (may contain the user's text), fall back to mediaTitle
        const mediaTitle = parsed.title || paramsObj?.mediaTitle;
        if (mediaTitle) return `Link: ${mediaTitle}`;
        return '[Link]';
      }

      // 3. Check photo / video / file
      if (paramsObj?.hd || paramsObj?.rawUrl) return tr('[Hình ảnh]');
      if (parsed.href && parsed.title) return `File: ${parsed.title}`;
      if (parsed.href) return '[Link]';
      if (parsed.thumb) return tr('[Hình ảnh]');

      // 4. Check title
      if (parsed.title) return parsed.title;

      // 5. Check the message field
      if (parsed.message && typeof parsed.message === 'string') return parsed.message;
    }
  } catch {}

  // Fallback: return plain text
  return msg;
}

/**
 * Extracts a photo URL from any object (params, content, attachment).
 */
export function extractUrlFromObj(obj: any): string {
  if (!obj || typeof obj !== 'object') return '';
  let p: any = obj.params;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  return (p?.hd || p?.rawUrl || p?.normalUrl)
    || obj.normalUrl || obj.hdUrl || obj.hd
    || obj.href || obj.thumb || obj.url || obj.src
    || '';
}

/**
 * Extracts the photo URL from quote content: ONLY for real photos, not links / files.
 */
export function extractQuoteImage(msg: any, attach?: any, msgType?: string): string {
  // Helper to check whether it is a photo
  const isImageContent = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    // If there is a title + href but NO params.hd/rawUrl => this is a link/file, not a photo
    if (obj.title && obj.href) {
      let paramsObj = obj.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (!hasImageParams) return false; // Link/file, not a photo
    }
    // Has params.hd/rawUrl or thumb => photo
    let paramsObj = obj.params;
    if (typeof paramsObj === 'string') {
      try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
    }
    return !!(paramsObj?.hd || paramsObj?.rawUrl || obj.thumb || obj.href);
  };

  if (msg && typeof msg === 'object') {
    if (isImageContent(msg)) {
      const url = extractUrlFromObj(msg);
      if (url) return url;
    }
    if (Array.isArray(msg) && msg.length > 0) {
      if (isImageContent(msg[0])) {
        const u = extractUrlFromObj(msg[0]);
        if (u) return u;
      }
    }
  }
  if (msg && typeof msg === 'string' && msg !== '' && msg !== 'null') {
    try {
      const parsed = JSON.parse(msg);
      if (typeof parsed === 'object') {
        if (isImageContent(parsed)) {
          const url = extractUrlFromObj(parsed);
          if (url) return url;
        }
        if (Array.isArray(parsed) && parsed.length > 0 && isImageContent(parsed[0])) {
          return extractUrlFromObj(parsed[0]);
        }
      }
    } catch {}
  }
  if (attach) {
    try {
      const parsed = typeof attach === 'string' ? JSON.parse(attach) : attach;
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (item && typeof item === 'object' && isImageContent(item)) {
        const url = extractUrlFromObj(item);
        if (url) return url;
        if (item.data && isImageContent(item.data)) return extractUrlFromObj(item.data);
      }
    } catch {}
  }
  return '';
}

/**
 * Extracts the photo URL from a message (used when looking up a quote image).
 */
export function extractMediaUrl(msg: any): string {
  try {
    const parsed = JSON.parse(msg.content || '{}');
    if (parsed && typeof parsed === 'object') {
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      return paramsObj?.hd || paramsObj?.rawUrl || parsed.href || parsed.thumb || '';
    }
  } catch {}
  try {
    const attachments = JSON.parse(msg.attachments || '[]');
    return attachments[0]?.url || attachments[0]?.href || attachments[0]?.thumb || '';
  } catch {}
  return '';
}

/**
 * Formats a timestamp as hours:minutes (or hours:minutes/day/month if not today).
 */
export function formatMsgTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString(appLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

/**
 * Time marker label between chat messages: "13:50 Hôm nay", "15:12 Hôm qua", otherwise it keeps "HH:mm dd/MM".
 */
export function formatMsgSeparatorTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const t = d.getTime();
  if (t >= startOfToday && t < startOfToday + 24 * 60 * 60 * 1000) {
    return tr('{{v1}} Hôm nay', { v1: d.toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' }) });
  }
  if (t >= startOfYesterday && t < startOfToday) {
    return tr('{{v1}} Hôm qua', { v1: d.toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' }) });
  }
  return formatMsgTime(timestamp);
}

/**
 * Day marker in the chat: once per day (each message's time is already in its bubble). By the machine's calendar day:
 * "Hôm nay", "Hôm qua", "5 ngày trước, 11-10", "1 tháng trước, 16-09", "1 năm trước, 16-10-2025"
 * (a day in a different year than the current one always shows the year, including "2 tháng trước, 20-12-2025").
 */
export function formatDaySeparator(timestamp: number, now: Date = new Date()): string {
  const d = new Date(timestamp);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const t = d.getTime();
  if (t >= startOfToday && t < startOfTomorrow) return tr('Hôm nay');
  if (t >= startOfYesterday && t < startOfToday) return tr('Hôm qua');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const date = d.getFullYear() === now.getFullYear() ? `${day}-${month}` : `${day}-${month}-${d.getFullYear()}`;
  // Message in the future (machine clock is off) → date only
  if (t >= startOfTomorrow) return date;
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfToday - startOfDay) / 86_400_000);
  // Number of full calendar months (16/09 → 16/10 = 1 month; 17/09 → 16/10 = 29 days)
  const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()) - (now.getDate() < d.getDate() ? 1 : 0);
  const relative = months < 1 ? tr('{{days}} ngày trước', { days }) : months < 12 ? tr('{{months}} tháng trước', { months }) : tr('{{v1}} năm trước', { v1: Math.floor(months / 12) });
  return `${relative}, ${date}`;
}

/**
 * Extracts the text from msg.content to use as the fallback for forwarding.
 */
export function extractMsgText(msg: any): string {
  try {
    const c = msg.content;
    if (!c || c === 'null') return '[Tin nhắn]';

    // Location message: include Google Maps link
    if (msg.msg_type === 'chat.location.new') {
      const parsed = JSON.parse(c);
      const params = typeof parsed?.params === 'string' ? JSON.parse(parsed.params) : (parsed?.params || {});
      const lat = params?.latitude;
      const lng = params?.longitude;
      const desc = parsed?.description || '';
      const mapLink = lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : '';
      let result = `📍 ${desc || tr('Vị trí')}`;
      if (mapLink) result += `\n${mapLink}`;
      return result;
    }

    const parsed = JSON.parse(c);
    if (typeof parsed === 'string') return parsed;
    if (parsed?.msg && typeof parsed.msg === 'string') return parsed.msg;
    if (parsed?.message && typeof parsed.message === 'string') return parsed.message;
    if (parsed?.content && typeof parsed.content === 'string') return parsed.content;
    if (parsed?.title) return `File: ${parsed.title}`;
    return '[Tin nhắn]';
  } catch { return msg.content || '[Tin nhắn]'; }
}
