/**
 * Gửi một tin chữ tới hội thoại Facebook từ ngoài ô soạn tin (nút postback / trả lời nhanh của tin mẫu Page) — cùng
 * đường với ô soạn tin: tin tạm "đang gửi" + hàng đợi gửi (thử lại, nhận echo thay tin tạm).
 *
 * Thư viện LightSpeed không có lệnh postback: Page nhận tên nút như một tin nhắn (giống phần hiện trong khung chat của
 * Messenger), không nhận mã ẩn (payload) của nút.
 */
import * as channelIpc from '@/lib/channelIpc';
import { generateTempId, messageQueue } from '@/lib/MessageQueue';
import { useChatStore } from '@/store/chatStore';

export function sendFacebookText(input: { accountId: string; threadId: string; threadType?: number; text: string }): boolean {
  const text = String(input.text || '').trim();
  const { accountId, threadId } = input;
  if (!text || !accountId || !threadId) return false;
  const threadType = Number(input.threadType) === 1 ? 1 : 0;
  const tempId = generateTempId();
  useChatStore.getState().addMessage(accountId, threadId, {
    msg_id: tempId, owner_zalo_id: accountId, thread_id: threadId,
    thread_type: threadType, sender_id: accountId, content: text,
    msg_type: 'text', timestamp: Date.now(), is_sent: 1, status: 'sending', channel: 'facebook',
    send_status: 'pending', temp_id: tempId, media_type: 'text',
  } as any);
  messageQueue.enqueue({
    tempId,
    zaloId: accountId,
    threadId,
    threadType,
    channel: 'facebook' as any,
    sendFn: async () => {
      try {
        const res: any = await channelIpc.sendMessage('facebook' as any, { accountId, threadId, body: text, threadType });
        if (!res?.success) {
          return { success: false, uncertain: !!res?.uncertain, msgId: res?.messageId, error: res?.error || 'Gửi tin nhắn Facebook thất bại' };
        }
        return { success: true, msgId: res?.messageId };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    },
    onSuccess: () => useChatStore.getState().markReplied(accountId, threadId),
  });
  return true;
}
