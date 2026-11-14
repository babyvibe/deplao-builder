/**
 * Data one message row needs from the chat window (conversation, message grouping, sender, multi-select, popups, actions…). The chat window
 * builds it once per render and passes it to renderMessageRow; a message row does not subscribe to the store itself (it redraws with the window, as before).
 * To add something a row needs: add the name to the matching group here + the build step in window/ChatWindow.tsx.
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
  // Open conversation (useOpenThread)
  Pick<OpenThread, 'activeAccountId' | 'activeThreadId' | 'activeContact' | 'channelCap' | 'msgs' | 'contactList' | 'threadReceipt' | 'telegramGroupAdmins' | 'postReplierPeers' | 'searchHighlightQuery' | 'updateContact' | 'removeMessage' | 'setReplyTo'>
  // Gom tin (useMessageGrouping)
  & Pick<MessageGrouping, 'groupedFirstMsgs' | 'groupedSkipIds' | 'pollSkipIds' | 'groupedStickerFirstMsgs' | 'groupedStickerSkipIds' | 'dayStartIds' | 'msgIndexById' | 'findMsgById' | 'msgTypeCache' | 'getRowMsgIds'>
  // Sender (useSenderDirectory)
  & Pick<SenderDirectory, 'getContact' | 'getGroupMember' | 'groupMembers' | 'isGroupAdmin' | 'resolveQuoteAuthor'>
  // Row display state (useRowDisplayState)
  & Pick<RowDisplayState, 'failedMsgAvatars' | 'setFailedMsgAvatars' | 'avatarRefreshAttempted' | 'revealedRecallIds' | 'setRevealedRecallIds' | 'revealedEditIds' | 'setRevealedEditIds'>
  // Multi-select (useMessageSelection)
  & Pick<MessageSelection, 'isSelecting' | 'selectedMsgIds' | 'setSelectedMsgIds' | 'dragSelectRef' | 'clickSuppressUntilRef'>
  // Menu / popup (useChatWindowDialogs)
  & Pick<ChatWindowDialogs, 'setContextMenu' | 'setErpDraft' | 'setManageGroupOpen' | 'setReactionPopup' | 'setUserProfilePopup'>
  // Photo / video viewer (useMediaViewers)
  & Pick<MediaViewers, 'openViewer' | 'openImageList' | 'openVideoPlayer'>
  // Message actions (useMessageActions / useJumpToMessage)
  & Pick<RowActions, 'handleReact' | 'handleCancelReaction' | 'handleScrollToMsg'>
  // Reactions: the hover reaction bar + the reactions usable in the Telegram conversation
  & Pick<RowReactions, 'telegramReactions' | 'reactionPickerMsgId' | 'openReactionPicker' | 'armReactionPicker' | 'scheduleCloseReactionPicker' | 'closeReactionPicker'>
  // Task management (calendar appointment / note from a message)
  & Pick<RowErp, 'erpAccess'>;

/** Value that renderMessageRow computes for one row, passed down to the parts of the row (Pick<RowLocals, …>) */
export interface RowLocals {
  msg: any;
  idx: number;
  isSent: boolean;
  /** Date marker before the row (the first displayed message of the day), or null */
  daySeparator: React.ReactNode;
  /** Old Telegram row that saved a pin event as a "đã xoá" (deleted) message → notice line */
  isTelegramPinnedNotice: boolean;
  /** Last message of a run from the same sender → show the avatar */
  isLastInRun: boolean;
  displayName: string;
  avatarUrl: string;
  /** Letter avatar (color by sender) when there is no photo or the photo fails */
  senderAvatarFallback: React.ReactNode;
  /** Photo / album / file / card / sticker…: no text bubble */
  isNoBubbleMsg: boolean;
  /** Reply message of a photo / file type: one frame wrapping both the quote and the content */
  quoteShell: boolean;
  /** Telegram channel post: photo / album / video flush with the post frame */
  postEdgeMedia: boolean;
  telegramPostMeta: ReturnType<typeof getTelegramPostMeta>;
  postStats: ReturnType<typeof pickTelegramPostStats> | null;
  /** Telegram rich-format message (headings, lists, tables…) */
  richBlocks: ReturnType<typeof getRichMessageBlocks>;
  /** Parsed text content (empty for media / card messages…) */
  content: string;
  /** Send time on the same line as the last text (plain text messages) */
  inlineTime: boolean;
  outgoingStatus: ReturnType<typeof outgoingMessageStatus>;
  reactionCounts: ReturnType<typeof parseReactions>;
  hasReactions: boolean;
}
