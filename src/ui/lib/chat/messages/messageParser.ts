/**
 * messageParser.ts - Các helper parse nội dung tin nhắn (content, quote, media URL, etc.)
 * Dùng chung cho ChatWindow, MessageBubbles, và các component khác.
 */
import React from 'react';
import { convertZaloEmojis } from './emojiUtils';
import { zinstantPreviewText } from '../../../../shared/zalo/zaloZinstant';

/**
 * Parse msg.content thành text thuần để hiển thị preview.
 * Ưu tiên: content.msg > content.message > content.content > content.title > raw text
 */
export function parseTxt(content: string): string {
  if (!content || content === 'null') return '';
  try {
    const p = JSON.parse(content);
    if (p === null || p === undefined) return '';
    if (typeof p === 'string') return convertZaloEmojis(p);
    if (typeof p !== 'object') return convertZaloEmojis(String(p));
    if (p?.action === 'zinstant.bankcard') return '🏦 [Tài khoản ngân hàng]';
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

/** Read native Zalo and Telegram mention entities without a DB migration. */
export function getMentionRanges(attachments: unknown): MentionRange[] {
  let parsed = attachments;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((attachment: any) =>
      attachment?.type === 'telegram_mention' || attachment?.type === 'zalo_mention'
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

/** URL nhận diện trong tin nhắn — dùng chung cho linkifyText và findUrlRanges. */
const LINK_URL_REGEX = /(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+|[a-zA-Z0-9._-]+\.(com|vn|net|org|io|dev|app|me|co|xyz|info|tv|gg|link|page|site|online|tech|store|fun|icu|top|cc|pw|tk|ml|ga|cf|gq)(?:\/[^\s<>"')\]]*)?)/g;

/**
 * Địa chỉ email (vd ten.khach@gmail.com) — nhận NGUYÊN địa chỉ trước khi xét URL / mention. Trước đây "@" của
 * email bị xét như mention còn tên miền "gmail.com" thành link riêng, nên email hiện như một tag màu xanh.
 */
// Lookbehind: chỉ thử từ đầu một cụm ký tự — không quét lại từng vị trí giữa chuỗi dài (tin chứa base64…)
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

/** Vị trí [start, end) các địa chỉ email trong text. */
export function findEmailRanges(text: string): Array<[number, number]> {
  return collectRanges(text, EMAIL_REGEX.source);
}

/**
 * Vị trí [start, end) các URL trong text (cùng regex với linkifyText). Dùng để không coi "@" nằm trong
 * URL (vd threads.com/@user/post/…) là mention. Tên miền nằm trong email (gmail.com của a@gmail.com) không phải URL.
 */
export function findUrlRanges(text: string): Array<[number, number]> {
  if (!text) return [];
  const emails = findEmailRanges(text);
  return collectRanges(text, LINK_URL_REGEX.source)
    .filter(([start, end]) => !emails.some(([emailStart, emailEnd]) => start >= emailStart && end <= emailEnd));
}

/** URL + email: "@" nằm trong các đoạn này thuộc về link / địa chỉ email, không phải mention. */
export function findLinkRanges(text: string): Array<[number, number]> {
  return [...findUrlRanges(text), ...findEmailRanges(text)].sort((a, b) => a[0] - b[0]);
}

/** Link trong tin (URL, email). chat-link: giao diện tối xanh da trời nhạt, không gạch chân (index.css); sáng giữ nguyên. */
const LINK_CLASS = 'chat-link text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer break-all';

/**
 * Detect URL và @mentions trong text → trả về React nodes.
 * - URLs: link clickable
 * - @name: highlight xanh (mention trong group chat)
 * - @@, @@@: KHÔNG bắt (chỉ bắt @ + ít nhất 1 chữ cái/số)
 * - email (a@gmail.com): MỘT link mailto: cho cả địa chỉ — không mention, không biến tên miền thành link riêng
 */
export function linkifyText(text: string, options: { detectMentions?: boolean } = {}): React.ReactNode[] {
  if (!text) return [text];
  const detectMentions = options.detectMentions !== false;
  // URL regex (giữ nguyên)
  const urlRegex = LINK_URL_REGEX;
  // @mention regex: @ + ít nhất 1 chữ cái/số/underscore. The boundary is
  // validated below because this pattern is combined with the URL pattern.
  const mentionRegex = /@([a-zA-Z0-9_][a-zA-Z0-9_]*)/g;
  // Combined: email trước (nguyên địa chỉ), rồi URL, mention sau cùng (URL ưu tiên hơn mention)
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
    // Thêm text trước match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];

    // Email: một link mailto: cho cả địa chỉ (bấm mở ứng dụng thư như Telegram) — không tách tên miền thành link riêng,
    // "@" không phải mention
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
            try { window.electronAPI?.shell?.openExternal?.(mailto); } catch {}
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
      // @mention — highlight xanh, KHÔNG tạo link
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
      // URL link
      const href = raw.startsWith('http') ? raw : `https://${raw}`;
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
            try { window.electronAPI?.shell?.openExternal?.(href); } catch {}
          },
          title: href,
        }, raw)
      );
    }
    lastIndex = match.index + raw.length;
  }

  // Thêm phần text còn lại
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

/**
 * Parse content để hiển thị trong bubble — bao gồm cả attachment markers.
 * Khác với parseTxt: parseContent trả về '[Đính kèm]' cho link/file/params.
 */
export function parseContent(content: string, msgType?: string, channel?: string | null): string {
  if (!content || content === 'null') return '';
  // Telegram giữ nguyên chữ người gửi gõ (":))" vẫn là ":))" như Telegram) — mã cảm xúc chữ là quy ước của Zalo
  if (typeof channel === 'string' && channel.startsWith('telegram')) {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed !== 'object' || parsed === null) return content;
    } catch {
      return content;
    }
  }
  // Bản tin / thông báo của Official Account (zinstant): chữ của OA thay vì "[Đính kèm]" / chuỗi JSON
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
    return '📍 [Vị trí]';
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed === null || parsed === undefined) return '';
    if (typeof parsed === 'string') return convertZaloEmojis(parsed);
    if (typeof parsed !== 'object') return convertZaloEmojis(String(parsed));
    if (parsed?.action === 'zinstant.bankcard') return '🏦 [Tài khoản ngân hàng]';
    if (parsed?.content && typeof parsed.content === 'string') return convertZaloEmojis(parsed.content);
    if (parsed?.msg && typeof parsed.msg === 'string') return convertZaloEmojis(parsed.msg);
    if (parsed?.message && typeof parsed.message === 'string') return convertZaloEmojis(parsed.message);
    if (parsed?.href || parsed?.thumb || parsed?.params) return '[Đính kèm]';
    if (parsed?.title) return parsed.title;
    return JSON.stringify(parsed);
  } catch {
    return convertZaloEmojis(content) || '';
  }
}

