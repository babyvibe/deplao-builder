/**
 * Hội thoại đang mở: đúng phần store cần cho khung chat (tài khoản, hội thoại / topic, tin, danh bạ, đang gõ, đã xem,
 * thông tin nhóm, mốc đã nhận / đã xem, quản trị viên nhóm Telegram, số liệu bài kênh). Chỉ subscribe phần của hội thoại
 * đang mở: `useChatStore()` không selector làm cả cửa sổ render lại với mọi thay đổi ở hội thoại / tài khoản khác.
 */
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getMessageCacheKey, useChatStore, type ContactItem, type MessageItem } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { getCapability, type Channel } from '@/../configs/channels/channelConfig';
import { CHANNEL, isTelegramUser } from '@/lib/channels/channelHelper';
import { inferredPeerReadTs, mergePeerReceipts } from '@/lib/chat/messages/messageStatus';
import { useTelegramGroupAdmins } from '@/lib/chat/telegram/telegramGroupAdmins';
import { useTelegramPostStats } from '@/hooks/chat/useTelegramPostStats';

/** Giá trị rỗng ổn định cho selector (không tạo mảng mới mỗi lần render → memo phía sau không chạy lại) */
const EMPTY_MESSAGES: MessageItem[] = [];
const EMPTY_CONTACTS: ContactItem[] = [];

/** Chuỗi đại diện những người đang gõ trong 1 hội thoại — selector trả chuỗi nên so theo giá trị. */
function typingSignature(typingUsers: Record<string, number>, prefix: string): string {
  if (!prefix) return '';
  let signature = '';
  for (const key in typingUsers) {
    if (key.startsWith(prefix)) signature += `${key}=${typingUsers[key]};`;
  }
  return signature;
}

export function useOpenThread() {
  const { activeAccountId, getActiveAccount, accounts: allAccounts } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, getActiveAccount: s.getActiveAccount, accounts: s.accounts,
  })));
  const {
    activeThreadId, prependMessages, setMessages, setReplyTo, editingMsg, setEditingMsg, removeMessage, updateContact,
    messagesLoading, activeTopicId, activeForumTopicId, activeTopicTitle,
  } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, prependMessages: s.prependMessages, setMessages: s.setMessages,
    setReplyTo: s.setReplyTo, editingMsg: s.editingMsg, setEditingMsg: s.setEditingMsg, removeMessage: s.removeMessage,
    updateContact: s.updateContact, messagesLoading: s.messagesLoading, activeTopicId: s.activeTopicId,
    activeForumTopicId: s.activeForumTopicId, activeTopicTitle: s.activeTopicTitle,
  })));
  const threadKey = activeAccountId && activeThreadId
    ? getMessageCacheKey(activeAccountId, activeThreadId, activeTopicId)
    : '';
  const msgs = useChatStore(s => (threadKey ? s.messages[threadKey] : undefined)) ?? EMPTY_MESSAGES;
  const contactList = useChatStore(s => (activeAccountId ? s.contacts[activeAccountId] : undefined)) ?? EMPTY_CONTACTS;
  const typingPrefix = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}_` : '';
  const threadTypingKey = useChatStore(s => typingSignature(s.typingUsers, typingPrefix));
  const threadSeen = useChatStore(s => (activeAccountId && activeThreadId ? s.seenInfo[`${activeAccountId}_${activeThreadId}`] : undefined));
  const { showNotification, searchHighlightQuery } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, searchHighlightQuery: s.searchHighlightQuery,
  })));
  const threadGroupInfo = useAppStore(s => (
    activeAccountId && activeThreadId ? s.groupInfoCache?.[activeAccountId]?.[activeThreadId] : undefined
  ));

  const activeContact = React.useMemo(() => {
    if (!activeAccountId || !activeThreadId) return undefined;
    return contactList.find(c => c.contact_id === activeThreadId);
  }, [activeAccountId, activeThreadId, contactList]);
  const channelCap = React.useMemo(() =>
    getCapability((activeContact?.channel || CHANNEL.ZALO) as Channel),
  [activeContact]);
  // Mốc người kia đã nhận / đã xem tin mình gửi (cột của hội thoại + event:receipt realtime) → dấu ✓ / ✓✓ cạnh giờ
  const liveReceipt = useChatStore(s => (activeAccountId && activeThreadId ? s.peerReceipts[`${activeAccountId}_${activeThreadId}`] : undefined));
  // Người kia nhắn sau tin mình gửi ⇒ đã xem các tin trước đó (Zalo / Facebook không phải lúc nào cũng báo "đã xem")
  const inferredReadTs = React.useMemo(() => inferredPeerReadTs(msgs, activeContact?.channel), [msgs, activeContact?.channel]);
  const threadReceipt = React.useMemo(() => mergePeerReceipts(
    activeContact ? { deliveredTs: activeContact.peer_delivered_ts, readTs: activeContact.peer_read_ts, readMaxId: activeContact.peer_read_max_id } : null,
    liveReceipt,
    inferredReadTs ? { readTs: inferredReadTs } : null,
  ), [activeContact?.peer_delivered_ts, activeContact?.peer_read_ts, activeContact?.peer_read_max_id, liveReceipt, inferredReadTs]);
  // Nhóm Telegram: chức vụ (chức vụ tự đặt / Quản trị viên / Chủ nhóm) ở góc phải tên người gửi, như Telegram
  const telegramGroupAdmins = useTelegramGroupAdmins(
    activeAccountId, activeThreadId,
    isTelegramUser(activeContact?.channel) && activeContact?.contact_type === 'group',
  );
  // Kênh Telegram: lượt xem / số bình luận của bài làm mới khi mở kênh + mỗi 60 s (như Telegram); hồ sơ người bình luận
  // gần đây cho thanh bình luận
  const postReplierPeers = useTelegramPostStats(activeAccountId, activeThreadId, activeContact?.channel, msgs);

  return {
    activeAccountId, getActiveAccount, allAccounts,
    activeThreadId, activeTopicId, activeForumTopicId, activeTopicTitle, threadKey,
    prependMessages, setMessages, setReplyTo, setEditingMsg, removeMessage, updateContact, messagesLoading,
    msgs, contactList, threadTypingKey, threadSeen, threadGroupInfo, activeContact, channelCap, threadReceipt,
    telegramGroupAdmins, postReplierPeers, showNotification, searchHighlightQuery,
  };
}

export type OpenThread = ReturnType<typeof useOpenThread>;
