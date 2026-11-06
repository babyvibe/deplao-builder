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
import { getCapability } from '@/../configs/channels/channelConfig';
import { isNonZalo, isTelegramUser, resolveChannel } from '@/lib/channels/channelHelper';
import { inferredPeerReadTs, mergePeerReceipts } from '@/lib/chat/messages/messageStatus';
import { useTelegramGroupAdmins } from '@/lib/chat/telegram/telegramGroupAdmins';
import { useTelegramPostStats } from '@/hooks/chat/useTelegramPostStats';
import { useTelegramPollResults } from '@/hooks/chat/useTelegramPollResults';

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
    activeThreadId, activeThreadType, prependMessages, setMessages, setReplyTo, editingMsg, setEditingMsg, removeMessage, updateContact,
    messagesLoading, activeTopicId, activeForumTopicId, activeTopicTitle,
  } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, activeThreadType: s.activeThreadType, prependMessages: s.prependMessages, setMessages: s.setMessages,
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

  const accountChannel = allAccounts.find(a => a.zalo_id === activeAccountId)?.channel;
  const activeContact = React.useMemo((): ContactItem | undefined => {
    if (!activeAccountId || !activeThreadId) return undefined;
    const found = contactList.find(c => c.contact_id === activeThreadId);
    if (found) return found;
    // Hội thoại chưa có trong các trang đã tải (hội thoại ghim / My Documents tải bù theo id): tài khoản Telegram / Facebook
    // vẫn biết kênh, không để khung chat coi là Zalo (đồng bộ, nút Telegram, gửi tin)
    if (!isNonZalo(accountChannel)) return undefined;
    return {
      owner_zalo_id: activeAccountId, contact_id: activeThreadId, display_name: '', avatar_url: '', is_friend: 0,
      contact_type: activeThreadType === 1 ? 'group' : 'user', unread_count: 0, last_message: '', last_message_time: 0,
      channel: resolveChannel(null, { channel: accountChannel }),
    } as ContactItem;
  }, [activeAccountId, activeThreadId, activeThreadType, contactList, accountChannel]);
  const channelCap = React.useMemo(() =>
    getCapability(resolveChannel(activeContact, { channel: accountChannel })),
  [activeContact, accountChannel]);
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
  // Bình chọn Telegram: kết quả làm mới khi mở hội thoại + mỗi 30 s (như Telegram)
  useTelegramPollResults(activeAccountId, activeThreadId, activeContact?.channel, msgs);

  return {
    activeAccountId, getActiveAccount, allAccounts,
    activeThreadId, activeTopicId, activeForumTopicId, activeTopicTitle, threadKey,
    prependMessages, setMessages, setReplyTo, setEditingMsg, removeMessage, updateContact, messagesLoading,
    msgs, contactList, threadTypingKey, threadSeen, threadGroupInfo, activeContact, channelCap, threadReceipt,
    telegramGroupAdmins, postReplierPeers, showNotification, searchHighlightQuery,
  };
}

export type OpenThread = ReturnType<typeof useOpenThread>;
