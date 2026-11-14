/**
 * ERP calendar linked to a conversation ("Thêm vào lịch" from a message): opens the right conversation (switches account, marks it read
 * like clicking the notification), then jumps to the message added to the calendar. Used in the reminder popup (App.tsx) and the calendar detail (CalendarPage).
 */
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';
import type { ErpCalendarEvent } from '../../../models/erp/CalendarEvent';

type LinkedEvent = Pick<ErpCalendarEvent, 'linked_account_id' | 'linked_contact_id' | 'linked_msg_id'>;

export function hasLinkedConversation(event: LinkedEvent | null | undefined): boolean {
  return !!(event?.linked_account_id && event?.linked_contact_id);
}

export function openLinkedConversation(event: LinkedEvent): void {
  const accountId = String(event.linked_account_id || '');
  const threadId = String(event.linked_contact_id || '');
  if (!accountId || !threadId) return;
  const contact = (useChatStore.getState().contacts[accountId] || []).find(c => c.contact_id === threadId);
  ipc.app?.openThread({ zaloId: accountId, threadId, threadType: contact?.contact_type === 'group' ? 1 : 0 });
  if (event.linked_msg_id) {
    // ChatWindow waits for the conversation to finish loading before jumping (pendingJumpRef)
    window.dispatchEvent(new CustomEvent('chat:jumpToMessage', {
      detail: { accountId, threadId, messageId: String(event.linked_msg_id) },
    }));
  }
}
