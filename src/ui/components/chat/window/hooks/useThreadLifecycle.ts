/**
 * Vòng đời hội thoại trong khung chat: đổi hội thoại → đặt lại mọi trạng thái (trước khi vẽ), cổng "sẵn sàng" (tin +
 * ghim đã tải), dự phòng khi tải lâu, cuộn xuống đáy lần đầu khi chiều cao đã ổn định, tắt lớp "Đang tải...".
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
  /** Đổi hội thoại: phần ngoài danh sách cần đặt lại (chọn nhiều tin, thanh chọn reaction) */
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

  // Reset khi đổi thread — DÙNG useLayoutEffect (chạy trước paint) để tránh
  // "double flash": nếu dùng useEffect, first render vẫn giữ threadReady=true
  // → messages container hiện ra với empty state (spinner) trước khi reset.
  // useLayoutEffect đảm bảo reset state trước khi browser paint frame đầu tiên.
  useLayoutEffect(() => {
    setHasMore(true);
    setOlderKnown(false);
    setLoadError(false);
    // Lần tải tin cũ của hội thoại trước (nếu còn đang chạy) không được chặn / ghi đè hội thoại này
    loadSeqRef.current++;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    initialScrollDoneRef.current = false;
    setInitialScrollDone(false);
    setAtBottom(true);
    setIsViewingHistory(false);
    prevLastMsgIdRef.current = '';      // reset để luôn trigger scroll khi load messages
    shouldRestoreScrollRef.current = false;
    isInitialThreadLoadRef.current = true;
    // Reset thread ready gate - ẩn UI cho đến khi data load xong
    setThreadReady(false);
    setMessagesReady(false);
    setInitialLoading(true);
    initialScrollDoneRef.current = false;
    setInitialScrollDone(false);
    lastScrolledThreadRef.current = null;
    prevPinnedBarHeightRef.current = 0;
    nearBottomRef.current = true; // hội thoại mới mở ở đáy (giá trị cũ có thể là của hội thoại trước)
    // Phần ngoài danh sách (chế độ chọn nhiều tin, thanh chọn reaction của hội thoại trước)
    onThreadSwitch();
    setLoadingSpinner(true);
  }, [activeAccountId, activeThreadId]);

  // ─── Thread ready gate: set true khi messages đã có data trong store ────────
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
    // setInitialLoading(false); // chờ messages load
  }, [pinsReady, messagesReady, activeThreadId]);

  // ─── Safety fallback: nếu loading quá 3s mà vẫn chưa ready → force hiển thị ───
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

  // ─── Clear initial loading khi messages thực sự có data ────────────────
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
