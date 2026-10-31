/**
 * Tin mới của nhóm forum Telegram → dòng chủ đề trong danh sách đã tải (chatStore.forumTopics) đổi ngay: tin mới nhất,
 * giờ, số chưa đọc — như Telegram, không gọi lại API. Nhóm chưa mở danh sách chủ đề thì không làm gì. Không ghi
 * localStorage mỗi tin: lần tải danh sách sau (mở lại panel) ghi bản của Telegram.
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
