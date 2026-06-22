import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore, LabelData } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { UserProfilePopup } from '../common/UserProfilePopup';
import LabelPicker, { ActiveLabels, EditLabelsModal } from './LabelPicker';
import useIsMobile from '@/hooks/useIsMobile';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useChannelCapability } from '@/hooks/useChannelCapability';
import { fetchContactInfo } from '@/hooks/useZaloEvents';
import { extractUserProfile } from '../../../utils/profileUtils';

interface HeaderLocalLabel {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
  sort_order?: number;
  is_active?: number;
}

export default function ChatHeader() {
  const { activeThreadId, activeThreadType, contacts, updateContact } = useChatStore();
  const { activeAccountId, getActiveAccount } = useAccountStore();
  const { showConversationInfo, toggleConversationInfo, searchOpen, toggleSearch, setSearchOpen, setSearchHighlightQuery, showNotification, labels: allLabels, setLabels, groupInfoCache, showGroupBoard, setShowGroupBoard, showIntegrationQuickPanel, toggleIntegrationQuickPanel, showAIQuickPanel, toggleAIQuickPanel, mergedInboxMode, setMobileShowChat } = useAppStore();
  const isMobile = useIsMobile();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [currentResultIdx, setCurrentResultIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [profilePopupPos, setProfilePopupPos] = useState<{ x: number; y: number } | null>(null);
  const [labelsVersion, setLabelsVersion] = useState(0);
  const [labelPickerOpen, setLabelPickerOpen] = useState<{ x: number; y: number } | null>(null);
  const [editLabelsOpen, setEditLabelsOpen] = useState(false);
  const [loadingGroupMsgs, setLoadingGroupMsgs] = useState(false);
  const [aliasRefreshing, setAliasRefreshing] = useState(false);
  const [refreshingFBInfo, setRefreshingFBInfo] = useState(false);
  const [aliasEditOpen, setAliasEditOpen] = useState(false);
  const [aliasEditPos, setAliasEditPos] = useState<{ x: number; y: number } | null>(null);
  const [aliasInputValue, setAliasInputValue] = useState('');
  const [aliasSaving, setAliasSaving] = useState(false);
  const [groupNameEditing, setGroupNameEditing] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [groupNameSaving, setGroupNameSaving] = useState(false);
  const [groupNameEditPos, setGroupNameEditPos] = useState<{ x: number; y: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local labels for the active thread
  const [headerLocalLabels, setHeaderLocalLabels] = useState<HeaderLocalLabel[]>([]);
  const [headerThreadLabelIds, setHeaderThreadLabelIds] = useState<Set<number>>(new Set());

  const loadHeaderLocalLabels = useCallback(async () => {
    if (!activeAccountId || !activeThreadId) {
      setHeaderLocalLabels([]);
      setHeaderThreadLabelIds(new Set());
      return;
    }
    try {
      const [labelsRes, threadRes] = await Promise.all([
        ipc.db?.getLocalLabels({ zaloId: activeAccountId }),
        ipc.db?.getThreadLocalLabels({ zaloId: activeAccountId, threadId: activeThreadId }),
      ]);
      const labels = (labelsRes?.labels || [])
        .filter((l: any) => (l?.is_active ?? 1) === 1)
        .sort((a: any, b: any) => {
          const sa = Number(a?.sort_order ?? 0);
          const sb = Number(b?.sort_order ?? 0);
          if (sa !== sb) return sa - sb;
          return String(a?.name || '').localeCompare(String(b?.name || ''));
        });
      const threadLabels = threadRes?.labels || [];
      setHeaderLocalLabels(labels);
      setHeaderThreadLabelIds(new Set(threadLabels.map((l: any) => Number(l.id))));
    } catch {
      setHeaderLocalLabels([]);
      setHeaderThreadLabelIds(new Set());
    }
  }, [activeAccountId, activeThreadId]);

  useEffect(() => {
    loadHeaderLocalLabels();
  }, [loadHeaderLocalLabels]);

  // Reload when local labels are changed externally (e.g. from MessageInput)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.zaloId || detail.zaloId === activeAccountId) {
        loadHeaderLocalLabels();
      }
    };
    window.addEventListener('local-labels-changed', handler);
    return () => window.removeEventListener('local-labels-changed', handler);
  }, [activeAccountId, loadHeaderLocalLabels]);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setSearchQuery('');
      setSearchResults([]);
      setCurrentResultIdx(0);
    }
  }, [searchOpen]);

  // Reset search when thread changes
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setCurrentResultIdx(0);
  }, [activeThreadId]);


  // ── Auto-fetch user info khi vào hội thoại mới mà chưa có thông tin ──────
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    const isGroupThread = activeThreadType === 1;
    if (isGroupThread) return;

    const storeContacts = useChatStore.getState().contacts[activeAccountId] || [];
    const ct = storeContacts.find((c) => c.contact_id === activeThreadId);
    if (!ct) return;

    const acc = getActiveAccount();
    const channel = ct.channel || acc?.channel || 'zalo';
    // Kiểm tra nếu chưa có tên thật (display_name = contact_id hoặc chỉ toàn số)
    const hasRealName = !!(ct.display_name && ct.display_name !== activeThreadId && !/^\d+$/.test(ct.display_name));
    const hasAvatar = !!ct.avatar_url;
    if (hasRealName && hasAvatar) return; // Đã có đủ thông tin

    if (channel === 'zalo') {
      // Dùng fetchContactInfo đã có cache 7 ngày + xử lý alias
      fetchContactInfo(activeAccountId, activeThreadId).catch(() => {});
    } else if (channel === 'facebook') {
      // Facebook: lấy tên + avatar từ HTML profile
      ipc.fb?.getUserInfoFacebookHtml({ accountId: activeAccountId, userId: activeThreadId })
        .then((res: any) => {
          if (res?.success && (res.name || res.avatarUrl)) {
            const patch: any = { contact_id: activeThreadId, channel: 'facebook' };
            if (res.name) patch.display_name = res.name;
            if (res.avatarUrl) patch.avatar_url = res.avatarUrl;
            updateContact(activeAccountId, patch);
          }
        })
        .catch(() => {});
      // Refresh avatar từ CDN (FB avatar CDN thường hết hạn)
      if (/^\d+$/.test(activeThreadId)) {
        ipc.fb?.refreshContactAvatar({ accountId: activeAccountId, userId: activeThreadId })
          .then((res: any) => {
            if (res?.success && res.avatarUrl) {
              updateContact(activeAccountId, { contact_id: activeThreadId, avatar_url: res.avatarUrl });
            }
          })
          .catch(() => {});
      }
    }
  }, [activeAccountId, activeThreadId, activeThreadType]);

  // ── Tải lại tin nhắn nhóm (getGroupChatHistory) / FB threads ────────────
  const handleReloadGroupMessages = useCallback(async () => {
    if (!activeAccountId || !activeThreadId || loadingGroupMsgs) return;
    const acc = getActiveAccount();
    if (!acc) return;
    const channel = acc.channel || 'zalo';
    setLoadingGroupMsgs(true);
    try {
      if (channel === 'facebook') {
        // FB: refresh threads from Facebook API
        const res = await ipc.fb?.getThreads({ accountId: activeAccountId, forceRefresh: true });
        if (res?.success) {
          const count = res.threads?.length ?? 0;
          showNotification(`Đã tải lại ${count} hội thoại Facebook`, 'success');
          // Reload contacts into store
          const contactsRes = await ipc.db?.getContacts(activeAccountId);
          const contacts: any[] = contactsRes?.contacts ?? contactsRes ?? [];
          if (contacts.length > 0) {
            useChatStore.getState().setContacts(activeAccountId, contacts);
          }
          // Refresh avatar cho Facebook user 1-1 hiện tại (CDN thường hết hn)
          if (activeThreadId && activeThreadType !== 1 && /^\d+$/.test(activeThreadId)) {
            ipc.fb.refreshContactAvatar({ accountId: activeAccountId, userId: activeThreadId })
              .then(refreshRes => {
                if (refreshRes.success && refreshRes.avatarUrl) {
                  useChatStore.getState().updateContact(activeAccountId, {
                    contact_id: activeThreadId,
                    avatar_url: refreshRes.avatarUrl,
                  });
                  // Tải lại contacts vào store
                  ipc.db?.getContacts(activeAccountId).then(cr => {
                    const cl = cr?.contacts ?? cr ?? [];
                    if (cl.length > 0) useChatStore.getState().setContacts(activeAccountId, cl);
                  });
                }
              }).catch(() => {});
          }
        } else {
          showNotification(res?.error || 'Không thể tải hội thoại Facebook', 'error');
        }
      } else {
        // Zalo: reload group chat history
        const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
        const res = await ipc.zalo?.getGroupChatHistory({ auth, groupId: activeThreadId });
        if (res?.success) {
          const count = res?.response?.groupMsgsCount ?? 0;
          showNotification(`Đã tải lại tin nhắn nhóm thành công (${count} tin nhắn)`, 'success');
        } else {
          showNotification(res?.error || 'Không thể tải tin nhắn nhóm', 'error');
        }
      }
    } catch (e: any) {
      showNotification('Lỗi: ' + (e.message || 'Không thể tải lại'), 'error');
    } finally {
      setLoadingGroupMsgs(false);
    }
  }, [activeAccountId, activeThreadId, loadingGroupMsgs, getActiveAccount, showNotification]);

  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    setSearchHighlightQuery(q);
    setCurrentResultIdx(0);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!q.trim()) { setSearchResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      if (!activeAccountId) return;
      setSearching(true);
      try {
        const res = await ipc.db?.searchMessages({ zaloId: activeAccountId, query: q.trim() });
        const all: any[] = res?.results || [];
        // Filter to current thread only
        const filtered = activeThreadId ? all.filter(m => m.thread_id === activeThreadId) : all;
        const results = filtered.slice(0, 50);
        setSearchResults(results);
        // Auto-scroll to first result
        if (results.length > 0) {
          setCurrentResultIdx(0);
          scrollToResult(results[0]);
        }
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 300);
  };

  const scrollToResult = async (msg: any) => {
    if (!msg) return;

    const scrollAndHighlight = (el: HTMLElement) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all');
      setTimeout(() => el.classList.remove('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all'), 2000);
    };

    // 1. Check if already in DOM
    await new Promise(r => setTimeout(r, 50));
    const el = document.getElementById(`msg-${msg.msg_id}`);
    if (el) {
      scrollAndHighlight(el);
      return;
    }

    // 2. Message not in DOM — load messages around its timestamp
    if (!activeAccountId || !activeThreadId || !msg.timestamp) return;
    try {
      const { setMessages } = useChatStore.getState();
      const aroundRes = await ipc.db?.getMessagesAround({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        timestamp: msg.timestamp,
        limit: 80,
      });
      const aroundMsgs = aroundRes?.messages;
      if (!aroundMsgs?.length) return;

      setMessages(activeAccountId, activeThreadId, aroundMsgs);

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
      console.error('[scrollToResult] Failed to load messages around target:', err);
    }
  };

  const navigateResult = (dir: 'next' | 'prev') => {
    if (!searchResults.length) return;
    const next = dir === 'next'
      ? (currentResultIdx + 1) % searchResults.length
      : (currentResultIdx - 1 + searchResults.length) % searchResults.length;
    setCurrentResultIdx(next);
    scrollToResult(searchResults[next]);
  };

  const handleAssignLabel = async (labelId: number) => {
    const acc = getActiveAccount();
    if (!acc || !activeAccountId || !activeThreadId) return;
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
    const currentLabels = allLabels[activeAccountId] || [];

    // Detect if this thread is a group to apply 'g' prefix (consistent with Zalo's label API)
    const contactsForAccount = contacts[activeAccountId] || [];
    const threadContact = contactsForAccount.find(c => c.contact_id === activeThreadId);
    const isGroupThread = activeThreadType === 1 || threadContact?.contact_type === 'group';
    const labelThreadId = isGroupThread ? `g${activeThreadId}` : activeThreadId;

    let freshLabels = currentLabels;
    let freshVersion = labelsVersion;
    try {
      const res = await ipc.zalo?.getLabels({ auth });
      if (res?.response?.labelData) {
        freshLabels = res.response.labelData;
        freshVersion = res.response.version || 0;
        setLabels(activeAccountId, freshLabels);
        setLabelsVersion(freshVersion);
      }
    } catch {}

    const target = freshLabels.find(l => l.id === labelId);
    if (!target) return;
    const alreadyHas = target.conversations.includes(labelThreadId) || target.conversations.includes(activeThreadId);
    const updated = freshLabels.map(l => {
      if (l.id === labelId) {
        const filtered = l.conversations.filter((c: string) => c !== labelThreadId && c !== activeThreadId);
        return { ...l, conversations: alreadyHas ? filtered : [...filtered, labelThreadId] };
      }
      return { ...l, conversations: l.conversations.filter((c: string) => c !== labelThreadId && c !== activeThreadId) };
    });

    let result = await ipc.zalo?.updateLabels({ auth, labelData: updated, version: freshVersion });
    if (!result?.success && result?.error?.includes('Outdated')) {
      try {
        const retried = await ipc.zalo?.getLabels({ auth });
        if (retried?.response?.labelData) {
          freshLabels = retried.response.labelData; freshVersion = retried.response.version || 0;
          const retryTarget = freshLabels.find(l => l.id === labelId);
          const retryAlreadyHas = (retryTarget?.conversations.includes(labelThreadId) || retryTarget?.conversations.includes(activeThreadId)) ?? false;
          const retryUpdated = freshLabels.map(l => {
            if (l.id === labelId) {
              const filtered = l.conversations.filter((c: string) => c !== labelThreadId && c !== activeThreadId);
              return { ...l, conversations: retryAlreadyHas ? filtered : [...filtered, labelThreadId] };
            }
            return { ...l, conversations: l.conversations.filter((c: string) => c !== labelThreadId && c !== activeThreadId) };
          });
          result = await ipc.zalo?.updateLabels({ auth, labelData: retryUpdated, version: freshVersion });
          if (result?.success) {
            setLabels(activeAccountId, retryUpdated); setLabelsVersion(result?.response?.version ?? freshVersion);
            showNotification(retryAlreadyHas ? 'Đã gỡ nhãn' : `Đã gán nhãn "${target.text}"`, 'success');
            // Note: Workflow events are emitted by backend (zaloIpc.ts) to avoid duplicates
            setLabelPickerOpen(null); return;
          }
        }
      } catch {}
    }
    if (!result?.success) { showNotification('Lỗi: ' + (result?.error || 'Không thể cập nhật nhãn'), 'error'); setLabelPickerOpen(null); return; }
    setLabels(activeAccountId, updated); setLabelsVersion(result?.response?.version ?? freshVersion);
    showNotification(alreadyHas ? 'Đã gỡ nhãn' : `Đã gán nhãn "${target.text}"`, 'success');
    // Note: Workflow events are emitted by backend (zaloIpc.ts) to avoid duplicates
    setLabelPickerOpen(null);
  };

  const handleCopyName = () => {
    if (!displayName) return;
    navigator.clipboard.writeText(displayName).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  /** Mở popup sửa tên gợi nhớ */
  const handleOpenAliasEdit = (e: React.MouseEvent) => {
    if (!contact) return;
    setAliasInputValue(contact?.alias || '');
    setAliasEditPos({ x: e.clientX, y: e.clientY });
    setAliasEditOpen(true);
  };

  /** Lưu alias mới qua API Zalo */
  const handleSaveAlias = async () => {
    if (!activeThreadId || !activeAccountId) return;
    const acc = getActiveAccount();
    if (!acc) return;
    setAliasSaving(true);
    try {
      const trimmed = aliasInputValue.trim();
      // Zalo: sync to API. Facebook/kênh khác: save locally only.
      if ((acc.channel || 'zalo') === 'zalo') {
        const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
        const res = await ipc.zalo?.changeFriendAlias({ auth, alias: trimmed, friendId: activeThreadId });
        if (res && !res.success && res.error) {
          showNotification('Lỗi cập nhật biệt danh: ' + res.error, 'error');
          return;
        }
      }
      // Always save alias locally to DB
      updateContact(activeAccountId, { contact_id: activeThreadId, alias: trimmed });
      ipc.db?.setContactAlias({
        zaloId: activeAccountId, contactId: activeThreadId, alias: trimmed,
      }).catch(() => {});
      showNotification('Đã cập nhật tên gợi nhớ', 'success');
      setAliasEditOpen(false);
    } catch (e: any) {
      showNotification('Lỗi: ' + (e.message || 'Không thể sửa tên gợi nhớ'), 'error');
    } finally {
      setAliasSaving(false);
    }
  };

  /** Reload alias + user info từ API Zalo — lưu toàn bộ alias + cập nhật thông tin hội thoại hiện tại */
  const handleRefreshAlias = async () => {
    if (!activeThreadId || !activeAccountId || activeThreadType === 1) return;
    const acc = getActiveAccount();
    if (!acc) return;
    setAliasRefreshing(true);
    try {
      if ((acc.channel || 'zalo') === 'zalo') {
        const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
        // 1. Update toàn bộ alias từ getAliasList (Zalo API)
        const res = await ipc.zalo?.getAliasList({ auth, count: 5000 });
        if (res?.success) {
          const items: { userId: string; alias: string }[] = res?.response?.items || [];
          for (const item of items) {
            if (item.alias && item.userId) {
              updateContact(activeAccountId, { contact_id: item.userId, alias: item.alias });
              ipc.db?.setContactAlias({ zaloId: activeAccountId, contactId: item.userId, alias: item.alias }).catch(() => {});
            }
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
          if (Object.keys(patch).length > 1) {
            updateContact(activeAccountId, patch);
            await ipc.db?.updateContactProfile({
              zaloId: activeAccountId, contactId: activeThreadId,
              displayName: newName, avatarUrl: newAvatar, phone: newPhone,
              gender, birthday,
            });
            if (newAlias) {
              ipc.db?.setContactAlias({ zaloId: activeAccountId, contactId: activeThreadId, alias: newAlias }).catch(() => {});
            }
          }
        }
      } else {
        // Facebook: refresh tên + avatar từ profile HTML
        const fbRes = await ipc.fb?.getUserInfoFacebookHtml({ accountId: activeAccountId, userId: activeThreadId });
        if (fbRes?.success && (fbRes.name || fbRes.avatarUrl)) {
          const patch: any = { contact_id: activeThreadId };
          if (fbRes.name) patch.display_name = fbRes.name;
          if (fbRes.avatarUrl) patch.avatar_url = fbRes.avatarUrl;
          if (Object.keys(patch).length > 1) updateContact(activeAccountId, patch);
        }
        showNotification('Đã cập nhật thông tin từ Facebook', 'success');
      }
    } catch {} finally {
      setAliasRefreshing(false);
    }
  };

  /** Đổi tên nhóm — Zalo: API changeGroupName, Facebook: note local-only */
  const handleOpenGroupNameEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setGroupNameInput(displayName);
    setGroupNameEditing(true);
    setGroupNameEditPos({ x: e.clientX, y: e.clientY });
  };

  const handleSaveGroupName = async () => {
    if (!activeAccountId || !activeThreadId || !isGroup) return;
    const acc = getActiveAccount();
    if (!acc) return;
    const trimmed = groupNameInput.trim();
    if (!trimmed || trimmed === displayName) { setGroupNameEditing(false); return; }
    setGroupNameSaving(true);
    try {
      if ((acc.channel || 'zalo') === 'zalo') {
        const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
        const res = await ipc.zalo?.changeGroupName({ name: trimmed, groupId: activeThreadId });
        if (res && !res.success && res.error) {
          showNotification('Lỗi đổi tên nhóm: ' + res.error, 'error');
          return;
        }
        showNotification('Đã đổi tên nhóm thành công', 'success');
      } else {
        // Facebook / other: chỉ lưu local
        showNotification('Tên nhóm đã được cập nhật (chỉ áp dụng trên app)', 'success');
      }
      // Cập nhật tên hiển thị
      updateContact(activeAccountId, { contact_id: activeThreadId, display_name: trimmed });
      setGroupNameEditing(false);
    } catch (e: any) {
      showNotification('Lỗi: ' + (e.message || 'Không thể đổi tên nhóm'), 'error');
    } finally {
      setGroupNameSaving(false);
    }
  };

  /** Reload thông tin Facebook từ HTML (tên + avatar) — chỉ cho 1-1 */
  const handleRefreshFacebookInfo = async () => {
    if (!activeThreadId || !activeAccountId || isGroup) return;
    const acc = getActiveAccount();
    if (!acc || (acc.channel || 'zalo') !== 'facebook') return;
    setRefreshingFBInfo(true);
    try {
      const res = await ipc.fb?.getUserInfoFacebookHtml({ accountId: activeAccountId, userId: activeThreadId });
      if (res?.success && (res.name || res.avatarUrl)) {
        const patch: any = { contact_id: activeThreadId };
        if (res.name) patch.display_name = res.name;
        if (res.avatarUrl) patch.avatar_url = res.avatarUrl;
        updateContact(activeAccountId, patch);
        showNotification('Đã cập nhật thông tin từ Facebook', 'success');
      } else {
        showNotification(res?.error || 'Không thể lấy thông tin từ Facebook', 'error');
      }
    } catch (e: any) {
      showNotification('Lỗi: ' + (e.message || 'Không thể làm mới'), 'error');
    } finally {
      setRefreshingFBInfo(false);
    }
  };

  const channelCap = useChannelCapability();

  if (!activeThreadId || !activeAccountId) return null;

  const contactList = contacts[activeAccountId] || [];
  const contact = contactList.find((c) => c.contact_id === activeThreadId);
  // Ưu tiên alias → display_name
  const displayName = contact?.alias || contact?.display_name || activeThreadId;
  const avatarUrl = toLocalMediaUrl(contact?.avatar_url || '');
  const isGroup = activeThreadType === 1 || contact?.contact_type === 'group';
  const activeAccount = getActiveAccount();
  const isFacebookDM = !isGroup && activeAccount?.channel === 'facebook';
  const groupInfo = isGroup ? (groupInfoCache[activeAccountId] || {})[activeThreadId] : undefined;

  // Render avatar: group composite or user avatar
  const renderAvatar = () => {
    if (avatarUrl && !avatarFailed) {
      return <img src={avatarUrl} alt={displayName} className={`w-9 h-9 rounded-full object-cover ${!isGroup ? 'hover:ring-2 hover:ring-blue-400 transition-all' : ''}`}
        onError={() => {
          setAvatarFailed(true);
          // Auto-refresh avatar cho Facebook contacts (CDN hết hạn → 403)
          if (activeAccountId && activeThreadId && (/^\d+$/.test(activeThreadId) || contact?.channel === 'facebook')) {
            ipc.fb.refreshContactAvatar({ accountId: activeAccountId, userId: activeThreadId })
              .then(res => {
                if (res.success && res.avatarUrl) {
                  updateContact(activeAccountId, {
                    contact_id: activeThreadId,
                    avatar_url: res.avatarUrl,
                  });
                  setAvatarFailed(false);
                }
              }).catch(() => {});
          }
        }} />;
    }
    if (isGroup) {
      const members = groupInfo?.members?.filter(m => m.avatar).slice(0, 4) || [];
      if (members.length >= 4) {
        return (
          <div className="w-9 h-9 rounded-full overflow-hidden grid grid-cols-2 grid-rows-2 bg-green-700 flex-shrink-0">
            {members.slice(0, 4).map((m, i) => (
              <div key={i} className="overflow-hidden">
                <img src={m.avatar} alt="" className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </div>
            ))}
          </div>
        );
      }
      if (members.length === 3) {
        return (
          <div className="w-9 h-9 rounded-full overflow-hidden flex flex-row bg-green-700 flex-shrink-0">
            <div className="flex-1 h-full overflow-hidden">
              <img src={members[0].avatar} alt="" className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
            <div className="flex-1 h-full flex flex-col overflow-hidden">
              <div className="flex-1 overflow-hidden">
                <img src={members[1].avatar} alt="" className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </div>
              <div className="flex-1 border-t border-gray-900/40 overflow-hidden">
                <img src={members[2].avatar} alt="" className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </div>
            </div>
          </div>
        );
      }
      if (members.length === 2) {
        return (
          <div className="w-9 h-9 rounded-full overflow-hidden flex flex-row bg-green-700 flex-shrink-0">
            <div className="flex-1 h-full overflow-hidden">
              <img src={members[0].avatar} alt="" className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
            <div className="flex-1 h-full border-l border-gray-900/40 overflow-hidden">
              <img src={members[1].avatar} alt="" className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
          </div>
        );
      }
      return (
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold bg-green-600">
          {(displayName || 'G').charAt(0).toUpperCase()}
        </div>
      );
    }
    return (
      <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold bg-blue-600 hover:ring-2 hover:ring-blue-400 transition-all">
        {(displayName || 'U').charAt(0).toUpperCase()}
      </div>
    );
  };

  return (
    <div className="flex flex-col border-b border-gray-700 bg-gray-800 flex-shrink-0">
      {/* Main header row */}
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* Mobile back button — return to conversation list */}
        {isMobile && (
          <button
            onClick={() => setMobileShowChat(false)}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            title="Quay lại"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        )}
        {/* Avatar — click to open profile for user chats */}
        <div
          className="relative flex-shrink-0 cursor-pointer"
          onClick={(e) => {
            if (!isGroup) {
              setProfilePopupPos({ x: e.clientX, y: e.clientY });
              setShowProfile(true);
            }
          }}
          title={isGroup ? '' : 'Xem thông tin'}
        >
          {renderAvatar()}
        </div>

        <div className="flex-1 min-w-0">
          {/* Name row — name + alias reload on the same line */}
          <div className="flex items-center gap-1 min-w-0">
            {/* Name — click to copy */}
            <button
              onClick={handleCopyName}
              title={copied ? 'Đã sao chép!' : 'Nhấn để sao chép tên'}
              className="flex items-center gap-1 group text-left min-w-0 overflow-hidden"
            >
              <p className="text-md font-semibold text-white truncate group-hover:text-blue-300 transition-colors">{displayName}</p>
              {copied
                ? <span className="text-xs text-green-400 flex-shrink-0">✓</span>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-50 flex-shrink-0 transition-opacity">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                  </svg>
              }
            </button>
            {/* Group rename button — chỉ cho nhóm Zalo (có API) */}
            {isGroup && channelCap.supportsGroupRename && (activeAccount?.channel || 'zalo') === 'zalo' && (
              <button
                title="Đổi tên nhóm"
                onClick={(e) => handleOpenGroupNameEdit(e)}
                className="flex-shrink-0 text-gray-400 hover:text-white transition-colors ml-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            )}
            {/* Reload user info + alias button — chỉ hiện cho user DM có hỗ trợ alias */}
            {!isGroup && channelCap.supportsAlias && (activeAccount?.channel || 'zalo') === 'zalo' && (
              <button
                title="Cập nhật thông tin + tên gợi nhớ"
                onClick={handleRefreshAlias}
                disabled={aliasRefreshing}
                className="flex-shrink-0 text-gray-400 hover:text-white transition-colors ml-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={aliasRefreshing ? 'animate-spin' : ''}>
                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                </svg>
              </button>
            )}
            {/* Facebook info reload — chỉ cho FB 1-1 */}
            {isFacebookDM && (
                <button
                    title="Tải lại thông tin từ Facebook"
                    onClick={handleRefreshFacebookInfo}
                    disabled={refreshingFBInfo}
                    className="flex-shrink-0 text-gray-400 hover:text-white transition-colors ml-1.5"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       className={refreshingFBInfo ? 'animate-spin' : ''}>
                    <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                  </svg>
                </button>
            )}
            {/* Edit alias button — sửa tên gợi nhớ (mọi kênh) */}
            {!isGroup && channelCap.supportsAlias && (
              <button
                title={(activeAccount?.channel || 'zalo') === 'zalo' ? 'Sửa tên gợi nhớ (đồng bộ Zalo)' : 'Sửa tên gợi nhớ (lưu local trên app)'}
                onClick={handleOpenAliasEdit}
                className="flex-shrink-0 text-gray-400 hover:text-white transition-colors ml-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            )}
          </div>
          {/* Active labels row — clickable to open label picker */}
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {channelCap.supportsLabel && (
            <ActiveLabels
              labels={allLabels[activeAccountId] || []}
              activeThreadId={activeThreadId}
              isGroup={isGroup}
              maxDisplay={3}
              onClickPill={(e) => { e.stopPropagation(); setLabelPickerOpen({ x: e.clientX, y: e.clientY }); }}
            />
            )}
            {/* Local labels — Pancake-style pills */}
            {(() => {
              const activeLocalLabels = headerLocalLabels.filter(l => headerThreadLabelIds.has(l.id));
              if (activeLocalLabels.length === 0) return null;
              const hasZaloLabels = (allLabels[activeAccountId] || []).some(l => {
                const pid = isGroup ? `g${activeThreadId}` : activeThreadId;
                return l.conversations?.includes(activeThreadId) || l.conversations?.includes(pid);
              });
              return (
                <>
                  {hasZaloLabels && <span className="w-px h-4 bg-gray-600 flex-shrink-0" />}
                  {activeLocalLabels.slice(0, 4).map(label => (
                    <button
                      key={`local-${label.id}`}
                      className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-1 rounded-full leading-none hover:opacity-80 transition-opacity cursor-pointer"
                      style={{ backgroundColor: label.color || '#3b82f6', color: label.text_color || '#ffffff' }}
                      title={`${label.name} — Nhãn Local`}
                    >
                      {label.emoji && <span>{label.emoji}</span>}
                      <span>{label.name}</span>
                    </button>
                  ))}
                  {activeLocalLabels.length > 4 && (
                    <button className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors">
                      +{activeLocalLabels.length - 4}
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Tải lại tin nhắn nhóm */}
          {isGroup && channelCap.supportsGroupReload && (
            <button
              title="Tải lại tin nhắn nhóm (trong phiên này)"
              onClick={handleReloadGroupMessages}
              disabled={loadingGroupMsgs}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${loadingGroupMsgs ? 'text-green-400 bg-gray-700' : 'hover:bg-gray-700 text-gray-400 hover:text-white'}`}
            >
              {loadingGroupMsgs ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              )}
            </button>
          )}
          <button
            title="Tìm kiếm tin nhắn"
            onClick={toggleSearch}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${searchOpen ? 'bg-blue-600 text-white' : 'hover:bg-gray-700 text-gray-400 hover:text-white'}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          {/* Tải tin nhắn cũ từ Facebook API (TẠM THỜI ẨN do API lỗi 500) */}
          {/* Bảng tin nhóm */}
          {isGroup && channelCap.supportsGroupBoard && (
            <button
              title="Bảng tin nhóm"
              onClick={() => setShowGroupBoard(!showGroupBoard)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showGroupBoard ? 'bg-blue-600 text-white' : 'hover:bg-gray-700 text-gray-400 hover:text-white'}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="9" y1="21" x2="9" y2="9"/>
              </svg>
            </button>
          )}
          <button
            title={showAIQuickPanel ? 'Đóng trợ lý AI' : 'Trợ lý AI'}
            onClick={toggleAIQuickPanel}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showAIQuickPanel ? 'bg-purple-600 text-white' : 'hover:bg-gray-700 text-gray-400 hover:text-white'}`}
          >
            🤖
          </button>
          <button
            title={showIntegrationQuickPanel ? 'Đóng tích hợp' : 'Tích hợp nhanh'}
            onClick={toggleIntegrationQuickPanel}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showIntegrationQuickPanel ? 'bg-blue-600 text-white' : 'hover:bg-gray-700 text-gray-400 hover:text-white'}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </button>
          <button
            title={showConversationInfo ? 'Ẩn thông tin' : 'Thông tin hội thoại'}
            onClick={toggleConversationInfo}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showConversationInfo ? 'bg-blue-600 text-white' : 'hover:bg-gray-700 text-gray-400 hover:text-white'}`}
          >
            {/* Panel/sidebar toggle icon — square with right divider, like Zalo */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
          </button>
        </div>
      </div>


      {/* Search bar — Zalo style with navigation */}
      {searchOpen && (
        <div className="px-3 pb-2.5 pt-1 flex items-center gap-2 border-t border-gray-700/50">
          {/* Input */}
          <div className="flex items-center gap-2 flex-1 bg-gray-700 border border-blue-500/60 rounded-full px-3 py-1.5 min-w-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 flex-shrink-0">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={e => handleSearchChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setSearchOpen(false); }
                else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); navigateResult('next'); }
                else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); navigateResult('prev'); }
              }}
              placeholder="Tìm trong hội thoại..."
              className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none min-w-0"
            />
            {searching && (
              <svg className="animate-spin w-3.5 h-3.5 text-gray-400 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            )}
            {searchQuery && !searching && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]); setCurrentResultIdx(0); searchInputRef.current?.focus(); }}
                className="w-4 h-4 rounded-full bg-gray-500 hover:bg-gray-400 flex items-center justify-center flex-shrink-0 transition-colors"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="3">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
          </div>

          {/* Counter + Nav arrows */}
          {searchResults.length > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className="text-xs text-gray-400 whitespace-nowrap tabular-nums">
                {currentResultIdx + 1}/{searchResults.length}
              </span>
              <button
                onClick={() => navigateResult('prev')}
                title="Kết quả trước (Shift+Enter)"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="18 15 12 9 6 15"/>
                </svg>
              </button>
              <button
                onClick={() => navigateResult('next')}
                title="Kết quả tiếp theo (Enter)"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
            </div>
          )}
          {/* No results indicator */}
          {searchQuery.trim() && !searching && searchResults.length === 0 && (
            <span className="text-xs text-gray-500 flex-shrink-0 whitespace-nowrap">Không tìm thấy</span>
          )}

          {/* Close button */}
          <button
            onClick={() => setSearchOpen(false)}
            className="text-sm text-blue-400 hover:text-blue-300 flex-shrink-0 font-medium transition-colors"
          >
            Đóng
          </button>
        </div>
      )}


      {/* User Profile Popup */}
      {showProfile && contact && profilePopupPos && activeAccountId && (
        <UserProfilePopup
          userId={contact.contact_id}
          anchorX={profilePopupPos.x}
          anchorY={profilePopupPos.y}
          contacts={contactList}
          activeAccountId={activeAccountId}
          activeThreadId={activeThreadId}
          onClose={() => { setShowProfile(false); setProfilePopupPos(null); }}
        />
      )}

      {/* Label picker popup */}
      {labelPickerOpen && activeAccountId && activeThreadId && (allLabels[activeAccountId] || []).length > 0 && (
        <HeaderLabelPickerPopup
          contactId={activeThreadId}
          isGroup={isGroup}
          x={labelPickerOpen.x}
          y={labelPickerOpen.y}
          labels={allLabels[activeAccountId] || []}
          onAssign={handleAssignLabel}
          onClose={() => setLabelPickerOpen(null)}
          onEditLabels={() => { setLabelPickerOpen(null); setEditLabelsOpen(true); }}
        />
      )}
      {editLabelsOpen && activeAccountId && (
        <EditLabelsModal
          labels={allLabels[activeAccountId] || []}
          labelsVersion={labelsVersion}
          onClose={() => setEditLabelsOpen(false)}
          onSave={(newLabels, newVersion) => {
            setLabels(activeAccountId, newLabels);
            setLabelsVersion(newVersion);
          }}
        />
      )}

      {/* Group name edit popup — đổi tên nhóm */}
      {groupNameEditing && groupNameEditPos && isGroup && (
        <AliasEditPopup
          title="Đổi tên nhóm"
          placeholder="Nhập tên nhóm mới..."
          value={groupNameInput}
          onChange={setGroupNameInput}
          saving={groupNameSaving}
          onSave={handleSaveGroupName}
          onClose={() => setGroupNameEditing(false)}
          anchorX={groupNameEditPos.x}
          anchorY={groupNameEditPos.y}
        />
      )}

      {/* Alias edit popup — sửa tên gợi nhớ */}
      {aliasEditOpen && aliasEditPos && contact && (
        <AliasEditPopup
          value={aliasInputValue}
          onChange={setAliasInputValue}
          saving={aliasSaving}
          onSave={handleSaveAlias}
          onClose={() => setAliasEditOpen(false)}
          anchorX={aliasEditPos.x}
          anchorY={aliasEditPos.y}
        />
      )}
    </div>
  );
}


// ─── HeaderLabelPickerPopup ───────────────────────────────────────────────────
function HeaderLabelPickerPopup({ contactId, isGroup, x, y, labels, onAssign, onClose, onEditLabels }: {
  contactId: string;
  isGroup: boolean;
  x: number;
  y: number;
  labels: LabelData[];
  onAssign: (labelId: number) => void;
  onClose: () => void;
  onEditLabels: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { activeAccountId } = useAccountStore();
  const { setLabels, showNotification } = useAppStore();
  const [labelsVersion, setLabelsVersion] = React.useState(0);
  const [syncingLabels, setSyncingLabels] = React.useState(false);

  React.useEffect(() => {
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

  const top = Math.min(y + 6, window.innerHeight - (labels.length * 34 + 120));
  const left = Math.min(x, window.innerWidth - 210);

  return (
    <div
      ref={ref}
      className="fixed z-[300] bg-gray-800 border border-gray-700 rounded-xl shadow-2xl min-w-[190px]"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
    >
      <LabelPicker
        labels={labels}
        activeThreadId={contactId}
        isGroup={isGroup}
        onToggleLabel={(label) => onAssign(label.id)}
        onEditLabels={onEditLabels}
        onSync={async () => {
          if (!activeAccountId || syncingLabels) return;
          setSyncingLabels(true);
          try {
            const acc = useAccountStore.getState().getActiveAccount();
            if (!acc) return;
            const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
            const res = await ipc.zalo?.getLabels({ auth });
            if (res?.response?.labelData) {
              setLabels(activeAccountId, res.response.labelData);
              setLabelsVersion(res.response.version || 0);
              showNotification('Đã cập nhật danh sách nhãn', 'success');
            }
          } catch { showNotification('Lỗi cập nhật nhãn', 'error'); }
          finally { setSyncingLabels(false); }
        }}
        syncingLabels={syncingLabels}
      />
    </div>
  );
}

// ─── AliasEditPopup ───────────────────────────────────────────────────────────
function AliasEditPopup({ value, onChange, saving, onSave, onClose, anchorX, anchorY, title, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
  anchorX: number;
  anchorY: number;
  title?: string;
  placeholder?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
      document.addEventListener('keydown', keyHandler);
      inputRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  const top = Math.min(anchorY + 6, window.innerHeight - 140);
  const left = Math.min(anchorX, window.innerWidth - 240);

  return (
    <div
      ref={ref}
      className="fixed z-[300] bg-gray-800 border border-gray-700 rounded-xl shadow-2xl min-w-[220px] p-3"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="text-xs text-gray-400 font-medium mb-2">{title || 'Sửa tên gợi nhớ'}</div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 mb-2"
        placeholder={placeholder || 'Nhập tên gợi nhớ...'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
        >
          Huỷ
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1"
        >
          {saving && (
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          )}
          Lưu
        </button>
      </div>
    </div>
  );
}

