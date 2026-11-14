/**
 * zaloMessagePins.ts: data of a Zalo message pin (pure, main process + tests).
 *
 * Zalo keeps a pinned message as a board "topic" of type 2 whose `params` name the message: global and client message ID,
 * sender, and a short title / thumbnail depending on the message type. Groups use the group board, 1-1 chats the friend
 * board (endpoints in src/services/zalo/zaloMessagePins.ts). Field names follow Zalo Web.
 */

/** Board topic type of a pinned message (Zalo Web MSG_TOPIC). */
export const ZALO_PINNED_MESSAGE_TOPIC = 2;
/** Zalo error: the group board version moved on (Zalo Web INVALID_BOARD_VERSION). List the pins again, then retry once. */
export const ZALO_INVALID_BOARD_VERSION = 183;
/** Topic color Zalo Web uses when the server settings give none (#222222). */
export const ZALO_DEFAULT_TOPIC_COLOR = -14540254;
/** Emoji Zalo Web gives a pinned message. */
export const ZALO_PIN_EMOJI = '📌';
/** Longest title sent with a pin: the pin bar shows one line, a very long text only weighs on the request. */
const MAX_PIN_TITLE = 500;

/**
 * Zalo client message type (the number used in pins and quotes) of a stored msg_type. Same table as zca-js
 * getClientMessageType, plus the short names Deplao stores for some messages ("photo", "video"…). Unknown = text (1).
 */
export function zaloClientMsgType(msgType: unknown): number {
  const t = String(msgType || '').toLowerCase();
  if (t === 'chat.voice' || t === 'voice' || t === 'audio') return 31;
  if (t === 'chat.photo' || t === 'photo' || t === 'image') return 32;
  if (t === 'chat.sticker' || t === 'sticker') return 36;
  if (t === 'chat.doodle' || t === 'doodle') return 37;
  if (t === 'chat.recommended' || t === 'chat.link' || t === 'link') return 38;
  if (t === 'chat.location.new' || t === 'location') return 43;
  if (t === 'chat.video.msg' || t === 'video') return 44;
  if (t === 'share.file' || t === 'file') return 46;
  if (t === 'chat.gif' || t === 'gif') return 49;
  return 1;
}

/** The message a pin names, as stored in Deplao. */
export interface ZaloPinSource {
  /** Global message ID (messages.msg_id). */
  msgId: string;
  /** Client message ID (messages.cli_msg_id); text messages usually share the global ID. */
  cliMsgId?: string | null;
  msgType?: string | null;
  /** Stored content: plain text or a JSON string / object (photo, file, sticker, link…). */
  content?: unknown;
  /** UID of the author of the message. */
  senderUid: string;
  senderName?: string;
  /** Text to show when the message has no text of its own (the preview built by the app). */
  fallbackTitle?: string;
}

function asObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clip(value: unknown): string {
  const text = String(value ?? '').trim();
  return text.length > MAX_PIN_TITLE ? `${text.slice(0, MAX_PIN_TITLE - 1)}…` : text;
}

/** Text of a text message: a plain string, or the msg / title of a JSON content (rich text, mentions). */
function textOf(src: ZaloPinSource): string {
  const obj = asObject(src.content);
  if (obj) return clip(obj.msg ?? obj.title ?? obj.description ?? src.fallbackTitle ?? '');
  const plain = typeof src.content === 'string' ? src.content : '';
  return clip(plain || src.fallbackTitle || '');
}

/**
 * `params` (a JSON string) of the pin topic of one message. Text keeps its text as the title; media keep the thumbnail
 * and caption Zalo shows in the pin bar; a type Zalo has no pin layout for is pinned as text with the app's preview.
 */
export function buildZaloPinParams(src: ZaloPinSource): string {
  const msgType = zaloClientMsgType(src.msgType);
  const content = asObject(src.content) || {};
  const extra = asObject(content.params) || {};
  const base = {
    client_msg_id: String(src.cliMsgId || src.msgId),
    global_msg_id: String(src.msgId),
    senderUid: String(src.senderUid),
    senderName: src.senderName || '',
  };
  switch (msgType) {
    case 32: // photo
    case 37: // doodle
    case 44: // video
      return JSON.stringify({ ...base, thumb: String(content.thumb || ''), title: clip(content.description || content.title || ''), msg_type: msgType });
    case 31: // voice
      return JSON.stringify({ ...base, msg_type: msgType });
    case 36: // sticker
      return JSON.stringify({
        ...base,
        extra: JSON.stringify({ id: content.id ?? content.sticker_id ?? '', catId: content.catId ?? content.cate_id ?? '', type: content.type ?? '' }),
        msg_type: msgType,
      });
    case 38: // link
      return JSON.stringify({ ...base, href: String(content.href || ''), thumb: String(content.thumb || ''), title: clip(content.title || content.href || ''), msg_type: msgType });
    case 43: // location
      return JSON.stringify({ ...base, title: clip(content.title || content.description || src.fallbackTitle || ''), msg_type: msgType });
    case 46: // file
      return JSON.stringify({
        ...base,
        title: clip(content.title || src.fallbackTitle || ''),
        extra: JSON.stringify({
          fileSize: String(extra.fileSize ?? ''),
          checksum: String(extra.checksum || ''),
          fileExt: String(extra.fileExt || ''),
          tWidth: Number(extra.tWidth) || 0,
          tHeight: Number(extra.tHeight) || 0,
          duration: Number(extra.duration) || 0,
          fType: Number(extra.fType) || 0,
          fdata: String(extra.fdata || ''),
        }),
        msg_type: msgType,
      });
    case 49: // gif
      return JSON.stringify({ ...base, thumb: String(content.thumb || ''), msg_type: msgType });
    default:
      return JSON.stringify({ ...base, title: textOf(src), msg_type: 1 });
  }
}

/** Params of a board topic as an object, whichever form Zalo sent. */
function topicParams(topic: any): Record<string, any> {
  return asObject(topic?.params) || {};
}

/**
 * The pinned-message topic that pins `msgId`, from a board listing. Accepts bare topics and `{ boardType, data }` items
 * (the group board list wraps topics that way).
 */
export function findZaloPinnedTopic(items: unknown, msgId: string): { id: string; [key: string]: any } | null {
  const target = String(msgId || '');
  if (!target || !Array.isArray(items)) return null;
  for (const item of items) {
    const topic = item && typeof item === 'object' && item.data && typeof item.data === 'object' && item.params === undefined ? item.data : item;
    const type = Number(topic?.type ?? item?.boardType);
    if (type !== ZALO_PINNED_MESSAGE_TOPIC || topic?.id === undefined || topic?.id === null) continue;
    if (String(topicParams(topic).global_msg_id ?? '') === target) return { ...topic, id: String(topic.id) };
  }
  return null;
}
