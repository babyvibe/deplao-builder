/**
 * ChannelAdapter.ts - Shared interface for all channel adapters
 * Each channel (Zalo, Facebook, Telegram Bot, Telegram User) implements this interface.
 * The UI calls through getAdapter(channel).method(params) instead of if/else.
 */

import { Channel } from '../../../../configs/channels/channelConfig';

// ─── Common Result Types ──────────────────────────────────────────────────────

export interface ActionResult {
  success: boolean;
  error?: string;
  msgId?: string;
  messageId?: string;
  pollId?: string;
  /** Facebook E2EE: unacknowledged send that may have been delivered (see MessageQueue). */
  uncertain?: boolean;
}

export interface ThreadsResult {
  success: boolean;
  threads?: any[];
  error?: string;
}

export interface MessagesResult {
  success: boolean;
  messages?: any[];
  error?: string;
}

export interface HealthResult {
  success: boolean;
  alive: boolean;
  error?: string;
}

// ─── Parameter Types ──────────────────────────────────────────────────────────

export interface SendMessageParams {
  accountId: string;
  threadId: string;
  body: string;
  threadType?: number;  // 0=user, 1=group
  options?: any;
  quote?: string | null;
  auth?: any;
  mentions?: Array<{ uid: string; pos: number; len: number }>;
}

export interface SendAttachmentParams {
  accountId: string;
  threadId: string;
  /** Telegram forum root/top message ID when sending inside a topic. */
  topicRootMessageId?: string;
  filePath: string;
  threadType?: number;
  body?: string;
  fileType?: 'image' | 'video' | 'audio' | 'voice' | 'sticker' | 'animation' | 'video_note' | 'file';
  quote?: string | null;
  /** Reply-to message ID for Telegram */
  replyToMsgId?: string;
  /**
   * Library item (the employee machine has no file: `filePath` is empty): the Boss swaps the uuid for the item's file path itself
   * (executeProxyAction, the page permission is checked).
   */
  libraryUuid?: string;
}

export interface SendVideoParams {
  accountId: string;
  threadId: string;
  /** Telegram forum root/top message ID when sending inside a topic. */
  topicRootMessageId?: string;
  threadType?: number;
  filePath: string;
  thumbPath?: string;
  duration?: number;
  width?: number;
  height?: number;
  body?: string;
  quote?: any;
  /** Telegram: reply to this message (also inside a forum topic / channel post comment thread) */
  replyToMsgId?: string;
  auth?: any;
  /** Library item when the employee machine has no file (see SendAttachmentParams.libraryUuid). */
  libraryUuid?: string;
}

export interface UnsendParams {
  accountId: string;
  messageId: string;
  threadId?: string;
  threadType?: number;
}

export interface ReactionParams {
  accountId: string;
  messageId: string;
  emoji: string;
  threadId?: string;
  threadType?: number;
  action?: 'add' | 'remove';
}

export interface GetThreadsParams {
  accountId: string;
  forceRefresh?: boolean;
}

export interface GetMessagesParams {
  accountId: string;
  threadId: string;
  limit?: number;
  offset?: number;
}

export interface MarkReadParams {
  accountId: string;
  threadId: string;
}

export interface TypingParams {
  accountId: string;
  threadId: string;
  isTyping: boolean;
  isGroup?: boolean;
}

export interface ConnectParams {
  accountId: string;
  auth?: any;
}

export interface DisconnectParams {
  accountId: string;
}

export interface HealthParams {
  accountId: string;
}

export interface GroupNameParams {
  accountId: string;
  threadId: string;
  name: string;
}

export interface BlockParams {
  accountId: string;
  userId: string;
}

export interface ForwardParams {
  accountId: string;
  messageId: string;
  targetThreadId: string;
  threadType?: number;
  sourceThreadId?: string; // needed for Telegram native forward
}

export interface EditParams {
  accountId: string;
  messageId: string;
  text: string;
  threadId?: string; // needed for Telegram edit (conversation context)
}

export interface PollParams {
  accountId: string;
  threadId: string;
  question: string;
  options: string[];
}

// ─── Channel Adapter Interface ────────────────────────────────────────────────

export interface ChannelAdapter {
  readonly channel: Channel;

  sendMessage(params: SendMessageParams): Promise<ActionResult>;
  sendAttachment(params: SendAttachmentParams): Promise<ActionResult>;
  sendVideo(params: SendVideoParams): Promise<ActionResult>;
  unsendMessage(params: UnsendParams): Promise<ActionResult>;
  addReaction(params: ReactionParams): Promise<ActionResult>;
  getThreads(params: GetThreadsParams): Promise<ThreadsResult>;
  getMessages(params: GetMessagesParams): Promise<MessagesResult>;
  markAsRead(params: MarkReadParams): Promise<ActionResult>;
  sendTyping(params: TypingParams): Promise<ActionResult>;
  connectAccount(params: ConnectParams): Promise<ActionResult>;
  disconnectAccount(params: DisconnectParams): Promise<ActionResult>;
  checkHealth(params: HealthParams): Promise<HealthResult>;
  changeGroupName(params: GroupNameParams): Promise<ActionResult>;
  blockUser(params: BlockParams): Promise<ActionResult>;
  unblockUser(params: BlockParams): Promise<ActionResult>;
  forwardMessage(params: ForwardParams): Promise<ActionResult>;
  editMessage(params: EditParams): Promise<ActionResult>;
  createPoll(params: PollParams): Promise<ActionResult>;
}
