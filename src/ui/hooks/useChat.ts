import { useCallback } from 'react';
import { useChatStore, MessageItem, ContactItem } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '../lib/ipc';
import { sendSeenForThread } from '@/lib/sendSeenHelper';

/**
 * Hook quản lý trạng thái chat — load messages, contacts, gửi tin nhắn
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
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  }, [getActiveAccount]);

  /** Tải danh sách hội thoại từ DB */
  const loadContacts = useCallback(
    async (zaloId: string) => {
      try {
        const res = await ipc.db?.getContacts(zaloId);
        if (res?.contacts) setContacts(zaloId, res.contacts);
      } catch {}
    },
    [setContacts]
  );

  /** Chọn thread để xem, tải messages từ DB */
  const selectThread = useCallback(
    async (contactId: string, threadType: number) => {
      if (!activeAccountId) return;
      setActiveThread(contactId, threadType);
      clearUnread(activeAccountId, contactId);

      // Mark as read in DB
      await ipc.db?.markAsRead({ zaloId: activeAccountId, contactId });
      // Gửi sự kiện đã đọc cho Zalo
      sendSeenForThread(activeAccountId, contactId, threadType);

      // Load messages from DB
      try {
        const res = await ipc.db?.getMessages({
          zaloId: activeAccountId,
          threadId: contactId,
          limit: 50,
          offset: 0,
        });
        if (res?.messages) {
          setMessages(activeAccountId, contactId, [...res.messages].reverse());
        }
      } catch {}
    },
    [activeAccountId, setActiveThread, clearUnread, setMessages]
  );

  /** Tải thêm messages cũ (phân trang) */
  const loadMoreMessages = useCallback(
    async (threadId: string, currentCount: number) => {
      if (!activeAccountId) return false;
      try {
        const res = await ipc.db?.getMessages({
          zaloId: activeAccountId,
          threadId,
          limit: 30,
          offset: currentCount,
        });
        if (res?.messages?.length > 0) {
          prependMessages(activeAccountId, threadId, [...res.messages].reverse());
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

