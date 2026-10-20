import React, { useEffect, useState, useCallback, useRef } from 'react';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useCRMStore } from '@/store/crmStore';
import { useEmployeeResync } from '@/hooks/useEmployeeResync';
import { buildGroupRows, countMembersByGroup, phonesByContact, readOutcome, withMemberPhones } from '@/lib/crm/loadFailure';
import PhoneDisplay from '@/components/common/PhoneDisplay';
import GroupAvatar from '@/components/common/GroupAvatar';
import CampaignCreateModal from '@/components/crm/campaigns/CampaignCreateModal';
import AddToContactsModal from '@/components/crm/contacts/AddToContactsModal';
import LoadFailedNotice from '@/components/crm/LoadFailedNotice';
import ShareGroupModal from '@/components/crm/groups/ShareGroupModal';
import SharedGroupsCategoryPopup from '@/components/crm/groups/SharedGroupsCategoryPopup';
import BulkImportGroupsModal from '@/components/crm/groups/BulkImportGroupsModal';
import { syncZaloGroups, MemberPlaceholder, SyncGroupsProgress } from '@/lib/zaloGroupUtils';
import { classifyZaloJoinResult } from '@/lib/zaloJoinGroupResult';
import { AlertIcon, CheckIcon, SearchIcon } from '@/components/common/icons';
import { useGroupMemberSync } from '@/hooks/useGroupMemberSync';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { groupRoleKind } from '../../../../shared/groupMemberRoles';

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

/** Nhãn vai trò theo quy ước của kênh (Zalo 2 = trưởng / 1 = phó, Telegram 1 = người tạo / 2 = quản trị). */
function roleLabel(role: number, channel?: string) {
  const kind = groupRoleKind(role, channel);
  if (kind === 'owner') return { text: 'Trưởng nhóm', cls: 'text-yellow-400', kind };
  if (kind === 'admin') return { text: 'Phó nhóm', cls: 'text-blue-400', kind };
  return { text: 'Thành viên', cls: 'text-muted-foreground', kind };
}

