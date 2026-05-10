import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore, CachedGroupInfo, GroupMember } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { AddMemberToGroupModal } from './GroupModals';
import { UserProfilePopup } from '../common/UserProfilePopup';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/utils/apiError';
import GroupAvatar from '../common/GroupAvatar';
import MediaSection, { MediaDetailPanel, MediaTab } from './MediaSection';
import { GroupActionSection } from './ConversationActions';
import { syncZaloGroups, MemberPlaceholder } from '@/lib/zaloGroupUtils';
import { getCapability, type Channel } from '../../../configs/channelConfig';

type PanelView = 'info' | 'members' | 'manage' | 'media' | 'pending';

// ─── Pending members cache (5-min TTL, module-level) ─────────────────────────
const PENDING_CACHE_TTL = 5 * 60 * 1000;
type PendingMember = { userId: string; displayName: string; avatar: string };
const pendingMembersCache = new Map<string, { data: PendingMember[]; ts: number }>();

async function fetchPendingMembers(
  auth: any,
  groupId: string,
  accountId: string,
  force = false,
): Promise<PendingMember[]> {
  const key = `${accountId}_${groupId}`;
  const cached = pendingMembersCache.get(key);
  if (!force && cached && Date.now() - cached.ts < PENDING_CACHE_TTL) {
    return cached.data;
  }

  const res = await ipc.zalo?.getPendingGroupMembers({ auth, groupId });
  const rawList: any[] =
    res?.response?.memberIds ||
    res?.response?.pendingMembers ||
    res?.response?.members ||
    (Array.isArray(res?.response) ? res.response : []);

  const uids: string[] = rawList
    .map((item: any) =>
      typeof item === 'string' ? item : (item.id || item.userId || item.uid || String(item)),
    )
    .filter(Boolean);

  if (uids.length === 0) {
    pendingMembersCache.set(key, { data: [], ts: Date.now() });
    return [];
  }

  const profiles: PendingMember[] = [];
  await Promise.all(
    uids.map(async (uid) => {
      try {
        const info = await ipc.zalo?.getUserInfo({ auth, userId: uid });
        const p = info?.response?.user || info?.response || {};
        profiles.push({
          userId: uid,
          displayName: p.display || p.displayName || p.zaloName || p.name || uid,
          avatar: p.avatar || p.avt || '',
        });
      } catch {
        profiles.push({ userId: uid, displayName: uid, avatar: '' });
      }
    }),
  );

  pendingMembersCache.set(key, { data: profiles, ts: Date.now() });
  return profiles;
}

function invalidatePendingCache(accountId: string, groupId: string) {
  pendingMembersCache.delete(`${accountId}_${groupId}`);
}

const getMyRole = (groupInfo: CachedGroupInfo | null, myId: string | null): number => {
  if (!myId || !groupInfo) return 0;
  const me = groupInfo.members?.find(m => m.userId === myId);
  return me?.role ?? (groupInfo.creatorId === myId ? 1 : groupInfo.adminIds?.includes(myId) ? 2 : 0);
};
const canManage = (role: number) => role >= 1; // owner or deputy

function muteUntilToDuration(until: number): number | string {
  if (until === 0) return -1;
  const remainSec = Math.round((until - Date.now()) / 1000);
  if (Math.abs(remainSec - 3600) <= 300) return 3600;
  if (Math.abs(remainSec - 14400) <= 300) return 14400;
  const t = new Date(until);
  if (t.getHours() === 8 && t.getMinutes() === 0) return 'until8AM';
  return remainSec > 0 ? remainSec : -1;
}

const MUTE_OPTIONS = [
  { label: 'Trong 1 giờ',              until: () => Date.now() + 60 * 60 * 1000 },
  { label: 'Trong 4 giờ',              until: () => Date.now() + 4 * 60 * 60 * 1000 },
  { label: 'Cho đến 8:00 AM',          until: () => { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 8 ? 1 : 0)); d.setHours(8,0,0,0); return d.getTime(); } },
  { label: 'Cho đến khi được mở lại',  until: () => 0 },
];

