/**
 * Group members of the open conversation: if the cache is fresh (5 minutes), stop there; otherwise the DB first, and if it has none (or the channel sees
 * missing names / photos), ask the channel's server. Senders without a name / photo: the channel asks the server itself, then saves to the DB + contacts + group
 * cache. Per-channel parts (Telegram, Zalo) are in channels/.
 */
import { useEffect, useRef } from 'react';
import { GROUP_INFO_CACHE_TTL_MS } from '@/lib/chat/constants';
import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import DataAccessor from '@/lib/data/DataAccessor';
import { chatWindowChannel } from '../channels';

export function useGroupMembers(deps: {
  activeAccountId: string | null;
  activeThreadId: string | null;
  msgs: any[];
  threadGroupInfo: any;
  activeContact: any;
  getContact: (senderId: string) => any;
  getGroupMember: (senderId: string) => any;
}) {
  const { activeAccountId, activeThreadId, msgs, threadGroupInfo, activeContact, getContact, getGroupMember } = deps;
  // Track which group member info requests have been made (avoid duplicate IPC calls)
  const requestedMemberInfoRef = useRef<Set<string>>(new Set());

  // OPTIMIZATION: load group members with a cache TTL, reload only if the cache is older than 5 minutes
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;

    // Detect the group from the contact list
    const contactList = useChatStore.getState().contacts[activeAccountId] || [];
    const contact = contactList.find(c => c.contact_id === activeThreadId);
    const isGroup = contact?.contact_type === 'group' || contact?.contact_type === '1';
    if (!isGroup) return;

    // Check that the cache is still fresh (< 5 minutes) and has members → skip loading
    const existingCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
    const CACHE_TTL = GROUP_INFO_CACHE_TTL_MS;
    if (existingCache?.members?.length > 0 &&
        existingCache.fetchedAt &&
        Date.now() - existingCache.fetchedAt < CACHE_TTL) {
      return; // Cache still fresh → SKIP loading, cuts ~80% of IPC calls
    }

    const { setGroupInfo } = useAppStore.getState();

    const groupId = activeThreadId;
    const accountId = activeAccountId;

    const buildAndSetGroupInfo = (members: any[], name?: string, avatar?: string, creatorId?: string, adminIds?: string[]) => {
      const c = useChatStore.getState().contacts[accountId]?.find(x => x.contact_id === groupId);
      // Telegram's GetParticipants(Recent) is only a partial page for large
      // groups. Never replace exact/history senders already present in the
      // cache with that page, otherwise their name/avatar regresses to UID.
      const current = useAppStore.getState().groupInfoCache?.[accountId]?.[groupId];
      const membersById = new Map<string, any>();
      for (const member of current?.members || []) {
        if (member?.userId != null) membersById.set(String(member.userId), member);
      }
      for (const m of members) {
        const userId = String(m.member_id || m.memberId || m.userId || '');
        if (!userId) continue;
        const previous = membersById.get(userId);
        membersById.set(userId, {
          ...previous,
          userId,
          displayName: m.display_name || m.displayName || previous?.displayName || '',
          avatar: m.avatar || previous?.avatar || '',
          role: m.role ?? previous?.role ?? 0,
          status: m.status || previous?.status || '',
          statusText: m.statusText || previous?.statusText || '',
          lastSeenAt: m.lastSeenAt ?? previous?.lastSeenAt,
          onlineUntil: m.onlineUntil ?? previous?.onlineUntil,
        });
      }
      const mergedMembers = Array.from(membersById.values());
      setGroupInfo(accountId, groupId, {
        groupId,
        name: name || current?.name || c?.display_name || groupId,
        avatar: avatar || current?.avatar || c?.avatar_url || '',
        memberCount: Math.max(Number(current?.memberCount || 0), mergedMembers.length),
        members: mergedMembers,
        creatorId: creatorId || current?.creatorId || '',
        adminIds: adminIds || current?.adminIds || [],
        settings: current?.settings,
        fetchedAt: Date.now(),
      });
    };

    // 1. Load from the DB first
    DataAccessor.getGroupMembers({ zaloId: accountId, groupId })
      .then(async (res: any) => {
        if (res?.members?.length) {
          // DB has members → use them
          buildAndSetGroupInfo(res.members);
          // Channel sees that saved members in the DB still lack names / photos (Telegram) → fetch again from the server
          const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
          const channel = chatWindowChannel(acc?.channel);
          if (channel.fetchGroupMembers && channel.membersNeedRefresh?.(res.members)) {
            const fresh = await channel.fetchGroupMembers({ account: acc, accountId, groupId });
            if (fresh?.members.length) {
              await DataAccessor.saveGroupMembers({ zaloId: accountId, groupId, members: fresh.members });
              buildAndSetGroupInfo(fresh.members);
            }
          }
        } else {
          // DB has no members → ask the channel's server (Telegram: member list, Zalo: getGroupInfo)
          try {
            const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
            if (!acc) return;
            const fetchGroupMembers = chatWindowChannel(acc.channel).fetchGroupMembers;
            if (!fetchGroupMembers) return;
            const fresh = await fetchGroupMembers({ account: acc, accountId, groupId });
            if (!fresh) return;

            // Save to DB
            if (fresh.members.length) {
              DataAccessor.saveGroupMembers({ zaloId: accountId, groupId, members: fresh.members }).catch(() => {});
            }
            // Update the group name / avatar if present
            if (fresh.name) {
              DataAccessor.updateContactProfile({ zaloId: accountId, contactId: groupId, displayName: fresh.name, avatarUrl: fresh.avatar, phone: '' }).catch(() => {});
              useChatStore.getState().updateContact(accountId, { contact_id: groupId, display_name: fresh.name, avatar_url: fresh.avatar });
            }

            buildAndSetGroupInfo(fresh.members, fresh.name, fresh.avatar, fresh.creatorId, fresh.adminIds);
          } catch {}
        }
      })
      .catch(() => {});
  }, [activeThreadId, activeAccountId]);

  // ─── Fetch info for unknown group members: handle messages already loaded ─────
  // When messages load from the DB, or the group has new members without a name / avatar,
  // the channel is asked automatically to enrich the info for unknown sender_ids.
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    const contactList = useChatStore.getState().contacts[activeAccountId] || [];
    const threadContact = contactList.find(c => c.contact_id === activeThreadId);
    const isGroup = threadContact?.contact_type === 'group'
      || String(threadContact?.contact_type) === '1'
      || msgs.some(message => Number(message.thread_type) === 1);
    if (!isGroup) return;

    const unknownSenders = new Set<string>();
    for (const msg of msgs) {
      if (msg.is_sent === 1 || !msg.sender_id) continue;
      const senderId = String(msg.sender_id);
      const senderKey = `${activeAccountId}__${senderId}__${activeThreadId}`;

      const ct = getContact(senderId);
      if (ct?.display_name && ct.display_name !== senderId && !/^-?\d+$/.test(ct.display_name) && ct.avatar_url) {
        continue; // contacts already has both identity and avatar
      }
      const gm = getGroupMember(senderId);
      if (gm?.displayName && gm.displayName !== senderId && !/^-?\d+$/.test(gm.displayName) && gm.avatar) {
        continue; // group cache already has both identity and avatar
      }
      if (requestedMemberInfoRef.current.has(senderKey)) continue;

      unknownSenders.add(senderId);
    }

    if (unknownSenders.size === 0) return;

    // Telegram: ask in batches; Zalo: getUserInfo one person at a time (channels/)
    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    chatWindowChannel(acc?.channel).resolveUnknownSenders?.({
      activeAccountId, activeThreadId, activeContact, msgs, unknownSenders, requestedMemberInfoRef,
    });
  }, [activeAccountId, activeThreadId, msgs, threadGroupInfo]);
}