function Avatar({ src, name, size = 36 }: { src?: string; name: string; size?: number }) {
  const [err, setErr] = useState(false);
  const initials = (name || '?').charAt(0).toUpperCase();
  const avatarUrl = src ? toLocalMediaUrl(src) : '';
  if (avatarUrl && !err) {
    return (
      <img src={avatarUrl} alt={name} style={{ width: size, height: size }}
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
      <div className="w-12 h-12 rounded-full bg-card flex items-center justify-center mb-3 opacity-70">{icon}</div>
      <p className="text-sm text-foreground/80 font-medium mb-1">{title}</p>
      <div className="text-xs text-muted-foreground leading-relaxed max-w-xs">{desc}</div>
    </div>
  );
}

const GroupIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
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

/** Channels are broadcast/news feeds, not CRM groups with a member list. */
const TELEGRAM_MEMBER_GROUP_TYPES = new Set(['basic_group', 'supergroup', 'forum']);
const isTelegramMemberGroup = (contact: any) => {
  const peerType = String(contact?.telegram_peer_type || '');
  // Keep legacy rows with no stored peer type until the user refreshes them.
  return !peerType || TELEGRAM_MEMBER_GROUP_TYPES.has(peerType);
};

function ZaloGroupMembersTab() {
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const setGroupCount = useCRMStore(s => s.setGroupCount);
  const groupInfoCache = useAppStore(s => s.groupInfoCache);

  const [groups, setGroups] = useState<ZaloGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersLastFetched, setMembersLastFetched] = useState(0);
  const [searchGroup, setSearchGroup] = useState('');
  const [searchMember, setSearchMember] = useState('');

  // ── Lần đọc lỗi (employee: mất kết nối BOSS) ──────────────────────────────
  // Lỗi → giữ nhóm / thành viên / chiến dịch đang có của ĐÚNG tài khoản (nhóm), báo "Không tải được — Thử lại", và
  // khoá thao tác ghi dựa trên dữ liệu đọc thiếu (đồng bộ nhóm, quét thành viên) cho tới khi đọc lại được.
  const [groupsLoadFailed, setGroupsLoadFailed] = useState(false);
  /** 'members' = không đọc được danh sách thành viên (khoá quét); 'phones' = chỉ không đọc được SĐT từ danh bạ. */
  const [membersFailure, setMembersFailure] = useState<null | 'members' | 'phones'>(null);
  const membersLoadFailed = membersFailure !== null;
  const [campaignsLoadFailed, setCampaignsLoadFailed] = useState(false);
  const [groupsReading, setGroupsReading] = useState(false);
  const [membersReading, setMembersReading] = useState(false);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  /** Chủ của dữ liệu đang hiện: nhóm & chiến dịch = tài khoản, thành viên = `tàiKhoản:nhóm`. */
  const groupsOwnerRef = useRef<string | null>(null);
  const membersOwnerRef = useRef<string | null>(null);
  const campaignsOwnerRef = useRef<string | null>(null);
  // Chỉ lần đọc mới nhất được ghi state (đổi tài khoản / nhóm trong lúc chờ)
  const groupsSeqRef = useRef(0);
  const membersSeqRef = useRef(0);
  const campaignsSeqRef = useRef(0);
  // Bản mới nhất cho callback async (giữ số thành viên / SĐT đã biết khi lần đọc phụ lỗi)
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const membersRef = useRef(members);
  membersRef.current = members;
  const selectedGroupIdRef = useRef(selectedGroupId);
  selectedGroupIdRef.current = selectedGroupId;

  // ── Progress state ────────────────────────────────────────────────────────
  /** Phase 1: syncing groups from API | Phase 2: enriching member details */
  type GroupFetchProgress =
    | { phase: 'groups'; current: number; total: number }
    | { phase: 'members'; groupCurrent: number; groupTotal: number; memberCurrent: number; memberTotal: number; currentGroupName: string };
  const [groupFetchProgress, setGroupFetchProgress] = useState<GroupFetchProgress | null>(null);
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

  // ── Share group modal state ───────────────────────────────────────────────
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareGroupInfo, setShareGroupInfo] = useState<{
    groupId: string; groupName: string; groupAvatar: string; memberCount: number;
  } | null>(null);

  // ── Shared groups popup state ────────────────────────────────────────────
  const [showSharedGroupsPopup, setShowSharedGroupsPopup] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  // ── Scan tab state ────────────────────────────────────────────────────
  const [scanLinkInput, setScanLinkInput] = useState('');
  const [scanTabLoading, setScanTabLoading] = useState(false);
  const [scanTabError, setScanTabError] = useState('');
  const [scanTabResults, setScanTabResults] = useState<Array<{ userId: string; displayName: string; avatar: string }>>([]);
  const [scanTabGroupId, setScanTabGroupId] = useState<string | null>(null);
  const [scanJoinLoading, setScanJoinLoading] = useState(false);
  const [scanJoinMsg, setScanJoinMsg] = useState('');
  const [scanJoinType, setScanJoinType] = useState<'idle' | 'success' | 'pending' | 'already' | 'error'>('idle');

  // ── Export notification state ──────────────────────────────────────────
  const [exportNotif, setExportNotif] = useState<{ message: string; folderPath?: string } | null>(null);

  // ── Red dot: "mới" badge cho tab Quét thành viên ─────────────────────
  const [scanTabSeen, setScanTabSeen] = useState(() => {
    try { return localStorage.getItem('scanTabSeen') === 'true'; } catch { return false; }
  });

  // ── Resolved group info (hiện ảnh + tên nhóm khi tham gia / quét) ─────
  const [resolvedGroupInfo, setResolvedGroupInfo] = useState<{ groupId: string; name: string; avatar: string; creatorId?: string; adminIds?: string[] } | null>(null);

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

  // ── Group member scan (available to every Zalo account) ───────────────
  const { syncMembers } = useGroupMemberSync({
    accountId: activeAccountId || '',
    groupId: selectedGroupId || '',
    onMembersSynced: async () => {
      if (selectedGroupId) {
        await loadMembersFromDB(selectedGroupId);
        await loadGroupsFromDB();
      }
    },
  });

  // ── Load groups from contacts (contact_type='group') ──────────────────────
  // Trả `false` khi đọc lỗi: danh sách lỗi → giữ danh sách đang có của tài khoản; chỉ đếm thành viên lỗi → danh sách
  // mới nhưng giữ số thành viên đã biết (không về "Chưa có thành viên"). Cả hai bật `groupsLoadFailed`.
  const loadGroupsFromDB = useCallback(async (): Promise<boolean> => {
    if (!activeAccountId) return false;
    const accountId = activeAccountId;
    const seq = ++groupsSeqRef.current;
    setGroupsReading(true);
    try {
      const convRes = await DataAccessor.getConversations(accountId, 999, 0);
      const convFailed = isReadFailure(convRes);
      // Danh sách lỗi → khỏi đếm thành viên
      const allMembersRes = convFailed ? null : await DataAccessor.getAllGroupMembers(accountId);
      const countsFailed = isReadFailure(allMembersRes);
      if (seq !== groupsSeqRef.current) return !convFailed && !countsFailed; // đã đổi tài khoản / có lần đọc mới hơn
      if (convFailed) {
        if (readOutcome(true, groupsOwnerRef.current, accountId) === 'clear') {
          groupsOwnerRef.current = accountId;
          setGroups([]);
        }
        setGroupsLoadFailed(true);
        return false;
      }
      const sameOwner = groupsOwnerRef.current === accountId;
      const counts = countsFailed ? null : countMembersByGroup(allMembersRes?.rows);
      const mapped = buildGroupRows(convRes?.items, counts, sameOwner ? groupsRef.current : []);
      groupsOwnerRef.current = accountId;
      setGroups(mapped);
      setGroupCount(mapped.length);
      setGroupsLoadFailed(countsFailed);
      return !countsFailed;
    } catch (err) {
      console.warn('[GroupMembersTab] loadGroupsFromDB error:', err);
      if (seq === groupsSeqRef.current) setGroupsLoadFailed(true);
      return false;
    } finally {
      if (seq === groupsSeqRef.current) setGroupsReading(false);
    }
  }, [activeAccountId, setGroupCount]);

  // ── Load members from page_group_member ───────────────────────────────────
  // Chỉ ghi khi `groupId` vẫn là nhóm đang chọn. Đọc thành viên lỗi → giữ danh sách đang hiện của đúng nhóm, không
  // đóng dấu thời gian (`membersFailure` = 'members'); đọc danh bạ lỗi → danh sách mới nhưng giữ SĐT đang hiện ('phones').
  const loadMembersFromDB = useCallback(async (groupId: string): Promise<boolean> => {
    // Nhóm không đang xem (vd quét ở tab "Quét thành viên"): không đọc — chọn nhóm đó sẽ tự tải (effect bên dưới)
    if (!activeAccountId || selectedGroupIdRef.current !== groupId) return false;
    const accountId = activeAccountId;
    const owner = `${accountId}:${groupId}`;
    const seq = ++membersSeqRef.current;
    setMembersReading(true);
    try {
      const res = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
      const membersFailed = isReadFailure(res);
      // Merge phone numbers from contacts table (danh sách thành viên đã lỗi thì khỏi đọc)
      const convRes = membersFailed ? null : await DataAccessor.getConversations(accountId, 999, 0);
      // Đổi nhóm / tài khoản trong lúc chờ, hoặc nhóm này không phải nhóm đang xem → không ghi
      if (seq !== membersSeqRef.current || selectedGroupIdRef.current !== groupId) return !membersFailed;
      if (membersFailed) {
        if (readOutcome(true, membersOwnerRef.current, owner) === 'clear') {
          membersOwnerRef.current = owner;
          setMembers([]);
          setMembersLastFetched(0);
        }
        setMembersFailure('members');
        return false;
      }
      // Filter out non-numeric garbage IDs (e.g. "profiles", "unchangeds_profile") from old bad parses
      const rows = (res?.members ?? []).filter((m: any) => {
        const id = m.member_id?.trim();
        return id && /^\d+$/.test(id);
      });
      const phonesFailed = isReadFailure(convRes);
      const merged: GroupMember[] = withMemberPhones(
        rows,
        phonesFailed ? null : phonesByContact(convRes?.items),
        membersOwnerRef.current === owner ? membersRef.current : [],
      );
      membersOwnerRef.current = owner;
      setMembers(merged);
      setMembersLastFetched(merged.length > 0 ? Math.max(...merged.map((m: any) => m.updated_at || 0)) : 0);
      setMembersFailure(phonesFailed ? 'phones' : null);
      return true;
    } catch (err) {
      console.warn('[GroupMembersTab] loadMembersFromDB error:', err);
      if (seq === membersSeqRef.current && selectedGroupIdRef.current === groupId) setMembersFailure('members');
      return false;
    } finally {
      if (seq === membersSeqRef.current) setMembersReading(false);
    }
  }, [activeAccountId]);

  // ── Fetch groups from API - delegates to syncZaloGroups (full-sync mode) ──
  const fetchGroupsFromAPI = useCallback(async () => {
    if (!activeAccountId) return;
    // Lần đọc nhóm / số thành viên gần nhất lỗi: đồng bộ toàn bộ dựa vào bảng thành viên hiện có — đọc lỗi sẽ ghi đè
    // thành viên mọi nhóm bằng bản rỗng tên và tải lại từ đầu. Chờ "Thử lại" đọc được đã.
    if (groupsLoadFailed) return;
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
    } catch (err: any) {
      // syncZaloGroups dừng có chủ đích khi không đọc được dữ liệu hiện có (tránh ghi đè) → báo cho người dùng
      useAppStore.getState().showNotification(err?.message || 'Đồng bộ nhóm thất bại', 'error');
    } finally {
      setGroupsLoading(false);
      setGroupFetchProgress(null);
      bulkEnrichStopRef.current = false;
    }
  }, [activeAccountId, loadGroupsFromDB, groupsLoadFailed]);

  // ── Fetch members from the shared scan API ─────────────────────────────
  const fetchMembersFromAPI = useCallback(async () => {
    if (!activeAccountId || !selectedGroupId) return;
    // Chưa đọc được thành viên hiện có (vai trò trưởng / phó nhóm) → chưa quét: lưu lúc này dựa trên dữ liệu thiếu
    // (useGroupMemberSync cũng tự bỏ lưu khi lần đọc vai trò của nó lỗi)
    if (membersFailure === 'members') return;

    setMembersLoading(true);
    try {
      await syncMembers();
    } finally {
      setMembersLoading(false);
    }
  }, [activeAccountId, selectedGroupId, syncMembers, membersFailure]);

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
      // 178 = đã là thành viên, 172 = nhóm đầy, 240 = chờ duyệt (lib/zaloJoinGroupResult)
      const join = classifyZaloJoinResult(res);
      if (join.outcome === 'already') {
        setLinkJoinStatus('already');
        setLinkJoinMsg('Bạn đã là thành viên của nhóm này.');
      } else if (join.outcome === 'full') {
        setLinkJoinStatus('error');
        setLinkJoinMsg('Group đã vượt quá số thành viên cho phép. Bạn không thể tham gia nhóm này.');
      } else if (join.outcome === 'pending') {
        setLinkJoinStatus('pending');
        setLinkJoinMsg('Nhóm bật chế độ duyệt thành viên. Yêu cầu của bạn đã được gửi, chờ admin duyệt.');
      } else if (join.outcome === 'error') {
        setLinkJoinStatus('error');
        setLinkJoinMsg(join.error || `Lỗi${join.code ? ` (${join.code})` : ''}: Không thể tham gia nhóm.`);
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

  // ── Helper: Resolve group link → get info + save to DB ────────────────────
  const resolveAndSaveGroupInfo = useCallback(async (auth: any, linkOrId: string): Promise<{ groupId: string; name: string; avatar: string; creatorId: string; adminIds: string[] } | null> => {
    try {
      const linkRes: any = await ipc.zalo?.getGroupLinkInfo({ auth, link: linkOrId, memberPage: 1 });
      if (!linkRes?.success || !linkRes?.response?.groupId) return null;
      const data = linkRes.response;
      const groupId = data.groupId || '';
      const name = data.name || data.groupId || '';
      const avatar = data.fullAvt || data.avt || '';
      const creatorId = String(data.creatorId || '').replace(/_0$/, '');
      const adminIds: string[] = (data.adminIds || []).map((a: string) => String(a).replace(/_0$/, ''));

      if (groupId) {
        // Save group contact to DB if not exists
        await DataAccessor.updateContactProfile({
          zaloId: activeAccountId!, contactId: groupId,
          displayName: name, avatarUrl: avatar, phone: '', contactType: 'group',
        });
        // Reload group list so it appears in left panel
        await loadGroupsFromDB();
      }
      return { groupId, name, avatar, creatorId, adminIds };
    } catch (err) {
      console.warn('[GroupMembersTab] resolveAndSaveGroupInfo error:', err);
      return null;
    }
  }, [activeAccountId, loadGroupsFromDB]);

  // ── Scan from "Quét thành viên" tab (gọi backend API) ──────────────
  const handleScanTab = useCallback(async () => {
    if (!activeAccountId || !scanLinkInput.trim()) return;

    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) { setScanTabError('Không tìm thấy tài khoản'); return; }
    const auth = buildZaloAuth(acc, activeAccountId);

    setScanTabLoading(true);
    setScanTabError('');
    setScanTabResults([]);
    setScanTabGroupId(null);
    try {
      let groupId = scanLinkInput.trim();
      let groupInfoFromLink: { groupId: string; name: string; avatar: string; creatorId?: string; adminIds?: string[] } | null = null;

      // Nếu là link zalo.me → gọi getGroupLinkInfo để lấy groupId + save group info
      if (groupId.includes('zalo.me') || groupId.includes('chat.zalo.me')) {
        const info = await resolveAndSaveGroupInfo(auth, groupId);
        if (!info) {
          setScanTabError('Không lấy được thông tin nhóm từ link. Kiểm tra lại đường dẫn.');
          return;
        }
        groupId = info.groupId;
        groupInfoFromLink = info;
        setResolvedGroupInfo(info);
      } else if (/^\d+$/.test(groupId)) {
        // Nhập groupId dạng số → thử resolve info để hiện tên + ảnh + lấy creator/admin
        const info = await resolveAndSaveGroupInfo(auth, groupId);
        if (info) {
          groupInfoFromLink = info;
          setResolvedGroupInfo(info);
        }
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

      // Update resolvedGroupInfo nếu chưa có (trường hợp nhập groupId số)
      if (!resolvedGroupInfo && !groupInfoFromLink) {
        setResolvedGroupInfo({ groupId, name: groupId, avatar: '', creatorId: '', adminIds: [] });
      }

      // Xác định role từ creatorId/adminIds (lấy từ getGroupLinkInfo)
      const creatorId = groupInfoFromLink?.creatorId || '';
      const adminIdList = groupInfoFromLink?.adminIds || [];
      const adminSet = new Set([creatorId, ...adminIdList].filter(Boolean));

      // Lưu vào DB
      await DataAccessor.saveGroupMembers({
        zaloId: activeAccountId,
        groupId,
        members: members.map((m: any) => {
          const mid = m.userId || m.id;
          let role = 0;
          if (mid === creatorId) role = 2;       // Trưởng nhóm
          else if (adminSet.has(mid)) role = 1;  // Phó nhóm
          return {
            memberId: mid,
            displayName: m.displayName || m.zaloName || m.userId || m.id,
            avatar: m.avatar || '',
            role,
          };
        }),
      });

      // Reload members tab
      await loadMembersFromDB(groupId);
    } catch (err: any) {
      setScanTabError(err?.message || 'Lỗi không xác định');
    } finally {
      setScanTabLoading(false);
    }
  }, [activeAccountId, scanLinkInput, loadMembersFromDB, resolveAndSaveGroupInfo, resolvedGroupInfo]);

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
      // Resolve group info + save to DB
      const info = await resolveAndSaveGroupInfo(auth, scanLinkInput.trim());
      if (info) setResolvedGroupInfo(info);

      const res = await ipc.zalo?.joinGroupLink({ auth, link: scanLinkInput.trim() });
      // Mỗi kết quả ghi vào state của CHÍNH tab Quét (nhánh nhóm đầy từng ghi vào modal Join theo link → tab không hiện gì)
      const join = classifyZaloJoinResult(res);
      if (join.outcome === 'already') {
        setScanJoinType('already');
        setScanJoinMsg('Bạn đã là thành viên của nhóm này.');
      } else if (join.outcome === 'full') {
        setScanJoinType('error');
        setScanJoinMsg('Group đã vượt quá số thành viên cho phép. Bạn không thể tham gia nhóm này.');
      } else if (join.outcome === 'pending') {
        setScanJoinType('pending');
        setScanJoinMsg('Nhóm bật chế độ duyệt thành viên. Yêu cầu đã được gửi, chờ admin duyệt. Bạn có thể quét thành viên nhóm được rồi!');
      } else if (join.outcome === 'error') {
        setScanJoinType('error');
        setScanJoinMsg(join.error || `Lỗi${join.code ? ` (${join.code})` : ''}: Không thể tham gia nhóm.`);
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
  }, [activeAccountId, scanLinkInput, loadGroupsFromDB, resolveAndSaveGroupInfo]);

  const toggleMember = (id: string) => {
    setSelectedMemberIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAllMembers = () => setSelectedMemberIds(new Set(filteredMembers.map(m => m.member_id)));
  const clearSelection = () => setSelectedMemberIds(new Set());

  // ── Campaigns for the picker ──────────────────────────────────────────────
  // Lỗi → giữ danh sách của đúng tài khoản + báo lỗi; danh sách của tài khoản khác thì bỏ (không thêm thành viên vào
  // chiến dịch của tài khoản khác, không hiện "Chưa có chiến dịch nào" giả).
  const loadPickerCampaigns = useCallback(async (): Promise<boolean> => {
    if (!activeAccountId) return false;
    const accountId = activeAccountId;
    const seq = ++campaignsSeqRef.current;
    setCampaignsLoading(true);
    let res: any;
    try {
      res = await DataAccessor.getCRMCampaigns({ zaloId: accountId });
    } catch (err: any) {
      res = { success: false, error: err?.message };
    }
    if (seq !== campaignsSeqRef.current) return false;
    setCampaignsLoading(false);
    if (res?.success) {
      campaignsOwnerRef.current = accountId;
      setLocalCampaigns((res.campaigns || []).filter((c: any) => c.status !== 'done'));
      setCampaignsLoadFailed(false);
      return true;
    }
    if (isReadFailure(res)) {
      if (readOutcome(true, campaignsOwnerRef.current, accountId) === 'clear') {
        campaignsOwnerRef.current = accountId;
        setLocalCampaigns([]);
      }
      setCampaignsLoadFailed(true);
    }
    return false;
  }, [activeAccountId]);

  // ── Open campaign picker ──────────────────────────────────────────────────
  const openCampaignPicker = useCallback(async () => {
    if (!activeAccountId) return;
    await loadPickerCampaigns();
    setPickedCampaignId(null);
    setShowCampaignPicker(true);
  }, [activeAccountId, loadPickerCampaigns]);

  // ── Create new campaign from within picker ────────────────────────────────
  const handleCreateCampaignInPicker = useCallback(async (data: any) => {
    if (!activeAccountId) return;
    const res = await DataAccessor.saveCRMCampaign({ zaloId: activeAccountId, campaign: data });
    if (res?.success) {
      // Refresh local campaign list and auto-select the new one
      if (await loadPickerCampaigns() && res.id) setPickedCampaignId(res.id);
    }
  }, [activeAccountId, loadPickerCampaigns]);

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
      const res: any = await DataAccessor.addCampaignContacts({ zaloId: activeAccountId, campaignId: pickedCampaignId, contacts });
      if (res?.success === false) {
        // Ghi lỗi (employee: mất kết nối BOSS) → báo + giữ cửa sổ / lựa chọn để thử lại (trước đây đóng như đã thêm)
        useAppStore.getState().showNotification('Không thêm được vào chiến dịch: ' + (res.error || 'Không rõ'), 'error');
        return;
      }
      setShowCampaignPicker(false);
      setSelectedMemberIds(new Set());
      setPickedCampaignId(null);
    } finally {
      setAddingToCampaign(false);
    }
  }, [activeAccountId, pickedCampaignId, selectedMemberIds, members]);

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    // Đổi tài khoản: bỏ ngay dữ liệu của tài khoản trước và mọi lần đọc đang chờ của nó
    groupsSeqRef.current++; membersSeqRef.current++;
    groupsOwnerRef.current = null; membersOwnerRef.current = null;
    setGroupsLoadFailed(false); setMembersFailure(null);
    setGroupsReading(false); setMembersReading(false);
    setGroups([]); setMembers([]); setSelectedGroupId(null);
    setMembersLastFetched(0); setSelectedMemberIds(new Set());
    if (activeAccountId) loadGroupsFromDB();
  }, [activeAccountId]);

  useEffect(() => {
    membersSeqRef.current++; // bỏ kết quả đang chờ của nhóm trước
    membersOwnerRef.current = null;
    setMembersFailure(null); setMembersReading(false);
    setMembers([]); setMembersLastFetched(0); setSelectedMemberIds(new Set());
    if (selectedGroupId) loadMembersFromDB(selectedGroupId);
  }, [selectedGroupId]);

  const retryMembers = () => { if (selectedGroupId) loadMembersFromDB(selectedGroupId); };

  // ── Chế độ nhân viên: kết nối BOSS phục hồi → tải lại nhóm + thành viên nhóm đang xem (+ chiến dịch nếu đang chọn
  // mà lần trước lỗi). Lần đọc lỗi lúc mất kết nối đã giữ dữ liệu cũ, giờ làm mới.
  useEmployeeResync(() => Promise.allSettled([
    loadGroupsFromDB(),
    selectedGroupId ? loadMembersFromDB(selectedGroupId) : Promise.resolve(false),
    showCampaignPicker && campaignsLoadFailed ? loadPickerCampaigns() : Promise.resolve(false),
  ]));

  // ── Listen for external navigation to scan tab (from TopBar "Kiếm tiền") ──
  useEffect(() => {
    const handler = () => {
      setActiveTab('scan');
      try { localStorage.removeItem('crm_open_scan_tab'); } catch {}
    };
    window.addEventListener('crm:openScanTab', handler);
    // Also check localStorage on mount (in case event fired before component mounted)
    try {
      if (localStorage.getItem('crm_open_scan_tab') === 'true') {
        localStorage.removeItem('crm_open_scan_tab');
        setActiveTab('scan');
      }
    } catch {}
    return () => window.removeEventListener('crm:openScanTab', handler);
  }, []);

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
      <div className="flex items-center border-b border-border flex-shrink-0 bg-card">
        <button
          onClick={() => setActiveTab('members')}
          className={`px-5 py-2.5 text-sm font-medium transition-colors relative
            ${activeTab === 'members'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-muted-foreground hover:text-foreground'}`}>
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
              : 'text-muted-foreground hover:text-foreground'}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Quét thành viên
          {!scanTabSeen && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────── */}
      {activeTab === 'scan' ? (
        /* ── Tab: Quét thành viên (Miễn phí) ──────────────────────────────── */
        <div className="flex-1 overflow-y-auto bg-card">
          <div className="mx-auto px-6 py-6 space-y-5 relative">

            {/* Header */}
            <div className="text-center pb-2 relative">
              <h2 className="text-lg font-bold text-foreground">Quét thành viên nhóm ẩn</h2>
              <p className="text-sm text-muted-foreground mt-1">Tiếp cận hàng nghìn khách hàng tiềm năng từ các nhóm Zalo chất lượng</p>
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-400"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>, title: 'Nhóm ẩn thành viên', desc: 'Bạn đã tham gia nhưng admin ẩn danh sách - quét vẫn lấy được hết' },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, title: 'Nhóm chờ duyệt', desc: 'Chưa được duyệt vào nhóm vẫn quét được thành viên - không cần chờ admin phê duyệt' },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>, title: 'Nhanh chóng', desc: '1000+ thành viên chỉ trong vài giây' },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-400"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>, title: 'Kết quả chi tiết', desc: 'Tên, ảnh đại diện, UID - thêm vào chiến dịch kết bạn, nhắn tin, mời vào nhóm ngay' },
              ].map((f, i) => (
                <div key={i} className="bg-card border border-border rounded-xl p-3.5 flex gap-3">
                  <div className="w-9 h-9 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">{f.icon}</div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{f.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Scan input */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={scanLinkInput}
                  onChange={e => { setScanLinkInput(e.target.value); setScanTabError(''); setResolvedGroupInfo(null); }}
                  onKeyDown={e => { if (e.key === 'Enter' && !scanTabLoading) handleScanTab(); }}
                  placeholder="Dán link nhóm Zalo (vd: https://zalo.me/g/xxxxxx)"
                  disabled={scanTabLoading}
                  className="flex-1 bg-card border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 disabled:opacity-50"
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
                <button
                  onClick={() => {
                    if (!scanLinkInput.trim()) return;
                    // Extract groupId from link or use input directly
                    let groupId = scanLinkInput.trim();
                    let groupName = '';
                    if (resolvedGroupInfo) {
                      groupId = resolvedGroupInfo.groupId;
                      groupName = resolvedGroupInfo.name;
                    }
                    setShareGroupInfo({
                      groupId,
                      groupName: groupName || groupId,
                      groupAvatar: resolvedGroupInfo?.avatar || '',
                      memberCount: 0,
                    });
                    setShowShareModal(true);
                  }}
                  disabled={!scanLinkInput.trim()}
                  className="px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                  </svg>
                  Chia sẻ
                </button>
              </div>
              <p className="text-[12px] text-muted-foreground">Kết quả khi quét xong sẽ lưu vào tab `Thành viên nhóm` để bạn sử dụng thêm vào chiến dịch.</p>
              <p className="text-[12px] text-muted-foreground">UID thành viên nhóm không thể chia sẻ giữa các tài khoản với nhau do chính sách từ Zalo.</p>
              <p className="text-[12px] text-muted-foreground">Nếu bạn quét nhóm chưa join cần ít nhất ở chế độ chờ duyệt, với trường hợp nhóm tắt chờ duyệt thì bạn không thể quét được nhóm này.</p>
              <p className="text-[12px] text-muted-foreground">Bạn có thể chia sẻ group cho cộng đồng để xây dựng kho nhóm dùng chung toàn bộ app.</p>
            </div>

            {/* Resolved group info card */}
            {resolvedGroupInfo && (
              <div className="bg-card border border-purple-500/30 rounded-xl p-4 flex items-center gap-3">
                {resolvedGroupInfo.avatar ? (
                  <img src={resolvedGroupInfo.avatar} alt={resolvedGroupInfo.name}
                    className="w-12 h-12 rounded-xl object-cover flex-shrink-0"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                    {(resolvedGroupInfo.name || '?').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{resolvedGroupInfo.name}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">ID: {resolvedGroupInfo.groupId}</p>
                </div>
                <button onClick={() => setResolvedGroupInfo(null)}
                  className="text-subtle-foreground hover:text-foreground/80 transition-colors p-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            )}

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
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Đã quét xong</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      <span className="text-green-400 font-medium">{scanTabResults.length}</span> thành viên · Đã lưu vào tab Thành viên nhóm
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setActiveTab('members');
                      setSelectedGroupId(scanTabGroupId);
                    }}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors">
                    Xem trong tab Thành viên →
                  </button>
                  <button
                    onClick={() => {
                      setShareGroupInfo({
                        groupId: scanTabGroupId || '',
                        groupName: resolvedGroupInfo?.name || scanTabGroupId || '',
                        groupAvatar: resolvedGroupInfo?.avatar || '',
                        memberCount: scanTabResults.length,
                      });
                      setShowShareModal(true);
                    }}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                    </svg>
                    Chia sẻ nhóm này
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto divide-y divide-border/50">
                  {scanTabResults.slice(0, 50).map((m, i) => (
                    <div key={m.userId || i} className="flex items-center gap-3 px-4 py-2.5">
                      <Avatar src={m.avatar} name={m.displayName || m.userId} size={32} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{m.displayName || m.userId}</p>
                        <p className="text-[11px] text-subtle-foreground">{m.userId}</p>
                      </div>
                    </div>
                  ))}
                  {scanTabResults.length > 50 && (
                    <div className="px-4 py-2 text-xs text-subtle-foreground text-center">
                      ... và {scanTabResults.length - 50} thành viên khác. Xem đầy đủ ở tab Thành viên nhóm.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Shared groups description */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-green-500/15 flex items-center justify-center flex-shrink-0">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
                      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                    </svg>
                  </div>
                  <div>
                    <p className="text-md font-semibold text-foreground">Nhóm chung từ cộng đồng</p>
                    <p className="text-[10px] text-foreground/80">Cùng nhau phát triển, chia sẻ giá trị</p>
                  </div>
                </div>
              </div>

              {/* Benefits grid */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { icon: '🎯', title: 'Tiết kiệm thời gian', desc: 'Không cần tự tìm nhóm, đã có danh sách nhóm chất lượng' },
                  { icon: '🤝', title: 'Cùng nhau phát triển', desc: 'Chia sẻ nhóm tốt giúp cộng đồng cùng tiếp cận khách hàng' },
                  { icon: '✅', title: 'Đảm bảo chất lượng', desc: 'Mọi nhóm đều qua kiểm duyệt, không spam không ảo hoặc nhóm ít thành viên' },
                ].map((b, i) => (
                    <div key={i} className="bg-muted/30 rounded-lg p-2 text-center">
                      <span className="text-base">{b.icon}</span>
                      <p className="text-[14px] text-foreground font-medium mt-1 leading-tight">{b.title}</p>
                      <p className="text-[12px] text-muted-foreground mt-0.5 leading-tight">{b.desc}</p>
                    </div>
                ))}
              </div>

              {/* CTA */}
              <button
                  onClick={() => setShowSharedGroupsPopup(true)}
                  className="w-full py-4 bg-green-600/10 hover:bg-green-600/20 border border-green-500/20 text-green-400 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                </svg>
                Khám phá kho nhóm chung
              </button>
            </div>

            {/* How it works */}
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs font-medium text-foreground/80 mb-3">Cách sử dụng</p>
              <div className="space-y-2.5">
                {[
                  { step: '1', text: 'Dán link nhóm Zalo vào ô bên trên' },
                  { step: '2', text: 'Nhấn Tham gia nếu chưa là thành viên' },
                  { step: '3', text: 'Nhấn Quét → kết quả hiện ở tab Thành viên nhóm' },
                  { step: '4', text: 'Chọn thành viên → thêm vào chiến dịch, gửi tin, kết bạn...' },
                ].map(s => (
                  <div key={s.step} className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-muted text-[11px] font-bold text-foreground/80 flex items-center justify-center flex-shrink-0 mt-0.5">{s.step}</span>
                    <p className="text-xs text-muted-foreground leading-relaxed">{s.text}</p>
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
      <div className="w-72 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Danh sách nhóm
              {groups.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({groups.length})</span>}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Từ danh sách hội thoại</p>
          </div>
          {/* 3-dot menu */}
          <div ref={groupMenuRef} className="relative flex-shrink-0">
            <button
              onClick={() => setShowGroupMenu(v => !v)}
              disabled={groupsLoading}
              title="Tùy chọn đồng bộ nhóm"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-muted hover:bg-accent disabled:opacity-50 text-foreground/80 text-lg font-bold transition-colors leading-none">
              ⋮
            </button>
            {showGroupMenu && (
              <div className="absolute right-0 top-full mt-1 bg-card border border-input rounded-xl shadow-xl z-30 min-w-[210px] overflow-hidden py-1">
                <button
                  onClick={() => { fetchGroupsFromAPI(); setShowGroupMenu(false); }}
                  disabled={groupsLoadFailed}
                  title={groupsLoadFailed ? 'Chưa đọc được dữ liệu nhóm hiện có — bấm "Thử lại" ở danh sách nhóm trước' : undefined}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                  {groupsLoading ? SpinIcon : RefreshIcon}
                  <span>Tải toàn bộ nhóm từ Zalo</span>
                </button>
                <button
                  onClick={() => { setShowLinkScanModal(true); setLinkScanInput(''); setLinkScanError(''); setLinkScanResult(null); setLinkJoinStatus('idle'); setLinkJoinMsg(''); setShowGroupMenu(false); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors text-left">
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
          <div className="px-3 py-2 border-b border-border/50 flex-shrink-0">
            <input type="text" value={searchGroup} onChange={e => setSearchGroup(e.target.value)}
              placeholder="Tìm nhóm..."
              className="w-full bg-card border border-input rounded-lg px-3 py-1.5 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
          </div>
        )}

        <div className="flex-1 overflow-y-auto bg-card">
          {groups.length > 0 && groupsLoadFailed && (
            <LoadFailedNotice className="justify-start px-3" text="Không tải được dữ liệu nhóm mới nhất"
              onRetry={loadGroupsFromDB} busy={groupsReading} />
          )}
          {groups.length === 0 && groupsLoadFailed ? (
            // Lỗi ≠ "chưa có nhóm": không gợi ý "Tải từ API" (đồng bộ dựa trên dữ liệu đọc thiếu)
            <LoadFailedNotice className="h-full" text="Không tải được danh sách nhóm" onRetry={loadGroupsFromDB} busy={groupsReading} />
          ) : groups.length === 0 ? (
            <EmptyState icon={GroupIcon} title="Chưa có dữ liệu nhóm"
              desc={<>Nhấn <span className="text-blue-400 font-medium">Tải từ API</span> để đồng bộ nhóm từ Zalo.</>} />
          ) : filteredGroups.length === 0 ? (
            <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">Không tìm thấy nhóm</div>
          ) : (
            <div className="py-1">
              {filteredGroups.map(group => (
                  <button key={group.contact_id} onClick={() => setSelectedGroupId(group.contact_id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors
                    ${selectedGroupId === group.contact_id ? 'bg-blue-500/10 border-r-2 border-blue-500' : ''}`}>
                  <GroupAvatar
                    id={group.contact_id}
                    avatarUrl={group.avatar_url}
                    groupInfo={activeAccountId ? (groupInfoCache[activeAccountId] || {})[group.contact_id] : undefined}
                    name={group.display_name}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate font-medium">{group.display_name}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
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
            desc={groups.length === 0 && groupsLoadFailed
              ? 'Chưa tải được danh sách nhóm — bấm "Thử lại" ở cột bên trái.'
              : groups.length === 0
              ? 'Hãy tải danh sách nhóm từ API trước.'
              : 'Chọn một nhóm bên trái để xem danh sách thành viên.'} />
        ) : (
          <>
            {/* Members header */}
            <div className="px-5 py-3 border-b border-border flex items-center gap-3 flex-shrink-0 flex-wrap">
              <GroupAvatar
                id={selectedGroup.contact_id}
                avatarUrl={selectedGroup.avatar_url}
                groupInfo={activeAccountId ? (groupInfoCache[activeAccountId] || {})[selectedGroup.contact_id] : undefined}
                name={selectedGroup.display_name}
                size="xs"
              />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-foreground truncate">{selectedGroup.display_name}</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {members.length > 0
                    ? <>{members.length} thành viên{membersLastFetched > 0 && <span className="ml-2 text-muted-foreground">· {formatTime(membersLastFetched)}</span>}</>
                    : membersFailure === 'members' ? 'Không tải được dữ liệu thành viên' : 'Chưa có dữ liệu thành viên'}
                </p>
              </div>
              {/* Tải thành viên từ API quét nhóm dùng chung — khoá khi chưa đọc được thành viên hiện có */}
              <button onClick={fetchMembersFromAPI} disabled={membersLoading || membersFailure === 'members'}
                title={membersFailure === 'members' ? 'Chưa đọc được dữ liệu thành viên hiện có — bấm "Thử lại" trước' : undefined}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium transition-colors flex-shrink-0">
                {membersLoading ? SpinIcon : RefreshIcon}
                {membersLoading ? 'Đang tải...' : 'Tải thông tin thành viên'}
              </button>
              {/* Xuất danh sách thành viên */}
              {filteredMembers.length > 0 && (
                <button onClick={() => {
                  const escapeCSV = (v: any): string => {
                    const s = String(v ?? '');
                    // Excel tự chuyển số dài (SĐT, UID) thành scientific notation → ép giữ dạng text
                    if (/^\d+$/.test(s) && s.length >= 5) return '="' + s + '"';
                    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
                      return '"' + s.replace(/"/g, '""') + '"';
                    return s;
                  };
                  const headers = ['STT', 'Tên', 'UID', 'Số điện thoại', 'Vai trò'];
                  const rows = filteredMembers.map((m, i) => [
                    i + 1,
                    escapeCSV(m.display_name || ''),
                    escapeCSV(m.member_id),
                    escapeCSV(m.phone || ''),
                    escapeCSV(roleLabel(m.role).text),
                  ].join(','));
                  const csv = [headers.join(','), ...rows].join('\r\n');
                  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `thanh_vien_${selectedGroup?.display_name || selectedGroupId}_${new Date().toISOString().split('T')[0]}.csv`;
                  document.body.appendChild(a); a.click(); document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  setExportNotif({ message: `Đã xuất ${filteredMembers.length} thành viên` });
                  setTimeout(() => setExportNotif(null), 4000);
                }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-medium transition-colors flex-shrink-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Xuất danh sách
                </button>
              )}
            </div>

            {/* Search + select-all row */}
            <div className="px-4 py-2 border-b border-border/50 flex items-center gap-2 flex-shrink-0">
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
                     className="flex-1 bg-card border border-input rounded-lg px-3 py-1.5 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
            </div>

            {/* Members list */}
            <div className="flex-1 overflow-y-auto pb-16">
              {members.length > 0 && membersLoadFailed && (
                <LoadFailedNotice className="justify-start px-4"
                  text={membersFailure === 'phones' ? 'Không tải được số điện thoại mới nhất' : 'Không tải được dữ liệu thành viên mới nhất'}
                  onRetry={retryMembers} busy={membersReading} />
              )}
              {members.length === 0 && membersFailure === 'members' ? (
                // Lỗi ≠ "chưa có thành viên": không gợi ý "Tải thành viên" (lưu dựa trên dữ liệu đọc thiếu)
                <LoadFailedNotice className="h-full" text="Không tải được danh sách thành viên" onRetry={retryMembers} busy={membersReading} />
              ) : members.length === 0 ? (
                <EmptyState
                  icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
                  title="Chưa có dữ liệu thành viên"
                  desc={<>Nhấn <span className="text-blue-400 font-medium">Tải thành viên</span> để đồng bộ từ Zalo về DB.<br/><span className="text-muted-foreground text-[11px]">Lưu ý: cần tải nhóm từ API trước để có danh sách UID.</span></>}
                />
              ) : filteredMembers.length === 0 ? (
                <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">Không tìm thấy thành viên</div>
              ) : (
                <div className="p-2 space-y-0.5">
                  {filteredMembers.map(member => {
                    const rl = roleLabel(member.role);
                    const isSelected = selectedMemberIds.has(member.member_id);
                    return (
                      <div key={member.member_id}
                        onClick={() => toggleMember(member.member_id)}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors select-none
                          ${isSelected ? 'bg-blue-500/15 border border-blue-500/30' : 'hover:bg-card/60 border border-transparent'}`}>
                        <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-colors
                          ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-input bg-card'}`}>
                          {isSelected && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          )}
                        </div>
                        <Avatar src={member.avatar} name={member.display_name || member.member_id} size={34} />
                        <div className="flex-1 min-w-0">
                          {member.display_name
                            ? <p className="text-sm text-foreground truncate font-medium">{member.display_name}</p>
                            : <p className="text-sm text-muted-foreground truncate italic">
                                Chưa có tên -{' '}
                                {member.phone
                                  ? <PhoneDisplay phone={member.phone} className="text-muted-foreground" />
                                  : member.member_id}
                              </p>}
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {member.phone
                              ? <>
                                  <PhoneDisplay phone={member.phone} className="text-green-400" />
                                  <div className="text-muted-foreground">{member.member_id}</div>
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

            {/* ── Bottom action bar ─────────────────── */}
            <div className="absolute bottom-0 left-72 right-0 bg-card/95 backdrop-blur border-t border-input px-5 py-3 z-10">
              {/* Row 1: Selection info + Bỏ chọn */}
              {selectedMemberIds.size > 0 && (
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-sm text-foreground font-medium">
                    Đã chọn <span className="text-blue-400">{selectedMemberIds.size}</span> thành viên
                  </span>
                  <div className="flex-1"/>
                  <button onClick={clearSelection}
                    className="px-3 py-1.5 rounded-lg bg-muted hover:bg-accent text-foreground/80 text-xs transition-colors">
                    Bỏ chọn
                  </button>
                </div>
              )}
              {/* Row 2: Action buttons (always visible, disabled when none selected) */}
              <div className="flex items-center gap-3">
                <button onClick={openCampaignPicker} disabled={selectedMemberIds.size === 0}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedMemberIds.size === 0
                      ? 'bg-muted text-subtle-foreground cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                  </svg>
                  Thêm vào chiến dịch
                </button>
                <button onClick={() => setShowAddToContacts(true)} disabled={selectedMemberIds.size === 0}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedMemberIds.size === 0
                      ? 'bg-muted text-subtle-foreground cursor-not-allowed'
                      : 'bg-green-600 hover:bg-green-700 text-white'
                  }`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
                    <line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
                  </svg>
                  Thêm vào liên hệ
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Campaign picker modal ──────────────────────────────────────────── */}
      {showCampaignPicker && !showCreateCampaign && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowCampaignPicker(false)}>
          <div className="bg-card border border-input rounded-2xl w-80 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-foreground">Thêm vào chiến dịch</h3>
              <button
                onClick={() => setShowCreateCampaign(true)}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-lg hover:bg-blue-500/10">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Tạo mới
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Áp dụng cho <span className="text-blue-400 font-medium">{selectedMemberIds.size}</span> thành viên đã chọn
            </p>

            {localCampaigns.length > 0 && campaignsLoadFailed && (
              <LoadFailedNotice className="justify-start px-0 pt-0" text="Không tải được danh sách chiến dịch mới nhất"
                onRetry={loadPickerCampaigns} busy={campaignsLoading} />
            )}
            {localCampaigns.length === 0 && campaignsLoadFailed ? (
              // Lỗi ≠ "chưa có chiến dịch": không gợi ý tạo chiến dịch mới (dễ tạo trùng)
              <LoadFailedNotice className="py-6" text="Không tải được danh sách chiến dịch" onRetry={loadPickerCampaigns} busy={campaignsLoading} />
            ) : localCampaigns.length === 0 ? (
              <div className="py-6 flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                  </svg>
                </div>
                <div className="text-center">
                  <p className="text-sm text-foreground/80 font-medium">Chưa có chiến dịch nào</p>
                  <p className="text-xs text-muted-foreground mt-1">Tạo chiến dịch mới để bắt đầu gửi tin</p>
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
                      ${pickedCampaignId === c.id ? 'border-blue-500 bg-blue-500/20 text-foreground' : 'border-input text-foreground/80 hover:border-border-strong'}`}>
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.status === 'active' ? 'bg-green-400' : c.status === 'paused' ? 'bg-yellow-400' : 'bg-accent'}`} />
                      {c.name}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5 pl-3">{c.total_contacts ?? 0} liên hệ</span>
                  </button>
                ))}
              </div>
            )}

            {localCampaigns.length > 0 && (
              <div className="flex gap-2">
                <button onClick={() => setShowCampaignPicker(false)}
                  className="flex-1 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent transition-colors">
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
                className="w-full mt-2 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent transition-colors">
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
          <div className="bg-card border border-input rounded-2xl w-[420px] p-6 shadow-2xl"
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
                <h3 className="font-semibold text-foreground text-sm">Join nhóm theo link</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Nhập link mời nhóm Zalo để tham gia nhóm</p>
                <p className="text-xs text-muted-foreground mt-0.5">Các nhóm công khai thành viên mới quét được thành viên</p>
              </div>
            </div>

            {/* Input */}
            <div className="mb-4">
              <label className="text-xs text-muted-foreground mb-1.5 block">Đường dẫn nhóm</label>
              <input
                value={linkScanInput}
                onChange={e => { setLinkScanInput(e.target.value); setLinkJoinStatus('idle'); setLinkJoinMsg(''); }}
                onKeyDown={e => { if (e.key === 'Enter' && !linkScanLoading) scanGroupByLink(); }}
                placeholder="https://zalo.me/g/..."
                disabled={linkScanLoading}
                className="w-full bg-muted border border-input rounded-xl px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-purple-500 disabled:opacity-60"
              />
            </div>

            {/* Progress bar */}
            {linkScanProgress !== null && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                  <span className="flex items-center gap-1.5">
                    {SpinIcon}
                    <span>Đang tải thông tin thành viên: <span className="text-foreground font-medium">{linkScanProgress.current}</span>/{linkScanProgress.total}</span>
                  </span>
                  <span className="text-purple-400 font-medium">{Math.round((linkScanProgress.current / linkScanProgress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
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
              <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
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
                <span className="text-muted-foreground ml-1">({linkScanResult.groupId})</span>
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
                className="flex-1 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent disabled:opacity-40 transition-colors">
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
          <div className="bg-card border border-input rounded-2xl w-[420px] p-6 shadow-2xl">

            {groupFetchProgress.phase === 'groups' ? (
              /* ── Phase 1: Sync groups ── */
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                    {SpinIcon}
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground text-sm">Đang đồng bộ nhóm Zalo</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">Tổng cộng <span className="text-foreground font-medium">{groupFetchProgress.total}</span> nhóm · Bước 1/2</p>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="text-muted-foreground">
                    Đã xử lý: <span className="text-foreground font-semibold">{groupFetchProgress.current}</span>
                    <span className="text-muted-foreground"> / {groupFetchProgress.total}</span>
                  </span>
                  <span className="text-blue-400 font-semibold text-sm">
                    {Math.round((groupFetchProgress.current / groupFetchProgress.total) * 100)}%
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-300"
                    style={{ width: `${(groupFetchProgress.current / groupFetchProgress.total) * 100}%` }} />
                </div>
                <p className="text-[11px] text-muted-foreground mt-3 text-center">
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
                    <h3 className="font-semibold text-foreground text-sm">Đang tải chi tiết thành viên · Bước 2/2</h3>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      Nhóm <span className="text-foreground font-medium">{groupFetchProgress.groupCurrent}/{groupFetchProgress.groupTotal}</span>
                      {groupFetchProgress.currentGroupName && (
                        <span className="ml-1 text-muted-foreground truncate">· {groupFetchProgress.currentGroupName}</span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Group progress */}
                <div className="mb-3">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Tiến độ nhóm</span>
                    <span className="text-green-400 font-semibold">
                      {Math.round((groupFetchProgress.groupCurrent / groupFetchProgress.groupTotal) * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-green-500 to-green-400 rounded-full transition-all duration-300"
                      style={{ width: `${(groupFetchProgress.groupCurrent / groupFetchProgress.groupTotal) * 100}%` }} />
                  </div>
                </div>

                {/* Member progress */}
                {groupFetchProgress.memberTotal > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted-foreground">
                        Thành viên: <span className="text-foreground">{groupFetchProgress.memberCurrent}</span>/{groupFetchProgress.memberTotal}
                      </span>
                      <span className="text-blue-400 font-semibold">
                        {Math.round((groupFetchProgress.memberCurrent / groupFetchProgress.memberTotal) * 100)}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full transition-all duration-300"
                        style={{ width: `${(groupFetchProgress.memberCurrent / groupFetchProgress.memberTotal) * 100}%` }} />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between mt-3">
                  <p className="text-[11px] text-muted-foreground">Đang tải SĐT + thông tin thành viên từ Zalo...</p>
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

      {/* ── Share Group Modal ──────────────────────────────────────────── */}
      {showShareModal && shareGroupInfo && (() => {
        const acc = useAccountStore.getState().getActiveAccount();
        return (
          <ShareGroupModal
            groupId={shareGroupInfo.groupId}
            groupName={shareGroupInfo.groupName}
            groupAvatar={shareGroupInfo.groupAvatar}
            memberCount={shareGroupInfo.memberCount}
            pageId={activeAccountId}
            displayName={acc?.display_name || acc?.full_name || activeAccountId}
            avatarUrl={acc?.avatar_url || ''}
            onClose={() => { setShowShareModal(false); setShareGroupInfo(null); }}
            onSubmitted={() => { setShowShareModal(false); setShareGroupInfo(null); }}
          />
        );
      })()}

      {/* ── Shared Groups Category Popup ──────────────────────────────── */}
      {showSharedGroupsPopup && (
        <SharedGroupsCategoryPopup
          pageId={activeAccountId}
          onClose={() => setShowSharedGroupsPopup(false)}
          onShareGroup={() => {
            setShowSharedGroupsPopup(false);
            setShareGroupInfo({
              groupId: '',
              groupName: '',
              groupAvatar: '',
              memberCount: 0,
            });
            setShowShareModal(true);
          }}
          onBulkImport={() => {
            setShowSharedGroupsPopup(false);
            setShowBulkImport(true);
          }}
        />
      )}

      {/* ── Bulk Import Groups Modal ──────────────────────────────────── */}
      {showBulkImport && (
        <BulkImportGroupsModal
          pageId={activeAccountId}
          onClose={() => setShowBulkImport(false)}
          onImported={() => {
            setShowBulkImport(false);
            // Reload groups from DB
            loadGroupsFromDB?.();
          }}
        />
      )}

      {/* ── Export success notification ──────────────────────────────── */}
      {exportNotif && (
        <div className="fixed bottom-4 right-4 z-50 bg-card border border-green-500/30 rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3 max-w-sm"
          style={{ animation: 'slideUp 0.2s ease-out' }}>
          <div className="w-8 h-8 rounded-lg bg-green-500/15 flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground font-medium">{exportNotif.message}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">File đã được tải xuống</p>
          </div>
          <button onClick={() => setExportNotif(null)}
            className="text-subtle-foreground hover:text-foreground/80 transition-colors p-1 flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      )}

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

/** Telegram deliberately gets a compact CRM group view. The Zalo-only hidden
 * member scan has no Telegram API equivalent, so it does not leak here. */
function TelegramGroupMembersTab({ channel }: { channel: 'telegram_user' | 'telegram_bot' }) {
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const setGroupCount = useCRMStore(s => s.setGroupCount);
  const showNotification = useAppStore(s => s.showNotification);
  const [groups, setGroups] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingGroups, setRefreshingGroups] = useState(false);
  const [memberLoading, setMemberLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [showCampaignPicker, setShowCampaignPicker] = useState(false);
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [pickedCampaignId, setPickedCampaignId] = useState<number | null>(null);
  const [addingToCampaign, setAddingToCampaign] = useState(false);
  const [showAddToContacts, setShowAddToContacts] = useState(false);

  // ── Lần đọc từ BOSS lỗi (employee: mất kết nối) — giữ dữ liệu đang có của đúng tài khoản / nhóm, báo "Thử lại" ──
  const [groupsLoadFailed, setGroupsLoadFailed] = useState(false);
  const [membersLoadFailed, setMembersLoadFailed] = useState(false);
  const [campaignsLoadFailed, setCampaignsLoadFailed] = useState(false);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  /** Chủ của dữ liệu đang hiện: nhóm = `tàiKhoản:kênh`, thành viên = `tàiKhoản:nhóm`, chiến dịch = tài khoản. */
  const groupsOwnerRef = useRef<string | null>(null);
  const membersOwnerRef = useRef<string | null>(null);
  const campaignsOwnerRef = useRef<string | null>(null);
  // Chỉ lần đọc mới nhất được ghi state (chọn nhóm khác / đổi tài khoản trong lúc chờ)
  const groupsSeqRef = useRef(0);
  const membersSeqRef = useRef(0);
  const campaignsSeqRef = useRef(0);
  const membersRef = useRef<any[]>(members);
  membersRef.current = members;

  const normaliseMember = useCallback((member: any): {
    id: string; firstName: string; lastName: string; username: string;
    phone: string; avatar: string; role: number;
  } => ({
    id: String(member.id || member.memberId || member.member_id || ''),
    firstName: member.firstName || member.displayName || member.display_name || '',
    lastName: member.lastName || '',
    username: member.username || '',
    phone: member.phone || '',
    avatar: member.avatar || member.avatar_url || '',
    role: Number(member.role || 0),
  }), []);

  const loadGroups = useCallback(async () => {
    if (!activeAccountId) return;
    const owner = `${activeAccountId}:${channel}`;
    const seq = ++groupsSeqRef.current;
    setLoading(true);
    try {
      const res = await DataAccessor.getConversations(activeAccountId, 999, 0);
      if (seq !== groupsSeqRef.current) return; // có lần đọc mới hơn
      if (isReadFailure(res)) {
        // Lỗi → giữ danh sách (và nhóm đang chọn) của đúng tài khoản; của tài khoản khác thì bỏ
        if (readOutcome(true, groupsOwnerRef.current, owner) === 'clear') {
          groupsOwnerRef.current = owner;
          setGroups([]);
          setSelectedId(null);
          setMembers([]);
          setSelectedMemberIds(new Set());
        }
        setGroupsLoadFailed(true);
        return;
      }
      const all = (res as any)?.items || [];
      const next = all.filter((c: any) => c.contact_type === 'group' && c.channel === channel && isTelegramMemberGroup(c));
      groupsOwnerRef.current = owner;
      setGroups(next);
      setGroupCount(next.length);
      setGroupsLoadFailed(false);
      if (selectedId && !next.some((g: any) => g.contact_id === selectedId)) setSelectedId(null);
    } catch (err) {
      console.warn('[GroupMembersTab] Telegram loadGroups error:', err);
      if (seq === groupsSeqRef.current) setGroupsLoadFailed(true);
    } finally {
      if (seq === groupsSeqRef.current) setLoading(false);
    }
  }, [activeAccountId, channel, selectedId, setGroupCount]);

  // Đổi tài khoản / kênh: bỏ ngay nhóm + thành viên của tài khoản trước (không chọn / thao tác nhầm trong lúc tải)
  const viewOwner = `${activeAccountId || ''}:${channel}`;
  const viewOwnerRef = useRef(viewOwner);
  useEffect(() => {
    if (viewOwnerRef.current === viewOwner) return;
    viewOwnerRef.current = viewOwner;
    groupsSeqRef.current++; membersSeqRef.current++;
    groupsOwnerRef.current = null; membersOwnerRef.current = null;
    setGroups([]); setSelectedId(null); setMembers([]); setSelectedMemberIds(new Set());
    setGroupsLoadFailed(false); setMembersLoadFailed(false);
  }, [viewOwner]);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  /**
   * Resolve only a bounded batch of rows without avatars. This is intentionally
   * not a whole-account scan: Telegram photo downloads are costly and can make
   * the MTProto connection unstable on large accounts.
   */
  const refreshGroupsAndMissingAvatars = useCallback(async () => {
    if (!activeAccountId || refreshingGroups) return;
    if (channel !== 'telegram_user') {
      await loadGroups();
      return;
    }
    setRefreshingGroups(true);
    try {
      const res = await DataAccessor.getConversations(activeAccountId, 999, 0);
      if (isReadFailure(res)) {
        // Lỗi → giữ danh sách đang có (trước đây bị thay bằng rỗng), không quét avatar dựa trên danh sách rỗng
        setGroupsLoadFailed(true);
        return;
      }
      const all = (res as any)?.items || [];
      const initialGroups = all.filter((contact: any) => contact.contact_type === 'group' && contact.channel === channel && isTelegramMemberGroup(contact));
      const candidates = initialGroups.filter((group: any) =>
        !group.telegram_peer_type || (!group.avatar_url && !group.avatar)
      ).slice(0, 12);
      const excludedChannelIds = new Set<string>();
      const avatarByGroupId = new Map<string, string>();

      for (const group of candidates) {
        const infoRes = await (ipc.telegramUser as any)?.getGroupInfo({ accountId: activeAccountId, chatId: group.contact_id });
        if (!infoRes?.success) continue;
        if (infoRes.info?.peerType === 'channel') {
          excludedChannelIds.add(String(group.contact_id));
          continue;
        }
        if (infoRes.info?.avatarUrl) avatarByGroupId.set(String(group.contact_id), infoRes.info.avatarUrl);
      }

      const next = initialGroups.filter((group: any) => !excludedChannelIds.has(String(group.contact_id))).map((group: any) => ({
        ...group,
        avatar_url: avatarByGroupId.get(String(group.contact_id)) || group.avatar_url || '',
      }));
      groupsOwnerRef.current = `${activeAccountId}:${channel}`;
      setGroups(next);
      setGroupCount(next.length);
      setGroupsLoadFailed(false);
      if (selectedId && !next.some((group: any) => group.contact_id === selectedId)) {
        setSelectedId(null);
        setMembers([]);
        setSelectedMemberIds(new Set());
      }
      const message = [
        avatarByGroupId.size ? `đã cập nhật ${avatarByGroupId.size} avatar` : '',
        excludedChannelIds.size ? `đã loại ${excludedChannelIds.size} kênh tin tức` : '',
      ].filter(Boolean).join(', ');
      if (message) showNotification(`Telegram Nhóm: ${message}`, 'success');
    } finally { setRefreshingGroups(false); }
  }, [activeAccountId, channel, refreshingGroups, selectedId, setGroupCount, showNotification, loadGroups]);

  const loadGroupMembers = useCallback(async (groupId: string) => {
    if (!activeAccountId || channel !== 'telegram_user') return;
    const owner = `${activeAccountId}:${groupId}`;
    const seq = ++membersSeqRef.current;
    setMemberLoading(true);
    try {
      // Show the persistent cache first. Avatar hydration is intentionally
      // backgrounded by the Telegram service to keep its MTProto connection stable.
      const cachedRes = await DataAccessor.getGroupMembers({ zaloId: activeAccountId, groupId });
      if (seq !== membersSeqRef.current) return; // đã chọn nhóm khác / có lần tải mới hơn
      // Đọc cache lỗi (employee: mất kết nối BOSS) → coi danh sách đang hiện của ĐÚNG nhóm này là cache: không làm
      // mất thành viên đã thu thập từ lịch sử tin nhắn khi gộp với danh sách Telegram bên dưới
      const cachedFailed = isReadFailure(cachedRes);
      const cached = cachedFailed
        ? (membersOwnerRef.current === owner ? membersRef.current : [])
        : ((cachedRes?.members || []) as any[])
          .map(normaliseMember)
          .filter(member => member.id);
      if (!cachedFailed && cached.length) {
        membersOwnerRef.current = owner;
        setMembers(cached);
      }
      setMembersLoadFailed(cachedFailed);

      const [groupInfo, memberRes] = await Promise.all([
        (ipc.telegramUser as any)?.getGroupInfo({ accountId: activeAccountId, chatId: groupId }),
        (ipc.telegramUser as any)?.getGroupMembers({ accountId: activeAccountId, chatId: groupId, limit: 200 }),
      ]);
      if (seq !== membersSeqRef.current) return;
      if (groupInfo?.success && groupInfo.info?.avatarUrl) {
        setGroups(previous => previous.map(group => group.contact_id === groupId
          ? { ...group, avatar_url: groupInfo.info.avatarUrl }
          : group));
      }
      if (groupInfo?.success && groupInfo.info?.peerType === 'channel') {
        setGroups(previous => {
          const next = previous.filter(group => group.contact_id !== groupId);
          setGroupCount(next.length);
          return next;
        });
        setSelectedId(null);
        setMembers([]);
        membersOwnerRef.current = null;
        setMembersLoadFailed(false);
        showNotification('Đây là kênh tin tức Telegram, không có danh sách thành viên để quản lý.', 'info');
        return;
      }
      if (memberRes?.success) {
        const cachedById = new Map(cached.map((member: any) => [member.id, member]));
        const fresh = ((memberRes.members || []) as any[])
          .map(normaliseMember)
          .filter(member => member.id)
          .map(member => ({ ...cachedById.get(member.id), ...member, avatar: member.avatar || cachedById.get(member.id)?.avatar || '' }));
        // Telegram chỉ trả về một phần participant list, trong khi những người
        // từng nhắn tin đã được lưu theo group_id ở DB. Giữ cả hai nguồn để
        // CRM không làm mất các thành viên đã thu thập từ lịch sử tin nhắn.
        const freshIds = new Set(fresh.map((member: any) => member.id));
        membersOwnerRef.current = owner;
        setMembers([...fresh, ...cached.filter((member: any) => !freshIds.has(member.id))]);
      } else if (!cached.length) {
        showNotification(memberRes?.error || 'Không thể tải thành viên nhóm', 'error');
      }
    } finally {
      if (seq === membersSeqRef.current) setMemberLoading(false);
    }
  }, [activeAccountId, channel, normaliseMember, showNotification]);

  const selectGroup = useCallback(async (groupId: string) => {
    setSelectedId(groupId);
    setMembers([]);
    membersOwnerRef.current = null;
    setMembersLoadFailed(false);
    setSelectedMemberIds(new Set());
    setMemberQuery('');
    await loadGroupMembers(groupId);
  }, [loadGroupMembers]);

  // Patch the currently displayed member as the Telegram main process finishes
  // downloading each photo into the local group-member cache.
  useEffect(() => {
    return ipc.on('event:groupMemberAvatar', (data: any) => {
      if (data?.zaloId !== activeAccountId || String(data?.groupId) !== String(selectedId) || !data?.avatar) return;
      setMembers(previous => previous.map(member => String(member.id) === String(data.memberId)
        ? { ...member, avatar: data.avatar, firstName: member.firstName || data.displayName || '' }
        : member));
    });
  }, [activeAccountId, selectedId]);

  const toggleMember = (memberId: string) => setSelectedMemberIds(previous => {
    const next = new Set(previous);
    next.has(memberId) ? next.delete(memberId) : next.add(memberId);
    return next;
  });

  // Chiến dịch cho cửa sổ chọn: lỗi → giữ danh sách của đúng tài khoản + báo lỗi; của tài khoản khác thì bỏ
  const loadPickerCampaigns = useCallback(async (): Promise<boolean> => {
    if (!activeAccountId) return false;
    const accountId = activeAccountId;
    const seq = ++campaignsSeqRef.current;
    setCampaignsLoading(true);
    let res: any;
    try {
      res = await DataAccessor.getCRMCampaigns({ zaloId: accountId });
    } catch (err: any) {
      res = { success: false, error: err?.message };
    }
    if (seq !== campaignsSeqRef.current) return false;
    setCampaignsLoading(false);
    if (res?.success) {
      campaignsOwnerRef.current = accountId;
      setCampaigns((res.campaigns || []).filter((campaign: any) => campaign.status !== 'done' && campaign.channel === channel));
      setCampaignsLoadFailed(false);
      return true;
    }
    if (isReadFailure(res)) {
      if (readOutcome(true, campaignsOwnerRef.current, accountId) === 'clear') {
        campaignsOwnerRef.current = accountId;
        setCampaigns([]);
      }
      setCampaignsLoadFailed(true);
    }
    return false;
  }, [activeAccountId, channel]);

  const openCampaignPicker = useCallback(async () => {
    if (!activeAccountId || selectedMemberIds.size === 0) return;
    await loadPickerCampaigns();
    setPickedCampaignId(null);
    setShowCampaignPicker(true);
  }, [activeAccountId, selectedMemberIds.size, loadPickerCampaigns]);

  const handleAddToCampaign = useCallback(async () => {
    if (!activeAccountId || !pickedCampaignId || selectedMemberIds.size === 0) return;
    setAddingToCampaign(true);
    try {
      const contacts = members.filter(member => selectedMemberIds.has(member.id)).map(member => ({
        contactId: member.id,
        displayName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.username || member.id,
        avatar: member.avatar || '',
      }));
      const res = await DataAccessor.addCampaignContacts({ zaloId: activeAccountId, campaignId: pickedCampaignId, contacts });
      if (res?.success === false) throw new Error(res.error || 'Không thể thêm vào chiến dịch');
      showNotification(`Đã thêm ${contacts.length} thành viên vào chiến dịch`, 'success');
      setShowCampaignPicker(false);
      setSelectedMemberIds(new Set());
    } catch (err: any) {
      showNotification(err?.message || 'Không thể thêm vào chiến dịch', 'error');
    } finally { setAddingToCampaign(false); }
  }, [activeAccountId, pickedCampaignId, selectedMemberIds, members, showNotification]);

  const handleCreateCampaign = useCallback(async (data: any) => {
    if (!activeAccountId) return;
    const res = await DataAccessor.saveCRMCampaign({ zaloId: activeAccountId, campaign: { ...data, channel } });
    if (res?.success === false) throw new Error(res.error || 'Không thể tạo chiến dịch');
    if (await loadPickerCampaigns() && res?.id) setPickedCampaignId(res.id);
  }, [activeAccountId, channel, loadPickerCampaigns]);

  // ── Chế độ nhân viên: kết nối BOSS phục hồi → tải lại danh sách nhóm; thành viên / chiến dịch chỉ khi lần trước lỗi
  // (tải thành viên còn gọi Telegram — không chạy lại mỗi lần kết nối hồi phục).
  useEmployeeResync(() => Promise.allSettled([
    loadGroups(),
    selectedId && membersLoadFailed ? loadGroupMembers(selectedId) : Promise.resolve(),
    showCampaignPicker && campaignsLoadFailed ? loadPickerCampaigns() : Promise.resolve(false),
  ]));

  const visibleGroups = groups.filter(g => (g.display_name || g.contact_id).toLowerCase().includes(query.toLowerCase()));
  const visibleMembers = members.filter(member => {
    const text = `${member.firstName || ''} ${member.lastName || ''} ${member.username || ''} ${member.id || ''}`.toLowerCase();
    return text.includes(memberQuery.toLowerCase());
  });
  const allVisibleSelected = visibleMembers.length > 0 && visibleMembers.every(member => selectedMemberIds.has(member.id));
  const selectedGroup = groups.find(g => g.contact_id === selectedId);
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* ── Left: Groups ──────────────────────────────────────────────────── */}
      <aside className="w-80 flex-shrink-0 border-r border-border flex flex-col bg-card">
        <div className="px-4 pt-4 pb-3 border-b border-border flex items-start gap-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Danh sách nhóm</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {groups.length > 0 ? `${groups.length} nhóm Telegram đã đồng bộ` : 'Nhóm Telegram đã đồng bộ'}
            </p>
          </div>
          <button onClick={refreshGroupsAndMissingAvatars} disabled={loading || refreshingGroups}
            title="Tải lại nhóm và avatar còn thiếu"
            className="flex items-center justify-center w-8 h-8 rounded-lg border border-input text-foreground/80 hover:text-foreground hover:border-border-strong hover:bg-card disabled:opacity-50 transition-colors flex-shrink-0">
            {loading || refreshingGroups ? SpinIcon : RefreshIcon}
          </button>
        </div>

        <div className="px-3 py-2.5 border-b border-border/60 flex-shrink-0">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>
            </svg>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm nhóm Telegram..."
              className="w-full bg-card border border-input rounded-lg pl-8 pr-3 py-2 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
          {groupsLoadFailed && groups.length > 0 && (
            <LoadFailedNotice className="justify-start px-1" text="Không tải được danh sách nhóm mới nhất"
              onRetry={loadGroups} busy={loading || refreshingGroups} />
          )}
          {visibleGroups.map(g => {
            const active = selectedId === g.contact_id;
            return (
              <button key={g.contact_id} onClick={() => selectGroup(g.contact_id)}
                className={`w-full text-left px-2.5 py-2 rounded-xl flex items-center gap-2.5 transition-colors border
                  ${active ? 'bg-blue-500/15 border-blue-500/40' : 'border-transparent hover:bg-card/70'}`}>
                <Avatar src={g.avatar_url || g.avatar} name={g.display_name || g.contact_id} size={34} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-xs truncate font-medium ${active ? 'text-foreground' : 'text-foreground'}`}>
                    {g.display_name || g.contact_id}
                  </span>
                  <span className="block text-[10px] text-muted-foreground mt-0.5 truncate">
                    {g.telegram_peer_type === 'forum' ? 'Diễn đàn'
                      : g.telegram_peer_type === 'supergroup' ? 'Siêu nhóm'
                      : g.telegram_peer_type === 'basic_group' ? 'Nhóm'
                      : 'Nhóm Telegram'}
                  </span>
                </span>
              </button>
            );
          })}
          {!loading && visibleGroups.length === 0 && (groupsLoadFailed && groups.length === 0 ? (
            <LoadFailedNotice className="p-5" text="Không tải được danh sách nhóm" onRetry={loadGroups} busy={refreshingGroups} />
          ) : (
            <p className="p-5 text-center text-xs text-muted-foreground leading-relaxed">
              Chưa có nhóm Telegram đã đồng bộ.
            </p>
          ))}
        </div>
      </aside>

      {/* ── Right: Members ────────────────────────────────────────────────── */}
      <section className="flex-1 min-w-0 flex flex-col">
        {!selectedId ? (
          <div className="m-auto text-center text-muted-foreground">
            <p className="text-sm">Chọn một nhóm để xem CRM nhóm</p>
            <p className="text-xs mt-1">Chỉ hiển thị nhóm đã có trong dữ liệu Telegram.</p>
          </div>
        ) : channel === 'telegram_bot' ? (
          <div className="m-auto text-center text-muted-foreground max-w-sm">
            <p className="text-sm">Telegram Bot không có danh sách thành viên đầy đủ.</p>
            <p className="text-xs mt-1">Bot API chỉ cho phép campaign tới chat mà bot đã nhận được hoặc nhóm bot đang tham gia.</p>
          </div>
        ) : (
          <>
            {/* Members header */}
            <div className="px-5 py-3.5 border-b border-border flex items-center gap-3 flex-shrink-0">
              <Avatar
                src={selectedGroup?.avatar_url || selectedGroup?.avatar}
                name={selectedGroup?.display_name || selectedId}
                size={38}
              />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground truncate">
                  {selectedGroup?.display_name || selectedId}
                </h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {members.length > 0 ? `${members.length} thành viên` : 'Chưa có dữ liệu thành viên'}
                </p>
              </div>
              <button onClick={() => loadGroupMembers(selectedId)} disabled={memberLoading} title="Tải lại thành viên"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium transition-colors flex-shrink-0">
                {memberLoading ? SpinIcon : RefreshIcon}
                {memberLoading ? 'Đang tải...' : 'Tải lại'}
              </button>
            </div>

            {/* Toolbar */}
            <div className="px-5 py-2.5 border-b border-border/60 flex items-center gap-2.5 flex-shrink-0">
              <div className="relative flex-1">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>
                </svg>
                <input value={memberQuery} onChange={event => setMemberQuery(event.target.value)} placeholder="Tìm thành viên..."
                  className="w-full bg-card border border-input rounded-lg pl-8 pr-3 py-2 text-xs text-foreground placeholder-subtle-foreground outline-none focus:border-blue-500 transition-colors" />
              </div>
              {visibleMembers.length > 0 && (
                <button onClick={() => setSelectedMemberIds(allVisibleSelected ? new Set() : new Set(visibleMembers.map(member => member.id)))}
                  className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors border
                    ${allVisibleSelected
                      ? 'bg-blue-600/20 border-blue-500/50 text-blue-300 hover:bg-blue-600/30'
                      : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'}`}>
                  {allVisibleSelected ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      Bỏ chọn
                    </>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg>
                      Tất cả ({visibleMembers.length})
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Members list */}
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {membersLoadFailed && members.length > 0 && !memberLoading && (
                <LoadFailedNotice className="justify-start px-2" text="Không tải được thành viên đã lưu — danh sách có thể thiếu"
                  onRetry={() => loadGroupMembers(selectedId)} />
              )}
              {memberLoading && members.length === 0 ? (
                <p className="p-5 text-xs text-muted-foreground">Đang tải thành viên…</p>
              ) : members.length === 0 && membersLoadFailed ? (
                <LoadFailedNotice className="p-5" text="Không tải được danh sách thành viên" onRetry={() => loadGroupMembers(selectedId)} />
              ) : visibleMembers.length === 0 ? (
                <p className="p-5 text-center text-xs text-muted-foreground">Không tìm thấy thành viên.</p>
              ) : (
                <div className="space-y-1">
                  {visibleMembers.map(member => {
                    const selected = selectedMemberIds.has(member.id);
                    const name = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.username || member.id;
                    const rl = roleLabel(member.role, channel);
                    return (
                      <button key={member.id} onClick={() => toggleMember(member.id)}
                        className={`w-full px-3 py-2.5 flex gap-3 items-center text-left rounded-xl border transition-colors select-none
                          ${selected ? 'bg-blue-500/15 border-blue-500/30' : 'border-transparent hover:bg-card/60'}`}>
                        <span className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-colors
                          ${selected ? 'bg-blue-600 border-blue-600 text-white' : 'border-input bg-card'}`}>
                          {selected && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                        </span>
                        <Avatar src={member.avatar} name={name} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className={`block text-xs truncate font-medium ${selected ? 'text-foreground' : 'text-foreground'}`}>{name}</span>
                          <span className="block text-[10px] text-muted-foreground mt-0.5 truncate">
                            {member.username ? '@' + member.username : member.id}
                          </span>
                        </span>
                        {member.role > 0 && (
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full flex-shrink-0 border
                            ${rl.kind === 'owner' ? 'border-yellow-500/30 text-yellow-400' : 'border-blue-500/30 text-blue-400'}`}>
                            {rl.text}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Bottom action bar ───────────────────────────────────────── */}
            <div className="border-t border-input px-5 py-3 flex items-center gap-3 bg-card/95 backdrop-blur flex-shrink-0">
              <span className="text-xs text-muted-foreground flex-1">
                {selectedMemberIds.size ? (
                  <>Đã chọn <span className="text-blue-400 font-medium">{selectedMemberIds.size}</span> thành viên</>
                ) : 'Chọn thành viên để thao tác'}
              </span>
              <button onClick={openCampaignPicker} disabled={!selectedMemberIds.size}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                  selectedMemberIds.size
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-muted text-subtle-foreground cursor-not-allowed'
                }`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                Thêm vào chiến dịch
              </button>
              <button onClick={() => setShowAddToContacts(true)} disabled={!selectedMemberIds.size}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                  selectedMemberIds.size
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-muted text-subtle-foreground cursor-not-allowed'
                }`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg>
                Thêm vào liên hệ
              </button>
            </div>
          </>
        )}
      </section>
      {showCampaignPicker && !showCreateCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCampaignPicker(false)}>
          <div className="w-80 rounded-2xl border border-input bg-card p-5 shadow-2xl" onClick={event => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-foreground">Thêm vào chiến dịch</h3><button onClick={() => setShowCreateCampaign(true)} className="text-xs text-blue-400 hover:text-blue-300">+ Tạo mới</button></div>
            <p className="mb-3 text-xs text-muted-foreground">Chỉ hiển thị chiến dịch Telegram của tài khoản này.</p>
            {campaignsLoadFailed && campaigns.length > 0 && (
              <LoadFailedNotice className="justify-start px-0 pt-0" text="Không tải được danh sách chiến dịch mới nhất"
                onRetry={loadPickerCampaigns} busy={campaignsLoading} />
            )}
            <div className="mb-4 max-h-52 space-y-1 overflow-y-auto">{campaigns.length ? campaigns.map(campaign => <button key={campaign.id} onClick={() => setPickedCampaignId(campaign.id)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${pickedCampaignId === campaign.id ? 'border-blue-500 bg-blue-500/15 text-foreground' : 'border-input text-foreground/80 hover:border-border-strong'}`}>{campaign.name}</button>) : campaignsLoadFailed ? <LoadFailedNotice className="py-4" text="Không tải được danh sách chiến dịch" onRetry={loadPickerCampaigns} busy={campaignsLoading} /> : <p className="py-4 text-center text-xs text-muted-foreground">Chưa có chiến dịch Telegram.</p>}</div>
            <div className="flex gap-2"><button onClick={() => setShowCampaignPicker(false)} className="flex-1 rounded-lg bg-muted py-2 text-xs text-foreground">Huỷ</button><button onClick={handleAddToCampaign} disabled={!pickedCampaignId || addingToCampaign} className="flex-1 rounded-lg bg-blue-600 py-2 text-xs text-white disabled:opacity-40">{addingToCampaign ? 'Đang thêm…' : 'Thêm'}</button></div>
          </div>
        </div>
      )}
      {showCreateCampaign && <CampaignCreateModal channel={channel} onClose={() => setShowCreateCampaign(false)} onSave={handleCreateCampaign} />}
      {showAddToContacts && <AddToContactsModal
        contacts={members.filter(member => selectedMemberIds.has(member.id)).map(member => ({ contactId: member.id, displayName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.username || member.id, avatar: member.avatar || '', phone: member.phone || '' }))}
        onClose={() => setShowAddToContacts(false)}
        onDone={() => { setShowAddToContacts(false); setSelectedMemberIds(new Set()); }}
      />}
    </div>
  );
}

export default function GroupMembersTab() {
  const channel = useAccountStore(s => s.accounts.find(a => a.zalo_id === s.activeAccountId)?.channel);
  if (channel === 'telegram_user' || channel === 'telegram_bot') return <TelegramGroupMembersTab channel={channel} />;
  return <ZaloGroupMembersTab />;
}
