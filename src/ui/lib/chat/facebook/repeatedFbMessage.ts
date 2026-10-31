/**
 * Tin Facebook phát lại (`message.repeat` trong fb:onMessage): MQTT và bridge LightSpeed cùng nhận mỗi tin; main chỉ phát
 * lại khi bản tới sau sửa được hàng trong DB (hàng rỗng, thẻ "File đính kèm không hiển thị"), bản trùng y hệt không phát.
 * Bản phát lại chỉ vá tin đang hiện + xem trước của hội thoại: không thêm tin, không cộng chưa đọc, không báo lần nữa.
 */
import { useChatStore, type MessageItem } from '@/store/chat/chatStore';

export function applyRepeatedFbMessage(fbAccountId: string, threadId: string, normalized: MessageItem): void {
  const store = useChatStore.getState();
  const msgId = String(normalized.msg_id);
  const shown = (store.messages[`${fbAccountId}_${threadId}`] || []).find(m => String(m.msg_id) === msgId);
  // Tin đã thu hồi giữ nguyên (không hiện lại nội dung)
  if (shown && !shown.is_recalled) {
    store.patchMessage(fbAccountId, threadId, msgId, {
      content: normalized.content,
      msg_type: normalized.msg_type,
      ...(normalized.attachments ? { attachments: normalized.attachments } : {}),
    });
  }
  // Xem trước của hội thoại: chỉ khi tin này vẫn là tin mới nhất
  const contact = (store.contacts[fbAccountId] || []).find(c => c.contact_id === threadId);
  const preview = String(normalized.content || '').slice(0, 100);
  if (contact && preview && Number(contact.last_message_time || 0) <= Number(normalized.timestamp || 0)) {
    store.updateContact(fbAccountId, { contact_id: threadId, last_message: preview, channel: 'facebook' });
  }
}
