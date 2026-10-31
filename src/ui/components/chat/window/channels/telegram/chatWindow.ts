/**
 * Telegram trong khung chat: tải lịch sử cũ hơn từ Telegram khi DB hết, tải tin chưa có để nhảy tới (tin ghim / trích
 * dẫn), thành viên nhóm từ Telegram, tên + ảnh người gửi chưa biết (hỏi theo lô bằng hydrateMessageSenders).
 */
import { GROUP_MEMBER_LIMIT, MESSAGE_LOAD_LIMIT } from '@/lib/chat/constants';
import { useChatStore } from '@/store/chat/chatStore';
import { useAppStore } from '@/store/app/appStore';
import { getAdapter } from '@/lib/channels/adapters/registry';
import ipc from '@/lib/ipc';
import type {
  ChatWindowChannel, EnsureMessageArgs, EnsureMessageResult, FetchGroupMembersArgs, OlderFromServerArgs,
  OlderFromServerResult, ResolveUnknownSendersArgs, ServerGroupInfo,
} from '../types';

async function fetchOlderFromServer(
  { accountId, threadId, topicId, oldest }: OlderFromServerArgs,
): Promise<OlderFromServerResult> {
  // DB đã hết → xin Telegram lịch sử cũ hơn (được lưu vào DB) rồi đọc lại DB
  const tgRes: any = await ipc.telegramUser?.getMessages({
    accountId,
    chatId: threadId,
    offsetId: Number(oldest.msg_id),
    limit: MESSAGE_LOAD_LIMIT,
    topicRootMessageId: topicId || undefined,
  });
  // Lỗi (mất kết nối, FLOOD_WAIT…) → "Lỗi - Thử lại", giữ hasMore để còn thử lại
  if (!tgRes?.success) throw new Error(tgRes?.error || 'Telegram getMessages failed');
  const fetched = tgRes.messages?.length || 0;
  // Telegram trả đủ trang → có thể còn; trả thiếu / rỗng → đã tới đầu lịch sử
  return { stored: fetched, hasMore: fetched >= MESSAGE_LOAD_LIMIT };
}

async function ensureMessage({ accountId, threadId, messageId, notify }: EnsureMessageArgs): Promise<EnsureMessageResult> {
  notify('Đang tải tin nhắn từ Telegram...', 'info');
  const ensured = await ipc.telegramUser?.ensureMessageAvailable({
    accountId,
    chatId: threadId,
    messageId,
  });
  if (!ensured?.success) {
    const err = ensured?.error || '';
    if (err.includes('CHANNEL_PRIVATE') || err.includes('USER_BANNED_IN_CHANNEL')) {
      notify('Kênh này không cho phép tải tin nhắn', 'info');
    } else {
      notify(err || 'Không tải được tin nhắn đã ghim', 'error');
    }
    return { ok: false };
  }
  return { ok: true, message: ensured.message };
}

async function fetchGroupMembers({ accountId, groupId }: FetchGroupMembersArgs): Promise<ServerGroupInfo | null> {
  const adapter = getAdapter('telegram_user') as any;
  const memberRes = await adapter.getGroupMembers({ accountId, threadId: groupId, limit: GROUP_MEMBER_LIMIT });
  if (!memberRes?.success) return null;
  const members = (memberRes.members || [])
    .map((member: any) => ({
      memberId: String(member.id || member.userId || ''),
      displayName: [member.firstName, member.lastName].filter(Boolean).join(' ')
        || member.username || member.displayName || '',
      avatar: member.avatar || '',
      role: Number(member.role || 0),
      status: member.status || '', statusText: member.statusText || '',
      lastSeenAt: member.lastSeenAt, onlineUntil: member.onlineUntil,
    }))
    .filter((member: any) => member.memberId);
  return { members };
}

/** Thành viên lưu DB thiếu ảnh / tên (hoặc tên = UID) → lấy lại từ Telegram */
function membersNeedRefresh(dbMembers: any[]): boolean {
  return dbMembers.some((member: any) =>
    !member?.avatar
    || !member?.display_name
    || String(member.display_name) === String(member.member_id)
  );
}

