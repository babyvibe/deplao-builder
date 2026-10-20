import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore, CachedGroupInfo, GroupMember } from '@/store/appStore';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/useEmployeeResync';
import { LOCAL_PIN_CHANGED_EVENT } from '@/lib/chat/relayUiEvents';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { AddMemberToGroupModal } from './GroupModals';
import ForumTopicsPanel from './ForumTopicsPanel';
import { UserProfilePopup } from '../common/UserProfilePopup';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/utils/apiError';
import GroupAvatar from '../common/GroupAvatar';
import MediaSection, { MediaDetailPanel, MediaTab } from './MediaSection';
import { GroupActionSection } from './ConversationActions';
import { syncZaloGroups, MemberPlaceholder } from '@/lib/zaloGroupUtils';
import { getCapability, channelSupports, type Channel, type ChannelCapability } from '../../../configs/channelConfig';
import { CHANNEL, isZalo as isZaloCh, isTelegram as isTelegramCh, isFacebook as isFacebookCh, isNonZalo } from '@/lib/channelHelper';
import { Spinner } from '@/components/common/PageLoading';
import * as channelIpc from '@/lib/channelIpc';
import { getAdapter } from '@/lib/adapters/registry';
import TelegramChatSettings from './quick/telegram/TelegramChatSettings';
import { useGroupMemberSync } from '@/hooks/useGroupMemberSync';
import { ArrowDownIcon, ArrowUpIcon, BellIcon, BellOffIcon, CloseIcon, MapPinIcon, PinIcon, SettingsIcon, TrashIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import { toLocalMediaUrl } from '@/lib/localMedia';
import {
  GROUP_MEMBERS_PAGE_SIZE, appendMemberPage, groupMembersApiSyncedAt, markGroupMembersApiSynced, memberFromRow,
  mergeGroupMembers, withLiveMemberInfo,
} from '@/lib/chat/groupMembersPanel';
import { groupAdminRole, groupOwnerRole, groupRoleKind, groupRoleLabel, myGroupRoleKind } from '../../../shared/groupMemberRoles';
import PeerInitials from '@/components/common/PeerInitials';


type PanelView = 'info' | 'members' | 'manage' | 'media' | 'pending' | 'topics';

// ─── Pending members cache (5-min TTL, module-level) ─────────────────────────
const PENDING_CACHE_TTL = 5 * 60 * 1000;
type PendingMember = { userId: string; displayName: string; avatar: string };
const pendingMembersCache = new Map<string, { data: PendingMember[]; ts: number }>();

function formatTelegramMemberStatus(member: GroupMember): string {
  if (member.statusText === 'Đang online') return member.statusText;
  if (member.lastSeenAt) {
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - member.lastSeenAt);
    if (elapsed < 60) return 'Vừa hoạt động';
    if (elapsed < 3600) return `Hoạt động ${Math.floor(elapsed / 60)} phút trước`;
    if (elapsed < 86400) return `Hoạt động ${Math.floor(elapsed / 3600)} giờ trước`;
    return `Hoạt động ${Math.floor(elapsed / 86400)} ngày trước`;
  }
  return member.statusText || '';
}

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
  // API returns: { time, users: [{ uid, dpn, avatar, user_submit }] }
  const rawList: any[] = res?.response?.users || [];

  if (rawList.length === 0) {
    pendingMembersCache.set(key, { data: [], ts: Date.now() });
    return [];
  }

  const profiles: PendingMember[] = rawList.map((item: any) => ({
    userId: item.uid || item.id || item.userId || String(item),
    displayName: item.dpn || item.displayName || item.display || item.name || item.uid || '',
    avatar: item.avatar || item.avt || '',
  })).filter(p => p.userId);

  pendingMembersCache.set(key, { data: profiles, ts: Date.now() });
  return profiles;
}

function invalidatePendingCache(accountId: string, groupId: string) {
  pendingMembersCache.delete(`${accountId}_${groupId}`);
}

/**
 * Ghim trong app theo tài khoản — lần đọc thành công gần nhất (module-level, sống qua lần đóng/mở panel). Lần đọc lỗi
 * (chế độ nhân viên: mất kết nối BOSS) dùng lại tập này thay vì coi hội thoại là "chưa ghim".
 */
const lastLocalPins = new Map<string, Set<string>>();

/**
 * Thành viên nhóm từ DB vào cache (chỉ khi cache chưa có ai — ví dụ lần tải lúc mở hội thoại bị lỗi vì mất kết nối).
 * Đọc lỗi → giữ nguyên cache (không thay bằng rỗng).
 */
async function loadGroupMembersFromDB(accountId: string, groupId: string): Promise<void> {
  const res: any = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
  if (isReadFailure(res)) {
    console.warn('[GroupInfoPanel] Không tải được thành viên nhóm:', readFailureMessage(res));
    return;
  }
  const rows: any[] = (res?.members ?? []).filter((m: any) => String(m?.member_id ?? '').trim());
  if (!rows.length) return;
  const app = useAppStore.getState();
  const current = app.groupInfoCache?.[accountId]?.[groupId];
  if (current?.members?.length) return; // đã có từ nguồn khác (ChatWindow / làm mới thủ công) trong lúc chờ
  const contact = useChatStore.getState().contacts[accountId]?.find(c => c.contact_id === groupId);
  const members: GroupMember[] = rows.map((m: any) => ({
    userId: String(m.member_id).trim(),
    displayName: m.display_name || '',
    avatar: m.avatar || '',
    role: m.role ?? 0,
  }));
  app.setGroupInfo(accountId, groupId, {
    ...current,
    groupId,
    name: current?.name || contact?.display_name || groupId,
    avatar: current?.avatar || contact?.avatar_url || '',
    memberCount: Math.max(Number(current?.memberCount || 0), members.length),
    members,
    creatorId: current?.creatorId || '',
    adminIds: current?.adminIds || [],
    fetchedAt: Date.now(),
  });
}

