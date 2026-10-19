/**
 * Chuyển tiếp tin nhắn — phân loại tin theo cách phải gửi lại.
 *
 * `forwardMessage` của zca-js chỉ chuyển tiếp được văn bản (msgType "1"; message rỗng → "Missing message content"),
 * nên mỗi loại tin Zalo phải gửi lại bằng API riêng: chữ định dạng → sendMessage + styles, link → sendLink,
 * danh thiếp → sendCard, sticker → sendSticker, tin thoại → sendVoice, video → sendVideo, ảnh / GIF → sendImage,
 * file → sendFile. Loại Zalo không cho chuyển tiếp (cuộc gọi, bình chọn, thẻ thông báo, bản tin OA, nội dung
 * tương tác / thẻ ngân hàng, tin hệ thống…) → `unsupported` để ẩn nút "Chuyển tiếp".
 */
import { isZalo } from '../channelHelper';
import { extractMsgText } from './messageParser';
import { isFileType, isMediaType, isStickerType, isVideoType, isVoiceType } from './messageTypeUtils';

export type ForwardKind =
  | 'text' | 'rtf' | 'location' | 'link' | 'card' | 'sticker'
  | 'image' | 'gif' | 'video' | 'voice' | 'file' | 'animation'
  | 'unsupported';

export interface ForwardPlan {
  kind: ForwardKind;
  /** Loại tin không chuyển tiếp được (kind = 'unsupported') — dùng trong thông báo */
  reason?: string;
}

/** Loại tin Zalo không chuyển tiếp được (Zalo cũng không cho) */
const UNSUPPORTED_MSG_TYPES: Record<string, string> = {
  'chat.ecard': 'Thẻ thông báo',
  'group.poll': 'Bình chọn',
  'chat.poll': 'Bình chọn',
  'chat.todo': 'Công việc',
  'chat.list.action': 'Bản tin Official Account',
  'chat.webcontent': 'Nội dung tương tác của Zalo',
  'chat.webcontent.v2': 'Nội dung tương tác của Zalo',
  'chat.undo': 'Tin đã thu hồi',
  recalled: 'Tin đã thu hồi',
  system: 'Tin hệ thống',
};

const ANIMATION_MSG_TYPES = ['animation', 'gif', 'animated_image'];

export function parseContentObject(content: unknown): Record<string, any> | null {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content as Record<string, any>;
  if (typeof content !== 'string' || !content.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseParams(obj: Record<string, any> | null): Record<string, any> {
  const params = obj?.params;
  if (params && typeof params === 'object') return params;
  if (typeof params === 'string' && params.trimStart().startsWith('{')) {
    try { return JSON.parse(params) || {}; } catch { return {}; }
  }
  return {};
}

const firstText = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
};

const isHttpUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//i.test(value);

export function getForwardPlan(msg: any): ForwardPlan {
  const msgType = String(msg?.msg_type || '');
  if (msg?.is_recalled === 1 || msg?.status === 'recalled') return { kind: 'unsupported', reason: 'Tin đã thu hồi' };
  const obj = parseContentObject(msg?.content);
  const action = String(obj?.action || '');
  if (action === 'zinstant.bankcard') return { kind: 'unsupported', reason: 'Thẻ ngân hàng' };
  const blocked = UNSUPPORTED_MSG_TYPES[msgType];
  if (blocked) return { kind: 'unsupported', reason: blocked };

  // Tin định dạng cũ (nhập từ bản sao lưu điện thoại kiểu cũ): zalo_<số>, nhật ký cuộc gọi, tin thoại "[Voice]",
  // "video" không có content JSON (thực chất là bản tin zinstant, link trong attachments là icon)
  if (isZalo(msg?.channel) && (/^zalo_\d+$/.test(msgType) || msgType === 'call' || msgType === 'emoji'
    || (msgType === 'video' && !obj))) {
    return { kind: 'unsupported', reason: 'Tin nhắn định dạng cũ' };
  }

  if (msgType === 'chat.recommended' || msgType === 'chat.recommend' || action.startsWith('recommened.')) {
    if (action === 'recommened.link' || action === 'recommended.link') return { kind: 'link' };
    if (action === 'recommened.user' || action === 'recommened.vip') return { kind: 'card' };
    if (action === 'recommened.calltime' || action === 'recommened.misscall') return { kind: 'unsupported', reason: 'Cuộc gọi' };
    return { kind: 'unsupported', reason: 'Thẻ Zalo' };
  }
  if (msgType === 'webchat' && action === 'rtf') return { kind: 'rtf' };
  if (msgType === 'chat.location.new') return { kind: 'location' };
  if (msgType === 'chat.gif') return { kind: 'gif' };
  if (msgType === 'chat.doodle') return { kind: 'image' };
  if (isStickerType(msgType)) return { kind: 'sticker' };
  if (isVideoType(msgType)) return { kind: 'video' };
  if (isVoiceType(msgType)) return { kind: 'voice' };
  if (ANIMATION_MSG_TYPES.includes(msgType)) return { kind: 'animation' };
  const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? '');
  if (isFileType(msgType, content, msg?.attachments)) return { kind: 'file' };
  if (isMediaType(msgType, content, msg?.attachments)) return { kind: 'image' };
  return { kind: 'text' };
}

