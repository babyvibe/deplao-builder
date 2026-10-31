/**
 * "Đang nhập..." của hội thoại đang mở: chỉ tick (500 ms) khi có người gõ trong 5 giây gần nhất, dừng khi không còn ai
 * (trước đây interval chạy mãi làm cả khung chat render lại mỗi 500 ms).
 */
import { useEffect, useState } from 'react';
import { useChatStore } from '@/store/chat/chatStore';

export function useTypingTicker(activeAccountId: string | null, activeThreadId: string | null, threadTypingKey: string): number {
  // OPTIMIZATION: Typing indicator - chỉ tick khi có typing trong thread hiện tại
  const [typingNow, setTypingNow] = useState(0);

  // Trigger khi người đang gõ trong thread hiện tại thay đổi
  useEffect(() => {
    if (threadTypingKey) setTypingNow(Date.now());
  }, [threadTypingKey]);

  // Interval chỉ chạy khi typingNow > 0 (có người đang typing)
  useEffect(() => {
    if (!typingNow) return; // SKIP nếu không có typing

    const id = setInterval(() => {
      const prefix = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}_` : '';
      if (!prefix) return;
      const store = useChatStore.getState();
      // Chỉ tính người gõ trong 5s gần nhất (như indicator). Đếm cả key cũ thì interval không bao giờ dừng
      // → cả cửa sổ chat render lại mỗi 500ms mãi khi có người gõ rồi không gửi.
      const nowTs = Date.now();
      const hasTyping = Object.entries(store.typingUsers).some(([k, ts]) => k.startsWith(prefix) && nowTs - ts < 5000);
      if (hasTyping) setTypingNow(nowTs);
      else setTypingNow(0); // Dừng interval khi không còn typing
    }, 500);

    return () => clearInterval(id);
  }, [activeAccountId, activeThreadId, typingNow]);

  return typingNow;
}
