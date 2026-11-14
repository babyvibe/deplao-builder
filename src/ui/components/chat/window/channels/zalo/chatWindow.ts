/**
 * Zalo in the chat window: group members from getGroupInfo (when the DB has none), names + photos of unknown senders (getUserInfo, one person at a time).
 * Older messages: DB only (Zalo history is loaded elsewhere: syncing from the phone, getGroupChatHistory).
 */
import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { isNonZalo } from '@/lib/channels/channelHelper';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import type { ChatWindowChannel, FetchGroupMembersArgs, ResolveUnknownSendersArgs, ServerGroupInfo } from '../types';

async function fetchGroupMembers({ account, accountId, groupId }: FetchGroupMembersArgs): Promise<ServerGroupInfo | null> {
  const auth = buildZaloAuth(account, accountId);
  const infoRes = await ipc.zalo?.getGroupInfo({ auth, groupId });
  const info = infoRes?.response?.gridInfoMap?.[groupId] || infoRes?.response;
  if (!info) return null;

  const name: string = info.name || info.groupName || '';
  const avatar: string = info.avt || info.fullAvt || info.avatar || '';
  const creatorId: string = String(info.creatorId || info.creator || '');
  const adminList: string[] = (info.adminIds || info.admins || []).map(String);

  // Build the members list from memVerList or memIdList
  // memVerList can be an array of strings "uid_version" or an array of objects {id, ...}
  const parseMemVerList = (list: any[]): string[] => {
    if (!list || !Array.isArray(list)) return [];
    return list.map((entry: any) => {
      if (typeof entry === 'string') return entry.replace(/_\d+$/, '');
      return String(entry.id || entry.uid || entry.userId || '');
    }).filter(uid => uid && uid !== 'undefined');
  };

  const memberIds: string[] = (info.memberIds?.length > 0)
    ? info.memberIds.map(String).filter(Boolean)
    : (info.memVerList?.length > 0)
      ? parseMemVerList(info.memVerList)
      : (info.memIdList || []).map(String).filter(Boolean);

  const rawMembers = memberIds.map((uid: string) => ({
    memberId: uid,
    displayName: '',
    avatar: '',
    // Zalo convention in the DB: 2 = group owner, 1 = deputy (shared/chat/groupMemberRoles). It used to be saved the other way round
    role: uid === creatorId ? 2 : adminList.includes(uid) ? 1 : 0,
  }));

  return { members: rawMembers, name, avatar, creatorId, adminIds: adminList };
}

function resolveUnknownSenders(
  { activeAccountId, activeThreadId, unknownSenders, requestedMemberInfoRef }: ResolveUnknownSendersArgs,
): void {
  // Zalo: fetch individual user info
  for (const senderId of unknownSenders) {
    const senderKey = `${activeAccountId}__${senderId}__${activeThreadId}`;
    requestedMemberInfoRef.current.add(senderKey);

    // Fetch member info via IPC, similar to fetchGroupMemberInfo in useZaloEvents
    const load = async () => {
      try {
        const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
        if (!acc || isNonZalo(acc.channel)) return;
        const auth = buildZaloAuth(acc, activeAccountId);
        const res = await ipc.zalo?.getUserInfo({ auth, userId: senderId });
        if (!res?.success || !res.response) return;
        const profile = res.response.changed_profiles?.[senderId];
        if (!profile) return;

        const displayName = profile.displayName || profile.zaloName || '';
        const avatar = profile.avatar || '';
        if (!displayName && !avatar) return;

        // Update contact store
        if (displayName || avatar) {
          useChatStore.getState().updateContact(activeAccountId!, {
            contact_id: senderId,
            ...(displayName ? { display_name: displayName } : {}),
            ...(avatar ? { avatar_url: avatar } : {}),
          });
        }

        // Update groupInfoCache
        if (activeThreadId && (displayName || avatar)) {
          const cache = useAppStore.getState().groupInfoCache?.[activeAccountId!]?.[activeThreadId];
          if (cache?.members) {
            const members = [...cache.members];
            const idx = members.findIndex(m => m.userId === senderId);
            if (idx >= 0) {
              members[idx] = { ...members[idx], ...(displayName ? { displayName } : {}), ...(avatar ? { avatar } : {}) };
            } else {
              members.push({ userId: senderId, displayName: displayName || senderId, avatar: avatar || '', role: 0 });
            }
            useAppStore.getState().setGroupInfo(activeAccountId!, activeThreadId, { ...cache, members, fetchedAt: Date.now() });
          }
        }

        // Save to DB
        await DataAccessor.saveGroupMembers({
          zaloId: activeAccountId, groupId: activeThreadId,
          members: [{ memberId: senderId, displayName: displayName || senderId, avatar: avatar || '', role: 0 }],
        }).catch(() => {});
        DataAccessor.updateContactProfile({
          zaloId: activeAccountId, contactId: senderId,
          displayName: displayName || senderId, avatarUrl: avatar, phone: '',
        }).catch(() => {});
      } catch {}
    };
    load();
  }
}

export const zaloChatWindow: ChatWindowChannel = {
  fetchGroupMembers,
  resolveUnknownSenders,
};
