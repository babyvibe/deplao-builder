/**
 * TelegramBotAdapter.ts - Adapter cho kênh Telegram Bot
 * Gọi IPC telegram:* để gửi tin nhắn, kiểm tra health, etc.
 */

import { BaseChannelAdapter } from './BaseChannelAdapter';
import {
  ActionResult, SendMessageParams, SendAttachmentParams, SendVideoParams,
  UnsendParams, ReactionParams, ConnectParams, HealthResult, HealthParams,
  ForwardParams, EditParams, PollParams, GroupNameParams, BlockParams,
} from './ChannelAdapter';
import ipc from '../ipc';

export class TelegramBotAdapter extends BaseChannelAdapter {
  readonly channel = 'telegram_bot' as const;

  async sendMessage(params: SendMessageParams): Promise<ActionResult> {
    try {
      const res = await ipc.telegram?.sendMessage({
        accountId: params.accountId,
        chatId: params.threadId,
        text: params.body,
      });
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async sendAttachment(params: SendAttachmentParams): Promise<ActionResult> {
    try {
      const ext = (params.filePath || '').split('.').pop()?.toLowerCase() || '';
      // A caller that supplied fileType has already classified the source
      // message; infer from extension only for direct, unclassified uploads.
      const isVideo = params.fileType === 'video'
        || (!params.fileType && ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext));
      const isAudio = params.fileType === 'audio'
        || (!params.fileType && ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext));

      let res: any;
      if (params.fileType === 'sticker') {
        res = await (ipc.telegram as any)?.sendSticker({
          accountId: params.accountId, chatId: params.threadId, stickerPath: params.filePath,
        });
      } else if (params.fileType === 'voice') {
        res = await (ipc.telegram as any)?.sendVoice({
          accountId: params.accountId, chatId: params.threadId, voicePath: params.filePath,
        });
      } else if (params.fileType === 'animation') {
        res = await (ipc.telegram as any)?.sendAnimation({
          accountId: params.accountId, chatId: params.threadId, animPath: params.filePath,
        });
      } else if (params.fileType === 'video_note') {
        res = await (ipc.telegram as any)?.sendVideoNote({
          accountId: params.accountId, chatId: params.threadId, videoPath: params.filePath,
        });
      } else if (isVideo) {
        res = await ipc.telegram?.sendVideo({
          accountId: params.accountId, chatId: params.threadId,
          videoPath: params.filePath, caption: params.body,
        });
      } else if (isAudio) {
        res = await ipc.telegram?.sendAudio({
          accountId: params.accountId, chatId: params.threadId,
          audioPath: params.filePath, caption: params.body,
        });
      } else {
        // Default: send as photo (image) or document (other files)
        // Respect an explicit document classification (e.g. SVG attachment).
        // Only infer an image from the extension when the caller did not state a type.
        const isImage = params.fileType === 'image'
          || (!params.fileType && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext));
        if (isImage) {
          res = await ipc.telegram?.sendPhoto({
            accountId: params.accountId, chatId: params.threadId,
            photoPath: params.filePath, caption: params.body,
          });
        } else {
          res = await ipc.telegram?.sendDocument({
            accountId: params.accountId, chatId: params.threadId,
            filePath: params.filePath, caption: params.body,
          });
        }
      }
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async sendVideo(params: SendVideoParams): Promise<ActionResult> {
    try {
      const res = await ipc.telegram?.sendVideo({
        accountId: params.accountId,
        chatId: params.threadId,
        videoPath: params.filePath,
        caption: params.body,
      });
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async unsendMessage(params: UnsendParams): Promise<ActionResult> {
    try {
      const res = await ipc.telegram?.deleteMessage({
        accountId: params.accountId,
        chatId: params.threadId || '',
        messageId: params.messageId,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async addReaction(params: ReactionParams): Promise<ActionResult> {
    try {
      const res = await ipc.telegram?.addReaction({
        accountId: params.accountId,
        chatId: params.threadId || '',
        messageId: params.messageId,
        emoji: params.emoji,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async forwardMessage(params: ForwardParams): Promise<ActionResult> {
    if (!params.sourceThreadId) {
      return { success: false, error: 'Telegram forward requires sourceThreadId.' };
    }
    try {
      const res = await ipc.telegram?.forwardMessage({
        accountId: params.accountId,
        chatId: params.targetThreadId,
        fromChatId: params.sourceThreadId,
        messageId: params.messageId,
      });
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async editMessage(params: EditParams): Promise<ActionResult> {
    try {
      // EditParams: accountId, messageId, text
      const res = await ipc.telegram?.editMessage({
        accountId: params.accountId,
        chatId: '', // will be resolved by service
        messageId: params.messageId,
        text: params.text,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async createPoll(params: PollParams): Promise<ActionResult> {
    try {
      const res = await ipc.telegram?.sendPoll({
        accountId: params.accountId,
        chatId: params.threadId,
        question: params.question,
        options: params.options,
      });
      return { success: res?.success ?? false, msgId: res?.messageId, messageId: res?.messageId, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async changeGroupName(params: GroupNameParams): Promise<ActionResult> {
    try {
      const res = await (ipc as any).telegram?.setChatTitle?.({
        accountId: params.accountId,
        chatId: params.threadId,
        title: params.name,
      });
      // Fallback: setChatTitle may not be registered, use setChatDescription pattern
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async leaveGroup(params: { accountId: string; threadId: string }): Promise<ActionResult> {
    try {
      const res = await (ipc as any).telegram?.leaveChat({
        accountId: params.accountId,
        chatId: params.threadId,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async removeMember(params: { accountId: string; threadId: string; userId: string }): Promise<ActionResult> {
    try {
      const res = await (ipc as any).telegram?.banChatMember({
        accountId: params.accountId,
        chatId: params.threadId,
        userId: params.userId,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async promoteMember(params: { accountId: string; threadId: string; userId: string; isAdmin: boolean }): Promise<ActionResult> {
    try {
      const perms = params.isAdmin ? {
        canChangeInfo: true, canDeleteMessages: true, canInviteUsers: true,
        canRestrictMembers: true, canPinMessages: true, canManageVideoChats: true, canManageChat: true,
      } : {
        canChangeInfo: false, canDeleteMessages: false, canInviteUsers: false,
        canRestrictMembers: false, canPinMessages: false, canManageVideoChats: false, canManageChat: false,
        canPromoteMembers: false,
      };
      const res = await (ipc as any).telegram?.promoteChatMember({
        accountId: params.accountId,
        chatId: params.threadId,
        userId: params.userId,
        perms,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getGroupInfo(params: { accountId: string; threadId: string }): Promise<ActionResult & { info?: any }> {
    try {
      const res = await (ipc as any).telegram?.getChat({
        accountId: params.accountId,
        chatId: params.threadId,
      });
      return { success: res?.success ?? false, info: res?.chat, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getGroupMembers(params: { accountId: string; threadId: string }): Promise<ActionResult & { members?: any[] }> {
    try {
      const res = await (ipc as any).telegram?.getChatAdministrators({
        accountId: params.accountId,
        chatId: params.threadId,
      });
      return { success: res?.success ?? false, members: res?.admins, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async setGroupAvatar(params: { accountId: string; threadId: string; photoPath: string }): Promise<ActionResult> {
    try {
      const res = await (ipc as any).telegram?.setChatPhoto({
        accountId: params.accountId,
        chatId: params.threadId,
        photoPath: params.photoPath,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getGroupLink(params: { accountId: string; threadId: string }): Promise<ActionResult & { link?: string }> {
    try {
      const res = await (ipc as any).telegram?.exportChatInviteLink({
        accountId: params.accountId,
        chatId: params.threadId,
      });
      return { success: res?.success ?? false, link: res?.link, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async connectAccount(params: ConnectParams): Promise<ActionResult> {
    try {
      // Lấy botToken từ accounts qua IPC (đã decrypt ở main process)
      let botToken = params.auth?.botToken || '';
      let botName = params.auth?.botName || '';
      if (!botToken) {
        try {
          const accountsRes = await (await import('../ipc')).default.login?.getAccounts();
          const botAccount = accountsRes?.accounts?.find((a: any) =>
            a.zalo_id === params.accountId && a.channel === 'telegram_bot'
          );
          botToken = botAccount?.cookies || '';
          botName = botAccount?.full_name || '';
        } catch {}
      }
      if (!botToken) return { success: false, error: 'Bot token không tồn tại. Vui lòng đăng nhập lại.' };
      const res = await ipc.telegram?.startBot({
        accountId: params.accountId,
        botToken,
        botUsername: botName,
        botFirstName: botName,
      });
      return { success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async disconnectAccount(params: { accountId: string }): Promise<ActionResult> {
    try {
      await ipc.telegram?.stopBot(params.accountId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async checkHealth(params: HealthParams): Promise<HealthResult> {
    try {
      const res = await ipc.telegram?.getActiveBots();
      const isActive = res?.bots?.some((b: any) => b.accountId === params.accountId) ?? false;
      // Also check if the bot is actually polling (not just registered)
      if (isActive) {
        const pollingRes = await ipc.telegram?.isBotPolling?.({ accountId: params.accountId });
        return { success: true, alive: pollingRes?.polling ?? isActive };
      }
      return { success: true, alive: false };
    } catch {
      return { success: false, alive: false };
    }
  }
}
