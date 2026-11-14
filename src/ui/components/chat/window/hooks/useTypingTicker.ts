/**
 * "Đang nhập..." (typing...) of the open conversation: only ticks (500 ms) when someone has typed in the last 5 seconds, and stops when nobody is typing
 * (the interval used to run forever, re-rendering the whole chat window every 500 ms).
 */
import { useEffect, useState } from 'react';
import { useChatStore } from '@/store/chat/chatStore';

export function useTypingTicker(activeAccountId: string | null, activeThreadId: string | null, threadTypingKey: string): number {
  // OPTIMIZATION: Typing indicator: only ticks when someone is typing in the current thread
  const [typingNow, setTypingNow] = useState(0);

  // Triggered when the person typing in the current thread changes
  useEffect(() => {
    if (threadTypingKey) setTypingNow(Date.now());
  }, [threadTypingKey]);

  // The interval only runs when typingNow > 0 (someone is typing)
  useEffect(() => {
    if (!typingNow) return; // SKIP if nobody is typing

    const id = setInterval(() => {
      const prefix = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}_` : '';
      if (!prefix) return;
      const store = useChatStore.getState();
      // Only counts people typing in the last 5 s (like the indicator). If old keys are counted too, the interval never stops
      // → the whole chat window re-renders every 500 ms forever when someone types and never sends.
      const nowTs = Date.now();
      const hasTyping = Object.entries(store.typingUsers).some(([k, ts]) => k.startsWith(prefix) && nowTs - ts < 5000);
      if (hasTyping) setTypingNow(nowTs);
      else setTypingNow(0); // Stop the interval when no one is typing anymore
    }, 500);

    return () => clearInterval(id);
  }, [activeAccountId, activeThreadId, typingNow]);

  return typingNow;
}
