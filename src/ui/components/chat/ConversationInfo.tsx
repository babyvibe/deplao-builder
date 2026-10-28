import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { LOCAL_PIN_CHANGED_EVENT } from '@/lib/chat/relayUiEvents';
import { useEmployeeResync } from '@/hooks/useEmployeeResync';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import PhoneDisplay from '../common/PhoneDisplay';
import { CreateGroupModal } from './GroupModals';
import GroupInfoPanel from './GroupInfoPanel';
import MediaSection, { MediaDetailPanel, MediaTab } from './MediaSection';
import { UserActionSection } from './ConversationActions';
import { extractUserProfile } from '../../../utils/profileUtils';
import { fetchAllAliases } from '@/lib/zaloAliasUtils';
import { Spinner } from '@/components/common/PageLoading';
import GroupAvatar from '../common/GroupAvatar';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { getCapability, channelSupports, type Channel } from '../../../configs/channelConfig';
import { CHANNEL, isZalo as isZaloCh, isNonZalo, isFacebook, isTelegram as isTelegramCh } from '@/lib/channelHelper';
import { fetchContactInfo } from '@/hooks/useZaloEvents';
import { BellIcon, BellOffIcon, GiftIcon, MapPinIcon, PhoneIcon, PinIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import PeerInitials from '@/components/common/PeerInitials';
import ZaloPresenceLine from './zalo/ZaloPresenceLine';
import ZaloAutoDeleteSection from './zalo/ZaloAutoDeleteSection';
import { isMyDocumentsThread } from '@/lib/chat/myDocuments';

function muteUntilToDuration(until: number): number | string {
  if (until === 0) return -1;
  const remainSec = Math.round((until - Date.now()) / 1000);
  if (Math.abs(remainSec - 3600) <= 300) return 3600;
  if (Math.abs(remainSec - 14400) <= 300) return 14400;
  const t = new Date(until);
  if (t.getHours() === 8 && t.getMinutes() === 0) return 'until8AM';
  return remainSec > 0 ? remainSec : -1;
}



export default function ConversationInfo() {
  const { activeThreadId, activeThreadType, contacts } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, activeThreadType: s.activeThreadType, contacts: s.contacts,
  })));
  const { activeAccountId } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId,
  })));

  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];
  const contact = contactList.find((c) => c.contact_id === activeThreadId);
  const isGroup = activeThreadType === 1 || contact?.contact_type === 'group';

  if (isGroup) return <GroupInfoPanel />;
  return <UserConversationInfo />;
}

