/**
 * Nhảy tới một tin: đang có trong khung → cuộn tới + nháy viền; chưa có → tải các tin quanh nó từ DB (không có trong DB
 * thì kênh tải từ server nếu được, channels/: Telegram) rồi cuộn tới, bật "Về tin nhắn mới nhất". Yêu cầu nhảy từ nơi
 * khác (Tin đánh dấu) chờ hội thoại tải xong.
 */
import { useEffect, useRef } from 'react';
import { MESSAGE_AROUND_LIMIT } from '@/lib/chat/constants';
import { getMessageCacheKey, useChatStore } from '@/store/chat/chatStore';
import DataAccessor from '@/lib/data/DataAccessor';
import { chatWindowChannel } from '../channels';
import type { MessageListState } from './useMessageListState';

export function useJumpToMessage(list: MessageListState, deps: {
  activeAccountId: string | null;
  activeThreadId: string | null;
  activeTopicId: string | null;
  activeContact: any;
  messagesLoading: boolean;
  setMessages: (accountId: string, threadId: string, messages: any[], topicId?: string | null) => void;
  showNotification: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}) {
  const {
    messagesContainerRef, initialScrollDone, nearBottomRef, setHasMore, setOlderKnown, suppressLoadOlderUntilRef,
    setIsViewingHistory, loadingLatest, setLoadingLatest, threadReady,
  } = list;
  const { activeAccountId, activeThreadId, activeTopicId, activeContact, messagesLoading, setMessages, showNotification } = deps;

  // Cuộn đến tin nhắn gốc khi click vào quote / pinned / search result
  // Nếu tin nhắn không có trong DOM (nằm ở trang cũ), load messages xung quanh nó
  // altMsgId: cliMsgId của quote — Zalo để msgId (globalMsgId) = "0" khi trích dẫn tin chưa có ID chính thức
  // (hay gặp với ảnh trong album), lúc đó chỉ tìm được theo cliMsgId.
  const handleScrollToMsg = async (msgId: string, altMsgId?: string) => {
    const ids = [msgId, altMsgId].map(id => String(id || '')).filter(id => id && id !== '0');
    if (ids.length === 0) return;

    // Helper: highlight + scroll to element
    const scrollAndHighlight = (el: HTMLElement) => {
      nearBottomRef.current = false; // rời đáy: ResizeObserver không được kéo về đáy giữa lúc cuộn tới tin
      suppressLoadOlderUntilRef.current = Date.now() + 1500;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all');
      setTimeout(() => el.classList.remove('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all'), 2000);
    };

    // Hàng đang hiển thị tin: id="msg-…", hoặc data-msg-ids (cliMsgId, ảnh trong album, sticker trong nhóm)
    const findMsgElement = (id: string): HTMLElement | null =>
      document.getElementById(`msg-${id}`)
      || document.querySelector<HTMLElement>(`[data-msg-ids~="${CSS.escape(id)}"]`);

    // 1. Check if already in DOM
    for (const id of ids) {
      const el = findMsgElement(id);
      if (el) {
        scrollAndHighlight(el);
        return;
      }
    }

    // 2. Message not in DOM - fetch its info to get timestamp, then load messages around it
    if (!activeAccountId || !activeThreadId) return;
    try {
      let targetMsg: any;
      for (const id of ids) {
        const msgRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, threadId: activeThreadId, msgId: id });
        if (msgRes?.message?.timestamp) {
          targetMsg = msgRes.message;
          break;
        }
      }
      // Không có trong DB: kênh tải được tin từ server (channels/: Telegram) → tải rồi nhảy tới
      const ensureMessage = chatWindowChannel(activeContact?.channel).ensureMessage;
      if (!targetMsg?.timestamp && ensureMessage) {
        const ensured = await ensureMessage({
          accountId: activeAccountId,
          threadId: activeThreadId,
          messageId: ids[0],
          notify: showNotification,
        });
        if (!ensured.ok) return;
        targetMsg = ensured.message;
      }
      if (!targetMsg?.timestamp) {
        showNotification('Không tìm thấy tin nhắn trong hội thoại này', 'error');
        return;
      }
      // A Zalo quote can identify a media message by globalMsgId while the
      // persisted/DOM record uses a different cli_msg_id.  After resolving
      // the row, always use its canonical msg_id for the element we render.
      const targetDomMessageId = String((targetMsg as any).msg_id || ids[0]);

      const aroundRes = await DataAccessor.getMessagesAround({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        timestamp: Number(targetMsg.timestamp),
        limit: MESSAGE_AROUND_LIMIT,
      });
      const aroundMsgs = aroundRes?.messages;
      if (!aroundMsgs?.length) return;

      // Build reply lookup map for reply_to_id → quote_data
      const msgLookup2 = new Map<string, { content: string; type: string }>();
      for (const m of aroundMsgs) msgLookup2.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
      const missingLookup2: Array<{ msgId: string; replyToId: string }> = [];
      const mappedAround = aroundMsgs.map((m: any) => {
        if (m.channel !== 'telegram_user' && m.reply_to_id && !m.quote_data) {
          const orig = msgLookup2.get(m.reply_to_id);
          if (orig) {
            return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
          }
          missingLookup2.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
          return m;
        }
        return m;
      });

      // Replace current messages with the "around" set
      nearBottomRef.current = false; // danh sách mới không phải tin mới nhất → không bám đáy
      suppressLoadOlderUntilRef.current = Date.now() + 1500;
      setMessages(activeAccountId, activeThreadId, mappedAround, activeTopicId);
      // Async fixup: query DB for original messages not in the loaded batch
      if (missingLookup2.length > 0 && activeAccountId && activeThreadId) {
        (async () => {
          for (const item of missingLookup2) {
            try {
              const dbRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, threadId: activeThreadId, msgId: item.replyToId });
              const origMsg = dbRes?.message;
              if (origMsg?.msg_type || origMsg?.content) {
                const store = useChatStore.getState();
                const key = getMessageCacheKey(activeAccountId, activeThreadId, activeTopicId);
                const msgs = (store.messages[key] || []).slice();
                const idx = msgs.findIndex((m2: any) => m2.msg_id === item.msgId);
                if (idx >= 0 && !msgs[idx].quote_data) {
                  msgs[idx] = {
                    ...msgs[idx],
                    quote_data: JSON.stringify({
                      msgId: item.replyToId,
                      msg: origMsg.content || '',
                      senderId: '',
                      msgType: origMsg.msg_type || 'text',
                    }),
                  };
                  store.setMessages(activeAccountId!, activeThreadId, msgs, activeTopicId);
                }
              }
            } catch {}
          }
        })();
      }
      setHasMore(true); // Có thể còn tin cũ hơn phía trên
      setOlderKnown(false); // chưa biết chắc → không hiện nút, cuộn lên gần đỉnh sẽ tự tải
      setIsViewingHistory(true); // Đánh dấu đang xem tin cũ → hiện nút "Về tin mới nhất"

      // Wait for React to render new messages, then scroll
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      const el2 = findMsgElement(targetDomMessageId);
      if (el2) {
        scrollAndHighlight(el2);
      }
    } catch (err) {
      console.error('[handleScrollToMsg] Failed to load messages around target:', err);
    }
  };

  // Nhảy tới tin của hội thoại KHÁC (Tin đánh dấu): hội thoại đang được mở → nhảy khi đã tải xong
  const pendingJumpRef = useRef<{ accountId: string; threadId: string; messageId: string; at: number } | null>(null);
  useEffect(() => {
    const handleJumpRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId?: string; threadId?: string; messageId?: string }>).detail;
      if (!detail?.messageId) return;
      if (detail.accountId !== activeAccountId || detail.threadId !== activeThreadId || !threadReady) {
        pendingJumpRef.current = {
          accountId: String(detail.accountId || ''), threadId: String(detail.threadId || ''),
          messageId: String(detail.messageId), at: Date.now(),
        };
        return;
      }
      void handleScrollToMsg(detail.messageId);
    };
    window.addEventListener('chat:jumpToMessage', handleJumpRequest);
    return () => window.removeEventListener('chat:jumpToMessage', handleJumpRequest);
  });
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || !threadReady || !initialScrollDone || messagesLoading) return;
    if (pending.accountId !== activeAccountId || pending.threadId !== activeThreadId) return;
    pendingJumpRef.current = null;
    if (Date.now() - pending.at > 20_000) return;
    const timer = setTimeout(() => { void handleScrollToMsg(pending.messageId); }, 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadReady, initialScrollDone, messagesLoading, activeAccountId, activeThreadId]);

  // Tải lại tin nhắn mới nhất và cuộn xuống cuối - dùng khi đang xem tin nhắn cũ (isViewingHistory)
  const handleReturnToLatest = async () => {
    if (!activeAccountId || !activeThreadId || loadingLatest) return;
    setLoadingLatest(true);
    try {
      const res = await DataAccessor.getMessages({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        limit: 50,
        offset: 0,
        topicId: activeTopicId || undefined,
      });
      if (res?.messages?.length) {
        // Build reply lookup map for reply_to_id → quote_data
        const msgLookup3 = new Map<string, { content: string; type: string }>();
        for (const m of res.messages) msgLookup3.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
        const missingLookup3 = [];
        const mappedLatest = res.messages.map((m: any) => {
          if (m.channel !== 'telegram_user' && m.reply_to_id && !m.quote_data) {
            const orig = msgLookup3.get(m.reply_to_id);
            if (orig) {
              return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
            }
            missingLookup3.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
            return m;
          }
          return m;
        });
        const sorted = [...mappedLatest].reverse();
        setMessages(activeAccountId, activeThreadId, sorted, activeTopicId);
        setHasMore(res.messages.length >= 50);
        setOlderKnown(false);
        // Async fixup: query DB for original messages not in the loaded batch
        if (missingLookup3.length > 0 && activeAccountId && activeThreadId) {
          (async () => {
            for (const item of missingLookup3) {
              try {
                const dbRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, threadId: activeThreadId, msgId: item.replyToId });
                const origMsg = dbRes?.message;
                if (origMsg?.msg_type || origMsg?.content) {
                  const store = useChatStore.getState();
                  const mkey = getMessageCacheKey(activeAccountId, activeThreadId, activeTopicId);
                  const msgs = (store.messages[mkey] || []).slice();
                  const idx = msgs.findIndex((m2) => m2.msg_id === item.msgId);
                  if (idx >= 0 && !msgs[idx].quote_data) {
                    msgs[idx] = {
                      ...msgs[idx],
                      quote_data: JSON.stringify({
                        msgId: item.replyToId,
                        msg: origMsg.content || '',
                        senderId: '',
                        msgType: origMsg.msg_type || 'text',
                      }),
                    };
                    store.setMessages(activeAccountId, activeThreadId, msgs, activeTopicId);
                  }
                }
              } catch {}
            }
          })();
        }
      }
      setIsViewingHistory(false);
      // Scroll to bottom sau khi render
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } catch (e) {
      console.error('[handleReturnToLatest]', e);
    } finally {
      setLoadingLatest(false);
    }
  };

  return { handleScrollToMsg, handleReturnToLatest };
}

export type JumpToMessage = ReturnType<typeof useJumpToMessage>;
