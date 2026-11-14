/**
 * BaseChannelAdapter.ts - Base class that handles "không hỗ trợ" (not supported) centrally
 * Child adapters only override the methods they support.
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
import { tr } from '../../../../shared/i18n';

export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly channel: Channel;

  protected notSupported(action: string): ActionResult {
    return { success: false, error: tr('{{channel}} không hỗ trợ {{action}}', { channel: this.channel, action }) };
  }

  async sendMessage(_params: SendMessageParams): Promise<ActionResult> {
    return this.notSupported(tr('gửi tin nhắn'));
  }

  async sendAttachment(_params: SendAttachmentParams): Promise<ActionResult> {
    return this.notSupported(tr('gửi file'));
  }

  async sendVideo(_params: SendVideoParams): Promise<ActionResult> {
    return this.notSupported(tr('gửi video'));
  }

  async unsendMessage(_params: UnsendParams): Promise<ActionResult> {
    return this.notSupported(tr('thu hồi tin nhắn'));
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
    return this.notSupported(tr('kết nối tài khoản'));
  }

  async disconnectAccount(_params: DisconnectParams): Promise<ActionResult> {
    return this.notSupported(tr('ngắt kết nối'));
  }

  async checkHealth(_params: HealthParams): Promise<HealthResult> {
    return { success: false, alive: false, error: tr('{{channel}} không hỗ trợ health check', { channel: this.channel }) };
  }

  async changeGroupName(_params: GroupNameParams): Promise<ActionResult> {
    return this.notSupported(tr('đổi tên nhóm'));
  }

  async blockUser(_params: BlockParams): Promise<ActionResult> {
    return this.notSupported(tr('chặn người dùng'));
  }

  async unblockUser(_params: BlockParams): Promise<ActionResult> {
    return this.notSupported(tr('bỏ chặn người dùng'));
  }

  async forwardMessage(_params: ForwardParams): Promise<ActionResult> {
    return this.notSupported(tr('chuyển tiếp tin nhắn'));
  }

  async editMessage(_params: EditParams): Promise<ActionResult> {
    return this.notSupported(tr('chỉnh sửa tin nhắn'));
  }

  async createPoll(_params: PollParams): Promise<ActionResult> {
    return this.notSupported(tr('tạo bình chọn'));
  }
}
