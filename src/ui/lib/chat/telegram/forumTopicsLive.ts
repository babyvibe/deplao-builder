/**
 * A new message in a Telegram forum group → the topic row in the loaded list (chatStore.forumTopics) updates at once: latest message,
 * time, unread count, as in Telegram, without calling the API again. A group whose topic list is not open does nothing. It does not write
 * to localStorage for every message: the next topic-list load (reopening the panel) writes Telegram's copy.
 */
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';
import { applyForumTopicMessage, type ForumTopicLiveMessage, type ForumTopicRow } from '../../../../shared/telegram/forumTopics';

export function noteForumTopicMessage(accountId: string, chatId: string, message: ForumTopicLiveMessage): void {
  const key = `${accountId}_${chatId}`;
  const chat = useChatStore.getState();
  const list = chat.forumTopics[key] as ForumTopicRow[] | undefined;
  if (!list?.length) return;
  const isOpen = chat.activeThreadId === chatId && useAccountStore.getState().activeAccountId === accountId;
  const next = applyForumTopicMessage(list, message, isOpen ? { topicId: chat.activeTopicId || null } : null);
  if (!next) return;
  useChatStore.setState((state) => ({ forumTopics: { ...state.forumTopics, [key]: next } }));
}
