/**
 * Kết quả bình chọn Telegram như app Telegram: khi mở hội thoại và mỗi 30 s (cửa sổ đang hiện), hỏi lại kết quả các bình
 * chọn mới nhất đang tải (messages.getPollResults, main: telegramUser:refreshPollResults) rồi vá attachments trong store.
 * Trước đây kết quả chỉ chụp lúc tin về nên Deplao hiện "0 lượt bình chọn" mãi. Bình chọn đã đóng không hỏi nữa (kết
 * quả không đổi); Telegram đẩy kết quả mới (UpdateMessagePoll) thì main tự vá qua event:messagesRepaired.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';

const REFRESH_INTERVAL_MS = 30_000;
/** Số bình chọn mới nhất hỏi mỗi lần (mỗi bình chọn một lệnh Telegram). */
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

  // id các bình chọn còn mở đang tải (mới nhất trước) — ref để interval luôn đọc danh sách mới mà không tạo lại timer
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
        // Mất kết nối / lỗi tạm: lần sau thử lại
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    // Quay lại cửa sổ sau khi ẩn: hỏi ngay thay vì chờ lượt kế
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, hasPolls, accountId, threadId]);
}
