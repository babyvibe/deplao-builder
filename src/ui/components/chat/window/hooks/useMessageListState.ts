/**
 * Shared state of the message list: the scroll container + the scroll-measuring ref, the conversation's ready flag, paging of older messages,
 * "đang xem tin cũ" (viewing old messages). The behavior hooks (useThreadLifecycle / useScrollFollow / useOlderMessages / useJumpToMessage)
 * read / write this same state; the declarations are kept separate so each hook only holds its own part.
 */
import { useCallback, useRef, useState } from 'react';

export function useMessageListState() {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // The content inside the scroll container: a ResizeObserver watches this part to stick to the bottom when photos / videos finish loading
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const pinnedBarWrapperRef = useRef<HTMLDivElement>(null);
  const prevPinnedBarHeightRef = useRef(0);
  const prevLastMsgIdRef = useRef<string>('');
  const savedScrollHeightRef = useRef(0);
  const savedScrollTopRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);
  const isInitialThreadLoadRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  // nearBottomRef: updated in real time from the scroll event (does not cause a re-render)
  // used by ResizeObserver + realtime scroll, avoids a stale closure
  const nearBottomRef = useRef(true);
  // Debounced scroll-to-bottom: batches many requests into one scroll
  const scrollRafRef = useRef(0);
  const scrollToBottom = useCallback((reason?: string) => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = messagesContainerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
      nearBottomRef.current = true;
    });
  }, []);

  // Only to show the spinner (turned on late when the page loads slowly); blocks duplicate loads using loadingMoreRef
  const [loadingMore, setLoadingMore] = useState(false);
  // "Có thể còn tin cũ hơn" (May have older messages): false once a load has confirmed there are none left
  const [hasMore, setHasMore] = useState(true);
  // Known for SURE that older messages remain (the page just loaded returned 1 extra row) → only then show the "Tải tin nhắn cũ hơn" (Load older messages) button
  const [olderKnown, setOlderKnown] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Incremented on each older-message load / conversation switch: a late result from an old load is ignored
  const loadSeqRef = useRef(0);
  // Smoothly scrolling to a message (pinned / quote / search): inserting an older page above now would throw off the target
  const suppressLoadOlderUntilRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  // Track when viewing old messages (after clicking a pin / quote / search): needs the "Về tin mới nhất" (Back to latest) button
  const [isViewingHistory, setIsViewingHistory] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);

  // ─── Thread ready gate: only show the UI when both messages + pins have loaded ──
  const [threadReady, setThreadReady] = useState(false);
  const [messagesReady, setMessagesReady] = useState(false);
  // Track initial loading for PageLoading display
  const [initialLoading, setInitialLoading] = useState(true);
  // loadingSpinner: the center spinner when switching threads, only done after the scroll finishes
  const [loadingSpinner, setLoadingSpinner] = useState(false);
  // Track the threadId already scrolled to: avoids a race condition between useLayoutEffect and useEffect
  const lastScrolledThreadRef = useRef<string | null>(null);

  // Load older messages when scrolled near the top (useOlderMessages): latest function + a flag that blocks duplicate loads
  const loadMoreFnRef = useRef<() => void>(() => {});
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);

  return {
    bottomRef, messagesContainerRef, messagesContentRef, pinnedBarWrapperRef, prevPinnedBarHeightRef, prevLastMsgIdRef,
    savedScrollHeightRef, savedScrollTopRef, shouldRestoreScrollRef, isInitialThreadLoadRef, initialScrollDoneRef,
    initialScrollDone, setInitialScrollDone, nearBottomRef, scrollRafRef, scrollToBottom,
    loadingMore, setLoadingMore, hasMore, setHasMore, olderKnown, setOlderKnown, loadError, setLoadError,
    loadSeqRef, suppressLoadOlderUntilRef, loadMoreFnRef, hasMoreRef, loadingMoreRef,
    atBottom, setAtBottom, isViewingHistory, setIsViewingHistory, loadingLatest, setLoadingLatest,
    threadReady, setThreadReady, messagesReady, setMessagesReady, initialLoading, setInitialLoading,
    loadingSpinner, setLoadingSpinner, lastScrolledThreadRef,
  };
}

export type MessageListState = ReturnType<typeof useMessageListState>;
