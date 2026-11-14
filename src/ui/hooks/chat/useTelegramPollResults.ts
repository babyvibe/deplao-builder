/**
 * Telegram poll results like the Telegram app: when a conversation is opened and every 30 s (while the window is shown), asks again for the results of the
 * latest polls being loaded (messages.getPollResults, main: telegramUser:refreshPollResults) and patches the attachments in the store.
 * Before, the results were only captured when the message arrived, so Deplao showed "0 lượt bình chọn" (0 votes) forever. Closed polls are not asked again (the
 * results do not change); when Telegram pushes new results (UpdateMessagePoll) main patches them itself via event:messagesRepaired.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';

const REFRESH_INTERVAL_MS = 30_000;
/** Number of the latest polls asked each time (one Telegram request per poll). */
const MAX_POLLS = 10;

function isOpenPoll(msg: any): boolean {
  if (msg?.msg_type !== 'telegram.poll' || !/^\d+$/.test(String(msg?.msg_id || ''))) return false;
  try {
    const list = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments || '[]') : msg.attachments;
    const poll = Array.isArray(list) ? list.find((item: any) => item?.type === 'poll') : null;
    return !!poll && !poll.closed;
  } catch {
    return false;
  }
}

export function useTelegramPollResults(
  accountId: string | null | undefined,
  threadId: string | null | undefined,
  channel: string | null | undefined,
  msgs: any[],
): void {
  const enabled = channel === 'telegram_user' && !!accountId && !!threadId;

  // ids of the open polls being loaded (latest first): ref so the interval always reads the new list without recreating the timer
  const pollIdsRef = React.useRef<string[]>([]);
  pollIdsRef.current = React.useMemo(() => {
    if (!enabled) return [];
    const ids: string[] = [];
    for (let index = msgs.length - 1; index >= 0 && ids.length < MAX_POLLS; index--) {
      if (isOpenPoll(msgs[index])) ids.push(String(msgs[index].msg_id));
    }
    return ids;
  }, [enabled, msgs]);
  const hasPolls = pollIdsRef.current.length > 0;

  React.useEffect(() => {
    if (!enabled || !hasPolls) return;
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (cancelled || running || document.hidden) return;
      const messageIds = pollIdsRef.current;
      if (!messageIds.length) return;
      running = true;
      try {
        const result = await ipc.telegramUser?.refreshPollResults?.({ accountId: accountId!, chatId: threadId!, messageIds });
        if (cancelled || !result?.success) return;
        const store = useChatStore.getState();
        for (const update of result.updates || []) {
          store.patchMessage(accountId!, threadId!, update.msgId, { attachments: update.attachments } as any);
        }
      } catch {
        // Connection lost / temporary error: try again next time
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    // Back to the window after it was hidden: ask right away instead of waiting for the next round
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, hasPolls, accountId, threadId]);
}