function resolveUnknownSenders(
  { activeAccountId, activeThreadId, activeContact, msgs, unknownSenders, requestedMemberInfoRef }: ResolveUnknownSendersArgs,
): void {
  // Mark before awaiting. Updating groupInfoCache reruns this effect; doing
  // it afterwards used to launch many identical getGroupMembers requests.
  for (const senderId of unknownSenders) {
    requestedMemberInfoRef.current.add(`${activeAccountId}__${senderId}__${activeThreadId}`);
  }
  const senderMessageIds = msgs
    .filter(message => unknownSenders.has(String(message.sender_id)) && /^\d+$/.test(String(message.msg_id)))
    .map(message => String(message.msg_id));
  const senderIds = Array.from(unknownSenders);
  (async () => {
    const resolvedSenderIds = new Set<string>();
    const resolvedAvatarIds = new Set<string>();
    try {
      console.log('[TG_MEMBER_HYDRATE_REQUEST]', {
        accountId: activeAccountId, threadId: activeThreadId,
        senderIds, messageIds: senderMessageIds,
      });
      const res = await ipc.telegramUser?.hydrateMessageSenders({
        accountId: activeAccountId,
        chatId: activeThreadId,
        messageIds: senderMessageIds,
        senderIds,
      });
      console.log('[TG_MEMBER_HYDRATE_RESULT]', {
        accountId: activeAccountId, threadId: activeThreadId,
        requestedSenderIds: senderIds,
        resolvedSenderIds: (res?.members || []).map((member: any) => String(member.id || member.userId || '')),
        success: !!res?.success, error: res?.error || '',
      });
      if (res?.success && res.members) {
        let resolved = 0;
        const currentCache = useAppStore.getState().groupInfoCache?.[activeAccountId!]?.[activeThreadId!];
        const membersById = new Map((currentCache?.members || []).map(member => [String(member.userId), member]));
        for (const m of res.members) {
          const mId = String(m.id || '');
          const mName = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.username || '';
          if (mId && mName) {
            resolvedSenderIds.add(mId);
            const previous = membersById.get(mId);
            if (m.avatar || previous?.avatar) resolvedAvatarIds.add(mId);
            membersById.set(mId, {
              ...previous,
              userId: mId, displayName: mName, avatar: m.avatar || previous?.avatar || '',
              role: Number(m.role ?? previous?.role ?? 0), status: m.status || '',
              statusText: m.statusText || '', lastSeenAt: m.lastSeenAt,
              onlineUntil: m.onlineUntil,
            });
            resolved++;
          }
        }
        console.log(`[ChatWindow] Resolved ${resolved}/${res.members.length} Telegram sender names`);
        // Save to groupInfoCache so getGroupMember() works
        if (resolved > 0) {
          useAppStore.getState().setGroupInfo(activeAccountId!, activeThreadId!, {
            ...currentCache,
            name: currentCache?.name || activeContact?.display_name || '',
            avatar: currentCache?.avatar || activeContact?.avatar_url || '',
            members: Array.from(membersById.values()),
            fetchedAt: Date.now(),
            groupId: activeThreadId!,
            memberCount: currentCache?.memberCount || membersById.size,
          });
        }
        // Force re-render
        useChatStore.setState({ messagesLoading: false });
      }
    } catch (err: any) {
      console.error(`[ChatWindow] Telegram getGroupMembers error:`, err.message);
    } finally {
      for (const senderId of unknownSenders) {
        const retryKey = `${activeAccountId}__${senderId}__${activeThreadId}`;
        if (!resolvedSenderIds.has(senderId)) requestedMemberInfoRef.current.delete(retryKey);
        else setTimeout(() => requestedMemberInfoRef.current.delete(retryKey), resolvedAvatarIds.has(senderId) ? 5 * 60_000 : 60_000);
      }
    }
  })();
}

/** Tài khoản Telegram cá nhân (MTProto) */
export const telegramUserChatWindow: ChatWindowChannel = {
  fetchOlderFromServer,
  ensureMessage,
  fetchGroupMembers,
  membersNeedRefresh,
  resolveUnknownSenders,
};

/**
 * Bot Telegram: như tài khoản cá nhân trừ tải lịch sử cũ (bot không đọc được lịch sử, chỉ DB). Nhảy tới tin / thành
 * viên nhóm / người gửi đi cùng đường với Telegram cá nhân như trước khi tách.
 */
export const telegramBotChatWindow: ChatWindowChannel = {
  ensureMessage,
  fetchGroupMembers,
  membersNeedRefresh,
  resolveUnknownSenders,
};
