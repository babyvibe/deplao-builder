import React, { useEffect, useState, useCallback, useRef } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useCRMStore } from '@/store/crmStore';
import PhoneDisplay from '@/components/common/PhoneDisplay';
import GroupAvatar from '@/components/common/GroupAvatar';
import CampaignCreateModal from '@/components/crm/campaigns/CampaignCreateModal';
import AddToContactsModal from '@/components/crm/contacts/AddToContactsModal';
import { syncZaloGroups, MemberPlaceholder, SyncGroupsProgress } from '@/lib/zaloGroupUtils';
import { AlertIcon, CheckIcon, SearchIcon } from '@/components/common/icons';

interface ZaloGroup {
  contact_id: string;
  display_name: string;
  avatar_url: string;
  last_message_time: number;
  memberCount: number;
}

interface GroupMember {
  member_id: string;
  display_name: string;
  avatar: string;
  role: number;
  updated_at: number;
  phone?: string;
}

function roleLabel(role: number) {
  if (role === 2) return { text: 'Trưởng nhóm', cls: 'text-yellow-400' };
  if (role === 1) return { text: 'Phó nhóm', cls: 'text-blue-400' };
  return { text: 'Thành viên', cls: 'text-gray-400' };
}

function Avatar({ src, name, size = 36 }: { src?: string; name: string; size?: number }) {
  const [err, setErr] = useState(false);
  const initials = (name || '?').charAt(0).toUpperCase();
  if (src && !err) {
    return (
      <img src={src} alt={name} style={{ width: size, height: size }}
        className="rounded-full object-cover flex-shrink-0"
        onError={() => setErr(true)} />
    );
  }
  return (
    <div style={{ width: size, height: size, fontSize: size * 0.38 }}
      className="rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold flex-shrink-0">
      {initials}
    </div>
  );
}

function EmptyState({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-5 py-8 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-3 opacity-70">{icon}</div>
      <p className="text-sm text-gray-300 font-medium mb-1">{title}</p>
      <div className="text-xs text-gray-400 leading-relaxed max-w-xs">{desc}</div>
    </div>
  );
}

const GroupIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-400">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

const RefreshIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.97"/>
  </svg>
);
const SpinIcon = (
  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

export default function GroupMembersTab() {
  const { activeAccountId } = useAccountStore();
  const { setGroupCount } = useCRMStore();
  const groupInfoCache = useAppStore(s => s.groupInfoCache);

  const [groups, setGroups] = useState<ZaloGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersLastFetched, setMembersLastFetched] = useState(0);
  const [searchGroup, setSearchGroup] = useState('');
  const [searchMember, setSearchMember] = useState('');

  // ── Progress state ────────────────────────────────────────────────────────
  /** Phase 1: syncing groups from API | Phase 2: enriching member details */
  type GroupFetchProgress =
    | { phase: 'groups'; current: number; total: number }
    | { phase: 'members'; groupCurrent: number; groupTotal: number; memberCurrent: number; memberTotal: number; currentGroupName: string };
  const [groupFetchProgress, setGroupFetchProgress] = useState<GroupFetchProgress | null>(null);
  /** Progress bar shown while auto-fetching member details via getUserInfo (single group) */
  const [manualLoadProgress, setManualLoadProgress] = useState<{ current: number; total: number } | null>(null);
  const manualLoadStopRef = useRef(false);
  /** Stop ref for Phase 2 bulk member enrichment inside fetchGroupsFromAPI */
  const bulkEnrichStopRef = useRef(false);

  // ── Selection state ───────────────────────────────────────────────────────
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  // ── Campaign picker state ─────────────────────────────────────────────────
  const [showCampaignPicker, setShowCampaignPicker] = useState(false);
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [localCampaigns, setLocalCampaigns] = useState<any[]>([]);
  const [pickedCampaignId, setPickedCampaignId] = useState<number | null>(null);
  const [addingToCampaign, setAddingToCampaign] = useState(false);

  // ── Add to contacts modal state ─────────────────────────────────────────
  const [showAddToContacts, setShowAddToContacts] = useState(false);

  // ── Tab state ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'members' | 'scan'>('members');

  // ── Scan tab state ────────────────────────────────────────────────────
  const [scanLinkInput, setScanLinkInput] = useState('');
  const [scanTabLoading, setScanTabLoading] = useState(false);
  const [scanTabError, setScanTabError] = useState('');
  const [scanTabResults, setScanTabResults] = useState<Array<{ userId: string; displayName: string; avatar: string }>>([]);
  const [scanTabGroupId, setScanTabGroupId] = useState<string | null>(null);
  const [scanJoinLoading, setScanJoinLoading] = useState(false);
  const [scanJoinMsg, setScanJoinMsg] = useState('');
  const [scanJoinType, setScanJoinType] = useState<'idle' | 'success' | 'pending' | 'already' | 'error'>('idle');

  // ── Premium state ────────────────────────────────────────────────────
  const [premiumLoaded, setPremiumLoaded] = useState(false);
  const [premiumLoading, setPremiumLoading] = useState(false);
  const [isPremium, setIsPremium] = useState(false);
  const [premiumExpiresAt, setPremiumExpiresAt] = useState<string | null>(null);

  // ── Red dot: "mới" badge cho tab Quét thành viên ─────────────────────
  const [scanTabSeen, setScanTabSeen] = useState(() => {
    try { return localStorage.getItem('scanTabSeen') === 'true'; } catch { return false; }
  });

  // ── Groups 3-dot menu ─────────────────────────────────────────────────────
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showGroupMenu) return;
    const handler = (e: MouseEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) setShowGroupMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showGroupMenu]);

  // ── Link scan state ───────────────────────────────────────────────────────
  const [showLinkScanModal, setShowLinkScanModal] = useState(false);
  const [linkScanInput, setLinkScanInput] = useState('');
  const [linkScanLoading, setLinkScanLoading] = useState(false);
  const [linkScanProgress, setLinkScanProgress] = useState<{ current: number; total: number } | null>(null);
  const [linkScanError, setLinkScanError] = useState('');
  const [linkScanResult, setLinkScanResult] = useState<{ groupId: string; name: string } | null>(null);
  const linkScanStopRef = useRef(false);
  const [linkJoinLoading, setLinkJoinLoading] = useState(false);
  const [linkJoinStatus, setLinkJoinStatus] = useState<'idle' | 'success' | 'pending' | 'already' | 'error'>('idle');
  const [linkJoinMsg, setLinkJoinMsg] = useState('');

  const selectedGroup = groups.find(g => g.contact_id === selectedGroupId) ?? null;

  // ── Load groups from contacts (contact_type='group') ──────────────────────
  const loadGroupsFromDB = useCallback(async () => {
    if (!activeAccountId) return;
    const convRes = await DataAccessor.getConversations(activeAccountId, 999, 0);
    const allContacts: any[] = convRes?.items || [];
    const groupContacts = (allContacts || []).filter((c: any) => c.contact_type === 'group');

    const allMembersRes = await DataAccessor.getAllGroupMembers(activeAccountId);
    const memberRows = allMembersRes?.rows ?? [];
    const countMap: Record<string, number> = {};
    for (const row of memberRows) countMap[row.group_id] = (countMap[row.group_id] || 0) + 1;

    const mapped = groupContacts.map((c: any) => ({
      contact_id: c.contact_id,
      display_name: c.display_name || c.contact_id,
      avatar_url: c.avatar_url || '',
      last_message_time: c.last_message_time || 0,
      memberCount: countMap[c.contact_id] ?? 0,
    }));
    setGroups(mapped);
    setGroupCount(mapped.length);
  }, [activeAccountId, setGroupCount]);

  // ── Load members from page_group_member ───────────────────────────────────
  const loadMembersFromDB = useCallback(async (groupId: string) => {
    if (!activeAccountId) return;
    const res = await DataAccessor.getGroupMembers({ zaloId: activeAccountId, groupId });
    // Filter out non-numeric garbage IDs (e.g. "profiles", "unchangeds_profile") from old bad parses
    const rows = (res?.members ?? []).filter((m: any) => {
      const id = m.member_id?.trim();
      return id && /^\d+$/.test(id);
    });

    // Merge phone numbers from contacts table
    const convRes = await DataAccessor.getConversations(activeAccountId, 999, 0);
    const allContacts: any[] = convRes?.items || [];
    const phoneMap: Record<string, string> = {};
    for (const c of allContacts) {
      if (c.contact_id && c.phone) phoneMap[c.contact_id] = c.phone;
    }
    const merged: GroupMember[] = rows.map((m: any) => ({ ...m, phone: phoneMap[m.member_id] || '' }));

    setMembers(merged);
    setMembersLastFetched(merged.length > 0 ? Math.max(...merged.map((m: any) => m.updated_at || 0)) : 0);
  }, [activeAccountId]);

  // ── Fetch groups from API - delegates to syncZaloGroups (full-sync mode) ──
  const fetchGroupsFromAPI = useCallback(async () => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const auth = buildZaloAuth(acc, activeAccountId);

    setGroupsLoading(true);
    bulkEnrichStopRef.current = false;
    try {
      await syncZaloGroups({
        activeAccountId,
        auth,
        onProgress: (p: SyncGroupsProgress) => {
          if (p.phase === 'groups') {
            setGroupFetchProgress({ phase: 'groups', current: p.current, total: p.total });
          } else {
            setGroupFetchProgress({
              phase: 'members',
              groupCurrent: p.groupCurrent ?? 1,
              groupTotal: p.groupTotal ?? 1,
              memberCurrent: p.current,
              memberTotal: p.total,
              currentGroupName: p.currentGroupName ?? '',
            });
          }
        },
        onPhase1Done: async () => { await loadGroupsFromDB(); },
        onGroupEnriched: async () => { await loadGroupsFromDB(); },
        stopRef: bulkEnrichStopRef,
      });
      await loadGroupsFromDB();
    } finally {
      setGroupsLoading(false);
      setGroupFetchProgress(null);
      bulkEnrichStopRef.current = false;
    }
  }, [activeAccountId, loadGroupsFromDB]);

  // ── Fetch members - delegates to syncZaloGroups (single-group mode) ───────
  const fetchMembersFromAPI = useCallback(async () => {
    if (!activeAccountId || !selectedGroupId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const auth = buildZaloAuth(acc, activeAccountId);

    setMembersLoading(true);
    manualLoadStopRef.current = false;
    setManualLoadProgress(null);

    try {
      await syncZaloGroups({
        activeAccountId,
        auth,
        groupId: selectedGroupId,   // ← single-group mode, skips getAllGroups
        onProgress: (p: SyncGroupsProgress) => {
          if (p.phase === 'members') {
            setMembersLoading(false); // transition: spinner → progress bar
            setManualLoadProgress({ current: p.current, total: p.total });
          }
        },
        onPhase1Done: async () => {
          // Placeholders saved → show UIDs in list immediately
          await loadMembersFromDB(selectedGroupId);
        },
        onGroupEnriched: async () => {
          setManualLoadProgress(null);
          manualLoadStopRef.current = false;
          await loadMembersFromDB(selectedGroupId);
          await loadGroupsFromDB();
        },
        stopRef: manualLoadStopRef,
      });
    } finally {
      setMembersLoading(false);
      setManualLoadProgress(null);
      manualLoadStopRef.current = false;
    }
  }, [activeAccountId, selectedGroupId, loadMembersFromDB, loadGroupsFromDB]);

  // ── Scan group by invite link ─────────────────────────────────────────────
  const scanGroupByLink = useCallback(async () => {
    if (!activeAccountId || !linkScanInput.trim()) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const auth = buildZaloAuth(acc, activeAccountId);

    setLinkScanLoading(true);
    setLinkScanError('');
    setLinkScanResult(null);
    setLinkScanProgress(null);
    linkScanStopRef.current = false;

    try {
      // ── Step 1: getGroupLinkInfo - phân trang đến khi hết (hasMoreMember = 0) ──
      let groupId = '';
      let name = '';
      let avatar = '';
      let creatorId = '';
      let adminIds: string[] = [];
      const currentMems: any[] = [];
      let page = 1;

      while (true) {
        if (linkScanStopRef.current) break;
        const res = await ipc.zalo?.getGroupLinkInfo({ auth, link: linkScanInput.trim(), memberPage: page });
        if (!res?.success) {
          setLinkScanError(res?.error || 'Không thể lấy thông tin nhóm. Kiểm tra lại đường dẫn.');
          return;
        }
        const data = res.response;
        if (page === 1) {
          groupId   = data.groupId || '';
          name      = data.name || data.groupId || '';
          avatar    = data.fullAvt || data.avt || '';
          creatorId = (data.creatorId || '').replace(/_0$/, '');
          adminIds  = (data.adminIds || []).map((a: string) => a.replace(/_0$/, ''));
        }
        const pageMems: any[] = data.currentMems || [];
        currentMems.push(...pageMems);

        if (!data.hasMoreMember) break;
        page++;
        // polite delay between pages to avoid rate limit
        await new Promise(r => setTimeout(r, 300));
      }

      if (!groupId) {
        setLinkScanError('Không tìm thấy thông tin nhóm từ link này.');
        return;
      }

      // ── Step 2: Save group contact to DB ─────────────────────────────────
      await DataAccessor.updateContactProfile({
        zaloId: activeAccountId, contactId: groupId,
        displayName: name, avatarUrl: avatar, phone: '', contactType: 'group',
      });

      // ── Step 3: Build + save initial member list ──────────────────────────
      const adminSet = new Set([creatorId, ...adminIds]);
      const memberIds: string[] = [];
      const memInfoMap: Record<string, { displayName: string; avatar: string; role: number }> = {};

      for (const mem of currentMems) {
        const memberId = String(mem.id || '').replace(/_0$/, '').trim();
        if (!memberId || !/^\d+$/.test(memberId)) continue;
        memberIds.push(memberId);
        let role = 0;
        if (memberId === creatorId) role = 2;
        else if (adminSet.has(memberId)) role = 1;
        memInfoMap[memberId] = { displayName: mem.dName || mem.zaloName || '', avatar: mem.avatar || mem.avatar_25 || '', role };
      }

      if (memberIds.length > 0) {
        const initMembers = memberIds.map(id => ({
          memberId: id,
          displayName: memInfoMap[id]?.displayName || '',
          avatar: memInfoMap[id]?.avatar || '',
          role: memInfoMap[id]?.role || 0,
        }));
        await DataAccessor.saveGroupMembers({ zaloId: activeAccountId, groupId, members: initMembers });
      }

      setLinkScanResult({ groupId, name });

      // ── Step 4: Batch getUserInfo for full profile + phone ────────────────
      if (memberIds.length > 0) {
        setLinkScanProgress({ current: 0, total: memberIds.length });
        const BATCH = 200;
        for (let j = 0; j < memberIds.length; j += BATCH) {
          if (linkScanStopRef.current) break;
          const batch = memberIds.slice(j, j + BATCH);
          try {
            const uRes = await ipc.zalo?.getUserInfo({ auth, userId: batch });
            if (uRes?.success && uRes.response) {
              const changedProfiles: Record<string, any> = uRes.response.changed_profiles ?? {};
              const updates: any[] = [];
              const contactSaves: Promise<any>[] = [];
              for (const memberId of batch) {
                const profile = changedProfiles[memberId] ?? changedProfiles[`${memberId}_0`] ?? null;
                if (profile) {
                  const displayName = profile.displayName || profile.zaloName || '';
                  const av = profile.avatar || '';
                  const phone: string = profile.msisdn || profile.phoneNumber || profile.phone || '';
                  updates.push({ memberId, displayName, avatar: av, role: memInfoMap[memberId]?.role ?? 0 });
                  if (phone) {
                    contactSaves.push(
                      DataAccessor.updateContactProfile({
                        zaloId: activeAccountId, contactId: memberId,
                        displayName, avatarUrl: av, phone, contactType: 'friend',
                      }) ?? Promise.resolve()
                    );
                  }
                }
              }
              if (updates.length > 0) await DataAccessor.saveGroupMembers({ zaloId: activeAccountId, groupId, members: updates });
              if (contactSaves.length > 0) await Promise.all(contactSaves);
            }
          } catch (err) {
            console.warn('[GroupMembersTab] scanGroupByLink getUserInfo batch error:', err);
          }
          setLinkScanProgress({ current: Math.min(j + BATCH, memberIds.length), total: memberIds.length });
          if (!linkScanStopRef.current && j + BATCH < memberIds.length) await new Promise(r => setTimeout(r, 200));
        }
        setLinkScanProgress(null);
      }

      // Reload group list and auto-select the scanned group
      await loadGroupsFromDB();
      setSelectedGroupId(groupId);
      await loadMembersFromDB(groupId);
    } catch (err: any) {
      setLinkScanError(err.message || 'Đã xảy ra lỗi không xác định');
    } finally {
      setLinkScanLoading(false);
      setLinkScanProgress(null);
      linkScanStopRef.current = false;
    }
  }, [activeAccountId, linkScanInput, loadGroupsFromDB, loadMembersFromDB]);

  // ── Join group via link ───────────────────────────────────────────────────
  const joinGroupByLink = useCallback(async () => {
    if (!activeAccountId || !linkScanInput.trim()) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const auth = buildZaloAuth(acc, activeAccountId);

    setLinkJoinLoading(true);
    setLinkJoinStatus('idle');
    setLinkJoinMsg('');
    try {
      const res = await ipc.zalo?.joinGroupLink({ auth, link: linkScanInput.trim() });
      // error code 178 = already member, 240 = pending approval
      const errCode = res?.errorCode ?? res?.error_code ?? (res?.response?.error);
      if (errCode === 178 || res?.response?.msg?.includes('already')) {
        setLinkJoinStatus('already');
        setLinkJoinMsg('Bạn đã là thành viên của nhóm này.');
      } else if (errCode === 240 || res?.response?.msg?.includes('pending') || res?.response?.msg?.includes('approval')) {
        setLinkJoinStatus('pending');
        setLinkJoinMsg('Nhóm bật chế độ duyệt thành viên. Yêu cầu của bạn đã được gửi, chờ admin duyệt.');
      } else if (!res?.success && errCode) {
        setLinkJoinStatus('error');
        setLinkJoinMsg(res?.error || `Lỗi (${errCode}): Không thể tham gia nhóm.`);
      } else {
        setLinkJoinStatus('success');
        setLinkJoinMsg('Đã tham gia nhóm thành công!');
        // Refresh group list to show new group
        await loadGroupsFromDB();
      }
    } catch (err: any) {
      setLinkJoinStatus('error');
      setLinkJoinMsg(err?.message || 'Lỗi không xác định khi tham gia nhóm.');
    } finally {
      setLinkJoinLoading(false);
    }
  }, [activeAccountId, linkScanInput, loadGroupsFromDB]);

  // ── Scan from "Quét thành viên" tab (gọi backend API) ──────────────
  const handleScanTab = useCallback(async () => {
    if (!activeAccountId || !scanLinkInput.trim()) return;

    // Kiểm tra premium trước khi quét
    if (!isPremium) {
      setScanTabError('Cần kích hoạt gói Premium để sử dụng tính năng này. Bấm nút mua gói hoặc liên hệ @babyvibe trên Telegram.');
      return;
    }

    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) { setScanTabError('Không tìm thấy tài khoản'); return; }
    const auth = buildZaloAuth(acc, activeAccountId);

    setScanTabLoading(true);
    setScanTabError('');
    setScanTabResults([]);
    setScanTabGroupId(null);
    try {
      let groupId = scanLinkInput.trim();

      // Nếu là link zalo.me → gọi getGroupLinkInfo để lấy groupId
      if (groupId.includes('zalo.me') || groupId.includes('chat.zalo.me')) {
        const linkRes: any = await ipc.zalo?.getGroupLinkInfo({ auth, link: groupId, memberPage: 1 });
        if (!linkRes?.success || !linkRes?.response?.groupId) {
          setScanTabError(linkRes?.error || 'Không lấy được thông tin nhóm từ link. Kiểm tra lại đường dẫn.');
          return;
        }
        groupId = linkRes.response.groupId;
      }

      // Validate groupId
      if (!/^\d+$/.test(groupId)) {
        setScanTabError('Group ID không hợp lệ. Nhập link nhóm hoặc Group ID dạng số.');
        return;
      }

      // Gọi backend API quét thành viên
      const { scanGroupViaBackend } = await import('@/lib/backendService');
      const result = await scanGroupViaBackend({
        pageId: activeAccountId,
        cookie: acc.cookies,
        imei: acc.imei,
        groupId,
      });

      if (!result?.success) {
        setScanTabError(result?.error || 'Quét thất bại');
        return;
      }

      const members = result.members || [];
      if (members.length === 0) {
        setScanTabError('Không tìm thấy thành viên nào trong nhóm.');
        return;
      }

      setScanTabResults(members);
      setScanTabGroupId(groupId);

      // Lưu vào DB
      await DataAccessor.saveGroupMembers({
        zaloId: activeAccountId,
        groupId,
        members: members.map((m: any) => ({
          memberId: m.userId || m.id,
          displayName: m.displayName || m.zaloName || m.userId || m.id,
          avatar: m.avatar || '',
          role: 0,
        })),
      });

      // Reload members tab
      await loadMembersFromDB(groupId);
    } catch (err: any) {
      setScanTabError(err?.message || 'Lỗi không xác định');
    } finally {
      setScanTabLoading(false);
    }
  }, [activeAccountId, scanLinkInput, loadMembersFromDB]);

  // ── Join group from scan tab ──────────────────────────────────────────
  const handleJoinFromScanTab = useCallback(async () => {
    if (!activeAccountId || !scanLinkInput.trim()) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const auth = buildZaloAuth(acc, activeAccountId);

    setScanJoinLoading(true);
    setScanJoinType('idle');
    setScanJoinMsg('');
    try {
      const res = await ipc.zalo?.joinGroupLink({ auth, link: scanLinkInput.trim() });
      const errCode = res?.errorCode ?? res?.error_code ?? (res?.response?.error);
      if (errCode === 178 || res?.response?.msg?.includes('already')) {
        setScanJoinType('already');
        setScanJoinMsg('Bạn đã là thành viên của nhóm này.');
      } else if (errCode === 240 || res?.response?.msg?.includes('pending') || res?.response?.msg?.includes('approval')) {
        setScanJoinType('pending');
        setScanJoinMsg('Nhóm bật chế độ duyệt thành viên. Yêu cầu đã được gửi, chờ admin duyệt. Bạn có thể quét thành viên nhóm được rồi!');
      } else if (!res?.success && errCode) {
        setScanJoinType('error');
        setScanJoinMsg(res?.error || `Lỗi (${errCode}): Không thể tham gia nhóm.`);
      } else {
        setScanJoinType('success');
        setScanJoinMsg('Đã tham gia nhóm thành công!');
        await loadGroupsFromDB();
      }
    } catch (err: any) {
      setScanJoinType('error');
      setScanJoinMsg(err?.message || 'Lỗi không xác định');
    } finally {
      setScanJoinLoading(false);
    }
  }, [activeAccountId, scanLinkInput, loadGroupsFromDB]);

  // ── Load premium status ───────────────────────────────────────────────
  // Lần đầu (không có localStorage): gọi backend → lưu localStorage
  // Các lần sau: đọc localStorage, chỉ gọi backend khi user ấn nút cấp nhật
  const loadPremiumStatus = useCallback(async (fromBackend = false) => {
    if (!activeAccountId) return;

    const storageKey = `premium_${activeAccountId}`;

    // Đọc từ localStorage trước
    let cached = false;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const data = JSON.parse(raw);
        const expiresDate = new Date(data.expiresAt);
        setIsPremium(expiresDate > new Date());
        setPremiumExpiresAt(data.expiresAt);
        cached = true;
      }
    } catch {}

    if (!cached) {
      setIsPremium(false);
      setPremiumExpiresAt(null);
    }
    setPremiumLoaded(true);

    // Nếu có cache rồi mà không phải manual reload → không gọi backend
    if (cached && !fromBackend) return;

    // Gọi backend (lần đầu hoặc manual reload)
    setPremiumLoading(true);
    try {
      const { getPremiumStatus } = await import('@/lib/backendService');
      const status = await getPremiumStatus(activeAccountId);

      setIsPremium(status.isPremium);
      setPremiumExpiresAt(status.expiresAt);

      // Lưu vào localStorage
      localStorage.setItem(storageKey, JSON.stringify({
        expiresAt: status.expiresAt,
        updatedAt: new Date().toISOString(),
      }));
    } catch (err) {
      console.error('[GroupMembersTab] loadPremiumStatus error:', err);
      // Lỗi → lưu ngày hôm qua để không gọi spam lại
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      setIsPremium(false);
      setPremiumExpiresAt(yesterday);
      localStorage.setItem(storageKey, JSON.stringify({
        expiresAt: yesterday,
        updatedAt: new Date().toISOString(),
      }));
    } finally {
      setPremiumLoading(false);
    }
  }, [activeAccountId]);

  const toggleMember = (id: string) => {
    setSelectedMemberIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAllMembers = () => setSelectedMemberIds(new Set(filteredMembers.map(m => m.member_id)));
  const clearSelection = () => setSelectedMemberIds(new Set());

  // ── Open campaign picker ──────────────────────────────────────────────────
  const openCampaignPicker = useCallback(async () => {
    if (!activeAccountId) return;
    const res = await DataAccessor.getCRMCampaigns({ zaloId: activeAccountId });
    if (res?.success) {
      const available = (res.campaigns || []).filter((c: any) => c.status !== 'done');
      setLocalCampaigns(available);
    }
    setPickedCampaignId(null);
    setShowCampaignPicker(true);
  }, [activeAccountId]);

  // ── Create new campaign from within picker ────────────────────────────────
  const handleCreateCampaignInPicker = useCallback(async (data: any) => {
    if (!activeAccountId) return;
    const res = await DataAccessor.saveCRMCampaign({ zaloId: activeAccountId, campaign: data });
    if (res?.success) {
      // Refresh local campaign list and auto-select the new one
      const res2 = await DataAccessor.getCRMCampaigns({ zaloId: activeAccountId });
      if (res2?.success) {
        const available = (res2.campaigns || []).filter((c: any) => c.status !== 'done');
        setLocalCampaigns(available);
        if (res.id) setPickedCampaignId(res.id);
      }
    }
  }, [activeAccountId]);

  // ── Add selected members to campaign ─────────────────────────────────────
  const handleAddToCampaign = useCallback(async () => {
    if (!activeAccountId || !pickedCampaignId || selectedMemberIds.size === 0) return;
    setAddingToCampaign(true);
    try {
      const contacts = members
        .filter(m => selectedMemberIds.has(m.member_id))
        .map(m => ({
          contactId: m.member_id,
          displayName: m.display_name || m.member_id,
          avatar: m.avatar || '',
        }));
      await DataAccessor.addCampaignContacts({ zaloId: activeAccountId, campaignId: pickedCampaignId, contacts });
      setShowCampaignPicker(false);
      setSelectedMemberIds(new Set());
      setPickedCampaignId(null);
    } finally {
      setAddingToCampaign(false);
    }
  }, [activeAccountId, pickedCampaignId, selectedMemberIds, members]);

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    setGroups([]); setMembers([]); setSelectedGroupId(null);
    setMembersLastFetched(0); setSelectedMemberIds(new Set());
    setManualLoadProgress(null);
    manualLoadStopRef.current = true;
    if (activeAccountId) loadGroupsFromDB();
  }, [activeAccountId]);

  useEffect(() => {
    setMembers([]); setMembersLastFetched(0); setSelectedMemberIds(new Set());
    setManualLoadProgress(null);
    manualLoadStopRef.current = true;
    if (selectedGroupId) loadMembersFromDB(selectedGroupId);
  }, [selectedGroupId]);

  // Load premium status when scan tab is opened (once per account)
  useEffect(() => {
    if (activeTab === 'scan' && activeAccountId && !premiumLoaded) {
      loadPremiumStatus();
    }
  }, [activeTab, activeAccountId, premiumLoaded, loadPremiumStatus]);

  // ── Filtered lists ────────────────────────────────────────────────────────
  const filteredGroups = groups.filter(g =>
    !searchGroup.trim() ||
    g.display_name.toLowerCase().includes(searchGroup.toLowerCase()) ||
    g.contact_id.includes(searchGroup)
  );
  const filteredMembers = members.filter(m =>
    !searchMember.trim() ||
    m.display_name.toLowerCase().includes(searchMember.toLowerCase()) ||
    m.member_id.includes(searchMember)
  );

  const allFilteredSelected = filteredMembers.length > 0 &&
    filteredMembers.every(m => selectedMemberIds.has(m.member_id));

  const formatTime = (ts: number) =>
    ts ? new Date(ts).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

  if (!activeAccountId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState icon={GroupIcon} title="Chưa chọn tài khoản" desc="Chọn tài khoản Zalo để xem thành viên nhóm" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden relative">

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center border-b border-gray-700 flex-shrink-0 bg-gray-900/50">
        <button
          onClick={() => setActiveTab('members')}
          className={`px-5 py-2.5 text-sm font-medium transition-colors relative
            ${activeTab === 'members'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-gray-200'}`}>
          Thành viên nhóm
        </button>
        <button
          onClick={() => {
            setActiveTab('scan');
            if (!scanTabSeen) {
              setScanTabSeen(true);
              try { localStorage.setItem('scanTabSeen', 'true'); } catch {}
            }
          }}
          className={`px-5 py-2.5 text-sm font-medium transition-colors relative flex items-center gap-1.5
            ${activeTab === 'scan'
              ? 'text-purple-400 border-b-2 border-purple-400'
              : 'text-gray-400 hover:text-gray-200'}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Quét thành viên
          <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-gradient-to-r from-yellow-600 to-orange-600 text-white-important rounded-full leading-none">Premium</span>
          {!scanTabSeen && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      {activeTab === 'scan' ? (
        /* ── Tab: Quét thành viên (Premium) ──────────────────────────────── */
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-6 py-6 space-y-5">

            {/* Header */}
            <div className="text-center pb-2">
              <h2 className="text-lg font-bold text-white">Quét thành viên nhóm ẩn</h2>
              <p className="text-sm text-gray-400 mt-1">Tiếp cận hàng nghìn khách hàng tiềm năng từ các nhóm Zalo chất lượng</p>
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-400"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>, title: 'Nhóm ẩn thành viên', desc: 'Bạn đã tham gia nhưng admin ẩn danh sách - quét vẫn lấy được hết' },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, title: 'Nhóm chờ duyệt', desc: 'Chưa được duyệt vào nhóm vẫn quét được thành viên - không cần chờ admin phê duyệt' },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>, title: 'Nhanh chóng', desc: '1000+ thành viên chỉ trong vài giây' },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-400"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>, title: 'Kết quả chi tiết', desc: 'Tên, ảnh đại diện, SĐT - thêm vào chiến dịch kết bạn, nhắn tin ngay' },
              ].map((f, i) => (
                <div key={i} className="bg-gray-800 border border-gray-700 rounded-xl p-3.5 flex gap-3">
                  <div className="w-9 h-9 rounded-lg bg-gray-700/50 flex items-center justify-center flex-shrink-0">{f.icon}</div>
                  <div>
                    <p className="text-xs font-semibold text-white">{f.title}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Scan input */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={scanLinkInput}
                  onChange={e => { setScanLinkInput(e.target.value); setScanTabError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter' && !scanTabLoading) handleScanTab(); }}
                  placeholder="Dán link nhóm Zalo (vd: https://zalo.me/g/xxxxxx)"
                  disabled={scanTabLoading}
                  className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
                />
                <button
                  onClick={handleJoinFromScanTab}
                  disabled={scanJoinLoading || !scanLinkInput.trim()}
                  className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 flex-shrink-0">
                  {scanJoinLoading ? <>{SpinIcon} Đang join...</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg> Tham gia</>}
                </button>
                <button
                  onClick={handleScanTab}
                  disabled={scanTabLoading || !scanLinkInput.trim()}
                  className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 flex-shrink-0">
                  {scanTabLoading ? (
                    <>{SpinIcon} Đang quét...</>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      </svg>
                      Quét
                    </>
                  )}
                </button>
              </div>
              <p className="text-[11px] text-gray-500">Kết quả sẽ lưu vào tab Thành viên nhóm để bạn sử dụng đầy đủ tính năng</p>
            </div>

            {/* Join status */}
            {scanJoinType !== 'idle' && (
              <div className={`px-4 py-3 rounded-xl text-xs border flex items-center gap-2 ${
                scanJoinType === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-400' :
                scanJoinType === 'pending' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' :
                scanJoinType === 'already' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' :
                'bg-red-500/10 border-red-500/30 text-red-400'
              }`}>
                {scanJoinMsg}
              </div>
            )}

            {/* Scan error */}
            {scanTabError && (
              <div className="px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400 flex items-center gap-2">
                <AlertIcon className="w-4 h-4 flex-shrink-0" /> {scanTabError}
              </div>
            )}

            {/* Scan results */}
            {scanTabResults.length > 0 && (
              <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">Đã quét xong</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      <span className="text-green-400 font-medium">{scanTabResults.length}</span> thành viên · Đã lưu vào tab Thành viên nhóm
                    </p>
                  </div>
                  <button
                    onClick={() => { setActiveTab('members'); setSelectedGroupId(scanTabGroupId); }}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors">
                    Xem trong tab Thành viên →
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto divide-y divide-gray-700/50">
                  {scanTabResults.slice(0, 50).map((m, i) => (
                    <div key={m.userId || i} className="flex items-center gap-3 px-4 py-2.5">
                      <Avatar src={m.avatar} name={m.displayName || m.userId} size={32} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{m.displayName || m.userId}</p>
                        <p className="text-[11px] text-gray-500">{m.userId}</p>
                      </div>
                    </div>
                  ))}
                  {scanTabResults.length > 50 && (
                    <div className="px-4 py-2 text-xs text-gray-500 text-center">
                      ... và {scanTabResults.length - 50} thành viên khác. Xem đầy đủ ở tab Thành viên nhóm.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Premium status */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${isPremium ? 'bg-green-400' : 'bg-gray-500'}`} />
                  <span className="text-sm text-white font-medium">Premium</span>
                  <button
                    onClick={() => loadPremiumStatus(true)}
                    disabled={premiumLoading}
                    className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1 ${
                      premiumLoading
                        ? 'bg-green-700 text-white'
                        : 'bg-green-600 hover:bg-green-700 text-white'
                    }`}>
                    {premiumLoading ? <>{SpinIcon} Đang cập nhật...</> : <>{RefreshIcon} Cập nhật</>}
                  </button>
                  {isPremium && premiumExpiresAt && (
                    <span className="text-xs text-gray-500">· Hết hạn: {new Date(premiumExpiresAt).toLocaleDateString('vi-VN')}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isPremium ? (
                    <span className="px-2 py-0.5 bg-green-500/15 text-green-400 text-[11px] font-medium rounded-full">Đang hoạt động</span>
                  ) : (
                    <span className="px-2 py-0.5 bg-gray-600/50 text-gray-400 text-[11px] font-medium rounded-full">Chưa kích hoạt</span>
                  )}
                </div>
              </div>
              {!isPremium && (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-bold text-white">265.000đ</span>
                    <span className="text-sm text-gray-400">/ năm / tài khoản</span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Chỉ <span className="text-white font-semibold">~700đ/ngày</span> - tiếp cận hàng chục nghìn khách hàng tiềm năng từ các nhóm chất lượng trên Zalo
                  </p>
                  <button
                    onClick={() => window.open('https://t.me/babyvibe', '_blank')}
                    className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.692-1.653-1.123-2.678-1.799-1.185-.78-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.492-1.302.484-.428-.008-1.252-.241-1.865-.44-.752-.244-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635.099-.002.321.023.465.141a.506.506 0 0 1 .171.325c.016.093.036.306.02.472z"/>
                    </svg>
                    Liên hệ mua gói
                  </button>
                </>
              )}
              {isPremium && (
                <p className="text-xs text-gray-400">Quét không giới hạn thành viên nhóm</p>
              )}
            </div>

            {/* How it works */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-300 mb-3">Cách sử dụng</p>
              <div className="space-y-2.5">
                {[
                  { step: '1', text: 'Dán link nhóm Zalo vào ô bên trên' },
                  { step: '2', text: 'Nhấn Tham gia nếu chưa là thành viên' },
                  { step: '3', text: 'Nhấn Quét — kết quả hiện ở tab Thành viên nhóm' },
                  { step: '4', text: 'Chọn thành viên → thêm vào chiến dịch, gửi tin, kết bạn...' },
                ].map(s => (
                  <div key={s.step} className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-gray-700 text-[11px] font-bold text-gray-300 flex items-center justify-center flex-shrink-0 mt-0.5">{s.step}</span>
                    <p className="text-xs text-gray-400 leading-relaxed">{s.text}</p>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      ) : (
      /* ── Tab: Thành viên nhóm (hiện tại) ──────────────────────────────── */
      <div className="flex flex-1 overflow-hidden relative">

      {/* ── Left: Groups ──────────────────────────────────────────────────── */}
      <div className="w-72 flex-shrink-0 border-r border-gray-700 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-white">
              Nhóm Zalo
              {groups.length > 0 && <span className="ml-1.5 text-xs font-normal text-gray-400">({groups.length})</span>}
            </h3>
            <p className="text-[11px] text-gray-400 mt-0.5">Từ danh sách hội thoại</p>
          </div>
          {/* 3-dot menu */}
          <div ref={groupMenuRef} className="relative flex-shrink-0">
            <button
              onClick={() => setShowGroupMenu(v => !v)}
              disabled={groupsLoading}
              title="Tùy chọn đồng bộ nhóm"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 text-lg font-bold transition-colors leading-none">
              ⋮
            </button>
            {showGroupMenu && (
              <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-30 min-w-[210px] overflow-hidden py-1">
                <button
                  onClick={() => { fetchGroupsFromAPI(); setShowGroupMenu(false); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors text-left">
                  {groupsLoading ? SpinIcon : RefreshIcon}
                  <span>Tải toàn bộ nhóm từ Zalo</span>
                </button>
                <button
                  onClick={() => { setShowLinkScanModal(true); setLinkScanInput(''); setLinkScanError(''); setLinkScanResult(null); setLinkJoinStatus('idle'); setLinkJoinMsg(''); setShowGroupMenu(false); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors text-left">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                  <span>Join nhóm theo link</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {groups.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-700/50 flex-shrink-0">
            <input type="text" value={searchGroup} onChange={e => setSearchGroup(e.target.value)}
              placeholder="Tìm nhóm..."
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {groups.length === 0 ? (
            <EmptyState icon={GroupIcon} title="Chưa có dữ liệu nhóm"
              desc={<>Nhấn <span className="text-blue-400 font-medium">Tải từ API</span> để đồng bộ nhóm từ Zalo.</>} />
          ) : filteredGroups.length === 0 ? (
            <div className="flex items-center justify-center h-16 text-xs text-gray-400">Không tìm thấy nhóm</div>
          ) : (
            <div className="py-1">
              {filteredGroups.map(group => (
                  <button key={group.contact_id} onClick={() => setSelectedGroupId(group.contact_id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-700/50 transition-colors
                    ${selectedGroupId === group.contact_id ? 'bg-blue-500/10 border-r-2 border-blue-500' : ''}`}>
                  <GroupAvatar
                    avatarUrl={group.avatar_url}
                    groupInfo={activeAccountId ? (groupInfoCache[activeAccountId] || {})[group.contact_id] : undefined}
                    name={group.display_name}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate font-medium">{group.display_name}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {group.memberCount > 0 ? `${group.memberCount} thành viên` : 'Chưa có thành viên'}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Members ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedGroup ? (
          <EmptyState icon={GroupIcon} title="Chọn một nhóm để xem thành viên"
            desc={groups.length === 0
              ? 'Hãy tải danh sách nhóm từ API trước.'
              : 'Chọn một nhóm bên trái để xem danh sách thành viên.'} />
        ) : (
          <>
            {/* Members header */}
            <div className="px-5 py-3 border-b border-gray-700 flex items-center gap-3 flex-shrink-0 flex-wrap">
              <GroupAvatar
                avatarUrl={selectedGroup.avatar_url}
                groupInfo={activeAccountId ? (groupInfoCache[activeAccountId] || {})[selectedGroup.contact_id] : undefined}
                name={selectedGroup.display_name}
                size="xs"
              />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-white truncate">{selectedGroup.display_name}</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {members.length > 0
                    ? <>{members.length} thành viên{membersLastFetched > 0 && <span className="ml-2 text-gray-400">· {formatTime(membersLastFetched)}</span>}</>
                    : 'Chưa có dữ liệu thành viên'}
                </p>
              </div>
              {/* Tải thành viên (getGroupMembersInfo, auto-fallback getUserInfo) */}
              <button onClick={fetchMembersFromAPI} disabled={membersLoading || manualLoadProgress !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium transition-colors flex-shrink-0">
                {membersLoading ? SpinIcon : RefreshIcon}
                {membersLoading ? 'Đang tải...' : 'Tải thông tin thành viên'}
              </button>
              {/* Stop button shown only during getUserInfo fallback */}
              {manualLoadProgress !== null && (
                <button onClick={() => { manualLoadStopRef.current = true; }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium transition-colors flex-shrink-0">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                  Dừng
                </button>
              )}
            </div>

            {/* getUserInfo fallback progress bar */}
            {manualLoadProgress !== null && (
              <div className="mx-4 mt-2 mb-1 flex-shrink-0">
                <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                  <span className="flex items-center gap-1.5">
                    {SpinIcon}
                    <span>Đang tải thông tin thành viên: <span className="text-white font-medium">{manualLoadProgress.current}</span>/{manualLoadProgress.total}</span>
                  </span>
                  <span className="text-blue-400 font-medium">
                    {Math.round((manualLoadProgress.current / manualLoadProgress.total) * 100)}%
                  </span>
                </div>
                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all duration-200"
                    style={{ width: `${(manualLoadProgress.current / manualLoadProgress.total) * 100}%` }} />
                </div>
              </div>
            )}

            {/* Search + select-all row */}
            <div className="px-4 py-2 border-b border-gray-700/50 flex items-center gap-2 flex-shrink-0">
              {members.length > 0 && (
                <button onClick={allFilteredSelected ? clearSelection : selectAllMembers}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors border
                    ${allFilteredSelected
                      ? 'bg-blue-600/20 border-blue-500/50 text-blue-300 hover:bg-blue-600/30'
                      : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'}`}>
                  {allFilteredSelected ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      Bỏ chọn tất cả
                    </>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg>
                      Chọn tất cả ({filteredMembers.length})
                    </>
                  )}
                </button>
              )}
              <input type="text" value={searchMember} onChange={e => setSearchMember(e.target.value)}
                     placeholder="Tìm thành viên..."
                     className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
            </div>

            {/* Members list */}
            <div className="flex-1 overflow-y-auto pb-16">
              {members.length === 0 ? (
                <EmptyState
                  icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-400"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
                  title="Chưa có dữ liệu thành viên"
                  desc={<>Nhấn <span className="text-blue-400 font-medium">Tải thành viên</span> để đồng bộ từ Zalo về DB.<br/><span className="text-gray-400 text-[11px]">Lưu ý: cần tải nhóm từ API trước để có danh sách UID.</span></>}
                />
              ) : filteredMembers.length === 0 ? (
                <div className="flex items-center justify-center h-16 text-xs text-gray-400">Không tìm thấy thành viên</div>
              ) : (
                <div className="p-2 space-y-0.5">
                  {filteredMembers.map(member => {
                    const rl = roleLabel(member.role);
                    const isSelected = selectedMemberIds.has(member.member_id);
                    return (
                      <div key={member.member_id}
                        onClick={() => toggleMember(member.member_id)}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors select-none
                          ${isSelected ? 'bg-blue-500/15 border border-blue-500/30' : 'hover:bg-gray-800/60 border border-transparent'}`}>
                        <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-colors
                          ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-600 bg-gray-800'}`}>
                          {isSelected && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          )}
                        </div>
                        <Avatar src={member.avatar} name={member.display_name || member.member_id} size={34} />
                        <div className="flex-1 min-w-0">
                          {member.display_name
                            ? <p className="text-sm text-white truncate font-medium">{member.display_name}</p>
                            : <p className="text-sm text-gray-400 truncate italic">
                                Chưa có tên -{' '}
                                {member.phone
                                  ? <PhoneDisplay phone={member.phone} className="text-gray-400" />
                                  : member.member_id}
                              </p>}
                          <div className="text-[11px] text-gray-400 mt-0.5">
                            {member.phone
                              ? <>
                                  <PhoneDisplay phone={member.phone} className="text-green-400" />
                                  <div className="text-gray-400">{member.member_id}</div>
                                </>
                              : member.display_name ? member.member_id : null}
                          </div>
                        </div>
                        <span className={`text-[11px] font-medium flex-shrink-0 ${rl.cls}`}>{rl.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Bottom action bar (when members selected) ─────────────────── */}
            {selectedMemberIds.size > 0 && (
              <div className="absolute bottom-0 left-72 right-0 bg-gray-800/95 backdrop-blur border-t border-gray-600 px-5 py-3 flex items-center gap-3 z-10">
                <span className="text-sm text-white font-medium">
                  Đã chọn <span className="text-blue-400">{selectedMemberIds.size}</span> thành viên
                </span>
                <div className="flex-1"/>
                <button onClick={clearSelection}
                  className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs transition-colors">
                  Bỏ chọn
                </button>
                <button onClick={openCampaignPicker}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                  </svg>
                  Thêm vào chiến dịch
                </button>
                <button onClick={() => setShowAddToContacts(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-medium transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
                    <line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
                  </svg>
                  Thêm vào liên hệ
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Campaign picker modal ──────────────────────────────────────────── */}
      {showCampaignPicker && !showCreateCampaign && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowCampaignPicker(false)}>
          <div className="bg-gray-800 border border-gray-600 rounded-2xl w-80 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-white">Thêm vào chiến dịch</h3>
              <button
                onClick={() => setShowCreateCampaign(true)}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-lg hover:bg-blue-500/10">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Tạo mới
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Áp dụng cho <span className="text-blue-400 font-medium">{selectedMemberIds.size}</span> thành viên đã chọn
            </p>

            {localCampaigns.length === 0 ? (
              <div className="py-6 flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-400">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                  </svg>
                </div>
                <div className="text-center">
                  <p className="text-sm text-gray-300 font-medium">Chưa có chiến dịch nào</p>
                  <p className="text-xs text-gray-400 mt-1">Tạo chiến dịch mới để bắt đầu gửi tin</p>
                </div>
                <button
                  onClick={() => setShowCreateCampaign(true)}
                  className="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors flex items-center justify-center gap-1.5">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  Tạo chiến dịch mới
                </button>
              </div>
            ) : (
              <div className="space-y-2 max-h-52 overflow-y-auto mb-4">
                {localCampaigns.map((c: any) => (
                  <button key={c.id} onClick={() => setPickedCampaignId(c.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm transition-colors
                      ${pickedCampaignId === c.id ? 'border-blue-500 bg-blue-500/20 text-white' : 'border-gray-600 text-gray-300 hover:border-gray-500'}`}>
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.status === 'active' ? 'bg-green-400' : c.status === 'paused' ? 'bg-yellow-400' : 'bg-gray-500'}`} />
                      {c.name}
                    </span>
                    <span className="block text-xs text-gray-400 mt-0.5 pl-3">{c.total_contacts ?? 0} liên hệ</span>
                  </button>
                ))}
              </div>
            )}

            {localCampaigns.length > 0 && (
              <div className="flex gap-2">
                <button onClick={() => setShowCampaignPicker(false)}
                  className="flex-1 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors">
                  Hủy
                </button>
                <button onClick={handleAddToCampaign}
                  disabled={!pickedCampaignId || addingToCampaign}
                  className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors">
                  {addingToCampaign ? 'Đang thêm...' : `Thêm ${selectedMemberIds.size} thành viên`}
                </button>
              </div>
            )}
            {localCampaigns.length === 0 && (
              <button onClick={() => setShowCampaignPicker(false)}
                className="w-full mt-2 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors">
                Hủy
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Create campaign popup (from picker) ───────────────────────────── */}
      {showCreateCampaign && (
        <CampaignCreateModal
          onClose={() => setShowCreateCampaign(false)}
          onSave={async (data) => {
            await handleCreateCampaignInPicker(data);
            setShowCreateCampaign(false);
          }}
        />
      )}

      {/* ── Add to contacts modal ─────────────────────────────────────────── */}
      {showAddToContacts && (
        <AddToContactsModal
          contacts={members
            .filter(m => selectedMemberIds.has(m.member_id))
            .map(m => ({
              contactId: m.member_id,
              displayName: m.display_name || m.member_id,
              avatar: m.avatar || '',
              phone: m.phone || '',
            }))}
          onClose={() => setShowAddToContacts(false)}
          onDone={() => {
            setSelectedMemberIds(new Set());
            setShowAddToContacts(false);
          }}
        />
      )}

      {/* ── Scan by link modal ─────────────────────────────────────────────── */}
      {showLinkScanModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={() => { if (!linkScanLoading) setShowLinkScanModal(false); }}>
          <div className="bg-gray-800 border border-gray-600 rounded-2xl w-[420px] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2.5">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-white text-sm">Join nhóm theo link</h3>
                <p className="text-xs text-gray-400 mt-0.5">Nhập link mời nhóm Zalo để tham gia nhóm</p>
                <p className="text-xs text-gray-400 mt-0.5">Các nhóm công khai thành viên mới quét được thành viên</p>
              </div>
            </div>

            {/* Input */}
            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1.5 block">Đường dẫn nhóm</label>
              <input
                value={linkScanInput}
                onChange={e => { setLinkScanInput(e.target.value); setLinkJoinStatus('idle'); setLinkJoinMsg(''); }}
                onKeyDown={e => { if (e.key === 'Enter' && !linkScanLoading) scanGroupByLink(); }}
                placeholder="https://zalo.me/g/..."
                disabled={linkScanLoading}
                className="w-full bg-gray-700 border border-gray-600 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 disabled:opacity-60"
              />
            </div>

            {/* Progress bar */}
            {linkScanProgress !== null && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs text-gray-400 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    {SpinIcon}
                    <span>Đang tải thông tin thành viên: <span className="text-white font-medium">{linkScanProgress.current}</span>/{linkScanProgress.total}</span>
                  </span>
                  <span className="text-purple-400 font-medium">{Math.round((linkScanProgress.current / linkScanProgress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-purple-500 to-purple-400 rounded-full transition-all duration-200"
                    style={{ width: `${(linkScanProgress.current / linkScanProgress.total) * 100}%` }} />
                </div>
                <button onClick={() => { linkScanStopRef.current = true; }}
                  className="mt-2 text-xs text-red-400 hover:text-red-300 transition-colors">
                  Dừng tải thông tin
                </button>
              </div>
            )}

            {/* Loading state */}
            {linkScanLoading && linkScanProgress === null && (
              <div className="mb-4 flex items-center gap-2 text-xs text-gray-400">
                {SpinIcon}
                <span>Đang lấy thông tin nhóm từ Zalo...</span>
              </div>
            )}

            {/* Error */}
            {linkScanError && (
              <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400">
                <AlertIcon className="w-4 h-4 inline" /> {linkScanError}
              </div>
            )}

            {/* Success result */}
            {linkScanResult && !linkScanLoading && (
              <div className="mb-4 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-xl text-xs text-green-400">
                <CheckIcon className="w-4 h-4 inline" /> Đã quét xong nhóm <span className="font-semibold text-green-300">"{linkScanResult.name}"</span>
                <span className="text-gray-400 ml-1">({linkScanResult.groupId})</span>
              </div>
            )}

            {/* Join status */}
            {linkJoinStatus !== 'idle' && (
              <div className={`mb-4 px-3 py-2 rounded-xl text-xs border flex items-center gap-1 ${
                linkJoinStatus === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-400' :
                linkJoinStatus === 'pending' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' :
                linkJoinStatus === 'already' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' :
                'bg-red-500/10 border-red-500/30 text-red-400'
              }`}>
                {linkJoinStatus === 'success' && <CheckIcon className="w-3.5 h-3.5 inline" />}
                {linkJoinStatus === 'pending' && '⏳ '}
                {linkJoinStatus === 'already' && 'ℹ️ '}
                {linkJoinStatus === 'error' && <AlertIcon className="w-3.5 h-3.5 inline" />}
                {linkJoinMsg}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setShowLinkScanModal(false)}
                disabled={linkScanLoading && linkScanProgress !== null}
                className="flex-1 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 disabled:opacity-40 transition-colors">
                {linkScanResult && !linkScanLoading ? 'Đóng' : 'Hủy'}
              </button>
              {!linkScanResult && (
                <button
                  onClick={scanGroupByLink}
                  disabled={linkScanLoading || !linkScanInput.trim()}
                  className="flex-1 py-2 rounded-xl bg-purple-600 text-white text-sm hover:bg-purple-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5">
                  {linkScanLoading ? <>{SpinIcon} Đang quét...</> : <><SearchIcon className="w-4 h-4 inline" /> Quét nhóm</>}
                </button>
              )}
              {/* Join button - shown after scan success or standalone */}
              <button
                onClick={joinGroupByLink}
                disabled={linkJoinLoading || !linkScanInput.trim()}
                title="Yêu cầu tài khoản đang hoạt động tham gia nhóm này"
                className="flex-1 py-2 rounded-xl bg-teal-600 text-white text-sm hover:bg-teal-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5">
                {linkJoinLoading ? <>{SpinIcon} Đang join...</> : '🚪 Join nhóm'}
              </button>
              {linkScanResult && !linkScanLoading && (
                <button
                  onClick={() => { setLinkScanInput(''); setLinkScanResult(null); setLinkScanError(''); setLinkJoinStatus('idle'); setLinkJoinMsg(''); }}
                  className="flex-1 py-2 rounded-xl bg-purple-600 text-white text-sm hover:bg-purple-700 transition-colors">
                  Quét link khác
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Group fetch progress modal ─────────────────────────────────────── */}
      {groupFetchProgress !== null && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-600 rounded-2xl w-[420px] p-6 shadow-2xl">

            {groupFetchProgress.phase === 'groups' ? (
              /* ── Phase 1: Sync groups ── */
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                    {SpinIcon}
                  </div>
                  <div>
                    <h3 className="font-semibold text-white text-sm">Đang đồng bộ nhóm Zalo</h3>
                    <p className="text-xs text-gray-400 mt-0.5">Tổng cộng <span className="text-white font-medium">{groupFetchProgress.total}</span> nhóm · Bước 1/2</p>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="text-gray-400">
                    Đã xử lý: <span className="text-white font-semibold">{groupFetchProgress.current}</span>
                    <span className="text-gray-400"> / {groupFetchProgress.total}</span>
                  </span>
                  <span className="text-blue-400 font-semibold text-sm">
                    {Math.round((groupFetchProgress.current / groupFetchProgress.total) * 100)}%
                  </span>
                </div>
                <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-300"
                    style={{ width: `${(groupFetchProgress.current / groupFetchProgress.total) * 100}%` }} />
                </div>
                <p className="text-[11px] text-gray-400 mt-3 text-center">
                  Vui lòng không đóng cửa sổ trong khi đồng bộ...
                </p>
              </>
            ) : (
              /* ── Phase 2: Enrich member details ── */
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl bg-green-500/15 border border-green-500/30 flex items-center justify-center flex-shrink-0">
                    {SpinIcon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-white text-sm">Đang tải chi tiết thành viên · Bước 2/2</h3>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      Nhóm <span className="text-white font-medium">{groupFetchProgress.groupCurrent}/{groupFetchProgress.groupTotal}</span>
                      {groupFetchProgress.currentGroupName && (
                        <span className="ml-1 text-gray-400 truncate">· {groupFetchProgress.currentGroupName}</span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Group progress */}
                <div className="mb-3">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-400">Tiến độ nhóm</span>
                    <span className="text-green-400 font-semibold">
                      {Math.round((groupFetchProgress.groupCurrent / groupFetchProgress.groupTotal) * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-green-500 to-green-400 rounded-full transition-all duration-300"
                      style={{ width: `${(groupFetchProgress.groupCurrent / groupFetchProgress.groupTotal) * 100}%` }} />
                  </div>
                </div>

                {/* Member progress */}
                {groupFetchProgress.memberTotal > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-gray-400">
                        Thành viên: <span className="text-white">{groupFetchProgress.memberCurrent}</span>/{groupFetchProgress.memberTotal}
                      </span>
                      <span className="text-blue-400 font-semibold">
                        {Math.round((groupFetchProgress.memberCurrent / groupFetchProgress.memberTotal) * 100)}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-300"
                        style={{ width: `${(groupFetchProgress.memberCurrent / groupFetchProgress.memberTotal) * 100}%` }} />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between mt-3">
                  <p className="text-[11px] text-gray-400">Đang tải SĐT + thông tin thành viên từ Zalo...</p>
                  <button
                    onClick={() => { bulkEnrichStopRef.current = true; }}
                    className="flex-shrink-0 ml-3 px-3 py-1 text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg transition-colors">
                    Bỏ qua
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      </div>
      )}
    </div>
  );
}
