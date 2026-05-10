import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { sendSeenForThread } from '@/lib/sendSeenHelper';
import { getFilteredUnreadCount } from '@/lib/badgeUtils';
import { CreateGroupModal, InviteToGroupModal } from './GroupModals';
import { showConfirm } from '../common/ConfirmDialog';
import LabelPicker, { EditLabelsModal } from './LabelPicker';
import AddFriendModal from '../common/AddFriendModal';
import GroupAvatar from '../common/GroupAvatar';
import GlobalSearchPanel from './GlobalSearchPanel';
import useIsMobile from '@/hooks/useIsMobile';
import { syncZaloGroups, MemberPlaceholder } from '@/lib/zaloGroupUtils';
import { ChannelBadgeOverlay } from '../common/ChannelBadge';
import type { Channel } from '@/../configs/channelConfig';

interface LabelData { id: number; text: string; color: string; emoji: string; conversations: string[]; textKey?: string; offset?: number; createTime?: number; }
interface LocalLabelData {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
  sort_order?: number;
  is_active?: number;
}
type LabelSource = 'local' | 'zalo';

function isPhoneNumber(s: string): boolean {
  return /^(\+84|0)\d{9,10}$/.test(s.trim().replace(/\s/g, ''));
}

type FilterType = 'all' | 'unread' | 'unreplied' | 'others' | 'label';

const MUTE_OPTIONS = [
  { label: 'Trong 1 giờ',              until: () => Date.now() + 60 * 60 * 1000 },
  { label: 'Trong 4 giờ',              until: () => Date.now() + 4 * 60 * 60 * 1000 },
  { label: 'Cho đến 8:00 AM',          until: () => { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 8 ? 1 : 0)); d.setHours(8,0,0,0); return d.getTime(); } },
  { label: 'Cho đến khi được mở lại',  until: () => 0 },
];

/**
 * Chuyển đổi epoch ms (from store) → MuteDuration hoặc số giây cho Zalo API.
 * until=0  → forever → -1
 * until>now ≈ 1h   → 3600
 * until>now ≈ 4h   → 14400
 * until=8AM target → "until8AM"
 * otherwise        → số giây còn lại (rounded)
 */
function muteUntilToDuration(until: number): number | string {
  if (until === 0) return -1; // MuteDuration.FOREVER
  const remainMs = until - Date.now();
  const remainSec = Math.round(remainMs / 1000);
  // ±5 phút tolerance
  if (Math.abs(remainSec - 3600) <= 300) return 3600;   // ONE_HOUR
  if (Math.abs(remainSec - 14400) <= 300) return 14400;  // FOUR_HOURS
  // Check "until8AM" — nếu target hour là 8
  const t = new Date(until);
  if (t.getHours() === 8 && t.getMinutes() === 0) return 'until8AM';
  return remainSec > 0 ? remainSec : -1;
}

