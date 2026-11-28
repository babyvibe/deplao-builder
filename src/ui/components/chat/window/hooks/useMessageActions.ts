/**
 * Message actions: unsend / recall, delete for me, delete from the app, add / remove reaction (updated on screen at once), forward
 * (the whole album included), save to My Documents (Zalo), star, pin (Telegram pins on the server; Zalo allows up to 3 messages).
 */
import { useEffect } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import { useStarredStore } from '@/store/chat/starredStore';
import { buildStarredSnapshot, starKey } from '@/lib/chat/messages/starredMessages';
import { myDocumentsThreadId } from '@/lib/chat/zalo/myDocuments';
import { buildPinFromMsg } from '../../messages/PinnedMessages';
import * as channelIpc from '../../../../lib/channels/channelIpc';
import { CHANNEL, isFacebook, isNonZalo, isZalo } from '@/lib/channels/channelHelper';
import { EMOJI_TO_REACTION } from '@/lib/chat/messages/emojiUtils';
import { markLocalReaction } from '@/lib/chat/reactions/localReactionRegistry';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { runForwardJob, type ForwardJobLabels, type ForwardJobTarget } from '@/lib/chat/forward/forwardSend';
import type { MessageContextMenuState } from './useChatWindowDialogs';
import { tr } from '../../../../../shared/i18n';

