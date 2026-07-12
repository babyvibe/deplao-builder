/**
 * messageTypeUtils.ts - Các helper xác định loại tin nhắn (message type detection)
 * Dùng chung cho ChatWindow, MessageBubbles, và các component khác.
 */

/** Kiểm tra tin nhắn danh thiếp (chat.recommended) */
export function isCardType(msgType: string, content: string): boolean {
  if (['chat.recommended', 'chat.recommend'].includes(msgType)) return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.action && String(parsed.action).includes('recommened')) return true;
  } catch {}
  return false;
}

/** Kiểm tra tin nhắn ecard (thông báo hệ thống dạng thẻ, vd: trở thành phó nhóm) */
export function isEcardType(msgType: string): boolean {
  return msgType === 'chat.ecard';
}

/** Kiểm tra tin nhắn có phải file đính kèm không (không phải ảnh, không phải card) */
export function isFileType(msgType: string, content: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (['share.file', 'share.link', 'file'].includes(msgType)) return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.title && parsed.href &&
        !parsed.params?.rawUrl && !parsed.params?.hd) return true;
  } catch {}
  return false;
}

/** Kiểm tra tin nhắn là sticker */
export function isStickerType(msgType: string): boolean {
  return msgType === 'chat.sticker' || msgType === 'sticker';
}

/** Kiểm tra tin nhắn webchat với action=rtf (tin nhắn có định dạng rich text) */
export function isRtfMsg(msgType: string, content: string): boolean {
  if (msgType !== 'webchat') return false;
  try {
    const parsed = JSON.parse(content);
    return parsed?.action === 'rtf';
  } catch {}
  return false;
}

/** Kiểm tra tin nhắn có phải media (ảnh) không - loại trừ file và card */
export function isMediaType(msgType: string, content: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (isBankCardType(msgType, content)) return false;
  if (['share.file', 'share.link', 'file'].includes(msgType)) return false;
  if (msgType === 'chat.video.msg') return false; // video được xử lý riêng
  if (msgType === 'chat.voice') return false; // voice được xử lý riêng
  if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      // params có thể là string JSON hoặc object
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

/** Kiểm tra tin nhắn video */
export function isVideoType(msgType: string): boolean {
  return msgType === 'chat.video.msg' || msgType === 'video';
}

/** Kiểm tra tin nhắn voice */
export function isVoiceType(msgType: string): boolean {
  return msgType === 'chat.voice' || msgType === 'audio';
}

/** Kiểm tra tin nhắn vị trí */
export function isLocationType(msgType: string): boolean {
  return msgType === 'chat.location.new';
}

/** Kiểm tra tin nhắn thẻ ngân hàng (chat.webcontent + zinstant.bankcard) */
export function isBankCardType(msgType: string, content: string): boolean {
  // Ưu tiên check msgType trước
  if (msgType === 'chat.webcontent' || msgType === 'webchat') {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  // Fallback: kiểm tra content bất kể msgType (phòng trường hợp Zalo đổi msgType)
  if (content && content.includes('zinstant.bankcard')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  return false;
}
