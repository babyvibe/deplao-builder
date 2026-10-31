/**
 * Thao tác trên tin: thu hồi, xoá phía mình, xoá khỏi app, thả / gỡ cảm xúc (cập nhật ngay trên giao diện), chuyển
 * tiếp (cả album), lưu vào My Documents (Zalo), đánh dấu sao, ghim (Telegram ghim trên server; Zalo tối đa 3 tin).
 */
import { useEffect } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import { useStarredStore } from '@/store/chat/starredStore';
import { buildStarredSnapshot, starKey } from '@/lib/chat/messages/starredMessages';
import { myDocumentsThreadId } from '@/lib/chat/zalo/myDocuments';
import { buildPinFromMsg } from '../../messages/PinnedMessages';
import * as channelIpc from '../../../../lib/channels/channelIpc';
import { CHANNEL, isNonZalo, isZalo } from '@/lib/channels/channelHelper';
import { EMOJI_TO_REACTION } from '@/lib/chat/messages/emojiUtils';
import { markLocalReaction } from '@/lib/chat/reactions/localReactionRegistry';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { runForwardJob, type ForwardJobLabels, type ForwardJobTarget } from '@/lib/chat/forward/forwardSend';
import type { MessageContextMenuState } from './useChatWindowDialogs';

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
        await channelIpc.unsendMessage(ch, {
          accountId: activeAccountId || '',
          messageId: msg.msg_id,
          threadId: msg.thread_id,
        });
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
      // IPC trả { success: false } (không ném) khi Zalo / Boss từ chối — không được đánh dấu "đã thu hồi" giả
      if (undoRes?.success === false) throw new Error(undoRes.error || 'Zalo từ chối');
      }
      // Đánh dấu thu hồi thay vì xóa - hiển thị "Tin nhắn đã thu hồi"
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id, threadId: msg.thread_id }).catch(() => {});
      }
      showNotification('Đã thu hồi tin nhắn', 'success');
    } catch (e: any) {
      showNotification('Thu hồi thất bại: ' + e.message, 'error');
    }
  };

  const handleDelete = async (msg: any) => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;
      if (isNonZalo(ch)) {
        await (channelIpc as any).unsendMessage(ch, { accountId: activeAccountId || '', messageId: msg.msg_id, threadId: msg.thread_id });
      } else {
      const messagePayload = JSON.stringify({
        data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id, uidFrom: msg.sender_id },
        threadId: msg.thread_id,
        type: msg.thread_type,
      });
      const deleteRes: any = await ipc.zalo?.deleteMessage({ auth, message: messagePayload, onlyMe: true });
      if (deleteRes?.success === false) throw new Error(deleteRes.error || 'Zalo từ chối');
      }
      // Đánh dấu đã xoá trong DB (recalled) thay vì xoá hẳn - nhất quán với thu hồi
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id, threadId: msg.thread_id }).catch(() => {});
      }
      showNotification('Đã xóa tin nhắn', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleDeleteFromDb = async (msg: any) => {
    if (!activeAccountId) return;
    try {
      await DataAccessor.deleteMessages({ zaloId: activeAccountId, msgIds: [msg.msg_id], threadId: msg.thread_id });
      removeMessage(activeAccountId, msg.thread_id, msg.msg_id);
      showNotification('Đã xóa vĩnh viễn tin nhắn khỏi app', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleReact = async (msg: any, emoji: string) => {
    try {
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      // Optimistic update: show reaction immediately in UI
      const accId = activeAccountId || '';
      // Telegram: SendReaction THAY reaction của mình (mỗi người 1) và số đếm là tổng hợp do Telegram trả — main
      // process lưu số chính thức từ kết quả gửi. Không cộng dồn vào DB kiểu Zalo (trước đây cộng nhầm vào tin
      // trùng ID ở hội thoại khác → "1 đống icon").
      const isTelegramUserMsg = ch === 'telegram_user';
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, emoji, isTelegramUserMsg ? 'set' : 'accumulate');

      if (!isTelegramUserMsg) {
        // Persist reaction to DB immediately (so it survives conversation switch); echo Zalo của lần bấm này bỏ qua
        markLocalReaction(accId, msg.msg_id, emoji);
        DataAccessor.updateReaction?.({ zaloId: accId, msgId: msg.msg_id, threadId: msg.thread_id, userId: accId, emoji }).catch(() => {});
      }

      if (isNonZalo(ch)) {
        await channelIpc.addReaction(ch, {
          accountId: accId,
          messageId: msg.msg_id,
          emoji,
          threadId: msg.thread_id,
          action: 'add',
        });
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

  // Huỷ reaction: gửi Reactions.NONE = "" để xoá
  const handleCancelReaction = async (msg: any) => {
    try {
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      // Optimistic update: remove reaction immediately in UI
      const accId = activeAccountId || '';
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, '');
      // Lưu luôn việc gỡ (trước đây không lưu → mở lại hội thoại reaction hiện lại). Gỡ lặp lại với echo Zalo vô hại.
      // Telegram: main process lưu số chính thức từ kết quả gửi.
      if (ch !== 'telegram_user') {
        DataAccessor.updateReaction?.({ zaloId: accId, msgId: msg.msg_id, threadId: msg.thread_id, userId: accId, emoji: '' }).catch(() => {});
      }

      if (isNonZalo(ch)) {
        await channelIpc.addReaction(ch, {
          accountId: accId,
          messageId: msg.msg_id,
          emoji: '',
          threadId: msg.thread_id,
          action: 'remove',
        });
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

  // Album ảnh (nhiều tin ảnh cùng groupLayoutId, hiển thị 1 bubble) → chuyển tiếp cả album, không chỉ ảnh đầu
  const handleForward = (msg: any) => {
    setForwardMsgs(groupedFirstMsgs[msg.msg_id] || [msg]);
  };

  /**
   * Gửi các tin tới từng người nhận (chuyển tiếp / Lưu vào My Documents): album gộp 1 lần, còn lại từng tin;
   * nội dung soạn kèm (nếu có) là 1 tin mới sau cùng. Chạy nền, không block UI (lib/chat/forward/forwardSend).
   */
  const runForward = (
    messages: any[],
    targets: ForwardJobTarget[],
    composeText: string,
    labels?: ForwardJobLabels,
  ) => runForwardJob(messages, targets, composeText, {
    albums: groupedFirstMsgs, accounts: allAccounts, sourceAccountId: activeAccountId, notify: showNotification,
  }, labels);

  // Zalo: "Lưu vào My Documents" = gửi bản sao tin vào hội thoại My Documents CÓ SẴN của Zalo (ID = send2me_id của
  // phiên đăng nhập — không phải hội thoại với UID của chính mình)
  const handleSaveToMyDocuments = async (target: any) => {
    if (!activeAccountId || !target) return;
    const myDocsId = myDocumentsThreadId(allAccounts.find(a => a.zalo_id === activeAccountId));
    if (!myDocsId) {
      showNotification('Chưa xác định được hội thoại My Documents của tài khoản này — hãy kết nối lại tài khoản Zalo rồi thử lại', 'error');
      return;
    }
    // Ảnh trong album được bấm chuột phải → chỉ ảnh đó; còn lại cả album / tin
    const messages = contextMenu?.mediaMsg ? [target] : (groupedFirstMsgs[target.msg_id] || [target]);
    runForward(messages, [{ accountId: activeAccountId, threadId: myDocsId, threadType: 0 }], '', {
      progress: (done, total) => `Đang lưu vào My Documents ${done}/${total}...`,
      done: 'Đã lưu vào My Documents',
    });
  };

  // ─── Tin đánh dấu (như Zalo) ──────────────────────────────────────────────
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
    if (ok) showNotification(starred ? 'Đã đánh dấu tin nhắn - xem ở menu ⋮ → Tin đánh dấu' : 'Đã bỏ đánh dấu tin nhắn', 'success');
    else showNotification('Không lưu được đánh dấu tin nhắn', 'error');
  };

  const handlePin = async (msg: any) => {
    if (!activeAccountId || !activeThreadId) return;
    // Lấy tên người gửi
    // Nếu là tin của mình (is_sent=1), dùng tên account đang đăng nhập
    let senderName = '';
    if (msg.is_sent) {
      const activeAccount = getActiveAccount();
      senderName = activeAccount?.full_name || 'Tôi';
    } else {
      const contact = getContact(msg.sender_id);
      const groupMember = getGroupMember(msg.sender_id);
      // Không dùng sender_id (UID dài) làm tên - fallback về 'Người dùng'
      const contactName = contact?.alias || contact?.display_name || '';
      senderName = (contactName && contactName !== msg.sender_id ? contactName : '')
        || groupMember?.displayName
        || contactName
        || 'Người dùng';
    }
    const pin = buildPinFromMsg(msg, senderName);

    const ch = msg.channel || activeContact?.channel || CHANNEL.ZALO;
    // The three-message limit is a Zalo server constraint. Telegram's API
    // supports multiple pinned messages in a chat, so never downgrade a
    // Telegram pin to local-only based on the Zalo rule.
    const alreadyPinned = pins.some(p => p.msg_id === msg.msg_id);
    const overLimit = isZalo(ch) && !alreadyPinned && pins.length >= 3;

    try {
      // Server-side pin for Telegram
      if (ch === 'telegram_user') {
        const res = await ipc.telegramUser?.pinMessage({ accountId: activeAccountId, chatId: activeThreadId, messageId: String(msg.msg_id) });
        if (!res?.success) {
          showNotification('Ghim trên Telegram thất bại: ' + (res?.error || 'Unknown'), 'error');
          return;
        }
      }

      const pinRes: any = await ipc.db?.pinMessage({ zaloId: activeAccountId, threadId: activeThreadId, pin });
      // Nhân viên: ghim chờ Boss xác nhận — Boss từ chối / mất kết nối thì báo lỗi (trước đây luôn "Đã ghim")
      if (pinRes?.success === false) {
        showNotification('Ghim thất bại: ' + (pinRes.error || 'lỗi không xác định'), 'error');
        return;
      }
      // Reload pins
      // Đọc qua DataAccessor: chế độ nhân viên lấy từ Boss (IPC trả stub rỗng → danh sách ghim bị xoá trắng sau khi ghim)
      const res = await DataAccessor.getPinnedMessages({ zaloId: activeAccountId, threadId: activeThreadId });
      if (res?.success) setPins(res.pins || []);
      if (overLimit) {
        // Zalo API chỉ hỗ trợ 3 tin ghim - ghim thành công trong ứng dụng nhưng không đồng bộ lên API
        showNotification('Đã ghim (chỉ áp dụng trong app - Zalo giới hạn 3 tin ghim)', 'success');
      } else {
        showNotification('Đã ghim tin nhắn', 'success');
      }
    } catch (e: any) {
      showNotification('Ghim thất bại: ' + e.message, 'error');
    }
  };

  return {
    getAuth, handleUndo, handleDelete, handleDeleteFromDb, handleReact, handleCancelReaction, handleForward, runForward,
    handleSaveToMyDocuments, contextTargetStarred, handleToggleStar, handlePin,
  };
}

export type MessageActions = ReturnType<typeof useMessageActions>;
