/**
 * Telegram-only work when opening a conversation: messages of a forum topic (DB first, then the API), fixing old rows that lack a quote or were saved empty
 * (fetched again by id), re-fetching the official reactions of messages that have your own reaction, and asking again for the reactions of the message on screen
 * every 20 seconds in groups / channels (Telegram only pushes reactions to the message author). Other channels: nothing to do.
 */
import { useEffect, useRef } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import { CHANNEL, isTelegramForumGeneral } from '@/lib/channels/channelHelper';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import type { ThreadSyncDeps } from '../types';

/** Telegram group / channel open: re-read reactions of the newest messages this often (Telegram: 15-30 s). */
const TG_REACTION_POLL_MS = 20_000;
const TG_REACTION_POLL_BATCH = 50;

/** Whether this user is in the message's reactions (a JSON string or an object { emoji: { [e]: { users } } }) */
function reactionsIncludeUser(raw: unknown, userId: string): boolean {
  if (!raw || !userId) return false;
  let parsed: any = raw;
  if (typeof raw === 'string') {
    if (!raw.includes(userId)) return false;
    try { parsed = JSON.parse(raw); } catch { return false; }
  }
  const emoji = parsed?.emoji;
  if (!emoji || typeof emoji !== 'object') return false;
  return Object.values(emoji).some((entry: any) => !!entry?.users && Object.prototype.hasOwnProperty.call(entry.users, userId));
}