/** Trưởng / phó nhóm (Telegram: người tạo / quản trị viên) — role đọc theo kênh (shared/groupMemberRoles). */
const canManageGroup = (groupInfo: CachedGroupInfo | null, myId: string | null, channel?: string | null) =>
  myGroupRoleKind(groupInfo, myId, channel) !== 'member';

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
  const { activeThreadId, contacts } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, contacts: s.contacts,
  })));
  const { activeAccountId, getActiveAccount } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, getActiveAccount: s.getActiveAccount, accounts: s.accounts,
  })));
  const { showNotification, setGroupInfo, setMuted, clearMuted, isMuted: isMutedFn, toggleConversationInfo } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, setGroupInfo: s.setGroupInfo, setMuted: s.setMuted,
    clearMuted: s.clearMuted, isMuted: s.isMuted, toggleConversationInfo: s.toggleConversationInfo,
    mutedThreads: s.mutedThreads,
  })));

  const [panelView, setPanelView] = useState<PanelView>('info');
  const [mediaTab, setMediaTab] = useState<MediaTab>('image');
  const [groupInfo, setLocalGroupInfo] = useState<CachedGroupInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isLocalPinned, setIsLocalPinned] = useState(false);
  const [muteDropdownOpen, setMuteDropdownOpen] = useState(false);
  const [muteDropdownPos, setMuteDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [userProfilePopup, setUserProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const muteRef = useRef<HTMLDivElement>(null);

  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];
  const contact = contactList.find(c => c.contact_id === activeThreadId);
  const displayName = contact?.display_name || activeThreadId || '';
  const avatarUrl = contact?.avatar_url || '';

  // Channel capability
  const channelCap = getCapability((contact?.channel || CHANNEL.ZALO) as Channel);
  // Kênh Telegram (phát tin): "người theo dõi" thay cho "thành viên", "kênh" thay cho "nhóm"
  const isTelegramChannel = isTelegramCh(channelCap.id)
    && ((contact as any)?.telegram_peer_type === 'channel' || (groupInfo as any)?.peerType === 'channel');
  const chatNoun = isTelegramChannel ? 'kênh' : 'nhóm';
  const memberNoun = isTelegramChannel ? 'người theo dõi' : 'thành viên';

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc, activeAccountId);
  };


  // Load pin status on thread change - only for Zalo (server-side pin sync)
  useEffect(() => {
    if (!activeThreadId || !channelCap.supportsPinConversation || channelCap.id !== CHANNEL.ZALO) return;
    setIsPinned(false);
    const auth = getAuth();
    if (!auth) return;
    ipc.zalo?.getPinConversations(auth).then((res: any) => {
      const convIds: string[] = res?.response?.conversations || [];
      setIsPinned(convIds.some((id: string) => id.replace(/^[ug]/, '') === activeThreadId));
    }).catch(() => {});
  }, [activeThreadId, channelCap.supportsPinConversation]);

  // Load local pin status - cho FB và các kênh không hỗ trợ Zalo API pin.
  // Đọc lỗi (chế độ nhân viên: mất kết nối BOSS) ≠ "chưa ghim": giữ cờ đang hiện của đúng hội thoại này, không thì cờ
  // của lần đọc thành công gần nhất của tài khoản (lastLocalPins).
  const localPinOwnerRef = useRef('');
  const reloadLocalPin = useCallback(async () => {
    if (!activeAccountId || !activeThreadId) return;
    const accountId = activeAccountId;
    const threadId = activeThreadId;
    const owner = `${accountId}:${threadId}`;
    const res: any = await DataAccessor.getLocalPinnedConversations({ zaloId: accountId }).catch(() => null);
    const current = useAccountStore.getState().activeAccountId === accountId && useChatStore.getState().activeThreadId === threadId;
    if (!current) return; // đã đổi hội thoại trong lúc chờ
    if (!res || isReadFailure(res)) {
      if (res) console.warn('[GroupInfoPanel] Không tải được trạng thái ghim:', readFailureMessage(res));
      if (localPinOwnerRef.current === owner) return; // giữ cờ đang hiện của hội thoại này
      const known = lastLocalPins.get(accountId);
      localPinOwnerRef.current = known ? owner : '';
      setIsLocalPinned(known ? known.has(threadId) : false);
      return;
    }
    const pinned = new Set<string>((res?.threadIds || []).map((id: any) => String(id)));
    lastLocalPins.set(accountId, pinned);
    localPinOwnerRef.current = owner;
    setIsLocalPinned(pinned.has(threadId));
  }, [activeAccountId, activeThreadId]);

  useEffect(() => {
    void reloadLocalPin();
  }, [reloadLocalPin]);

  // Ghim trong app đổi ở nơi khác (Boss / nhân viên khác / ConversationList — relay db:pinnedConversationChanged →
  // 'local-pin-changed' có threadId + isPinned): cập nhật bộ nhớ tài khoản + cờ của hội thoại đang mở
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.zaloId || !detail.threadId || typeof detail.isPinned !== 'boolean') return;
      const accountId = String(detail.zaloId);
      const threadId = String(detail.threadId);
      const known = lastLocalPins.get(accountId);
      if (known) { if (detail.isPinned) known.add(threadId); else known.delete(threadId); }
      if (accountId === activeAccountId && threadId === activeThreadId) {
        localPinOwnerRef.current = `${accountId}:${threadId}`;
        setIsLocalPinned(detail.isPinned);
      }
    };
    window.addEventListener(LOCAL_PIN_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOCAL_PIN_CHANGED_EVENT, handler);
  }, [activeAccountId, activeThreadId]);

  // Chế độ nhân viên: kết nối BOSS phục hồi → tải lại cờ ghim; thành viên nhóm từ DB nếu cache còn trống (lần tải lúc
  // mở hội thoại bị lỗi). Không gọi API Zalo (fetchGroupInfo vẫn chỉ chạy khi bấm làm mới).
  useEmployeeResync(() => {
    const accountId = useAccountStore.getState().activeAccountId;
    const threadId = useChatStore.getState().activeThreadId;
    if (!accountId || !threadId) return;
    const tasks: Promise<unknown>[] = [reloadLocalPin()];
    if (!useAppStore.getState().groupInfoCache?.[accountId]?.[threadId]?.members?.length) {
      tasks.push(loadGroupMembersFromDB(accountId, threadId));
    }
    return Promise.allSettled(tasks);
  });


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
    if (!channelCap.supportsPinConversation || channelCap.id !== CHANNEL.ZALO) return;
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

  const handleToggleLocalPin = async () => {
    if (!activeAccountId || !activeThreadId) return;
    const newVal = !isLocalPinned;
    try {
      const pinRes: any = await DataAccessor.setLocalPinnedConversation({ zaloId: activeAccountId, threadId: activeThreadId, isPinned: newVal });
      // Nhân viên: Boss từ chối / mất kết nối trả success:false (không ném lỗi)
      if (pinRes?.success === false) throw new Error(pinRes.error || 'Không thể ghim hội thoại');
      setIsLocalPinned(newVal);
      localPinOwnerRef.current = `${activeAccountId}:${activeThreadId}`;
      const known = lastLocalPins.get(activeAccountId);
      if (known) { if (newVal) known.add(activeThreadId); else known.delete(activeThreadId); }
      showNotification(newVal ? 'Đã ghim trong app' : 'Đã bỏ ghim khỏi app', 'success');
    } catch (e: any) {
      showNotification('Lỗi: ' + (e.message || 'Không thể ghim hội thoại'), 'error');
    }
  };

  const handleMuteWithTime = (until: number) => {
    if (!activeAccountId || !activeThreadId) return;
    setMuted(activeAccountId, activeThreadId, until);
    showNotification('Đã tắt thông báo', 'success');
    setMuteDropdownOpen(false);
    if (isTelegramCh(channelCap.id)) {
      const muteUntil = until === 0 ? 2147483647 : Math.floor(until / 1000);
      ipc.telegramUser?.setDialogMute({ accountId: activeAccountId, chatId: activeThreadId, muteUntil })
        .then((res) => {
          if (!res?.success) showNotification(res?.error || 'Không thể đồng bộ tắt thông báo với Telegram', 'error');
        }).catch(() => showNotification('Không thể đồng bộ tắt thông báo với Telegram', 'error'));
      useChatStore.getState().updateContact(activeAccountId, {
        contact_id: activeThreadId, is_muted: until === 0 ? 1 : 0, mute_until: until === 0 ? 0 : until,
      } as any);
      return;
    }
    // Gọi API đồng bộ lên Zalo (fire-and-forget) - chỉ Zalo
    if (channelCap.supportsMuteSync && channelCap.id === CHANNEL.ZALO) {
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
    if (isTelegramCh(channelCap.id)) {
      ipc.telegramUser?.setDialogMute({ accountId: activeAccountId, chatId: activeThreadId, muteUntil: 0 })
        .then((res) => {
          if (!res?.success) showNotification(res?.error || 'Không thể đồng bộ bật thông báo với Telegram', 'error');
        }).catch(() => showNotification('Không thể đồng bộ bật thông báo với Telegram', 'error'));
      useChatStore.getState().updateContact(activeAccountId, {
        contact_id: activeThreadId, is_muted: 0, mute_until: 0,
      } as any);
      return;
    }
    showNotification('Đã bật thông báo', 'success');
    // Gọi API đồng bộ lên Zalo (fire-and-forget) - chỉ Zalo
    if (channelCap.supportsMuteSync && channelCap.id === CHANNEL.ZALO) {
      const auth = getAuth();
      if (auth) {
        ipc.zalo?.setMute({ auth, threadId: activeThreadId, threadType: 1, action: 3 }).catch(() => {});
      }
    }
  };

  // Load group info on mount / thread change
  // Chỉ đọc từ cache (DB đã được ChatWindow load sẵn khi click hội thoại)
  // KHÔNG tự gọi API - fetchGroupInfo chỉ chạy khi user bấm nút refresh thủ công
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

  useEffect(() => {
    const openMembers = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (String(detail.accountId) !== String(activeAccountId) || String(detail.chatId) !== String(activeThreadId)) return;
      // Danh sách đọc từ DB; panel tự gọi API nếu đây là lần đầu mở thành viên của nhóm
      setPanelView('members');
    };
    window.addEventListener('telegram:open-group-members', openMembers);
    return () => window.removeEventListener('telegram:open-group-members', openMembers);
  }, [activeAccountId, activeThreadId]);

  // Sync localGroupInfo từ cache khi ChatWindow populate xong
  // (GroupInfoPanel có thể đang hiển thị trong khi ChatWindow async load từ DB)
  const { groupInfoCache } = useAppStore(useShallow(s => ({
    groupInfoCache: s.groupInfoCache,
  })));
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

  /**
   * Gọi API lấy thông tin + thành viên nhóm (bấm làm mới, hoặc mở panel "Thành viên" lần đầu). Thành viên GỘP vào DB /
   * cache, không thay thế: API trả ít hơn danh sách đã quét / thu thập. `forceEnrich` (làm mới thủ công, Zalo): lấy lại
   * tên / ảnh của mọi thành viên. Trả true khi đã lấy được danh sách thành viên.
   */
  const fetchGroupInfo = async (options: { forceEnrich?: boolean } = {}): Promise<boolean> => {
    if (!activeThreadId || !activeAccountId) return false;
    const ch = channelCap.id;
    // Facebook: no group info API
    if (isFacebookCh(ch)) return false;

    // Telegram: use adapter to fetch group info
    if (isTelegramCh(ch)) {
      setLoading(true);
      let membersFetched = false;
      try {
        const adapter = getAdapter(ch);
        const res = await (adapter as any).getGroupInfo({ accountId: activeAccountId, threadId: activeThreadId });
        if (res?.success && res.info) {
          const entity = res.info.entity || res.info || {};
          const fullChat = res.info.full || res.info || {};
          const name = entity.title || entity.username || displayName;
          const memberCount = res.info.memberCount || fullChat.participantsCount || fullChat.memberCount || 0;
          const onlineCount = res.info.onlineCount || fullChat.onlineCount || 0;
          const telegramAvatarUrl = res.info.avatarUrl || avatarUrl || '';
          // Update contact
          useChatStore.getState().updateContact(activeAccountId, {
            contact_id: activeThreadId, display_name: name, avatar_url: telegramAvatarUrl, contact_type: 'group',
            telegram_peer_type: res.info.peerType || '', telegram_members_count: memberCount,
            telegram_online_count: onlineCount, telegram_can_send: res.info.canSend === false ? 0 : 1,
            telegram_send_reason: res.info.sendReason || '',
            telegram_membership_state: res.info.membershipState || 'member',
            telegram_join_action: res.info.joinAction || 'none',
          });
          DataAccessor.updateContactProfile({
            zaloId: activeAccountId, contactId: activeThreadId, displayName: name, avatarUrl: telegramAvatarUrl, contactType: 'group',
          }).catch(() => {});

          // Thành viên: Telegram chỉ trả ~200 người gần đây (main đã lưu vào DB) → GỘP với người đã thu thập từ lịch sử
          // tin, không thay (thay thì người từng nhắn tin quay về hiện id)
          const membersRes = await (adapter as any).getGroupMembers({ accountId: activeAccountId, threadId: activeThreadId });
          if (membersRes?.success && membersRes.members) {
            const fresh: GroupMember[] = membersRes.members.map((m: any) => ({
              userId: String(m.id || ''),
              displayName: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.username || '',
              avatar: m.avatar || '',
              role: Number(m.role || 0),
              ...(m.username ? { username: m.username } : {}),
              status: m.status || '', statusText: m.statusText || '',
              lastSeenAt: m.lastSeenAt, onlineUntil: m.onlineUntil,
            }));
            const current = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
            const members = mergeGroupMembers(current?.members, fresh);
            useAppStore.getState().setGroupInfo(activeAccountId, activeThreadId, {
              ...current,
              name, avatar: telegramAvatarUrl, members, fetchedAt: Date.now(),
              groupId: activeThreadId, memberCount: memberCount || Math.max(Number(current?.memberCount || 0), members.length),
              onlineCount, peerType: res.info.peerType,
              canSend: res.info.canSend, sendReason: res.info.sendReason,
              membershipState: res.info.membershipState, joinAction: res.info.joinAction,
              canManageTopics: res.info.canManageTopics,
            });
            markGroupMembersApiSynced(activeAccountId, activeThreadId);
            membersFetched = true;
          }
        }
      } catch {}
      setLoading(false);
      return membersFetched;
    }

    // Zalo: existing logic below
    // Guard: verify thread still belongs to current account at fetch time
    const currentContacts = useChatStore.getState().contacts[activeAccountId] || [];
    if (currentContacts.length > 0 && !currentContacts.some(c => c.contact_id === activeThreadId)) return false;
    const auth = getAuth();
    if (!auth) return false;

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
        return false;
      }

      const gridMap = res?.response?.gridInfoMap || res?.response?.changed_groups || {};
      const gData: any = gridMap[threadId] || (Object.values(gridMap)[0] as any);
      if (!gData) {
        showNotification('Không lấy được thông tin nhóm, vui lòng thử lại', 'error');
        return false;
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

      // Merge ALL sources of member IDs instead of picking one
      const idsFromMemberIds: string[] = (gData.memberIds || []).map(id => String(id).replace(/_0$/, '').trim()).filter(id => /^\d+$/.test(id));
      const idsFromCurrentMems: string[] = Array.from(currentMemMap.keys()).filter(id => /^\d+$/.test(id));
      const idsFromMemVer: string[] = memVerIds.map(id => id.replace(/_0$/, '').trim()).filter(id => /^\d+$/.test(id));

      console.log('[GroupInfoPanel] Group sources - memberIds:', idsFromMemberIds.length,
        'currentMems:', idsFromCurrentMems.length,
        'memVerList:', idsFromMemVer.length,
        'hasMoreMember:', gData.hasMoreMember,
        'totalMember:', gData.totalMember,
        'lockViewMember:', gData.setting?.lockViewMember);

      const allRawIds = [...new Set([...idsFromMemberIds, ...idsFromCurrentMems, ...idsFromMemVer])];
      const memberIds: string[] = allRawIds;
      console.log('[GroupInfoPanel] memberIds union:', memberIds.length, 'first5:', memberIds.slice(0, 5));

      // Tên / ảnh đã có trong DB (quét thành viên ẩn, lần đồng bộ trước): placeholder lưu đè cả hàng (INSERT OR REPLACE)
      // nên phải mang theo — trước đây lưu tên rỗng → danh sách mất tên tới khi lấy lại xong từng người
      const existingRes = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId: threadId });
      const existingFailed = isReadFailure(existingRes);
      const existingById = new Map<string, any>(
        existingFailed ? [] : (existingRes?.members ?? []).map((m: any) => [String(m.member_id).trim(), m]),
      );

      // Vai trò Zalo: 2 = trưởng nhóm, 1 = phó nhóm (shared/groupMemberRoles)
      const roleOf = (memberId: string) => (memberId === creatorId ? 2 : adminSet.has(memberId) ? 1 : 0);
      const contactMap = new Map((useChatStore.getState().contacts[accountId] || []).map(c => [c.contact_id, c]));
      const placeholders: MemberPlaceholder[] = memberIds.map(memberId => {
        const previous = existingById.get(memberId);
        const cm = currentMemMap.get(memberId);
        const c = contactMap.get(memberId);
        return {
          memberId,
          displayName: previous?.display_name || cm?.dName || cm?.zaloName || c?.display_name || '',
          avatar: previous?.avatar || cm?.avatar || c?.avatar_url || '',
          role: roleOf(memberId),
        };
      });

      // Cache: GỘP với danh sách đang có (DB có thể nhiều hơn API — nhóm khoá xem thành viên, quét thành viên ẩn)
      const currentCache = useAppStore.getState().groupInfoCache?.[accountId]?.[threadId];
      const cacheMembers = mergeGroupMembers(currentCache?.members, placeholders.map(p => ({
        userId: p.memberId, displayName: p.displayName, avatar: p.avatar, role: p.role,
      })));
      const initialInfo: CachedGroupInfo = {
        ...currentCache,
        groupId: threadId, name, avatar,
        memberCount: gData.totalMember || Math.max(Number(currentCache?.memberCount || 0), memberIds.length),
        members: cacheMembers,
        creatorId, adminIds,
        settings: gData.setting,
        fetchedAt: Date.now(),
      };
      setLocalGroupInfo(initialInfo);
      setGroupInfo(accountId, threadId, initialInfo);

      if (memberIds.length === 0) return false;
      // Không đọc được danh sách hiện có (nhân viên mất kết nối Boss): không lưu — lưu lúc này xoá trắng tên đã có
      if (existingFailed) {
        console.warn('[GroupInfoPanel] skip member save — cannot read existing members:', readFailureMessage(existingRes));
        showNotification('Chưa lưu thành viên nhóm: không đọc được danh sách hiện có. Thử lại sau.', 'warning');
        return false;
      }

      // Helper: reload enriched members from DB into cache
      const reloadFromDB = async () => {
        const dbRes = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId: threadId });
        // Đọc lỗi (chế độ nhân viên) → giữ danh sách thành viên đang có (initialInfo / cache), không thay bằng rỗng
        if (isReadFailure(dbRes)) {
          console.warn('[GroupInfoPanel] Không tải được thành viên nhóm từ DB:', readFailureMessage(dbRes));
          return;
        }
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
          // DB đủ người; giữ trạng thái sống (online…) của cache cho người trùng
          members: mergeGroupMembers(existing?.members, membersForCache),
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
        // Làm mới thủ công: lấy lại tên / ảnh của mọi người; mở panel lần đầu: chỉ người chưa có tên
        forceEnrich: !!options.forceEnrich,
        // Phase 1: placeholders (kèm tên đã có) saved to DB - keep initialInfo in cache
        onPhase1Done: async () => { /* intentionally no cache update here */ },
        // Phase 2 complete: enriched data in DB → refresh cache
        onGroupEnriched: reloadFromDB,
      });
      markGroupMembersApiSynced(accountId, threadId);
      return true;
    } catch (e: any) {
      console.error('[GroupInfoPanel] fetchGroupInfo error:', e?.message);
      showNotification('Không thể tải thông tin nhóm', 'error');
      return false;
    } finally {
      setLoading(false);
    }
  };

  // Telegram group/channel/forum details need an explicit profile-photo fetch
  // when the dialog sync did not cache one yet.
  const telegramInfoRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || !isTelegramCh(channelCap.id)) return;
    const key = `${activeAccountId}_${activeThreadId}`;
    if (telegramInfoRequestedRef.current.has(key)) return;
    if (groupInfo?.avatar && groupInfo?.members?.length) return;
    telegramInfoRequestedRef.current.add(key);
    fetchGroupInfo();
  }, [activeAccountId, activeThreadId, channelCap.id]);

  // Load pending count for admins whenever groupInfo is refreshed
  useEffect(() => {
    if (!groupInfo || !activeThreadId || !activeAccountId) return;
    if (!canManageGroup(groupInfo, activeAccountId, channelCap.id)) return;
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
          onRefresh={() => fetchGroupInfo({ forceEnrich: true })}
          onApiSync={() => fetchGroupInfo()}
          myAccountId={activeAccountId || ''}
          channelCap={channelCap}
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
        channel={contact?.channel || CHANNEL.ZALO}
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

  if (panelView === 'topics' && activeAccountId && activeThreadId) {
    return (
      <ForumTopicsPanel
        accountId={activeAccountId}
        chatId={activeThreadId}
        chatName={groupInfo?.name || displayName}
        onSelectTopic={(topicId, topicTitle, forumTopicId) => {
          useChatStore.getState().setMessages(activeAccountId, activeThreadId, []);
          useChatStore.setState({ activeTopicId: topicId, activeForumTopicId: forumTopicId || null, activeTopicTitle: topicTitle, messagesLoading: true });
          setPanelView('info');
        }}
        onBack={() => setPanelView('info')}
      />
    );
  }



  // ─── Main info view ───────────────────────────────────────────────────────
  return (
    <div className="w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-y-auto">
      {/* Header - with close + refresh buttons */}
      <div className="flex items-center px-3 py-3 border-b border-border">
        <button
          title="Đóng"
          onClick={toggleConversationInfo}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <span className="flex-1 text-sm font-semibold text-foreground text-center">Thông tin {chatNoun}</span>
        <button
          title="Cập nhật thông tin nhóm"
          onClick={() => { void fetchGroupInfo({ forceEnrich: true }); }}
          disabled={loading}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 flex-shrink-0"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      {/* Group avatar + name */}
      <div className="flex flex-col items-center py-5 px-4 border-b border-border">
        <div className={`relative ${channelCap.supportsChangeGroupAvatar ? 'group cursor-pointer' : ''}`}
          onClick={channelCap.supportsChangeGroupAvatar ? handleChangeAvatar : undefined}
          title={channelCap.supportsChangeGroupAvatar ? 'Đổi ảnh nhóm' : undefined}>
          <GroupAvatar avatarUrl={groupInfo?.avatar || avatarUrl} groupInfo={groupInfo} name={displayName} id={activeThreadId || undefined} size="lg" />
          {channelCap.supportsChangeGroupAvatar && (
          <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
          </div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <p className="text-foreground font-semibold text-base text-center">{groupInfo?.name || displayName}</p>
          {channelCap.supportsGroupRename && (
          <button onClick={() => startRenameGroup()} title="Đổi tên nhóm"
            className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          )}
        </div>
        {groupInfo && groupInfo.memberCount > 0 && (
          <p className="mt-1 text-muted-foreground text-xs">{groupInfo.memberCount} {memberNoun}</p>
        )}
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-4 gap-1 px-3 py-3 border-b border-border">
        {/* Mute with dropdown */}
        <div className="relative" ref={muteRef}>
          <GrpActionBtn
            icon={isMuted ? <BellIcon className="w-4 h-4" /> : <BellOffIcon className="w-4 h-4" />}
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
            <div className="fixed z-50 bg-card border border-border rounded-xl shadow-2xl min-w-[210px] py-1"
              style={{ top: muteDropdownPos.top, left: muteDropdownPos.left }}>
              {MUTE_OPTIONS.map(opt => (
                <button key={opt.label} onClick={() => handleMuteWithTime(opt.until())}
                  className="w-full flex items-center px-4 py-2.5 text-sm text-foreground/80 hover:bg-muted hover:text-foreground text-left transition-colors">
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {channelCap.supportsPinConversation && channelCap.id === CHANNEL.ZALO && (
          <GrpActionBtn icon={<PinIcon className="w-4 h-4" />} label={isPinned ? 'Bỏ ghim' : 'Ghim hội thoại'} onClick={handleTogglePin} active={isPinned} />
        )}
        {(!channelCap.supportsPinConversation || channelCap.id !== CHANNEL.ZALO) && (
          <GrpActionBtn icon={<MapPinIcon className="w-4 h-4" />} label={isLocalPinned ? 'Bỏ ghim app' : 'Ghim trong app'} onClick={handleToggleLocalPin} active={isLocalPinned} />
        )}
        {channelCap.supportsInviteToGroup && (
          <GrpActionBtn icon={<UsersIcon className="w-4 h-4" />} label={isTelegramChannel ? 'Mời người theo dõi' : 'Thêm thành viên'} onClick={() => setAddMemberOpen(true)} />
        )}
        {channelCap.supportsGroupManage && (
          <GrpActionBtn icon={<SettingsIcon className="w-4 h-4" />} label={`Quản lý ${chatNoun}`} onClick={() => setPanelView('manage')} />
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-4">
          <Spinner size={5} />
        </div>
      )}

      {/* Member list section - chỉ hiển thị số lượng, click để xem chi tiết */}
      {groupInfo && (
        <button
          onClick={() => setPanelView('members')}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-border hover:bg-muted/40 transition-colors group"
        >
          <div className="flex items-center gap-2 text-sm text-foreground">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
            </svg>
            <span>{groupInfo.memberCount || groupInfo.members?.length || 0} {memberNoun}</span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground group-hover:text-foreground/80 transition-colors">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      )}

      {/* Chờ duyệt vào nhóm - chỉ hiển thị với admin/owner và kênh Zalo */}
      {channelCap.supportsPendingApproval && groupInfo && canManageGroup(groupInfo, activeAccountId, channelCap.id) && (
        <button
          onClick={() => setPanelView('pending')}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-border hover:bg-muted/40 transition-colors group"
        >
          <div className="flex items-center gap-2 text-sm text-foreground">
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground group-hover:text-foreground/80 transition-colors">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      )}

      {/* Telegram forum topics */}
      {isTelegramCh(channelCap.id) && Number((contact as any)?.is_forum) === 1 && (
      <button
          onClick={() => setPanelView('topics')}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-border hover:bg-muted/40 transition-colors group"
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-sky-400">
            <path d="M21 15a4 4 0 01-4 4H8l-5 3V7a4 4 0 014-4h10a4 4 0 014 4z"/>
          </svg>
          <span>Chủ đề</span>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground group-hover:text-foreground/80 transition-colors">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
      )}

      {/* Bảng tin nhóm is a Zalo feature; Telegram uses forum topics above. */}
      {channelCap.supportsGroupBoard && isZaloCh(channelCap.id) && (
      <button
          onClick={() => useAppStore.getState().setShowGroupBoard(true)}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-border hover:bg-muted/40 transition-colors group"
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <span>Bảng tin nhóm</span>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground group-hover:text-foreground/80 transition-colors">
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
        isOwner={myGroupRoleKind(groupInfo, activeAccountId, channelCap.id) === 'owner'}
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
          channel={channelCap.id}
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

      {/* Rename dialog */}
      {showRenameDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
          onClick={() => setShowRenameDialog(false)}>
          <div className="bg-card border border-input rounded-2xl p-5 w-80 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-foreground mb-3">Đổi tên nhóm</p>
            <input
              ref={renameInputRef}
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRenameConfirm(); if (e.key === 'Escape') setShowRenameDialog(false); }}
              className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 mb-4"
              placeholder="Nhập tên nhóm mới..."
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRenameDialog(false)}
                className="px-4 py-1.5 text-xs text-foreground/80 hover:text-foreground bg-muted hover:bg-accent rounded-lg transition-colors">
                Hủy
              </button>
              <button onClick={handleRenameConfirm}
                className="px-4 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
                Lưu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  async function handleChangeAvatar() {
    if (channelCap.id === CHANNEL.FACEBOOK) return; // FB uses different mechanism
    if (!activeThreadId || !activeAccountId) return;
    // Electron mới bỏ File.path (input file trả đường dẫn rỗng) → chọn ảnh bằng hộp chọn file của máy
    const picked: any = await ipc.file?.openDialog({ filters: [{ name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    const filePath = picked?.filePaths?.[0] || '';
    if (!filePath) return;
    const telegramGroup = isTelegramCh(channelCap.id);
    const auth = telegramGroup ? null : getAuth();
    if (!telegramGroup && !auth) return;
    try {
      const res = telegramGroup
        ? await (getAdapter(channelCap.id) as any).setGroupAvatar({ accountId: activeAccountId, threadId: activeThreadId, photoPath: filePath })
        : await ipc.zalo?.changeGroupAvatar({ auth, avatarPath: filePath, groupId: activeThreadId });
      if (res?.success) { showNotification(`Đã đổi ảnh ${chatNoun}`, 'success'); fetchGroupInfo(); }
      else showNotification(extractApiError(res, `Đổi ảnh ${chatNoun} thất bại`), 'error');
    } catch (e: any) { showNotification(extractApiError(e, `Đổi ảnh ${chatNoun} thất bại`), 'error'); }
  }

  function startRenameGroup() {
    if (!channelCap.supportsGroupRename) return;
    setRenameValue(groupInfo?.name || displayName);
    setShowRenameDialog(true);
  }

  async function handleRenameConfirm() {
    const newName = renameValue.trim();
    if (!newName || !activeThreadId) return;
    setShowRenameDialog(false);
    channelIpc.changeGroupName(channelCap.id, { accountId: activeAccountId!, threadId: activeThreadId, name: newName })
      .then((res: any) => {
        if (res?.success) {
          showNotification('Đã đổi tên nhóm', 'success');
          setLocalGroupInfo(prev => prev ? { ...prev, name: newName } : prev);
          if (activeAccountId) {
            useChatStore.getState().updateContact(activeAccountId, { contact_id: activeThreadId, display_name: newName });
          }
        } else showNotification(extractApiError(res, 'Đổi tên nhóm thất bại'), 'error');
      }).catch((e: any) => showNotification(extractApiError(e, 'Đổi tên nhóm thất bại'), 'error'));
  }

}



// ─── GrpActionBtn ─────────────────────────────────────────────────────────────
function GrpActionBtn({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick}
      className={`flex flex-col items-center gap-1 py-2 px-1 rounded-xl hover:bg-muted transition-colors text-center`}>
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${active ? 'bg-blue-500' : 'bg-accent'}`}>{icon}</div>
      <span className={`text-[9px] leading-tight ${active ? 'text-blue-500' : 'text-subtle-foreground'}`}>{label}</span>
    </button>
  );
}


// ─── MembersPanel ─────────────────────────────────────────────────────────────
/** Mở panel lần đầu → API đang chạy cho nhóm này (StrictMode / mở lại nhanh không gọi trùng). */
const membersApiSyncInFlight = new Set<string>();

/**
 * Thành viên nhóm — đọc từ DB theo trang, ĐỦ người như CRM Nhóm (quét thành viên ẩn, thu thập từ lịch sử tin Telegram,
 * các lần đồng bộ trước); tìm trong DB, không phân biệt dấu. API chỉ gọi khi mở panel lần đầu cho nhóm (gộp vào DB,
 * không bớt ai) hoặc khi bấm làm mới. Thao tác quản trị cập nhật DB / cache tại chỗ thay vì tải lại cả nhóm qua API.
 */
function MembersPanel({ groupInfo, groupId, onBack, onRefresh, onApiSync, myAccountId, channelCap, onShowProfile }: {
  groupInfo: CachedGroupInfo | null;
  groupId: string;
  onBack: () => void;
  /** Làm mới thủ công (API, lấy lại tên mọi người). */
  onRefresh: () => Promise<boolean>;
  /** Đồng bộ API lần đầu mở panel (chỉ lấy tên người còn thiếu). */
  onApiSync: () => Promise<boolean>;
  myAccountId: string;
  channelCap?: ChannelCapability;
  onShowProfile?: (userId: string, x: number, y: number) => void;
}) {
  const channel = channelCap?.id || CHANNEL.ZALO;
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  // ── Hidden-member scan is a Zalo-only capability ──────────────────────
  const { syncMembers } = useGroupMemberSync({
    accountId: myAccountId,
    groupId,
    onMembersSynced: () => { void reloadRef.current(); },
  });
  const { getActiveAccount } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, accounts: s.accounts, activeAccountId: s.activeAccountId,
  })));
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));
  const userPresence = useChatStore(state => state.userPresence);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<GroupMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [apiSyncing, setApiSyncing] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [ctxMember, setCtxMember] = useState<GroupMember | null>(null);
  const [ctxPos, setCtxPos] = useState<{ top: number; left: number } | null>(null);
  const [reloading, setReloading] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<GroupMember[]>([]);
  rowsRef.current = rows;
  const seqRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const isAdmin = canManageGroup(groupInfo, myAccountId, channel);
  const ownerRole = groupOwnerRole(channel);

  // Gõ tìm: đợi ngừng gõ 250 ms rồi mới hỏi DB
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchPage = useCallback((offset: number, limit: number) => DataAccessor.getGroupMembersPage({
    zaloId: myAccountId, groupId, query, limit, offset, ownerRole,
  }).catch((err: any) => ({ success: false as const, error: err?.message || String(err), members: [] as any[], total: 0 })), [myAccountId, groupId, query, ownerRole]);

  /** Đọc lại từ đầu — giữ số người đang hiện (tối đa 500) để danh sách không co lại / nhảy vị trí cuộn. */
  const reloadList = useCallback(async () => {
    if (!myAccountId || !groupId) return;
    const seq = ++seqRef.current;
    const limit = Math.min(Math.max(rowsRef.current.length, GROUP_MEMBERS_PAGE_SIZE), 500);
    setListLoading(true);
    const res: any = await fetchPage(0, limit);
    if (seq !== seqRef.current) return;
    setListLoading(false);
    // Đọc lỗi (nhân viên mất kết nối Boss): giữ danh sách đang hiện, báo lỗi
    if (isReadFailure(res)) { setListError(readFailureMessage(res)); return; }
    setListError('');
    setRows((res.members || []).map(memberFromRow).filter((member: GroupMember) => member.userId));
    setTotal(Number(res.total) || 0);
  }, [fetchPage, myAccountId, groupId]);
  reloadRef.current = reloadList;

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || total === null || rowsRef.current.length >= total) return;
    loadingMoreRef.current = true;
    const seq = seqRef.current; // lần đọc lại từ đầu đang chạy / chạy sau sẽ thay kết quả này
    setListLoading(true);
    const res: any = await fetchPage(rowsRef.current.length, GROUP_MEMBERS_PAGE_SIZE);
    loadingMoreRef.current = false;
    if (seq !== seqRef.current) return;
    setListLoading(false);
    if (isReadFailure(res)) { setListError(readFailureMessage(res)); return; }
    setListError('');
    setRows(previous => appendMemberPage(previous, (res.members || []).map(memberFromRow)));
    setTotal(Number(res.total) || 0);
  }, [fetchPage, total]);

  // Đổi nhóm / từ khoá → trang đầu (danh sách cũ còn hiện tới khi có kết quả mới, đổi nhóm thì xoá ngay)
  const groupKey = `${myAccountId}:${groupId}`;
  const shownGroupRef = useRef(groupKey);
  useEffect(() => {
    if (shownGroupRef.current !== groupKey) {
      shownGroupRef.current = groupKey;
      setRows([]);
      setTotal(null);
    }
    rowsRef.current = [];
    scrollRef.current?.scrollTo({ top: 0 });
    void reloadList();
  }, [reloadList, groupKey]);

  // Mở thành viên của nhóm LẦN ĐẦU → gọi API một lần (đánh dấu khi thành công); về sau chỉ đọc DB
  useEffect(() => {
    const apiCapable = isZaloCh(channel) || channel === 'telegram_user';
    if (!myAccountId || !groupId || !apiCapable) return;
    if (groupMembersApiSyncedAt(myAccountId, groupId)) return;
    const key = `${myAccountId}:${groupId}`;
    if (membersApiSyncInFlight.has(key)) return;
    membersApiSyncInFlight.add(key);
    setApiSyncing(true);
    let mounted = true;
    onApiSync()
      .catch(() => false)
      .finally(() => {
        membersApiSyncInFlight.delete(key);
        if (!mounted) return;
        setApiSyncing(false);
        void reloadRef.current();
      });
    return () => { mounted = false; };
    // Chỉ theo nhóm: onApiSync là hàm mới mỗi lần render
  }, [myAccountId, groupId, channel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cache nhóm đổi (đồng bộ xong, ảnh Telegram vừa tải, có người vào / rời…) → đọc lại DB
  const fetchedAt = groupInfo?.fetchedAt || 0;
  const seenFetchedAtRef = useRef(fetchedAt);
  useEffect(() => {
    if (!fetchedAt || fetchedAt === seenFetchedAtRef.current) return;
    seenFetchedAtRef.current = fetchedAt;
    const timer = setTimeout(() => { void reloadRef.current(); }, 400);
    return () => clearTimeout(timer);
  }, [fetchedAt]);

  // Cuộn gần cuối → trang sau; trang vừa tải chưa lấp đầy khung → tải tiếp
  const onListScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 320) void loadMore();
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || total === null || rows.length >= total) return;
    if (el.scrollHeight - el.clientHeight < 320) void loadMore();
  }, [rows.length, total, loadMore]);

  const handleReload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      if (isZaloCh(channel)) await syncMembers();
      await onRefresh();
      await reloadList();
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    if (!ctxMember) return;
    const h = (e: MouseEvent) => { if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMember(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ctxMember]);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc, myAccountId);
  };

  const visibleRows = React.useMemo(() => withLiveMemberInfo(rows, groupInfo?.members), [rows, groupInfo?.members]);
  const getStatusText = (member: GroupMember) => {
    const live = userPresence[`${myAccountId}_${member.userId}`];
    if (live?.status === 'online') return 'Đang online';
    if (live?.lastSeen) return formatTelegramMemberStatus({ ...member, lastSeenAt: live.lastSeen, statusText: 'Đã offline' });
    return formatTelegramMemberStatus(member);
  };

  /** Thao tác quản trị thành công → sửa DB + cache tại chỗ (danh sách đọc từ DB), không gọi lại API cả nhóm. */
  const applyMemberChange = async (member: GroupMember, change: { removed: true } | { role: number }) => {
    if ('removed' in change) {
      await DataAccessor.removeGroupMember({ zaloId: myAccountId, groupId, memberId: member.userId }).catch(() => {});
    } else {
      await DataAccessor.upsertGroupMember({
        zaloId: myAccountId, groupId,
        member: { memberId: member.userId, displayName: member.displayName || '', avatar: member.avatar || '', role: change.role, username: member.username || '' },
      }).catch(() => {});
    }
    const app = useAppStore.getState();
    const cache = app.groupInfoCache?.[myAccountId]?.[groupId];
    if (cache) {
      const members = 'removed' in change
        ? cache.members.filter(item => item.userId !== member.userId)
        : cache.members.map(item => (item.userId === member.userId ? { ...item, role: change.role } : item));
      const adminRole = groupAdminRole(channel);
      const adminIds = 'removed' in change
        ? (cache.adminIds || []).filter(id => id !== member.userId)
        : change.role === adminRole
          ? Array.from(new Set([...(cache.adminIds || []), member.userId]))
          : (cache.adminIds || []).filter(id => id !== member.userId);
      app.setGroupInfo(myAccountId, groupId, {
        ...cache,
        members,
        adminIds,
        memberCount: 'removed' in change ? Math.max(0, Number(cache.memberCount || members.length + 1) - 1) : cache.memberCount,
        fetchedAt: Date.now(),
      });
    } else {
      void reloadList();
    }
  };

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
      if (isNonZalo(channel)) {
        const adapter = getAdapter(channel);
        const res = await (adapter as any).removeMember({ accountId: myAccountId, threadId: groupId, userId: member.userId });
        if (res?.success) { showNotification('Đã xóa thành viên', 'success'); await applyMemberChange(member, { removed: true }); }
        else showNotification(res?.error || 'Xóa thành viên thất bại', 'error');
      } else {
        const res = await ipc.zalo?.removeUserFromGroup({ auth, userId: member.userId, groupId });
        if (res?.success) { showNotification('Đã xóa thành viên', 'success'); await applyMemberChange(member, { removed: true }); }
        else showNotification(extractApiError(res, 'Xóa thành viên thất bại'), 'error');
      }
    } catch (e: any) { showNotification(extractApiError(e, 'Xóa thành viên thất bại'), 'error'); }
    setCtxMember(null);
  };

  const handleMakeDeputy = async (member: GroupMember) => {
    const auth = getAuth();
    if (!auth) return;
    const isDeputy = groupRoleKind(member.role, channel) === 'admin';
    const nextRole = isDeputy ? 0 : groupAdminRole(channel);
    try {
      if (isNonZalo(channel)) {
        const adapter = getAdapter(channel);
        const res = await (adapter as any).promoteMember({ accountId: myAccountId, threadId: groupId, userId: member.userId, isAdmin: !isDeputy });
        if (res?.success) { showNotification(isDeputy ? 'Đã xóa quyền admin' : 'Đã cấp quyền admin', 'success'); await applyMemberChange(member, { role: nextRole }); }
        else showNotification(res?.error || 'Thao tác thất bại', 'error');
        setCtxMember(null);
        return;
      }
      const res = isDeputy
        ? await ipc.zalo?.removeGroupDeputy({ auth, userId: member.userId, groupId })
        : await ipc.zalo?.addGroupDeputy({ auth, userId: member.userId, groupId });
      if (res?.success) { showNotification(isDeputy ? 'Đã xóa phó nhóm' : 'Đã thêm phó nhóm', 'success'); await applyMemberChange(member, { role: nextRole }); }
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
      if (isNonZalo(channel)) {
        const adapter = getAdapter(channel);
        const res = await (adapter as any).removeMember({ accountId: myAccountId, threadId: groupId, userId: member.userId });
        if (res?.success) { showNotification('Đã chặn thành viên', 'success'); await applyMemberChange(member, { removed: true }); }
        else showNotification(res?.error || 'Chặn thành viên thất bại', 'error');
        setCtxMember(null);
        return;
      }
      const res = await ipc.zalo?.addGroupBlockedMember({ auth, userId: member.userId, groupId });
      if (res?.success) { showNotification('Đã chặn thành viên', 'success'); await applyMemberChange(member, { removed: true }); }
      else showNotification(extractApiError(res, 'Chặn thành viên thất bại'), 'error');
    } catch (e: any) { showNotification(extractApiError(e, 'Chặn thành viên thất bại'), 'error'); }
    setCtxMember(null);
  };

  const officialCount = Number(groupInfo?.memberCount || 0);
  const shownTotal = total ?? 0;
  const countLabel = query
    ? `Kết quả tìm kiếm (${shownTotal})`
    : `Danh sách thành viên (${officialCount > shownTotal ? `${shownTotal} / ${officialCount}` : shownTotal})`;
  const hasMore = total !== null && rows.length < total;

  return (
    <div className="w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-3 py-3 border-b border-border">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="text-sm font-semibold text-foreground flex-1 text-center">Thành viên</span>
        {/* Add member */}
        {(channelCap?.supportsInviteToGroup ?? true) && (
          <button
            title="Thêm thành viên"
            onClick={() => setAddMemberOpen(true)}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
          </button>
        )}

        {/* Reload member info (API) */}
        <button
          title="Tải lại thành viên từ Zalo / Telegram"
          onClick={handleReload}
          disabled={reloading || apiSyncing}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 flex-shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={reloading || apiSyncing ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      <div className="px-3 pb-2 pt-2">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Tìm thành viên..."
          className="w-full bg-muted border border-input rounded-full px-3 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
      </div>

      <div className="px-4 pb-1 flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-medium flex-1 min-w-0 truncate">{countLabel}</span>
        {(listLoading || apiSyncing) && <Spinner size={3} />}
      </div>
      {apiSyncing && (
        <p className="px-4 pb-1 text-[11px] text-subtle-foreground">Đang đồng bộ thành viên lần đầu…</p>
      )}
      {listError && (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <span className="flex-1 min-w-0">{listError}</span>
          <button onClick={() => { void reloadList(); }} className="shrink-0 font-medium underline-offset-2 hover:underline">Thử lại</button>
        </div>
      )}

      <div ref={scrollRef} onScroll={onListScroll} className="flex-1 overflow-y-auto">
        {visibleRows.map(m => {
          const kind = groupRoleKind(m.role, channel);
          const statusText = getStatusText(m);
          const avatarSrc = m.avatar ? toLocalMediaUrl(m.avatar) : '';
          return (
            <div key={m.userId} className="flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors group">
              {/* Avatar - clickable */}
              <button
                onClick={(e) => onShowProfile?.(m.userId, e.clientX, e.clientY)}
                className="flex-shrink-0 focus:outline-none hover:opacity-80 transition-opacity"
              >
                {avatarSrc ? (
                  <img src={avatarSrc} alt="" loading="lazy" className="w-9 h-9 rounded-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <PeerInitials id={m.userId} name={m.displayName} className="w-9 h-9 text-xs" />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{m.displayName || m.userId}</p>
                {statusText && (
                  <p className={`text-[11px] truncate ${statusText === 'Đang online' ? 'text-green-400' : 'text-subtle-foreground'}`}>
                    {statusText}
                  </p>
                )}
                {kind !== 'member' && (
                  <div className="flex items-center gap-1">
                    {kind === 'owner' && <span className="text-[11px] bg-yellow-600/30 text-yellow-400 px-1.5 rounded">{groupRoleLabel(kind)}</span>}
                    {kind === 'admin' && <span className="text-[11px] bg-blue-600/30 text-blue-400 px-1.5 rounded">{groupRoleLabel(kind)}</span>}
                  </div>
                )}
              </div>
              {/* Context menu - admin only, not for group owner */}
              {isAdmin && (channelCap?.supportsGroupAdmin ?? true) && kind !== 'owner' && m.userId !== myAccountId && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setCtxPos({ top: rect.top, left: rect.left - 196 });
                    setCtxMember(m);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
                  </svg>
                </button>
              )}
            </div>
          );
        })}
        {hasMore && (
          <div className="flex justify-center py-3">
            {listLoading
              ? <Spinner size={4} />
              : <button onClick={() => { void loadMore(); }} className="text-xs text-blue-500 hover:underline">Tải thêm thành viên</button>}
          </div>
        )}
        {total === 0 && !listLoading && !apiSyncing && (
          <p className="text-xs text-muted-foreground text-center py-8">{query ? 'Không tìm thấy thành viên' : 'Không có thành viên'}</p>
        )}
        {total === null && !listError && (
          <div className="flex justify-center py-8"><Spinner size={5} /></div>
        )}
      </div>

      {/* Context menu for admin actions */}
      {ctxMember && (
        <div ref={ctxRef}
          className="fixed z-50 bg-card border border-border rounded-xl shadow-2xl py-1 min-w-[180px]"
          style={{ top: ctxPos?.top ?? 200, left: Math.max(4, ctxPos?.left ?? 200) }}>
          <div className="px-3 py-2 border-b border-border">
            <p className="text-sm text-foreground font-medium">{ctxMember.displayName || ctxMember.userId}</p>
          </div>
          <button onClick={() => { onShowProfile?.(ctxMember.userId, (ctxPos?.left ?? 0) + 200, ctxPos?.top ?? 0); setCtxMember(null); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground/80 hover:bg-muted hover:text-foreground text-left"><UserIcon className="w-4 h-4 inline" /> Xem thông tin
          </button>
          <button onClick={() => handleMakeDeputy(ctxMember)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground/80 hover:bg-muted hover:text-foreground text-left">
            {groupRoleKind(ctxMember.role, channel) === 'admin' ? <><ArrowDownIcon className="w-4 h-4 inline" /> Xóa phó nhóm</> : <><ArrowUpIcon className="w-4 h-4 inline" /> Đặt làm phó nhóm</>}
          </button>
          <button onClick={() => handleBlockMember(ctxMember)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-orange-400 hover:bg-muted text-left"><CloseIcon className="w-4 h-4 inline" /> Chặn khỏi nhóm
          </button>
          <button onClick={() => handleRemoveMember(ctxMember)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-900/30 text-left"><TrashIcon className="w-4 h-4 inline" /> Xóa khỏi nhóm
          </button>
          <button onClick={() => setCtxMember(null)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-muted text-left">
            ✕ Đóng
          </button>
        </div>
      )}

      {addMemberOpen && (
        <AddMemberToGroupModal
          groupId={groupId}
          groupName={groupInfo?.name || groupId}
          channel={channel}
          existingMemberIds={groupInfo?.members?.map(m => m.userId) || []}
          onClose={() => setAddMemberOpen(false)}
          onAdded={() => { void onApiSync().finally(() => { void reloadRef.current(); }); }}
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
  const { getActiveAccount } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, accounts: s.accounts, activeAccountId: s.activeAccountId,
  })));
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));
  const [pending, setPending] = useState<PendingMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [approvingAll, setApprovingAll] = useState(false);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc, myAccountId);
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
        payload: { members: userId, isApprove: accept },
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
          payload: { members: member.userId, isApprove: true },
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
    <div className="w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border flex-shrink-0">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="text-sm font-semibold text-foreground flex-1 text-center">Chờ duyệt vào nhóm</span>
        <button onClick={() => loadPending(true)} disabled={loading || approvingAll}
          title="Tải lại"
          className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <Spinner size={8} className="text-yellow-400" />
          <p className="text-sm">Đang tải danh sách...</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && pending.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="w-16 h-16 rounded-full bg-muted/60 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
              <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-foreground/80">Không có yêu cầu nào</p>
            <p className="text-xs text-muted-foreground mt-1">Chưa có ai đang chờ được phê duyệt</p>
          </div>
        </div>
      )}

      {/* List */}
      {!loading && pending.length > 0 && (
        <>
          {/* Stats + approve-all */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60 flex-shrink-0 bg-card/80">
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-yellow-500/20 text-yellow-400 text-[11px] font-bold flex items-center justify-center">
                {pending.length}
              </span>
              <span className="text-xs text-muted-foreground">người đang chờ duyệt</span>
            </div>
            <button
              onClick={handleApproveAll}
              disabled={approvingAll}
              className="flex items-center gap-1.5 text-xs font-medium text-green-400 hover:text-green-300 bg-green-500/10 hover:bg-green-500/20 px-2.5 py-1 rounded-full border border-green-500/20 transition-all disabled:opacity-40">
              {approvingAll ? (
                <Spinner size={3} />
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
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-muted/50 transition-colors group">
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
                  <PeerInitials id={member.userId} name={member.displayName} className="avatar-fallback w-10 h-10 text-sm absolute inset-0"
                    style={{ display: member.avatar ? 'none' : 'flex' }} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate leading-tight">{member.displayName}</p>
                  <p className="text-[11px] text-muted-foreground truncate font-mono mt-0.5">{member.userId}</p>
                </div>

                {/* Action buttons */}
                <div className="flex gap-1.5 flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleReview(member.userId, true)}
                    disabled={processing.has(member.userId) || approvingAll}
                    title="Phê duyệt"
                    className="w-8 h-8 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/25 text-green-400 hover:text-green-300 flex items-center justify-center transition-all disabled:opacity-40">
                    {processing.has(member.userId) ? (
                      <Spinner size={3} />
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
function PendingMembersSection({ groupId, isAdmin, channel }: { groupId: string; isAdmin: boolean; channel: string }) {
  const { getActiveAccount } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, accounts: s.accounts, activeAccountId: s.activeAccountId,
  })));
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));
  const [pending, setPending] = useState<Array<{ userId: string; displayName: string; avatar: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [approvingAll, setApprovingAll] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc);
  };

  const loadPending = async () => {
    if (!channelSupports(channel as Channel, 'supportsPendingApproval')) return;
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
        payload: { members: userId, isApprove: accept },
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
          payload: { members: member.userId, isApprove: true },
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
    <div className="border-t border-border">
      {/* Toggle header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
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
          className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {expanded && (
        <div className="pb-3">
          {/* Sub-header: count + reload + approve-all */}
          <div className="flex items-center justify-between px-4 py-1.5 mb-1">
            <span className="text-xs text-muted-foreground">{pending.length} người đang chờ</span>
            <div className="flex items-center gap-2">
              {pending.length > 0 && (
                <button onClick={handleApproveAll} disabled={approvingAll || loading}
                  className="flex items-center gap-1 text-xs font-medium text-green-400 hover:text-green-300 disabled:opacity-40 transition-colors">
                  {approvingAll ? (
                    <Spinner size={3} />
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
                  <Spinner size={3} className="inline" />
                ) : '↻ Tải lại'}
              </button>
            </div>
          </div>

          {loading && pending.length === 0 && (
            <div className="flex justify-center py-6">
              <Spinner size={5} className="text-yellow-400" />
            </div>
          )}

          {!loading && pending.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <div className="w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
                </svg>
              </div>
              <p className="text-xs text-muted-foreground">Không có ai đang chờ duyệt</p>
            </div>
          )}

          <div className="space-y-0.5 px-2">
            {pending.map(member => (
              <div key={member.userId}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 hover:bg-muted/50 transition-colors group">
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
                  <PeerInitials id={member.userId} name={member.displayName} className="pm-fallback w-9 h-9 text-xs absolute inset-0"
                    style={{ display: member.avatar ? 'none' : 'flex' }} />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate leading-tight">{member.displayName}</p>
                  <p className="text-[11px] text-muted-foreground font-mono truncate">{member.userId}</p>
                </div>

                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleReview(member.userId, true)}
                    disabled={processing.has(member.userId) || approvingAll}
                    title="Phê duyệt"
                    className="w-7 h-7 rounded-lg bg-green-500/15 hover:bg-green-500/30 border border-green-500/20 text-green-400 flex items-center justify-center transition-all disabled:opacity-40">
                    {processing.has(member.userId) ? (
                      <Spinner size={3} />
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
export function ManagePanel({ groupInfo, groupId, onBack, myAccountId, asModal, channel }: {
  groupInfo: CachedGroupInfo | null;
  groupId: string;
  onBack: () => void;
  myAccountId: string;
  asModal?: boolean;
  channel?: string;
}) {
  const { getActiveAccount, activeAccountId } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, activeAccountId: s.activeAccountId, accounts: s.accounts,
  })));
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));
  const [settings, setSettings] = useState<Record<string, any>>(groupInfo?.settings || {});
  const [groupLink, setGroupLink] = useState<string>('');
  const [loadingLink, setLoadingLink] = useState(false);

  // Zalo: 2 = trưởng nhóm, 1 = phó nhóm; Telegram ngược lại — luôn đọc qua shared/groupMemberRoles
  const myRoleKind = myGroupRoleKind(groupInfo, myAccountId, channel);
  const isAdmin = myRoleKind !== 'member';
  const isOwner = myRoleKind === 'owner';

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc, activeAccountId);
  };

  const ch = channel || CHANNEL.ZALO;
  const isZalo = isZaloCh(ch);
  const isTelegram = isTelegramCh(ch);

  /** Extract link from various API response shapes */
  const extractLink = (res: any): string =>
    res?.response?.data?.link
    || res?.response?.link
    || res?.response?.data?.info?.group_link
    || res?.response?.info?.group_link
    || '';

  // Auto-load group link on mount (Telegram: TelegramChatSettings tải link + cài đặt trong một lần)
  useEffect(() => {
    if (!groupId || isTelegram) return;
    setLoadingLink(true);
    const auth = getAuth();
    if (!auth) { setLoadingLink(false); return; }
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
    if (!isZalo) { showNotification('Tính năng chưa hỗ trợ cho kênh này', 'info'); return; }
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
    setLoadingLink(true);
    try {
      if (isTelegram) {
        const { getAdapter } = await import('@/lib/adapters/registry');
        const adapter = getAdapter(ch as any);
        const res = await (adapter as any).getGroupLink({ accountId: myAccountId, threadId: groupId });
        if (res?.link) setGroupLink(res.link);
        else showNotification('Lấy link nhóm thất bại', 'error');
      } else {
        const auth = getAuth();
        if (!auth) { setLoadingLink(false); return; }
        const res = await ipc.zalo?.getGroupLinkDetail({ auth, groupId });
        const link = extractLink(res);
        if (link) { setGroupLink(link); }
        else {
          const enRes = await ipc.zalo?.enableGroupLink({ auth, groupId });
          const newLink = extractLink(enRes);
          setGroupLink(newLink || 'Không lấy được link');
        }
      }
    } catch (e: any) { showNotification(extractApiError(e, 'Lấy link nhóm thất bại'), 'error'); }
    finally { setLoadingLink(false); }
  };

  const handleDisable = async () => {
    if (isTelegram) {
      showNotification('Telegram không hỗ trợ tắt link nhóm', 'info');
      return;
    }
    const auth = getAuth();
    if (!auth) return;
    try {
      await ipc.zalo?.disableGroupLink({ auth, groupId });
      setGroupLink('');
      showNotification('Đã tắt link nhóm', 'success');
    } catch {}
  };

  const handleDisperseGroup = async () => {
    if (isTelegram) {
      showNotification('Telegram không hỗ trợ giải tán nhóm', 'info');
      return;
    }
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

  if (isTelegram) {
    const telegramChannel = (useChatStore.getState().contacts[myAccountId] || [])
      .find(c => c.contact_id === groupId)?.telegram_peer_type === 'channel';
    return (
      <div className={asModal ? 'flex flex-col w-full h-full overflow-y-auto' : 'w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-y-auto'}>
        <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
          <button onClick={onBack} aria-label="Quay lại" className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span className="text-sm font-semibold text-foreground flex-1 text-center pr-6">{telegramChannel ? 'Quản lý kênh' : 'Quản lý nhóm'}</span>
        </div>
        <TelegramChatSettings accountId={myAccountId} chatId={groupId} onDeleted={onBack} />
      </div>
    );
  }

  const SETTINGS_LIST = isZalo ? [
    { key: 'blockName',       label: 'Thay đổi tên & ảnh đại diện của nhóm',                   inverted: true  },
    { key: 'setTopicOnly',    label: 'Ghim tin nhắn, ghi chú, bình chọn lên đầu hội thoại',    inverted: true  },
    { key: 'lockCreatePost',  label: 'Tạo mới ghi chú, nhắc hẹn',                              inverted: true  },
    { key: 'lockCreatePoll',  label: 'Tạo mới bình chọn',                                      inverted: true  },
    { key: 'lockSendMsg',     label: 'Gửi tin nhắn',                                           inverted: true  },
  ] : isTelegram ? [
    // Telegram: settings handled via restrictChatMember, not group-level toggles
    // These are informational only — actual restriction is per-member
  ] : [];

  return (
    <div className={asModal ? 'flex flex-col w-full h-full overflow-y-auto' : 'w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-y-auto'}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="text-sm font-semibold text-foreground flex-1 text-center pr-6">Quản lý nhóm</span>
      </div>

      {/* Member permissions + settings — Zalo only */}
      {isZalo && (
      <>
      <div className="px-4 py-3">
        {!isAdmin && (
          <p className="text-xs text-orange-400 mb-2 flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Bạn không có quyền thay đổi cài đặt nhóm
          </p>
        )}
        <p className="text-xs text-muted-foreground mb-3 font-medium">Cho phép các thành viên trong nhóm:</p>
        <div className="space-y-3">
          {SETTINGS_LIST.map(s => {
            const val = settings[s.key];
            const isOn = s.inverted ? !val : !!val;
            return (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className={`text-sm flex-1 leading-tight ${isAdmin ? 'text-foreground/80' : 'text-muted-foreground'}`}>{s.label}</span>
                <button
                  onClick={() => isAdmin && handleToggleSetting(s.key, val)}
                  disabled={!isAdmin}
                  className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${isAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} ${isOn ? 'bg-blue-600' : 'bg-accent'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${isOn ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border px-4 py-3 space-y-2">
        <p className="text-xs text-muted-foreground font-medium mb-2">Chế độ phê duyệt thành viên mới</p>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${isAdmin ? 'text-foreground/80' : 'text-muted-foreground'}`}>Bật phê duyệt</span>
          <button
            onClick={() => isAdmin && handleToggleSetting('joinAppr', settings.joinAppr)}
            disabled={!isAdmin}
            className={`relative w-10 h-5 rounded-full transition-colors ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''} ${settings.joinAppr ? 'bg-blue-600' : 'bg-accent'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.joinAppr ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${isAdmin ? 'text-foreground/80' : 'text-muted-foreground'}`}>Đánh dấu tin nhắn từ trưởng/phó nhóm</span>
          <button
            onClick={() => isAdmin && handleToggleSetting('signAdminMsg', settings.signAdminMsg)}
            disabled={!isAdmin}
            className={`relative w-10 h-5 rounded-full transition-colors ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''} ${settings.signAdminMsg ? 'bg-blue-600' : 'bg-accent'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.signAdminMsg ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-sm ${isAdmin ? 'text-foreground/80' : 'text-muted-foreground'}`}>Cho phép thành viên mới đọc tin nhắn gần nhất</span>
          <button
            onClick={() => isAdmin && handleToggleSetting('enableMsgHistory', settings.enableMsgHistory)}
            disabled={!isAdmin}
            className={`relative w-10 h-5 rounded-full transition-colors ${!isAdmin ? 'opacity-60 cursor-not-allowed' : ''} ${settings.enableMsgHistory ? 'bg-blue-600' : 'bg-accent'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.enableMsgHistory ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>
      </>
      )}

      {/* Danh sách chờ duyệt - visible for admin khi bật joinAppr */}
      <PendingMembersSection groupId={groupId} isAdmin={isAdmin} channel={channel || CHANNEL.ZALO} />

      {/* Group link */}
      <div className="border-t border-border px-4 py-3 space-y-2">
        <p className="text-xs text-muted-foreground font-medium">Link tham gia nhóm</p>
        {groupLink ? (
          <div className="flex items-center gap-2">
            <input value={groupLink} readOnly className="flex-1 bg-muted border border-input rounded-lg px-2 py-1 text-xs text-foreground/80 truncate" />
            <button onClick={() => { navigator.clipboard.writeText(groupLink); showNotification('Đã sao chép link', 'success'); }}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded-lg">Sao chép</button>
            {!isTelegram && (
              <button onClick={handleDisable} className="text-xs bg-muted hover:bg-accent text-foreground/80 px-2 py-1 rounded-lg">Tắt</button>
            )}
          </div>
        ) : (
          <button onClick={handleGetGroupLink} disabled={loadingLink}
            className="w-full py-2 rounded-xl bg-muted hover:bg-accent text-sm text-foreground/80 flex items-center justify-center gap-2">
            {loadingLink ? (
              <Spinner size={4} />
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

      {/* Danger zone - owner only, Zalo only */}
      {isOwner && isZalo && (
        <div className="border-t border-border px-4 py-3 mt-auto space-y-2">
          <button
            onClick={() => setPanelViewBlocked()}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted hover:bg-accent text-sm text-foreground/80 transition-colors">
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
