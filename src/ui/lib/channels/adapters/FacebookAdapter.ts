/**
 * FacebookAdapter.ts - Adapter for the Facebook channel
 * Logic moved as-is from the Facebook branch of channelIpc.ts.
 */

import { BaseChannelAdapter } from './BaseChannelAdapter';
import {
  ActionResult, ThreadsResult, MessagesResult, HealthResult,
  SendMessageParams, SendAttachmentParams, SendAttachmentsParams, SendVideoParams,
  UnsendParams, ReactionParams, GetThreadsParams, GetMessagesParams,
  MarkReadParams, TypingParams, ConnectParams,
  GroupNameParams, BlockParams, ForwardParams, EditParams, PollParams,
} from './ChannelAdapter';
import ipc from '../../ipc';
import { tr } from '../../../../shared/i18n';

export class FacebookAdapter extends BaseChannelAdapter {
  readonly channel = 'facebook' as const;

  private extractReplyTo(quote?: string | null): string | undefined {
    if (!quote) return undefined;
    try {
      const parsed = JSON.parse(quote);
      return parsed.msgId || undefined;
    } catch { return undefined; }
  }

  /**
   * Preserve the Facebook routing tri-state across renderer → IPC:
   * user = 1:1, null = group, undefined = genuinely unknown. Facebook group
   * IDs can also be numeric, so a group must not be collapsed to undefined.
   */
  private typeChat(threadType?: number): 'user' | null | undefined {
    if (threadType === 0) return 'user';
    if (threadType === 1) return null;
    return undefined;
  }

  async sendMessage(params: SendMessageParams): Promise<ActionResult> {
    const replyToMessageId = this.extractReplyTo(params.quote);
    const inferredTypeChat = this.typeChat(params.threadType);
    const hasCallerTypeChat = Object.prototype.hasOwnProperty.call(params.options || {}, 'typeChat');
    // @mentions picked in the composer ({ uid, pos, len }) → Messenger ranges; "@all" has no Messenger equivalent
    const mentions = (Array.isArray((params as any).mentions) ? (params as any).mentions : [])
      .map((m: any) => ({ userId: String(m?.uid ?? m?.userId ?? ''), offset: Number(m?.pos ?? m?.offset), length: Number(m?.len ?? m?.length) }))
      .filter((m: { userId: string; offset: number; length: number }) => /^\d+$/.test(m.userId) && m.offset >= 0 && m.length > 0);
    return ipc.fb?.sendMessage({
      accountId: params.accountId,
      threadId: params.threadId,
      body: params.body,
      options: {
        ...params.options,
        ...(!hasCallerTypeChat && inferredTypeChat !== undefined ? { typeChat: inferredTypeChat } : {}),
        ...(replyToMessageId ? { replyToMessageId } : {}),
        ...(mentions.length ? { mentions } : {}),
      },
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  async sendAttachment(params: SendAttachmentParams): Promise<ActionResult> {
    const replyToMessageId = this.extractReplyTo(params.quote);
    const typeChat = this.typeChat(params.threadType);
    return ipc.fb?.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      filePath: params.filePath,
      body: params.body,
      ...(typeChat !== undefined ? { typeChat } : {}),
      // Facebook only accepts these four MIME routes; Telegram-specific
      // media types are sent as a normal file when crossing channels.
      // 'voice' = in-app recording → audio sent as a Messenger voice message
      fileType: params.fileType === 'voice' ? 'audio'
        : ['image', 'video', 'audio', 'file'].includes(params.fileType || '')
          ? params.fileType as 'image' | 'video' | 'audio' | 'file'
          : 'file',
      ...(params.fileType === 'voice' ? { voice: true } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(params.libraryUuid ? { _libraryUuid: params.libraryUuid } : {}),
    }) ?? { success: false, error: 'FB IPC not available' };
  }

  /** Several attachments at once: Facebook uploads and sends them in one IPC call (one mutation per file server-side). */
  async sendAttachments(params: SendAttachmentsParams): Promise<ActionResult> {
    const files = (params.filePaths || []).filter(Boolean);
    if (files.length === 0) return { success: false, error: tr('Không có ảnh để gửi') };
    if ((params.fileType ?? 'image') !== 'image') return super.sendAttachments(params);
    const typeChat = this.typeChat(params.threadType);
    const res: any = await ipc.fb?.sendAttachments({
      accountId: params.accountId,
      threadId: params.threadId,
      filePaths: files,
      body: params.body,
      ...(typeChat !== undefined ? { typeChat } : {}),
    });
    return { success: res?.success ?? false, messageId: res?.messageId, error: res?.error };
  }

  async sendVideo(params: SendVideoParams): Promise<ActionResult> {
    const replyToMessageId = this.extractReplyTo(params.quote);
    const typeChat = this.typeChat(params.threadType);
    return ipc.fb?.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      filePath: params.filePath,
      body: params.body,
      ...(typeChat !== undefined ? { typeChat } : {}),
      fileType: 'video',
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(params.libraryUuid ? { _libraryUuid: params.libraryUuid } : {}),
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
      ...(params.threadType === 0 || params.threadType === 1
        ? { isGroup: params.threadType === 1 }
        : {}),
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

  // ─── Group members (Messenger LightSpeed tasks through the bridge) ─────────────
  // Same method names as the Telegram adapter: GroupInfoPanel / AddMemberToGroupModal call them for non-Zalo channels.

  async addMember(params: { accountId: string; threadId: string; userId: string }): Promise<ActionResult> {
    return ipc.fb?.addGroupMembers({ accountId: params.accountId, threadId: params.threadId, userIds: [params.userId] })
      ?? { success: false, error: 'FB IPC not available' };
  }

  async removeMember(params: { accountId: string; threadId: string; userId: string }): Promise<ActionResult> {
    return ipc.fb?.removeGroupMember({ accountId: params.accountId, threadId: params.threadId, userId: params.userId })
      ?? { success: false, error: 'FB IPC not available' };
  }

  async promoteMember(params: { accountId: string; threadId: string; userId: string; isAdmin: boolean }): Promise<ActionResult> {
    const call = params.isAdmin ? ipc.fb?.addGroupAdmin : ipc.fb?.removeGroupAdmin;
    return call?.({ accountId: params.accountId, threadId: params.threadId, userId: params.userId })
      ?? { success: false, error: 'FB IPC not available' };
  }

  async leaveGroup(params: { accountId: string; threadId: string }): Promise<ActionResult> {
    return ipc.fb?.leaveGroup({ accountId: params.accountId, threadId: params.threadId })
      ?? { success: false, error: 'FB IPC not available' };
  }

  async setGroupAvatar(params: { accountId: string; threadId: string; photoPath: string }): Promise<ActionResult> {
    return ipc.fb?.setGroupPhoto({ accountId: params.accountId, threadId: params.threadId, photoPath: params.photoPath })
      ?? { success: false, error: 'FB IPC not available' };
  }
}