export function useTelegramThreadSync(deps: ThreadSyncDeps) {
  const { activeAccountId, activeThreadId, activeTopicId, activeContact, msgs, threadKey, threadReady, setMessages } = deps;
  const quoteRepairAttemptedRef = useRef<Set<string>>(new Set());
  const emptyMessageRepairAttemptedRef = useRef<Set<string>>(new Set());

  // ─── Telegram Forum: load topic messages when activeTopicId changes ─────────
  // Pattern: DB-first (instant) → API background sync (slow)
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || !activeTopicId) return;
    const channel = activeContact?.channel || CHANNEL.ZALO;
    if (channel !== 'telegram_user') return;
    const isGeneralTopic = isTelegramForumGeneral(activeTopicId);

    let cancelled = false;

    (async () => {
      // 1. Load from DB first — instant, no network
      try {
        const dbRes = await DataAccessor.getMessages({
          zaloId: activeAccountId,
          threadId: activeThreadId,
          limit: 50,
          offset: 0,
          topicId: activeTopicId,
        });
        if (cancelled) return;
        const dbMessages = dbRes?.messages || dbRes?.items || [];
        if (dbMessages.length > 0) {
          setMessages(activeAccountId, activeThreadId, [...dbMessages].reverse(), activeTopicId);
        }
      } catch {}
      // Don't set messagesLoading=false yet — API sync below

      // General is the normal supergroup timeline, not a reply thread.
      if (isGeneralTopic) {
        if (!cancelled) useChatStore.getState().setMessagesLoading(false);
        return;
      }

      // 2. Fetch from API in background — updates with fresh data
      try {
        const { getAdapter } = await import('@/lib/channels/adapters/registry');
        const adapter = getAdapter('telegram_user');
        const res = await (adapter as any).getForumTopicMessages?.({
          accountId: activeAccountId,
          threadId: activeThreadId,
          topicId: activeTopicId,
          limit: 50,
        });
        if (cancelled) return;
        if (!res?.success || !Array.isArray(res.messages)) {
          useChatStore.getState().setMessagesLoading(false);
          return;
        }

        const mapped = res.messages.map((m: any) => ({
          msg_id: String(m.id),
          owner_zalo_id: activeAccountId,
          thread_id: activeThreadId,
          thread_type: 1,
          sender_id: m.senderId || '',
          content: m.text || (m.msgType === 'sticker' ? '🎨 Sticker' : m.media ? `[${m.media.type}]` : ''),
          msg_type: m.msgType || (m.media?.type === 'MessageMediaPhoto' ? 'photo' : m.media?.type === 'MessageMediaDocument' ? 'file' : 'text'),
          timestamp: (m.date || 0) * 1000,
          is_sent: m.isOut ? 1 : 0,
          attachments: JSON.stringify(m.attachments || []),
          ...(m.localPaths && Object.keys(m.localPaths).length > 0
            ? { local_paths: JSON.stringify(m.localPaths) }
            : {}),
          status: 'received',
          channel: 'telegram_user',
          reply_to_id: m.replyToId || null,
          quote_data: m.quoteData || null,
          topic_id: m.topicRootMessageId || activeTopicId,
          _senderName: m.senderName || '',
        }));

        if (!cancelled && mapped.length > 0) {
          setMessages(activeAccountId, activeThreadId, mapped, activeTopicId);
        }
      } catch (err: any) {
        console.error('[ChatWindow] API topic messages failed:', err.message);
      } finally {
        if (!cancelled) useChatStore.getState().setMessagesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeAccountId, activeThreadId, activeTopicId, activeContact?.channel]);

  useEffect(() => {
    quoteRepairAttemptedRef.current.clear();
    emptyMessageRepairAttemptedRef.current.clear();
  }, [activeAccountId, activeThreadId]);

  // Legacy Telegram rows can lack quote_data because the original message was
  // outside the synced page. Forum routing also used to be stored as a quote
  // when reply_to_id was only the topic root. Repair visible rows in one batch
  // and keep safe identifiers in the console for field diagnosis.
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    const repair = ipc.telegramUser?.repairMessageQuotes;
    if (!repair) return;

    const needsQuoteRepair = (message: any): boolean => {
      if (!message?.reply_to_id) return false;
      if (!message.quote_data) return true;
      try {
        const quote = JSON.parse(message.quote_data);
        const quoteType = String(quote?.msgType || 'text');
        const quoteAttach = typeof quote?.attach === 'string' ? quote.attach.trim() : quote?.attach;
        const hasAttachment = !!quoteAttach && quoteAttach !== '[]' && quoteAttach !== '{}';
        if (['photo', 'image', 'chat.photo'].includes(quoteType)) {
          return !quote?.imageUrl && !quote?.imageLocalPath;
        }
        return !String(quote?.msg || '').trim() &&
          (quoteType === 'text' || quoteType === 'chat.text') &&
          !quote?.imageUrl && !hasAttachment;
      } catch {
        return true;
      }
    };

    const batch: Array<{ messageId: string; replyToId: string }> = [];
    for (const message of msgs) {
      if (!needsQuoteRepair(message)) continue;
      const key = `${activeAccountId}:${activeThreadId}:${message.msg_id}:${message.reply_to_id}`;
      if (quoteRepairAttemptedRef.current.has(key)) continue;
      quoteRepairAttemptedRef.current.add(key);
      batch.push({ messageId: String(message.msg_id), replyToId: String(message.reply_to_id) });
      if (batch.length >= 100) break;
    }
    if (batch.length === 0) return;

    void repair({ accountId: activeAccountId, chatId: activeThreadId, items: batch })
      .then(response => {
        const results = response?.results || [];
        console.info('[TelegramQuoteRepair]', {
          accountId: activeAccountId,
          threadId: activeThreadId,
          requested: batch.length,
          repaired: results.filter(item => item.status === 'repaired').length,
          topicRouting: results.filter(item => item.status === 'topic_routing').length,
          deferred: results.filter(item => item.status === 'deferred').map(item => ({
            messageId: item.messageId,
            replyToId: item.replyToId,
          })),
          notFound: results.filter(item => item.status === 'not_found').map(item => ({
            messageId: item.messageId,
            replyToId: item.replyToId,
          })),
        });
        if (results.length === 0) return;
        const resultMap = new Map(results.map(item => [item.messageId, item]));
        const store = useChatStore.getState();
        const current = store.messages[threadKey] || [];
        let changed = false;
        const repairedMessages = current.map(message => {
          const result = resultMap.get(String(message.msg_id));
          if (!result) return message;
          if (result.status === 'topic_routing') {
            changed = true;
            return { ...message, reply_to_id: null };
          }
          if (result.status === 'repaired' && result.quoteData) {
            changed = true;
            return { ...message, quote_data: result.quoteData };
          }
          return message;
        });
        if (changed) store.setMessages(activeAccountId, activeThreadId, repairedMessages, activeTopicId);
      })
      .catch(error => {
        console.warn('[TelegramQuoteRepair] failed', {
          accountId: activeAccountId,
          threadId: activeThreadId,
          messageIds: batch.map(item => item.messageId),
          error: error?.message || String(error),
        });
      });
  }, [activeAccountId, activeThreadId, activeTopicId, activeContact?.channel, msgs, threadKey]);

  // Legacy normalizers stored unknown Telegram MessageMedia classes as an
  // empty text row. Re-fetch exact visible IDs, persist the real class/type,
  // and log safe identifiers so unsupported cases are diagnosable.
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    const candidates = msgs.filter(message => {
      // Messages saved as "chưa hỗ trợ" (not supported yet) while the app still used the old API layer (rich-format messages, checklists…): fetch again by id
      if (message.msg_type === 'telegram.unsupported') return true;
      if (String(message.content || '').trim() || message.msg_type !== 'text') return false;
      try {
        const attachments = JSON.parse(message.attachments || '[]');
        return !Array.isArray(attachments) || attachments.length === 0;
      } catch {
        return true;
      }
    }).filter(message => {
      const key = `${activeAccountId}:${activeThreadId}:${message.msg_id}`;
      if (emptyMessageRepairAttemptedRef.current.has(key)) return false;
      emptyMessageRepairAttemptedRef.current.add(key);
      return /^\d+$/.test(String(message.msg_id));
    }).slice(0, 100);
    if (!candidates.length) return;

    const messageIds = candidates.map(message => String(message.msg_id));
    console.warn('[TelegramEmptyMessage] REPAIR_REQUESTED', {
      accountId: activeAccountId, threadId: activeThreadId, messageIds,
    });
    ipc.telegramUser?.repairEmptyMessages({ accountId: activeAccountId, chatId: activeThreadId, messageIds })
      .then(response => {
        if (!response?.success) throw new Error(response?.error || 'repair failed');
        const results = response.results || [];
        console.info('[TelegramEmptyMessage] REPAIR_COMPLETED', {
          accountId: activeAccountId, threadId: activeThreadId,
          results: results.map(result => ({
            messageId: result.messageId, resolved: result.resolved,
            msgType: result.msgType, mediaClass: result.mediaClass,
          })),
        });
        const byId = new Map(results.filter(result => result.resolved).map(result => [result.messageId, result]));
        if (!byId.size) return;
        const current = useChatStore.getState().messages[threadKey] || [];
        const repaired = current.map(message => {
          const result = byId.get(String(message.msg_id));
          return result ? {
            ...message, content: result.content, msg_type: result.msgType,
            attachments: JSON.stringify(result.attachments || []),
          } : message;
        });
        useChatStore.getState().setMessages(activeAccountId, activeThreadId, repaired, activeTopicId);
      })
      .catch(error => console.warn('[TelegramEmptyMessage] REPAIR_FAILED', {
        accountId: activeAccountId, threadId: activeThreadId, messageIds,
        error: error?.message || String(error),
      }));
  }, [activeAccountId, activeThreadId, activeTopicId, activeContact?.channel, msgs, threadKey]);

  // Telegram: re-fetch the official reactions (GetMessagesReactions) for messages that have your own reaction when opening a
  // conversation. Gradually fixes data that was wrongly summed before (a channel post reaction with a duplicate ID was written onto a message in another
  // conversation, always with your own reaction too), and syncs reactions you changed on another device. Once per message per session.
  const refreshedTgReactionsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!threadReady || !activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    const refresh = ipc.telegramUser?.refreshReactions;
    if (!refresh) return;
    const messageIds: string[] = [];
    for (const message of msgs) {
      const key = `${activeAccountId}:${activeThreadId}:${message.msg_id}`;
      if (refreshedTgReactionsRef.current.has(key) || !reactionsIncludeUser(message.reactions, activeAccountId)) continue;
      refreshedTgReactionsRef.current.add(key);
      messageIds.push(String(message.msg_id));
      if (messageIds.length >= 100) break;
    }
    if (!messageIds.length) return;
    refresh({ accountId: activeAccountId, chatId: activeThreadId, messageIds }).catch(() => {});
  }, [threadReady, activeAccountId, activeThreadId, activeContact?.channel, msgs]);

  // Telegram groups / channels: Telegram only pushes reactions to the message AUTHOR; reactions on other people's messages must be asked for again
  // (Telegram's recommendation: poll messages.getMessagesReactions for the messages on screen every 15-30 seconds). Only the open conversation
  // and only while its window is visible; main only writes to the DB / emits an event when a reaction really changes. Private chats do not need it: reaction changes arrive
  // through UpdateEditMessage.
  const tgReactionPollMsgsRef = useRef(msgs);
  tgReactionPollMsgsRef.current = msgs;
  useEffect(() => {
    if (!threadReady || !activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    if (!activeThreadId.startsWith('-')) return;
    const refresh = ipc.telegramUser?.refreshReactions;
    if (!refresh) return;
    const poll = () => {
      if (document.hidden) return;
      const messageIds = tgReactionPollMsgsRef.current
        .filter(message => /^\d+$/.test(String(message.msg_id)) && message.is_recalled !== 1 && message.msg_type !== 'system')
        .slice(-TG_REACTION_POLL_BATCH)
        .map(message => String(message.msg_id));
      if (messageIds.length) refresh({ accountId: activeAccountId, chatId: activeThreadId, messageIds }).catch(() => {});
    };
    const first = window.setTimeout(poll, 1500);
    const timer = window.setInterval(poll, TG_REACTION_POLL_MS);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [threadReady, activeAccountId, activeThreadId, activeContact?.channel]);
}