/** null = chuyển tiếp được; ngược lại là tên loại tin không chuyển tiếp được */
export function getForwardBlockReason(msg: any): string | null {
  const plan = getForwardPlan(msg);
  return plan.kind === 'unsupported' ? plan.reason || 'Loại tin nhắn này' : null;
}

/** Cách cũ (Facebook / Telegram giữ nguyên): content là văn bản / chú thích, bỏ placeholder "[Tin nhắn]". */
function legacyForwardText(msg: any): string {
  const content = msg?.content;
  if (!content || content === 'null') return '';
  const text = extractMsgText(msg).trim();
  return text === '[Tin nhắn]' ? '' : text;
}

/**
 * Chữ đi kèm khi chuyển tiếp: nội dung tin văn bản, hoặc chú thích ảnh / video (gửi thành tin riêng sau media).
 * Zalo: `title` của file là tên file, của link / danh thiếp là nội dung thẻ → không gửi thêm
 * (trước đây gửi nhầm "File: <title>").
 */
export function getForwardCaption(msg: any, kind: ForwardKind = getForwardPlan(msg).kind): string {
  if (!isZalo(msg?.channel)) return legacyForwardText(msg);
  const obj = parseContentObject(msg?.content);
  switch (kind) {
    case 'text':
      return obj ? firstText(obj.msg, obj.message, obj.content, obj.title) : legacyForwardText(msg);
    case 'rtf':
      return firstText(obj?.title);
    case 'location':
      return extractMsgText(msg).trim();
    case 'image':
    case 'gif':
    case 'video':
      return firstText(obj?.title);
    default:
      return '';
  }
}

export type ZaloTextStyle = { start: number; len: number; st: string; indentSize?: number };

/** Tin chữ định dạng (webchat action "rtf"): nội dung + styles, cắt styles vào độ dài chữ (Zalo từ chối style vượt quá). */
export function getZaloRichText(msg: any): { text: string; styles: ZaloTextStyle[] } {
  const obj = parseContentObject(msg?.content);
  const text = typeof obj?.title === 'string' ? obj.title : '';
  const raw = parseParams(obj).styles;
  const styles: ZaloTextStyle[] = [];
  for (const style of Array.isArray(raw) ? raw : []) {
    if (!style || typeof style.st !== 'string' || !style.st) continue;
    const start = Math.max(0, Math.min(Number(style.start) || 0, text.length));
    const len = Math.min(Number(style.len) || 0, text.length - start);
    if (len <= 0) continue;
    styles.push({ start, len, st: style.st, ...(Number(style.indentSize) > 0 ? { indentSize: Number(style.indentSize) } : {}) });
  }
  return { text, styles };
}

/** Tin link (recommened.link): `title` là chữ người gửi (thường chứa link), `href` là link. */
export function getZaloLinkInfo(msg: any): { url: string; text: string } {
  const obj = parseContentObject(msg?.content);
  const text = firstText(obj?.title).trim();
  const url = String(obj?.href || text.match(/https?:\/\/\S+/i)?.[0] || '').trim();
  return { url: isHttpUrl(url) ? url : '', text };
}

/** Danh thiếp (recommened.user / .vip): `params` = UID web (chuỗi 19 số), `description` là JSON có phone. */
export function getZaloCardInfo(msg: any): { userId: string; phone: string; name: string } {
  const obj = parseContentObject(msg?.content);
  let desc: Record<string, any> = {};
  if (obj?.description && typeof obj.description === 'object') desc = obj.description;
  else if (typeof obj?.description === 'string' && obj.description.trimStart().startsWith('{')) {
    try { desc = JSON.parse(obj.description) || {}; } catch { /* không phải JSON */ }
  }
  // params dạng số > 2^53 sẽ bị JSON.parse làm tròn → chỉ nhận chuỗi số
  const candidates = [obj?.params, desc.uid, desc.userId, desc.id];
  const userId = String(candidates.find(v => typeof v === 'string' && /^\d+$/.test(v.trim()) && v.trim() !== '0') || '').trim();
  return { userId, phone: firstText(desc.phone).trim(), name: firstText(obj?.title).trim() };
}

/** Sticker Zalo: content { id, catId, type } */
export function getZaloStickerId(msg: any): number {
  const id = Number(parseContentObject(msg?.content)?.id);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/** Tin thoại Zalo: link m4a (params.m4a, hoặc href) */
export function getZaloVoiceUrl(msg: any): string {
  const obj = parseContentObject(msg?.content);
  const params = parseParams(obj);
  return [params.m4a, obj?.href].find(isHttpUrl) || '';
}

/** Link CDN + thông số của tin video Zalo (content: href, thumb, params.duration ms, video_width, video_height). */
export function getZaloVideoInfo(msg: any): { videoUrl: string; thumbUrl: string; duration?: number; width?: number; height?: number } | null {
  if (!isZalo(msg?.channel)) return null;
  const obj = parseContentObject(msg?.content);
  if (!obj || !isHttpUrl(obj.href)) return null;
  const params = parseParams(obj);
  const positive = (value: any) => (Number(value) > 0 ? Number(value) : undefined);
  return {
    videoUrl: obj.href,
    thumbUrl: isHttpUrl(obj.thumb) ? obj.thumb : '',
    duration: positive(params.duration),
    width: positive(params.video_width ?? params.width),
    height: positive(params.video_height ?? params.height),
  };
}
