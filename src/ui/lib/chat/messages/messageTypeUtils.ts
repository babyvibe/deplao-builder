/**
 * messageTypeUtils.ts - Helpers that determine the message type (message type detection)
 * Shared by ChatWindow, MessageBubbles, and other components.
 */

/** Checks whether the message is a contact card (chat.recommended) */
export function isCardType(msgType: string, content: string): boolean {
  if (['chat.recommended', 'chat.recommend'].includes(msgType)) return true;
  if (isOaListType(msgType)) return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.action && String(parsed.action).includes('recommened')) return true;
  } catch {}
  return false;
}

/** Zalo Official Account news (content is an array of articles), shown with OaListBubble */
export function isOaListType(msgType: string): boolean {
  return msgType === 'chat.list.action';
}

/** Checks whether the message is an ecard (a system notice shown as a card, e.g. became a deputy group admin) */
export function isEcardType(msgType: string): boolean {
  return msgType === 'chat.ecard';
}

/** Checks whether the message is a file attachment (not a photo, not a card) */
export function isFileType(msgType: string, content: string, attachmentsStr?: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (['share.file', 'share.link'].includes(msgType)) return true;
  if (msgType === 'file') {
    // If it's actually an image (by MIME/extension), it's not a file
    if (isMediaType(msgType, content, attachmentsStr)) return false;
    return true;
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.title && parsed.href &&
        !parsed.params?.rawUrl && !parsed.params?.hd) return true;
  } catch {}
  return false;
}

/** Checks whether the message is a sticker */
export function isStickerType(msgType: string): boolean {
  return msgType === 'chat.sticker' || msgType === 'sticker';
}

/** Checks whether the message is a webchat message with action=rtf (a message with rich text formatting) */
export function isRtfMsg(msgType: string, content: string): boolean {
  if (msgType !== 'webchat') return false;
  try {
    const parsed = JSON.parse(content);
    return parsed?.action === 'rtf';
  } catch {}
  return false;
}

/** Checks whether the message is media (a photo), excluding files and cards */
export function isMediaType(msgType: string, content: string, attachmentsStr?: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (isBankCardType(msgType, content)) return false;
  if (['share.file', 'share.link'].includes(msgType)) return false;
  if (msgType === 'chat.video.msg') return false; // video is handled separately
  if (msgType === 'chat.voice' || msgType === 'audio' || msgType === 'voice') return false; // voice is handled separately
  if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') return true;

  // Telegram/Facebook: file with image MIME type or image extension → treat as media.
  // SVG documents are intentionally kept as files. Telegram and Zalo commonly send
  // them as attachments (icons/documents), even though their MIME is image/svg+xml;
  // rendering those through an <img> creates a broken image bubble instead of a
  // downloadable attachment.
  if (msgType === 'file' && attachmentsStr) {
    try {
      const atts = JSON.parse(attachmentsStr || '[]');
      if (Array.isArray(atts) && atts.length > 0) {
        const mime = (atts[0].mime_type || '').toLowerCase();
        const fileName = (atts[0].file_name || '').toLowerCase();
        if (fileName.endsWith('.svg') || mime === 'image/svg+xml' || mime === 'image/svg') return false;
        const imageMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.ico'];
        if (imageMimes.some(m => mime.startsWith(m))) return true;
        if (imageExts.some(ext => fileName.endsWith(ext))) return true;
      }
    } catch {}
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      // params can be a JSON string or an object
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      const hasHdOrRaw = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (parsed.title && parsed.href && !hasHdOrRaw) return false;
      return !!(parsed.href || parsed.thumb || paramsObj?.rawUrl || paramsObj?.hd);
    }
  } catch {}
  return false;
}

/** Checks whether the message is a video (including Telegram's video_note) */
export function isVideoType(msgType: string): boolean {
  return msgType === 'chat.video.msg' || msgType === 'video' || msgType === 'video_note';
}

/** Checks whether the message is a voice message */
export function isVoiceType(msgType: string): boolean {
  return msgType === 'chat.voice' || msgType === 'audio' || msgType === 'voice';
}

/** Checks whether the message is a location */
export function isLocationType(msgType: string): boolean {
  return msgType === 'chat.location.new';
}

/** Checks whether the message is a bank card (chat.webcontent + zinstant.bankcard) */
export function isBankCardType(msgType: string, content: string): boolean {
  // Check msgType first
  if (msgType === 'chat.webcontent' || msgType === 'webchat') {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  // Fallback: check the content regardless of msgType (in case Zalo changes msgType)
  if (content && content.includes('zinstant.bankcard')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  return false;
}