export default function ConversationList() {
  const { contacts, setActiveThread, activeThreadId, activeThreadType, setMessages, updateContact, clearUnread, removeContact, drafts, draftTimestamps } = useChatStore();
  const { syncRepliedState, saveAccountThread } = useChatStore();
  const { activeAccountId, accounts: allAccountsList, setActiveAccount } = useAccountStore();
  const { labels: allLabels, setLabels, showNotification, setMuted, clearMuted, isMuted: isMutedFn, groupInfoCache, setGroupInfo,
    othersConversations: allOthers, loadFlags, addToOthers, removeFromOthers,
    mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount, setMobileShowChat } = useAppStore();
  const isMobile = useIsMobile();

  const [search, setSearch] = useState('');
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [phoneResult, setPhoneResult] = useState<any>(null);
  const [phoneSearching, setPhoneSearching] = useState(false);
  /** Số điện thoại đang chờ chọn tài khoản tìm kiếm (chế độ gộp trang, chưa chọn filter) */
  const [phoneSearchPendingPhone, setPhoneSearchPendingPhone] = useState<string | null>(null);
  const [addFriendModal, setAddFriendModal] = useState<{ userId: string; displayName: string; avatar: string } | null>(null);
  const [sendingFriendReq, setSendingFriendReq] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [channelFilter, setChannelFilter] = useState<Channel | 'all'>('all');
  const [filterLabelIds, setFilterLabelIds] = useState<number[]>([]);
  const [filterLabelSource, setFilterLabelSource] = useState<LabelSource>('local');
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [pinnedThreads, setPinnedThreads] = useState<Set<string>>(new Set());
  const [localPinnedThreads, setLocalPinnedThreads] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ contactId: string; zaloId: string; x: number; y: number } | null>(null);
  const [labelPickerId, setLabelPickerId] = useState<string | null>(null);
  const [muteSubmenuId, setMuteSubmenuId] = useState<string | null>(null);
  const [labelsVersion, setLabelsVersion] = useState(0);
  const [inlineLabelPicker, setInlineLabelPicker] = useState<{ contactId: string; zaloId: string; x: number; y: number } | null>(null);
  const [localLabelsByAccount, setLocalLabelsByAccount] = useState<Record<string, LocalLabelData[]>>({});
  const [localLabelThreadMapByAccount, setLocalLabelThreadMapByAccount] = useState<Record<string, Record<string, number[]>>>({});
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [inviteContactId, setInviteContactId] = useState<string | null>(null);
  const [loadingGroupAvatars, setLoadingGroupAvatars] = useState(false);
  const [editLabelsOpen, setEditLabelsOpen] = useState(false);
  const [editLabelsZaloId, setEditLabelsZaloId] = useState<string | null>(null);
  const [editLabelsPickerOpen, setEditLabelsPickerOpen] = useState(false);
  const [syncingLabels, setSyncingLabels] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  // Prevents the activeAccountId useEffect from overriding a manual merged-mode selection
  const isManualSelectingRef = React.useRef(false);

  // ── Pagination: cố định 250 hội thoại mỗi trang, infinite scroll ──────
  const PAGE_SIZE = 250;
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset displayCount khi đổi account hoặc filter
  useEffect(() => { setDisplayCount(PAGE_SIZE); }, [activeAccountId, filter, filterLabelIds, search, mergedInboxFilterAccount, channelFilter]);

  // Infinite scroll: IntersectionObserver trên sentinel element
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = listContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setDisplayCount(prev => prev + PAGE_SIZE);
        }
      },
      { root: container, threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [searchPanelOpen, filter]); // re-attach khi panel/filter thay đổi

  const labels: LabelData[] = activeAccountId ? (allLabels[activeAccountId] || []) : [];
  const othersConversations: Set<string> = activeAccountId ? (allOthers[activeAccountId] || new Set()) : new Set();
  const localLabels: LocalLabelData[] = activeAccountId ? (localLabelsByAccount[activeAccountId] || []) : [];

  const loadLocalLabelsForAccount = async (zaloId: string) => {
    try {
      const [labelsRes, threadsRes] = await Promise.all([
        ipc.db?.getLocalLabels({ zaloId }),
        ipc.db?.getLocalLabelThreads({ zaloId }),
      ]);
      const localLabelsRaw = (labelsRes?.labels || [])
        .filter((l: any) => (l?.is_active ?? 1) === 1)
        .sort((a: any, b: any) => {
          const sa = Number(a?.sort_order ?? 0);
          const sb = Number(b?.sort_order ?? 0);
          if (sa !== sb) return sa - sb;
          return String(a?.name || '').localeCompare(String(b?.name || ''));
        });
      const map: Record<string, number[]> = {};
      (threadsRes?.threads || []).forEach((row: any) => {
        const tid = String(row.thread_id || '');
        if (!tid) return;
        if (!map[tid]) map[tid] = [];
        map[tid].push(Number(row.label_id));
      });
      setLocalLabelsByAccount(prev => ({ ...prev, [zaloId]: localLabelsRaw }));
      setLocalLabelThreadMapByAccount(prev => ({ ...prev, [zaloId]: map }));
    } catch {}
  };

  // Load labels, pinned, and others conversations when account changes
  useEffect(() => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const isZalo = (acc.channel || 'zalo') === 'zalo';
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };

    // Zalo-only APIs: labels, pin conversations
    if (isZalo) {
      // Labels: dùng cache 12h, không gọi API mỗi lần chuyển tab
      useAppStore.getState().fetchLabelsWithCache(activeAccountId, auth).then(({ version }) => {
        setLabelsVersion(version);
      }).catch(() => {});
      // FIX: getPinConversations returns { conversations: string[], version: number }
      // where each ID is prefixed with 'u' (user) or 'g' (group)
      ipc.zalo?.getPinConversations(auth).then((res: any) => {
        const convIds: string[] = res?.response?.conversations || [];
        setPinnedThreads(new Set(convIds.map((id: string) => id.replace(/^[ug]/, ''))));
      }).catch(() => {});
    }

    // Load local pinned conversations from DB
    ipc.db?.getLocalPinnedConversations({ zaloId: activeAccountId }).then((res: any) => {
      setLocalPinnedThreads(new Set(res?.threadIds || []));
    }).catch(() => {});

    // Load mute + others flags from DB into store cache
    loadFlags(activeAccountId);
    loadLocalLabelsForAccount(activeAccountId).catch(() => {});
    // Load drafts from DB into store for this account
    useChatStore.getState().loadDrafts(activeAccountId).catch(() => {});
  }, [activeAccountId]);

  // Reload local labels when toggled from MessageInput, ChatHeader, CRM, etc.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const zaloId = detail?.zaloId;
      if (zaloId) {
        loadLocalLabelsForAccount(zaloId).catch(() => {});
      } else if (activeAccountId) {
        loadLocalLabelsForAccount(activeAccountId).catch(() => {});
      }
    };
    window.addEventListener('local-labels-changed', handler);
    return () => window.removeEventListener('local-labels-changed', handler);
  }, [activeAccountId]);

  useEffect(() => {
    if (!mergedInboxMode) return;
    mergedInboxAccounts.forEach((zaloId) => {
      loadLocalLabelsForAccount(zaloId).catch(() => {});
    });
  }, [mergedInboxMode, mergedInboxAccounts.join(',')]);

  // BATCH LOAD GROUP AVATARS - Load từ DB trước, API sau
  useEffect(() => {
    if (!activeAccountId) return;

    const loadGroupAvatars = async () => {
      // Không set loading state để tránh hiển thị loading indicator
      // setLoadingGroupAvatars(true);

      try {
        const accountContacts = useChatStore.getState().contacts[activeAccountId] || [];

        // Tìm các nhóm không có avatar
        const groupsNeedingAvatars = accountContacts.filter(c => {
          if (c.contact_type !== 'group') return false;
          if (c.avatar_url) return false; // Đã có group avatar

          // Check cache có members với avatar không
          const cached = groupInfoCache?.[activeAccountId]?.[c.contact_id];
          const membersWithAvatar = cached?.members?.filter(m => m.avatar && m.userId !== 'undefined') || [];
          return membersWithAvatar.length < 2; // Cần ít nhất 2 members có avatar
        });

        if (groupsNeedingAvatars.length === 0) {
          setLoadingGroupAvatars(false);
          return;
        }

        console.log(`[ConversationList] Found ${groupsNeedingAvatars.length} groups needing avatars`);

        // ═══ PROGRESSIVE LOADING: Load 10 đầu tiên, sau đó load dần background ═══
        const INITIAL_BATCH = 10;
        const BACKGROUND_BATCH = 5;
        const BACKGROUND_DELAY = 500; // ms delay giữa các batch background

        // Helper function để load members của 1 group từ DB
        const loadGroupFromDB = async (group: typeof groupsNeedingAvatars[0]): Promise<boolean> => {
          try {
            const res = await ipc.db?.getGroupMembers({ zaloId: activeAccountId, groupId: group.contact_id });
            const rows: any[] = res?.members || [];
            const validMembers = rows.filter(r => r.member_id && /^\d+$/.test(r.member_id));

            if (validMembers.length >= 1) {
              // DB có data → update cache
              if (!group.avatar_url && validMembers.length === 1) {
                const memberAvatar = validMembers[0]?.avatar || '';
                if (memberAvatar) {
                  ipc.db?.updateContactProfile({
                    zaloId: activeAccountId, contactId: group.contact_id,
                    displayName: group.display_name || group.contact_id,
                    avatarUrl: memberAvatar, phone: '', contactType: 'group',
                  }).catch(() => {});
                  group.avatar_url = memberAvatar;
                }
              }

              setGroupInfo(activeAccountId, group.contact_id, {
                groupId: group.contact_id,
                name: group.display_name || group.contact_id,
                avatar: '',
                memberCount: validMembers.length,
                members: validMembers.map(r => ({
                  userId: r.member_id,
                  displayName: r.display_name || r.member_id,
                  avatar: r.avatar || '',
                  role: r.role || 0,
                })),
                creatorId: '',
                adminIds: [],
                settings: undefined,
                fetchedAt: Date.now(),
              });
              console.log(`[ConversationList] Group ${group.contact_id}: loaded ${validMembers.length} members from DB`);
              return true; // Success - no API needed
            }
            return false; // Need API
          } catch (err) {
            console.warn(`[ConversationList] DB error for group ${group.contact_id}:`, err);
            return false; // Need API
          }
        };

        // STEP 1: Load INITIAL_BATCH đầu tiên (blocking)
        const initialGroups = groupsNeedingAvatars.slice(0, INITIAL_BATCH);
        const remainingGroups = groupsNeedingAvatars.slice(INITIAL_BATCH);
        const groupsNeedingAPI: string[] = [];

        // Load initial batch synchronously
        for (const group of initialGroups) {
          const success = await loadGroupFromDB(group);
          if (!success) {
            groupsNeedingAPI.push(group.contact_id);
          }
        }

        // STEP 2: Load remaining groups in background (non-blocking)
        if (remainingGroups.length > 0) {
          console.log(`[ConversationList] Loading ${remainingGroups.length} remaining groups in background...`);
          
          // Fire-and-forget background loading
          (async () => {
            for (let i = 0; i < remainingGroups.length; i += BACKGROUND_BATCH) {
              // Delay between batches to avoid blocking main thread
              if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, BACKGROUND_DELAY));
              }
              
              const batch = remainingGroups.slice(i, i + BACKGROUND_BATCH);
              for (const group of batch) {
                const success = await loadGroupFromDB(group);
                if (!success) {
                  groupsNeedingAPI.push(group.contact_id);
                }
              }
            }
            
            // After all DB loads complete, do API calls if needed
            if (groupsNeedingAPI.length > 0) {
              console.log(`[ConversationList] ${groupsNeedingAPI.length} groups need API call (background)`);
              await loadGroupsFromAPI(groupsNeedingAPI, activeAccountId);
            }
          })();
        } else if (groupsNeedingAPI.length > 0) {
          // Only initial batch needed API
          console.log(`[ConversationList] ${groupsNeedingAPI.length} groups need API call`);
          await loadGroupsFromAPI(groupsNeedingAPI, activeAccountId);
        }

      } finally {
        setLoadingGroupAvatars(false);
      }
    };

    // Helper function để load groups từ API
    const loadGroupsFromAPI = async (groupIds: string[], accountId: string) => {
      const acc = useAccountStore.getState().getActiveAccount();
      if (!acc || (acc.channel || 'zalo') !== 'zalo') return; // Zalo-only API

      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };

      // Batch getGroupInfo (max 10/request)
      const batchSize = 10;
      for (let i = 0; i < groupIds.length; i += batchSize) {
        const batch = groupIds.slice(i, i + batchSize);

        let gridMap: Record<string, any> = {};
        try {
          const res = await ipc.zalo?.getGroupInfo({ auth, groupId: batch });
          gridMap = res?.response?.gridInfoMap || {};
        } catch (err) {
          console.warn('[ConversationList] Batch getGroupInfo failed:', err);
          continue;
        }

        for (const groupId of batch) {
          const gi = gridMap[groupId];
          if (!gi) continue;

          const groupName   = gi.name || gi.nameChanged || groupId;
          const groupAvatar = gi.avt  || gi.fullAvt     || '';
          const creatorId   = (gi.creatorId || gi.creator || '').replace(/_0$/, '');
          const adminIds    = (gi.adminIds || gi.subAdmins || []).map((a: string) => a.replace(/_0$/, ''));
          const adminSet    = new Set([creatorId, ...adminIds]);

          // Update contact name/avatar
          await ipc.db?.updateContactProfile({
            zaloId: accountId, contactId: groupId,
            displayName: groupName, avatarUrl: groupAvatar, phone: '', contactType: 'group',
          }).catch(() => {});

          // Parse member IDs (smart memVerList parsing, same as zaloGroupUtils)
          const parseMemVerList = (list: string[]): string[] =>
            list.map(entry => {
              if (typeof entry !== 'string') return String(entry || '');
              const lastUnder = entry.lastIndexOf('_');
              if (lastUnder <= 0) return entry;
              const possibleVer = entry.substring(lastUnder + 1);
              if (/^\d+$/.test(possibleVer) && possibleVer.length < entry.substring(0, lastUnder).length)
                return entry.substring(0, lastUnder);
              return entry;
            }).filter(uid => uid && /^\d+$/.test(uid));

          const rawIds: string[] =
            gi.memberIds?.length > 0     ? gi.memberIds.map(String) :
            gi.currentMems?.length > 0   ? gi.currentMems.map((m: any) => String(m.id || '')) :
            parseMemVerList(gi.memVerList || []);

          const memberIds: string[] = [...new Set(
            rawIds.map(id => id.replace(/_0$/, '').trim()).filter(id => /^\d+$/.test(id))
          )];

          if (memberIds.length === 0) continue;

          // Placeholders: empty displayName → forces full enrichment in syncZaloGroups
          const placeholders: MemberPlaceholder[] = memberIds.map(memberId => ({
            memberId,
            displayName: '',
            avatar: '',
            role: memberId === creatorId ? 2 : adminSet.has(memberId) ? 1 : 0,
          }));

          // Reload from DB and update groupInfoCache after each sync phase
          const reloadFromDB = async (isFinal = false) => {
            const dbRes = await ipc.db?.getGroupMembers({ zaloId: accountId, groupId });
            const rows: any[] = (dbRes?.members ?? []).filter((r: any) => /^\d+$/.test(r.member_id?.trim() ?? ''));
            if (rows.length === 0) return;

            const trueTotalMembers = gi.totalMember || rows.length;
            let effectiveAvatar = groupAvatar;
            if (isFinal && !effectiveAvatar && trueTotalMembers <= 1) {
              const memberAvatar = rows.find((r: any) => r.avatar)?.avatar || '';
              if (memberAvatar) {
                effectiveAvatar = memberAvatar;
                ipc.db?.updateContactProfile({
                  zaloId: accountId, contactId: groupId,
                  displayName: groupName, avatarUrl: effectiveAvatar,
                  phone: '', contactType: 'group',
                }).catch(() => {});
                console.log(`[ConversationList] Group ${groupId}: single-member, using member avatar as group avatar`);
              }
            }

            setGroupInfo(accountId, groupId, {
              groupId,
              name: groupName,
              avatar: effectiveAvatar,
              memberCount: Math.max(trueTotalMembers, rows.length),
              members: rows.map(r => ({
                userId: r.member_id,
                displayName: r.display_name || '',
                avatar: r.avatar || '',
                role: r.role ?? 0,
              })),
              creatorId, adminIds,
              settings: gi.setting || {},
              fetchedAt: Date.now(),
            });
            console.log(`[ConversationList] Group ${groupId}: enriched ${rows.filter((r: any) => r.avatar).length}/${rows.length} members`);
          };

          // Use syncZaloGroups (pre-parsed → skips duplicate getGroupInfo call)
          await syncZaloGroups({
            activeAccountId: accountId,
            auth,
            groupId,
            memberIds,
            placeholders,
            onPhase1Done: () => reloadFromDB(false),
            onGroupEnriched: () => reloadFromDB(true),
          }).catch(err => console.warn(`[ConversationList] syncZaloGroups failed for ${groupId}:`, err));
        }
        
        // Add small delay between API batches to avoid rate limiting
        if (i + batchSize < groupIds.length) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    };

    // Delay 1s để contacts load xong từ DB
    const timer = setTimeout(loadGroupAvatars, 1000);
    return () => clearTimeout(timer);
  }, [activeAccountId]);

  // MERGED MODE: Load group avatars từ DB cho tất cả tài khoản trong merged list
  useEffect(() => {
    if (!mergedInboxMode || mergedInboxAccounts.length === 0) return;

    const loadMergedGroupAvatars = async () => {
      const BATCH_SIZE = 5;
      const BATCH_DELAY = 300;

      for (const zaloId of mergedInboxAccounts) {
        const accountContacts = useChatStore.getState().contacts[zaloId] || [];
        const groupsNeedingAvatars = accountContacts.filter(c => {
          if (c.contact_type !== 'group') return false;
          const cached = groupInfoCache?.[zaloId]?.[c.contact_id];
          const membersWithId = cached?.members?.filter(m => m.userId && m.userId !== 'undefined') || [];
          return membersWithId.length < 2;
        });

        if (groupsNeedingAvatars.length === 0) continue;

        // Progressive loading: batch by batch with delay
        for (let i = 0; i < groupsNeedingAvatars.length; i += BATCH_SIZE) {
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
          }
          
          const batch = groupsNeedingAvatars.slice(i, i + BATCH_SIZE);
          for (const group of batch) {
            try {
              const res = await ipc.db?.getGroupMembers({ zaloId, groupId: group.contact_id });
              const rows: any[] = res?.members || [];
              const validMembers = rows.filter(r => r.member_id && /^\d+$/.test(r.member_id));
              if (validMembers.length >= 2) {
                setGroupInfo(zaloId, group.contact_id, {
                  groupId: group.contact_id,
                  name: group.display_name || group.contact_id,
                  avatar: group.avatar_url || '',
                  memberCount: validMembers.length,
                  members: validMembers.map(r => ({
                    userId: r.member_id,
                    displayName: r.display_name || r.member_id,
                    avatar: r.avatar || '',
                    role: r.role || 0,
                  })),
                  creatorId: '',
                  adminIds: [],
                  settings: undefined,
                  fetchedAt: Date.now(),
                });
              }
            } catch { /* ignore */ }
          }
        }
      }
    };

    const timer = setTimeout(loadMergedGroupAvatars, 1500);
    return () => clearTimeout(timer);
  }, [mergedInboxMode, mergedInboxAccounts.join(',')]);


  // Background fetch group info for groups without real names
  // Chỉ chạy 1 lần khi activeAccountId thay đổi — KHÔNG depend vào contacts
  // để tránh gọi API liên tục mỗi khi nhận tin nhắn mới
  useEffect(() => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };

    // Delay nhỏ để contacts kịp load từ DB
    const timer = setTimeout(async () => {
      const accountContacts = useChatStore.getState().contacts[activeAccountId] || [];

      // Chỉ lấy nhóm chưa có tên thực sự (tên = ID số hoặc rỗng)
      const groupsNeedingInfo = accountContacts.filter(c => {
        if (c.contact_type !== 'group') return false;
        const name = c.display_name || '';
        // Có tên thực → bỏ qua
        return !(name && name !== c.contact_id && !/^\d+$/.test(name));

      }).slice(0, 15); // Giới hạn batch để tránh quá nhiều request

      if (groupsNeedingInfo.length === 0) return;

      const groupIds = groupsNeedingInfo.map(c => c.contact_id);
      try {
        const res = await ipc.zalo?.getGroupInfo({ auth, groupId: groupIds });
        const gridMap = res?.response?.gridInfoMap || res?.response?.changed_groups || {};
        for (const [gId, gData] of Object.entries(gridMap) as [string, any][]) {
          const name: string = gData.name || gData.nameChanged || gId;
          const avatar: string = gData.avt || gData.fullAvt || '';
          const adminIds: string[] = gData.adminIds || gData.subAdmins || [];
          const creatorId: string = gData.creatorId || gData.creator || '';

          // Cập nhật contact với contact_type = 'group'
          updateContact(activeAccountId, { contact_id: gId, display_name: name, avatar_url: avatar, contact_type: 'group' });
          ipc.db?.updateContactProfile({
            zaloId: activeAccountId,
            contactId: gId,
            displayName: name,
            avatarUrl: avatar,
            phone: '',
            contactType: 'group'  // ← FIX
          }).catch(() => {});

          // Parse và lưu members nếu có — chỉ khi DB chưa có (tránh ghi đè mỗi lần chuyển account)
          const rawMembers: any[] = gData.memVerList || gData.memberList || gData.members || gData.currentMems || [];
          // memVerList có thể là array of strings "uid_version" hoặc array of objects
          const members = rawMembers.map((m: any) => {
            let memberId: string;
            if (typeof m === 'string') {
              memberId = m.replace(/_\d+$/, '');
            } else {
              memberId = String(m.id || m.userId || m.uid || m.memberId || '');
            }
            return {
              memberId,
              displayName: (typeof m === 'object' ? (m.dName || m.displayName || m.name || '') : ''),
              avatar: (typeof m === 'object' ? (m.avt || m.avatar || '') : ''),
              role: memberId === creatorId ? 1 : adminIds.includes(memberId) ? 2 : 0,
            };
          }).filter((m: any) => m.memberId);

          if (members.length > 0) {
            // Check DB trước — nếu đã có members rồi thì bỏ qua
            const existingMembers = await ipc.db?.getGroupMembers({ zaloId: activeAccountId, groupId: gId }).catch(() => null);
            if (!existingMembers?.members?.length) {
              ipc.db?.saveGroupMembers({ zaloId: activeAccountId, groupId: gId, members }).catch(() => {});
            }
          }

          setGroupInfo(activeAccountId, gId, {
            groupId: gId,
            name,
            avatar,
            memberCount: gData.totalMember || members.length,
            members: members.map((m: any) => ({
              userId: m.memberId,
              displayName: m.displayName,
              avatar: m.avatar,
              role: m.role,
            })),
            creatorId,
            adminIds,
            settings: gData.setting || {},
            fetchedAt: Date.now(),
          });
        }
      } catch (err: any) {
        console.warn('[ConversationList] batch getGroupInfo error:', err?.message);
      }
    }, 1500); // delay 1.5s để contacts kịp load

    return () => clearTimeout(timer);
  }, [activeAccountId]); // KHÔNG thêm contacts vào deps!

  // Close context menu and dropdowns on outside click
  useEffect(() => {
    if (!ctxMenu && !filterDropdownOpen && !moreMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (ctxMenu && ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null); setLabelPickerId(null); setMuteSubmenuId(null);
      }
      if (filterDropdownOpen && filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterDropdownOpen(false);
      }
      if (moreMenuOpen && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctxMenu, filterDropdownOpen, moreMenuOpen]);

  const accountContacts = activeAccountId ? (contacts[activeAccountId] || []) : [];
  // Không tính unread của hội thoại trong thư mục "Khác"
  const unreadCount = accountContacts.reduce((s, c) => {
    if (othersConversations.has(c.contact_id)) return s;
    return s + (c.unread_count > 0 ? 1 : 0);
  }, 0);
  // Unread riêng của thư mục "Khác" — chỉ dùng để hiện dấu chấm đỏ
  const othersUnreadCount = accountContacts.reduce((s, c) => {
    if (!othersConversations.has(c.contact_id)) return s;
    return s + (c.unread_count > 0 ? 1 : 0);
  }, 0);
  // const unrepliedCount = accountContacts.reduce((s, c) => s + (c.unread_count > 0 && c.is_replied !== 1 ? 1 : 0), 0);
  const othersCount = accountContacts.reduce((s, c) => s + (othersConversations.has(c.contact_id) ? 1 : 0), 0);

  const filtered = accountContacts.filter((c) => {
    // Channel filter
    if (channelFilter !== 'all' && (c.channel || 'zalo') !== channelFilter) return false;
    // Tìm kiếm: kiểm tra cả alias VÀ display_name để tránh miss khi alias ngắn hơn
    const alias = (c.alias || '').toLowerCase();
    const displayName = (c.display_name || '').toLowerCase();
    const q = search.toLowerCase();
    const matchName = alias.includes(q) || displayName.includes(q) || (c.contact_id || '').includes(q) || (c.phone || '').includes(q);
    if (!matchName) return false;

    // Nếu đang xem 'others', chỉ show conversations trong others
    if (filter === 'others') {
      return othersConversations.has(c.contact_id);
    }

    // Nếu không phải xem 'others', loại bỏ conversations trong others khỏi danh sách chính
    if (othersConversations.has(c.contact_id)) {
      return false;
    }

    if (filter === 'unread') return c.unread_count > 0;
    if (filter === 'unreplied') return c.unread_count > 0 && c.is_replied !== 1;
    if (filter === 'label') {
      if (filterLabelSource === 'local') {
        // Local labels filter
        const threadMap = localLabelThreadMapByAccount[activeAccountId || ''] || {};
        const threadLabelIds = threadMap[c.contact_id] || [];
        if (filterLabelIds.length > 0) return filterLabelIds.every(id => threadLabelIds.includes(id));
        return threadLabelIds.length > 0;
      } else {
        // Zalo labels filter
        const isGroupC = c.contact_type === 'group';
        const labelCId = isGroupC ? `g${c.contact_id}` : c.contact_id;
        if (filterLabelIds.length > 0) {
          return filterLabelIds.every(id => {
            const lbl = labels.find(l => l.id === id);
            return lbl ? (lbl.conversations.includes(labelCId) || lbl.conversations.includes(c.contact_id)) : false;
          });
        }
        return labels.some(l => l.conversations.includes(labelCId) || l.conversations.includes(c.contact_id));
      }
    }
    return true;
  }).sort((a, b) => {
    const aLP = localPinnedThreads.has(a.contact_id) ? 1 : 0, bLP = localPinnedThreads.has(b.contact_id) ? 1 : 0;
    if (aLP !== bLP) return bLP - aLP; // local pin goes first
    const aP = pinnedThreads.has(a.contact_id) ? 1 : 0, bP = pinnedThreads.has(b.contact_id) ? 1 : 0;
    if (aP !== bP) return bP - aP;
    // Draft priority: conversations with drafts sort above non-draft (after pinned)
    // Skip draft for the currently active thread — only show after user switches away
    const aDraftKey = `${activeAccountId}_${a.contact_id}`;
    const bDraftKey = `${activeAccountId}_${b.contact_id}`;
    const aHasDraft = a.contact_id !== activeThreadId && !!drafts[aDraftKey];
    const bHasDraft = b.contact_id !== activeThreadId && !!drafts[bDraftKey];
    if (aHasDraft !== bHasDraft) return aHasDraft ? -1 : 1;
    // If both have drafts, sort by draft updated_at desc
    if (aHasDraft && bHasDraft) {
      return (draftTimestamps[bDraftKey] || 0) - (draftTimestamps[aDraftKey] || 0);
    }
    return (b.last_message_time || 0) - (a.last_message_time || 0);
  });

  // ── Chế độ Gộp trang: gộp contacts từ tất cả tài khoản được chọn ──────────
  const mergedContacts = useMemo(() => {
    if (!mergedInboxMode) return null;
    const result: import('@/store/chatStore').ContactItem[] = [];
    for (const zaloId of mergedInboxAccounts) {
      const acctContacts = contacts[zaloId] || [];
      result.push(...acctContacts);
    }
    result.sort((a, b) => {
      // Draft priority: conversations with drafts sort to top
      // Skip draft for the currently active thread
      const aDraftKey = `${a.owner_zalo_id}_${a.contact_id}`;
      const bDraftKey = `${b.owner_zalo_id}_${b.contact_id}`;
      const aHasDraft = a.contact_id !== activeThreadId && !!drafts[aDraftKey];
      const bHasDraft = b.contact_id !== activeThreadId && !!drafts[bDraftKey];
      if (aHasDraft !== bHasDraft) return aHasDraft ? -1 : 1;
      if (aHasDraft && bHasDraft) {
        return (draftTimestamps[bDraftKey] || 0) - (draftTimestamps[aDraftKey] || 0);
      }
      return (b.last_message_time || 0) - (a.last_message_time || 0);
    });
    return result;
  }, [mergedInboxMode, mergedInboxAccounts, contacts, drafts, draftTimestamps, activeThreadId]);

  // Merge nhãn từ tất cả tài khoản trong merged mode — trùng tên thì gộp 1
  const mergedLabels = useMemo(() => {
    if (!mergedInboxMode) return null;
    const seen = new Map<string, LabelData>();
    for (const zaloId of mergedInboxAccounts) {
      const acctLabels = allLabels[zaloId] || [];
      for (const lbl of acctLabels) {
        if (!seen.has(lbl.text)) {
          seen.set(lbl.text, { ...lbl });
        }
      }
    }
    return Array.from(seen.values());
  }, [mergedInboxMode, mergedInboxAccounts, allLabels]);

  const filteredMerged = useMemo(() => {
    if (!mergedContacts) return null;
    const q = search.toLowerCase();
    return mergedContacts.filter(c => {
      // Channel filter
      if (channelFilter !== 'all' && (c.channel || 'zalo') !== channelFilter) return false;
      // Account filter (from sidebar)
      if (mergedInboxFilterAccount && c.owner_zalo_id !== mergedInboxFilterAccount) return false;
      // Search filter
      if (q) {
        const alias = (c.alias || '').toLowerCase();
        const displayName = (c.display_name || '').toLowerCase();
        const matchName = alias.includes(q) || displayName.includes(q) || (c.contact_id || '').includes(q) || (c.phone || '').includes(q);
        if (!matchName) return false;
      }
      // Others bucket — per-account
      const ownerOthers: Set<string> = (allOthers[c.owner_zalo_id!] || new Set()) as Set<string>;
      if (filter === 'others') return ownerOthers.has(c.contact_id);
      if (ownerOthers.has(c.contact_id)) return false; // hide from main list
      // Unread filter
      if (filter === 'unread') return c.unread_count > 0;
      // Label filter — per-account, match by label text (cross-account dedup)
      if (filter === 'label') {
        if (filterLabelSource === 'local') {
          const threadMap = localLabelThreadMapByAccount[c.owner_zalo_id!] || {};
          const threadLabelIds = threadMap[c.contact_id] || [];
          if (filterLabelIds.length > 0) return filterLabelIds.every(id => threadLabelIds.includes(id));
          return threadLabelIds.length > 0;
        } else {
          const ownerLabels: LabelData[] = allLabels[c.owner_zalo_id!] || [];
          const isGroupC = c.contact_type === 'group';
          const labelCId = isGroupC ? `g${c.contact_id}` : c.contact_id;
          if (filterLabelIds.length > 0) {
            return filterLabelIds.every(id => {
              const selectedText = mergedLabels?.find(l => l.id === id)?.text;
              const matchingLabels = selectedText != null
                ? ownerLabels.filter(l => l.text === selectedText)
                : ownerLabels.filter(l => l.id === id);
              return matchingLabels.some(l => l.conversations.includes(labelCId) || l.conversations.includes(c.contact_id));
            });
          }
          return ownerLabels.some(l => l.conversations.includes(labelCId) || l.conversations.includes(c.contact_id));
        }
      }
      return true;
    });
  }, [mergedContacts, mergedInboxFilterAccount, search, filter, filterLabelIds, allOthers, allLabels, mergedLabels]);

  const mergedUnreadCount = mergedContacts
    ? mergedContacts.reduce((s, c) => {
        const ownerOthers = (allOthers[c.owner_zalo_id!] || new Set()) as Set<string>;
        if (ownerOthers.has(c.contact_id)) return s;
        return s + (c.unread_count > 0 ? 1 : 0);
      }, 0) : 0;

  const mergedOthersUnreadCount = mergedContacts
    ? mergedContacts.reduce((s, c) => {
        const ownerOthers = (allOthers[c.owner_zalo_id!] || new Set()) as Set<string>;
        if (!ownerOthers.has(c.contact_id)) return s;
        return s + (c.unread_count > 0 ? 1 : 0);
      }, 0) : 0;


  // ── Helper: thực sự tìm kiếm SĐT với tài khoản đã xác định ──────────────────
  const doPhoneSearch = async (acc: import('@/store/accountStore').AccountInfo, phone: string) => {
    setPhoneSearching(true); setPhoneResult(null);
    try {
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      const res = await ipc.zalo?.findUser({ auth, phone: phone.trim() });
      const user = res?.response;
      if (user?.uid) {
        try {
          const infoRes = await ipc.zalo?.getUserInfo({ auth, userId: user.uid });
          const profile = infoRes?.response?.changed_profiles?.[user.uid];
          setPhoneResult(profile ? { ...user, isFr: profile.isFr ?? 0, isBlocked: profile.isBlocked ?? 0, _searchZaloId: acc.zalo_id } : { ...user, _searchZaloId: acc.zalo_id });
        } catch { setPhoneResult({ ...user, _searchZaloId: acc.zalo_id }); }
      } else {
        setPhoneResult({ _notFound: true });
      }
    } catch {} finally { setPhoneSearching(false); }
  };

  // Handle search input change
  const handleSearchChange = async (value: string) => {
    setSearch(value); setPhoneResult(null); setPhoneSearchPendingPhone(null);
    // Auto-close search panel when input is completely cleared
    if (!value.trim()) {
      setSearchPanelOpen(false);
      return;
    }
    // Auto-open search panel when typing (new behavior)
    if (value.trim()) {
      setSearchPanelOpen(true);
    }
    if (!isPhoneNumber(value)) return;

    // ── Chế độ gộp trang, chưa chọn tài khoản filter → hiện account picker ──
    // (Phone search in GlobalSearchPanel handles this internally now)
    if (mergedInboxMode && !mergedInboxFilterAccount) {
      setPhoneSearchPendingPhone(value.trim());
      return;
    }

    // Xác định tài khoản để tìm kiếm
    let acc: import('@/store/accountStore').AccountInfo | undefined;
    if (mergedInboxMode && mergedInboxFilterAccount) {
      acc = useAccountStore.getState().accounts.find(a => a.zalo_id === mergedInboxFilterAccount);
    } else {
      acc = useAccountStore.getState().getActiveAccount();
    }
    if (!acc) return;
    await doPhoneSearch(acc, value);
  };

  // Ref để debounce labels load — không gọi quá 1 lần / 1 tiếng
  const lastLabelsFetchRef = useRef<number>(0);
  const loadLabelsIfStale = async () => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc || (acc.channel || 'zalo') !== 'zalo') return; // Labels are Zalo-only
    const now = Date.now();
    if (now - lastLabelsFetchRef.current < 3_600_000) return; // debounce 1 giờ
    lastLabelsFetchRef.current = now;
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
    try {
      const res = await ipc.zalo?.getLabels({ auth });
      if (res?.response?.labelData) {
        setLabels(activeAccountId, res.response.labelData);
        setLabelsVersion(res.response.version || 0);
      }
    } catch {}
  };

  const handleSelect = async (contactId: string, threadType: number, overrideZaloId?: string) => {
    const zaloId = overrideZaloId ?? activeAccountId;
    setActiveThread(contactId, threadType);
    // On mobile, switch to chat detail view
    if (isMobile) setMobileShowChat(true);
    if (!zaloId) return;

    ipc.db?.markAsRead({ zaloId, contactId }).catch(() => {});
    clearUnread(zaloId, contactId);
    // Gửi sự kiện đã đọc cho Zalo
    sendSeenForThread(zaloId, contactId, threadType);

    // Cập nhật badge taskbar — tổng unread của tất cả tài khoản
    ipc.app?.setBadge(getFilteredUnreadCount());

    // Load labels mỗi lần click hội thoại (debounced 30s) — chỉ ở chế độ thường
    if (!overrideZaloId) loadLabelsIfStale();

    const res = await ipc.db?.getMessages({ zaloId, threadId: contactId, limit: 50, offset: 0 });
    const dbMessages = res?.messages || [];
    if (dbMessages.length > 0) {
      setMessages(zaloId, contactId, [...dbMessages].reverse());
      // Sync is_replied dựa trên tin nhắn cuối thực tế
      syncRepliedState(zaloId, contactId, zaloId);
    } else {
      const acc = overrideZaloId
        ? useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId)
        : useAccountStore.getState().getActiveAccount();
      if (acc && (acc.channel || 'zalo') === 'zalo') {
        const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
        ipc.zalo?.getMessageHistory({ auth, threadId: contactId, type: threadType, lastMsgId: 0, count: 50 })
          .then((histRes: any) => {
            const msgs: any[] = histRes?.response?.data || histRes?.response || [];
            if (msgs.length > 0) {
              const converted = msgs.map((m: any) => ({
                msg_id: m.msgId || String(Date.now() + Math.random()),
                owner_zalo_id: zaloId!, thread_id: contactId, thread_type: threadType,
                sender_id: String(m.uidFrom || ''),
                content: typeof m.data?.content === 'object' ? JSON.stringify(m.data?.content) : String(m.data?.content || ''),
                msg_type: m.msgType || m.data?.msgType || 'text',
                timestamp: m.serverTime || Date.now(),
                is_sent: String(m.uidFrom) === String(zaloId) ? 1 : 0, status: 'received',
              }));
              setMessages(zaloId!, contactId, converted.reverse());
            }
          }).catch(() => {});
      }
    }
  };

  const handleOpenPhoneResult = (user: any) => {
    // Trong chế độ gộp trang, dùng _searchZaloId được gắn khi tìm kiếm
    const targetZaloId = user._searchZaloId || activeAccountId;
    if (!targetZaloId) return;
    updateContact(targetZaloId, { contact_id: user.uid, display_name: user.display_name || user.zalo_name || user.uid, avatar_url: user.avatar || '', contact_type: 'user' });
    if (mergedInboxMode && user._searchZaloId && user._searchZaloId !== activeAccountId) {
      // Chuyển đúng tài khoản trước khi mở hội thoại
      isManualSelectingRef.current = true;
      setActiveAccount(user._searchZaloId);
      handleSelect(user.uid, 0, user._searchZaloId);
    } else {
      handleSelect(user.uid, 0);
    }
    setPhoneResult(null); setSearch(''); setPhoneSearchPendingPhone(null);
  };

  // Khi chuyển tài khoản: khôi phục thread đang xem của tài khoản đó (hoặc clear nếu chưa có)
  // isManualSelectingRef: ngăn effect override khi chọn thủ công trong chế độ gộp trang
  useEffect(() => {
    if (isManualSelectingRef.current) {
      isManualSelectingRef.current = false;
      return;
    }
    if (!activeAccountId) { setActiveThread(null); return; }
    const saved = useChatStore.getState().perAccountThread[activeAccountId];
    if (saved?.threadId) {
      handleSelect(saved.threadId, saved.threadType);
    } else {
      setActiveThread(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId]);

  /** Chọn hội thoại trong chế độ Gộp trang — tự động chuyển tài khoản */
  const handleMergedClick = async (contact: import('@/store/chatStore').ContactItem) => {
    const zaloId = contact.owner_zalo_id;
    if (!zaloId) return;
    // Lưu thread hiện tại trước khi chuyển
    if (activeAccountId && activeThreadId) {
      saveAccountThread(activeAccountId, activeThreadId, activeThreadType);
    }
    // Đánh dấu thủ công để effect không override
    isManualSelectingRef.current = true;
    // Chuyển tài khoản — zustand cập nhật đồng bộ
    setActiveAccount(zaloId);
    const threadType = contact.contact_type === 'group' ? 1 : 0;
    await handleSelect(contact.contact_id, threadType, zaloId);
    setFilterDropdownOpen(false);
  };


  const handleTogglePin = async (contactId: string, threadType: number) => {
    const acc = useAccountStore.getState().getActiveAccount(); if (!acc) return;
    const wasPinned = pinnedThreads.has(contactId);
    if ((acc.channel || 'zalo') !== 'zalo') {
      // FB: only local pin (Zalo pin API not available)
      await handleToggleLocalPin(contactId);
      return;
    }
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
    const result = await ipc.zalo?.setPinConversation({ auth, conversations: [{ threadId: contactId, type: threadType }], isPin: !wasPinned });
    if (result?.success) {
      setPinnedThreads(prev => { const s = new Set(prev); wasPinned ? s.delete(contactId) : s.add(contactId); return s; });
      showNotification(wasPinned ? 'Đã bỏ ghim hội thoại' : 'Đã ghim hội thoại', 'success');
    } else {
      showNotification('Lỗi ghim: ' + (result?.error || 'Không thể ghim'), 'error');
    }
    setCtxMenu(null);
  };

  const handleToggleLocalPin = async (contactId: string) => {
    const zId = activeAccountId; if (!zId) return;
    const wasPinned = localPinnedThreads.has(contactId);
    await ipc.db?.setLocalPinnedConversation({ zaloId: zId, threadId: contactId, isPinned: !wasPinned });
    setLocalPinnedThreads(prev => { const s = new Set(prev); wasPinned ? s.delete(contactId) : s.add(contactId); return s; });
    showNotification(wasPinned ? 'Đã bỏ ghim khỏi app' : 'Đã ghim trong app', 'success');
    setCtxMenu(null);
  };

  const handleMute = (contactId: string, until: number, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    setMuted(zId, contactId, until);
    showNotification('Đã tắt thông báo', 'success');
    setMuteSubmenuId(null); setCtxMenu(null);
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj) return;
    if ((accObj.channel || 'zalo') !== 'zalo') return; // FB: local-only mute, no Zalo API
    const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    const duration = muteUntilToDuration(until);
    ipc.zalo?.setMute({ auth, threadId: contactId, threadType, duration, action: 1 }).catch(() => {});
  };

  const handleUnmute = (contactId: string, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    clearMuted(zId, contactId);
    showNotification('Đã bật thông báo', 'success');
    setMuteSubmenuId(null); setCtxMenu(null);
    const accObj2 = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj2 || (accObj2.channel || 'zalo') !== 'zalo') return; // FB: local-only, no Zalo API
    const auth = { cookies: accObj2.cookies, imei: accObj2.imei, userAgent: accObj2.user_agent };
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    ipc.zalo?.setMute({ auth, threadId: contactId, threadType, action: 3 }).catch(() => {});
  };

  const handleMoveToOthers = (contactId: string, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    addToOthers(zId, contactId);
    setMuted(zId, contactId, 0);
    showNotification('Đã chuyển vào thư mục Khác và tắt thông báo', 'success');
    setCtxMenu(null);
    // Cập nhật badge taskbar — conversation giờ nằm trong "Khác" nên không đếm nữa
    ipc.app?.setBadge(getFilteredUnreadCount());
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj) return;
    if ((accObj.channel || 'zalo') !== 'zalo') return; // FB: no Zalo mute API
    const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    ipc.zalo?.setMute({ auth, threadId: contactId, threadType, duration: -1, action: 1 }).catch(() => {});
  };

  const handleRemoveFromOthers = (contactId: string, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    removeFromOthers(zId, contactId);
    clearMuted(zId, contactId);
    showNotification('Đã chuyển về danh sách chính và bật thông báo', 'success');
    // Cập nhật badge taskbar — conversation giờ quay lại danh sách chính
    ipc.app?.setBadge(getFilteredUnreadCount());
    setCtxMenu(null);
    const accObj2 = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj2 || (accObj2.channel || 'zalo') !== 'zalo') return; // FB: no Zalo mute API
    const auth2 = { cookies: accObj2.cookies, imei: accObj2.imei, userAgent: accObj2.user_agent };
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    ipc.zalo?.setMute({ auth: auth2, threadId: contactId, threadType, action: 3 }).catch(() => {});
  };

  const handleMarkRead = async (contactId: string, asRead: boolean, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    const isZaloAcc = accObj && (accObj.channel || 'zalo') === 'zalo';
    const auth = (isZaloAcc && accObj) ? { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent } : null;
    const contact = (contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;

    if (asRead) {
      clearUnread(zId, contactId);
      ipc.db?.markAsRead({ zaloId: zId, contactId }).catch(() => {});
      if (auth) ipc.zalo?.removeUnreadMark({ auth, threadId: contactId, type: threadType }).catch(() => {});
      // sendSeenForThread already has its own channel guard
      sendSeenForThread(zId, contactId, threadType, auth);
    } else {
      useChatStore.getState().updateContact(zId, { contact_id: contactId, unread_count: 1 });
      if (auth) ipc.zalo?.addUnreadMark({ auth, threadId: contactId, type: threadType }).catch(() => {});
    }
    setCtxMenu(null);
  };

  const handleAssignLabel = async (contactId: string, labelId: number, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj || !zId) return;
    if ((accObj.channel || 'zalo') !== 'zalo') {
      showNotification('Nhãn Zalo không khả dụng cho kênh Facebook', 'warning');
      return;
    }
    const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };

    // Use 'g' prefix for groups — consistent with Zalo's label API
    const contact = (contacts[zId] || []).find(c => c.contact_id === contactId);
    const isGroupContact = contact?.contact_type === 'group';
    const labelContactId = isGroupContact ? `g${contactId}` : contactId;

    // Helper: fetch latest labels from server
    const fetchFreshLabels = async (): Promise<{ labels: any[]; version: number } | null> => {
      const res = await ipc.zalo?.getLabels({ auth });
      if (res?.response?.labelData) return { labels: res.response.labelData, version: res.response.version || 0 };
      return null;
    };

    // Helper: build updated label list (single label per contact)
    const buildUpdated = (base: any[], alreadyAssigned: boolean) =>
      base.map(l => {
        if (l.id === labelId) {
          const filtered = l.conversations.filter((c: string) => c !== labelContactId && c !== contactId);
          return { ...l, conversations: alreadyAssigned ? filtered : [...filtered, labelContactId] };
        }
        return { ...l, conversations: l.conversations.filter((c: string) => c !== labelContactId && c !== contactId) };
      });

    // Fetch fresh state
    let freshLabels = allLabels[zId] || []; let freshVersion = labelsVersion;
    const fresh = await fetchFreshLabels().catch(() => null);
    if (fresh) { freshLabels = fresh.labels; freshVersion = fresh.version; setLabels(zId, freshLabels); setLabelsVersion(freshVersion); }

    const target = freshLabels.find(l => l.id === labelId); if (!target) return;
    const alreadyHas = target.conversations.includes(labelContactId) || target.conversations.includes(contactId);
    let updated = buildUpdated(freshLabels, alreadyHas);

    // Try update; if Outdated, re-fetch and retry once
    const labelDiffs = [{
      threadId: contactId, threadType: isGroupContact ? 1 : 0,
      labelId: target.id, labelText: target.text || '', labelColor: target.color || '', labelEmoji: target.emoji || '',
      action: alreadyHas ? 'removed' as const : 'assigned' as const,
    }];
    let result = await ipc.zalo?.updateLabels({ auth, labelData: updated, version: freshVersion, labelDiffs });

    if (!result?.success && result?.error?.includes('Outdated')) {
      const retried = await fetchFreshLabels().catch(() => null);
      if (retried) {
        freshLabels = retried.labels; freshVersion = retried.version;
        const retryTarget = freshLabels.find(l => l.id === labelId);
        const retryAlreadyHas = (retryTarget?.conversations.includes(labelContactId) || retryTarget?.conversations.includes(contactId)) ?? false;
        updated = buildUpdated(freshLabels, retryAlreadyHas);
        const retryDiffs = [{
          threadId: contactId, threadType: isGroupContact ? 1 : 0,
          labelId: target.id, labelText: target.text || '', labelColor: target.color || '', labelEmoji: target.emoji || '',
          action: retryAlreadyHas ? 'removed' as const : 'assigned' as const,
        }];
        result = await ipc.zalo?.updateLabels({ auth, labelData: updated, version: freshVersion, labelDiffs: retryDiffs });
      }
    }

    if (!result?.success) {
      showNotification('Lỗi: ' + (result?.error || 'Không thể cập nhật nhãn'), 'error');
      setLabelPickerId(null); setCtxMenu(null);
      return;
    }

    // Apply to local state
    const newVersion = result?.response?.version ?? freshVersion;
    setLabels(zId, updated);
    setLabelsVersion(newVersion);
    showNotification(alreadyHas ? 'Đã gỡ nhãn' : `Đã gán nhãn "${target.text}"`, 'success');
    setLabelPickerId(null); setCtxMenu(null); setInlineLabelPicker(null); setInlineLabelPicker(null);
  };

  const handleDeleteConversation = async (contactId: string, overrideZaloId?: string) => {
    setCtxMenu(null);
    const ok = await showConfirm({
      title: 'Xóa hội thoại này?',
      message: 'Toàn bộ tin nhắn sẽ bị xóa khỏi ứng dụng và không thể khôi phục.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!ok) return;
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;

    const contact = (contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);

    if (accObj && (accObj.channel || 'zalo') === 'zalo') {
      try {
        const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
        const msgRes = await ipc.db?.getMessages({ zaloId: zId, threadId: contactId, limit: 1 });
        const lastMsg = msgRes?.messages?.[0];
        if (lastMsg) {
          const lastMessage = {
            ownerId: String(lastMsg.sender_id || ''),
            cliMsgId: String(lastMsg.cli_msg_id || lastMsg.msg_id || ''),
            globalMsgId: String(lastMsg.msg_id || ''),
          };
          await ipc.zalo?.deleteChat({ auth, lastMessage, threadId: contactId, type: threadType });
        }
      } catch {}
    }

    await ipc.db?.deleteConversation({ zaloId: zId, contactId });
    removeContact(zId, contactId);
    if (activeThreadId === contactId) setActiveThread(null);
    showNotification('Đã xóa hội thoại', 'success');
  };

  // Pre-compute context menu to avoid IIFE inside JSX
  const ctxZaloId = ctxMenu?.zaloId || activeAccountId || '';
  const ctxContact = ctxMenu ? (contacts[ctxZaloId] || accountContacts).find(c => c.contact_id === ctxMenu.contactId) : undefined;
  const ctxMenuEl = ctxMenu && ctxContact ? (() => {
    const contact = ctxContact;
    const threadType = contact.contact_type === 'group' ? 1 : 0;
    const isPinned = pinnedThreads.has(contact.contact_id);
    const isLocalPinned = localPinnedThreads.has(contact.contact_id);
    const ctxIsFB = (contact.channel || 'zalo') === 'facebook';
    const isMuted = isMutedFn(ctxZaloId, contact.contact_id);
    const hasUnread = contact.unread_count > 0;
    const ctxOthers: Set<string> = (allOthers[ctxZaloId] || new Set()) as Set<string>;
    const ctxLabels: LabelData[] = allLabels[ctxZaloId] || [];
    return (
      <div ref={ctxRef} className="fixed z-50 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl py-1 min-w-[190px]"
        style={{ top: Math.min(ctxMenu.y, window.innerHeight - 320), left: Math.min(ctxMenu.x, window.innerWidth - 210) }}>
        <CtxItem icon={hasUnread ? '✅' : '🔵'} label={hasUnread ? 'Đánh dấu đã đọc' : 'Đánh dấu chưa đọc'} onClick={() => handleMarkRead(contact.contact_id, hasUnread, ctxZaloId)} />

        {/* Mute sub-menu */}
        <div className="relative"
          onMouseEnter={() => setMuteSubmenuId(contact.contact_id)}
          onMouseLeave={() => setMuteSubmenuId(null)}>
          {isMuted ? (
            <CtxItem icon="🔔" label="Bật thông báo" onClick={() => handleUnmute(contact.contact_id, ctxZaloId)} />
          ) : (
            <CtxItem icon="🔕" label="Tắt thông báo" hasArrow onClick={() => {}} />
          )}
          {!isMuted && muteSubmenuId === contact.contact_id && (
            <div className="absolute left-full top-0 bg-gray-800 border border-gray-700 rounded-xl shadow-xl min-w-[200px] py-1 z-50">
              {MUTE_OPTIONS.map(opt => (
                <button key={opt.label} onClick={() => handleMute(contact.contact_id, opt.until(), ctxZaloId)}
                  className="w-full flex items-center px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left transition-colors">
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {!ctxIsFB && (
          <CtxItem icon={isPinned ? '📍' : '📌'} label={isPinned ? 'Bỏ ghim (Zalo)' : 'Ghim (đồng bộ Zalo)'} onClick={() => handleTogglePin(contact.contact_id, threadType)} />
        )}
        <CtxItem icon={isLocalPinned ? '🔖' : '📎'} label={isLocalPinned ? 'Bỏ ghim trong app' : 'Ghim trong app'} onClick={() => handleToggleLocalPin(contact.contact_id)} />

        <div className="border-t border-gray-700 my-1" />

        {ctxOthers.has(contact.contact_id) ? (
          <CtxItem icon="🌐" label="Chuyển về Chính" onClick={() => handleRemoveFromOthers(contact.contact_id, ctxZaloId)} />
        ) : (
          <div className="flex items-center">
            <button
              onClick={() => handleMoveToOthers(contact.contact_id, ctxZaloId)}
              className="flex-1 flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left transition-colors"
            >
              <span>📁</span>
              <span>Chuyển vào Khác</span>
            </button>
            <div className="relative group pr-2">
              <span className="w-4 h-4 rounded-full border border-gray-500 text-gray-500 hover:border-gray-300 hover:text-gray-300 flex items-center justify-center text-xs cursor-default select-none transition-colors">
                ?
              </span>
              <div className="absolute right-0 bottom-full mb-1 w-64 bg-gray-900 border border-gray-600 rounded-lg shadow-xl p-3 text-xs text-gray-300 leading-relaxed z-[60] hidden group-hover:block pointer-events-none">
                <p>Dùng để lưu các hội thoại không quan trọng. Các hội thoại trong thư mục này sẽ <span className="text-yellow-400 font-medium">không phát âm thanh</span> và <span className="text-yellow-400 font-medium">không hiện thông báo</span> khi có tin nhắn mới.</p>
              </div>
            </div>
          </div>
        )}

        {contact.contact_type !== 'group' && !ctxIsFB && (
          <>
            <div className="border-t border-gray-700 my-1" />
            <CtxItem icon="👥" label="Mời vào nhóm" onClick={() => { setCtxMenu(null); setInviteContactId(contact.contact_id); }} />
          </>
        )}
        <div className="border-t border-gray-700 my-1" />
        <div className="flex items-center">
          <CtxItem icon="🗑" label="Xóa hội thoại" onClick={() => handleDeleteConversation(contact.contact_id, ctxZaloId)} danger />
          <div className="relative group pr-2">
              <span className="w-4 h-4 rounded-full border border-gray-500 text-gray-500 hover:border-gray-300 hover:text-gray-300 flex items-center justify-center text-xs cursor-default select-none transition-colors">
                ?
              </span>
            <div className="absolute right-0 bottom-full mb-1 w-64 bg-gray-900 border border-gray-600 rounded-lg shadow-xl p-3 text-xs text-gray-300 leading-relaxed z-[60] hidden group-hover:block pointer-events-none">
              <p>Chỉ xoá dữ liệu <span className="text-yellow-400 font-medium">trên app này</span></p>
            </div>
          </div>
        </div>
      </div>
    );
  })() : null;

  return (
    <div className={`flex flex-col h-full border-r border-gray-700 bg-gray-850 relative ${isMobile ? 'w-full' : 'w-72'}`}>
      {/* Search row — Zalo style */}
      <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex items-center gap-1.5">
        {/* Search input wrapper */}
        <div className={`flex items-center gap-2 bg-gray-700/60 border rounded-full px-3 py-1.5 transition-all flex-1 min-w-0 ${searchPanelOpen ? 'border-blue-500 bg-gray-700' : 'border-gray-600 hover:border-gray-500'}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 flex-shrink-0">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setSearchPanelOpen(false); setSearch(''); searchInputRef.current?.blur(); } }}
            placeholder="Tìm kiếm..."
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none min-w-0"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); setPhoneResult(null); setSearchPanelOpen(false); searchInputRef.current?.blur(); }}
              className="w-4 h-4 rounded-full bg-gray-500 hover:bg-gray-400 flex items-center justify-center text-gray-900 flex-shrink-0 transition-colors"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>
        {/* Đóng button when search is active */}
        {searchPanelOpen ? (
          <button
            onClick={() => { setSearchPanelOpen(false); setSearch(''); setPhoneResult(null); searchInputRef.current?.blur(); }}
            className="text-sm text-blue-400 hover:text-blue-300 flex-shrink-0 font-medium transition-colors"
          >
            Đóng
          </button>
        ) : (
          <button title="Tạo nhóm" onClick={() => setCreateGroupOpen(true)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
            </svg>
          </button>
        )}
      </div>

      {/* GlobalSearchPanel — fills remaining space below search bar when active */}
      {searchPanelOpen && (
        <div className="flex-1 overflow-hidden relative">
          <GlobalSearchPanel
            query={search}
            activeAccountId={activeAccountId}
            contacts={mergedInboxMode && mergedContacts ? mergedContacts : accountContacts}
            allAccounts={allAccountsList}
            mergedInboxMode={mergedInboxMode}
            mergedInboxAccounts={mergedInboxAccounts}
            groupInfoCache={groupInfoCache}
            onSelectConversation={(contactId, threadType, overrideZaloId, userInfo) => {
              // Nếu có userInfo từ phone search → cập nhật contact trước khi mở hội thoại
              if (userInfo) {
                const targetZaloId = overrideZaloId || activeAccountId;
                if (targetZaloId) {
                  updateContact(targetZaloId, {
                    contact_id: contactId,
                    display_name: userInfo.display_name,
                    avatar_url: userInfo.avatar_url,
                    contact_type: 'user',
                  });
                }
              }
              if (overrideZaloId && overrideZaloId !== activeAccountId) {
                isManualSelectingRef.current = true;
                setActiveAccount(overrideZaloId);
                handleSelect(contactId, threadType, overrideZaloId);
              } else {
                handleSelect(contactId, threadType);
              }
              setSearchPanelOpen(false);
              setSearch('');
              searchInputRef.current?.blur();
            }}
            onSelectMessage={async (msg) => {
              const threadType = msg.thread_type ?? 0;
              handleSelect(msg.thread_id, threadType);
              setSearchPanelOpen(false);
              setSearch('');
              searchInputRef.current?.blur();

              // Helper: highlight + scroll to element
              const scrollAndHighlight = (el: HTMLElement) => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('ring-2', 'ring-yellow-400', 'ring-opacity-75');
                setTimeout(() => el.classList.remove('ring-2', 'ring-yellow-400', 'ring-opacity-75'), 2500);
              };

              // Wait for handleSelect to load initial messages
              await new Promise(r => setTimeout(r, 400));
              const el = document.getElementById(`msg-${msg.msg_id}`);
              if (el) {
                scrollAndHighlight(el);
                return;
              }

              // Message not in initial page — load messages around its timestamp
              const zaloId = msg.owner_zalo_id || activeAccountId;
              if (!zaloId || !msg.thread_id || !msg.timestamp) return;
              try {
                const aroundRes = await ipc.db?.getMessagesAround({
                  zaloId,
                  threadId: msg.thread_id,
                  timestamp: msg.timestamp,
                  limit: 80,
                });
                const aroundMsgs = aroundRes?.messages;
                if (!aroundMsgs?.length) return;

                setMessages(zaloId, msg.thread_id, aroundMsgs);

                // Wait for React to render, then scroll
                await new Promise<void>(resolve => {
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => resolve());
                  });
                });

                const el2 = document.getElementById(`msg-${msg.msg_id}`);
                if (el2) {
                  scrollAndHighlight(el2);
                }
              } catch (err) {
                console.error('[onSelectMessage] Failed to load messages around target:', err);
              }
            }}
          />
        </div>
      )}

      {/* Filter tabs + Contact list — hidden when global search is open */}
      {!searchPanelOpen && (<>
      <div className="flex border-b border-gray-700 relative">
        <TabBtn label="Tất cả" active={filter === 'all'} onClick={() => { setFilter('all'); setFilterLabelIds([]); setFilterDropdownOpen(false); setMoreMenuOpen(false); }} />
        <TabBtn label="Chưa đọc" active={filter === 'unread'} onClick={() => { setFilter('unread'); setFilterLabelIds([]); setFilterDropdownOpen(false); setMoreMenuOpen(false); }} badge={mergedInboxMode ? mergedUnreadCount : unreadCount} />

        {/* Tab Nhãn (Local + Zalo) */}
        <div className="flex-1 relative" ref={filterRef}>
          <TabBtn
            label="Nhãn"
            active={filter === 'label'}
            onClick={() => {
              setMoreMenuOpen(false);
              if (filter !== 'label') { setFilter('label'); setFilterDropdownOpen(true); }
              else { setFilterDropdownOpen(p => !p); }
            }}
            fullWidth
          />
          {filter === 'label' && filterDropdownOpen && (
            <div className="absolute top-full left-0 z-30 bg-gray-800 border border-gray-700 rounded-xl shadow-xl min-w-[220px] py-1">
              {/* Local / Zalo sub-tabs */}
              <div className="px-2 pt-1.5 pb-1 border-b border-gray-700/60">
                <div className="flex bg-gray-700/60 rounded-md p-0.5 gap-0.5">
                  <button onClick={() => { setFilterLabelSource('local'); setFilterLabelIds([]); }}
                    className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                      filterLabelSource === 'local' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                    }`}>💾 Local</button>
                  <button onClick={() => { setFilterLabelSource('zalo'); setFilterLabelIds([]); }}
                    className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                      filterLabelSource === 'zalo' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                    }`}>☁️ Zalo</button>
                </div>
              </div>

              {filterLabelSource === 'local' ? (
                /* ── Local labels list (multi-select) ── */
                <>
                  <button onClick={() => { setFilterLabelIds([]); setFilterDropdownOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-700 text-left ${filterLabelIds.length === 0 ? 'text-white' : 'text-gray-400'}`}>
                    <span className="w-3 h-3 rounded-full bg-gray-500 flex-shrink-0" />
                    <span>Tất cả Nhãn Local</span>
                    {filterLabelIds.length === 0 && <span className="ml-auto text-blue-400">✓</span>}
                  </button>
                  {localLabels.length === 0 ? (
                    <p className="text-xs text-gray-500 px-3 py-2 italic">Chưa có Nhãn Local</p>
                  ) : localLabels.map(l => {
                    const isActive = filterLabelIds.includes(l.id);
                    return (
                      <button key={l.id} onClick={() => {
                        setFilterLabelIds(prev => isActive ? prev.filter(x => x !== l.id) : [...prev, l.id]);
                      }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-700 text-left ${isActive ? 'text-white' : 'text-gray-300'}`}>
                        <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[10px] ${isActive ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-500'}`}>
                          {isActive && '✓'}
                        </span>
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: l.color || '#3b82f6' }} />
                        {l.emoji && <span>{l.emoji}</span>}
                        <span className="truncate">{l.name}</span>
                      </button>
                    );
                  })}
                </>
              ) : (
                /* ── Zalo labels list ── */
                <>
                  {/* Cập nhật */}
                  <div className="px-3 py-1.5 border-b border-gray-700/60 flex items-center justify-between">
                    <span className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">Nhãn Zalo</span>
                    <button
                      onClick={async () => {
                        if (syncingLabels) return;
                        setSyncingLabels(true);
                        try {
                          if (mergedInboxMode) {
                            for (const zaloId of mergedInboxAccounts) {
                              const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
                              if (!accObj || (accObj.channel || 'zalo') !== 'zalo') continue;
                              const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
                              const res = await ipc.zalo?.getLabels({ auth });
                              if (res?.response?.labelData) setLabels(zaloId, res.response.labelData);
                            }
                            showNotification('Đã cập nhật nhãn cho tất cả tài khoản', 'success');
                          } else {
                            const acc = useAccountStore.getState().getActiveAccount();
                            if (!acc || !activeAccountId) return;
                            const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
                            const res = await ipc.zalo?.getLabels({ auth });
                            if (res?.response?.labelData) {
                              setLabels(activeAccountId, res.response.labelData);
                              setLabelsVersion(res.response.version || 0);
                              showNotification('Đã cập nhật danh sách nhãn', 'success');
                            }
                          }
                        } catch { showNotification('Lỗi cập nhật nhãn', 'error'); }
                        finally { setSyncingLabels(false); }
                      }}
                      disabled={syncingLabels}
                      className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={syncingLabels ? 'animate-spin' : ''}>
                        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                      </svg>
                      <span>Cập nhật</span>
                    </button>
                  </div>
                  <button onClick={() => { setFilterLabelIds([]); setFilterDropdownOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-700 text-left ${filterLabelIds.length === 0 ? 'text-white' : 'text-gray-400'}`}>
                    <span className="w-3 h-3 rounded-full bg-gray-500 flex-shrink-0" />
                    <span>Tất cả nhãn Zalo</span>
                    {filterLabelIds.length === 0 && <span className="ml-auto text-blue-400">✓</span>}
                  </button>
                  {(mergedInboxMode ? mergedLabels! : labels).length === 0 ? (
                    <p className="text-xs text-gray-500 px-3 py-2 italic">Chưa có nhãn Zalo</p>
                  ) : (mergedInboxMode ? mergedLabels! : labels).map(l => {
                    const isActive = filterLabelIds.includes(l.id);
                    return (
                      <button key={l.id} onClick={() => {
                        setFilterLabelIds(prev => isActive ? prev.filter(x => x !== l.id) : [...prev, l.id]);
                      }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-700 text-left ${isActive ? 'text-white' : 'text-gray-300'}`}>
                        <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[10px] ${isActive ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-500'}`}>
                          {isActive && '✓'}
                        </span>
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: l.color || '#3b82f6' }} />
                        {l.emoji && <span>{l.emoji}</span>}
                        <span className="truncate">{l.text}</span>
                      </button>
                    );
                  })}
                  {/* Chỉnh sửa nhãn Zalo */}
                  <div className="px-3 py-2 border-t border-gray-700 mt-1">
                    <button
                      onClick={() => {
                        setFilterDropdownOpen(false);
                        if (mergedInboxMode) setEditLabelsPickerOpen(true);
                        else setEditLabelsZaloId(activeAccountId);
                      }}
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                      <span>Chỉnh sửa nhãn{mergedInboxMode ? ' (chọn trang)' : ''}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Menu 3 chấm - Chứa Chưa trả lời & Khác */}
        <div className="flex-shrink-0 relative" ref={moreMenuRef}>
          <button
            onClick={() => {
              setFilterDropdownOpen(false);
              setMoreMenuOpen(p => !p);
            }}
            className={`h-10 px-3 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors ${(filter === 'unreplied' || filter === 'others' || channelFilter !== 'all' || moreMenuOpen) ? 'bg-gray-700 text-white' : ''}`}
            title="Thêm"
          >
            <div className="relative">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="12" cy="19" r="2"/>
              </svg>
              {(mergedInboxMode ? mergedOthersUnreadCount : othersUnreadCount) > 0 && filter !== 'others' && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
              )}
            </div>
          </button>

          {moreMenuOpen && (
            <div className="absolute top-full left-0 z-30 bg-gray-800 border border-gray-700 rounded-xl shadow-xl min-w-[160px] py-1 mt-1">
              {/*<button*/}
              {/*  onClick={() => {*/}
              {/*    setFilter('unreplied');*/}
              {/*    setFilterLabelId(null);*/}
              {/*    setMoreMenuOpen(false);*/}
              {/*  }}*/}
              {/*  className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-700 text-left ${filter === 'unreplied' ? 'text-white bg-gray-700/50' : 'text-gray-300'}`}*/}
              {/*>*/}
              {/*  <span>💬</span>*/}
              {/*  <span>Chưa trả lời</span>*/}
              {/*  {unrepliedCount > 0 && <span className="ml-auto bg-blue-600 text-white text-xs rounded-full px-1.5 min-w-[18px] text-center">{unrepliedCount}</span>}*/}
              {/*  {filter === 'unreplied' && <span className="ml-auto text-blue-400">✓</span>}*/}
              {/*</button>*/}

              <button
                onClick={() => {
                  setFilter('others');
                  setFilterLabelIds([]);
                  setMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-700 text-left ${filter === 'others' ? 'text-white bg-gray-700/50' : 'text-gray-300'}`}
              >
                <span>🧩</span>
                <span>Khác</span>
                {othersCount > 0 && <span className="ml-auto bg-gray-600 text-white text-xs rounded-full px-1.5 min-w-[18px] text-center">{othersCount}</span>}
                {filter === 'others' && <span className="ml-auto text-blue-400">✓</span>}
                <div className="relative group pr-2">
                  <span className="w-4 h-4 rounded-full border border-gray-500 text-gray-500 hover:border-gray-300 hover:text-gray-300 flex items-center justify-center text-xs cursor-default select-none transition-colors">
                    ?
                  </span>
                    <div className="absolute right-0 top-full mb-1 w-64 bg-gray-900 border border-gray-600 rounded-lg shadow-xl p-3 text-xs text-gray-300 leading-relaxed z-[60] hidden group-hover:block pointer-events-none">
                      <p>Dùng để lưu các hội thoại không quan trọng. Các hội thoại trong thư mục này sẽ <span className="text-yellow-400 font-medium">không phát âm thanh</span> và <span className="text-yellow-400 font-medium">không hiện thông báo</span> khi có tin nhắn mới.</p>
                    </div>
                </div>
              </button>

              {/* Channel filter submenu */}
              <div className="border-t border-gray-700 mt-1 pt-1">
                <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wider">Kênh</div>
                {(['all', 'zalo', 'facebook'] as const).map(ch => (
                  <button
                    key={ch}
                    onClick={() => { setChannelFilter(ch); setMoreMenuOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-700 text-left ${channelFilter === ch ? 'text-white bg-gray-700/50' : 'text-gray-300'}`}
                  >
                    <span>{ch === 'all' ? '🌐' : ch === 'zalo' ? '💙' : '💜'}</span>
                    <span>{ch === 'all' ? 'Tất cả kênh' : ch === 'zalo' ? 'Zalo' : 'Facebook'}</span>
                    {channelFilter === ch && <span className="ml-auto text-blue-400">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Merged inbox: cần chọn tài khoản để tìm SĐT trên Zalo */}
      {phoneSearchPendingPhone && !phoneSearching && !phoneResult && (
        <div className="border-b border-gray-700 bg-gray-900 px-3 py-2">
          <p className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Chọn tài khoản để tìm <span className="text-white font-medium">{phoneSearchPendingPhone}</span>:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {mergedInboxAccounts.map(zaloId => {
              const acc = allAccountsList.find(a => a.zalo_id === zaloId);
              if (!acc) return null;
              return (
                <button
                  key={zaloId}
                  onClick={async () => {
                    setPhoneSearchPendingPhone(null);
                    await doPhoneSearch(acc, phoneSearchPendingPhone!);
                  }}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors"
                >
                  {acc.avatar_url
                    ? <img src={acc.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                    : <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{(acc.full_name || zaloId).charAt(0).toUpperCase()}</div>
                  }
                  <span className="truncate max-w-[80px]">{acc.full_name || acc.phone || zaloId}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Phone search result */}
      {(phoneSearching || phoneResult) && (
        <div className="border-b border-gray-700 bg-gray-800 px-3 py-2">
          {phoneSearching ? <p className="text-xs text-gray-400">Đang tìm...</p> : phoneResult ? (
            phoneResult._notFound ? (
              <p className="text-xs text-gray-500">Không tìm thấy người dùng với số này hoặc người dùng đã chặn tìm kiếm với người lạ</p>
            ) : (
            <div className="flex items-center gap-2">
              {phoneResult.avatar ? <img src={phoneResult.avatar} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                : <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">{(phoneResult.display_name || 'U').charAt(0).toUpperCase()}</div>}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 truncate">{phoneResult.display_name || phoneResult.zalo_name}</p>
                {phoneResult.isBlocked === 1 ? <p className="text-xs text-red-400">🚫 Đã chặn</p>
                  : phoneResult.isFr === 1 ? <p className="text-xs text-green-400">✓ Bạn bè</p>
                  : phoneResult._sentRequest ? <p className="text-xs text-yellow-400">✓ Đã gửi lời mời</p>
                  : <p className="text-xs text-gray-400">Chưa kết bạn</p>}
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {phoneResult.isBlocked !== 1 && phoneResult.isFr !== 1 && !phoneResult._sentRequest && (
                  <button
                    onClick={() => setAddFriendModal({ userId: phoneResult.uid, displayName: phoneResult.display_name || phoneResult.zalo_name || phoneResult.uid, avatar: phoneResult.avatar || '' })}
                    className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded-lg">
                    + Kết bạn
                  </button>
                )}
                <button onClick={() => handleOpenPhoneResult(phoneResult)} className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-2 py-1 rounded-lg">💬</button>
              </div>
            </div>
            )
          ) : null}
        </div>
      )}

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto relative" ref={listContainerRef}>
        {/* Loading spinner overlay — hiện khi đang tải avatar nhóm, không chặn danh sách */}
        {loadingGroupAvatars && (
          <div className="sticky top-0 z-20 flex items-center justify-center py-1.5 bg-gray-850/80 backdrop-blur-sm border-b border-gray-700/40">
            <svg className="animate-spin h-4 w-4 text-blue-400 mr-2" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <span className="text-xs text-gray-400">Đang tải avatar nhóm...</span>
          </div>
        )}
        {(mergedInboxMode ? (filteredMerged?.length ?? 0) : filtered.length) === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm"><p>Không có hội thoại</p></div>
        ) : (mergedInboxMode ? filteredMerged! : filtered).slice(0, displayCount).map((contact) => {
          const threadType = contact.contact_type === 'group' ? 1 : 0;
          const contactZaloId = contact.owner_zalo_id || activeAccountId || '';
          const isPinned = pinnedThreads.has(contact.contact_id);
          const isLocalPinned = localPinnedThreads.has(contact.contact_id);
          const isMuted = contactZaloId ? isMutedFn(contactZaloId, contact.contact_id) : false;
          const isHovered = hoveredId === `${contact.owner_zalo_id}_${contact.contact_id}`;
          const isGroupC = contact.contact_type === 'group';
          const labelCId = isGroupC ? `g${contact.contact_id}` : contact.contact_id;
          const contactLabels = (allLabels[contactZaloId] || []).filter(l =>
            l.conversations?.includes(labelCId) || l.conversations?.includes(contact.contact_id)
          );
          // Local labels for this thread
          const threadLocalLabelIds = (localLabelThreadMapByAccount[contactZaloId] || {})[contact.contact_id] || [];
          const threadLocalLabelsArr = threadLocalLabelIds
            .map(lid => (localLabelsByAccount[contactZaloId] || []).find(l => l.id === lid))
            .filter(Boolean) as LocalLabelData[];
          // Badge tài khoản sở hữu (chỉ trong chế độ Gộp trang)
          const ownerAcc = mergedInboxMode ? allAccountsList.find(a => a.zalo_id === contact.owner_zalo_id) : null;
          return (
            <div key={`${contact.owner_zalo_id}_${contact.contact_id}`}
              className={`relative w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-700 transition-colors cursor-pointer ${threadLocalLabelsArr.length > 0 ? 'min-h-[72px]' : 'max-h-[80px] min-h-[80px]'} ${activeThreadId === contact.contact_id && activeAccountId === contact.owner_zalo_id ? 'bg-gray-700' : ''}`}
              onClick={() => { if (mergedInboxMode) { handleMergedClick(contact); } else { handleSelect(contact.contact_id, threadType); setFilterDropdownOpen(false); } }}
              onMouseEnter={() => setHoveredId(`${contact.owner_zalo_id}_${contact.contact_id}`)}
              onMouseLeave={() => setHoveredId(null)}>
              <div className="relative flex-shrink-0">
                {threadType === 1 ? (
                  <GroupAvatar
                    avatarUrl={contact.avatar_url}
                    groupInfo={(groupInfoCache[contact.owner_zalo_id] || {})[contact.contact_id]}
                    name={contact.alias || contact.display_name}
                    size="md"
                  />
                ) : (
                  contact.avatar_url ? <img src={contact.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover" />
                    : <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold bg-blue-600">{(contact.alias || contact.display_name).charAt(0).toUpperCase()}</div>
                )}
                {/* Badge tài khoản — chỉ hiện trong chế độ Gộp trang */}
                {mergedInboxMode && ownerAcc && (
                  <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border border-gray-800 overflow-hidden z-10 flex-shrink-0" title={ownerAcc.full_name || ownerAcc.zalo_id}>
                    {ownerAcc.avatar_url
                      ? <img src={ownerAcc.avatar_url} alt="" className="w-full h-full object-cover" />
                      : <div className="w-full h-full bg-purple-600 flex items-center justify-center text-white text-[6px] font-bold">{(ownerAcc.full_name || ownerAcc.zalo_id).charAt(0).toUpperCase()}</div>
                    }
                  </div>
                )}
                {/* Channel badge overlay — hiện trong chế độ Gộp trang */}
                {mergedInboxMode && (
                  <div className="absolute -top-0.5 -left-0.5 z-10">
                    <ChannelBadgeOverlay channel={(contact.channel || 'zalo') as Channel} size="xs" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-sm font-medium text-gray-200 truncate flex items-center gap-1">
                    {isLocalPinned && <span title="Ghim trong app">📎</span>}
                    {isPinned && <span title="Ghim Zalo">📌</span>}
                    {contact.alias || contact.display_name || contact.contact_id}
                  </span>
                  {/* Fixed-width slot: always reserve space to prevent layout shift on hover */}
                  <div className="flex-shrink-0 w-14 flex items-center justify-end gap-1">
                    {isHovered ? (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); setCtxMenu({ contactId: contact.contact_id, zaloId: contactZaloId, x: e.clientX, y: e.clientY }); setLabelPickerId(null); }}
                          className="w-6 h-4 flex items-center justify-center rounded-md hover:bg-gray-600 text-gray-400 hover:text-white">
                          {/* Horizontal 3-dot (⋯) */}
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
                          </svg>
                        </button>
                      </>
                    ) : contact.last_message_time ? (
                      <span className="text-xs text-gray-500 whitespace-nowrap">{formatTime(contact.last_message_time)}</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-1 mt-1">
                  <span className="text-sm text-gray-500 truncate flex items-center gap-1">
                    {/* Zalo label icon before lastMessage */}
                    {contactLabels.length > 0 && (
                      <span
                        className="inline-flex items-center justify-center w-4 h-4 rounded flex-shrink-0"
                        style={{ backgroundColor: contactLabels[0].color || '#3b82f6' }}
                        title={contactLabels[0].text}
                      >
                        {contactLabels[0].emoji
                          ? <span className="text-[7px] leading-none">{contactLabels[0].emoji}</span>
                          : <svg width="12" height="12" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1.5"/></svg>
                        }
                      </span>
                    )}
                    <span className="truncate">
                      {(() => {
                        const draftKey = `${contactZaloId}_${contact.contact_id}`;
                        const draftText = contact.contact_id !== activeThreadId ? drafts[draftKey] : undefined;
                        if (draftText) {
                          return <><span className="text-red-400">Chưa gửi: </span><span className="text-gray-400">{draftText}</span></>;
                        }
                        return formatLastMessage(contact.last_message) || (contact.phone ? `📞 ${contact.phone}` : '');
                      })()}
                    </span>
                  </span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isMuted && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>}
                    {contact.unread_count > 0
                      ? <span className="bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">{contact.unread_count > 99 ? '99+' : contact.unread_count}</span>
                      : contact.is_replied === 1
                        ? (
                          /* Icon double-checkmark "đã trả lời" */
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
                        )
                        : null
                    }
                  </div>
                </div>
                {/* Local labels: pill tags on conversation item */}
                {threadLocalLabelsArr.length > 0 && (
                  <div className="flex items-center gap-1 mt-1.5 overflow-hidden">
                    {threadLocalLabelsArr.slice(0, 3).map(label => (
                      <span key={label.id}
                        className="inline-flex items-center gap-0.5 px-2 py-1 rounded-full text-[11px] flex-shrink-0 max-w-[100px] leading-none"
                        style={{ backgroundColor: label.color || '#3b82f6', color: label.text_color || '#ffffff' }}
                        title={label.name}
                      >
                        {label.emoji && <span className="text-[8px] leading-none">{label.emoji}</span>}
                        <span className="truncate">{label.name}</span>
                      </span>
                    ))}
                    {threadLocalLabelsArr.length > 3 && <span className="text-[9px] text-gray-500">+{threadLocalLabelsArr.length - 3}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {/* Sentinel element for infinite scroll */}
        {displayCount < (mergedInboxMode ? filteredMerged?.length ?? 0 : filtered.length) && (
          <div ref={sentinelRef} className="h-1 w-full" />
        )}
      </div>
      </>)} {/* end !searchPanelOpen */}

      {/* Inline label picker (click on label tag) */}
      {!searchPanelOpen && inlineLabelPicker && (
        <InlineLabelPickerPopup
          contactId={inlineLabelPicker.contactId}
          x={inlineLabelPicker.x}
          y={inlineLabelPicker.y}
          labels={allLabels[inlineLabelPicker.zaloId] || labels}
          onAssign={(labelId) => handleAssignLabel(inlineLabelPicker.contactId, labelId, inlineLabelPicker.zaloId)}
          onClose={() => setInlineLabelPicker(null)}
          onEditLabels={() => { setInlineLabelPicker(null); setEditLabelsZaloId(inlineLabelPicker.zaloId); }}
          onSync={async () => {
            const zId = inlineLabelPicker.zaloId;
            setSyncingLabels(true);
            try {
              const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
              if (!accObj) return;
              const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
              const res = await ipc.zalo?.getLabels({ auth });
              if (res?.response?.labelData) {
                setLabels(zId, res.response.labelData);
                setLabelsVersion(res.response.version || 0);
                showNotification('Đã cập nhật nhãn', 'success');
              }
            } catch { showNotification('Lỗi cập nhật nhãn', 'error'); }
            finally { setSyncingLabels(false); }
          }}
          syncingLabels={syncingLabels}
        />
      )}

      {/* Context menu */}
      {ctxMenuEl}

      {/* Modals */}
      {createGroupOpen && <CreateGroupModal onClose={() => setCreateGroupOpen(false)} />}
      {inviteContactId && (
        <InviteToGroupModal
          contactId={inviteContactId}
          contactName={accountContacts.find(c => c.contact_id === inviteContactId)?.display_name}
          onClose={() => setInviteContactId(null)} />
      )}
      {editLabelsOpen && (
        <EditLabelsModal
          labels={labels}
          labelsVersion={labelsVersion}
          onClose={() => setEditLabelsOpen(false)}
          onSave={(newLabels, newVersion) => {
            setLabels(activeAccountId!, newLabels);
            setLabelsVersion(newVersion);
          }}
        />
      )}
      {editLabelsZaloId && (
        <EditLabelsModal
          labels={allLabels[editLabelsZaloId] || []}
          labelsVersion={labelsVersion}
          overrideZaloId={editLabelsZaloId}
          onClose={() => setEditLabelsZaloId(null)}
          onSave={(newLabels, newVersion) => {
            setLabels(editLabelsZaloId, newLabels);
            setLabelsVersion(newVersion);
          }}
        />
      )}
      {/* Account picker for editing labels in merged mode */}
      {editLabelsPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditLabelsPickerOpen(false)}>
          <div className="bg-gray-800 rounded-xl shadow-2xl w-72 flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <h3 className="text-sm font-semibold text-white">Chọn trang để chỉnh sửa nhãn</h3>
              <button onClick={() => setEditLabelsPickerOpen(false)} className="text-gray-400 hover:text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="py-2">
              {mergedInboxAccounts.map(zaloId => {
                const acc = allAccountsList.find(a => a.zalo_id === zaloId);
                const accLabels = allLabels[zaloId] || [];
                return (
                  <button key={zaloId}
                    onClick={() => { setEditLabelsPickerOpen(false); setEditLabelsZaloId(zaloId); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700 text-left transition-colors"
                  >
                    {acc?.avatar_url
                      ? <img src={acc.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                      : <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{(acc?.full_name || zaloId).charAt(0).toUpperCase()}</div>
                    }
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 truncate">{acc?.full_name || zaloId}</p>
                      <p className="text-gray-500 text-[12px]">{acc?.phone || zaloId}</p>
                      <p className="text-xs text-gray-500">{accLabels.length} nhãn</p>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 flex-shrink-0">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Add-friend compose modal */}
      {addFriendModal && (
        <AddFriendModal
          displayName={addFriendModal.displayName}
          avatar={addFriendModal.avatar}
          sending={sendingFriendReq}
          onConfirm={async (msg) => {
            const acc = useAccountStore.getState().getActiveAccount();
            if (!acc) return;
            setSendingFriendReq(true);
            try {
              await ipc.zalo?.sendFriendRequest({
                auth: { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent },
                userId: addFriendModal.userId,
                msg,
              });
              setPhoneResult((p: any) => p?.uid === addFriendModal.userId ? { ...p, _sentRequest: true } : p);
              setAddFriendModal(null);
            } catch (err: any) {
              alert('Gửi lời mời thất bại: ' + (err?.message || err));
            } finally {
              setSendingFriendReq(false);
            }
          }}
          onClose={() => !sendingFriendReq && setAddFriendModal(null)}
        />
      )}
    </div>
  );
}

function TabBtn({ label, active, onClick, badge, fullWidth }: { label: string; active: boolean; onClick: () => void; badge?: number; fullWidth?: boolean }) {
  return (
    <button onClick={onClick} className={`${fullWidth ? 'w-full' : 'flex-1'} h-10 flex items-center justify-center text-xs font-medium transition-colors whitespace-nowrap px-3 ${active ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>
      {label}
      {badge !== undefined && badge > 0 && <span className="ml-1 bg-blue-600 text-white text-[9px] rounded-full px-1.5 min-w-[16px] text-center">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

function CtxItem({ icon, label, onClick, hasArrow, danger }: { icon: string; label: string; onClick: () => void; hasArrow?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${danger ? 'text-red-400 hover:bg-red-900/30 hover:text-red-300' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}>
      <span className="w-4 text-center flex-shrink-0 text-base">{icon}</span>
      <span className="flex-1">{label}</span>
      {hasArrow && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>}
    </button>
  );
}

function formatLastMessage(msg: string | undefined): string {
  if (!msg) return '';
  if (!msg.startsWith('{')) {
    // Handle legacy "text[Type]" format stored from old Zalo API responses
    // e.g. "0[Hình ảnh]" (empty text + image) or "Hello[Hình ảnh]" (text + image)
    const bracketMatch = msg.match(/^(.*?)\[([^\]]+)\]$/);
    if (bracketMatch) {
      const textPart = bracketMatch[1];
      const typePart = bracketMatch[2];
      // Return the text part if it's meaningful (not empty / "0" / "null")
      if (textPart && textPart !== '0' && textPart !== 'null' && textPart.trim()) return textPart;
      // Otherwise map type label to emoji label
      const typeMap: Record<string, string> = {
        'Hình ảnh': '🖼 Hình ảnh',
        'Video': '🎥 Video',
        'Sticker': '🎭 Nhãn dán',
        'GIF': '🎬 GIF',
        'File': '📂 File',
        'Giọng nói': '🎙 Tin nhắn thoại',
        'Âm thanh': '🎙 Tin nhắn thoại',
      };
      return typeMap[typePart] ?? `[${typePart}]`;
    }
    return msg;
  }
  try {
    const p = JSON.parse(msg);
    const mt = (p?.msgType || '').toLowerCase();
    // chat.recommended với action cuộc gọi (recommened.calltime / recommened.misscall)
    const action = String(p?.action || '');
    if (action === 'recommened.misscall') return '📵 Cuộc gọi nhỡ';
    if (action === 'recommened.calltime') {
      const params = (() => { try { const pr = p?.params; return typeof pr === 'string' ? JSON.parse(pr) : (pr || {}); } catch { return {}; } })();
      const secs = params.duration || 0;
      if (secs > 0) {
        const m = Math.floor(secs / 60), s = secs % 60;
        return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
      }
      return '📞 Cuộc gọi';
    }
    // Handle chat.recommended messages
    if (action.startsWith('recommened.') || action.startsWith('chat.recommended')) {
      const params = (() => { try { const pr = p?.params; return typeof pr === 'string' ? JSON.parse(pr) : (pr || {}); } catch { return {}; } })();
      
      // Link preview (recommened.link) - show media title prominently
      if (action === 'recommened.link') {
        const mediaTitle = params.mediaTitle || params.src || '';
        // Only show title, not description (matching Zalo's conversation list style)
        if (mediaTitle) {
          return mediaTitle;
        }
        // Fallback to URL hostname if no title
        const href = p?.href || p?.title || '';
        if (href && href.includes('://')) {
          try {
            const url = new URL(href);
            return `🔗 ${url.hostname}`;
          } catch { }
        }
        return '🔗 Link';
      }
      
      // Other recommended messages (text suggestions, etc.)
      const textContent = params.content || params.message || params.text || p?.content || p?.msg;
      if (textContent && typeof textContent === 'string' && textContent.trim()) {
        return textContent;
      }
      return '[Tin nhắn gợi ý]';
    }
    // Call messages (legacy format)
    if (mt.includes('call') || p?.call_id || p?.callId || p?.callType !== undefined) {
      if (p?.missed || p?.status === 2) return '📵 Cuộc gọi nhỡ';
      const secs = p?.duration || p?.call_duration;
      if (secs) {
        const m = Math.floor(secs / 60), s = secs % 60;
        return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
      }
      return '📞 Cuộc gọi';
    }
    // Voice / audio messages
    if (mt.includes('voice') || mt.includes('audio')) {
      const secs = p?.duration || 0;
      return `🎙 Tin nhắn thoại${secs ? ` (${secs}s)` : ''}`;
    }
    // Sticker
    if (mt.includes('sticker') || p?.sticker_id || p?.stickerId) {
      return '🎭 Nhãn dán';
    }
    // GIF
    if (mt.includes('gif')) {
      return '🎬 GIF';
    }
    // Video
    if (mt.includes('video')) {
      return '🎥 Video';
    }
    // File with title — only when msgType is file OR content has file-specific fields
    if (mt.includes('file') || mt === 'share.file') return p?.title ? `📂 ${p.title}` : '📂 [File]';
    // Parse params for further checks
    const par = (() => { try { return typeof p?.params === 'string' ? JSON.parse(p.params) : (p?.params || {}); } catch { return {}; } })();
    // File heuristic: title + file-specific fields
    if (p?.title && (par?.fileSize || par?.fileExt || par?.fileUrl || p?.normalUrl || p?.fileUrl)) return `📂 ${p.title}`;
    // Image (by URL fields) — but prefer text content if the message has both
    if (p?.href || par?.hd || par?.rawUrl || p?.thumb) {
      const textContent = (typeof p?.content === 'string' ? p.content : null) || (typeof p?.msg === 'string' ? p.msg : null);
      if (textContent && textContent.trim() && textContent !== '0' && textContent !== 'null') return textContent;
      return '🖼 Hình ảnh';
    }
    // title without file markers → plain text (reminder, link preview, etc.)
    if (p?.title && typeof p.title === 'string') return p.title;
    // Wrapped text
    if (p?.content && typeof p.content === 'string') return p.content;
    if (p?.msg && typeof p.msg === 'string') return p.msg;
    return '[Đính kèm]';
  } catch {}
  return msg;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Hôm qua';
  if (days < 7) return `${days} ngày`;
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}


// ─── InlineLabelPickerPopup ───────────────────────────────────────────────────
function InlineLabelPickerPopup({ contactId, x, y, labels, onAssign, onClose, onEditLabels, onSync, syncingLabels }: {
  contactId: string;
  x: number;
  y: number;
  labels: LabelData[];
  onAssign: (labelId: number) => void;
  onClose: () => void;
  onEditLabels?: () => void;
  onSync?: () => void;
  syncingLabels?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
      document.addEventListener('keydown', keyHandler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  // Determine if contact is a group by looking at label conversations prefixed with 'g'
  const isGroup = labels.some(l =>
    l.conversations.includes(`g${contactId}`) && !l.conversations.includes(contactId)
  ) || labels.some(l => l.conversations.includes(`g${contactId}`));

  const top = Math.min(y + 4, window.innerHeight - (labels.length * 36 + 80));
  const left = Math.min(x, window.innerWidth - 200);

  return (
    <div
      ref={ref}
      className="fixed z-[200] bg-gray-800 border border-gray-700 rounded-xl shadow-2xl min-w-[185px]"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
    >
      <p className="text-[11px] text-gray-500 px-3 pt-1.5 pb-1 font-medium uppercase tracking-wide">Nhãn</p>
      <LabelPicker
        labels={labels}
        activeThreadId={contactId}
        isGroup={isGroup}
        onToggleLabel={(label) => onAssign(label.id)}
        onEditLabels={onEditLabels}
        onSync={onSync}
        syncingLabels={syncingLabels}
      />
    </div>
  );
}

// ─── EditLabelsModal is now exported from LabelPicker.tsx ────────────────────
