/**
 * Telegram channel post stats like the Telegram app: when a channel is opened and every 60 s, asks again for the views / comment count / recent commenters of the
 * latest posts being loaded (messages.getMessagesViews, main: telegramUser:refreshPostStats) and patches the
 * attachments in the store. Before, the stats were only captured when the post arrived → far off from Telegram (views, comments).
 * The first ask each time a channel is opened counts one view (increment), like Telegram does when a post appears.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { getTelegramPostMeta } from '@/lib/media/mediaResolver';
import { useChatStore } from '@/store/chat/chatStore';

const REFRESH_INTERVAL_MS = 60_000;
/** Number of the latest posts asked each time (Telegram limits 100 ids per call). */
const MAX_POSTS = 60;

export type TelegramPostPeers = Record<string, { name: string; avatar: string }>;

export function useTelegramPostStats(
  accountId: string | null | undefined,
  threadId: string | null | undefined,
  channel: string | null | undefined,
  msgs: any[],
): TelegramPostPeers {
  const [peers, setPeers] = React.useState<TelegramPostPeers>({});
  const enabled = channel === 'telegram_user' && !!accountId && !!threadId;

  // ids of the posts being loaded (latest first): ref so the interval always reads the new list without recreating the timer
  const postIdsRef = React.useRef<string[]>([]);
  postIdsRef.current = React.useMemo(() => {
    if (!enabled) return [];
    const ids: string[] = [];
    for (let index = msgs.length - 1; index >= 0 && ids.length < MAX_POSTS; index--) {
      const msg = msgs[index];
      if (!/^\d+$/.test(String(msg?.msg_id || ''))) continue;
      if (getTelegramPostMeta(msg)) ids.push(String(msg.msg_id));
    }
    return ids;
  }, [enabled, msgs]);
  const hasPosts = postIdsRef.current.length > 0;

  React.useEffect(() => {
    setPeers({});
  }, [accountId, threadId]);

  React.useEffect(() => {
    if (!enabled || !hasPosts) return;
    let cancelled = false;
    let counted = false;
    let running = false;
    const refresh = async () => {
      if (cancelled || running || document.hidden) return;
      const messageIds = postIdsRef.current;
      if (!messageIds.length) return;
      running = true;
      try {
        const result = await ipc.telegramUser?.refreshPostStats?.({
          accountId: accountId!, chatId: threadId!, messageIds, increment: !counted,
        });
        if (cancelled || !result?.success) return;
        counted = true;
        const store = useChatStore.getState();
        for (const update of result.updates || []) {
          store.patchMessage(accountId!, threadId!, update.msgId, { attachments: update.attachments } as any);
        }
        if (result.peers && Object.keys(result.peers).length) {
          setPeers((previous) => ({ ...previous, ...result.peers }));
        }
      } catch {
        // Connection lost / temporary error: try again next time
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, hasPosts, accountId, threadId]);

  return peers;
}
