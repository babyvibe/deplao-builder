/**
 * Dữ liệu một hàng tin cần từ khung chat (hội thoại, gom tin, người gửi, chọn nhiều tin, popup, thao tác…). Khung chat
 * dựng 1 lần / lần vẽ rồi truyền cho renderMessageRow; hàng tin không tự subscribe store (vẽ lại cùng khung như trước).
 * Thêm thứ hàng tin cần: thêm tên vào nhóm tương ứng ở đây + chỗ dựng ở window/ChatWindow.tsx.
 */
import type React from 'react';
import type { useQuickErpAccess } from '@/hooks/erp/useQuickErpAccess';
import type { getTelegramPostMeta } from '@/lib/media/mediaResolver';
import type { outgoingMessageStatus } from '@/lib/chat/messages/messageStatus';
import type { parseReactions } from '../../messages/reactions/ReactionComponents';
import type { pickTelegramPostStats } from '../../telegram/posts/telegramPostLayout';
import type { getRichMessageBlocks } from '../../telegram/messages/TelegramRichMessageBody';
import type { useTelegramChatReactions } from '@/lib/chat/reactions/reactionChoices';
import type { useReactionHoverPicker } from '../../messages/reactions/MessageReactionCorner';
import type { OpenThread } from '../hooks/useOpenThread';
import type { MessageGrouping } from '../hooks/useMessageGrouping';
import type { SenderDirectory } from '../hooks/useSenderDirectory';
import type { RowDisplayState } from '../hooks/useRowDisplayState';
import type { MessageSelection } from '../hooks/useMessageSelection';
import type { ChatWindowDialogs } from '../hooks/useChatWindowDialogs';
import type { MediaViewers } from '../hooks/useMediaViewers';
import type { MessageActions } from '../hooks/useMessageActions';
import type { JumpToMessage } from '../hooks/useJumpToMessage';

type RowActions = Pick<MessageActions, 'handleReact' | 'handleCancelReaction'> & Pick<JumpToMessage, 'handleScrollToMsg'>;
type HoverPicker = ReturnType<typeof useReactionHoverPicker>;

interface RowReactions {
  telegramReactions: ReturnType<typeof useTelegramChatReactions>;
  reactionPickerMsgId: HoverPicker['openId'];
  openReactionPicker: HoverPicker['open'];
  armReactionPicker: HoverPicker['arm'];
  scheduleCloseReactionPicker: HoverPicker['scheduleClose'];
  closeReactionPicker: HoverPicker['close'];
}

interface RowErp {
  erpAccess: ReturnType<typeof useQuickErpAccess>;
}

export type MessageRowContext =
  // Hội thoại đang mở (useOpenThread)
  Pick<OpenThread, 'activeAccountId' | 'activeThreadId' | 'activeContact' | 'channelCap' | 'msgs' | 'contactList' | 'threadReceipt' | 'telegramGroupAdmins' | 'postReplierPeers' | 'searchHighlightQuery' | 'updateContact' | 'removeMessage' | 'setReplyTo'>
  // Gom tin (useMessageGrouping)
  & Pick<MessageGrouping, 'groupedFirstMsgs' | 'groupedSkipIds' | 'pollSkipIds' | 'groupedStickerFirstMsgs' | 'groupedStickerSkipIds' | 'dayStartIds' | 'msgIndexById' | 'findMsgById' | 'msgTypeCache' | 'getRowMsgIds'>
  // Người gửi (useSenderDirectory)
  & Pick<SenderDirectory, 'getContact' | 'getGroupMember' | 'groupMembers' | 'isGroupAdmin' | 'resolveQuoteAuthor'>
  // Trạng thái hiển thị hàng (useRowDisplayState)
  & Pick<RowDisplayState, 'failedMsgAvatars' | 'setFailedMsgAvatars' | 'avatarRefreshAttempted' | 'revealedRecallIds' | 'setRevealedRecallIds' | 'revealedEditIds' | 'setRevealedEditIds'>
  // Chọn nhiều tin (useMessageSelection)
  & Pick<MessageSelection, 'isSelecting' | 'selectedMsgIds' | 'setSelectedMsgIds' | 'dragSelectRef' | 'clickSuppressUntilRef'>
  // Menu / popup (useChatWindowDialogs)
  & Pick<ChatWindowDialogs, 'setContextMenu' | 'setErpDraft' | 'setManageGroupOpen' | 'setReactionPopup' | 'setUserProfilePopup' | 'setWebviewModal'>
  // Xem ảnh / video (useMediaViewers)
  & Pick<MediaViewers, 'openViewer' | 'openImageList' | 'openVideoPlayer'>
  // Thao tác trên tin (useMessageActions / useJumpToMessage)
  & Pick<RowActions, 'handleReact' | 'handleCancelReaction' | 'handleScrollToMsg'>
  // Cảm xúc: thanh chọn khi rê chuột + reaction dùng được của hội thoại Telegram
  & Pick<RowReactions, 'telegramReactions' | 'reactionPickerMsgId' | 'openReactionPicker' | 'armReactionPicker' | 'scheduleCloseReactionPicker' | 'closeReactionPicker'>
  // Quản lý công việc (lịch hẹn / ghi chú từ tin)
  & Pick<RowErp, 'erpAccess'>;

/** Giá trị renderMessageRow tính cho một hàng, truyền xuống các phần của hàng (Pick<RowLocals, …>) */
export interface RowLocals {
  msg: any;
  idx: number;
  isSent: boolean;
  /** Mốc ngày trước hàng (tin hiển thị đầu tiên của ngày) hoặc null */
  daySeparator: React.ReactNode;
  /** Hàng Telegram cũ lưu nhầm sự kiện ghim thành tin "đã xoá" → dòng thông báo */
  isTelegramPinnedNotice: boolean;
  /** Tin cuối của lượt cùng người gửi → hiện ảnh đại diện */
  isLastInRun: boolean;
  displayName: string;
  avatarUrl: string;
  /** Ảnh đại diện chữ (màu theo người gửi) khi không có / lỗi ảnh */
  senderAvatarFallback: React.ReactNode;
  /** Ảnh / album / file / thẻ / sticker…: không có bong bóng chữ */
  isNoBubbleMsg: boolean;
  /** Tin trả lời loại ảnh / file: một khung bao cả trích dẫn lẫn nội dung */
  quoteShell: boolean;
  /** Bài đăng kênh Telegram: ảnh / album / video sát mép khung bài */
  postEdgeMedia: boolean;
  telegramPostMeta: ReturnType<typeof getTelegramPostMeta>;
  postStats: ReturnType<typeof pickTelegramPostStats> | null;
  /** Tin định dạng phong phú Telegram (tiêu đề, danh sách, bảng…) */
  richBlocks: ReturnType<typeof getRichMessageBlocks>;
  /** Nội dung chữ đã parse (rỗng với tin media / thẻ…) */
  content: string;
  /** Giờ gửi chung dòng chữ cuối (tin chữ thường) */
  inlineTime: boolean;
  outgoingStatus: ReturnType<typeof outgoingMessageStatus>;
  reactionCounts: ReturnType<typeof parseReactions>;
  hasReactions: boolean;
}
