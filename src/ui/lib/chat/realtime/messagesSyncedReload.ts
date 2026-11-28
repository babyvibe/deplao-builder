/**
 * Reloading what is shown after the Boss wrote messages without an event per message:
 *  - reloadNewestPage: the newest page of the open conversation, merged into memory (also used when the employee reconnects to the Boss);
 *  - reloadAfterMessagesSynced: `event:messagesSynced` (a bulk sync on the Boss: Zalo phone, Facebook history, Telegram). The employee
 *    used to see those messages only after F5. Reloads the conversation list of that account, its flags (muted / "Khác") and the open
 *    conversation when it belongs to that account.
 * A read error or an empty answer keeps what is shown.
 */
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { compareMessagesChronologically, getMessageCacheKey, useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { reloadAccountContacts } from '@/lib/chat/conversations/accountContacts';
import { MESSAGE_LOAD_LIMIT } from '@/lib/chat/constants';
import { mergeNewestPage } from '@/lib/chat/messages/messagePage';

/** The conversation (not a forum topic) open on screen belongs to this account. */
function openThreadOf(accountId: string): string | null {
  const chat = useChatStore.getState();
  if (!chat.activeThreadId || chat.activeTopicId) return null;
  return useAccountStore.getState().activeAccountId === accountId ? chat.activeThreadId : null;
}

/**
 * Reads the newest page of the open conversation again and merges it into memory (mergeNewestPage). Nothing changes on a read error, an
 * empty answer, or when another conversation / a topic was opened meanwhile.
 */
export async function reloadNewestPage(accountId: string, threadId: string): Promise<void> {
  const res: any = await DataAccessor.getMessages({ zaloId: accountId, threadId, limit: MESSAGE_LOAD_LIMIT, offset: 0 });
  const messages: any[] = res?.messages || res?.items || [];
  if (isReadFailure(res) || messages.length === 0) return;
  if (openThreadOf(accountId) !== threadId) return;
  const store = useChatStore.getState();
  const cached = store.messages[getMessageCacheKey(accountId, threadId)] || [];
  store.setMessages(accountId, threadId, mergeNewestPage(cached, [...messages].reverse(), MESSAGE_LOAD_LIMIT, compareMessagesChronologically));
}

/** After a bulk sync of `accountId` on the Boss: conversation list, flags, and the open conversation of that account. */
export async function reloadAfterMessagesSynced(accountId: string): Promise<void> {
  if (!accountId) return;
  const tasks: Promise<unknown>[] = [
    reloadAccountContacts(accountId),
    useAppStore.getState().loadFlags(accountId),
  ];
  const threadId = openThreadOf(accountId);
  if (threadId) tasks.push(reloadNewestPage(accountId, threadId));
  await Promise.allSettled(tasks);
}
