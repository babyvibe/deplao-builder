/**
 * Type of a message to choose how to draw it (contact card, greeting card, sticker, RTF, poll, video, voice, bank card, location, Facebook page
 * template message, Zalo OA card, album, photo, file, text) + the parsed text content. Pure: uses the message type cache (msgTypeCache) if
 * available. A new channel with its own message types: add a flag here + a draw branch in SharedMessageContent / MessageRow.
 */
import { isZinstantMsgType } from '../../../../../shared/zalo/zaloZinstant';
import { FB_TEMPLATE_MSG_TYPE } from '../../../../../shared/facebook/facebookTemplate';
import { isFacebook, isTelegram as isTelegramCh } from '@/lib/channels/channelHelper';
import { parseContent } from '@/lib/chat/messages/messageParser';
import { isBankCardType, isCardType, isEcardType, isFileType, isMediaType, isRtfMsg, isStickerType, isVideoType, isVoiceType } from '@/lib/chat/messages/messageTypeUtils';
import type { MsgTypeInfo } from '@/lib/chat/messages/messageGrouping';

/** The attachments column holds a real attachment (not '', '[]', 'null'). */
function hasStoredAttachments(raw: unknown): boolean {
  if (!raw) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  const text = String(raw).trim();
  return !!text && text !== '[]' && text !== 'null' && text !== '{}';
}

export interface MessageKind {
  isCardMsg: boolean;
  isEcardMsg: boolean;
  isStickerMsg: boolean;
  isRtf: boolean;
  isPollMsg: boolean;
  isVideoMsg: boolean;
  isVoiceMsg: boolean;
  isBankCardMsg: boolean;
  isLocationMsg: boolean;
  /** Facebook Page template message (card + button) */
  isFbTemplateMsg: boolean;
  /** News / notification from a Zalo Official Account (zinstant) */
  isZinstantMsg: boolean;
  /** Old Facebook message saved empty (an earlier version could not read the template message) */
  isFbEmptyMsg: boolean;
  /** Photo album (first message): groupMediaMsgs = every message of the album */
  isGroupMedia: boolean;
  groupMediaMsgs: any[] | null;
  isMediaMsg: boolean;
  isFileMsg: boolean;
  /** Parsed text content (empty for media / card messages…) */
  content: string;
}

export function classifyMessage(msg: any, cached: MsgTypeInfo | undefined, groupedFirstMsgs: Record<string, any[]>): MessageKind {
  const isCardMsg = cached?.isCard ?? isCardType(msg.msg_type, msg.content);
  const isEcardMsg = cached?.isEcard ?? isEcardType(msg.msg_type);
  const isStickerMsg = cached?.isSticker ?? isStickerType(msg.msg_type);
  const isRtf = cached?.isRtf ?? isRtfMsg(msg.msg_type, msg.content);
  const isPollMsg = cached?.isPoll ?? (
    msg.msg_type === 'group.poll'
    || msg.msg_type === 'telegram.poll'
    || (msg.msg_type === 'poll' && isTelegramCh(msg.channel))
  );
  const isVideoMsg = cached?.isVideo ?? (isVideoType(msg.msg_type) || msg.msg_type === 'gif');
  const isVoiceMsg = cached?.isVoice ?? isVoiceType(msg.msg_type);
  const isBankCardMsg = isBankCardType(msg.msg_type, msg.content);
  const isLocationMsg = msg.msg_type === 'chat.location.new';
  // Facebook Page template message (card + button) / old Facebook message saved empty (an earlier version could not read the template message)
  const isFbTemplateMsg = msg.msg_type === FB_TEMPLATE_MSG_TYPE;
  const isZinstantMsg = cached?.isZinstant ?? isZinstantMsgType(msg.msg_type, msg.content);
  const isFbEmptyMsg = !isFbTemplateMsg && isFacebook(msg.channel) && (!msg.msg_type || msg.msg_type === 'text')
    && !msg.is_recalled && !String(msg.content || '').trim() && !hasStoredAttachments(msg.attachments);
  const isGroupMedia = cached?.isGroupMedia ?? (!isPollMsg && !isVoiceMsg && !!groupedFirstMsgs[msg.msg_id]);
  const groupMediaMsgs = isGroupMedia ? groupedFirstMsgs[msg.msg_id] : null;
  const isMediaMsg = cached?.isMedia ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isGroupMedia && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && !isLocationMsg && !isZinstantMsg && isMediaType(msg.msg_type, msg.content, msg.attachments));
  const isFileMsg = cached?.isFile ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isMediaMsg && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && !isLocationMsg && !isZinstantMsg && isFileType(msg.msg_type, msg.content, msg.attachments));
  const content = cached?.content ?? (isMediaMsg || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isGroupMedia || isRtf || isPollMsg || isVideoMsg || isVoiceMsg || isBankCardMsg || isLocationMsg || isZinstantMsg ? '' : parseContent(msg.content, msg.msg_type, msg.channel));
  return {
    isCardMsg, isEcardMsg, isStickerMsg, isRtf, isPollMsg, isVideoMsg, isVoiceMsg, isBankCardMsg, isLocationMsg,
    isFbTemplateMsg, isZinstantMsg, isFbEmptyMsg, isGroupMedia, groupMediaMsgs, isMediaMsg, isFileMsg, content,
  };
}
