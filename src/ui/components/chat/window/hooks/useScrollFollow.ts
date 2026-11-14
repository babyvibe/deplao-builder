/**
 * Scrolling of the message list: the pinned bar gets taller / shorter, content changes size (photos / videos finish loading), scroll position (bottom, leaving the bottom
 * when scrolling up), new messages (mine, or when at the bottom) → scroll to the bottom, scroll events from elsewhere (AI suggestions, library sent),
 * and keeps the current position when older messages are inserted at the top.
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


  // ─── ResizeObserver: auto-scroll when the content resizes while the user is at the bottom ──
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || !threadReady) return;
    // Pull to the bottom RIGHT in the callback (runs after layout, before paint) instead of waiting for the next frame → the user never sees the frame
    // pushed away and then jump back. Compares the distance to the bottom, not scrollHeight: when the scroll container gets shorter (the bar
    // pinned / "Đã xem" (Seen) / "đang nhập" (typing) appear late, the composer gets taller) scrollHeight stays the same but the bottom is covered.
    const ro = new ResizeObserver(() => {
      if (!nearBottomRef.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    // The scroll container has a fixed height, so observing only the container would not notice when the content gets taller (photos / videos finish loading
    // after scrolling to the bottom) → also watch the content part so it keeps sticking to the bottom.
    if (messagesContentRef.current) ro.observe(messagesContentRef.current);
    return () => ro.disconnect();
  }, [activeThreadId, threadReady]);

  // Scroll event: track the top/bottom position + nearBottomRef (used by the ResizeObserver)
  // Optimization: use rAF throttling and only setState when the value changes, to avoid constant re-renders
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    let rafId = 0;
    let lastAtBottom = true;
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      if (rafId) return; // throttle with rAF
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const { scrollTop, scrollHeight, clientHeight } = el;
        // Only scrolling UP (the user / jumping to an old message) leaves the bottom. Content that grows taller also fires a scroll event (anchor
        // scrolling) or pushes the bottom further away while scrollTop does not decrease. If it were recalculated here, the ResizeObserver would see "not at
        // bottom" and the conversation would be pushed up every time.
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

  // ─── Scroll to bottom when the AI suggestions bar appears / disappears ──────────
  useEffect(() => {
    const handler = () => {
      if (nearBottomRef.current) scrollToBottom('ai-suggestions');
    };
    window.addEventListener('ai:suggestionsBarChanged', handler);
    return () => window.removeEventListener('ai:suggestionsBarChanged', handler);
  }, [scrollToBottom]);

  // Scroll to bottom when LibraryPickerModal finishes sending
  useEffect(() => {
    const handler = () => scrollToBottom('library-sent');
    window.addEventListener('chat:scrollToBottom', handler);
    return () => window.removeEventListener('chat:scrollToBottom', handler);
  }, [scrollToBottom]);

  // Scroll to bottom only when there is a NEW message (the last message changes), not when older messages are prepended
  // The initial load scroll is handled by the consolidated scroll effect
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
          // The first scroll is handled by the consolidated effect above; whether there are older messages is decided by the page load (maybeLoadOlder)
          // determined. Checking with a separate query here is useless, because the DB returns the messages with the same timestamp too (timestamp <= before).
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

  // After prepending older messages: restore the scroll position so it does not jump to the top
  // useLayoutEffect runs SYNCHRONOUSLY after the DOM update but BEFORE paint → it never jumps
  useLayoutEffect(() => {
    if (!shouldRestoreScrollRef.current || !messagesContainerRef.current) return;
    shouldRestoreScrollRef.current = false;
    const el = messagesContainerRef.current;
    const savedHeight = savedScrollHeightRef.current;
    if (savedHeight > 0) {
      const delta = el.scrollHeight - savedHeight;
      if (delta > 0) {
        // The position at insertion + the new content above: correct both when near the top (prefetch) and when the browser
        // has already anchored the scroll ([overflow-anchor:auto]). Setting an absolute `delta` would jump back near the top.
        const target = savedScrollTopRef.current + delta;
        // Normally the scroll anchor is already in the right place: reassigning scrollTop while the user is scrolling (mouse / touchpad) will
        // cut the scroll momentum → a stutter on every page change. Only fix it when it is really off.
        if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      }
    }
  }, [msgs.length]);
}
