/**
 * Message forwarding: classifies messages by how they must be re-sent.
 *
 * zca-js `forwardMessage` only forwards text (msgType "1"; empty message → "Missing message content"),
 * so each Zalo message type must be re-sent with its own API: formatted text → sendMessage + styles, link → sendLink,
 * contact card → sendCard, sticker → sendSticker, voice message → sendVoice, video → sendVideo, photo / GIF → sendImage,
 * file → sendFile. Types Zalo does not allow to be forwarded (calls, polls, notification cards, OA news, interactive content /
 * bank cards, system messages...) → `unsupported` to hide the "Chuyển tiếp" (Forward) button.
 */
import { isZalo } from '../../channels/channelHelper';
import { extractMsgText } from '../messages/messageParser';
import { isFileType, isMediaType, isStickerType, isVideoType, isVoiceType } from '../messages/messageTypeUtils';
import { tr } from '../../../../shared/i18n';

export type ForwardKind =
  | 'text' | 'rtf' | 'location' | 'link' | 'card' | 'sticker'
  | 'image' | 'gif' | 'video' | 'voice' | 'file' | 'animation'
  | 'unsupported';

export interface ForwardPlan {
  kind: ForwardKind;
  /** Message type that cannot be forwarded (kind = 'unsupported'), used in notifications */
  reason?: string;
}

/** Zalo message type that cannot be forwarded (Zalo does not allow it either) */
const UNSUPPORTED_MSG_TYPES: Record<string, string> = {
  'chat.ecard': tr('Thẻ thông báo'),
  'group.poll': tr('Bình chọn'),
  'chat.poll': tr('Bình chọn'),
  'chat.todo': tr('Công việc'),
  'chat.list.action': tr('Bản tin Official Account'),
  'chat.webcontent': tr('Nội dung tương tác của Zalo'),
  'chat.webcontent.v2': tr('Nội dung tương tác của Zalo'),
  'chat.undo': tr('Tin đã thu hồi'),
  recalled: tr('Tin đã thu hồi'),
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
  if (msg?.is_recalled === 1 || msg?.status === 'recalled') return { kind: 'unsupported', reason: tr('Tin đã thu hồi') };
  const obj = parseContentObject(msg?.content);
  const action = String(obj?.action || '');
  if (action === 'zinstant.bankcard') return { kind: 'unsupported', reason: tr('Thẻ ngân hàng') };
  const blocked = UNSUPPORTED_MSG_TYPES[msgType];
  if (blocked) return { kind: 'unsupported', reason: blocked };

  // Old-format messages (imported from an old-style phone backup): zalo_<number>, call logs, voice messages "[Voice]",
  // "video" without JSON content (really a zinstant news message, the link in attachments is an icon)
  if (isZalo(msg?.channel) && (/^zalo_\d+$/.test(msgType) || msgType === 'call' || msgType === 'emoji'
    || (msgType === 'video' && !obj))) {
    return { kind: 'unsupported', reason: tr('Tin nhắn định dạng cũ') };
  }

  if (msgType === 'chat.recommended' || msgType === 'chat.recommend' || action.startsWith('recommened.')) {
    if (action === 'recommened.link' || action === 'recommended.link') return { kind: 'link' };
    if (action === 'recommened.user' || action === 'recommened.vip') return { kind: 'card' };
    if (action === 'recommened.calltime' || action === 'recommened.misscall') return { kind: 'unsupported', reason: tr('Cuộc gọi') };
    return { kind: 'unsupported', reason: tr('Thẻ Zalo') };
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

/** null = can be forwarded; otherwise the name of the message type that cannot be forwarded */
export function getForwardBlockReason(msg: any): string | null {
  const plan = getForwardPlan(msg);
  return plan.kind === 'unsupported' ? plan.reason || tr('Loại tin nhắn này') : null;
}

/** Old way (kept for Facebook / Telegram): content is the text / caption, drop the "[Tin nhắn]" placeholder. */
function legacyForwardText(msg: any): string {
  const content = msg?.content;
  if (!content || content === 'null') return '';
  const text = extractMsgText(msg).trim();
  return text === '[Tin nhắn]' ? '' : text;
}

/**
 * Text sent along when forwarding: the text of a text message, or the caption of a photo / video (sent as a separate message after the media).
 * Zalo: the `title` of a file is the file name, of a link / contact card it is the card's content → nothing extra is sent
 * (it used to wrongly send "File: <title>").
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

/** Formatted text message (webchat action "rtf"): content + styles, styles are trimmed to the text length (Zalo rejects styles that go beyond it). */
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

/** Link message (recommened.link): `title` is the sender's text (usually containing the link), `href` is the link. */
export function getZaloLinkInfo(msg: any): { url: string; text: string } {
  const obj = parseContentObject(msg?.content);
  const text = firstText(obj?.title).trim();
  const url = String(obj?.href || text.match(/https?:\/\/\S+/i)?.[0] || '').trim();
  return { url: isHttpUrl(url) ? url : '', text };
}

/** Contact card (recommened.user / .vip): `params` = web UID (19-digit string), `description` is JSON containing the phone. */
export function getZaloCardInfo(msg: any): { userId: string; phone: string; name: string } {
  const obj = parseContentObject(msg?.content);
  let desc: Record<string, any> = {};
  if (obj?.description && typeof obj.description === 'object') desc = obj.description;
  else if (typeof obj?.description === 'string' && obj.description.trimStart().startsWith('{')) {
    try { desc = JSON.parse(obj.description) || {}; } catch { /* not JSON */ }
  }
  // numeric params > 2^53 would be rounded by JSON.parse → accept only numeric strings
  const candidates = [obj?.params, desc.uid, desc.userId, desc.id];
  const userId = String(candidates.find(v => typeof v === 'string' && /^\d+$/.test(v.trim()) && v.trim() !== '0') || '').trim();
  return { userId, phone: firstText(desc.phone).trim(), name: firstText(obj?.title).trim() };
}

/** Sticker Zalo: content { id, catId, type } */
export function getZaloStickerId(msg: any): number {
  const id = Number(parseContentObject(msg?.content)?.id);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/** Zalo voice message: m4a link (params.m4a, or href) */
export function getZaloVoiceUrl(msg: any): string {
  const obj = parseContentObject(msg?.content);
  const params = parseParams(obj);
  return [params.m4a, obj?.href].find(isHttpUrl) || '';
}

/** CDN link + parameters of a Zalo video message (content: href, thumb, params.duration in ms, video_width, video_height). */
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
