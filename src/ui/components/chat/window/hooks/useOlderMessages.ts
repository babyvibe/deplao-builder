/**
 * Older messages: load automatically when scrolled near the top (based on scroll position, not IntersectionObserver), one page from the DB by timestamp.
 * When the DB runs out, ask the channel's server (channels/: Telegram getMessages, Facebook fetchOlderMessages), then read the DB again.
 * Quotes in the new page are built from the page itself, or filled in later by one batched query. Keeps the current view position when inserting above.
 */
import { useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { MESSAGE_LOAD_MORE_LIMIT, LOAD_MORE_TIMEOUT_MS, LOAD_OLDER_PREFETCH_PX } from '@/lib/chat/constants';
import { getMessageCacheKey, useChatStore } from '@/store/chat/chatStore';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { chatWindowChannel } from '../channels';
import type { MessageListState } from './useMessageListState';

export function useOlderMessages(list: MessageListState, deps: {
  activeAccountId: string | null;
  activeThreadId: string | null;
  activeTopicId: string | null;
  getActiveAccount: () => any;
  prependMessages: (accountId: string, threadId: string, messages: any[], topicId?: string | null) => void;
}) {
  const {
    messagesContainerRef, savedScrollHeightRef, savedScrollTopRef, shouldRestoreScrollRef, initialScrollDoneRef,
    initialScrollDone, loadingMore, setLoadingMore, hasMore, setHasMore, setOlderKnown, loadError, setLoadError,
    loadSeqRef, suppressLoadOlderUntilRef, loadMoreFnRef, hasMoreRef, loadingMoreRef,
  } = list;
  const { activeAccountId, activeThreadId, activeTopicId, getActiveAccount, prependMessages } = deps;

  useEffect(() => { loadMoreFnRef.current = handleLoadMore; });
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
  const maybeLoadOlder = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el || !initialScrollDoneRef.current || !hasMoreRef.current || loadingMoreRef.current) return;
    if (Date.now() < suppressLoadOlderUntilRef.current) return;
    if (el.scrollTop <= LOAD_OLDER_PREFETCH_PX) loadMoreFnRef.current();
  }, []);
  // Short conversation (cannot scroll yet), or the bottom is still inside the prefetch zone right after opening
  useEffect(() => {
    if (!initialScrollDone) return;
    const raf = requestAnimationFrame(maybeLoadOlder);
    return () => cancelAnimationFrame(raf);
  }, [initialScrollDone, activeThreadId, maybeLoadOlder]);

  // Capture the scroll position RIGHT before inserting older messages at the top, not before the DB query: while waiting,
  // the user may still scroll or new messages may arrive, so the restored position would be wrong.
  const snapshotScrollForPrepend = () => {
    const el = messagesContainerRef.current;
    savedScrollHeightRef.current = el?.scrollHeight || 0;
    savedScrollTopRef.current = el?.scrollTop || 0;
    shouldRestoreScrollRef.current = true;
  };

  // One page of messages older than `before` from the DB (owner: IPC, employee: REST), new → old. The DB returns `timestamp <= before`
  // so messages with the same timestamp that are already shown come back: ask for exactly that many + 1 row. The extra row tells whether older messages remain,
  // no need for another query.
  const fetchOlderPage = async (accountId: string, threadId: string, topicId: string | null, before: number, loaded: any[]) => {
    const loadedIds = new Set(loaded.map(m => String(m.msg_id)));
    const sameTs = loaded.filter(m => m.timestamp === before).length;
    const res: any = await DataAccessor.getMessages({
      zaloId: accountId,
      threadId,
      limit: MESSAGE_LOAD_MORE_LIMIT + sameTs + 1,
      before,
      topicId: topicId || undefined,
    });
    // A read error (employee: lost connection to BOSS) ≠ "hết tin cũ" (no older messages left): handleLoadMore shows "Lỗi - Thử lại" (Error - Retry) and keeps hasMore
    if (isReadFailure(res)) throw new Error(readFailureMessage(res));
    const rows: any[] = res?.messages || res?.items || [];
    const fresh = rows.filter(m => !loadedIds.has(String(m.msg_id)));
    return { page: fresh.slice(0, MESSAGE_LOAD_MORE_LIMIT), more: fresh.length > MESSAGE_LOAD_MORE_LIMIT };
  };

  // reply_to_id → quote_data from the page just loaded (Facebook…); the original message outside the page is filled in later
  const mapReplyQuotes = (rows: any[]) => {
    const lookup = new Map<string, { content: string; type: string }>();
    for (const m of rows) lookup.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
    const missing: Array<{ msgId: string; replyToId: string }> = [];
    const mapped = rows.map((m: any) => {
      if (m.channel === 'telegram_user' || !m.reply_to_id || m.quote_data) return m;
      const orig = lookup.get(m.reply_to_id);
      if (orig) {
        return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
      }
      missing.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
      return m;
    });
    return { mapped, missing };
  };

  // The original message of a quote is outside the page: 1 batched query + 1 store update. It used to be 1 query per message
  // + 1 setMessages → the whole list re-rendered several times right after each page.
  const fixupMissingQuotes = async (
    accountId: string,
    threadId: string,
    topicId: string | null,
    missing: Array<{ msgId: string; replyToId: string }>,
  ) => {
    try {
      const replyIds = [...new Set(missing.map(item => item.replyToId))];
      const found = new Map<string, any>();
      const batch: any = await DataAccessor.getMessagesByIds({ zaloId: accountId, msgIds: replyIds });
      for (const m of batch?.messages || []) found.set(String(m.msg_id), m);
      // getMessagesByIds only matches msg_id; getMessageById also matches cli_msg_id (Zalo quotes have msgId "0")
      for (const id of replyIds) {
        if (found.has(id)) continue;
        const one: any = await DataAccessor.getMessageById({ zaloId: accountId, threadId, msgId: id });
        if (one?.message) found.set(id, one.message);
      }
      const store = useChatStore.getState();
      const list = store.messages[getMessageCacheKey(accountId, threadId, topicId)];
      if (!list) return;
      const replyOf = new Map(missing.map(item => [item.msgId, item.replyToId]));
      let changed = false;
      const updated = list.map((m: any) => {
        const replyToId = replyOf.get(m.msg_id);
        if (!replyToId || m.quote_data) return m;
        const orig = found.get(replyToId);
        if (!orig?.msg_type && !orig?.content) return m;
        changed = true;
        return {
          ...m,
          quote_data: JSON.stringify({ msgId: replyToId, msg: orig.content || '', senderId: '', msgType: orig.msg_type || 'text' }),
        };
      });
      if (changed) store.setMessages(accountId, threadId, updated, topicId);
    } catch {}
  };

  // Loading more older messages uses a timestamp cursor (avoids offset errors when real-time messages arrive)
  const handleLoadMore = async () => {
    // Double-guard: check refs to prevent race conditions
    if (!activeAccountId || !activeThreadId || loadingMoreRef.current || !hasMoreRef.current) return;
    const accountId = activeAccountId;
    const threadId = activeThreadId;
    const topicId = activeTopicId;
    // Re-read msgs from the store to get the freshest oldest message (MIN timestamp, the array may not be sorted)
    const loaded = (useChatStore.getState().messages[getMessageCacheKey(accountId, threadId, topicId)] || [])
      .filter(m => !m.msg_id.startsWith('temp_'));
    // The store has no messages yet (the first load is still running) → leave it to the first load, do not conclude there are no more messages
    if (loaded.length === 0) return;
    let oldest: any = null;
    for (const m of loaded) {
      if ((m.timestamp || 0) > 0 && (!oldest || m.timestamp < oldest.timestamp)) oldest = m;
    }
    if (!oldest) {
      // No valid timestamp → no marker to load further from
      hasMoreRef.current = false;
      setHasMore(false);
      return;
    }
    const before: number = oldest.timestamp;

    const seq = ++loadSeqRef.current;
    loadingMoreRef.current = true;
    if (loadError) setLoadError(false);
    // The spinner only shows when loading is slow: a page from the DB usually finishes in a few dozen ms, so turning the state on at once would make the whole list
    // re-render one more time per page (stutters while scrolling).
    const spinnerTimer = setTimeout(() => {
      if (loadSeqRef.current === seq) setLoadingMore(true);
    }, 250);
    // Safety: reset loadingMore if it's been stuck for > 10 seconds
    const safetyTimer = setTimeout(() => {
      if (loadSeqRef.current === seq && loadingMoreRef.current) {
        console.warn('[LOADMORE] Safety reset: loadingMore stuck for >10s');
        loadSeqRef.current++;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }, LOAD_MORE_TIMEOUT_MS);

    try {
      // `confirmed`: the DB returned an extra row → there are certainly older messages (the button is shown). `maybe`: there may be more (keep auto-loading).
      let { page, more: confirmed } = await fetchOlderPage(accountId, threadId, topicId, before, loaded);
      let maybe = confirmed;

      // The channel can load history from the server (channels/: Telegram, Facebook)
      const fetchOlderFromServer = chatWindowChannel(getActiveAccount()?.channel).fetchOlderFromServer;
      if (fetchOlderFromServer) {
        if (page.length === 0) {
          // DB has run out → ask the server for one older page (the server saves it to the DB), then read the DB again. A temporary error is thrown →
          // "Lỗi - Thử lại" (Error - Retry), keep hasMore so it can retry
          const fromServer = await fetchOlderFromServer({ accountId, threadId, topicId, oldest, before });
          if (fromServer.stored > 0) ({ page, more: confirmed } = await fetchOlderPage(accountId, threadId, topicId, before, loaded));
          maybe = confirmed || fromServer.hasMore;
        } else {
          // The DB having fewer than one page does not mean the server has run out: ask the server next time
          maybe = true;
        }
      }
      if (loadSeqRef.current !== seq) return; // the conversation changed, or this load was dropped

      const { mapped, missing } = mapReplyQuotes(page);
      const nextHasMore = mapped.length > 0 && maybe;
      // One render for both the new page and the state (it used to take 2-3 full re-renders of the list per page)
      flushSync(() => {
        if (mapped.length > 0) {
          snapshotScrollForPrepend();
          prependMessages(accountId, threadId, [...mapped].reverse(), topicId);
        }
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        setOlderKnown(mapped.length > 0 && confirmed);
        setLoadingMore(false);
      });
      // All duplicates (the store already has them) → no render uses the captured marker, so drop it, otherwise a later change in the message count would restore the wrong position
      shouldRestoreScrollRef.current = false;
      if (mapped.length > 0) {
        if (missing.length > 0) void fixupMissingQuotes(accountId, threadId, topicId, missing);
        // The loaded page did not push the top out of the prefetch zone (short page / not scrollable) → keep loading
        requestAnimationFrame(maybeLoadOlder);
      }
    } catch {
      if (loadSeqRef.current === seq) {
        setLoadError(true);
        // Does not retry automatically on every scroll (Telegram FLOOD_WAIT…): the "Thử lại" (Retry) button can still be clicked right away
        suppressLoadOlderUntilRef.current = Date.now() + 15_000;
      }
    } finally {
      clearTimeout(spinnerTimer);
      clearTimeout(safetyTimer);
      if (loadSeqRef.current === seq) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  return { handleLoadMore, maybeLoadOlder };
}

export type OlderMessages = ReturnType<typeof useOlderMessages>;
