/**
 * Conversation lifecycle in the chat window: switching conversation → reset every state (before painting), the "sẵn sàng" (ready) gate (messages +
 * pins loaded), a fallback when loading is slow, scroll to the bottom on the first load once the height is stable, turn off the "Đang tải..." (Loading...) layer.
 */
import { useEffect, useLayoutEffect } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import type { MessageListState } from './useMessageListState';

export function useThreadLifecycle(list: MessageListState, deps: {
  activeAccountId: string | null;
  activeThreadId: string | null;
  threadKey: string;
  msgs: any[];
  messagesLoading: boolean;
  pinsReady: boolean;
  /** Switching conversation: the parts outside the list need resetting (multi-select, the reaction bar) */
  onThreadSwitch: () => void;
}) {
  const {
    messagesContainerRef, prevPinnedBarHeightRef, prevLastMsgIdRef, shouldRestoreScrollRef, isInitialThreadLoadRef,
    initialScrollDoneRef, setInitialScrollDone, nearBottomRef, scrollToBottom, setLoadingMore, setHasMore,
    setOlderKnown, setLoadError, loadSeqRef, loadingMoreRef, setAtBottom, setIsViewingHistory, threadReady,
    setThreadReady, messagesReady, setMessagesReady, initialLoading, setInitialLoading, loadingSpinner,
    setLoadingSpinner, lastScrolledThreadRef,
  } = list;
  const { activeAccountId, activeThreadId, threadKey, msgs, messagesLoading, pinsReady, onThreadSwitch } = deps;

  // Reset when switching threads. USES useLayoutEffect (runs before paint) to avoid
  // "double flash": with useEffect, the first render would still keep threadReady=true
  // → the messages container shows up with the empty state (spinner) before the reset.
  // useLayoutEffect makes sure the state is reset before the browser paints the first frame.
  useLayoutEffect(() => {
    setHasMore(true);
    setOlderKnown(false);
    setLoadError(false);
    // An older-message load of the previous conversation (if still running) must not block or overwrite this conversation
    loadSeqRef.current++;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    initialScrollDoneRef.current = false;
    setInitialScrollDone(false);
    setAtBottom(true);
    setIsViewingHistory(false);
    prevLastMsgIdRef.current = '';      // reset so the scroll always triggers when the messages load
    shouldRestoreScrollRef.current = false;
    isInitialThreadLoadRef.current = true;
    // Reset the thread ready gate: hide the UI until the data has loaded
    setThreadReady(false);
    setMessagesReady(false);
    setInitialLoading(true);
    initialScrollDoneRef.current = false;
    setInitialScrollDone(false);
    lastScrolledThreadRef.current = null;
    prevPinnedBarHeightRef.current = 0;
    nearBottomRef.current = true; // a newly opened conversation starts at the bottom (the old value may belong to the previous conversation)
    // Outside the list (multi-select mode, the reaction bar of the previous conversation)
    onThreadSwitch();
    setLoadingSpinner(true);
  }, [activeAccountId, activeThreadId]);

  // ─── Thread ready gate: set to true when messages already have data in the store ────────
  useEffect(() => {
    if (!activeThreadId) {
      setMessagesReady(false);
      return;
    }
    // Require msgs.length > 0 OR loading finished (empty conversation)
    if (msgs.length > 0) {
      setMessagesReady(true);
    } else if (!messagesLoading) {
      // Empty conversation or loading finished with no messages
      setMessagesReady(true);
    }
  }, [activeThreadId, threadKey, msgs.length, messagesLoading]);

  useEffect(() => {
    if (!activeThreadId) return;
    setThreadReady(pinsReady && messagesReady);
    // setInitialLoading(false); // wait for the messages to load
  }, [pinsReady, messagesReady, activeThreadId]);

  // ─── Safety fallback: if loading takes more than 3s and it is still not ready → force display ───
  useEffect(() => {
    if (!activeThreadId) return;
    const fallback = setTimeout(() => {
      if (!useChatStore.getState().messagesLoading) {
        setMessagesReady(true);
        setThreadReady(true);
        setInitialLoading(false);
      }
    }, 5000);
    return () => clearTimeout(fallback);
  }, [activeThreadId]);

  // ─── Clear initial loading when the messages really have data ────────────────
  useEffect(() => {
    if (threadReady && messagesReady && initialLoading) {
      setInitialLoading(false);
    }
  }, [threadReady, messagesReady, initialLoading]);

  // ─── Single scroll-to-bottom effect for initial thread load ────────────────
  // Consolidates: useLayoutEffect cached + useEffect settling + double-RAF
  // into one reliable mechanism using stable-height detection.
  useEffect(() => {
    if (!threadReady || !messagesReady || !activeThreadId || !threadKey) return;
    if (!msgs.length) return;
    if (lastScrolledThreadRef.current === threadKey) return;

    // Wait for at least 1 real message to avoid premature lock from realtime
    const realCount = msgs.filter(m => !String(m.msg_id).startsWith('temp_')).length;
    if (realCount < 1 && messagesLoading) return;

    let cancelled = false;

    // Stable-height detection: wait until scrollHeight stops changing
    // (meaning all messages have been rendered by React)
    const waitForStable = () => {
      const el = messagesContainerRef.current;
      if (!el || cancelled) return;
      const h1 = el.scrollHeight;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const h2 = messagesContainerRef.current?.scrollHeight || 0;
        if (h2 !== h1) {
          // Height still changing → wait another frame
          requestAnimationFrame(() => {
            if (cancelled) return;
            scrollToBottom('initial-stable');
            lockScroll();
          });
        } else {
          // Height stable → scroll now
          scrollToBottom('initial');
          lockScroll();
        }
      });
    };

    const lockScroll = () => {
      if (cancelled) return;
      initialScrollDoneRef.current = true;
      setInitialScrollDone(true);
      lastScrolledThreadRef.current = threadKey;
      setAtBottom(true);
      // Hide spinner after scroll has been painted
      requestAnimationFrame(() => {
        if (!cancelled) setLoadingSpinner(false);
      });
    };

    // Small delay to let React render the initial batch
    const timer = setTimeout(waitForStable, 16);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [threadReady, messagesReady, activeThreadId, threadKey, msgs.length, messagesLoading, scrollToBottom]);

  // ─── Loading spinner fallback cho empty/cached thread ──
  // Khi initialScrollDoneRef da duoc set (cached) hoac msgs.length === 0 (empty),
  // initial scroll effect khong fire → khong goi setLoadingSpinner(false).
  // Fallback: khi threadReady && loadingSpinner, kiem tra neu khong can scroll → tat spinner.
  useEffect(() => {
    if (!loadingSpinner || !threadReady) return;
    const isCached = lastScrolledThreadRef.current === threadKey;
    if (msgs.length === 0 || isCached) {
      setLoadingSpinner(false);
    }
  }, [loadingSpinner, threadReady, msgs.length, threadKey]);
}