export function useMessageActions(deps: {
  activeAccountId: string | null;
  activeThreadId: string | null;
  activeContact: any;
  contactList: any[];
  allAccounts: any[];
  getActiveAccount: () => any;
  showNotification: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  removeMessage: (accountId: string, threadId: string, msgId: string) => void;
  groupedFirstMsgs: Record<string, any[]>;
  setForwardMsgs: (msgs: any[] | null) => void;
  contextMenu: MessageContextMenuState | null;
  pins: any[];
  setPins: (pins: any[]) => void;
  getContact: (senderId: string) => any;
  getGroupMember: (senderId: string) => any;
  resolveStarSender: (m: any) => { name: string; avatar: string };
}) {
  const {
    activeAccountId, activeThreadId, activeContact, contactList, allAccounts, getActiveAccount, showNotification,
    removeMessage, groupedFirstMsgs, setForwardMsgs, contextMenu, pins, setPins, getContact, getGroupMember, resolveStarSender,
  } = deps;

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    if (isNonZalo(acc.channel)) return buildZaloAuth(acc, activeAccountId);
    return buildZaloAuth(acc, activeAccountId);
  };

  const handleUndo = async (msg: any) => {
    const auth = getAuth();
    if (!auth) return;
    try {
      // Detect channel from the message or contact
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      if (isNonZalo(ch)) {
        const unsendRes = await channelIpc.unsendMessage(ch, {
          accountId: activeAccountId || '',
          messageId: msg.msg_id,
          threadId: msg.thread_id,
        });
        // Adapters answer { success: false } instead of throwing: must not mark the message as recalled
        if (unsendRes?.success === false) throw new Error(unsendRes.error || tr('Không thu hồi được tin nhắn'));
      } else if (isZalo(ch)) {
      const isMsgSent = !!msg.is_sent;
      const messagePayload = JSON.stringify({
        data: {
          msgId: msg.msg_id,
          cliMsgId: msg.cli_msg_id || msg.msg_id,
          // Include uidFrom when admin is recalling another member's message
          ...(!isMsgSent && msg.sender_id ? { uidFrom: msg.sender_id } : {}),
        },
        threadId: msg.thread_id,
        type: msg.thread_type,
      });
      const undoRes: any = await ipc.zalo?.undoMessage({ auth, message: messagePayload });
      // IPC returns { success: false } (does not throw) when Zalo / Boss refuses → must not fake-mark it as "đã thu hồi" (recalled)
      if (undoRes?.success === false) throw new Error(undoRes.error || tr('Zalo từ chối'));
      }
      // Mark as unsent instead of deleting → shows "Tin nhắn đã thu hồi" (Message unsent)
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id, threadId: msg.thread_id }).catch(() => {});
      }
      showNotification(tr('Đã thu hồi tin nhắn'), 'success');
    } catch (e: any) {
      showNotification(tr('Thu hồi thất bại: {{message}}', { message: e.message }), 'error');
    }
  };

  const handleDelete = async (msg: any) => {
    try {
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;
      // Facebook: ordinary messages are removed for this account on Messenger too (the other person keeps them);
      // encrypted ones have no such call and are hidden in Deplao only. Telegram: hidden in Deplao only (supergroups have
      // no "delete for me"; the unsend call would remove it for everyone).
      if (isFacebook(ch)) {
        if (!activeAccountId) return;
        const res = await ipc.fb?.deleteMessageForMe({ accountId: activeAccountId, threadId: msg.thread_id, messageId: msg.msg_id });
        if (res && res.success === false) throw new Error(res.error || tr('Messenger từ chối'));
      } else if (!isNonZalo(ch)) {
      const auth = getAuth();
      if (!auth) return;
      const messagePayload = JSON.stringify({
        data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id, uidFrom: msg.sender_id },
        threadId: msg.thread_id,
        type: msg.thread_type,
      });
      const deleteRes: any = await ipc.zalo?.deleteMessage({ auth, message: messagePayload, onlyMe: true });
      if (deleteRes?.success === false) throw new Error(deleteRes.error || tr('Zalo từ chối'));
      }
      // Mark as deleted in the DB (recalled) instead of removing the row, consistent with unsend
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id, threadId: msg.thread_id }).catch(() => {});
      }
      showNotification(tr('Đã xóa tin nhắn'), 'success');
    } catch (e: any) {
      showNotification(tr('Xóa thất bại: {{message}}', { message: e.message }), 'error');
    }
  };

  const handleDeleteFromDb = async (msg: any) => {
    if (!activeAccountId) return;
    try {
      await DataAccessor.deleteMessages({ zaloId: activeAccountId, msgIds: [msg.msg_id], threadId: msg.thread_id });
      removeMessage(activeAccountId, msg.thread_id, msg.msg_id);
      showNotification(tr('Đã xóa vĩnh viễn tin nhắn khỏi app'), 'success');
    } catch (e: any) {
      showNotification(tr('Xóa thất bại: {{message}}', { message: e.message }), 'error');
    }
  };

  /** My reaction on a message before an optimistic change ('' = none). Messenger keeps one per person. */
  const ownReactionOf = (msg: any, accId: string): string => {
    let parsed: any = msg?.reactions;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed || '{}'); } catch { parsed = {}; }
    }
    const byEmoji = parsed?.emoji && typeof parsed.emoji === 'object' ? parsed.emoji : {};
    for (const [icon, stats] of Object.entries<any>(byEmoji)) {
      if (Number(stats?.users?.[accId]) > 0) return icon;
    }
    return '';
  };

  /** Messenger refused a reaction change: my previous reaction comes back (screen + DB) and the user is told. */
  const revertFacebookReaction = (msg: any, accId: string, previous: string, removing: boolean, error?: string) => {
    const store = useChatStore.getState();
    store.updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, '');
    if (previous) store.updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, previous, 'set');
    const save = (value: string) =>
      DataAccessor.updateReaction?.({ zaloId: accId, msgId: msg.msg_id, threadId: msg.thread_id, userId: accId, emoji: value });
    void Promise.resolve(save('')).then(() => (previous ? save(previous) : undefined)).catch(() => {});
    const reason = error || tr('lỗi không xác định');
    showNotification(removing
      ? tr('Không gỡ được cảm xúc trên Messenger: {{v1}}', { v1: reason })
      : tr('Không thả được cảm xúc trên Messenger: {{v1}}', { v1: reason }), 'error');
  };

  const handleReact = async (msg: any, emoji: string) => {
    try {
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      // Optimistic update: show reaction immediately in UI
      const accId = activeAccountId || '';
      const previousOwn = isFacebook(ch) ? ownReactionOf(msg, accId) : '';
      // Telegram: SendReaction REPLACES your own reaction (one per person) and the counts are the totals Telegram returns, main
      // process saves the official counts from the send result. It does not add into the DB the way Zalo does (it used to add onto a message
      // with the same ID in another conversation → "1 đống icon" (a pile of icons)).
      const isTelegramUserMsg = ch === 'telegram_user';
      // Telegram (user and bot), Messenger: one reaction per person, a new one REPLACES it; Zalo: every tap adds +1
      const replacesOwn = isTelegramUserMsg || ch === 'telegram_bot' || isFacebook(ch);
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, emoji, replacesOwn ? 'set' : 'accumulate');

      if (!isTelegramUserMsg) {
        // Persist the reaction to the DB immediately (so it survives a conversation switch); the Zalo echo of this click is ignored
        markLocalReaction(accId, msg.msg_id, emoji);
        const save = (value: string) =>
          DataAccessor.updateReaction?.({ zaloId: accId, msgId: msg.msg_id, threadId: msg.thread_id, userId: accId, emoji: value });
        // Telegram Bot / Messenger: the DB adds up like Zalo → remove my own reaction first, then save the new one
        if (replacesOwn) void Promise.resolve(save('')).then(() => save(emoji)).catch(() => {});
        else save(emoji)?.catch(() => {});
      }

      if (isNonZalo(ch)) {
        const res: any = await channelIpc.addReaction(ch, {
          accountId: accId,
          messageId: msg.msg_id,
          emoji,
          threadId: msg.thread_id,
          action: 'add',
        });
        if (isFacebook(ch) && res?.success === false) revertFacebookReaction(msg, accId, previousOwn, false, res.error);
      } else if (isZalo(ch)) {
        const auth = getAuth();
        if (!auth) return;
        const reactionKey = EMOJI_TO_REACTION[emoji] || 'HEART';
        const messagePayload = JSON.stringify({
          data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id },
          threadId: msg.thread_id,
          type: msg.thread_type,
        });
        await ipc.zalo?.addReaction({ auth, reactionType: reactionKey, message: messagePayload });
      }

    } catch {}
  };

  // Cancel a reaction: send Reactions.NONE = "" to remove it
  const handleCancelReaction = async (msg: any) => {
    try {
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      // Optimistic update: remove reaction immediately in UI
      const accId = activeAccountId || '';
      const previousOwn = isFacebook(ch) ? ownReactionOf(msg, accId) : '';
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, '');
      // Always save the removal (it used to be skipped, so reopening the conversation brought the reaction back). A repeated removal with the Zalo echo is harmless.
      // Telegram: the main process saves the official counts from the send result.
      if (ch !== 'telegram_user') {
        DataAccessor.updateReaction?.({ zaloId: accId, msgId: msg.msg_id, threadId: msg.thread_id, userId: accId, emoji: '' }).catch(() => {});
      }

      if (isNonZalo(ch)) {
        const res: any = await channelIpc.addReaction(ch, {
          accountId: accId,
          messageId: msg.msg_id,
          emoji: '',
          threadId: msg.thread_id,
          action: 'remove',
        });
        if (isFacebook(ch) && res?.success === false) revertFacebookReaction(msg, accId, previousOwn, true, res.error);
      } else if (isZalo(ch)) {
        const auth = getAuth();
        if (!auth) return;
        const messagePayload = JSON.stringify({
          data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id },
          threadId: msg.thread_id,
          type: msg.thread_type,
        });
        await ipc.zalo?.addReaction({ auth, reactionType: 'NONE', message: messagePayload });
      }
    } catch {}
  };

  // Photo album (several photo messages with the same groupLayoutId, shown as 1 bubble) → forward the whole album, not just the first photo
  const handleForward = (msg: any) => {
    setForwardMsgs(groupedFirstMsgs[msg.msg_id] || [msg]);
  };

  /**
   * Send the messages to each recipient (forward / Save to My Documents): an album is sent as one unit, the rest one message at a time;
   * the draft text attached (if any) is sent last as one new message. Runs in the background, does not block the UI (lib/chat/forward/forwardSend).
   */
  const runForward = (
    messages: any[],
    targets: ForwardJobTarget[],
    composeText: string,
    labels?: ForwardJobLabels,
  ) => runForwardJob(messages, targets, composeText, {
    albums: groupedFirstMsgs, accounts: allAccounts, sourceAccountId: activeAccountId, notify: showNotification,
  }, labels);

  // Zalo: "Lưu vào My Documents" (Save to My Documents) = send a copy of the message into Zalo's EXISTING My Documents conversation (ID = send2me_id of the
  // login session, not a conversation with your own UID). Telegram: goes to Saved Messages (a conversation with yourself)
  const handleSaveToMyDocuments = async (target: any) => {
    if (!activeAccountId || !target) return;
    const myDocsId = myDocumentsThreadId(allAccounts.find(a => a.zalo_id === activeAccountId));
    if (!myDocsId) {
      showNotification(tr('Chưa xác định được hội thoại My Documents của tài khoản này, hãy kết nối lại tài khoản rồi thử lại'), 'error');
      return;
    }
    // A photo in an album that is right-clicked → only that photo; otherwise the whole album / message
    const messages = contextMenu?.mediaMsg ? [target] : (groupedFirstMsgs[target.msg_id] || [target]);
    runForward(messages, [{ accountId: activeAccountId, threadId: myDocsId, threadType: 0 }], '', {
      progress: (done, total) => tr('Đang lưu vào My Documents {{done}}/{{total}}...', { done, total }),
      done: tr('Đã lưu vào My Documents'),
    });
  };

  // ─── Starred messages (like Zalo) ──────────────────────────────────────────────
  useEffect(() => {
    if (activeAccountId) void useStarredStore.getState().load(activeAccountId);
  }, [activeAccountId]);

  const contextStarTarget = contextMenu ? (contextMenu.mediaMsg || contextMenu.msg) : null;
  const contextTargetStarred = useStarredStore(s => !!(
    contextStarTarget && activeAccountId && activeThreadId
    && s.keys[activeAccountId]?.has(starKey(activeThreadId, String(contextStarTarget.msg_id)))
  ));

  const handleToggleStar = async (target: any) => {
    if (!activeAccountId || !activeThreadId || !target?.msg_id) return;
    const store = useStarredStore.getState();
    const msgId = String(target.msg_id);
    const starred = !store.isStarred(activeAccountId, activeThreadId, msgId);
    const sender = resolveStarSender(target);
    const ok = await store.setStarred({
      zaloId: activeAccountId,
      threadId: activeThreadId,
      msgId,
      starred,
      snapshot: starred ? buildStarredSnapshot(target, {
        senderName: sender.name,
        senderAvatar: sender.avatar,
        threadName: activeContact?.alias || activeContact?.display_name || '',
        threadAvatar: activeContact?.avatar_url || '',
        channel: activeContact?.channel || CHANNEL.ZALO,
      }) : undefined,
    });
    if (ok) showNotification(starred ? tr('Đã đánh dấu tin nhắn - xem ở menu ⋮ → Tin đánh dấu') : tr('Đã bỏ đánh dấu tin nhắn'), 'success');
    else showNotification(tr('Không lưu được đánh dấu tin nhắn'), 'error');
  };

  const handlePin = async (msg: any) => {
    if (!activeAccountId || !activeThreadId) return;
    // Get the sender's name
    // If it is your own message (is_sent=1), use the name of the logged-in account
    let senderName = '';
    if (msg.is_sent) {
      const activeAccount = getActiveAccount();
      senderName = activeAccount?.full_name || tr('Tôi');
    } else {
      const contact = getContact(msg.sender_id);
      const groupMember = getGroupMember(msg.sender_id);
      // Do not use sender_id (a long UID) as the name; fall back to 'Người dùng' ('User')
      const contactName = contact?.alias || contact?.display_name || '';
      senderName = (contactName && contactName !== msg.sender_id ? contactName : '')
        || groupMember?.displayName
        || contactName
        || tr('Người dùng');
    }
    const pin = buildPinFromMsg(msg, senderName);

    const ch = msg.channel || activeContact?.channel || CHANNEL.ZALO;
    // The three-message limit is a Zalo server constraint. Telegram's API
    // supports multiple pinned messages in a chat, so never downgrade a
    // Telegram pin to local-only based on the Zalo rule.
    const alreadyPinned = pins.some(p => p.msg_id === msg.msg_id);
    const overLimit = isZalo(ch) && !alreadyPinned && pins.length >= 3;
    // Messenger accepts no pin from Deplao (its pin mutation is refused): the pin is kept in Deplao only
    const facebookLocalOnly = isFacebook(ch);

    try {
      // Server-side pin for Telegram
      if (ch === 'telegram_user') {
        const res = await ipc.telegramUser?.pinMessage({ accountId: activeAccountId, chatId: activeThreadId, messageId: String(msg.msg_id) });
        if (!res?.success) {
          showNotification(tr('Ghim trên Telegram thất bại: {{v1}}', { v1: (res?.error || 'Unknown') }), 'error');
          return;
        }
      }

      // Zalo: the main process pins on Zalo too (the phone sees it); over Zalo's limit the pin stays in the app only
      const pinRes: any = await ipc.db?.pinMessage({ zaloId: activeAccountId, threadId: activeThreadId, pin, localOnly: overLimit });
      // Employee: pin waits for Boss to confirm; if Boss refuses or the connection drops, show an error (it used to always show "Đã ghim" (Pinned))
      if (pinRes?.success === false) {
        showNotification(tr('Ghim thất bại: {{v1}}', { v1: (pinRes.error || tr('lỗi không xác định')) }), 'error');
        return;
      }
      // Reload pins
      // Read through DataAccessor: employee mode gets it from Boss (the IPC returns an empty stub → the pinned list was wiped right after pinning)
      const res = await DataAccessor.getPinnedMessages({ zaloId: activeAccountId, threadId: activeThreadId });
      if (res?.success) setPins(res.pins || []);
      if (overLimit) {
        // The Zalo API only supports 3 pinned messages: pinning succeeds in the app but does not sync to the API
        showNotification(tr('Đã ghim (chỉ áp dụng trong app - Zalo giới hạn 3 tin ghim)'), 'success');
      } else if (facebookLocalOnly) {
        showNotification(tr('Đã ghim trong Deplao (Messenger chưa nhận ghim từ Deplao)'), 'success');
      } else {
        showNotification(tr('Đã ghim tin nhắn'), 'success');
      }
    } catch (e: any) {
      showNotification(tr('Ghim thất bại: {{message}}', { message: e.message }), 'error');
    }
  };

  return {
    getAuth, handleUndo, handleDelete, handleDeleteFromDb, handleReact, handleCancelReaction, handleForward, runForward,
    handleSaveToMyDocuments, contextTargetStarred, handleToggleStar, handlePin,
  };
}

export type MessageActions = ReturnType<typeof useMessageActions>;
