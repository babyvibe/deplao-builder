/**
 * Loại của một tin để chọn cách vẽ (thẻ, thiệp, sticker, RTF, bình chọn, video, thoại, thẻ ngân hàng, vị trí, tin mẫu
 * Facebook, thẻ OA Zalo, album, ảnh, file, chữ) + nội dung chữ đã parse. Thuần: dùng bộ đệm loại tin (msgTypeCache) nếu
 * có. Kênh mới có loại tin riêng: thêm cờ ở đây + nhánh vẽ ở SharedMessageContent / MessageRow.
 */
import { isZinstantMsgType } from '../../../../../shared/zalo/zaloZinstant';
import { FB_TEMPLATE_MSG_TYPE } from '../../../../../shared/facebook/facebookTemplate';
import { isFacebook, isTelegram as isTelegramCh } from '@/lib/channels/channelHelper';
import { parseContent } from '@/lib/chat/messages/messageParser';
import { isBankCardType, isCardType, isEcardType, isFileType, isMediaType, isRtfMsg, isStickerType, isVideoType, isVoiceType } from '@/lib/chat/messages/messageTypeUtils';
import type { MsgTypeInfo } from '@/lib/chat/messages/messageGrouping';

/** Cột attachments có đính kèm thật (không phải '', '[]', 'null'). */
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
  /** Tin mẫu của Page Facebook (thẻ + nút) */
  isFbTemplateMsg: boolean;
  /** Bản tin / thông báo của Official Account Zalo (zinstant) */
  isZinstantMsg: boolean;
  /** Tin Facebook cũ lưu rỗng (bản trước chưa đọc được tin mẫu) */
  isFbEmptyMsg: boolean;
  /** Album ảnh (tin đầu): groupMediaMsgs = mọi tin của album */
  isGroupMedia: boolean;
  groupMediaMsgs: any[] | null;
  isMediaMsg: boolean;
  isFileMsg: boolean;
  /** Nội dung chữ đã parse (rỗng với tin media / thẻ…) */
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
  // Tin mẫu của Page Facebook (thẻ + nút) / tin Facebook cũ lưu rỗng (bản trước chưa đọc được tin mẫu)
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
