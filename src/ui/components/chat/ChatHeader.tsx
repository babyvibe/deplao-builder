import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore, LabelData } from '@/store/appStore';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/useEmployeeResync';
import {
  EMPTY_THREAD_LOCAL_LABELS, nextThreadLocalLabels, sortActiveLocalLabels, threadLabelsKey, toLabelIdSet,
  type ThreadLocalLabelsState,
} from '@/lib/chat/chatLoadFailures';
import { THREAD_LABELS_CHANGED_EVENT, threadLabelsEventTouches } from '@/lib/chat/relayUiEvents';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { UserProfilePopup } from '../common/UserProfilePopup';
import LabelPicker, { ActiveLabels, EditLabelsModal } from './LabelPicker';
import useIsMobile from '@/hooks/useIsMobile';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useChannelCapability } from '@/hooks/useChannelCapability';
import { fetchContactInfo } from '@/hooks/useZaloEvents';
import { extractUserProfile } from '../../../utils/profileUtils';
import { fetchAllAliases } from '@/lib/zaloAliasUtils';
import { Spinner } from '@/components/common/PageLoading';
import { BotIcon, CloudIcon, RefreshIcon } from '@/components/common/icons';
import { MY_DOCUMENTS_NAME, isMyDocumentsThread } from '@/lib/chat/myDocuments';
import { PluginPanelToggle } from '@/components/plugins/PluginChatPanel';
import { CHANNEL, isZalo, isFacebook, isTelegram, isTelegramUser } from '@/lib/channelHelper';
import PeerInitials from '@/components/common/PeerInitials';

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
  // Selector: không render lại header với mọi tin nhắn / đang gõ / đã xem của các hội thoại khác
  const { activeThreadId, activeThreadType, contacts, updateContact } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, activeThreadType: s.activeThreadType, contacts: s.contacts, updateContact: s.updateContact,
  })));
  // getActiveAccount() đọc accounts → chọn kèm để vẫn cập nhật khi tài khoản đổi
  const { activeAccountId, getActiveAccount } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, getActiveAccount: s.getActiveAccount, accounts: s.accounts,
  })));
  const { showConversationInfo, toggleConversationInfo, searchOpen, toggleSearch, setSearchOpen, setSearchHighlightQuery, showNotification, labels: allLabels, setLabels, groupInfoCache, showGroupBoard, setShowGroupBoard, showIntegrationQuickPanel, toggleIntegrationQuickPanel, showAIQuickPanel, toggleAIQuickPanel, mergedInboxMode, setMobileShowChat } = useAppStore(useShallow(s => ({
    showConversationInfo: s.showConversationInfo, toggleConversationInfo: s.toggleConversationInfo, searchOpen: s.searchOpen,
    toggleSearch: s.toggleSearch, setSearchOpen: s.setSearchOpen, setSearchHighlightQuery: s.setSearchHighlightQuery,
    showNotification: s.showNotification, labels: s.labels, setLabels: s.setLabels, groupInfoCache: s.groupInfoCache,
    showGroupBoard: s.showGroupBoard, setShowGroupBoard: s.setShowGroupBoard, showIntegrationQuickPanel: s.showIntegrationQuickPanel,
    toggleIntegrationQuickPanel: s.toggleIntegrationQuickPanel, showAIQuickPanel: s.showAIQuickPanel,
    toggleAIQuickPanel: s.toggleAIQuickPanel, mergedInboxMode: s.mergedInboxMode, setMobileShowChat: s.setMobileShowChat,
  })));
  const isMobile = useIsMobile();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [currentResultIdx, setCurrentResultIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [profilePopupPos, setProfilePopupPos] = useState<{ x: number; y: number } | null>(null);
  const [labelsVersion, setLabelsVersion] = useState(0);
  const [labelPickerOpen, setLabelPickerOpen] = useState<{ x: number; y: number } | null>(null);
  const [editLabelsOpen, setEditLabelsOpen] = useState(false);
  const [aliasRefreshing, setAliasRefreshing] = useState(false);
  const [refreshingFBInfo, setRefreshingFBInfo] = useState(false);
  const [refreshingTelegram, setRefreshingTelegram] = useState(false);
  const [aliasEditOpen, setAliasEditOpen] = useState(false);
  const [aliasEditPos, setAliasEditPos] = useState<{ x: number; y: number } | null>(null);
  const [aliasInputValue, setAliasInputValue] = useState('');
  const [aliasSaving, setAliasSaving] = useState(false);
  const [groupNameEditing, setGroupNameEditing] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [groupNameSaving, setGroupNameSaving] = useState(false);
  // Telegram message download dialog
  const [tgDownloadOpen, setTgDownloadOpen] = useState(false);
  const [tgDownloadCount, setTgDownloadCount] = useState('200');
  const [tgDownloading, setTgDownloading] = useState(false);
  const [groupNameEditPos, setGroupNameEditPos] = useState<{ x: number; y: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local labels for the active thread. Lần đọc lỗi (chế độ nhân viên: mất kết nối BOSS) giữ nhãn đang có của đúng
  // tài khoản / hội thoại (không thay bằng rỗng) và hiện "Thử lại" gọn trên hàng nhãn.
  const [headerLabelState, setHeaderLabelState] = useState<ThreadLocalLabelsState<HeaderLocalLabel>>(EMPTY_THREAD_LOCAL_LABELS);
  const headerLocalLabels = headerLabelState.labels;
  const headerThreadLabelIds = headerLabelState.threadLabelIds;
  // Hội thoại đang mở: phản hồi muộn của hội thoại trước không được ghi đè nhãn của hội thoại này
  const headerLabelOwnerRef = useRef('');
  headerLabelOwnerRef.current = activeAccountId && activeThreadId ? threadLabelsKey(activeAccountId, activeThreadId) : '';

  const loadHeaderLocalLabels = useCallback(async () => {
    if (!activeAccountId || !activeThreadId) {
      setHeaderLabelState(EMPTY_THREAD_LOCAL_LABELS);
      return;
    }
    const accountId = activeAccountId;
    const threadId = activeThreadId;
    const [labelsRes, threadRes] = await Promise.all([
      DataAccessor.getLocalLabels({ zaloId: accountId }).catch(() => null),
      DataAccessor.getThreadLocalLabels({ zaloId: accountId, threadId }).catch(() => null),
    ]);
    if (headerLabelOwnerRef.current !== threadLabelsKey(accountId, threadId)) return;
    const labelsOk = !!labelsRes && !isReadFailure(labelsRes);
    const threadOk = !!threadRes && !isReadFailure(threadRes);
    if (!labelsOk || !threadOk) {
      console.warn('[ChatHeader] Không tải được Nhãn Local:', readFailureMessage(labelsOk ? threadRes : labelsRes) || 'lỗi không rõ');
    }
    setHeaderLabelState(prev => nextThreadLocalLabels(
      prev, accountId, threadId,
      labelsOk ? sortActiveLocalLabels<HeaderLocalLabel>(labelsRes?.labels) : null,
      threadOk ? toLabelIdSet(threadRes?.labels) : null,
    ));
  }, [activeAccountId, activeThreadId]);

  useEffect(() => {
    loadHeaderLocalLabels();
  }, [loadHeaderLocalLabels]);

  // Chế độ nhân viên: kết nối BOSS phục hồi → tải lại Nhãn Local của hội thoại đang mở
  useEmployeeResync(loadHeaderLocalLabels);

  // Reload when local labels are changed externally (e.g. from MessageInput) — và khi Boss / nhân viên khác gán / bỏ
  // nhãn của hội thoại đang mở (relay db:localLabelThreadChanged → 'ui:threadLabelsChanged')
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.zaloId || detail.zaloId === activeAccountId) {
        loadHeaderLocalLabels();
      }
    };
    const handleThreadLabels = (e: Event) => {
      if (threadLabelsEventTouches((e as CustomEvent).detail, activeAccountId, activeThreadId)) loadHeaderLocalLabels();
    };
    window.addEventListener('local-labels-changed', handler);
    window.addEventListener(THREAD_LABELS_CHANGED_EVENT, handleThreadLabels);
    return () => {
      window.removeEventListener('local-labels-changed', handler);
      window.removeEventListener(THREAD_LABELS_CHANGED_EVENT, handleThreadLabels);
    };
  }, [activeAccountId, activeThreadId, loadHeaderLocalLabels]);

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

    const storeContacts = useChatStore.getState().contacts[activeAccountId] || [];
    const ct = storeContacts.find((c) => c.contact_id === activeThreadId);
    if (!ct) return;

    const acc = getActiveAccount();
    const channel = ct.channel || acc?.channel || CHANNEL.ZALO;
    // Kiểm tra nếu chưa có tên thật (display_name = contact_id hoặc chỉ toàn số)
    const hasRealName = !!(ct.display_name && ct.display_name !== activeThreadId && !/^\d+$/.test(ct.display_name));
    const hasAvatar = !!ct.avatar_url;
    const isBotUnknown = ct.is_cov_bot == null; // null = chưa load, 0/1 = đã load
    if (isGroupThread) {
      if (isTelegram(channel)) {
        import('@/lib/adapters/registry').then(({ getAdapter }) =>
          (getAdapter(channel as any) as any).getGroupInfo?.({ accountId: activeAccountId, threadId: activeThreadId })
        ).then((res: any) => {
          if (!res?.success || !res?.info) return;
          const avatarUrl = res?.info?.avatarUrl || '';
          const entity = res.info.entity || {};
          const current = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
          const memberCount = Number(res.info.memberCount || res.info.full?.participantsCount || entity.participantsCount || 0);
          const onlineCount = Number(res.info.onlineCount || res.info.full?.onlineCount || 0);
          const name = entity.title || ct.display_name || activeThreadId;
          updateContact(activeAccountId, {
            contact_id: activeThreadId, display_name: name,
            ...(avatarUrl ? { avatar_url: avatarUrl } : {}), contact_type: 'group',
            telegram_peer_type: res.info.peerType || '', telegram_members_count: memberCount,
            telegram_online_count: onlineCount, telegram_can_send: res.info.canSend === false ? 0 : 1,
            telegram_send_reason: res.info.sendReason || '', telegram_state_updated_at: Date.now(),
            telegram_membership_state: res.info.membershipState || 'member',
            telegram_join_action: res.info.joinAction || 'none',
          });
          useAppStore.getState().setGroupInfo(activeAccountId, activeThreadId, {
            groupId: activeThreadId, name, avatar: avatarUrl || current?.avatar || ct.avatar_url || '',
            memberCount: memberCount || current?.memberCount || current?.members?.length || 0,
            onlineCount, members: current?.members || [], fetchedAt: Date.now(),
            peerType: res.info.peerType, canSend: res.info.canSend, sendReason: res.info.sendReason,
            membershipState: res.info.membershipState, joinAction: res.info.joinAction,
            canManageTopics: res.info.canManageTopics,
            creatorId: current?.creatorId, adminIds: current?.adminIds, settings: current?.settings,
          });
        }).catch(() => {});
      }
      return;
    }
    // Telegram user: nếu is_cov_bot chưa biết (null) → phải fetch profile để xác định
    const isTelegramUserDM = !isGroupThread && isTelegram(channel);
    if (hasRealName && hasAvatar && !(isTelegramUserDM && isBotUnknown)) return;

    if (isZalo(channel)) {
      // Dùng fetchContactInfo đã có cache 7 ngày + xử lý alias
      fetchContactInfo(activeAccountId, activeThreadId).catch(() => {});
    } else if (isFacebook(channel)) {
      // Facebook: lấy tên + avatar từ HTML profile
      ipc.fb?.getUserInfoFacebook({ accountId: activeAccountId, userId: activeThreadId })
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
    } else if (isTelegram(channel)) {
      ipc.telegramUser?.getUserProfile({ accountId: activeAccountId, userId: activeThreadId })
        .then((res: any) => {
          const profile = res?.profile;
          if (!res?.success || !profile) return;
          const name = profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.username || activeThreadId;
          const ct = useChatStore.getState().contacts[activeAccountId]?.find((c: any) => c.contact_id === activeThreadId);
          updateContact(activeAccountId, {
            contact_id: activeThreadId, display_name: name,
            ...(profile.avatarUrl ? { avatar_url: profile.avatarUrl } : {}),
            ...(profile.phone ? { phone: profile.phone } : {}), channel: 'telegram_user',
            is_cov_bot: profile.isBot ? 1 : 0,
            ...(profile.menuButton ? { menu_button: JSON.stringify(profile.menuButton) } : {}),
            // Only set has_main_app if not already set (prevent overwrite)
            ...((ct?.has_main_app == null) ? (profile.hasMainApp ? { has_main_app: 1 } : { has_main_app: 0 }) : {}),
          });
          DataAccessor.updateContactProfile({
            zaloId: activeAccountId, contactId: activeThreadId, displayName: name,
            avatarUrl: profile.avatarUrl || '', phone: profile.phone || '', contactType: 'user',
            isBot: profile.isBot ? 1 : 0,
          }).catch(() => {});
        }).catch(() => {});
    }
  }, [activeAccountId, activeThreadId, activeThreadType]);


  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    setSearchHighlightQuery(q);
    setCurrentResultIdx(0);
    setSearchFailed(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!q.trim()) { setSearchResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      if (!activeAccountId) return;
      setSearching(true);
      try {
        const res = await DataAccessor.searchMessages({ zaloId: activeAccountId, query: q.trim() });
        // Đọc lỗi (chế độ nhân viên: mất kết nối BOSS) ≠ "Không tìm thấy": báo "Không tìm được · Thử lại"
        if (isReadFailure(res)) {
          console.warn('[ChatHeader] Không tìm được tin nhắn:', readFailureMessage(res));
          setSearchResults([]);
          setSearchFailed(true);
          return;
        }
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
      } catch { setSearchResults([]); setSearchFailed(true); }
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

    // 2. Message not in DOM - load messages around its timestamp
    if (!activeAccountId || !activeThreadId || !msg.timestamp) return;
    try {
      const { setMessages } = useChatStore.getState();
      const aroundRes = await DataAccessor.getMessagesAround({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        timestamp: Number(msg.timestamp),
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
    const auth = buildZaloAuth(acc, activeAccountId);
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

  /** Mở popup sửa tên gợi nhớ - pre-fill tên hiện tại giống Zalo PC */
  const handleOpenAliasEdit = (e: React.MouseEvent) => {
    if (!contact) return;
    setAliasInputValue(displayName);
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
      if (isZalo(acc.channel)) {
        const auth = buildZaloAuth(acc, activeAccountId);
        const res = await ipc.zalo?.changeFriendAlias({ auth, alias: trimmed, friendId: activeThreadId });
        if (res && !res.success && res.error) {
          showNotification('Lỗi cập nhật biệt danh: ' + res.error, 'error');
          return;
        }
      }
      // Always save alias locally to DB
      updateContact(activeAccountId, { contact_id: activeThreadId, alias: trimmed });
      DataAccessor.setContactAlias({
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

  /** Tải tin nhắn từ Telegram API */
  const handleTgDownload = async () => {
    if (!activeAccountId || !activeThreadId) return;
    const requestedLimit = parseInt(tgDownloadCount, 10);
    if (isNaN(requestedLimit) || requestedLimit <= 0) return;
    const limit = Math.min(requestedLimit, 5000);
    if (requestedLimit > limit) {
      showNotification('Mỗi lần chỉ có thể tải tối đa 5.000 tin nhắn Telegram.', 'info');
    }
    setTgDownloading(true);
    showNotification(`Đang tải ${limit} tin nhắn từ Telegram...`, 'info');
    try {
      const res = await ipc.telegramUser?.getMessages({
        accountId: activeAccountId,
        chatId: activeThreadId,
        limit,
        // The importer persists messages in the main process. Do not copy the
        // complete imported history through IPC just to show the newest page.
        returnMessages: false,
      });
      const downloadedCount = Number(res?.count || 0);
      if (res?.success && downloadedCount > 0) {
        // Keep the renderer bounded even when the user imports thousands of rows.
        const dbRes = await DataAccessor.getMessages({ zaloId: activeAccountId, threadId: activeThreadId, limit: 200, offset: 0 });
        if (dbRes?.messages?.length) {
          useChatStore.getState().setMessages(activeAccountId, activeThreadId, [...dbRes.messages].reverse());

          // Update contact last_message/last_message_time from the newest message
          const newest = dbRes.messages[0]; // Already sorted desc from DB
          if (newest) {
            const content = newest.content || '';
            const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;
            useChatStore.getState().updateContact(activeAccountId, {
              contact_id: activeThreadId,
              last_message: preview,
              last_message_time: newest.timestamp || Date.now(),
            });
          }
        }
        showNotification(`Đã tải ${downloadedCount} tin nhắn`, 'success');
      } else {
        // Skip noisy Telegram errors — CHANNEL_PRIVATE is expected for restricted channels
        const err = res?.error || '';
        if (err.includes('CHANNEL_PRIVATE') || err.includes('USER_BANNED_IN_CHANNEL')) {
          showNotification('Kênh này không cho phép tải tin nhắn cũ', 'info');
        } else {
          showNotification(err || 'Không có tin nhắn mới', 'info');
        }
      }
    } catch (err: any) {
      showNotification(err?.message || 'Lỗi tải tin nhắn', 'error');
    } finally {
      setTgDownloading(false);
      setTgDownloadOpen(false);
    }
  };

  /** Reload alias + user info từ API Zalo - lưu toàn bộ alias + cập nhật thông tin hội thoại hiện tại */
  const handleRefreshAlias = async () => {
    if (!activeThreadId || !activeAccountId || activeThreadType === 1) return;
    const acc = getActiveAccount();
    if (!acc) return;
    setAliasRefreshing(true);
    try {
      if (isZalo(acc.channel)) {
        const auth = buildZaloAuth(acc, activeAccountId);
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
        // Facebook: refresh tên + avatar từ profile HTML
        const fbRes = await ipc.fb?.getUserInfoFacebook({ accountId: activeAccountId, userId: activeThreadId });
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

  /** Đổi tên nhóm - Zalo: API changeGroupName, Facebook: note local-only */
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
      if (isZalo(acc.channel)) {
        const auth = buildZaloAuth(acc, activeAccountId);
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

  /** Reload thông tin Facebook từ HTML (tên + avatar) - chỉ cho 1-1 */
  const handleRefreshFacebookInfo = async () => {
    if (!activeThreadId || !activeAccountId || isGroup) return;
    const acc = getActiveAccount();
    if (!acc || (acc.channel || CHANNEL.ZALO) !== 'facebook') return;
    setRefreshingFBInfo(true);
    try {
      const res = await ipc.fb?.getUserInfoFacebook({ accountId: activeAccountId, userId: activeThreadId });
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
  const activeAccount = getActiveAccount();
  // Zalo "My Documents": hội thoại có sẵn của Zalo (ID = send2me_id của phiên, không phải UID của mình)
  const isMyDocs = isMyDocumentsThread(activeAccount, activeThreadId, contact?.avatar_url);
  // Ưu tiên alias → display_name
  const displayName = contact?.alias || contact?.display_name || (isMyDocs ? MY_DOCUMENTS_NAME : activeThreadId);
  const avatarUrl = toLocalMediaUrl(contact?.avatar_url || '');
  const isGroup = activeThreadType === 1 || contact?.contact_type === 'group';
  const isFacebookDM = !isGroup && isFacebook(activeAccount?.channel);
  const groupInfo = isGroup ? (groupInfoCache[activeAccountId] || {})[activeThreadId] : undefined;
  const isTelegramGroup = isGroup && isTelegram(contact?.channel || activeAccount?.channel);
  const telegramMemberCount = Number(groupInfo?.memberCount || contact?.telegram_members_count || 0);
  const telegramOnlineCount = Number(groupInfo?.onlineCount || contact?.telegram_online_count || 0);
  const telegramAudienceLabel = (groupInfo?.peerType || contact?.telegram_peer_type) === 'channel'
    ? 'subscribers'
    : 'members';

  const openTelegramMembers = () => {
    if (!showConversationInfo) toggleConversationInfo();
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('telegram:open-group-members', {
      detail: { accountId: activeAccountId, chatId: activeThreadId },
    })), 50);
  };

  // Render avatar: group composite or user avatar
  const renderAvatar = () => {
    // My Documents: ảnh thư mục của Zalo; chỉ dùng biểu tượng đám mây khi thiếu / lỗi ảnh
    if (isMyDocs && (!avatarUrl || avatarFailed)) {
      return (
        <div className="w-9 h-9 rounded-full flex items-center justify-center bg-gradient-to-br from-sky-400 to-blue-600" style={{ color: '#fff' }}>
          <CloudIcon className="w-5 h-5" />
        </div>
      );
    }
    if (avatarUrl && !avatarFailed) {
      return <img src={avatarUrl} alt={displayName} className={`w-9 h-9 rounded-full object-cover ${!isGroup ? 'hover:ring-2 hover:ring-blue-400 transition-all' : ''}`}
        onError={() => {
          setAvatarFailed(true);
          // Retry avatar cho cả Zalo + Facebook
          if (activeAccountId && activeThreadId) {
            import('@/lib/avatarRetry').then(({ handleAvatarError }) =>
              handleAvatarError({ ownerId: activeAccountId, contactId: activeThreadId, channel: contact?.channel || CHANNEL.ZALO })
            ).then(newUrl => {
              if (newUrl) {
                updateContact(activeAccountId!, { contact_id: activeThreadId, avatar_url: newUrl });
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
              <div className="flex-1 border-t border-border/40 overflow-hidden">
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
            <div className="flex-1 h-full border-l border-border/40 overflow-hidden">
              <img src={members[1].avatar} alt="" className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
          </div>
        );
      }
      return (
        <PeerInitials id={activeThreadId} name={displayName} fallback="G" className="w-9 h-9 text-xs" />
      );
    }
    return (
      <PeerInitials id={activeThreadId} name={displayName} fallback="U" className="w-9 h-9 text-xs hover:ring-2 hover:ring-blue-400 transition-all" />
    );
  };

  return (
    <div className="flex flex-col border-b border-border bg-card flex-shrink-0">
      {/* Main header row */}
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* Mobile back button - return to conversation list */}
        {isMobile && (
          <button
            onClick={() => setMobileShowChat(false)}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Quay lại"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        )}
        {/* Avatar - click to open profile for user chats */}
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
          {/* Name row - name + alias reload on the same line */}
          <div className="flex items-center gap-1 min-w-0">
            {/* Name - click to copy */}
            <button
              onClick={handleCopyName}
              title={copied ? 'Đã sao chép!' : 'Nhấn để sao chép tên'}
              className="flex items-center gap-1 group text-left min-w-0 overflow-hidden"
            >
              <p className="text-md font-semibold text-foreground truncate group-hover:text-blue-300 transition-colors">{displayName}</p>
              {copied
                ? <span className="text-xs text-green-400 flex-shrink-0">✓</span>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-50 flex-shrink-0 transition-opacity">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                  </svg>
              }
            </button>
            {/* Group rename button - chỉ cho nhóm Zalo (có API) */}
            {isGroup && channelCap.supportsGroupRename && isZalo(activeAccount?.channel) && (
              <button
                title="Đổi tên nhóm"
                onClick={(e) => handleOpenGroupNameEdit(e)}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors ml-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            )}
            {/* Reload user info + alias button - chỉ hiện cho user DM có hỗ trợ alias */}
            {!isGroup && channelCap.supportsAlias && isZalo(activeAccount?.channel) && (
              <button
                title="Cập nhật thông tin + tên gợi nhớ"
                onClick={handleRefreshAlias}
                disabled={aliasRefreshing}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors ml-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={aliasRefreshing ? 'animate-spin' : ''}>
                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                </svg>
              </button>
            )}
            {/* Facebook info reload - chỉ cho FB 1-1 */}
            {isFacebookDM && (
                <button
                    title="Tải lại thông tin từ Facebook"
                    onClick={handleRefreshFacebookInfo}
                    disabled={refreshingFBInfo}
                    className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors ml-1.5"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       className={refreshingFBInfo ? 'animate-spin' : ''}>
                    <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                  </svg>
                </button>
            )}
            {/* Edit alias button - sửa tên gợi nhớ (mọi kênh) */}
            {!isGroup && channelCap.supportsAlias && (
              <button
                title={isZalo(activeAccount?.channel) ? 'Sửa tên gợi nhớ (đồng bộ Zalo)' : 'Sửa tên gợi nhớ (lưu local trên app)'}
                onClick={handleOpenAliasEdit}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors ml-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            )}
          </div>
          {isTelegramGroup && (telegramMemberCount > 0 || telegramOnlineCount > 0) && (
            <button
              type="button"
              onClick={openTelegramMembers}
              className="mt-0.5 text-[11px] text-muted-foreground hover:text-blue-300 transition-colors text-left"
              title="Xem danh sách thành viên"
            >
              {telegramMemberCount > 0 && `${telegramMemberCount.toLocaleString()} ${telegramAudienceLabel}`}
              {telegramMemberCount > 0 && telegramOnlineCount > 0 && ' · '}
              {telegramOnlineCount > 0 && `${telegramOnlineCount.toLocaleString()} online`}
            </button>
          )}
          {/* Active labels row - clickable to open label picker */}
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
            {/* Local labels - Pancake-style pills */}
            {(() => {
              const activeLocalLabels = headerLocalLabels.filter(l => headerThreadLabelIds.has(l.id));
              if (activeLocalLabels.length === 0) {
                // Đọc lỗi (chế độ nhân viên) và chưa biết nhãn nào: "Thử lại" gọn thay vì trông như không có nhãn
                if (!headerLabelState.failed) return null;
                return (
                  <button
                    type="button"
                    onClick={() => { void loadHeaderLocalLabels(); }}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    title="Không tải được Nhãn Local — bấm để thử lại"
                  >
                    <RefreshIcon className="w-3 h-3" />
                    <span>Nhãn Local: Thử lại</span>
                  </button>
                );
              }
              const hasZaloLabels = (allLabels[activeAccountId] || []).some(l => {
                const pid = isGroup ? `g${activeThreadId}` : activeThreadId;
                return l.conversations?.includes(activeThreadId) || l.conversations?.includes(pid);
              });
              return (
                <>
                  {hasZaloLabels && <span className="w-px h-4 bg-accent flex-shrink-0" />}
                  {activeLocalLabels.slice(0, 4).map(label => (
                    <button
                      key={`local-${label.id}`}
                      className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-1 rounded-full leading-none hover:opacity-80 transition-opacity cursor-pointer"
                      style={{ backgroundColor: label.color || '#3b82f6', color: label.text_color || '#ffffff' }}
                      title={`${label.name} - Nhãn Local`}
                    >
                      {label.emoji && <span>{label.emoji}</span>}
                      <span>{label.name}</span>
                    </button>
                  ))}
                  {activeLocalLabels.length > 4 && (
                    <button className="text-[11px] text-muted-foreground hover:text-foreground/80 transition-colors">
                      +{activeLocalLabels.length - 4}
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            title="Tìm kiếm tin nhắn"
            onClick={toggleSearch}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${searchOpen ? 'bg-blue-600 text-white' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          {/* Tải tin nhắn từ Telegram API */}
          {isTelegramUser(contact?.channel) && (
            <div className="relative group">
              <button
                title="Tải tin nhắn từ Telegram"
                onClick={() => setTgDownloadOpen(true)}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
            </div>
          )}
          {/* Bảng tin nhóm */}
          {isGroup && channelCap.supportsGroupBoard && (
            <button
              title="Bảng tin nhóm"
              onClick={() => setShowGroupBoard(!showGroupBoard)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showGroupBoard ? 'bg-blue-600 text-white' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="9" y1="21" x2="9" y2="9"/>
              </svg>
            </button>
          )}
          <button
            title={showAIQuickPanel ? 'Đóng trợ lý AI' : 'Trợ lý AI'}
            onClick={toggleAIQuickPanel}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showAIQuickPanel ? 'bg-purple-600 text-white' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}
          ><BotIcon className="w-5 h-5 inline" /> </button>
          <button
            title={showIntegrationQuickPanel ? 'Đóng tích hợp' : 'Tích hợp nhanh'}
            onClick={toggleIntegrationQuickPanel}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showIntegrationQuickPanel ? 'bg-blue-600 text-white' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </button>
          <PluginPanelToggle />
          <button
            title={showConversationInfo ? 'Ẩn thông tin' : 'Thông tin hội thoại'}
            onClick={toggleConversationInfo}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showConversationInfo ? 'bg-blue-600 text-white' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}
          >
            {/* Panel/sidebar toggle icon - square with right divider, like Zalo */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
          </button>
        </div>
      </div>


      {/* Search bar - Zalo style with navigation */}
      {searchOpen && (
        <div className="px-3 pb-2.5 pt-1 flex items-center gap-2 border-t border-border/50">
          {/* Input */}
          <div className="flex items-center gap-2 flex-1 bg-muted border border-blue-500/60 rounded-full px-3 py-1.5 min-w-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
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
              className="flex-1 bg-transparent text-sm text-foreground placeholder-subtle-foreground focus:outline-none min-w-0"
            />
            {searching && (
              <Spinner size={3} className="text-muted-foreground flex-shrink-0" />
            )}
            {searchQuery && !searching && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]); setCurrentResultIdx(0); searchInputRef.current?.focus(); }}
                className="w-4 h-4 rounded-full bg-accent hover:bg-gray-400 flex items-center justify-center flex-shrink-0 transition-colors"
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
              <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                {currentResultIdx + 1}/{searchResults.length}
              </span>
              <button
                onClick={() => navigateResult('prev')}
                title="Kết quả trước (Shift+Enter)"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="18 15 12 9 6 15"/>
                </svg>
              </button>
              <button
                onClick={() => navigateResult('next')}
                title="Kết quả tiếp theo (Enter)"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
            </div>
          )}
          {/* No results indicator (lần tìm lỗi → "Thử lại" thay vì "Không tìm thấy") */}
          {searchQuery.trim() && !searching && searchResults.length === 0 && (
            searchFailed ? (
              <button
                type="button"
                onClick={() => handleSearchChange(searchQuery)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground flex-shrink-0 whitespace-nowrap transition-colors"
                title="Không tìm được (mất kết nối) — bấm để thử lại"
              >
                <RefreshIcon className="w-3 h-3" />
                Không tìm được · Thử lại
              </button>
            ) : (
              <span className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap">Không tìm thấy</span>
            )
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

      {/* Group name edit popup - đổi tên nhóm */}
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

      {/* Alias edit popup - sửa tên gợi nhớ */}
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

      {/* Telegram message download dialog */}
      {tgDownloadOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => { if (!tgDownloading) setTgDownloadOpen(false); }}>
          <div className="bg-card border border-input rounded-2xl w-80 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-foreground mb-1">Tải tin nhắn từ Telegram</h3>
            <p className="text-xs text-muted-foreground mb-3">Nhập số lượng tin nhắn muốn tải từ Telegram API (tối đa 5.000).</p>
            <input
              type="number"
              value={tgDownloadCount}
              onChange={e => setTgDownloadCount(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !tgDownloading) handleTgDownload(); }}
              placeholder="200"
              min="1"
              max="5000"
              disabled={tgDownloading}
              className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 disabled:opacity-50 mb-3"
            />
            <div className="flex gap-2">
              <button onClick={() => setTgDownloadOpen(false)} disabled={tgDownloading}
                className="flex-1 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent disabled:opacity-40">
                Hủy
              </button>
              <button onClick={handleTgDownload} disabled={tgDownloading || !tgDownloadCount}
                className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 flex items-center justify-center gap-1.5">
                {tgDownloading ? <><Spinner size={3} /> Đang tải...</> : 'Tải'}
              </button>
            </div>
          </div>
        </div>
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
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const { setLabels, showNotification } = useAppStore(useShallow(s => ({ setLabels: s.setLabels, showNotification: s.showNotification })));
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
      className="fixed z-[300] bg-card border border-border rounded-xl shadow-2xl min-w-[190px]"
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
            const auth = buildZaloAuth(acc, activeAccountId);
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
      className="fixed z-[300] bg-card border border-border rounded-xl shadow-2xl min-w-[220px] p-3"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="text-xs text-muted-foreground font-medium mb-2">{title || 'Sửa tên gợi nhớ'}</div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 mb-2"
        placeholder={placeholder || 'Nhập tên gợi nhớ...'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-foreground/80 hover:text-foreground bg-muted hover:bg-accent rounded-lg transition-colors"
        >
          Huỷ
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1"
        >
          {saving && (
            <Spinner size={3} />
          )}
          Lưu
        </button>
      </div>
    </div>
  );
}