/** Chú thích giả do app / nền tảng tự sinh cho tin media (không phải chữ người gửi gõ). */
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
      /* không phải JSON → coi là chữ thường */
    }
    return '';
  }
  return cleanQuoteCaption(text);
}

/**
 * Chú thích (caption) của ảnh / video / sticker được trích dẫn — để khối trích dẫn hiện cả ảnh lẫn chữ như
 * Telegram. Zalo: `attach.title` (msg rỗng); Telegram / Facebook: `msg` là chữ thường; thiếu thì lấy từ nội dung
 * tin gốc (`originalContent`, JSON có title hoặc chữ thường). Trả '' khi chỉ có nhãn kiểu "[Hình ảnh]".
 */
export function getQuotedMediaCaption(
  quote: { msg?: unknown; attach?: unknown } | null | undefined,
  originalContent?: unknown,
): string {
  if (!quote) return captionFromQuotePart(originalContent);
  return captionFromQuotePart(quote.attach) || captionFromQuotePart(quote.msg) || captionFromQuotePart(originalContent);
}

/**
 * Hiển thị nội dung tin nhắn trích dẫn - ưu tiên msgType từ DB, sau đó phân tích cấu trúc msg.
 * Dùng cho quote/reply preview.
 */
export function parseQuoteMsg(msg: string, msgType?: string): string {
  if (!msg || msg === 'null') {
    // msg rỗng nhưng msgType cho biết loại → trả về fallback ngay
    if (msgType === 'chat.recommended' || msgType === 'chat.link') return '[Link]';
    if (msgType === 'share.file' || msgType === 'file') return '[File]';
    if (msgType === 'share.link') return '[Link]';
    if (msgType === 'chat.photo' || msgType === 'photo' || msgType === 'image') return '[Hình ảnh]';
    if (msgType === 'chat.video.msg') return '[Video]';
    if (msgType === 'chat.voice') return '🎤 [Ghi âm]';
    if (msgType === 'chat.sticker') return '[Sticker]';
    if (msgType === 'chat.poll') return '[Bình chọn]';
    if (msgType === 'chat.webcontent') return '🏦 [Tài khoản ngân hàng]';
    if (msgType === 'chat.location.new') return '📍 [Vị trí]';
    return '';
  }

  // Nếu có msgType từ DB → sử dụng để xác định loại trước
  if (msgType) {
    // Với các loại đặc biệt, kiểm tra msgType trước khi parse msg
    if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') {
      return '[Hình ảnh]';
    }
    if (msgType === 'chat.video.msg') {
      return '[Video]';
    }
    if (msgType === 'chat.voice') {
      return '🎤 [Ghi âm]';
    }
    if (msgType === 'chat.sticker') {
      return '[Sticker]';
    }
    if (msgType === 'chat.poll') {
      return '[Bình chọn]';
    }
    if (msgType === 'chat.webcontent' || msgType === 'chat.webcontent.v2') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.action === 'zinstant.bankcard') return '🏦 [Tài khoản ngân hàng]';
      } catch {}
      const zinstant = zinstantPreviewText(msg, msgType);
      if (zinstant) return zinstant;
    }
    // chat.recommended / chat.link = link chia sẻ, parse msg để lấy title
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
    // Với share.file và share.link → cần parse msg để lấy title
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

  // Thử parse JSON để lấy text hoặc phân tích cấu trúc
  try {
    const parsed = JSON.parse(msg);

    // Nếu parse ra string thuần túy → đây là text message
    if (typeof parsed === 'string') return parsed;

    if (parsed && typeof parsed === 'object') {
      // Parse params nếu có
      let paramsObj = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }

      // 1. Kiểm tra text message trước (msg/content field)
      if (parsed.msg && typeof parsed.msg === 'string') return String(parsed.msg);
      if (parsed.content && typeof parsed.content === 'string') return String(parsed.content);

      // 2. Kiểm tra LINK với action="recommened.link"
      if (parsed.action === 'recommened.link' || parsed.action === 'recommended.link') {
        // Ưu tiên title gốc (có thể chứa text người dùng), fallback sang mediaTitle
        const mediaTitle = parsed.title || paramsObj?.mediaTitle;
        if (mediaTitle) return `Link: ${mediaTitle}`;
        return '[Link]';
      }

      // 3. Kiểm tra ảnh/video/file
      if (paramsObj?.hd || paramsObj?.rawUrl) return '[Hình ảnh]';
      if (parsed.href && parsed.title) return `File: ${parsed.title}`;
      if (parsed.href) return '[Link]';
      if (parsed.thumb) return '[Hình ảnh]';

      // 4. Kiểm tra title
      if (parsed.title) return parsed.title;

      // 5. Kiểm tra message field
      if (parsed.message && typeof parsed.message === 'string') return parsed.message;
    }
  } catch {}

  // Fallback: trả về text thuần
  return msg;
}

