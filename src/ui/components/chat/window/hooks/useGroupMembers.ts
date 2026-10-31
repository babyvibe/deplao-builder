/**
 * Thành viên nhóm của hội thoại đang mở: bộ đệm còn mới (5 phút) thì thôi; không thì DB trước, chưa có (hoặc kênh thấy
 * thiếu tên / ảnh) thì hỏi server của kênh. Người gửi chưa có tên / ảnh: kênh tự hỏi server rồi lưu DB + danh bạ + bộ
 * đệm nhóm. Phần riêng từng kênh (Telegram, Zalo) ở channels/.
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

  // OPTIMIZATION: Load group members với cache TTL - chỉ reload nếu cache cũ hơn 5 phút
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;

    // Detect group từ contact list
    const contactList = useChatStore.getState().contacts[activeAccountId] || [];
    const contact = contactList.find(c => c.contact_id === activeThreadId);
    const isGroup = contact?.contact_type === 'group' || contact?.contact_type === '1';
    if (!isGroup) return;

    // Check cache còn mới (< 5 phút) và có members → skip load
    const existingCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
    const CACHE_TTL = GROUP_INFO_CACHE_TTL_MS;
    if (existingCache?.members?.length > 0 &&
        existingCache.fetchedAt &&
        Date.now() - existingCache.fetchedAt < CACHE_TTL) {
      return; // Cache còn mới → SKIP load, giảm ~80% IPC calls
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

    // 1. Tải từ DB trước
    DataAccessor.getGroupMembers({ zaloId: accountId, groupId })
      .then(async (res: any) => {
        if (res?.members?.length) {
          // DB có members → dùng luôn
          buildAndSetGroupInfo(res.members);
          // Kênh thấy thành viên lưu DB còn thiếu tên / ảnh (Telegram) → lấy lại từ server
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
          // DB không có members → hỏi server của kênh (Telegram: danh sách thành viên, Zalo: getGroupInfo)
          try {
            const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
            if (!acc) return;
            const fetchGroupMembers = chatWindowChannel(acc.channel).fetchGroupMembers;
            if (!fetchGroupMembers) return;
            const fresh = await fetchGroupMembers({ account: acc, accountId, groupId });
            if (!fresh) return;

            // Lưu vào DB
            if (fresh.members.length) {
              DataAccessor.saveGroupMembers({ zaloId: accountId, groupId, members: fresh.members }).catch(() => {});
            }
            // Cập nhật tên/avatar nhóm nếu có
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

  // ─── Fetch thông tin thành viên nhóm chưa biết - xử lý messages đã có ─────
  // Khi messages load từ DB hoặc nhóm có thành viên mới chưa có tên/avatar,
  // tự động hỏi kênh để enrich thông tin cho các sender_id lạ.
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

    // Telegram: hỏi theo lô; Zalo: getUserInfo từng người (channels/)
    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    chatWindowChannel(acc?.channel).resolveUnknownSenders?.({
      activeAccountId, activeThreadId, activeContact, msgs, unknownSenders, requestedMemberInfoRef,
    });
  }, [activeAccountId, activeThreadId, msgs, threadGroupInfo]);
}