// ─── UserConversationInfo ─────────────────────────────────────────────────────
function UserConversationInfo() {
  const { activeThreadId, activeThreadType, contacts, updateContact } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, activeThreadType: s.activeThreadType, contacts: s.contacts,
    updateContact: s.updateContact,
  })));
  const { activeAccountId, getActiveAccount } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, getActiveAccount: s.getActiveAccount, accounts: s.accounts,
  })));
  const { showNotification, setMuted, clearMuted, isMuted: isMutedFn } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, setMuted: s.setMuted, clearMuted: s.clearMuted, isMuted: s.isMuted,
    mutedThreads: s.mutedThreads,
  })));

  const [isPinned, setIsPinned] = useState(false);
  const [isLocalPinned, setIsLocalPinned] = useState(false);
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasValue, setAliasValue] = useState('');
  const [hovering, setHovering] = useState(false);
  const [muteDropdownOpen, setMuteDropdownOpen] = useState(false);
  const [muteDropdownPos, setMuteDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const muteRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [mediaDetailTab, setMediaDetailTab] = useState<MediaTab | null>(null);
  const [showMutualGroups, setShowMutualGroups] = useState(false);
  const [mutualGroups, setMutualGroups] = useState<{ groupId: string; name: string; avatar: string }[]>([]);
  const [mutualGroupsLoading, setMutualGroupsLoading] = useState(false);
  // isFriendDB: check thực từ bảng friends trong DB (đáng tin hơn contact.is_friend)
  const [isFriendDB, setIsFriendDB] = useState<boolean | null>(null);
  const [aliasRefreshing, setAliasRefreshing] = useState(false);
  // Editable contact info states
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [editingBirthday, setEditingBirthday] = useState(false);
  const [birthdayInput, setBirthdayInput] = useState('');
  // Gender picker popup
  const [showGenderPicker, setShowGenderPicker] = useState(false);
  const genderBtnRef = useRef<HTMLDivElement>(null);

  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];
  const contact = contactList.find((c) => c.contact_id === activeThreadId);
  const channelCap = getCapability((contact?.channel || CHANNEL.ZALO) as Channel);
  // Kiểm tra thêm account channel để fallback đúng cho FB khi contact thiếu channel field
  const activeAccount = getActiveAccount();
  const effectiveChannel = (contact?.channel || activeAccount?.channel || CHANNEL.ZALO) as Channel;
  const effectiveChannelCap = getCapability(effectiveChannel);
  // Hội thoại Zalo 1:1 thật (không phải nhóm / chính mình / My Documents): trạng thái truy cập (ZL-01), tự xoá tin (ZL-05)
  const zaloDirect = isZaloCh(effectiveChannel) && !!activeAccountId && !!activeThreadId
    && contact?.contact_type !== 'group' && activeThreadId !== activeAccountId
    && !isMyDocumentsThread((activeAccount || {}) as any, activeThreadId);
  // Hiển thị: ưu tiên alias → display_name
  const displayName = contact?.alias || contact?.display_name || activeThreadId || '';
  const avatarUrl = contact?.avatar_url || '';

  // Check friends table mỗi khi thread thay đổi
  useEffect(() => {
    setIsFriendDB(null);
    if (!activeAccountId || !activeThreadId) return;
    DataAccessor.isFriend({ zaloId: activeAccountId, userId: activeThreadId })
      // Lỗi đọc (employee: mất kết nối BOSS) ≠ "không phải bạn bè": dùng cờ trên hội thoại như khi lỗi IPC
      .then((res: any) => setIsFriendDB(isReadFailure(res) ? !!(contact?.is_friend) : !!res?.isFriend))
      .catch(() => setIsFriendDB(!!(contact?.is_friend)));
  }, [activeAccountId, activeThreadId]);
  // Init aliasValue từ alias (không phải display_name) khi thread thay đổi
  useEffect(() => {
    setAliasValue(contact?.alias || '');
  }, [activeThreadId, contact?.alias]);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc, activeAccountId);
  };

  // Load pin status on mount / thread change
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    loadPinStatus();
    // Always load local pin status regardless of channel
    DataAccessor.getLocalPinnedConversations({ zaloId: activeAccountId })
      .then((res: any) => setIsLocalPinned((res?.threadIds || []).includes(activeThreadId)))
      .catch(() => {});
  }, [activeAccountId, activeThreadId]);

  // Ghim trong app của hội thoại đang mở đổi ở nơi khác (Boss / nhân viên khác / ConversationList — relay
  // db:pinnedConversationChanged → 'local-pin-changed' có threadId + isPinned)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || typeof detail.isPinned !== 'boolean') return;
      if (String(detail.zaloId || '') !== String(activeAccountId || '') || String(detail.threadId || '') !== String(activeThreadId || '')) return;
      setIsLocalPinned(detail.isPinned);
    };
    window.addEventListener(LOCAL_PIN_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOCAL_PIN_CHANGED_EVENT, handler);
  }, [activeAccountId, activeThreadId]);

  // Chế độ nhân viên: kết nối BOSS phục hồi → đọc lại cờ ghim trong app (đổi trong lúc mất kết nối không có event).
  // Lỗi đọc / đã đổi hội thoại → giữ cờ đang hiện.
  useEmployeeResync(() => {
    const accountId = useAccountStore.getState().activeAccountId;
    const threadId = useChatStore.getState().activeThreadId;
    if (!accountId || !threadId) return;
    return DataAccessor.getLocalPinnedConversations({ zaloId: accountId }).then((res: any) => {
      if (isReadFailure(res)) return;
      if (useAccountStore.getState().activeAccountId !== accountId || useChatStore.getState().activeThreadId !== threadId) return;
      setIsLocalPinned((res?.threadIds || []).map(String).includes(String(threadId)));
    }).catch(() => {});
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

  // ── Auto-fetch user info khi vào hội thoại chưa có thông tin ──────────
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    if (activeThreadType === 1) return; // Group - không áp dụng

    const ctList = useChatStore.getState().contacts[activeAccountId] || [];
    const ct = ctList.find((c) => c.contact_id === activeThreadId);
    if (!ct) return;

    const channel = ct.channel || CHANNEL.ZALO;
    const hasRealName = !!(ct.display_name && ct.display_name !== activeThreadId && !/^\d+$/.test(ct.display_name));
    const hasAvatar = !!ct.avatar_url;
    if (hasRealName && hasAvatar) return; // Đã có đủ thông tin

    setLoading(true);
    if (isZaloCh(channel)) {
      // Dùng fetchContactInfo có cache 7 ngày + xử lý alias
      fetchContactInfo(activeAccountId, activeThreadId)
        .finally(() => setLoading(false))
        .catch(() => {});
    } else if (isFacebook(channel)) {
      Promise.all([
        ipc.fb?.getUserInfoFacebook({ accountId: activeAccountId, userId: activeThreadId }) || Promise.resolve(null),
        /^\d+$/.test(activeThreadId)
          ? (ipc.fb?.refreshContactAvatar({ accountId: activeAccountId, userId: activeThreadId }) || Promise.resolve(null))
          : Promise.resolve(null),
      ])
        .then(([infoRes, avatarRes]) => {
          if (infoRes?.success && (infoRes.name || infoRes.avatarUrl)) {
            const patch: any = { contact_id: activeThreadId, channel: 'facebook' };
            if (infoRes.name) patch.display_name = infoRes.name;
            if (infoRes.avatarUrl) patch.avatar_url = infoRes.avatarUrl;
            useChatStore.getState().updateContact(activeAccountId!, patch);
          }
          if (avatarRes?.success && avatarRes.avatarUrl) {
            useChatStore.getState().updateContact(activeAccountId!, {
              contact_id: activeThreadId,
              avatar_url: avatarRes.avatarUrl,
            });
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    } else if (isTelegramCh(channel)) {
      // Telegram: contact info comes from MTProto/Bot API during message sync
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [activeAccountId, activeThreadId, activeThreadType]);

  const loadPinStatus = async () => {
    if (!channelCap.supportsPinConversation) return;
    // Only Zalo has server-side pin sync
    if (isNonZalo(effectiveChannel)) return;
    const auth = getAuth();
    if (!auth) return;
    try {
      const res = await ipc.zalo?.getPinConversations(auth);
      const convIds: string[] = res?.response?.conversations || [];
      setIsPinned(convIds.some((id: string) => id.replace(/^[ug]/, '') === activeThreadId));
    } catch {}
  };

  const handleRefresh = async () => {
    if (loading) return;
    setLoading(true);
    try {
      // Pin status only for Zalo
      if (isZaloCh(effectiveChannel)) await loadPinStatus();
      // Fetch fresh user profile via API if supported (Zalo only)
      const ch = effectiveChannel as Channel;
      if (activeAccountId && activeThreadId && channelSupports(ch, 'supportsAlias') && isZaloCh(ch)) {
        const auth = getAuth();
        if (auth) {
          try {
            const res = await ipc.zalo?.getUserInfo({ auth, userId: activeThreadId });
            const profile = res?.response?.changed_profiles?.[activeThreadId]
              || res?.response?.data?.[activeThreadId];
            if (profile) {
              const { displayName: newName, avatar: newAvatar, phone: newPhone, gender, birthday, alias: newAlias } = extractUserProfile(profile);
              // Only patch fields that have actual values - never spread undefined
              const patch: any = { contact_id: activeThreadId };
              if (newName) patch.display_name = newName;
              if (newAvatar) patch.avatar_url = newAvatar;
              if (newPhone) patch.phone = newPhone;
              if (newAlias) patch.alias = newAlias;
              if (gender !== null) patch.gender = gender;
              if (birthday) patch.birthday = birthday;
              if (newName || newAvatar || newPhone || newAlias || gender !== null || birthday) {
                updateContact(activeAccountId, patch);
                await DataAccessor.updateContactProfile({
                  zaloId: activeAccountId, contactId: activeThreadId,
                  displayName: newName, avatarUrl: newAvatar, phone: newPhone,
                  gender, birthday,
                });
                // Lưu alias vào DB (field riêng, không overwrite display_name)
                if (newAlias) {
                  DataAccessor.setContactAlias({
                    zaloId: activeAccountId,
                    contactId: activeThreadId,
                    alias: newAlias,
                  }).catch(() => {});
                }
              }
            }
          } catch {}
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleMuteWithTime = (until: number) => {
    if (!activeAccountId || !activeThreadId) return;
    setMuted(activeAccountId, activeThreadId, until);
    showNotification('Đã tắt thông báo', 'success');
    setMuteDropdownOpen(false);
    // Gọi API đồng bộ lên server (fire-and-forget) - chỉ Zalo
    if (channelCap.supportsMuteSync && isZaloCh(effectiveChannel)) {
      const auth = getAuth();
      if (auth) {
        const duration = muteUntilToDuration(until);
        ipc.zalo?.setMute({ auth, threadId: activeThreadId, threadType: 0, duration, action: 1 }).catch(() => {});
      }
    }
  };

  const handleUnmute = () => {
    if (!activeAccountId || !activeThreadId) return;
    clearMuted(activeAccountId, activeThreadId);
    showNotification('Đã bật thông báo', 'success');
    // Gọi API đồng bộ lên server (fire-and-forget) - chỉ Zalo
    if (channelCap.supportsMuteSync && isZaloCh(effectiveChannel)) {
      const auth = getAuth();
      if (auth) {
        ipc.zalo?.setMute({ auth, threadId: activeThreadId, threadType: 0, action: 3 }).catch(() => {});
      }
    }
  };

  const handleTogglePin = async () => {
    if (!activeThreadId) return;
    // Non-Zalo channels OR channels without server pin: use local pin only
    if (isNonZalo(effectiveChannel) || !effectiveChannelCap.supportsPinConversation) {
      // FB / non-Zalo: use local pin only
      if (!activeAccountId) return;
      const newVal = !isLocalPinned;
      const pinRes: any = await DataAccessor.setLocalPinnedConversation({ zaloId: activeAccountId, threadId: activeThreadId, isPinned: newVal });
      // Nhân viên: Boss từ chối / mất kết nối → báo lỗi, giữ trạng thái cũ
      if (pinRes?.success === false) {
        showNotification(`Không ${newVal ? 'ghim' : 'bỏ ghim'} được: ${pinRes.error || 'lỗi không xác định'}`, 'error');
        return;
      }
      setIsLocalPinned(newVal);
      showNotification(newVal ? 'Đã ghim trong app' : 'Đã bỏ ghim khỏi app', 'success');
      return;
    }
    const auth = getAuth();
    if (!auth) return;
    try {
      await ipc.zalo?.setPinConversation({
        auth,
        conversations: [{ threadId: activeThreadId, type: activeThreadType }],
        isPin: !isPinned,
      });
      setIsPinned(!isPinned);
      showNotification(isPinned ? 'Đã bỏ ghim hội thoại' : 'Đã ghim hội thoại', 'success');
    } catch (e: any) {
      showNotification('Lỗi: ' + e.message, 'error');
    }
  };

  const handleSaveAlias = async () => {
    if (!activeThreadId) return;
    try {
      const trimmed = aliasValue.trim();
      // Channels with API alias support: sync to server. Others: save locally only.
      if (isZaloCh(effectiveChannel) && channelSupports(effectiveChannel, 'supportsAlias')) {
        const auth = getAuth();
        if (auth) {
          const res = await ipc.zalo?.changeFriendAlias({ auth, alias: trimmed, friendId: activeThreadId });
          if (res && !res.success && res.error) {
            showNotification('Lỗi cập nhật biệt danh: ' + res.error, 'error');
            return;
          }
        }
      }
      // Telegram/Facebook: save locally only (no server alias API)
      if (isNonZalo(effectiveChannel) && channelSupports(effectiveChannel, 'supportsAlias')) {
        // Telegram User supports editing contacts but no IPC wired yet — save locally
      }
      // Always save alias locally to DB
      if (activeAccountId) {
        useChatStore.getState().updateContact(activeAccountId, {
          contact_id: activeThreadId,
          alias: trimmed,
        });
        DataAccessor.setContactAlias({
          zaloId: activeAccountId,
          contactId: activeThreadId,
          alias: trimmed,
        }).catch(() => {});
      }
      showNotification('Đã cập nhật biệt danh', 'success');
      setEditingAlias(false);
    } catch (e: any) {
      showNotification('Lỗi: ' + e.message, 'error');
    }
  };

  /** Reload alias + user info từ API - lưu toàn bộ alias + cập nhật thông tin hội thoại hiện tại */
  const handleRefreshAlias = async () => {
    if (!activeThreadId || !activeAccountId) return;
    setAliasRefreshing(true);
    try {
      if (isZaloCh(effectiveChannel) && channelSupports(effectiveChannel, 'supportsAlias')) {
        const auth = getAuth();
        if (!auth) return;
        // 1. Update toàn bộ alias từ fetchAllAliases (pagination, count=200)
        const aliasItems = await fetchAllAliases(auth);
        for (const item of aliasItems) {
          if (item.alias && item.userId) {
            updateContact(activeAccountId, { contact_id: item.userId, alias: item.alias });
            DataAccessor.setContactAlias({ zaloId: activeAccountId, contactId: item.userId, alias: item.alias }).catch(() => {});
          }
        }
        // 2. Fetch full profile (tên, avatar, SĐT) cho hội thoại hiện tại
        const infoRes = await ipc.zalo?.getUserInfo({ auth, userId: activeThreadId });
        const rawProfile = infoRes?.response?.changed_profiles?.[activeThreadId]
          || infoRes?.response?.data?.[activeThreadId];
        if (rawProfile) {
          const { displayName: newName, avatar: newAvatar, phone: newPhone, gender, birthday, alias: newAlias } = extractUserProfile(rawProfile);
          const patch: any = { contact_id: activeThreadId };
          if (newName) patch.display_name = newName;
          if (newAvatar) patch.avatar_url = newAvatar;
          if (newPhone) patch.phone = newPhone;
          if (newAlias) patch.alias = newAlias;
          if (gender !== null) patch.gender = gender;
          if (birthday) patch.birthday = birthday;
          if (Object.keys(patch).length > 1) {
            updateContact(activeAccountId, patch);
            await DataAccessor.updateContactProfile({
              zaloId: activeAccountId, contactId: activeThreadId,
              displayName: newName, avatarUrl: newAvatar, phone: newPhone,
              gender, birthday,
            });
            if (newAlias) {
              DataAccessor.setContactAlias({ zaloId: activeAccountId, contactId: activeThreadId, alias: newAlias }).catch(() => {});
            }
          }
        }
      } else {
        // Facebook / other: refresh thông tin user từ profile HTML + reload alias từ DB
        // FB: refresh tên + avatar từ profile HTML
        const fbRes = await ipc.fb?.getUserInfoFacebook({ accountId: activeAccountId, userId: activeThreadId });
        if (fbRes?.success && (fbRes.name || fbRes.avatarUrl)) {
          const patch: any = { contact_id: activeThreadId };
          if (fbRes.name) patch.display_name = fbRes.name;
          if (fbRes.avatarUrl) patch.avatar_url = fbRes.avatarUrl;
          if (Object.keys(patch).length > 1) updateContact(activeAccountId, patch);
        }
      }
    } catch {} finally {
      setAliasRefreshing(false);
    }
  };

  // ─── Editable contact info handlers ─────────────────────────────────────
  const handleSavePhone = async () => {
    if (!activeAccountId || !activeThreadId) return;
    const normalized = phoneInput.trim();
    updateContact(activeAccountId, { contact_id: activeThreadId, phone: normalized || undefined });
    await DataAccessor.updateContactProfile({
      zaloId: activeAccountId, contactId: activeThreadId,
      phone: normalized,
      gender: contact?.gender ?? null,
      birthday: contact?.birthday ?? null,
      displayName: contact?.display_name || '',
      avatarUrl: contact?.avatar_url || '',
    }).catch(() => {});
    setEditingPhone(false);
    showNotification('Đã cập nhật số điện thoại', 'success');
  };

  const handleSaveBirthday = async () => {
    if (!activeAccountId || !activeThreadId) return;
    const val = birthdayInput.trim();
    // Basic validation: DD/MM/YYYY or empty
    if (val && !/^\d{2}\/\d{2}\/\d{4}$/.test(val)) {
      showNotification('Ngày sinh không đúng định dạng DD/MM/YYYY', 'error');
      return;
    }
    updateContact(activeAccountId, { contact_id: activeThreadId, birthday: val || null });
    await DataAccessor.updateContactProfile({
      zaloId: activeAccountId, contactId: activeThreadId,
      phone: contact?.phone || '',
      gender: contact?.gender ?? null,
      birthday: val || null,
      displayName: contact?.display_name || '',
      avatarUrl: contact?.avatar_url || '',
    }).catch(() => {});
    setEditingBirthday(false);
    showNotification('Đã cập nhật ngày sinh', 'success');
  };

  const handleSetGender = async (gender: number | null) => {
    if (!activeAccountId || !activeThreadId) return;
    updateContact(activeAccountId, { contact_id: activeThreadId, gender });
    await DataAccessor.updateContactProfile({
      zaloId: activeAccountId, contactId: activeThreadId,
      phone: contact?.phone || '',
      gender,
      birthday: contact?.birthday || null,
      displayName: contact?.display_name || '',
      avatarUrl: contact?.avatar_url || '',
    }).catch(() => {});
    const label = gender === 0 ? 'Nam' : gender === 1 ? 'Nữ' : 'chưa xác định';
    showNotification(`Đã đặt giới tính: ${label}`, 'success');
  };

  // Close gender picker on outside click
  useEffect(() => {
    if (!showGenderPicker) return;
    const handler = (e: MouseEvent) => {
      if (genderBtnRef.current && !genderBtnRef.current.contains(e.target as Node)) setShowGenderPicker(false);
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowGenderPicker(false); };
    setTimeout(() => {
      document.addEventListener('mousedown', handler);
      document.addEventListener('keydown', keyHandler);
    }, 0);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [showGenderPicker]);

  // Load mutual groups khi mở sub-panel
  const handleOpenMutualGroups = () => {
    if (!channelCap.supportsMutualGroups) return;
    setShowMutualGroups(true);
    if (mutualGroups.length > 0) return;
    if (!activeAccountId || !activeThreadId) return;
    // Only Zalo has mutual groups API wired
    if (isNonZalo(effectiveChannel)) { setMutualGroupsLoading(false); return; }
    const acc = getActiveAccount();
    if (!acc) return;
    const auth = buildZaloAuth(acc, activeAccountId);
    setMutualGroupsLoading(true);
    ipc.zalo?.getRelatedFriendGroup({ auth, userId: activeThreadId })
      .then((res: any) => {
        if (!res?.success || !res.response) return;
        const raw = res.response;
        let groupIds: string[] = [];
        if (raw.groupRelateds && typeof raw.groupRelateds === 'object') {
          const val = raw.groupRelateds[activeThreadId] || raw.groupRelateds['all'];
          if (Array.isArray(val)) groupIds = val;
          else if (val && typeof val === 'object') groupIds = Object.keys(val);
          else {
            const firstVal = Object.values(raw.groupRelateds)[0];
            if (Array.isArray(firstVal)) groupIds = firstVal as string[];
          }
        } else if (Array.isArray(raw.groupIds)) {
          groupIds = raw.groupIds;
        } else if (Array.isArray(raw)) {
          groupIds = raw;
        }
        const allContacts = useChatStore.getState().contacts[activeAccountId] || [];
        const groups = groupIds.map((gid: string) => {
          const cached = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[gid];
          if (cached?.name) return { groupId: String(gid), name: cached.name, avatar: cached.avatar || '' };
          const gc = allContacts.find((c: any) => c.contact_id === String(gid));
          return { groupId: String(gid), name: gc?.display_name || '', avatar: gc?.avatar_url || '' };
        });
        setMutualGroups(groups);
      })
      .catch(() => {})
      .finally(() => setMutualGroupsLoading(false));
  };

  const isMuted = activeAccountId && activeThreadId ? isMutedFn(activeAccountId, activeThreadId) : false;

  // Mutual groups sub-panel
  if (showMutualGroups && activeThreadId) {
    return (
      <div className="w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
          <button onClick={() => setShowMutualGroups(false)}
            className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <span className="text-sm font-semibold text-foreground flex-1 text-center pr-6">
            Nhóm chung ({mutualGroups.length})
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {mutualGroupsLoading && mutualGroups.length === 0 && (
            <div className="flex items-center justify-center py-10">
              <Spinner size={5} />
            </div>
          )}
          {mutualGroups.map(g => (
            <button key={g.groupId}
              onClick={() => { useChatStore.getState().setActiveThread(g.groupId, 1); setShowMutualGroups(false); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50 transition-colors text-left">
              <GroupAvatar
                id={g.groupId}
                name={g.name || g.groupId}
                avatarUrl={g.avatar}
                groupInfo={useAppStore.getState().groupInfoCache?.[activeAccountId || '']?.[g.groupId] || null}
                size="sm"
              />
              <span className="text-sm text-foreground truncate flex-1">{g.name || g.groupId}</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          ))}
          {!mutualGroupsLoading && mutualGroups.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">Không có nhóm chung</p>
          )}
        </div>
      </div>
    );
  }

  // Media detail - thay thế toàn bộ panel
  if (mediaDetailTab !== null && activeThreadId) {
    return (
      <MediaDetailPanel
        threadId={activeThreadId}
        activeAccountId={activeAccountId || ''}
        tab={mediaDetailTab}
        onBack={() => setMediaDetailTab(null)}
      />
    );
  }

  const isFriend = isFriendDB !== null
    ? isFriendDB
    : !!(contact?.is_friend || contact?.isFr === 1);

  // @ts-ignore
  // @ts-ignore
  return (
    <>
    <div className="w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-border">
        <span className="flex-1 text-sm font-semibold text-foreground text-center">Thông tin liên hệ</span>
        {(channelCap.supportsAlias || channelCap.supportsPinConversation) && (
        <button title="Cập nhật thông tin" onClick={handleRefresh} disabled={loading}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 flex-shrink-0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        )}
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="flex-1 flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-muted-foreground">Đang tải thông tin...</span>
          </div>
        </div>
      )}

      {!loading && (
      <>
      {/* Avatar + name */}
      <div className="flex flex-col items-center py-6 px-4 border-b border-border">
        {avatarUrl ? (
          <img src={toLocalMediaUrl(avatarUrl)} alt={displayName} className="w-16 h-16 rounded-full object-cover mb-3" />
        ) : (
          <PeerInitials id={activeThreadId} name={displayName} fallback="U" className="w-16 h-16 text-xl mb-3" />
        )}
        {editingAlias ? (
          <div className="flex items-center gap-2 mt-2 w-full px-2">
            <input value={aliasValue} onChange={e => setAliasValue(e.target.value)}
              className="flex-1 bg-muted border border-input rounded-lg px-2 py-1 text-sm text-foreground focus:outline-none focus:border-blue-500 text-center"
              placeholder="Nhập biệt danh..." autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSaveAlias(); if (e.key === 'Escape') setEditingAlias(false); }} />
            <button onClick={handleSaveAlias} className="px-2 py-1 bg-blue-600 rounded-lg text-xs text-white hover:bg-blue-700 flex-shrink-0">Lưu</button>
            <button onClick={() => setEditingAlias(false)} className="px-2 py-1 bg-muted rounded-lg text-xs text-foreground/80 hover:bg-accent flex-shrink-0">✕</button>
          </div>
        ) : (
          <div className={`group flex items-center gap-1.5 mt-1 ${channelCap.supportsAlias ? 'cursor-pointer' : ''}`}
            onMouseEnter={() => channelCap.supportsAlias && setHovering(true)} onMouseLeave={() => setHovering(false)}
            onClick={() => { if (!channelCap.supportsAlias) return; setAliasValue(contact?.alias || ''); setEditingAlias(true); }}>
            <p className="text-foreground font-semibold text-base text-center">{displayName}</p>
            {channelCap.supportsAlias && isZaloCh(effectiveChannel) && (
              <button
                title="Cập nhật thông tin + tên gợi nhớ"
                onClick={(e) => { e.stopPropagation(); handleRefreshAlias(); }}
                className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                disabled={aliasRefreshing}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={aliasRefreshing ? 'animate-spin' : ''}>
                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                </svg>
              </button>
            )}
            {channelCap.supportsAlias && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`text-foreground/80 transition-opacity flex-shrink-0 ${hovering ? 'opacity-100' : 'opacity-0'}`}>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            )}
          </div>
        )}
        {contact?.alias && contact?.display_name && contact.alias !== contact.display_name && (
          <p className="text-muted-foreground text-xs mt-0.5 text-center">({contact.display_name})</p>
        )}
        {contact?.phone && (
          <p className="text-muted-foreground text-xs mt-0.5">
            <PhoneDisplay phone={contact.phone} className="text-muted-foreground text-xs" showIcon={true} />
          </p>
        )}
        <ZaloPresenceLine accountId={activeAccountId} userId={activeThreadId} enabled={zaloDirect} className="mt-1" />
      </div>

      {/* Contact detail info - editable phone, birthday, gender */}
      <div className="border-b border-border divide-y divide-border/50">
        <ContactInfoRow
          icon={<PhoneIcon className="w-4 h-4" />}
          label="Số điện thoại"
          value={contact?.phone || ''}
          placeholder="Thêm số điện thoại"
          editing={editingPhone}
          editValue={phoneInput}
          onStartEdit={() => { setPhoneInput(contact?.phone || ''); setEditingPhone(true); }}
          onCancelEdit={() => setEditingPhone(false)}
          onSave={handleSavePhone}
          onEditChange={setPhoneInput}
        />
        <ContactInfoRow
          icon={<GiftIcon className="w-4 h-4" />}
          label="Sinh nhật"
          value={contact?.birthday || ''}
          placeholder="Chọn ngày"
          editing={editingBirthday}
          editValue={birthdayInput}
          onStartEdit={() => { setBirthdayInput(contact?.birthday || ''); setEditingBirthday(true); }}
          onCancelEdit={() => setEditingBirthday(false)}
          onSave={handleSaveBirthday}
          onEditChange={setBirthdayInput}
          inputType="date"
        />
        <div ref={genderBtnRef} className="relative">
          <ContactInfoRow
            icon={<UserIcon className="w-4 h-4" />}
            label="Giới tính"
            value={contact?.gender === 0 ? 'Nam' : contact?.gender === 1 ? 'Nữ' : ''}
            placeholder="Chọn giới tính"
            editing={false}
            onStartEdit={() => setShowGenderPicker(true)}
            isClickable
          />
          {showGenderPicker && (
            <GenderPickerPopup
              current={contact?.gender ?? null}
              onSelect={(g) => { handleSetGender(g); setShowGenderPicker(false); }}
              onClose={() => setShowGenderPicker(false)}
            />
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex justify-around py-3 border-b border-border relative">
        {/* Mute with time picker dropdown */}
        <div className="relative" ref={muteRef}>
          <UserActionBtn
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
              {[
                { label: 'Trong 1 giờ',             until: () => Date.now() + 60 * 60 * 1000 },
                { label: 'Trong 4 giờ',             until: () => Date.now() + 4 * 60 * 60 * 1000 },
                { label: 'Cho đến 8:00 AM',         until: () => { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 8 ? 1 : 0)); d.setHours(8,0,0,0); return d.getTime(); } },
                { label: 'Cho đến khi được mở lại', until: () => 0 },
              ].map(opt => (
                <button key={opt.label} onClick={() => handleMuteWithTime(opt.until())}
                  className="w-full flex items-center px-4 py-2.5 text-sm text-foreground/80 hover:bg-muted hover:text-foreground text-left transition-colors">
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {effectiveChannelCap.supportsPinConversation && isZaloCh(effectiveChannel) && (
          <UserActionBtn icon={<PinIcon className="w-4 h-4" />} label={isPinned ? 'Bỏ ghim' : 'Ghim hội thoại'} onClick={handleTogglePin} active={isPinned} />
        )}
        {(!effectiveChannelCap.supportsPinConversation || isNonZalo(effectiveChannel)) && (
          <UserActionBtn icon={<MapPinIcon className="w-4 h-4" />} label={isLocalPinned ? 'Bỏ ghim app' : 'Ghim trong app'} onClick={handleTogglePin} active={isLocalPinned} />
        )}
        {channelCap.supportsCreateGroup && (
          <UserActionBtn icon={<UsersIcon className="w-4 h-4" />} label="Tạo nhóm" onClick={() => setCreateGroupOpen(true)} />
        )}
      </div>


      {/* Tự xoá tin nhắn trên Zalo (ZL-05) — Deplao vẫn giữ tin */}
      {zaloDirect && activeAccountId && activeThreadId && (
        <div className="border-b border-border">
          <ZaloAutoDeleteSection accountId={activeAccountId} threadId={activeThreadId} isGroup={false} bordered={false} />
        </div>
      )}

      {/* Shared media / file / link section */}
      {activeThreadId && (
        <MediaSection
          threadId={activeThreadId}
          onOpenDetail={(t) => setMediaDetailTab(t)}
        />
      )}

      {/* User actions: nhóm chung, chặn, báo xấu, xoá bạn, xoá lịch sử */}
      {activeThreadId && (
        <UserActionSection
          userId={activeThreadId}
          userName={displayName}
          isFriend={isFriend}
          onMutualGroupsOpen={handleOpenMutualGroups}
          channelCap={channelCap}
          onFriendRemoved={() => {
            setIsFriendDB(false);
            if (activeAccountId) {
              useChatStore.getState().updateContact(activeAccountId, { contact_id: activeThreadId, is_friend: 0 });
            }
          }}
        />
      )}


      {/* Create group modal */}
      {createGroupOpen && activeThreadId && (
        <CreateGroupModal preSelected={[activeThreadId]} onClose={() => setCreateGroupOpen(false)} />
      )}
      </>
      )}
    </div>
    </>
  );
}

function UserActionBtn({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick}
      className="flex flex-col items-center gap-1 py-2 px-1 rounded-xl hover:bg-muted transition-colors text-center"
      title={label}
    >
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${active ? 'bg-blue-600' : 'bg-muted'}`}>{icon}</div>
      <span className={`text-[9px] leading-tight ${active ? 'text-blue-400' : 'text-muted-foreground'}`}>{label}</span>
    </button>
  );
}

// ─── ContactInfoRow ──────────────────────────────────────────────────────────
/** Inline-editable row: icon + label + value/input. Click value to edit, Enter to save, Esc to cancel. */
function ContactInfoRow({ icon, label, value, placeholder, editing, editValue, onStartEdit, onCancelEdit, onSave, onEditChange, onClick, isClickable, inputType }: {
  icon: React.ReactNode; label: string; value: string; placeholder?: string;
  editing?: boolean; editValue?: string;
  onStartEdit?: () => void; onCancelEdit?: () => void; onSave?: () => void; onEditChange?: (v: string) => void;
  onClick?: () => void; isClickable?: boolean;
  inputType?: 'text' | 'date';
}) {
  /** Convert DD/MM/YYYY → YYYY-MM-DD cho date input */
  const toDateInputValue = (ddmmyyyy: string): string => {
    if (!ddmmyyyy) return '';
    const parts = ddmmyyyy.split('/');
    if (parts.length !== 3) return '';
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  };
  /** Convert YYYY-MM-DD → DD/MM/YYYY cho DB */
  const fromDateInputValue = (yyyyMmDd: string): string => {
    if (!yyyyMmDd) return '';
    const parts = yyyyMmDd.split('-');
    if (parts.length !== 3) return '';
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  };

  const isDate = inputType === 'date';
  const inputVal = isDate ? toDateInputValue(editValue || '') : (editValue || '');

  return (
    <div className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/20 transition-colors min-h-[44px]">
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span className="text-base flex-shrink-0 leading-none">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-[0.08em]">{label}</p>
          {editing && onEditChange ? (
            <div className="flex items-center gap-1 mt-1">
              {isDate ? (
                <input type="date"
                  value={inputVal}
                  onChange={e => onEditChange(fromDateInputValue(e.target.value))}
                  className="flex-1 bg-muted border border-input rounded-lg px-2 py-1 text-sm text-foreground w-28 focus:outline-none focus:border-blue-500 [color-scheme:dark]"
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') onSave?.(); if (e.key === 'Escape') onCancelEdit?.(); }}
                />
              ) : (
                <input
                  value={editValue || ''}
                  onChange={e => onEditChange(e.target.value)}
                  className="flex-1 bg-muted border border-input rounded-lg px-2 py-1 text-sm text-foreground w-24 focus:outline-none focus:border-blue-500"
                  placeholder={placeholder}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') onSave?.(); if (e.key === 'Escape') onCancelEdit?.(); }}
                />
              )}
              <button onClick={onSave}
                className="px-2 py-1 text-xs font-medium text-green-400 hover:text-green-300 bg-muted/50 hover:bg-muted rounded-lg transition-colors flex-shrink-0">
                Lưu
              </button>
              <button onClick={onCancelEdit}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors flex-shrink-0">
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={onClick || onStartEdit}
              className="text-left mt-0.5 block w-full"
              title={isClickable ? 'Nhấn để chọn' : 'Nhấn để sửa'}
            >
              {value ? (
                <span className={`text-sm ${isClickable ? 'text-blue-400 hover:text-blue-300 cursor-pointer' : 'text-foreground'}`}>
                  {isClickable && value === 'Nam' && '♂ '}
                  {isClickable && value === 'Nữ' && '♀ '}
                  {value}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground italic">{placeholder || 'Chưa cập nhật'}</span>
              )}
            </button>
          )}
        </div>
      </div>
      {!editing && !isClickable && (
        <button onClick={onStartEdit}
          className="text-muted-foreground hover:text-foreground/80 transition-colors flex-shrink-0 ml-2"
          title="Sửa">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── GenderPickerPopup ────────────────────────────────────────────────────────
function GenderPickerPopup({ current, onSelect, onClose }: {
  current: number | null;
  onSelect: (g: number | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => {
      document.addEventListener('mousedown', h);
      document.addEventListener('keydown', k);
    }, 0);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);

  const OPTIONS = [
    { value: null, label: 'Không xác định' },
    { value: 0, label: '♂ Nam' },
    { value: 1, label: '♀ Nữ' },
  ];

  return (
    <div ref={ref}
      className="absolute left-12 bottom-0 bg-card border border-border rounded-xl shadow-2xl z-50 w-44 py-1"
    >
      {OPTIONS.map(opt => (
        <button key={String(opt.value)} onClick={() => onSelect(opt.value)}
          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted ${
            current === opt.value ? 'bg-blue-600/20 text-blue-400' : 'text-foreground'
          }`}
        >
          <span className="text-sm flex-1">{opt.label}</span>
          {current === opt.value && <span className="text-blue-400 text-xs">✓</span>}
        </button>
      ))}
    </div>
  );
}
