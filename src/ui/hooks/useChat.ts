import { useCallback } from 'react';
import { useChatStore, MessageItem, ContactItem } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useAppStore } from '@/store/appStore';
import ipc, { buildZaloAuth } from '../lib/ipc';
import * as channelIpc from '../lib/channelIpc';
import { sendSeenForThread } from '@/lib/sendSeenHelper';
import DataAccessor from '../lib/data/DataAccessor';

/**
 * Hook quản lý trạng thái chat - load messages, contacts, gửi tin nhắn
 */
export function useChat() {
  const {
    contacts,
    messages,
    activeThreadId,
    activeThreadType,
    setContacts,
    setMessages,
    addMessage,
    prependMessages,
    updateContact,
    setActiveThread,
    incrementUnread,
    clearUnread,
  } = useChatStore();

  const { activeAccountId, getActiveAccount } = useAccountStore();
  const { showNotification } = useAppStore();

  const getAuth = useCallback(() => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc);
  }, [getActiveAccount]);

  /** Tải danh sách hội thoại từ DB (hoặc REST cho employee) */
  const loadContacts = useCallback(
    async (zaloId: string) => {
      try {
        const result = await DataAccessor.getConversations(zaloId, 500, 0);
        if (result?.items) {
          setContacts(zaloId, result.items);
        }
      } catch {}
    },
    [setContacts]
  );

  /** Chọn thread để xem, tải messages từ DB (hoặc REST cho employee) */
  const selectThread = useCallback(
    async (contactId: string, threadType: number) => {
      if (!activeAccountId) return;
      useChatStore.getState().setMessagesLoading(true);
      setActiveThread(contactId, threadType);
      clearUnread(activeAccountId, contactId);

      // Determine channel from contact data
      const currentContacts = useChatStore.getState().contacts[activeAccountId] || [];
      const contact = currentContacts.find(c => c.contact_id === contactId);
      const channel = (contact?.channel || 'zalo') as string;

      // Mark as read in DB
      await DataAccessor.markAsRead({ zaloId: activeAccountId, contactId });
      // Gửi sự kiện đã đọc: Zalo uses sendSeenForThread, Facebook uses channelIpc
      if (channel === 'facebook') {
        channelIpc.markAsRead('facebook', { accountId: activeAccountId, threadId: contactId }).catch(() => {});
      } else {
        sendSeenForThread(activeAccountId, contactId, threadType);
      }

      // Load messages from DB (or REST)
      try {
        const isEmp = useEmployeeStore.getState().mode === 'employee';
        console.log(`[useChat] selectThread → contact=${contactId} type=${threadType} employee=${isEmp}`);
        useChatStore.getState().setMessagesLoading(true);
        const result = await DataAccessor.getMessages({
          zaloId: activeAccountId,
          threadId: contactId,
          limit: 50,
        });
        useChatStore.getState().setMessagesLoading(false);
        const msgs = result?.items || result?.messages || [];
        console.log(`[useChat] getMessages result: items=${result?.items?.length ?? 0} messages=${result?.messages?.length ?? 0} isArray=${Array.isArray(result)} keys=${result ? Object.keys(result).join(',') : 'null'}`);
        if (msgs.length > 0) {
          console.log(`[useChat] ✅ Setting ${msgs.length} messages, first=${msgs[0]?.msg_id || msgs[0]?.id || '?'}`);
          setMessages(activeAccountId, contactId, [...msgs].reverse());
        } else {
          console.warn(`[useChat] ⚠️ No messages returned, contactId=${contactId} employee=${isEmp}`);
        }
      } catch (err) {
        console.error(`[useChat] ❌ selectThread error:`, err);
        useChatStore.getState().setMessagesLoading(false);
      }
    },
    [activeAccountId, setActiveThread, clearUnread, setMessages]
  );

  /** Tải thêm messages cũ (phân trang) */
  const loadMoreMessages = useCallback(
    async (threadId: string, currentCount: number) => {
      if (!activeAccountId) return false;
      try {
        const result = await DataAccessor.getMessages({
          zaloId: activeAccountId,
          threadId,
          limit: 30,
          offset: currentCount,
          before: undefined, // sẽ dùng offset-based tạm thời
        });
        // Fallback: nếu REST không trả về items, thử IPC
        const msgs = result?.items || result?.messages || [];
        if (msgs.length > 0) {
          prependMessages(activeAccountId, threadId, [...msgs].reverse());
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [activeAccountId, prependMessages]
  );

  /** Gửi tin nhắn văn bản */
  const sendMessage = useCallback(
    async (text: string): Promise<boolean> => {
      const auth = getAuth();
      if (!auth || !activeThreadId || !activeAccountId) return false;

      const tempMsg: MessageItem = {
        msg_id: `temp_${Date.now()}`,
        owner_zalo_id: activeAccountId,
        thread_id: activeThreadId,
        thread_type: activeThreadType,
        sender_id: activeAccountId,
        content: text,
        msg_type: 'text',
        timestamp: Date.now(),
        is_sent: 1,
        status: 'sending',
      };
      addMessage(activeAccountId, activeThreadId, tempMsg);

      try {
        await ipc.zalo?.sendMessage({
          auth,
          threadId: activeThreadId,
          type: activeThreadType,
          message: text,
        });
        return true;
      } catch (err: any) {
        showNotification('Gửi tin nhắn thất bại: ' + err.message, 'error');
        return false;
      }
    },
    [getAuth, activeThreadId, activeThreadType, activeAccountId, addMessage, showNotification]
  );

  /** Lấy messages của thread hiện tại */
  const currentMessages = (): MessageItem[] => {
    if (!activeAccountId || !activeThreadId) return [];
    return messages[`${activeAccountId}_${activeThreadId}`] || [];
  };

  /** Lấy contacts của account hiện tại */
  const currentContacts = (): ContactItem[] => {
    if (!activeAccountId) return [];
    return contacts[activeAccountId] || [];
  };

  return {
    contacts,
    messages,
    activeThreadId,
    activeThreadType,
    currentMessages,
    currentContacts,
    loadContacts,
    selectThread,
    loadMoreMessages,
    sendMessage,
    addMessage,
    updateContact,
    incrementUnread,
    clearUnread,
  };
}
