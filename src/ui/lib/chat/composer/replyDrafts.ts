/**
 * Reply drafts PER conversation (like Telegram): replying to a message in conversation A, then switching to B shows no reply in B,
 * and going back to A brings the old reply back. `chatStore.replyTo` is still the reply of the open conversation; MessageInput saves /
 * restores it when the conversation changes (or the forum topic). Only remembered for the current session. Pure: tested in
 * src/__tests__/chat/composer/replyDrafts.test.ts.
 */
import type { MessageItem } from '@/store/chat/chatStore';

const drafts = new Map<string, MessageItem>();

/** Key: account + conversation (+ Telegram forum topic: one reply per topic). */
export function replyDraftKey(accountId: string | null | undefined, threadId: string | null | undefined, topicId?: string | number | null): string {
  if (!accountId || !threadId) return '';
  return `${accountId}_${threadId}${topicId != null && topicId !== '' ? `_t${topicId}` : ''}`;
}

/** Save the reply of the conversation just left (null = no reply left). */
export function saveReplyDraft(key: string, reply: MessageItem | null | undefined): void {
  if (!key) return;
  if (reply) drafts.set(key, reply);
  else drafts.delete(key);
}

/** The conversation's unfinished reply (null if none). */
export function getReplyDraft(key: string): MessageItem | null {
  return (key && drafts.get(key)) || null;
}

/** A reply message has been sent: drop that reply in every conversation that saved it. */
export function forgetReplyDraft(reply: MessageItem | null | undefined): void {
  if (!reply) return;
  for (const [key, value] of drafts) {
    if (value === reply || (value.msg_id === reply.msg_id && value.thread_id === reply.thread_id && value.owner_zalo_id === reply.owner_zalo_id)) {
      drafts.delete(key);
    }
  }
}

/** Workspace change: the old account's replies no longer make sense. */
export function clearReplyDrafts(): void {
  drafts.clear();
}
