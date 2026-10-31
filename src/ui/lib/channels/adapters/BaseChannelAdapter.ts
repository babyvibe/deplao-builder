/**
 * BaseChannelAdapter.ts - Base class xử lý "không hỗ trợ" tập trung
 * Adapter con chỉ override đúng method mình hỗ trợ.
 */

import {
  ChannelAdapter,
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
} from './ChannelAdapter';
import { Channel } from '../../../../configs/channels/channelConfig';

export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly channel: Channel;

  protected notSupported(action: string): ActionResult {
    return { success: false, error: `${this.channel} không hỗ trợ ${action}` };
  }

  async sendMessage(_params: SendMessageParams): Promise<ActionResult> {
    return this.notSupported('gửi tin nhắn');
  }

  async sendAttachment(_params: SendAttachmentParams): Promise<ActionResult> {
    return this.notSupported('gửi file');
  }

  async sendVideo(_params: SendVideoParams): Promise<ActionResult> {
    return this.notSupported('gửi video');
  }

  async unsendMessage(_params: UnsendParams): Promise<ActionResult> {
    return this.notSupported('thu hồi tin nhắn');
  }

  async addReaction(_params: ReactionParams): Promise<ActionResult> {
    return this.notSupported('reaction');
  }

  async getThreads(_params: GetThreadsParams): Promise<ThreadsResult> {
    return { success: true, threads: [] };
  }

  async getMessages(_params: GetMessagesParams): Promise<MessagesResult> {
    return { success: true, messages: [] };
  }

  async markAsRead(_params: MarkReadParams): Promise<ActionResult> {
    return { success: true };
  }

  async sendTyping(_params: TypingParams): Promise<ActionResult> {
    return { success: true };
  }

  async connectAccount(_params: ConnectParams): Promise<ActionResult> {
    return this.notSupported('kết nối tài khoản');
  }

  async disconnectAccount(_params: DisconnectParams): Promise<ActionResult> {
    return this.notSupported('ngắt kết nối');
  }

  async checkHealth(_params: HealthParams): Promise<HealthResult> {
    return { success: false, alive: false, error: `${this.channel} không hỗ trợ health check` };
  }

  async changeGroupName(_params: GroupNameParams): Promise<ActionResult> {
    return this.notSupported('đổi tên nhóm');
  }

  async blockUser(_params: BlockParams): Promise<ActionResult> {
    return this.notSupported('chặn người dùng');
  }

  async unblockUser(_params: BlockParams): Promise<ActionResult> {
    return this.notSupported('bỏ chặn người dùng');
  }

  async forwardMessage(_params: ForwardParams): Promise<ActionResult> {
    return this.notSupported('chuyển tiếp tin nhắn');
  }

  async editMessage(_params: EditParams): Promise<ActionResult> {
    return this.notSupported('chỉnh sửa tin nhắn');
  }

  async createPoll(_params: PollParams): Promise<ActionResult> {
    return this.notSupported('tạo bình chọn');
  }
}
