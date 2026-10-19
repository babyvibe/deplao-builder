/**
 * channelIpc.ts - Channel-aware IPC facade
 * Delegates to ChannelAdapter instances via getAdapter(channel).
 * UI components call this instead of ipc.zalo / ipc.fb directly.
 *
 * Giai đoạn 1 refactor: bọc adapter, giữ nguyên tên hàm + chữ ký export.
 * Giai đoạn 2: UI migrate dần sang gọi getAdapter(channel) trực tiếp.
 */

import { Channel } from '../../configs/channelConfig';
import { getAdapter } from './adapters/registry';

// Re-export types for backward compatibility
export type {
  ActionResult,
  ThreadsResult,
  MessagesResult,
  HealthResult,
  SendMessageParams,
  SendAttachmentParams,
  SendVideoParams,
  UnsendParams,
  ReactionParams,
  GetThreadsParams,
  GetMessagesParams,
  MarkReadParams,
  TypingParams,
  ConnectParams,
  DisconnectParams,
  HealthParams,
  GroupNameParams,
  BlockParams,
  ForwardParams,
  EditParams,
  PollParams,
} from './adapters/ChannelAdapter';

// ─── Facade functions — giữ nguyên chữ ký, delegate to adapter ───────────────

export async function sendMessage(channel: Channel, params: {
  accountId: string;
  threadId: string;
  body: string;
  threadType?: number;
  options?: any;
  quote?: string | null;
  auth?: any;
  mentions?: Array<{ uid: string; pos: number; len: number }>;
}) {
  return getAdapter(channel).sendMessage(params);
}

export async function sendAttachment(channel: Channel, params: {
  accountId: string;
  threadId: string;
  topicRootMessageId?: string;
  filePath: string;
  threadType?: number;
  body?: string;
  fileType?: 'image' | 'video' | 'audio' | 'file';
  quote?: string | null;
  libraryUuid?: string;
}) {
  return getAdapter(channel).sendAttachment(params);
}

export async function sendVideo(channel: Channel, params: {
  accountId: string;
  threadId: string;
  topicRootMessageId?: string;
  threadType?: number;
  filePath: string;
  thumbPath?: string;
  duration?: number;
  width?: number;
  height?: number;
  body?: string;
  quote?: any;
  auth?: any;
  libraryUuid?: string;
}) {
  return getAdapter(channel).sendVideo(params);
}

export async function unsendMessage(channel: Channel, params: {
  accountId: string;
  messageId: string;
  threadId?: string;
  threadType?: number;
}) {
  return getAdapter(channel).unsendMessage(params);
}

export async function addReaction(channel: Channel, params: {
  accountId: string;
  messageId: string;
  emoji: string;
  threadId?: string;
  threadType?: number;
  action?: 'add' | 'remove';
}) {
  return getAdapter(channel).addReaction(params);
}

export async function getThreads(channel: Channel, params: {
  accountId: string;
  forceRefresh?: boolean;
}) {
  return getAdapter(channel).getThreads(params);
}

export async function getMessages(channel: Channel, params: {
  accountId: string;
  threadId: string;
  limit?: number;
  offset?: number;
}) {
  return getAdapter(channel).getMessages(params);
}

export async function markAsRead(channel: Channel, params: {
  accountId: string;
  threadId: string;
}) {
  return getAdapter(channel).markAsRead(params);
}

export async function sendTyping(channel: Channel, params: {
  accountId: string;
  threadId: string;
  isTyping: boolean;
  isGroup?: boolean;
}) {
  return getAdapter(channel).sendTyping(params);
}

export async function connectAccount(channel: Channel, params: {
  accountId: string;
  auth?: any;
}) {
  return getAdapter(channel).connectAccount(params);
}

export async function disconnectAccount(channel: Channel, params: {
  accountId: string;
}) {
  return getAdapter(channel).disconnectAccount(params);
}

export async function checkHealth(channel: Channel, params: {
  accountId: string;
}) {
  return getAdapter(channel).checkHealth(params);
}

export async function changeGroupName(channel: Channel, params: {
  accountId: string;
  threadId: string;
  name: string;
}) {
  return getAdapter(channel).changeGroupName(params);
}

export async function blockUser(channel: Channel, params: {
  accountId: string;
  userId: string;
}) {
  return getAdapter(channel).blockUser(params);
}

export async function unblockUser(channel: Channel, params: {
  accountId: string;
  userId: string;
}) {
  return getAdapter(channel).unblockUser(params);
}

export async function forwardMessage(channel: Channel, params: {
  accountId: string;
  messageId: string;
  targetThreadId: string;
  threadType?: number;
}) {
  return getAdapter(channel).forwardMessage(params);
}

export async function editMessage(channel: Channel, params: {
  accountId: string;
  messageId: string;
  text: string;
}) {
  return getAdapter(channel).editMessage(params);
}

export async function createPoll(channel: Channel, params: {
  accountId: string;
  threadId: string;
  question: string;
  options: string[];
}) {
  return getAdapter(channel).createPoll(params);
}

