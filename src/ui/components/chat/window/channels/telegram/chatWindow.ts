/**
 * Telegram in the chat window: load older history from Telegram when the DB runs out, load messages not yet stored to jump to (pinned / quoted
 * messages), group members from Telegram, names + avatars of unknown senders (requested in batches via hydrateMessageSenders).
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
import { tr } from '../../../../../../shared/i18n';

async function fetchOlderFromServer(
  { accountId, threadId, topicId, oldest }: OlderFromServerArgs,
): Promise<OlderFromServerResult> {
  // DB has no more → ask Telegram for older history (saved to the DB), then read the DB again
  const tgRes: any = await ipc.telegramUser?.getMessages({
    accountId,
    chatId: threadId,
    offsetId: Number(oldest.msg_id),
    limit: MESSAGE_LOAD_LIMIT,
    topicRootMessageId: topicId || undefined,
  });
  // Error (connection lost, FLOOD_WAIT…) → "Lỗi - Thử lại" (Error - Retry), keep hasMore so it can retry
  if (!tgRes?.success) throw new Error(tgRes?.error || 'Telegram getMessages failed');
  const fetched = tgRes.messages?.length || 0;
  // Telegram returns a full page → there may be more; a short / empty page → reached the start of the history
  return { stored: fetched, hasMore: fetched >= MESSAGE_LOAD_LIMIT };
}

async function ensureMessage({ accountId, threadId, messageId, notify }: EnsureMessageArgs): Promise<EnsureMessageResult> {
  notify(tr('Đang tải tin nhắn từ Telegram...'), 'info');
  const ensured = await ipc.telegramUser?.ensureMessageAvailable({
    accountId,
    chatId: threadId,
    messageId,
  });
  if (!ensured?.success) {
    const err = ensured?.error || '';
    if (err.includes('CHANNEL_PRIVATE') || err.includes('USER_BANNED_IN_CHANNEL')) {
      notify(tr('Kênh này không cho phép tải tin nhắn'), 'info');
    } else {
      notify(err || tr('Không tải được tin nhắn đã ghim'), 'error');
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

/** Members saved in the DB missing a photo / name (or the name is a UID) → fetch again from Telegram */
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

/** Personal Telegram account (MTProto) */
export const telegramUserChatWindow: ChatWindowChannel = {
  fetchOlderFromServer,
  ensureMessage,
  fetchGroupMembers,
  membersNeedRefresh,
  resolveUnknownSenders,
};

/**
 * Telegram bot: same as a personal account, except loading old history (bots cannot read history, DB only). Jumping to a message, group
 * members and senders take the same route as the personal Telegram account did before the split.
 */
export const telegramBotChatWindow: ChatWindowChannel = {
  ensureMessage,
  fetchGroupMembers,
  membersNeedRefresh,
  resolveUnknownSenders,
};
