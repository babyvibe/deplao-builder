/**
 * Tin cũ hơn: tự tải khi cuộn gần đỉnh (theo vị trí cuộn, không IntersectionObserver), một trang từ DB theo mốc thời
 * gian; DB hết thì hỏi server của kênh (channels/: Telegram getMessages, Facebook fetchOlderMessages) rồi đọc lại DB.
 * Trích dẫn của trang mới ghép từ chính trang / bổ sung sau bằng 1 truy vấn gộp. Giữ vị trí đang xem khi chèn lên trên.
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
  // Hội thoại ngắn (chưa cuộn được) hoặc đáy vẫn nằm trong vùng tải trước ngay sau khi mở
  useEffect(() => {
    if (!initialScrollDone) return;
    const raf = requestAnimationFrame(maybeLoadOlder);
    return () => cancelAnimationFrame(raf);
  }, [initialScrollDone, activeThreadId, maybeLoadOlder]);

  // Chụp vị trí cuộn NGAY trước khi chèn tin cũ lên đầu — không chụp trước lúc query DB: trong lúc chờ,
  // người dùng vẫn cuộn / có tin mới nên vị trí khôi phục sẽ sai.
  const snapshotScrollForPrepend = () => {
    const el = messagesContainerRef.current;
    savedScrollHeightRef.current = el?.scrollHeight || 0;
    savedScrollTopRef.current = el?.scrollTop || 0;
    shouldRestoreScrollRef.current = true;
  };

  // Một trang tin cũ hơn `before` từ DB (chủ: IPC, nhân viên: REST), mới → cũ. DB trả `timestamp <= before`
  // nên các tin cùng mốc đã hiển thị quay lại — xin thêm đúng số đó + 1 dòng: dòng dư cho biết còn tin cũ hơn,
  // khỏi truy vấn dò lần nữa.
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
    // Lỗi đọc (employee: mất kết nối BOSS) ≠ "hết tin cũ": để handleLoadMore hiện "Lỗi - Thử lại", giữ hasMore
    if (isReadFailure(res)) throw new Error(readFailureMessage(res));
    const rows: any[] = res?.messages || res?.items || [];
    const fresh = rows.filter(m => !loadedIds.has(String(m.msg_id)));
    return { page: fresh.slice(0, MESSAGE_LOAD_MORE_LIMIT), more: fresh.length > MESSAGE_LOAD_MORE_LIMIT };
  };

  // reply_to_id → quote_data từ chính trang vừa tải (Facebook…); tin gốc nằm ngoài trang thì bổ sung sau
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

  // Tin gốc của trích dẫn nằm ngoài trang: 1 truy vấn gộp + 1 lần cập nhật store. Trước đây mỗi tin 1 truy vấn
  // + 1 lần setMessages → cả danh sách re-render nhiều lần ngay sau mỗi trang.
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
      // getMessagesByIds chỉ khớp msg_id; getMessageById còn khớp cli_msg_id (trích dẫn Zalo có msgId "0")
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

  // Tải thêm tin nhắn cũ dùng timestamp cursor (tránh lỗi offset khi có tin real-time)
  const handleLoadMore = async () => {
    // Double-guard: check refs to prevent race conditions
    if (!activeAccountId || !activeThreadId || loadingMoreRef.current || !hasMoreRef.current) return;
    const accountId = activeAccountId;
    const threadId = activeThreadId;
    const topicId = activeTopicId;
    // Re-read msgs from store to get the freshest oldest message (MIN timestamp, mảng có thể chưa sắp xếp)
    const loaded = (useChatStore.getState().messages[getMessageCacheKey(accountId, threadId, topicId)] || [])
      .filter(m => !m.msg_id.startsWith('temp_'));
    // Store chưa có tin (lần tải đầu đang chạy) → để lần tải đầu xử lý, không kết luận là hết tin
    if (loaded.length === 0) return;
    let oldest: any = null;
    for (const m of loaded) {
      if ((m.timestamp || 0) > 0 && (!oldest || m.timestamp < oldest.timestamp)) oldest = m;
    }
    if (!oldest) {
      // Không có timestamp hợp lệ → không có mốc để tải tiếp
      hasMoreRef.current = false;
      setHasMore(false);
      return;
    }
    const before: number = oldest.timestamp;

    const seq = ++loadSeqRef.current;
    loadingMoreRef.current = true;
    if (loadError) setLoadError(false);
    // Spinner chỉ hiện khi tải lâu: trang từ DB thường xong trong vài chục ms; bật state ngay thì cả danh sách
    // re-render thêm một lần mỗi trang (giật khi đang cuộn).
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
      // `confirmed`: DB trả dư dòng → chắc chắn còn tin cũ (mới hiện nút). `maybe`: có thể còn (tiếp tục tự tải).
      let { page, more: confirmed } = await fetchOlderPage(accountId, threadId, topicId, before, loaded);
      let maybe = confirmed;

      // Kênh tải được lịch sử từ server (channels/: Telegram, Facebook)
      const fetchOlderFromServer = chatWindowChannel(getActiveAccount()?.channel).fetchOlderFromServer;
      if (fetchOlderFromServer) {
        if (page.length === 0) {
          // DB đã hết → xin server một trang cũ hơn (server lưu vào DB) rồi đọc lại DB. Lỗi tạm thời ném ra →
          // "Lỗi - Thử lại", giữ hasMore để còn thử lại
          const fromServer = await fetchOlderFromServer({ accountId, threadId, topicId, oldest, before });
          if (fromServer.stored > 0) ({ page, more: confirmed } = await fetchOlderPage(accountId, threadId, topicId, before, loaded));
          maybe = confirmed || fromServer.hasMore;
        } else {
          // DB còn ít hơn một trang không có nghĩa server đã hết tin: lần sau hỏi server
          maybe = true;
        }
      }
      if (loadSeqRef.current !== seq) return; // đã đổi hội thoại / lần tải này đã bị bỏ

      const { mapped, missing } = mapReplyQuotes(page);
      const nextHasMore = mapped.length > 0 && maybe;
      // Một lần render cho cả trang mới lẫn trạng thái (trước đây 2–3 lần re-render toàn bộ danh sách / trang)
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
      // Trùng hết (store đã có) → không có render nào dùng mốc chụp: bỏ, kẻo lần đổi số tin sau khôi phục sai
      shouldRestoreScrollRef.current = false;
      if (mapped.length > 0) {
        if (missing.length > 0) void fixupMissingQuotes(accountId, threadId, topicId, missing);
        // Trang vừa tải chưa đẩy đỉnh ra khỏi vùng tải trước (trang ngắn / không cuộn) → tải tiếp
        requestAnimationFrame(maybeLoadOlder);
      }
    } catch {
      if (loadSeqRef.current === seq) {
        setLoadError(true);
        // Không tự thử lại ở mỗi lần cuộn (Telegram FLOOD_WAIT…) — nút "Thử lại" vẫn bấm được ngay
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
