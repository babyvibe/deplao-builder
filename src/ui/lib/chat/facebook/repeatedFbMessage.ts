/**
 * Facebook message replayed (`message.repeat` in fb:onMessage): MQTT and the LightSpeed bridge both receive each message; main only re-emits when the later copy fixes a row in the DB (empty row, the card "File đính kèm không hiển thị" (attachment not shown)); an identical duplicate is not re-emitted.
 * A replay only patches the shown message and the conversation preview: it adds no message, does not add to unread, and does not notify again.
 */
import { useChatStore, type MessageItem } from '@/store/chat/chatStore';

export function applyRepeatedFbMessage(fbAccountId: string, threadId: string, normalized: MessageItem): void {
  const store = useChatStore.getState();
  const msgId = String(normalized.msg_id);
  const shown = (store.messages[`${fbAccountId}_${threadId}`] || []).find(m => String(m.msg_id) === msgId);
  // Recalled messages stay as they are (content is not shown again)
  if (shown && !shown.is_recalled) {
    store.patchMessage(fbAccountId, threadId, msgId, {
      content: normalized.content,
      msg_type: normalized.msg_type,
      ...(normalized.attachments ? { attachments: normalized.attachments } : {}),
    });
  }
  // Conversation preview: only if this message is still the newest one
  const contact = (store.contacts[fbAccountId] || []).find(c => c.contact_id === threadId);
  const preview = String(normalized.content || '').slice(0, 100);
  if (contact && preview && Number(contact.last_message_time || 0) <= Number(normalized.timestamp || 0)) {
    store.updateContact(fbAccountId, { contact_id: threadId, last_message: preview, channel: 'facebook' });
  }
}
