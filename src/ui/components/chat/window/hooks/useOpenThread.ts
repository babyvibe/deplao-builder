/**
 * The open conversation: exactly the store parts the chat window needs (account, conversation / topic, messages, contacts, typing, seen,
 * group info, received / seen marks, Telegram group admins, channel post stats). Only subscribes to the part of the open conversation:
 * `useChatStore()` without a selector would re-render the whole window on every change in other conversations / accounts.
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

/** Stable empty value for selectors (does not create a new array on every render, so the memo after it does not run again) */
const EMPTY_MESSAGES: MessageItem[] = [];
const EMPTY_CONTACTS: ContactItem[] = [];

/** String of the people typing in one conversation: the selector returns a string, so it is compared by value. */
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
    // The conversation is not in the pages loaded so far (a pinned conversation / My Documents loaded by id): a Telegram / Facebook account
    // still knows its channel, so the chat window does not treat it as Zalo (sync, the Telegram button, sending messages)
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
  // The other side's received / seen marks for the messages I sent (the conversation's columns + realtime event:receipt) → ✓ / ✓✓ marks next to the time
  const liveReceipt = useChatStore(s => (activeAccountId && activeThreadId ? s.peerReceipts[`${activeAccountId}_${activeThreadId}`] : undefined));
  // The other side messaged after my message ⇒ they have seen the earlier messages (Zalo / Facebook do not always report "đã xem" (seen))
  const inferredReadTs = React.useMemo(() => inferredPeerReadTs(msgs, activeContact?.channel), [msgs, activeContact?.channel]);
  const threadReceipt = React.useMemo(() => mergePeerReceipts(
    activeContact ? { deliveredTs: activeContact.peer_delivered_ts, readTs: activeContact.peer_read_ts, readMaxId: activeContact.peer_read_max_id } : null,
    liveReceipt,
    inferredReadTs ? { readTs: inferredReadTs } : null,
  ), [activeContact?.peer_delivered_ts, activeContact?.peer_read_ts, activeContact?.peer_read_max_id, liveReceipt, inferredReadTs]);
  // Telegram group: the role (custom title / Admin / Owner) at the right of the sender's name, like Telegram
  const telegramGroupAdmins = useTelegramGroupAdmins(
    activeAccountId, activeThreadId,
    isTelegramUser(activeContact?.channel) && activeContact?.contact_type === 'group',
  );
  // Telegram channel: post view / comment counts refresh when the channel opens + every 60 s (like Telegram); profiles of recent commenters
  // for the comment bar
  const postReplierPeers = useTelegramPostStats(activeAccountId, activeThreadId, activeContact?.channel, msgs);
  // Telegram polls: results refresh when the conversation opens + every 30 s (like Telegram)
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
