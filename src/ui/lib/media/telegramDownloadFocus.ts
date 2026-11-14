/**
 * Tell main which Telegram conversation is open → that account's file download queue downloads photos / videos / files of this conversation first
 * (services/telegram/media/telegramDownloadQueue.ts). Previously the queue ran in arrival order: on app start, the catch-up of
 * every other conversation came first, so opening a conversation did not show its videos right away.
 *
 * Only reports when the value changes (switching conversation / account). Not Telegram, or no conversation open → priority is dropped.
 */
import ipc from '@/lib/ipc';
import { isTelegramUser } from '@/lib/channels/channelHelper';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';

export interface TelegramDownloadFocus {
  accountId: string | null;
  threadId: string | null;
}

export function telegramDownloadFocusOf(
  accountId: string | null | undefined,
  channel: string | undefined,
  threadId: string | null | undefined,
): TelegramDownloadFocus {
  return accountId && threadId && isTelegramUser(channel)
    ? { accountId, threadId }
    : { accountId: null, threadId: null };
}

function currentFocus(): TelegramDownloadFocus {
  const { activeAccountId, accounts } = useAccountStore.getState();
  const channel = accounts.find(account => account.zalo_id === activeAccountId)?.channel;
  return telegramDownloadFocusOf(activeAccountId, channel, useChatStore.getState().activeThreadId);
}

const defaultSend = (focus: TelegramDownloadFocus) => ipc.telegramUser?.setDownloadFocus?.(focus);

export function installTelegramDownloadFocus(
  send: (focus: TelegramDownloadFocus) => unknown = defaultSend,
): () => void {
  let last: string | null = null;
  const update = () => {
    const focus = currentFocus();
    const key = `${focus.accountId ?? ''}\u0000${focus.threadId ?? ''}`;
    if (key === last) return;
    last = key;
    try {
      Promise.resolve(send(focus)).catch(() => {});
    } catch {
      // Only a hint for the download order: it never breaks switching conversations
    }
  };
  const unsubscribeChat = useChatStore.subscribe(update);
  const unsubscribeAccount = useAccountStore.subscribe(update);
  update();
  return () => {
    unsubscribeChat();
    unsubscribeAccount();
  };
}
