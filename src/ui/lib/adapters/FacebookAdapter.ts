/**
 * FacebookAdapter.ts - Adapter cho kênh Facebook
 * Di chuyển nguyên trạng logic từ channelIpc.ts nhánh Facebook.
 */

import { BaseChannelAdapter } from './BaseChannelAdapter';
import {
  ActionResult, ThreadsResult, MessagesResult, HealthResult,
  SendMessageParams, SendAttachmentParams, SendVideoParams,
  UnsendParams, ReactionParams, GetThreadsParams, GetMessagesParams,
  MarkReadParams, TypingParams, ConnectParams,
  GroupNameParams, BlockParams, ForwardParams, EditParams, PollParams,
} from './ChannelAdapter';
import ipc from '../ipc';

export class FacebookAdapter extends BaseChannelAdapter {
  readonly channel = 'facebook' as const;

  private extractReplyTo(quote?: string | null): string | undefined {
    if (!quote) return undefined;
    try {
      const parsed = JSON.parse(quote);
      return parsed.msgId || undefined;
    } catch { return undefined; }
  }

  private typeChat(threadType?: number): 'user' | undefined {
    return threadType === 0 ? 'user' : undefined;
  }

  async sendMessage(params: SendMessageParams): Promise<ActionResult> {
    const replyToMessageId = this.extractReplyTo(params.quote);
    return ipc.fb?.sendMessage({
      accountId: params.accountId,
      threadId: params.threadId,
      body: params.body,
      options: {
        ...params.options,
        typeChat: this.typeChat(params.threadType),
        ...(replyToMessageId ? { replyToMessageId } : {}),
      },
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async sendAttachment(params: SendAttachmentParams): Promise<ActionResult> {
    const replyToMessageId = this.extractReplyTo(params.quote);
    return ipc.fb?.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      filePath: params.filePath,
      body: params.body,
      typeChat: this.typeChat(params.threadType),
      // Facebook only accepts these four MIME routes; Telegram-specific
      // media types are sent as a normal file when crossing channels.
      fileType: ['image', 'video', 'audio', 'file'].includes(params.fileType || '')
        ? params.fileType as 'image' | 'video' | 'audio' | 'file'
        : 'file',
      ...(replyToMessageId ? { replyToMessageId } : {}),
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async sendVideo(params: SendVideoParams): Promise<ActionResult> {
    const replyToMessageId = this.extractReplyTo(params.quote);
    return ipc.fb?.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      filePath: params.filePath,
      body: params.body,
      typeChat: this.typeChat(params.threadType),
      fileType: 'video',
      ...(replyToMessageId ? { replyToMessageId } : {}),
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async unsendMessage(params: UnsendParams): Promise<ActionResult> {
    return ipc.fb?.unsendMessage({
      accountId: params.accountId,
      messageId: params.messageId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async addReaction(params: ReactionParams): Promise<ActionResult> {
    return ipc.fb?.addReaction({
      accountId: params.accountId,
      messageId: params.messageId,
      emoji: params.emoji,
      action: params.action || 'add',
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async getThreads(params: GetThreadsParams): Promise<ThreadsResult> {
    return ipc.fb?.getThreads({
      accountId: params.accountId,
      forceRefresh: params.forceRefresh,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async getMessages(params: GetMessagesParams): Promise<MessagesResult> {
    return ipc.fb?.getMessages({
      accountId: params.accountId,
      threadId: params.threadId,
      limit: params.limit,
      offset: params.offset,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async markAsRead(params: MarkReadParams): Promise<ActionResult> {
    return ipc.fb?.markAsRead({
      accountId: params.accountId,
      threadId: params.threadId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async sendTyping(params: TypingParams): Promise<ActionResult> {
    return ipc.fb?.sendTyping({
      accountId: params.accountId,
      threadId: params.threadId,
      isTyping: params.isTyping,
      isGroup: params.isGroup,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async connectAccount(params: ConnectParams): Promise<ActionResult> {
    return ipc.fb?.connect({ accountId: params.accountId })
      ?? { success: false, error: 'FB IPC not available' };
  }

  async disconnectAccount(params: { accountId: string }): Promise<ActionResult> {
    return ipc.fb?.disconnect({ accountId: params.accountId })
      ?? { success: false, error: 'FB IPC not available' };
  }

  async checkHealth(params: { accountId: string }): Promise<HealthResult> {
    const res = await ipc.fb?.checkHealth({ accountId: params.accountId });
    return { success: res?.success ?? false, alive: res?.alive ?? false, error: res?.reason };
  }

  async changeGroupName(params: GroupNameParams): Promise<ActionResult> {
    return ipc.fb?.changeThreadName({
      accountId: params.accountId,
      threadId: params.threadId,
      name: params.name,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async blockUser(params: BlockParams): Promise<ActionResult> {
    return ipc.fb?.blockUser({
      accountId: params.accountId,
      userId: params.userId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async unblockUser(params: BlockParams): Promise<ActionResult> {
    return ipc.fb?.unblockUser({
      accountId: params.accountId,
      userId: params.userId,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async forwardMessage(params: ForwardParams): Promise<ActionResult> {
    return ipc.fb?.forwardMessage({
      accountId: params.accountId,
      messageId: params.messageId,
      targetThreadId: params.targetThreadId,
      isGroup: params.threadType === 1,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async editMessage(params: EditParams): Promise<ActionResult> {
    return ipc.fb?.editMessage({
      accountId: params.accountId,
      messageId: params.messageId,
      text: params.text,
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async createPoll(params: PollParams): Promise<ActionResult> {
    return ipc.fb?.createPoll({
      accountId: params.accountId,
      threadId: params.threadId,
      question: params.question,
      options: params.options,
    }) ?? { success: false, error: 'FB IPC not available' };
  }
}
