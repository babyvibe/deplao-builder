/**
 * Lịch Quản lý công việc gắn với hội thoại ("Thêm vào lịch" từ tin nhắn): mở đúng hội thoại (đổi tài khoản, báo đã đọc
 * như bấm thông báo) rồi nhảy tới tin đã thêm vào lịch. Dùng ở popup nhắc lịch (App.tsx) và chi tiết lịch (CalendarPage).
 */
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chatStore';
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
    // ChatWindow chờ hội thoại tải xong mới nhảy (pendingJumpRef)
    window.dispatchEvent(new CustomEvent('chat:jumpToMessage', {
      detail: { accountId, threadId, messageId: String(event.linked_msg_id) },
    }));
  }
}
