/**
 * Cuộn của danh sách tin: thanh ghim cao / thấp đi, nội dung đổi cỡ (ảnh / video tải xong), vị trí cuộn (đáy, rời đáy
 * khi cuộn lên), tin mới (của mình hoặc đang ở đáy) → xuống đáy, sự kiện cuộn từ nơi khác (gợi ý AI, thư viện đã gửi),
 * giữ nguyên chỗ đang xem khi chèn trang tin cũ lên trên.
 */
import { useEffect, useLayoutEffect } from 'react';
import type { MessageListState } from './useMessageListState';

export function useScrollFollow(list: MessageListState, deps: {
  activeAccountId: string | null;
  activeThreadId: string | null;
  activeContact: any;
  msgs: any[];
  pins: any[];
  pinnedNotes: any[];
  maybeLoadOlder: () => void;
}) {
  const {
    messagesContainerRef, messagesContentRef, pinnedBarWrapperRef, prevPinnedBarHeightRef, prevLastMsgIdRef,
    savedScrollHeightRef, savedScrollTopRef, shouldRestoreScrollRef, isInitialThreadLoadRef, initialScrollDoneRef,
    nearBottomRef, scrollToBottom, setAtBottom, threadReady,
  } = list;
  const { activeAccountId, activeThreadId, activeContact, msgs, pins, pinnedNotes, maybeLoadOlder } = deps;

  useLayoutEffect(() => {
    if (!threadReady) return;
    const scroller = messagesContainerRef.current;
    const currentHeight = pinnedBarWrapperRef.current?.offsetHeight || 0;
    const prevHeight = prevPinnedBarHeightRef.current;
    if (!initialScrollDoneRef.current) {
      prevPinnedBarHeightRef.current = currentHeight;
      return;
    }
    if (scroller && currentHeight !== prevHeight) {
      if (nearBottomRef.current) {
        scrollToBottom('pinned-bar');
      } else {
        scroller.scrollTop += (currentHeight - prevHeight);
      }
    }
    prevPinnedBarHeightRef.current = currentHeight;
  }, [threadReady, activeThreadId, pins.length, pinnedNotes.length, scrollToBottom]);


  // ─── ResizeObserver: auto-scroll khi content resize mà user đang ở bottom ──
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || !threadReady) return;
    // Kéo về đáy NGAY trong callback (chạy sau layout, trước khi vẽ) thay vì đợi frame sau → không thấy khung
    // bị đẩy rồi mới giật về. So khoảng cách tới đáy chứ không so scrollHeight: khi khung cuộn thấp đi (thanh
    // ghim / "Đã xem" / "đang nhập" hiện ra muộn, ô soạn tin cao lên) scrollHeight không đổi nhưng đáy bị che.
    const ro = new ResizeObserver(() => {
      if (!nearBottomRef.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    // Khung cuộn cao cố định nên chỉ observe khung thì không biết khi nội dung cao lên (ảnh / video tải xong
    // sau khi đã cuộn xuống đáy) → theo dõi cả phần nội dung để vẫn bám đáy.
    if (messagesContentRef.current) ro.observe(messagesContentRef.current);
    return () => ro.disconnect();
  }, [activeThreadId, threadReady]);

  // Scroll event: track top/bottom position + nearBottomRef (dùng cho ResizeObserver)
  // Tối ưu: dùng rAF throttle + chỉ setState khi giá trị thay đổi để tránh re-render liên tục
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    let rafId = 0;
    let lastAtBottom = true;
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      if (rafId) return; // throttle bằng rAF
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const { scrollTop, scrollHeight, clientHeight } = el;
        // Chỉ cuộn LÊN (người dùng / nhảy tới tin cũ) mới rời đáy. Nội dung cao lên cũng sinh scroll event (neo
        // cuộn) hoặc đẩy đáy ra xa mà scrollTop không giảm — nếu tính lại ở đây thì ResizeObserver thấy "không ở
        // đáy" và để hội thoại bị đẩy lên luôn.
        if (scrollHeight - scrollTop - clientHeight < 150) nearBottomRef.current = true;
        else if (scrollTop < lastScrollTop) nearBottomRef.current = false;
        lastScrollTop = scrollTop;
        const newAtBottom = scrollHeight - scrollTop - clientHeight < 60;
        if (newAtBottom !== lastAtBottom) { lastAtBottom = newAtBottom; setAtBottom(newAtBottom); }
        maybeLoadOlder();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (rafId) cancelAnimationFrame(rafId); };
  }, [activeThreadId]);

  // ─── Scroll to bottom khi AI suggestions bar xuất hiện/biến mất ──────────
  useEffect(() => {
    const handler = () => {
      if (nearBottomRef.current) scrollToBottom('ai-suggestions');
    };
    window.addEventListener('ai:suggestionsBarChanged', handler);
    return () => window.removeEventListener('ai:suggestionsBarChanged', handler);
  }, [scrollToBottom]);

  // Scroll to bottom khi LibraryPickerModal gửi xong
  useEffect(() => {
    const handler = () => scrollToBottom('library-sent');
    window.addEventListener('chat:scrollToBottom', handler);
    return () => window.removeEventListener('chat:scrollToBottom', handler);
  }, [scrollToBottom]);

  // Scroll to bottom chỉ khi có tin nhắn MỚI (tin cuối thay đổi), không scroll khi prepend tin cũ
  // Initial load scroll được xử lý bởi consolidated scroll effect
  useEffect(() => {
    if (!msgs.length) return;
    const lastMsg = msgs[msgs.length - 1];
    const lastMsgId = lastMsg.msg_id;
    if (lastMsgId !== prevLastMsgIdRef.current) {
      prevLastMsgIdRef.current = lastMsgId;
      if (!shouldRestoreScrollRef.current) {
        const isInitial = isInitialThreadLoadRef.current;
        isInitialThreadLoadRef.current = false;
        if (isInitial) {
          // Cuộn lần đầu do effect gộp phía trên lo; còn tin cũ hay không thì lần tải trang (maybeLoadOlder)
          // xác định — dò bằng 1 truy vấn riêng ở đây vô dụng vì DB trả cả tin cùng mốc (timestamp <= before).
          return;
        }
        // Realtime messages
        const isOutgoing =
          lastMsg?.is_sent === 1 ||
          (activeAccountId ? String(lastMsg?.sender_id || '') === String(activeAccountId) : false) ||
          String(lastMsg?.msg_id || '').startsWith('temp_');
        if (isOutgoing || nearBottomRef.current) {
          scrollToBottom('realtime');
        }
      }
    }
  }, [msgs, activeAccountId, activeContact?.channel, scrollToBottom]);

  // Sau khi prepend tin cũ: khôi phục vị trí scroll để không bị nhảy lên đầu
  // useLayoutEffect chạy ĐỒNG BỘ sau DOM update nhưng TRƯỚC khi paint → không bao giờ nhảy
  useLayoutEffect(() => {
    if (!shouldRestoreScrollRef.current || !messagesContainerRef.current) return;
    shouldRestoreScrollRef.current = false;
    const el = messagesContainerRef.current;
    const savedHeight = savedScrollHeightRef.current;
    if (savedHeight > 0) {
      const delta = el.scrollHeight - savedHeight;
      if (delta > 0) {
        // Vị trí lúc chèn + phần mới phía trên: đúng cả khi đang cách đỉnh (tải trước) và khi trình duyệt
        // đã tự neo cuộn ([overflow-anchor:auto]) — đặt `delta` tuyệt đối sẽ nhảy về gần đỉnh.
        const target = savedScrollTopRef.current + delta;
        // Neo cuộn thường đã đặt đúng chỗ: gán lại scrollTop lúc người dùng đang cuộn (chuột / touchpad) sẽ
        // cắt quán tính cuộn → cảm giác giật mỗi lần sang trang. Chỉ sửa khi thực sự lệch.
        if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      }
    }
  }, [msgs.length]);
}
