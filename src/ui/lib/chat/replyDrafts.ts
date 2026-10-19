/**
 * Trích dẫn đang dở THEO TỪNG hội thoại (như Telegram): đang trả lời tin ở hội thoại A, sang B thì B không có trích dẫn,
 * quay lại A thì trích dẫn cũ hiện lại. `chatStore.replyTo` vẫn là trích dẫn của hội thoại đang mở; MessageInput cất /
 * lấy lại khi đổi hội thoại (hoặc chủ đề forum). Chỉ nhớ trong phiên làm việc. Thuần — test ở
 * src/__tests__/replyDrafts.test.ts.
 */
import type { MessageItem } from '@/store/chatStore';

const drafts = new Map<string, MessageItem>();

/** Khoá: tài khoản + hội thoại (+ chủ đề forum Telegram: mỗi chủ đề một trích dẫn). */
export function replyDraftKey(accountId: string | null | undefined, threadId: string | null | undefined, topicId?: string | number | null): string {
  if (!accountId || !threadId) return '';
  return `${accountId}_${threadId}${topicId != null && topicId !== '' ? `_t${topicId}` : ''}`;
}

/** Cất trích dẫn của hội thoại vừa rời (null = không còn trích dẫn). */
export function saveReplyDraft(key: string, reply: MessageItem | null | undefined): void {
  if (!key) return;
  if (reply) drafts.set(key, reply);
  else drafts.delete(key);
}

/** Trích dẫn đang dở của hội thoại (null nếu không có). */
export function getReplyDraft(key: string): MessageItem | null {
  return (key && drafts.get(key)) || null;
}

/** Tin trả lời đã gửi xong: bỏ trích dẫn đó ở mọi hội thoại đang cất nó. */
export function forgetReplyDraft(reply: MessageItem | null | undefined): void {
  if (!reply) return;
  for (const [key, value] of drafts) {
    if (value === reply || (value.msg_id === reply.msg_id && value.thread_id === reply.thread_id && value.owner_zalo_id === reply.owner_zalo_id)) {
      drafts.delete(key);
    }
  }
}

/** Đổi workspace: trích dẫn của tài khoản cũ không còn ý nghĩa. */
export function clearReplyDrafts(): void {
  drafts.clear();
}
