/**
 * Số liệu bài đăng kênh Telegram như app Telegram: khi mở kênh và mỗi 60 s, hỏi lại lượt xem / số bình luận / người bình
 * luận gần đây của các bài mới nhất đang tải (messages.getMessagesViews, main: telegramUser:refreshPostStats) rồi vá
 * attachments trong store. Trước đây số liệu chỉ chụp lúc bài về → lệch xa Telegram (lượt xem, bình luận).
 * Lần hỏi đầu tiên mỗi lần mở kênh tính một lượt xem (increment), như Telegram khi bài hiện ra.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { getTelegramPostMeta } from '@/lib/media/mediaResolver';
import { useChatStore } from '@/store/chat/chatStore';

const REFRESH_INTERVAL_MS = 60_000;
/** Số bài mới nhất hỏi mỗi lần (Telegram giới hạn 100 id / lần gọi). */
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

  // id các bài đang tải (mới nhất trước) — ref để interval luôn đọc danh sách mới mà không tạo lại timer
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
        // Mất kết nối / lỗi tạm: lần sau thử lại
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
