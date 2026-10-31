/**
 * Trạng thái dùng chung của danh sách tin: khung cuộn + ref đo cuộn, cờ sẵn sàng của hội thoại, phân trang tin cũ,
 * "đang xem tin cũ". Các hook hành vi (useThreadLifecycle / useScrollFollow / useOlderMessages / useJumpToMessage)
 * cùng đọc / ghi bộ này; tách khai báo ra để mỗi hook chỉ giữ phần việc của nó.
 */
import { useCallback, useRef, useState } from 'react';

export function useMessageListState() {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Phần nội dung bên trong khung cuộn: ResizeObserver theo dõi phần này để bám đáy khi ảnh/video tải xong
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
  // nearBottomRef: cập nhật realtime từ scroll event (không gây re-render)
  // dùng cho ResizeObserver + realtime scroll — tránh stale closure
  const nearBottomRef = useRef(true);
  // Debounced scroll-to-bottom: gom nhiều request thành 1 lần scroll
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

  // Chỉ để hiện spinner (bật trễ khi trang tải lâu); chặn tải trùng dùng loadingMoreRef
  const [loadingMore, setLoadingMore] = useState(false);
  // "Có thể còn tin cũ hơn" — false khi lần tải đã chắc chắn hết
  const [hasMore, setHasMore] = useState(true);
  // Đã biết CHẮC còn tin cũ hơn (trang vừa tải trả dư 1 dòng) → mới hiện nút "Tải tin nhắn cũ hơn"
  const [olderKnown, setOlderKnown] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Mỗi lần tải tin cũ / đổi hội thoại tăng 1 — kết quả về muộn của lần tải cũ bị bỏ qua
  const loadSeqRef = useRef(0);
  // Đang cuộn mượt tới một tin (ghim / trích dẫn / tìm kiếm): chèn trang cũ lên trên lúc này làm lệch đích
  const suppressLoadOlderUntilRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  // Track khi đang xem tin nhắn cũ (do click vào ghim / quote / search) - cần nút "Về tin mới nhất"
  const [isViewingHistory, setIsViewingHistory] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);

  // ─── Thread ready gate: chỉ hiển thị UI khi messages + pins đều đã load ──
  const [threadReady, setThreadReady] = useState(false);
  const [messagesReady, setMessagesReady] = useState(false);
  // Track initial loading for PageLoading display
  const [initialLoading, setInitialLoading] = useState(true);
  // loadingSpinner: spinner trung tâm khi chuyển thread, chỉ done sau khi scroll hoàn tất
  const [loadingSpinner, setLoadingSpinner] = useState(false);
  // Track threadId đã scroll - tránh race condition giữa useLayoutEffect vs useEffect
  const lastScrolledThreadRef = useRef<string | null>(null);

  // Tải tin cũ khi cuộn gần đỉnh (useOlderMessages): hàm mới nhất + cờ chặn tải trùng
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
