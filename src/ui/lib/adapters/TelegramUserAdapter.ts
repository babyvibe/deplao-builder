/**
 * TelegramUserAdapter.ts - Adapter cho kênh Telegram cá nhân (MTProto)
 * Gọi IPC telegramUser:* để gửi tin nhắn, kết nối, etc.
 */

import { BaseChannelAdapter } from './BaseChannelAdapter';
import {
  ActionResult, SendMessageParams, SendAttachmentParams,
  ConnectParams, HealthResult, HealthParams, DisconnectParams, SendVideoParams,
  UnsendParams, ForwardParams, EditParams, TypingParams, ReactionParams,
} from './ChannelAdapter';
import ipc from '../ipc';

export class TelegramUserAdapter extends BaseChannelAdapter {
  readonly channel = 'telegram_user' as const;

  async sendMessage(params: SendMessageParams): Promise<ActionResult> {
    try {
      // Extract replyToMsgId from quote payload (JSON string from buildQuotePayload)
      let replyToMsgId: string | undefined;
      if (params.quote) {
        try {
          const q = typeof params.quote === 'string' ? JSON.parse(params.quote) : params.quote;
          replyToMsgId = q?.msgId || q?.msg_id;
        } catch {}
      }
      const res = await (ipc.telegramUser as any)?.sendMessage({
        accountId: params.accountId,
        chatId: params.threadId,
        text: params.body,
        mentions: params.mentions,
        replyToMsgId,
      });
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async connectAccount(params: ConnectParams): Promise<ActionResult> {
    try {
      // Lấy stringSession từ auth params (đã decrypt từ AccountCard)
      // hoặc từ IPC getAccounts() nếu không có
      let stringSession = params.auth?.stringSession || '';
      if (!stringSession) {
        // Fallback: query accounts qua IPC (đã decrypt ở main process)
        try {
          const accountsRes = await (await import('../ipc')).default.login?.getAccounts();
          const tgAccount = accountsRes?.accounts?.find((a: any) =>
            a.zalo_id === params.accountId && (a.channel === 'telegram_user')
          );
          stringSession = tgAccount?.cookies || '';
        } catch {}
      }
      if (!stringSession) return { success: false, error: 'Session không tồn tại. Vui lòng đăng nhập lại.' };
      const res = await ipc.telegramUser?.startListener({
        accountId: params.accountId,
        phoneNumber: '',
        stringSession,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async disconnectAccount(params: DisconnectParams): Promise<ActionResult> {
    try {
      await ipc.telegramUser?.stopListener(params.accountId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async checkHealth(params: HealthParams): Promise<HealthResult> {
    try {
      const res = await ipc.telegramUser?.isConnected(params.accountId);
      return { success: res?.success ?? false, alive: res?.connected ?? false };
    } catch {
      return { success: false, alive: false };
    }
  }

  // ─── Group Management ──────────────────────────────────────────────────

  async getGroupInfo(params: { accountId: string; threadId: string }): Promise<ActionResult & { info?: any }> {
    try {
      const res = await ipc.telegramUser?.getGroupInfo({ accountId: params.accountId, chatId: params.threadId });
      return { success: res?.success ?? false, info: res?.info, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getGroupMembers(params: { accountId: string; threadId: string; limit?: number }): Promise<ActionResult & { members?: any[] }> {
    try {
      const res = await ipc.telegramUser?.getGroupMembers({ accountId: params.accountId, chatId: params.threadId, limit: params.limit });
      return { success: res?.success ?? false, members: res?.members, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async changeGroupName(params: { accountId: string; threadId: string; name: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.editChatTitle({ accountId: params.accountId, chatId: params.threadId, title: params.name });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async leaveGroup(params: { accountId: string; threadId: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.leaveChat({ accountId: params.accountId, chatId: params.threadId });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async blockUser(params: { accountId: string; userId: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.blockUser({ accountId: params.accountId, userId: params.userId });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async unblockUser(params: { accountId: string; userId: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.unblockUser({ accountId: params.accountId, userId: params.userId });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async addMember(params: { accountId: string; threadId: string; userId: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.addChatUser({ accountId: params.accountId, chatId: params.threadId, userId: params.userId });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async removeMember(params: { accountId: string; threadId: string; userId: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.deleteChatUser({ accountId: params.accountId, chatId: params.threadId, userId: params.userId });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async promoteMember(params: { accountId: string; threadId: string; userId: string; isAdmin: boolean }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.editChatAdmin({ accountId: params.accountId, chatId: params.threadId, userId: params.userId, isAdmin: params.isAdmin });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async exportInviteLink(params: { accountId: string; threadId: string }): Promise<ActionResult & { link?: string }> {
    try {
      const res = await ipc.telegramUser?.exportChatInvite({ accountId: params.accountId, chatId: params.threadId });
      return { success: res?.success ?? false, link: res?.link, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async sendAttachment(params: SendAttachmentParams): Promise<ActionResult> {
    try {
      const filePath = params.filePath;
      const caption = params.body;
      const chatId = params.threadId;
      const topicId = params.topicRootMessageId;

      // Detect file type for proper routing
      const ext = (filePath.split('.').pop() || '').toLowerCase();
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
      const isVideo = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv'].includes(ext);
      const isAudio = ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac'].includes(ext);

      const fileType = params.fileType || (isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file');
      console.log(`[TG:adapter] sendAttachment filePath=${filePath} fileType=${fileType} topicId=${topicId || 'none'}`);

      let res: any;
      if (topicId) {
        res = await (ipc.telegramUser as any)?.sendTopicFile({
          accountId: params.accountId, chatId, topicRootMessageId: topicId, filePath, caption, fileType,
        });
      } else {
        // Extract replyToMsgId from quote payload if available
        let replyToMsgId: string | undefined = params.replyToMsgId;
        if (!replyToMsgId && params.quote) {
          try { const q = JSON.parse(params.quote); replyToMsgId = q?.msgId || q?.msg_id; } catch {}
        }
        res = await (ipc.telegramUser as any)?.sendFile({
          accountId: params.accountId, chatId, filePath, caption, fileType, replyToMsgId,
        });
      }
      console.log(`[TG:adapter] sendAttachment result: success=${res?.success} msgId=${res?.messageId} error=${res?.error}`);
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      console.error(`[TG:adapter] sendAttachment FAILED: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async sendVideo(params: SendVideoParams): Promise<ActionResult> {
    return this.sendAttachment({
      accountId: params.accountId,
      threadId: params.threadId,
      threadType: params.threadType,
      topicRootMessageId: params.topicRootMessageId,
      filePath: params.filePath,
      fileType: 'video',
      body: params.body,
    });
  }

  async unsendMessage(params: UnsendParams): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.deleteMessages({
        accountId: params.accountId,
        chatId: params.threadId || '',
        messageIds: [String(params.messageId).replace(/^tg_/, '')],
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async forwardMessage(params: ForwardParams): Promise<ActionResult> {
    const fromChatId = params.sourceThreadId;
    const toChatId = params.targetThreadId;
    if (!fromChatId || !toChatId) {
      return { success: false, error: 'Telegram forward requires sourceThreadId and targetThreadId.' };
    }
    try {
      const res = await ipc.telegramUser?.forwardMessages({
        accountId: params.accountId,
        fromChatId,
        toChatId,
        messageIds: [params.messageId],
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async editMessage(params: EditParams): Promise<ActionResult> {
    const chatId = params.threadId;
    if (!chatId) {
      return { success: false, error: 'Telegram edit requires threadId (conversation context).' };
    }
    try {
      const res = await ipc.telegramUser?.editMessage({
        accountId: params.accountId,
        chatId,
        messageId: params.messageId,
        text: params.text,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async addReaction(params: ReactionParams): Promise<ActionResult> {
    const chatId = params.threadId || '';
    if (!chatId) return { success: false, error: 'Telegram reaction requires the conversation ID.' };
    try {
      const res = await ipc.telegramUser?.sendReaction({
        accountId: params.accountId,
        chatId,
        messageId: String(params.messageId).replace(/^tg_/, ''),
        emoji: params.action === 'remove' ? undefined : params.emoji,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async sendTyping(params: TypingParams): Promise<ActionResult> {
    try {
      if (!params.isTyping) return { success: true };
      const res = await ipc.telegramUser?.sendTyping({ accountId: params.accountId, chatId: params.threadId });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getGroupLink(params: { accountId: string; threadId: string }): Promise<ActionResult & { link?: string }> {
    return this.exportInviteLink(params);
  }

  async setGroupAvatar(params: { accountId: string; threadId: string; photoPath: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.editChatPhoto({
        accountId: params.accountId,
        chatId: params.threadId,
        photoPath: params.photoPath,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async markAsRead(params: { accountId: string; threadId: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.readChatHistory({ accountId: params.accountId, chatId: params.threadId });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Đánh dấu đã đọc 1 forum topic cụ thể (dùng messages.ReadDiscussion) */
  async markTopicAsRead(params: { accountId: string; threadId: string; topicId: string; topMessageId?: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.readForumTopic({
        accountId: params.accountId,
        chatId: params.threadId,
        topMsgId: params.topicId,
        readMaxId: params.topMessageId,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ─── Forum / Topics ────────────────────────────────────────────────────

  async isForum(params: { accountId: string; threadId: string; forceApi?: boolean }): Promise<ActionResult & { isForum?: boolean }> {
    try {
      const res = await ipc.telegramUser?.isForum({ accountId: params.accountId, chatId: params.threadId, forceApi: params.forceApi });
      return { success: res?.success ?? false, isForum: res?.isForum, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getForumTopics(params: { accountId: string; threadId: string }): Promise<ActionResult & { topics?: any[] }> {
    try {
      const res = await ipc.telegramUser?.getForumTopics({ accountId: params.accountId, chatId: params.threadId });
      return { success: res?.success ?? false, topics: res?.topics, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getForumTopicMessages(params: { accountId: string; threadId: string; topicId: string; limit?: number }): Promise<ActionResult & { messages?: any[] }> {
    try {
      const res = await ipc.telegramUser?.getForumTopicMessages({ accountId: params.accountId, chatId: params.threadId, topicRootMessageId: params.topicId, limit: params.limit });
      return { success: res?.success ?? false, messages: res?.messages, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getUserProfile(params: { accountId: string; userId: string; threadId?: string }): Promise<ActionResult & { profile?: any }> {
    try {
      const res = await ipc.telegramUser?.getUserProfile({ accountId: params.accountId, userId: params.userId, chatId: params.threadId });
      return { success: res?.success ?? false, profile: res?.profile, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async createForumTopic(params: { accountId: string; threadId: string; title: string }): Promise<ActionResult & { topicId?: string }> {
    try {
      const res = await ipc.telegramUser?.createForumTopic({ accountId: params.accountId, chatId: params.threadId, title: params.title });
      return { success: res?.success ?? false, topicId: res?.topicId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async sendTopicMessage(params: { accountId: string; threadId: string; topicId: string; text: string }): Promise<ActionResult> {
    try {
      const res = await ipc.telegramUser?.sendTopicMessage({ accountId: params.accountId, chatId: params.threadId, topicRootMessageId: params.topicId, text: params.text });
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
