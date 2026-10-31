/**
 * ZaloAdapter.ts - Adapter cho kênh Zalo
 * Di chuyển nguyên trạng logic từ channelIpc.ts nhánh Zalo.
 */

import { BaseChannelAdapter } from './BaseChannelAdapter';
import {
  ActionResult, ThreadsResult, MessagesResult, HealthResult,
  SendMessageParams, SendAttachmentParams, SendVideoParams,
  UnsendParams, ReactionParams, GetMessagesParams,
  ConnectParams, GroupNameParams, BlockParams, ForwardParams,
  EditParams, PollParams,
} from './ChannelAdapter';
import ipc, { buildZaloAuth } from '../../ipc';
import DataAccessor from '../../data/DataAccessor';

export class ZaloAdapter extends BaseChannelAdapter {
  readonly channel = 'zalo' as const;

  private resolveAuth(accountId: string, auth?: any): any {
    if (auth) return auth;
    try {
      const { useAccountStore } = require('../../../store/accounts/accountStore');
      const account = useAccountStore.getState().accounts?.find((a: any) => a.zalo_id === accountId);
      if (account?.cookies) return buildZaloAuth(account, accountId);
      // Máy nhân viên không có cookie (snapshot không gửi) → auth chỉ mang accountId, Boss gắn phiên thật của đúng tài
      // khoản đó (trước đây trả undefined → "Missing auth", hoặc Boss dùng tài khoản được giao đầu tiên)
      const { useEmployeeStore } = require('../../../store/employee/employeeStore');
      if (account && useEmployeeStore.getState().mode === 'employee') return buildZaloAuth(account, accountId);
    } catch {}
    return undefined;
  }

  async sendMessage(params: SendMessageParams): Promise<ActionResult> {
    const auth = this.resolveAuth(params.accountId, params.auth);
    return ipc.zalo?.sendMessage({
      auth,
      threadId: params.threadId,
      type: params.threadType ?? 0,
      message: params.body,
      ...params.options,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  async sendAttachment(params: SendAttachmentParams): Promise<ActionResult> {
    return ipc.zalo?.sendFile({
      zaloId: params.accountId,
      threadId: params.threadId,
      threadType: params.threadType ?? 0,
      filePath: params.filePath,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  async sendVideo(params: SendVideoParams): Promise<ActionResult> {
    if (!params.auth) return { success: false, error: 'Missing auth for Zalo video' };

    // Upload thumbnail
    let thumbUrl = '';
    if (params.thumbPath) {
      const uploadRes = await ipc.zalo?.uploadVideoThumb?.({
        auth: params.auth,
        thumbPath: params.thumbPath,
        threadId: params.threadId,
        type: params.threadType,
      });
      const resp = uploadRes?.response;
      thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
    }

    // Upload video file
    const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({
      auth: params.auth,
      videoPath: params.filePath,
      threadId: params.threadId,
      type: params.threadType,
    });
    const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
    if (!videoUrl) return { success: false, error: 'Upload video thất bại' };

    // Send video message
    await ipc.zalo?.sendVideo({
      auth: params.auth,
      options: {
        videoUrl,
        thumbnailUrl: thumbUrl || videoUrl,
        duration: params.duration ? params.duration * 1000 : undefined,
        width: params.width || undefined,
        height: params.height || undefined,
      },
      threadId: params.threadId,
      type: params.threadType,
      ...(params.quote ? { quote: params.quote } : {}),
    });

    return { success: true };
  }

  async unsendMessage(params: UnsendParams): Promise<ActionResult> {
    return ipc.zalo?.undoMessage({
      zaloId: params.accountId,
      threadId: params.threadId,
      threadType: params.threadType ?? 0,
      msgId: params.messageId,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  async addReaction(params: ReactionParams): Promise<ActionResult> {
    return ipc.zalo?.addReaction({
      zaloId: params.accountId,
      threadId: params.threadId,
      threadType: params.threadType ?? 0,
      msgId: params.messageId,
      icon: params.emoji,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  async getMessages(params: GetMessagesParams): Promise<MessagesResult> {
    return DataAccessor.getMessages?.({
      zaloId: params.accountId,
      threadId: params.threadId,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    }) ?? { success: false, error: 'DB IPC not available' };
  }

  async connectAccount(params: ConnectParams): Promise<ActionResult> {
    return ipc.login?.connectAccount?.(params.auth)
      ?? { success: false, error: 'Login IPC not available' };
  }

  async disconnectAccount(params: { accountId: string }): Promise<ActionResult> {
    return ipc.login?.disconnectAccount?.(params.accountId)
      ?? { success: false, error: 'Login IPC not available' };
  }

  async checkHealth(params: { accountId: string }): Promise<HealthResult> {
    const res = await ipc.login?.checkHealth?.(params.accountId);
    const result = res?.results?.[0];
    return { success: res?.success ?? false, alive: result?.healthy ?? false, error: result?.reason };
  }

  async changeGroupName(params: GroupNameParams): Promise<ActionResult> {
    return ipc.zalo?.changeGroupName?.({
      zaloId: params.accountId,
      groupId: params.threadId,
      name: params.name,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  async blockUser(params: BlockParams): Promise<ActionResult> {
    return ipc.zalo?.blockUser?.({
      auth: { zaloId: params.accountId },
      userId: params.userId,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  async unblockUser(params: BlockParams): Promise<ActionResult> {
    return ipc.zalo?.unblockUser?.({
      auth: { zaloId: params.accountId },
      userId: params.userId,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  async forwardMessage(params: ForwardParams): Promise<ActionResult> {
    return ipc.zalo?.forwardMessage?.({
      auth: { zaloId: params.accountId },
      msgId: params.messageId,
      threadId: params.targetThreadId,
      type: params.threadType ?? 0,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }

  // editMessage: Zalo không hỗ trợ → dùng default từ BaseChannelAdapter

  async createPoll(params: PollParams): Promise<ActionResult> {
    return ipc.zalo?.createPoll?.({
      auth: { zaloId: params.accountId },
      groupId: params.threadId,
      question: params.question,
      options: params.options,
    }) ?? { success: false, error: 'Zalo IPC not available' };
  }
}