export default function GroupInfoPanel() {
  const { activeThreadId, contacts } = useChatStore();
  const { activeAccountId, getActiveAccount } = useAccountStore();
  const { showNotification, setGroupInfo, setMuted, clearMuted, isMuted: isMutedFn } = useAppStore();

  const [panelView, setPanelView] = useState<PanelView>('info');
  const [mediaTab, setMediaTab] = useState<MediaTab>('image');
  const [groupInfo, setLocalGroupInfo] = useState<CachedGroupInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [muteDropdownOpen, setMuteDropdownOpen] = useState(false);
  const [muteDropdownPos, setMuteDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [userProfilePopup, setUserProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const muteRef = useRef<HTMLDivElement>(null);

  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];
  const contact = contactList.find(c => c.contact_id === activeThreadId);
  const displayName = contact?.display_name || activeThreadId || '';
  const avatarUrl = contact?.avatar_url || '';

  // Channel capability
  const channelCap = getCapability((contact?.channel || 'zalo') as Channel);
  const isFBChannel = channelCap.id === 'facebook';

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };


  // Load pin status on thread change — only for channels that support it
  useEffect(() => {
    if (!activeThreadId || !channelCap.supportsPinConversation) return;
    setIsPinned(false);
    const auth = getAuth();
    if (!auth) return;
    ipc.zalo?.getPinConversations(auth).then((res: any) => {
      const convIds: string[] = res?.response?.conversations || [];
      setIsPinned(convIds.some((id: string) => id.replace(/^[ug]/, '') === activeThreadId));
    }).catch(() => {});
  }, [activeThreadId, channelCap.supportsPinConversation]);


  // Close mute dropdown on outside click
  useEffect(() => {
    if (!muteDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (muteRef.current && !muteRef.current.contains(e.target as Node)) setMuteDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [muteDropdownOpen]);

  const isMuted = activeAccountId && activeThreadId ? isMutedFn(activeAccountId, activeThreadId) : false;

  const handleTogglePin = async () => {
    if (!channelCap.supportsPinConversation) return;
    const auth = getAuth();
    if (!auth || !activeThreadId) return;
    try {
      await ipc.zalo?.setPinConversation({
        auth,
        conversations: [{ threadId: activeThreadId, type: 1 }],
        isPin: !isPinned,
      });
      setIsPinned(!isPinned);
      showNotification(isPinned ? 'Đã bỏ ghim hội thoại' : 'Đã ghim hội thoại', 'success');
    } catch (e: any) {
      showNotification(extractApiError(e, 'Ghim hội thoại thất bại'), 'error');
    }
  };

  const handleMuteWithTime = (until: number) => {
    if (!activeAccountId || !activeThreadId) return;
    setMuted(activeAccountId, activeThreadId, until);
    showNotification('Đã tắt thông báo', 'success');
    setMuteDropdownOpen(false);
    // Gọi API đồng bộ lên Zalo (fire-and-forget) — chỉ khi kênh hỗ trợ
    if (channelCap.supportsMuteSync) {
      const auth = getAuth();
      if (auth) {
        const duration = muteUntilToDuration(until);
        ipc.zalo?.setMute({ auth, threadId: activeThreadId, threadType: 1, duration, action: 1 }).catch(() => {});
      }
    }
  };

  const handleUnmute = () => {
    if (!activeAccountId || !activeThreadId) return;
    clearMuted(activeAccountId, activeThreadId);
    showNotification('Đã bật thông báo', 'success');
    // Gọi API đồng bộ lên Zalo (fire-and-forget) — chỉ khi kênh hỗ trợ
    if (channelCap.supportsMuteSync) {
      const auth = getAuth();
      if (auth) {
        ipc.zalo?.setMute({ auth, threadId: activeThreadId, threadType: 1, action: 3 }).catch(() => {});
      }
    }
  };

  // Load group info on mount / thread change
  // Chỉ đọc từ cache (DB đã được ChatWindow load sẵn khi click hội thoại)
  // KHÔNG tự gọi API — fetchGroupInfo chỉ chạy khi user bấm nút refresh thủ công
  useEffect(() => {
    if (!activeThreadId || !activeAccountId) return;

    setPanelView('info');
    setAddMemberOpen(false);
    setLocalGroupInfo(null);

    // Đọc cache ngay lập tức
    const { groupInfoCache: cache } = useAppStore.getState();
    const cached = (cache[activeAccountId] || {})[activeThreadId];
    if (cached?.members?.length) {
      setLocalGroupInfo(cached);
      return;
    }

    // Nếu chưa có trong cache, poll ngắn để chờ ChatWindow load DB xong (không gọi API)
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const { groupInfoCache: c } = useAppStore.getState();
      const fresh = (c[activeAccountId] || {})[activeThreadId];
      if (fresh?.members?.length) {
        setLocalGroupInfo(fresh);
        clearInterval(poll);
        return;
      }
      if (attempts >= 5) clearInterval(poll); // dừng sau ~1s, không gọi API
    }, 200);

    return () => clearInterval(poll);
  }, [activeThreadId, activeAccountId]);

  // Sync localGroupInfo từ cache khi ChatWindow populate xong
  // (GroupInfoPanel có thể đang hiển thị trong khi ChatWindow async load từ DB)
  const { groupInfoCache } = useAppStore();
  useEffect(() => {
    if (!activeThreadId || !activeAccountId) return;
    const cached = (groupInfoCache[activeAccountId] || {})[activeThreadId];
    if (cached?.members?.length) {
      setLocalGroupInfo(prev => {
        // Chỉ update nếu cache mới hơn dữ liệu hiện tại
        if (!prev || (cached.fetchedAt || 0) >= (prev.fetchedAt || 0)) return cached;
        return prev;
      });
    }
  }, [groupInfoCache, activeThreadId, activeAccountId]);

  const fetchGroupInfo = async () => {
    if (!activeThreadId || !activeAccountId) return;
    // FB groups: don't call Zalo API
    if (isFBChannel) return;
    // Guard: verify thread still belongs to current account at fetch time
    const currentContacts = useChatStore.getState().contacts[activeAccountId] || [];
    if (currentContacts.length > 0 && !currentContacts.some(c => c.contact_id === activeThreadId)) return;
    const auth = getAuth();
    if (!auth) return;

    // Capture to avoid stale closure in async callbacks
    const threadId = activeThreadId;
    const accountId = activeAccountId;

    setLoading(true);
    try {
      console.log('[GroupInfoPanel] fetchGroupInfo start, groupId=', threadId);

      // ── Step 1: getGroupInfo → name / avatar / member list ───────────────
      const res = await ipc.zalo?.getGroupInfo({ auth, groupId: threadId });
      if (res?.success === false) {
        showNotification('Không thể tải thông tin nhóm: ' + (res?.error || 'Lỗi không xác định'), 'error');
        return;
      }

      const gridMap = res?.response?.gridInfoMap || res?.response?.changed_groups || {};
      const gData: any = gridMap[threadId] || (Object.values(gridMap)[0] as any);
      if (!gData) {
        showNotification('Không lấy được thông tin nhóm, vui lòng thử lại', 'error');
        return;
      }

      const name: string     = gData.name || gData.nameChanged || displayName;
      const avatar: string   = gData.avt  || gData.fullAvt     || avatarUrl;
      const creatorId: string  = (gData.creatorId || gData.creator || '').replace(/_0$/, '');
      const adminIds: string[] = (gData.adminIds || gData.subAdmins || []).map((a: string) => a.replace(/_0$/, ''));
      const adminSet = new Set([creatorId, ...adminIds]);

      // Update contact display name / avatar immediately
      useChatStore.getState().updateContact(accountId, {
        contact_id: threadId, display_name: name, avatar_url: avatar, contact_type: 'group',
      });

      // Parse member IDs (same multi-source logic as before)
      const parseMemVerList = (list: string[]): string[] =>
        list.map(entry => {
          const lastUnder = entry.lastIndexOf('_');
          if (lastUnder <= 0) return entry;
          const possibleVer = entry.substring(lastUnder + 1);
          if (/^\d+$/.test(possibleVer) && possibleVer.length < entry.substring(0, lastUnder).length)
            return entry.substring(0, lastUnder);
          return entry;
        }).filter(Boolean);

      const currentMemMap = new Map<string, any>();
      for (const cm of (gData.currentMems || [])) {
        const id = String(cm?.id || '').replace(/_0$/, '').trim();
        if (id) currentMemMap.set(id, cm);
      }
      const memVerIds = parseMemVerList(gData.memVerList || []);
      const rawIds: string[] =
        gData.memberIds?.length > 0  ? gData.memberIds :
        currentMemMap.size > 0        ? Array.from(currentMemMap.keys()) :
        memVerIds;

      const memberIds: string[] = [...new Set(
        rawIds.map(id => String(id).replace(/_0$/, '').trim()).filter(id => /^\d+$/.test(id))
      )];
      console.log('[GroupInfoPanel] memberIds:', memberIds.length, 'first3:', memberIds.slice(0, 3));

      // Build placeholders: empty displayName → forces full enrichment via syncZaloGroups
      const placeholders: MemberPlaceholder[] = memberIds.map(memberId => {
        let role = 0;
        if (memberId === creatorId) role = 2;
        else if (adminSet.has(memberId)) role = 1;
        return { memberId, displayName: '', avatar: '', role };
      });

      // Set initial cache with partial names from currentMems for immediate display
      const contactMap = new Map((useChatStore.getState().contacts[accountId] || []).map(c => [c.contact_id, c]));
      const initialInfo: CachedGroupInfo = {
        groupId: threadId, name, avatar,
        memberCount: gData.totalMember || memberIds.length,
        members: memberIds.map(id => {
          const cm = currentMemMap.get(id);
          const c  = contactMap.get(id);
          return {
            userId: id,
            displayName: cm?.dName || cm?.zaloName || c?.display_name || '',
            avatar: cm?.avatar || c?.avatar_url || '',
            role: id === creatorId ? 2 : adminSet.has(id) ? 1 : 0,
          };
        }),
        creatorId, adminIds,
        settings: gData.setting,
        fetchedAt: Date.now(),
      };
      setLocalGroupInfo(initialInfo);
      setGroupInfo(accountId, threadId, initialInfo);

      if (memberIds.length === 0) return;

      // Helper: reload enriched members from DB into cache
      const reloadFromDB = async () => {
        const dbRes = await ipc.db?.getGroupMembers({ zaloId: accountId, groupId: threadId });
        const rows: any[] = (dbRes?.members ?? []).filter((m: any) => /^\d+$/.test(m.member_id?.trim() ?? ''));
        if (rows.length === 0) return;
        const membersForCache: GroupMember[] = rows.map((m: any) => ({
          userId: m.member_id,
          displayName: m.display_name || '',
          avatar: m.avatar || '',
          role: m.role ?? 0,
        }));
        const existing = useAppStore.getState().groupInfoCache?.[accountId]?.[threadId];
        const updated: CachedGroupInfo = {
          ...(existing || initialInfo),
          members: membersForCache,
          memberCount: Math.max(existing?.memberCount || 0, membersForCache.length, gData.totalMember || 0),
          fetchedAt: Date.now(),
        };
        setLocalGroupInfo(updated);
        setGroupInfo(accountId, threadId, updated);
      };

      // ── Step 2: syncZaloGroups (single-group) enriches members ───────────
      // Passes pre-parsed memberIds + placeholders → _syncSingleGroup skips
      // the internal getGroupInfo call (no duplicate API request).
      await syncZaloGroups({
        activeAccountId: accountId,
        auth,
        groupId: threadId,
        memberIds,
        placeholders,
        // Phase 1: empty placeholders saved to DB — keep initialInfo in cache
        // to avoid showing a blank member list during enrichment.
        onPhase1Done: async () => { /* intentionally no cache update here */ },
        // Phase 2 complete: enriched data in DB → refresh cache
        onGroupEnriched: reloadFromDB,
      });

    } catch (e: any) {
      console.error('[GroupInfoPanel] fetchGroupInfo error:', e?.message);
      showNotification('Không thể tải thông tin nhóm', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Load pending count for admins whenever groupInfo is refreshed
  useEffect(() => {
    if (!groupInfo || !activeThreadId || !activeAccountId) return;
    if (!canManage(getMyRole(groupInfo, activeAccountId))) return;
    const auth = getAuth();
    if (!auth) return;
    fetchPendingMembers(auth, activeThreadId, activeAccountId)
      .then((data) => setPendingCount(data.length))
      .catch(() => {});
  }, [groupInfo, activeThreadId, activeAccountId]);

  if (!activeThreadId) return null;

  const contactList2 = activeAccountId ? (contacts[activeAccountId] || []) : [];

  if (panelView === 'members') {
    return (
      <>
        <MembersPanel
          groupInfo={groupInfo}
          groupId={activeThreadId}
          onBack={() => setPanelView('info')}
          onRefresh={fetchGroupInfo}
          myAccountId={activeAccountId || ''}
          onShowProfile={(userId, x, y) => setUserProfilePopup({ userId, x, y })}
        />
        {userProfilePopup && (
          <UserProfilePopup
            userId={userProfilePopup.userId}
            anchorX={userProfilePopup.x}
            anchorY={userProfilePopup.y}
            contacts={contactList2}
            activeAccountId={activeAccountId || ''}
            activeThreadId={activeThreadId}
            onClose={() => setUserProfilePopup(null)}
          />
        )}
      </>
    );
  }

  if (panelView === 'manage') {
    return (
      <ManagePanel
        groupInfo={groupInfo}
        groupId={activeThreadId}
        onBack={() => setPanelView('info')}
        myAccountId={activeAccountId || ''}
      />
    );
  }

  if (panelView === 'media') {
    return (
      <MediaDetailPanel
        threadId={activeThreadId}
        activeAccountId={activeAccountId || ''}
        tab={mediaTab}
        onBack={() => setPanelView('info')}
      />
    );
  }

  if (panelView === 'pending') {
    return (
      <PendingPanel
        groupId={activeThreadId}
        myAccountId={activeAccountId || ''}
        onBack={() => setPanelView('info')}
        onCountChange={setPendingCount}
      />
    );
  }



  // ─── Main info view ───────────────────────────────────────────────────────
  return (
    <div className="w-72 h-full flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-y-auto">
      {/* Header — with refresh button */}
      <div className="flex items-center px-4 py-3 border-b border-gray-700">
        <span className="flex-1 text-sm font-semibold text-white text-center">Thông tin nhóm</span>
        <button
          title="Cập nhật thông tin nhóm"
          onClick={fetchGroupInfo}
          disabled={loading}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-gray-700 text-gray-400 hover:text-white disabled:opacity-50 flex-shrink-0"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      {/* Group avatar + name */}
      <div className="flex flex-col items-center py-5 px-4 border-b border-gray-700">
        <div className={`relative ${!isFBChannel ? 'group cursor-pointer' : ''}`}
          onClick={!isFBChannel ? handleChangeAvatar : undefined}
          title={!isFBChannel ? 'Đổi ảnh nhóm' : undefined}>
          <GroupAvatar avatarUrl={groupInfo?.avatar || avatarUrl} groupInfo={groupInfo} name={displayName} size="lg" />
          {!isFBChannel && (
          <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
          </div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <p className="text-white font-semibold text-base text-center">{groupInfo?.name || displayName}</p>
          {channelCap.supportsGroupRename && (
          <button onClick={() => startRenameGroup()} title="Đổi tên nhóm"
            className="text-gray-400 hover:text-white transition-colors flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          )}
        </div>
        {groupInfo && groupInfo.memberCount > 0 && (
          <p className="mt-1 text-gray-500 text-xs">{groupInfo.memberCount} thành viên</p>
        )}
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-4 gap-1 px-3 py-3 border-b border-gray-700">
        {/* Mute with dropdown */}
        <div className="relative" ref={muteRef}>
          <GrpActionBtn
            icon={isMuted ? '🔔' : '🔕'}
            label={isMuted ? 'Bật thông báo' : 'Tắt thông báo'}
            onClick={isMuted ? handleUnmute : () => {
              if (muteRef.current) {
                const rect = muteRef.current.getBoundingClientRect();
                setMuteDropdownPos({ top: rect.bottom + 4, left: Math.max(4, rect.left - 60) });
              }
              setMuteDropdownOpen(p => !p);
            }}
            active={isMuted}
          />
          {muteDropdownOpen && !isMuted && muteDropdownPos && (
            <div className="fixed z-50 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl min-w-[210px] py-1"
              style={{ top: muteDropdownPos.top, left: muteDropdownPos.left }}>
              {MUTE_OPTIONS.map(opt => (
                <button key={opt.label} onClick={() => handleMuteWithTime(opt.until())}
                  className="w-full flex items-center px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left transition-colors">
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {channelCap.supportsPinConversation && (
          <GrpActionBtn icon={isPinned ? '📌' : '📍'} label={isPinned ? 'Bỏ ghim' : 'Ghim hội thoại'} onClick={handleTogglePin} active={isPinned} />
        )}
        <GrpActionBtn icon="👥" label="Thêm thành viên" onClick={() => setAddMemberOpen(true)} />
        {!isFBChannel && (
          <GrpActionBtn icon="⚙️" label="Quản lý nhóm" onClick={() => setPanelView('manage')} />
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-4">
          <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
        </div>
      )}

      {/* Member list section — chỉ hiển thị số lượng, click để xem chi tiết */}
      {groupInfo && (
        <button
          onClick={() => setPanelView('members')}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-gray-700 hover:bg-gray-700/40 transition-colors group"
        >
          <div className="flex items-center gap-2 text-sm text-gray-200">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
            </svg>
            <span>{groupInfo.memberCount || groupInfo.members?.length || 0} thành viên</span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 group-hover:text-gray-300 transition-colors">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      )}

      {/* Chờ duyệt vào nhóm — chỉ hiển thị với admin/owner và kênh Zalo */}
      {!isFBChannel && groupInfo && canManage(getMyRole(groupInfo, activeAccountId)) && (
        <button
          onClick={() => setPanelView('pending')}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-gray-700 hover:bg-gray-700/40 transition-colors group"
        >
          <div className="flex items-center gap-2 text-sm text-gray-200">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-400">
              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
            <span>Chờ duyệt vào nhóm</span>
            {pendingCount != null && pendingCount > 0 && (
              <span className="text-[11px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded-full font-semibold">
                {pendingCount}
              </span>
            )}
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 group-hover:text-gray-300 transition-colors">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      )}

      {/* Bảng tin nhóm — only for channels that support it */}
      {channelCap.supportsGroupBoard && (
      <button
          onClick={() => useAppStore.getState().setShowGroupBoard(true)}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-gray-700 hover:bg-gray-700/40 transition-colors group"
      >
        <div className="flex items-center gap-2 text-sm text-gray-200">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <span>Bảng tin nhóm</span>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 group-hover:text-gray-300 transition-colors">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
      )}

      {/* Media tabs */}
      <MediaSection
        threadId={activeThreadId}
        onOpenDetail={(t) => { setMediaTab(t); setPanelView('media'); }}
      />

      {/* Actions: báo xấu, xoá lịch sử, rời nhóm */}
      <GroupActionSection
        groupId={activeThreadId}
        groupName={groupInfo?.name || displayName}
        isOwner={getMyRole(groupInfo, activeAccountId) === 1}
        channelCap={channelCap}
        onLeft={() => {
          if (activeAccountId) {
            useChatStore.getState().removeContact(activeAccountId, activeThreadId);
            useChatStore.getState().setActiveThread(null);
          }
        }}
      />

      {/* Add member modal */}
      {addMemberOpen && (
        <AddMemberToGroupModal
          groupId={activeThreadId}
          groupName={groupInfo?.name || displayName}
          existingMemberIds={groupInfo?.members?.map(m => m.userId) || []}
          onClose={() => setAddMemberOpen(false)}
          onAdded={fetchGroupInfo}
        />
      )}

      {/* User profile popup */}
      {userProfilePopup && (
        <UserProfilePopup
          userId={userProfilePopup.userId}
          anchorX={userProfilePopup.x}
          anchorY={userProfilePopup.y}
          contacts={contactList}
          activeAccountId={activeAccountId || ''}
          activeThreadId={activeThreadId}
          onClose={() => setUserProfilePopup(null)}
        />
      )}
    </div>
  );

  function handleChangeAvatar() {
    if (isFBChannel) return; // FB uses different mechanism
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !activeThreadId) return;
      const auth = getAuth();
      if (!auth) return;
      const filePath = (file as any).path || '';
      if (!filePath) { showNotification('Không đọc được đường dẫn file', 'error'); return; }
      try {
        const res = await ipc.zalo?.changeGroupAvatar({ auth, avatarPath: filePath, groupId: activeThreadId });
        if (res?.success) { showNotification('Đã đổi ảnh nhóm', 'success'); fetchGroupInfo(); }
        else showNotification(extractApiError(res, 'Đổi ảnh nhóm thất bại'), 'error');
      } catch (e: any) { showNotification(extractApiError(e, 'Đổi ảnh nhóm thất bại'), 'error'); }
    };
    input.click();
  }

  function startRenameGroup() {
    if (!channelCap.supportsGroupRename) return;
    const newName = window.prompt('Tên nhóm mới:', groupInfo?.name || displayName);
    if (!newName?.trim() || !activeThreadId) return;
    const auth = getAuth();
    if (!auth) return;
    ipc.zalo?.changeGroupName({ auth, name: newName.trim(), groupId: activeThreadId })
      .then((res: any) => {
        if (res?.success) {
          showNotification('Đã đổi tên nhóm', 'success');
          setLocalGroupInfo(prev => prev ? { ...prev, name: newName.trim() } : prev);
          if (activeAccountId) {
            useChatStore.getState().updateContact(activeAccountId, { contact_id: activeThreadId, display_name: newName.trim() });
          }
        } else showNotification(extractApiError(res, 'Đổi tên nhóm thất bại'), 'error');
      }).catch((e: any) => showNotification(extractApiError(e, 'Đổi tên nhóm thất bại'), 'error'));
  }

}



// ─── GrpActionBtn ─────────────────────────────────────────────────────────────
function GrpActionBtn({ icon, label, onClick, active }: { icon: string; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick}
      className={`flex flex-col items-center gap-1 py-2 px-1 rounded-xl hover:bg-gray-700 transition-colors text-center`}>
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${active ? 'bg-blue-600' : 'bg-gray-700'}`}>{icon}</div>
      <span className={`text-[9px] leading-tight ${active ? 'text-blue-400' : 'text-gray-400'}`}>{label}</span>
    </button>
  );
}


// ─── MembersPanel ─────────────────────────────────────────────────────────────
function MembersPanel({ groupInfo, groupId, onBack, onRefresh, myAccountId, onShowProfile }: {
  groupInfo: CachedGroupInfo | null;
  groupId: string;
  onBack: () => void;
  onRefresh: () => void;
  myAccountId: string;
  onShowProfile?: (userId: string, x: number, y: number) => void;
}) {
  const { getActiveAccount } = useAccountStore();
  const { showNotification } = useAppStore();
  const [search, setSearch] = useState('');
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [ctxMember, setCtxMember] = useState<GroupMember | null>(null);
  const [ctxPos, setCtxPos] = useState<{ top: number; left: number } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  const myRole = getMyRole(groupInfo, myAccountId);
  const isAdmin = canManage(myRole);

  useEffect(() => {
    if (!ctxMember) return;
    const h = (e: MouseEvent) => { if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMember(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ctxMember]);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  const filtered = (groupInfo?.members || []).filter(m =>
    !search || (m.displayName || m.userId).toLowerCase().includes(search.toLowerCase())
  );
  const sorted = [...filtered].sort((a, b) => b.role - a.role);

  const handleRemoveMember = async (member: GroupMember) => {
    const ok = await showConfirm({
      title: `Xóa ${member.displayName || member.userId} khỏi nhóm?`,
      message: 'Thành viên sẽ bị xóa khỏi nhóm này.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    try {
      const res = await ipc.zalo?.removeUserFromGroup({ auth, userId: member.userId, groupId });
      if (res?.success) { showNotification('Đã xóa thành viên', 'success'); onRefresh(); }
      else showNotification(extractApiError(res, 'Xóa thành viên thất bại'), 'error');
    } catch (e: any) { showNotification(extractApiError(e, 'Xóa thành viên thất bại'), 'error'); }
    setCtxMember(null);
  };

  const handleMakeDeputy = async (member: GroupMember) => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const isDeputy = member.role === 2;
      const res = isDeputy
        ? await ipc.zalo?.removeGroupDeputy({ auth, userId: member.userId, groupId })
        : await ipc.zalo?.addGroupDeputy({ auth, userId: member.userId, groupId });
      if (res?.success) { showNotification(isDeputy ? 'Đã xóa phó nhóm' : 'Đã thêm phó nhóm', 'success'); onRefresh(); }
      else showNotification(extractApiError(res, 'Thao tác thất bại'), 'error');
    } catch (e: any) { showNotification(extractApiError(e, 'Thao tác thất bại'), 'error'); }
    setCtxMember(null);
  };

  const handleBlockMember = async (member: GroupMember) => {
    const ok = await showConfirm({
      title: `Chặn ${member.displayName || member.userId} khỏi nhóm?`,
      message: 'Thành viên sẽ bị chặn và không thể tham gia nhóm này.',
      confirmText: 'Chặn',
      variant: 'danger',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    try {
      const res = await ipc.zalo?.addGroupBlockedMember({ auth, userId: member.userId, groupId });
      if (res?.success) { showNotification('Đã chặn thành viên', 'success'); onRefresh(); }
      else showNotification(extractApiError(res, 'Chặn thành viên thất bại'), 'error');
    } catch (e: any) { showNotification(extractApiError(e, 'Chặn thành viên thất bại'), 'error'); }
    setCtxMember(null);
  };

  const handleLeaveGroup = async () => {
    const ok = await showConfirm({
      title: 'Rời khỏi nhóm này?',
      message: 'Bạn sẽ rời khỏi nhóm và không nhận tin nhắn mới.',
      confirmText: 'Rời nhóm',
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    try {
      const res = await ipc.zalo?.leaveGroup({ auth, groupId });
      if (res?.success) { showNotification('Đã rời khỏi nhóm', 'success'); onBack(); }
      else showNotification(extractApiError(res, 'Rời nhóm thất bại'), 'error');
    } catch (e: any) { showNotification(extractApiError(e, 'Rời nhóm thất bại'), 'error'); }
  };

  return (
    <div className="w-72 h-full flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-700">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="text-sm font-semibold text-white flex-1 text-center pr-6">Thành viên</span>
      </div>

      {/* Add member — all users can add */}
      <button onClick={() => setAddMemberOpen(true)}
        className="mx-3 my-2 flex items-center justify-center gap-2 py-2 rounded-xl bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
        </svg>
        Thêm thành viên
      </button>

      <div className="px-3 pb-2">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Tìm thành viên..."
          className="w-full bg-gray-700 border border-gray-600 rounded-full px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
      </div>

      <div className="px-4 pb-1">
        <span className="text-xs text-gray-400 font-medium">Danh sách thành viên ({groupInfo?.memberCount || sorted.length})</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.map(m => (
          <div key={m.userId} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors group">
            {/* Avatar — clickable */}
            <button
              onClick={(e) => onShowProfile?.(m.userId, e.clientX, e.clientY)}
              className="flex-shrink-0 focus:outline-none hover:opacity-80 transition-opacity"
            >
              {m.avatar ? (
                <img src={m.avatar} alt="" className="w-9 h-9 rounded-full object-cover" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold">
                  {(m.displayName || '?').charAt(0).toUpperCase()}
                </div>
              )}
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-200 truncate">{m.displayName || m.userId}</p>
              <div className="flex items-center gap-1">
                {m.role === 1 && <span className="text-[11px] bg-yellow-600/30 text-yellow-400 px-1.5 rounded">Trưởng nhóm</span>}
                {m.role === 2 && <span className="text-[11px] bg-blue-600/30 text-blue-400 px-1.5 rounded">Phó nhóm</span>}
              </div>
            </div>
            {/* Context menu — admin only, not for group owner */}
            {isAdmin && m.role !== 1 && m.userId !== myAccountId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setCtxPos({ top: rect.top, left: rect.left - 196 });
                  setCtxMember(m);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-gray-600 text-gray-400 hover:text-white transition-all">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
                </svg>
              </button>
            )}
          </div>
        ))}
        {sorted.length === 0 && <p className="text-xs text-gray-500 text-center py-8">Không có thành viên</p>}
      </div>

      {/* Context menu for admin actions */}
      {ctxMember && (
        <div ref={ctxRef}
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl py-1 min-w-[180px]"
          style={{ top: ctxPos?.top ?? 200, left: Math.max(4, ctxPos?.left ?? 200) }}>
          <div className="px-3 py-2 border-b border-gray-700">
            <p className="text-sm text-white font-medium">{ctxMember.displayName || ctxMember.userId}</p>
          </div>
          <button onClick={() => { onShowProfile?.(ctxMember.userId, (ctxPos?.left ?? 0) + 200, ctxPos?.top ?? 0); setCtxMember(null); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left">
            👤 Xem thông tin
          </button>
          <button onClick={() => handleMakeDeputy(ctxMember)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left">
            {ctxMember.role === 2 ? '⬇️ Xóa phó nhóm' : '⬆️ Đặt làm phó nhóm'}
          </button>
          <button onClick={() => handleBlockMember(ctxMember)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-orange-400 hover:bg-gray-700 text-left">
            🚫 Chặn khỏi nhóm
          </button>
          <button onClick={() => handleRemoveMember(ctxMember)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-900/30 text-left">
            🗑 Xóa khỏi nhóm
          </button>
          <button onClick={() => setCtxMember(null)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:bg-gray-700 text-left">
            ✕ Đóng
          </button>
        </div>
      )}

      {addMemberOpen && (
        <AddMemberToGroupModal
          groupId={groupId}
          groupName={groupInfo?.name || groupId}
          existingMemberIds={groupInfo?.members?.map(m => m.userId) || []}
          onClose={() => setAddMemberOpen(false)}
          onAdded={onRefresh}
        />
      )}
    </div>
  );
}

// ─── PendingPanel ────────────────────────────────────────────────────────────
function PendingPanel({ groupId, myAccountId, onBack, onCountChange }: {
  groupId: string;
  myAccountId: string;
  onBack: () => void;
  onCountChange: (count: number | null) => void;
}) {
  const { getActiveAccount } = useAccountStore();
  const { showNotification } = useAppStore();
  const [pending, setPending] = useState<PendingMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [approvingAll, setApprovingAll] = useState(false);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  useEffect(() => { loadPending(); }, [groupId]);

  const loadPending = async (force = false) => {
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      const members = await fetchPendingMembers(auth, groupId, myAccountId, force);
      setPending(members);
      onCountChange(members.length);
    } catch (e: any) {
      showNotification('Không thể tải danh sách chờ duyệt: ' + (e?.message || ''), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleReview = async (userId: string, accept: boolean) => {
    const auth = getAuth();
    if (!auth) return;
    setProcessing(prev => new Set(prev).add(userId));
    try {
      const res = await ipc.zalo?.reviewPendingMemberRequest({
        auth,
        groupId,
        payload: { memberId: userId, isAccept: accept },
      });
      if (res?.success !== false) {
        showNotification(accept ? 'Đã phê duyệt thành viên' : 'Đã từ chối thành viên', 'success');
        setPending(prev => {
          const next = prev.filter(m => m.userId !== userId);
          onCountChange(next.length);
          return next;
        });
        invalidatePendingCache(myAccountId, groupId);
      } else {
        showNotification(extractApiError(res, 'Thao tác thất bại'), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, 'Thao tác thất bại'), 'error');
    } finally {
      setProcessing(prev => { const s = new Set(prev); s.delete(userId); return s; });
    }
  };

  const handleApproveAll = async () => {
    const ok = await showConfirm({
      title: `Phê duyệt tất cả ${pending.length} người?`,
      message: 'Tất cả thành viên đang chờ sẽ được phê duyệt vào nhóm.',
      confirmText: 'Phê duyệt tất cả',
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setApprovingAll(true);
    let successCount = 0;
    const snapshot = [...pending];
    for (const member of snapshot) {
      try {
        const res = await ipc.zalo?.reviewPendingMemberRequest({
          auth, groupId,
          payload: { memberId: member.userId, isAccept: true },
        });
        if (res?.success !== false) {
          successCount++;
          setPending(prev => prev.filter(m => m.userId !== member.userId));
        }
      } catch {}
    }
    invalidatePendingCache(myAccountId, groupId);
    onCountChange(0);
    showNotification(`Đã phê duyệt ${successCount}/${snapshot.length} thành viên`, 'success');
    setApprovingAll(false);
  };

  return (
    <div className="w-72 h-full flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-700 flex-shrink-0">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="text-sm font-semibold text-white flex-1 text-center">Chờ duyệt vào nhóm</span>
        <button onClick={() => loadPending(true)} disabled={loading || approvingAll}
          title="Tải lại"
          className="p-1 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-40">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-400">
          <svg className="animate-spin w-8 h-8 text-yellow-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <p className="text-sm">Đang tải danh sách...</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && pending.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="w-16 h-16 rounded-full bg-gray-700/60 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-400">
              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-300">Không có yêu cầu nào</p>
            <p className="text-xs text-gray-500 mt-1">Chưa có ai đang chờ được phê duyệt</p>
          </div>
        </div>
      )}

      {/* List */}
      {!loading && pending.length > 0 && (
        <>
          {/* Stats + approve-all */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700/60 flex-shrink-0 bg-gray-800/80">
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400 text-[11px] font-bold flex items-center justify-center">
                {pending.length}
              </span>
              <span className="text-xs text-gray-400">người đang chờ duyệt</span>
            </div>
            <button
              onClick={handleApproveAll}
              disabled={approvingAll}
              className="flex items-center gap-1.5 text-xs font-medium text-green-400 hover:text-green-300 bg-green-500/10 hover:bg-green-500/20 px-2.5 py-1 rounded-full border border-green-500/20 transition-all disabled:opacity-40">
              {approvingAll ? (
                <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
              Duyệt tất cả
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2 space-y-1 px-2">
            {pending.map(member => (
              <div key={member.userId}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-gray-700/50 transition-colors group">
                {/* Avatar */}
                <div className="relative flex-shrink-0 w-10 h-10">
                  {member.avatar ? (
                    <img
                      src={member.avatar}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover"
                      onError={(e) => {
                        const img = e.target as HTMLImageElement;
                        img.style.display = 'none';
                        const fallback = img.parentElement?.querySelector('.avatar-fallback') as HTMLElement;
                        if (fallback) fallback.style.display = 'flex';
                      }}
                    />
                  ) : null}
                  <div
                    className="avatar-fallback w-10 h-10 rounded-full bg-gradient-to-br from-yellow-500 to-orange-500 items-center justify-center text-white text-sm font-bold absolute inset-0"
                    style={{ display: member.avatar ? 'none' : 'flex' }}>
                    {(member.displayName || '?').charAt(0).toUpperCase()}
                  </div>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-100 truncate leading-tight">{member.displayName}</p>
                  <p className="text-[11px] text-gray-500 truncate font-mono mt-0.5">{member.userId}</p>
                </div>

                {/* Action buttons */}
                <div className="flex gap-1.5 flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleReview(member.userId, true)}
                    disabled={processing.has(member.userId) || approvingAll}
                    title="Phê duyệt"
                    className="w-8 h-8 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/25 text-green-400 hover:text-green-300 flex items-center justify-center transition-all disabled:opacity-40">
                    {processing.has(member.userId) ? (
                      <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => handleReview(member.userId, false)}
                    disabled={processing.has(member.userId) || approvingAll}
                    title="Từ chối"
                    className="w-8 h-8 rounded-lg bg-red-500/15 hover:bg-red-500/30 border border-red-500/25 text-red-400 hover:text-red-300 flex items-center justify-center transition-all disabled:opacity-40">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── PendingMembersSection ────────────────────────────────────────────────────
function PendingMembersSection({ groupId, isAdmin }: { groupId: string; isAdmin: boolean }) {
  const { getActiveAccount } = useAccountStore();
  const { showNotification } = useAppStore();
  const [pending, setPending] = useState<Array<{ userId: string; displayName: string; avatar: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [approvingAll, setApprovingAll] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  const loadPending = async () => {
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      const res = await ipc.zalo?.getPendingGroupMembers({ auth, groupId });
      const rawList: any[] = res?.response?.memberIds
        || res?.response?.pendingMembers
        || res?.response?.members
        || (Array.isArray(res?.response) ? res.response : []);

      const uids: string[] = rawList.map((item: any) =>
        typeof item === 'string' ? item : (item.id || item.userId || item.uid || String(item))
      ).filter(Boolean);

      if (uids.length === 0) { setPending([]); setLoading(false); return; }

      const profiles: Array<{ userId: string; displayName: string; avatar: string }> = [];
      await Promise.all(uids.map(async (uid) => {
        try {
          const info = await ipc.zalo?.getUserInfo({ auth, userId: uid });
          const p = info?.response?.user || info?.response || {};
          profiles.push({
            userId: uid,
            displayName: p.display || p.displayName || p.zaloName || p.name || uid,
            avatar: p.avatar || p.avt || '',
          });
        } catch {
          profiles.push({ userId: uid, displayName: uid, avatar: '' });
        }
      }));
      setPending(profiles);
    } catch (e: any) {
      showNotification('Không thể tải danh sách chờ duyệt: ' + (e?.message || ''), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && isAdmin) loadPending();
  }, [expanded, groupId]);

  const handleReview = async (userId: string, accept: boolean) => {
    const auth = getAuth();
    if (!auth) return;
    setProcessing(prev => new Set(prev).add(userId));
    try {
      const res = await ipc.zalo?.reviewPendingMemberRequest({
        auth, groupId,
        payload: { memberId: userId, isAccept: accept },
      });
      if (res?.success !== false) {
        showNotification(accept ? 'Đã phê duyệt thành viên' : 'Đã từ chối thành viên', 'success');
        setPending(prev => prev.filter(m => m.userId !== userId));
      } else {
        showNotification(extractApiError(res, 'Thao tác thất bại'), 'error');
      }
    } catch (e: any) {
      showNotification(extractApiError(e, 'Thao tác thất bại'), 'error');
    } finally {
      setProcessing(prev => { const s = new Set(prev); s.delete(userId); return s; });
    }
  };

  const handleApproveAll = async () => {
    const ok = await showConfirm({
      title: `Phê duyệt tất cả ${pending.length} người?`,
      message: 'Tất cả thành viên đang chờ sẽ được phê duyệt vào nhóm.',
      confirmText: 'Phê duyệt tất cả',
      variant: 'warning',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    setApprovingAll(true);
    let successCount = 0;
    const snapshot = [...pending];
    for (const member of snapshot) {
      try {
        const res = await ipc.zalo?.reviewPendingMemberRequest({
          auth, groupId,
          payload: { memberId: member.userId, isAccept: true },
        });
        if (res?.success !== false) {
          successCount++;
          setPending(prev => prev.filter(m => m.userId !== member.userId));
        }
      } catch {}
    }
    showNotification(`Đã phê duyệt ${successCount}/${snapshot.length} thành viên`, 'success');
    setApprovingAll(false);
  };

  if (!isAdmin) return null;

  return (
    <div className="border-t border-gray-700">
      {/* Toggle header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-700/40 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-gray-200">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-400">
            <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="22" y1="11" x2="16" y2="11"/>
          </svg>
          <span>Danh sách chờ duyệt</span>
          {pending.length > 0 && (
            <span className="text-[11px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded-full font-semibold">
              {pending.length}
            </span>
          )}
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {expanded && (
        <div className="pb-3">
          {/* Sub-header: count + reload + approve-all */}
          <div className="flex items-center justify-between px-4 py-1.5 mb-1">
            <span className="text-xs text-gray-500">{pending.length} người đang chờ</span>
            <div className="flex items-center gap-2">
              {pending.length > 0 && (
                <button onClick={handleApproveAll} disabled={approvingAll || loading}
                  className="flex items-center gap-1 text-xs font-medium text-green-400 hover:text-green-300 disabled:opacity-40 transition-colors">
                  {approvingAll ? (
                    <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                  Duyệt tất cả
                </button>
              )}
              <button onClick={loadPending} disabled={loading || approvingAll}
                className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors">
                {loading ? (
                  <svg className="animate-spin w-3 h-3 inline" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                ) : '↻ Tải lại'}
              </button>
            </div>
          </div>

          {loading && pending.length === 0 && (
            <div className="flex justify-center py-6">
              <svg className="animate-spin w-5 h-5 text-yellow-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            </div>
          )}

          {!loading && pending.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <div className="w-10 h-10 rounded-full bg-gray-700/60 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-500">
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
                </svg>
              </div>
              <p className="text-xs text-gray-500">Không có ai đang chờ duyệt</p>
            </div>
          )}

          <div className="space-y-0.5 px-2">
            {pending.map(member => (
              <div key={member.userId}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 hover:bg-gray-700/50 transition-colors group">
                {/* Avatar */}
                <div className="relative flex-shrink-0 w-9 h-9">
                  {member.avatar ? (
                    <img src={member.avatar} alt="" className="w-9 h-9 rounded-full object-cover"
                      onError={(e) => {
                        const img = e.target as HTMLImageElement;
                        img.style.display = 'none';
                        const fb = img.parentElement?.querySelector('.pm-fallback') as HTMLElement;
                        if (fb) fb.style.display = 'flex';
                      }} />
                  ) : null}
                  <div className="pm-fallback w-9 h-9 rounded-full bg-gradient-to-br from-yellow-500 to-orange-500 items-center justify-center text-white text-xs font-bold absolute inset-0"
                    style={{ display: member.avatar ? 'none' : 'flex' }}>
                    {(member.displayName || '?').charAt(0).toUpperCase()}
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate leading-tight">{member.displayName}</p>
                  <p className="text-[11px] text-gray-500 font-mono truncate">{member.userId}</p>
                </div>

                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleReview(member.userId, true)}
                    disabled={processing.has(member.userId) || approvingAll}
                    title="Phê duyệt"
                    className="w-7 h-7 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/20 text-green-400 flex items-center justify-center transition-all disabled:opacity-40">
                    {processing.has(member.userId) ? (
                      <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => handleReview(member.userId, false)}
                    disabled={processing.has(member.userId) || approvingAll}
                    title="Từ chối"
                    className="w-7 h-7 rounded-lg bg-red-500/15 hover:bg-red-500/30 border border-red-500/20 text-red-400 flex items-center justify-center transition-all disabled:opacity-40">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ManagePanel ──────────────────────────────────────────────────────────────
export function ManagePanel({ groupInfo, groupId, onBack, myAccountId, asModal }: {
  groupInfo: CachedGroupInfo | null;
  groupId: string;
  onBack: () => void;
  myAccountId: string;
  asModal?: boolean;
}) {
  const { getActiveAccount, activeAccountId } = useAccountStore();
  const { showNotification } = useAppStore();
  const [settings, setSettings] = useState<Record<string, any>>(groupInfo?.settings || {});
  const [groupLink, setGroupLink] = useState<string>('');
  const [loadingLink, setLoadingLink] = useState(false);

  const myRole = getMyRole(groupInfo, myAccountId);
  const isAdmin = canManage(myRole);
  const isOwner = myRole === 1;

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  /** Extract link from various API response shapes */
  const extractLink = (res: any): string =>
    res?.response?.data?.link
    || res?.response?.link
    || res?.response?.data?.info?.group_link
    || res?.response?.info?.group_link
    || '';

  // Auto-load group link on mount
  useEffect(() => {
    const auth = getAuth();
    if (!auth || !groupId) return;
    setLoadingLink(true);
    ipc.zalo?.getGroupLinkDetail({ auth, groupId })
      .then((res: any) => {
        const link = extractLink(res);
        if (link) setGroupLink(link);
      })
      .catch(() => {})
      .finally(() => setLoadingLink(false));
  }, [groupId]);

  // Listen for new_link event to update link in real-time
  useEffect(() => {
    const unsub = ipc.on('event:groupEvent', (data: any) => {
      if (data.groupId !== groupId || data.eventType !== 'new_link') return;
      const d = data.data?.data || data.data || {};
      const link = d.link || d.inviteLink || d.groupLink || d.linkJoin || d.info?.group_link || '';
      if (link) setGroupLink(link);
    });
    return () => unsub();
  }, [groupId]);

  useEffect(() => {
    if (groupInfo?.settings) setSettings(groupInfo.settings);
  }, [groupInfo]);

  const handleToggleSetting = async (key: string, current: any) => {
    const auth = getAuth();
    if (!auth) return;
    const newVal = current ? 0 : 1;
    const oldSettings = { ...settings };           // snapshot BEFORE toggle for EventBroadcaster seed
    const newSettings = { ...settings, [key]: newVal };
    setSettings(newSettings);
    try {
      const res = await ipc.zalo?.updateGroupSettings({
        auth,
        settings: JSON.stringify(newSettings),
        groupId,
        oldSettings: JSON.stringify(oldSettings),  // seed cache so update_setting event can show text
      });
      if (!res?.success) {
        setSettings(oldSettings); // revert
        showNotification('Lỗi cập nhật cài đặt', 'error');
      }
    } catch { setSettings(oldSettings); }
  };

  const handleGetGroupLink = async () => {
    const auth = getAuth();
    if (!auth) return;
    setLoadingLink(true);
    try {
      const res = await ipc.zalo?.getGroupLinkDetail({ auth, groupId });
      const link = extractLink(res);
      if (link) { setGroupLink(link); }
      else {
        // Enable link first
        const enRes = await ipc.zalo?.enableGroupLink({ auth, groupId });
        const newLink = extractLink(enRes);
        setGroupLink(newLink || 'Không lấy được link');
      }
    } catch (e: any) { showNotification(extractApiError(e, 'Lấy link nhóm thất bại'), 'error'); }
    finally { setLoadingLink(false); }
  };

  const handleDisable = async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      await ipc.zalo?.disableGroupLink({ auth, groupId });
      setGroupLink('');
      showNotification('Đã tắt link nhóm', 'success');
    } catch {}
  };

  const handleDisperseGroup = async () => {
    const ok = await showConfirm({
      title: 'Giải tán nhóm này?',
      message: 'Hành động này không thể hoàn tác. Toàn bộ thành viên sẽ bị xóa khỏi nhóm.',
      confirmText: 'Giải tán',
      variant: 'danger',
    });
    if (!ok) return;
    const auth = getAuth();
    if (!auth) return;
    try {
      const res = await ipc.zalo?.disperseGroup({ auth, groupId });
      if (res?.success) {
        showNotification('Đã giải tán nhóm', 'success');
        if (activeAccountId) {
          const chatState = useChatStore.getState();
          chatState.removeContact(activeAccountId, groupId);
          chatState.setActiveThread(null);
        }
        onBack();
      } else {
        showNotification(extractApiError(res, 'Giải tán nhóm thất bại'), 'error');
      }
    } catch (e: any) { showNotification(extractApiError(e, 'Giải tán nhóm thất bại'), 'error'); }
  };

  const SETTINGS_LIST = [
    { key: 'blockName',       label: 'Thay đổi tên & ảnh đại diện của nhóm',                   inverted: true  },
    { key: 'setTopicOnly',    label: 'Ghim tin nhắn, ghi chú, bình chọn lên đầu hội thoại',    inverted: true  },
    { key: 'lockCreatePost',  label: 'Tạo mới ghi chú, nhắc hẹn',                              inverted: true  },
    { key: 'lockCreatePoll',  label: 'Tạo mới bình chọn',                                      inverted: true  },
    { key: 'lockSendMsg',     label: 'Gửi tin nhắn',                                           inverted: true  },
  ];

  return (
    <div className={asModal ? 'flex flex-col w-full h-full overflow-y-auto' : 'w-72 h-full flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-y-auto'}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-700">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="text-sm font-semibold text-white flex-1 text-center pr-6">Quản lý nhóm</span>
      </div>

      {/* Member permissions */}
      <div className="px-4 py-3">
        {!isAdmin && (
          <p className="text-xs text-orange-400 mb-2 flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Bạn không có quyền thay đổi cài đặt nhóm
          </p>
        )}
        <p className="text-xs text-gray-400 mb-3 font-medium">Cho phép các thành viên trong nhóm:</p>
        <div className="space-y-3">
          {SETTINGS_LIST.map(s => {
            const val = settings[s.key];
            const isOn = s.inverted ? !val : !!val;
            return (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className={`text-sm flex-1 leading-tight ${isAdmin ? 'text-gray-300' : 'text-gray-500'}`}>{s.label}</span>
                <button
                  onClick={() => isAdmin && handleToggleSetting(s.key, val)}
                  disabled={!isAdmin}
                  className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} ${isOn ? 'bg-blue-600' : 'bg-gray-600'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${isOn ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-gray-700 px-4 py-3 space-y-2">
        <p className="text-xs text-gray-400 font-medium mb-2">Chế độ phê duyệt thành viên mới</p>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${isAdmin ? 'text-gray-300' : 'text-gray-500'}`}>Bật phê duyệt</span>
          <button
            onClick={() => isAdmin && handleToggleSetting('joinAppr', settings.joinAppr)}
            disabled={!isAdmin}
            className={`relative w-10 h-5 rounded-full transition-colors ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''} ${settings.joinAppr ? 'bg-blue-600' : 'bg-gray-600'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.joinAppr ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${isAdmin ? 'text-gray-300' : 'text-gray-500'}`}>Đánh dấu tin nhắn từ trưởng/phó nhóm</span>
          <button
            onClick={() => isAdmin && handleToggleSetting('signAdminMsg', settings.signAdminMsg)}
            disabled={!isAdmin}
            className={`relative w-10 h-5 rounded-full transition-colors ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''} ${settings.signAdminMsg ? 'bg-blue-600' : 'bg-gray-600'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.signAdminMsg ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${isAdmin ? 'text-gray-300' : 'text-gray-500'}`}>Cho phép thành viên mới đọc tin nhắn gần nhất</span>
          <button
            onClick={() => isAdmin && handleToggleSetting('enableMsgHistory', settings.enableMsgHistory)}
            disabled={!isAdmin}
            className={`relative w-10 h-5 rounded-full transition-colors ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''} ${settings.enableMsgHistory ? 'bg-blue-600' : 'bg-gray-600'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.enableMsgHistory ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      {/* Danh sách chờ duyệt — visible for admin khi bật joinAppr */}
      <PendingMembersSection groupId={groupId} isAdmin={isAdmin} />

      {/* Group link */}
      <div className="border-t border-gray-700 px-4 py-3 space-y-2">
        <p className="text-xs text-gray-400 font-medium">Link tham gia nhóm</p>
        {groupLink ? (
          <div className="flex items-center gap-2">
            <input value={groupLink} readOnly className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-gray-300 truncate" />
            <button onClick={() => { navigator.clipboard.writeText(groupLink); showNotification('Đã sao chép link', 'success'); }}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded-lg">Sao chép</button>
            <button onClick={handleDisable} className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded-lg">Tắt</button>
          </div>
        ) : (
          <button onClick={handleGetGroupLink} disabled={loadingLink}
            className="w-full py-2 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 flex items-center justify-center gap-2">
            {loadingLink ? (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
              </svg>
            )}
            Cho phép dùng link tham gia nhóm
          </button>
        )}
      </div>

      {/* Danger zone — owner only */}
      {isOwner && (
        <div className="border-t border-gray-700 px-4 py-3 mt-auto space-y-2">
          <button
            onClick={() => setPanelViewBlocked()}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <line x1="20" y1="8" x2="14" y2="14"/>
            </svg>
            Chặn khỏi nhóm
          </button>
          <button
            onClick={handleDisperseGroup}
            className="w-full py-2.5 rounded-xl bg-red-900/30 hover:bg-red-900/50 text-sm text-red-400 font-medium border border-red-800/50 transition-colors">
            Giải tán nhóm
          </button>
        </div>
      )}
    </div>
  );

  function setPanelViewBlocked() {
    showNotification('Chức năng xem danh sách bị chặn', 'info');
  }
}