/**
 * Trích xuất URL ảnh từ một object bất kỳ (params, content, attachment).
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
 * Trích xuất URL ảnh từ nội dung quote - CHỈ với ảnh thực sự, không phải link/file.
 */
export function extractQuoteImage(msg: any, attach?: any, msgType?: string): string {
  // Helper để kiểm tra xem có phải ảnh không
  const isImageContent = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    // Nếu có title + href nhưng KHÔNG có params.hd/rawUrl => đây là link/file, không phải ảnh
    if (obj.title && obj.href) {
      let paramsObj = obj.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (!hasImageParams) return false; // Link/file, không phải ảnh
    }
    // Có params.hd/rawUrl hoặc thumb => ảnh
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
 * Trích xuất URL ảnh từ tin nhắn (dùng khi lookup quote image).
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
 * Format timestamp thành chuỗi giờ/phút (hoặc giờ/phút/ngày/tháng nếu không phải hôm nay).
 */
export function formatMsgTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

/**
 * Nhãn mốc thời gian giữa khung chat: "13:50 Hôm nay", "15:12 Hôm qua", còn lại giữ "HH:mm dd/MM".
 */
export function formatMsgSeparatorTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const t = d.getTime();
  if (t >= startOfToday && t < startOfToday + 24 * 60 * 60 * 1000) {
    return `${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} Hôm nay`;
  }
  if (t >= startOfYesterday && t < startOfToday) {
    return `${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} Hôm qua`;
  }
  return formatMsgTime(timestamp);
}

/**
 * Mốc ngày trong khung chat — 1 lần mỗi ngày (giờ từng tin đã nằm trong bubble). Theo ngày lịch của máy:
 * "Hôm nay", "Hôm qua", "5 ngày trước, 11-10", "1 tháng trước, 16-09", "1 năm trước, 16-10-2025"
 * (ngày khác năm hiện tại luôn kèm năm, kể cả "2 tháng trước, 20-12-2025").
 */
export function formatDaySeparator(timestamp: number, now: Date = new Date()): string {
  const d = new Date(timestamp);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const t = d.getTime();
  if (t >= startOfToday && t < startOfTomorrow) return 'Hôm nay';
  if (t >= startOfYesterday && t < startOfToday) return 'Hôm qua';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const date = d.getFullYear() === now.getFullYear() ? `${day}-${month}` : `${day}-${month}-${d.getFullYear()}`;
  // Tin ở tương lai (lệch giờ máy) → chỉ ngày
  if (t >= startOfTomorrow) return date;
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfToday - startOfDay) / 86_400_000);
  // Số tháng lịch đã tròn (16/09 → 16/10 = 1 tháng; 17/09 → 16/10 = 29 ngày)
  const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()) - (now.getDate() < d.getDate() ? 1 : 0);
  const relative = months < 1 ? `${days} ngày trước` : months < 12 ? `${months} tháng trước` : `${Math.floor(months / 12)} năm trước`;
  return `${relative}, ${date}`;
}

/**
 * Trích xuất nội dung text từ msg.content để dùng làm fallback cho forward.
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
      let result = `📍 ${desc || 'Vị trí'}`;
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
