import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getMessageCacheKey, useChatStore } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { MESSAGE_LOAD_LIMIT, MESSAGE_RESTORE_LIMIT, MESSAGE_SEARCH_LIMIT, PAGE_SIZE, CONVERSATION_DISPLAY_STEP, INITIAL_LOADING_TIMEOUT_MS, LABELS_DEBOUNCE_MS } from '@/lib/chat/constants';
import DataAccessor, {
  isReadFailure, mergeAccountOnSuccess, nextConversationPaging, readFailureMessage, retryDelayMs,
  type ConversationPaging,
} from '@/lib/data/DataAccessor';
import { useEmployeeStore } from '@/store/employeeStore';
import { useEmployeeResync } from '@/hooks/useEmployeeResync';
import { Button, EmptyState } from '@/components/ui';
import { sendSeenForThread } from '@/lib/sendSeenHelper';
import { getFilteredUnreadCount } from '@/lib/badgeUtils';
import { InviteToGroupModal } from './GroupModals';
import QuickActionsButton from './quick/QuickActionsButton';
import type { OpenQuickConversation } from './quick/quickActions';
import { showConfirm } from '../common/ConfirmDialog';
import LabelPicker, { EditLabelsModal } from './LabelPicker';
import AddFriendModal from '../common/AddFriendModal';
import ConversationGroupAvatar from './ConversationGroupAvatar';
import { requestGroupAvatar } from '@/lib/chat/groupAvatarLoader';
import { BellIcon, BellOffIcon, BookmarkIcon, ChatIcon, CheckCircleIcon, CheckIcon, CircleIcon, ClipboardListIcon, CloseIcon, CloudIcon, FolderIcon, GlobeIcon, HardDriveIcon, ImageIcon, LinkIcon, MapPinIcon, MessageCircleIcon, PaperclipIcon, PinIcon, PluginIcon, StarIcon, TargetIcon, TrashIcon, UsersIcon } from '@/components/common/icons';
import { toLocalMediaUrl } from '@/lib/localMedia';
import GlobalSearchPanel from './GlobalSearchPanel';
import StarredMessagesPanel from './StarredMessagesPanel';
import AutoMarkReadModal from './AutoMarkReadModal';
import { useAutoReadStore } from '@/store/autoReadStore';
import { markConversationRead } from '@/lib/chat/markConversationRead';
import { useStarredStore } from '@/store/starredStore';
import type { StarredItem } from '@/lib/chat/starredMessages';
import { MY_DOCUMENTS_NAME, isMyDocumentsContact, isPinnedMyDocuments, myDocumentsThreadId } from '@/lib/chat/myDocuments';
import { isSameMessagePage, newestMessages } from '@/lib/chat/messagePage';
import useIsMobile from '@/hooks/useIsMobile';
import ChannelBadge, { ChannelBadgeOverlay } from '../common/ChannelBadge';
import { getCapability, channelSupports, getChannelLabel, type Channel } from '@/../configs/channelConfig';
import { extractUserProfile } from '../../../utils/profileUtils';
import { refreshContactAlias } from '../../hooks/useZaloEvents';
import PageLoading from '@/components/common/PageLoading';
import { CHANNEL, isFacebook, isZalo, isNonZalo, isTelegram, isTelegramUser } from '@/lib/channelHelper';
import { getTelegramMembershipNotice, isTelegramNonMember } from '@/lib/telegramMembership';
import { getAdapter } from '@/lib/adapters/registry';
import ForumTopicsPanel from './ForumTopicsPanel';

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
  // Check "until8AM" - nếu target hour là 8
  const t = new Date(until);
  if (t.getHours() === 8 && t.getMinutes() === 0) return 'until8AM';
  return remainSec > 0 ? remainSec : -1;
}

/**
 * Đổi qua lại giữa các tài khoản: dữ liệu phụ của tài khoản (ghim, cờ tắt thông báo / Khác, nhãn Local, nháp) vừa tải
 * trong khoảng này thì dùng lại — mỗi lần tải xong là một lần dựng lại cả danh sách. Thay đổi trong lúc đó vẫn tới qua
 * sự kiện (ghim, nhãn, cờ).
 */
const ACCOUNT_SIDE_DATA_TTL_MS = 60_000;

/** Tập ghim rỗng dùng chung (giữ nguyên tham chiếu giữa các lần render — useMemo không chạy lại vô ích). */
const EMPTY_THREAD_SET: Set<string> = new Set();
const EMPTY_PINNED_EXTRAS: any[] = [];

const INITIAL_CONVERSATION_PAGING: ConversationPaging = {
  nextOffset: PAGE_SIZE, hasMore: false, exhausted: false, failures: 0, failedPage: null,
};

function samePaging(a: ConversationPaging, b: ConversationPaging): boolean {
  return a.nextOffset === b.nextOffset && a.hasMore === b.hasMore && a.exhausted === b.exhausted
    && a.failures === b.failures && a.failedPage === b.failedPage;
}

/** Bật / tắt ghim một hội thoại trong tập ghim của đúng tài khoản. */
function withThreadPinned(prev: Record<string, Set<string>>, zaloId: string, threadId: string, pinned: boolean) {
  const next = new Set(prev[zaloId] || []);
  if (pinned) next.add(threadId); else next.delete(threadId);
  return { ...prev, [zaloId]: next };
}

/**
 * Báo lỗi tải gọn ngay trong danh sách (chế độ nhân viên: mất kết nối BOSS). Hiện thay cho "trống" — lỗi mạng
 * không được trông như không có dữ liệu.
 */
function LoadFailedNotice({ text, onRetry, busy }: { text: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span>{text}</span>
      <Button variant="link" size="sm" className="text-xs" onClick={onRetry} disabled={busy}>Thử lại</Button>
    </div>
  );
}

/** Tin Facebook lưu rỗng (bản cũ chưa đọc được tin mẫu của Page / đính kèm) — bong bóng chỉ còn giờ. */
function isEmptyFacebookRow(m: any): boolean {
  if (!m || m.is_recalled) return false;
  const att = String(m.attachments ?? '').trim();
  return (!m.msg_type || m.msg_type === 'text') && !String(m.content || '').trim() && (!att || att === '[]' || att === 'null');
}

export default function ConversationList() {
  // Chỉ subscribe các trường danh sách dùng: `useChatStore()` không selector làm cả danh sách (tới 200 hàng) render
  // lại với mọi tin nhắn / đang gõ / đã xem của mọi hội thoại → cuộn và chuyển hội thoại bị giật.
  const {
    contacts, setActiveThread, activeThreadId, activeThreadType, activeTopicId, setMessages, updateContact, clearUnread,
    removeContact, drafts, draftTimestamps, syncRepliedState, saveAccountThread,
  } = useChatStore(useShallow(s => ({
    contacts: s.contacts, setActiveThread: s.setActiveThread, activeThreadId: s.activeThreadId,
    activeThreadType: s.activeThreadType, activeTopicId: s.activeTopicId, setMessages: s.setMessages,
    updateContact: s.updateContact, clearUnread: s.clearUnread, removeContact: s.removeContact, drafts: s.drafts,
    draftTimestamps: s.draftTimestamps, syncRepliedState: s.syncRepliedState, saveAccountThread: s.saveAccountThread,
    // Đọc bằng getState() trong JSX (chỉ báo đang tải) → vẫn phải render lại khi đổi
    conversationsLoading: s.conversationsLoading,
  })));

  // Debug: log khi contacts thay đổi
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (activeAccountId) {
      const c = contacts[activeAccountId];
      const count = c?.length || 0;
      if (count !== prevCountRef.current) {
        console.log(`[ConversationList] 📋 contacts[${activeAccountId}] ${prevCountRef.current} → ${count} items`, count > 0 ? `sample: ${c[0]?.display_name || ''} keys=${Object.keys(c[0]||{}).join(',')}` : '(empty)');
        prevCountRef.current = count;
      }
    }
  });
  const { activeAccountId, accounts: allAccountsList, setActiveAccount } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, accounts: s.accounts, setActiveAccount: s.setActiveAccount,
  })));
  const activeAccountObj = allAccountsList.find(a => a.zalo_id === activeAccountId);
  // groupInfoCache KHÔNG lấy ở đây: mỗi ảnh nhóm tự đọc phần của mình (ConversationGroupAvatar) — trước đây mỗi lần
  // một nhóm tải xong ảnh / thành viên là cả danh sách dựng lại.
  const { labels: allLabels, setLabels, showNotification, setMuted, clearMuted, isMuted: isMutedFn, setGroupInfo,
    othersConversations: allOthers, loadFlags, addToOthers, removeFromOthers,
    mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount, setMobileShowChat } = useAppStore(useShallow(s => ({
    labels: s.labels, setLabels: s.setLabels, showNotification: s.showNotification, setMuted: s.setMuted,
    clearMuted: s.clearMuted, isMuted: s.isMuted, setGroupInfo: s.setGroupInfo,
    othersConversations: s.othersConversations, loadFlags: s.loadFlags, addToOthers: s.addToOthers,
    removeFromOthers: s.removeFromOthers, mergedInboxMode: s.mergedInboxMode, mergedInboxAccounts: s.mergedInboxAccounts,
    mergedInboxFilterAccount: s.mergedInboxFilterAccount, setMobileShowChat: s.setMobileShowChat,
    // isMuted() đọc mutedThreads → biểu tượng tắt thông báo phải cập nhật khi đổi
    mutedThreads: s.mutedThreads,
  })));
  // Local labels work across every channel. Remote Zalo labels must not be
  // shown or loaded while viewing a standalone Telegram/Facebook inbox.
  const canUseZaloLabelFilter = mergedInboxMode || isZalo(activeAccountObj?.channel);
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
  const [filterLabelMode, setFilterLabelMode] = useState<'all' | 'any'>('all'); // 'all' = AND, 'any' = OR
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // Ghim Zalo / ghim trong app theo TÀI KHOẢN: một lần tải lỗi giữ tập ghim cũ của đúng tài khoản đó (trước đây
  // bị thay bằng tập rỗng, và đổi tài khoản còn mang tập ghim của tài khoản trước sang).
  const [zaloPinsByAccount, setZaloPinsByAccount] = useState<Record<string, Set<string>>>({});
  const [localPinsByAccount, setLocalPinsByAccount] = useState<Record<string, Set<string>>>({});
  // Hội thoại ghim nằm ở trang sau (danh sách phân trang theo thời gian tin cuối) — tải bù theo id, giữ RIÊNG khỏi store:
  // phân trang tính offset theo số hội thoại trong store, nhét thêm vào đó sẽ làm trang sau bỏ sót hội thoại.
  const [pinnedExtrasByAccount, setPinnedExtrasByAccount] = useState<Record<string, any[]>>({});
  const pinnedExtrasRequestedRef = useRef(new Set<string>());
  const pinnedThreads = (activeAccountId && zaloPinsByAccount[activeAccountId]) || EMPTY_THREAD_SET;
  const localPinnedThreads = (activeAccountId && localPinsByAccount[activeAccountId]) || EMPTY_THREAD_SET;
  // "Tin đánh dấu" (menu ⋮) thay chỗ danh sách hội thoại khi mở
  const [starredPanelOpen, setStarredPanelOpen] = useState(false);
  // "Tự động đánh dấu đã đọc" (menu ⋮ → Tự động)
  const [autoReadOpen, setAutoReadOpen] = useState(false);
  const autoReadProgress = useAutoReadStore(s => (s.job.status === 'running' ? `${s.job.done}/${s.job.total}` : ''));
  const [failedAvatars, setFailedAvatars] = useState<Set<string>>(() => new Set());
  const [ctxMenu, setCtxMenu] = useState<{ contactId: string; zaloId: string; x: number; y: number } | null>(null);
  const [labelPickerId, setLabelPickerId] = useState<string | null>(null);
  const [muteSubmenuId, setMuteSubmenuId] = useState<string | null>(null);
  const [labelsVersion, setLabelsVersion] = useState(0);
  const [inlineLabelPicker, setInlineLabelPicker] = useState<{ contactId: string; zaloId: string; x: number; y: number } | null>(null);
  const [localLabelsByAccount, setLocalLabelsByAccount] = useState<Record<string, LocalLabelData[]>>({});
  const [localLabelThreadMapByAccount, setLocalLabelThreadMapByAccount] = useState<Record<string, Record<string, number[]>>>({});
  /** Tài khoản có lần tải Nhãn Local gần nhất bị lỗi (danh sách nhãn trống ≠ "chưa có nhãn") */
  const [localLabelsFailed, setLocalLabelsFailed] = useState<Record<string, boolean>>({});
  const [inviteContactId, setInviteContactId] = useState<string | null>(null);
  const [editLabelsOpen, setEditLabelsOpen] = useState(false);
  const [editLabelsZaloId, setEditLabelsZaloId] = useState<string | null>(null);
  const [editLabelsPickerOpen, setEditLabelsPickerOpen] = useState(false);
  const [syncingLabels, setSyncingLabels] = useState(false);
  // Forum topics state
  const [forumChatId, setForumChatId] = useState<string | null>(null);
  const [forumChatName, setForumChatName] = useState('');
  const [forumAccountId, setForumAccountId] = useState<string | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  // Prevents the activeAccountId useEffect from overriding a manual merged-mode selection
  const isManualSelectingRef = React.useRef(false);
  const isEmp = useEmployeeStore(s => s.mode === 'employee');
  // Hội thoại đang mở → "Thêm lịch hẹn" (thao tác nhanh) gắn được lịch với hội thoại này.
  const activeThreadContact = activeAccountId && activeThreadId
    ? (contacts[activeAccountId] || []).find(c => c.contact_id === activeThreadId)
    : undefined;
  const activeThreadName = activeThreadContact?.alias || activeThreadContact?.display_name || activeThreadId || '';
  const quickActiveThread = useMemo(
    () => (activeThreadId ? { id: activeThreadId, name: activeThreadName } : null),
    [activeThreadId, activeThreadName],
  );

  const effectiveFilterLabelSource: LabelSource = canUseZaloLabelFilter ? filterLabelSource : 'local';
  useEffect(() => {
    if (!canUseZaloLabelFilter && filterLabelSource !== 'local') {
      setFilterLabelSource('local');
      setFilterLabelIds([]);
    }
  }, [canUseZaloLabelFilter, filterLabelSource]);

  /** Loading state cho initial fetch - tránh hiển thị empty state khi chưa có data */
  const [initialLoading, setInitialLoading] = useState(true);

  /** Proxy Zalo API calls qua Boss khi ở employee mode */
  const zaloApi = useCallback(async (method: string, params: any) => {
    if (isEmp) {
      // Tài khoản của hội thoại (buildZaloAuth → auth.accountId) trước tài khoản đang mở — danh sách gộp nhiều tài khoản
      const zaloId = params.auth?.zaloId || params.auth?.accountId || params.zaloId || activeAccountId || '';
      return ipc.employee?.proxyAction(`zalo:${method}`, {
        ...params,
        auth: { zaloId },
      });
    }
    const m = (ipc.zalo as any)?.[method];
    return m?.(params);
  }, [isEmp, activeAccountId]);

  // ── Pagination: cố định 200 hội thoại mỗi trang, infinite scroll ──────
  const [displayCount, setDisplayCount] = useState(CONVERSATION_DISPLAY_STEP);
  // Phân trang server (offset / còn nữa / đã hết) + lỗi tải liên tiếp. Lỗi giữ offset + hasMore để thử lại
  // (backoff / "Thử lại" / kết nối lại); chỉ dừng hẳn khi server nói hết.
  const [paging, setPaging] = useState<ConversationPaging>(INITIAL_CONVERSATION_PAGING);
  const conversationHasMore = paging.hasMore;
  const conversationNextOffset = paging.nextOffset;
  const conversationExhausted = paging.exhausted;
  const [conversationLoadingMore, setConversationLoadingMore] = useState(false);

  // ── DB-level filtered contacts (nhanh hơn filter trong memory) ──────
  const [dbFilteredContacts, setDbFilteredContacts] = useState<any[] | null>(null);
  // The filtered list is a DB snapshot. Re-read it whenever the Others flags
  // reload (they reload after every Telegram/Zalo contact refresh), so a newly
  // archived or brand-new conversation shows up without switching tabs.
  const othersSnapshotKey = mergedInboxMode ? allOthers : allOthers[activeAccountId || ''];
  useEffect(() => {
    const hasFilter = channelFilter !== 'all' || !!search || filter === 'unread' || filter === 'others';
    if (!hasFilter) { setDbFilteredContacts(null); return; }

    let cancelled = false;
    const ipc = (window as any).electronAPI?.db;
    const filterOpts = {
      channel: channelFilter !== 'all' ? channelFilter : undefined,
      search: search || undefined,
      unreadOnly: filter === 'unread' ? true : undefined,
      othersOnly: filter === 'others' ? true : undefined,
      excludeOthers: filter !== 'others' ? true : undefined,
    };

    if (mergedInboxMode && mergedInboxAccounts.length > 0) {
      // Merged mode: query DB cho từng account rồi gộp
      Promise.all(
        mergedInboxAccounts.map(zaloId =>
          ipc?.getContactsFiltered({ zaloId, ...filterOpts })
            .then((r: any) => r?.success ? (r.contacts || []) : [])
            .catch(() => [])
        )
      ).then((results) => {
        if (cancelled) return;
        const merged = results.flat();
        // Dedup theo contact_id (giữ bản mới nhất)
        const seen = new Map<string, any>();
        for (const c of merged) {
          const key = `${c.owner_zalo_id}_${c.contact_id}`;
          if (!seen.has(key)) seen.set(key, c);
        }
        setDbFilteredContacts(Array.from(seen.values()));
      });
    } else if (activeAccountId) {
      // Single mode: query DB cho account hiện tại
      ipc?.getContactsFiltered({ zaloId: activeAccountId, ...filterOpts })
        .then((res: any) => {
          if (!cancelled && res?.success && Array.isArray(res.contacts)) {
            setDbFilteredContacts(res.contacts);
          }
        }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, [activeAccountId, mergedInboxMode, mergedInboxAccounts.join(','), channelFilter, search, filter, othersSnapshotKey]);

  // A filtered DB query is a snapshot. Selection immediately clears unread in
  // the Zustand store, so overlay the live item before rendering; otherwise a
  // conversation in "Khác" keeps its 99+ badge until a tab change re-runs the
  // database query.
  const dbFilteredContactsWithLiveState = useMemo(() => {
    if (!dbFilteredContacts) return null;
    // Map theo tài khoản (giữ phần tử đầu tiên như .find): trước đây mỗi hội thoại .find() qua cả danh bạ,
    // chạy lại theo mỗi tin nhắn đến khi đang lọc
    const liveByOwner = new Map<string, Map<string, any>>();
    const getLive = (ownerId: string, contactId: string) => {
      let byId = liveByOwner.get(ownerId);
      if (!byId) {
        byId = new Map();
        for (const item of contacts[ownerId] || []) {
          if (!byId.has(item.contact_id)) byId.set(item.contact_id, item);
        }
        liveByOwner.set(ownerId, byId);
      }
      return byId.get(contactId);
    };
    return dbFilteredContacts.map((contact) => {
      const ownerId = contact.owner_zalo_id || activeAccountId;
      const live = ownerId ? getLive(ownerId, contact.contact_id) : undefined;
      return live ? { ...contact, ...live } : contact;
    });
  }, [dbFilteredContacts, contacts, activeAccountId]);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  // Ảnh nhóm chỉ tải khi hàng vào vùng nhìn thấy (+240px trước / sau khi cuộn): một observer cho cả danh sách
  const [listContainerEl, setListContainerEl] = useState<HTMLDivElement | null>(null);
  const setListContainer = useCallback((el: HTMLDivElement | null) => {
    listContainerRef.current = el;
    setListContainerEl(el);
  }, []);
  const [groupAvatarObserver, setGroupAvatarObserver] = useState<IntersectionObserver | null>(null);
  useEffect(() => {
    if (!listContainerEl || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        observer.unobserve(el);
        requestGroupAvatar(el.dataset.avatarAccount || '', el.dataset.avatarGroup || '');
      }
    }, { root: listContainerEl, rootMargin: '240px 0px' });
    setGroupAvatarObserver(observer);
    return () => {
      observer.disconnect();
      setGroupAvatarObserver(null);
    };
  }, [listContainerEl]);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // ── Vị trí cuộn theo từng danh sách ─────────────────────────────────────
  // Danh sách = tài khoản (hoặc trang gộp) + thư mục / bộ lọc / nhãn / kênh. Đổi sang danh sách khác rồi quay lại: về
  // đúng chỗ cũ; danh sách mới mở từ đầu. Trước đây phần tử cuộn giữ scrollTop của danh sách trước trong khi số hàng
  // về lại 60 → trình duyệt kẹp xuống CUỐI danh sách mới ("nhảy xuống dưới cùng"); trang gộp còn bị vậy mỗi lần mở
  // hội thoại của tài khoản khác (đổi tài khoản đang mở làm số hàng về 60).
  const listBaseKey = [
    mergedInboxMode ? `merged:${mergedInboxFilterAccount || ''}` : `acc:${activeAccountId || ''}`,
    filter, filterLabelIds.join(','), channelFilter,
  ].join('|');
  const listViewKey = search ? `${listBaseKey}|q:${search}` : listBaseKey;
  const listViewStateRef = useRef(new Map<string, { top: number; count: number }>());
  const listViewKeyRef = useRef(listViewKey);
  const lastListScrollTopRef = useRef(0);
  const displayCountRef = useRef(displayCount);
  displayCountRef.current = displayCount;
  const pendingListScrollRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const prevKey = listViewKeyRef.current;
    if (prevKey === listViewKey) return;
    // Kết quả tìm kiếm là tạm thời: không nhớ vị trí của chúng
    if (!prevKey.includes('|q:')) {
      listViewStateRef.current.set(prevKey, { top: lastListScrollTopRef.current, count: displayCountRef.current });
    }
    listViewKeyRef.current = listViewKey;
    const saved = listViewKey.includes('|q:') ? undefined : listViewStateRef.current.get(listViewKey);
    setDisplayCount(Math.max(CONVERSATION_DISPLAY_STEP, saved?.count || 0));
    pendingListScrollRef.current = saved && saved.top > 0 ? saved.top : null;
    const el = listContainerRef.current;
    if (el) el.scrollTop = 0;
    lastListScrollTopRef.current = 0;
  }, [listViewKey]);

  // Về chỗ cũ khi danh sách đã dựng đủ hàng (danh sách theo bộ lọc tải từ DB có thể tới sau vài khung hình)
  useLayoutEffect(() => {
    const target = pendingListScrollRef.current;
    const el = listContainerRef.current;
    if (target == null || !el) return;
    if (el.scrollHeight - el.clientHeight >= target) {
      el.scrollTop = target;
      lastListScrollTopRef.current = target;
      pendingListScrollRef.current = null;
    }
  });

  const handleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop;
    lastListScrollTopRef.current = top;
    // Người dùng tự cuộn trong lúc chờ khôi phục → thôi khôi phục
    if (top > 0 && pendingListScrollRef.current != null && Math.abs(top - pendingListScrollRef.current) > 2) {
      pendingListScrollRef.current = null;
    }
  }, []);
  const loadMoreConversationsRef = useRef<() => void>(() => {});
  const pagingAccountRef = useRef(activeAccountId);

  // Phân trang khi đổi tài khoản / bộ lọc (số hàng đang dựng theo từng danh sách: xem listViewKey ở trên)
  useEffect(() => {
    const accountChanged = pagingAccountRef.current !== activeAccountId;
    pagingAccountRef.current = activeAccountId;
    setPaging(prev => {
      // Chỉ đổi bộ lọc: lần tải TRANG ĐẦU vừa lỗi vẫn phải được thử lại → giữ đếm lỗi
      const next = !accountChanged && prev.failedPage === 'first'
        ? { ...INITIAL_CONVERSATION_PAGING, failures: prev.failures, failedPage: prev.failedPage }
        : INITIAL_CONVERSATION_PAGING;
      return samePaging(prev, next) ? prev : next;
    });
  }, [activeAccountId, filter, filterLabelIds, search, mergedInboxFilterAccount, channelFilter]);

  useEffect(() => {
    if (!activeAccountId || mergedInboxMode || conversationExhausted) return;
    const count = contacts[activeAccountId]?.length || 0;
    if (count >= PAGE_SIZE) {
      setPaging(prev => {
        const nextOffset = Math.max(prev.nextOffset, count);
        return nextOffset === prev.nextOffset && prev.hasMore ? prev : { ...prev, nextOffset, hasMore: true };
      });
    }
  }, [activeAccountId, contacts, mergedInboxMode, conversationExhausted]);

  const loadMoreConversations = useCallback(async () => {
    if (!activeAccountId || mergedInboxMode || conversationLoadingMore || !conversationHasMore) return;
    const accountId = activeAccountId;
    setConversationLoadingMore(true);
    let result: Awaited<ReturnType<typeof DataAccessor.getConversations>> | null = null;
    try {
      result = await DataAccessor.getConversations(accountId, PAGE_SIZE, conversationNextOffset);
      const items = !isReadFailure(result) && Array.isArray(result?.items) ? result.items : [];
      if (items.length > 0) {
        // Đọc danh sách SAU khi tải xong: hội thoại / tin mới đến trong lúc chờ không bị ghi đè
        const current = useChatStore.getState().contacts[accountId] || [];
        const seen = new Set(current.map((contact) => contact.contact_id));
        const merged = [
          ...current,
          ...items.filter((contact: any) => !seen.has(contact.contact_id)),
        ];
        useChatStore.getState().setContacts(accountId, merged);
      }
    } catch (err) {
      console.warn('[ConversationList] Failed to load more contacts:', err);
      result = null;
    } finally {
      setConversationLoadingMore(false);
    }
    if (isReadFailure(result)) {
      console.warn(`[ConversationList] Không tải được thêm hội thoại (${accountId}): ${readFailureMessage(result)}`);
    }
    // Đổi tài khoản trong lúc chờ → phân trang đã thuộc tài khoản mới
    if (useAccountStore.getState().activeAccountId !== accountId) return;
    // Lỗi: giữ offset + hasMore (không còn "bỏ cuộc" vĩnh viễn sau một lần lỗi)
    setPaging(prev => nextConversationPaging(prev, result, 'more'));
  }, [activeAccountId, mergedInboxMode, conversationHasMore, conversationLoadingMore, conversationNextOffset]);

  loadMoreConversationsRef.current = loadMoreConversations;

  /**
   * Trang đầu hội thoại của `zaloId`: đầu danh sách lấy từ server, giữ phần đã tải phía sau.
   * `updatePaging`: lần tải đầu / thử lại lần tải đầu (đặt lại phân trang); lần làm mới khi kết nối lại chỉ gộp.
   * Lỗi → giữ nguyên danh sách đang có, ghi nhận lỗi để "Thử lại" (không còn thành "Không có hội thoại").
   */
  const loadFirstConversationPage = async (zaloId: string, updatePaging: boolean): Promise<void> => {
    if (useChatStore.getState().conversationsLoading[zaloId]) return;
    useChatStore.getState().setConversationsLoading(zaloId, true);
    try {
      let result: Awaited<ReturnType<typeof DataAccessor.getConversations>> | null = null;
      try {
        result = await DataAccessor.getConversations(zaloId, PAGE_SIZE, 0);
      } catch (err) {
        console.warn('[ConversationList] Failed to load contacts:', err);
      }
      const applyPaging = updatePaging && useAccountStore.getState().activeAccountId === zaloId;
      if (applyPaging) setPaging(prev => nextConversationPaging(prev, result, 'first'));
      if (!result || isReadFailure(result)) {
        if (result) console.warn(`[ConversationList] Không tải được hội thoại (${zaloId}): ${readFailureMessage(result)}`);
        // Bỏ khung xương chờ: hiện "Không tải được — Thử lại" (tự thử lại theo backoff / khi kết nối lại)
        if (applyPaging) setInitialLoading(false);
        return;
      }
      const items = Array.isArray(result.items) ? result.items : [];
      if (items.length) {
        const existing = useChatStore.getState().contacts[zaloId] || [];
        const seen = new Set(items.map((contact: any) => contact.contact_id));
        const merged = [
          ...items,
          ...existing.filter((contact) => !seen.has(contact.contact_id)),
        ];
        useChatStore.getState().setContacts(zaloId, merged);
        console.log(`[ConversationList] Loaded ${items.length} contacts for ${zaloId} via DataAccessor`);
      } else if (applyPaging) {
        console.warn(`[ConversationList] No contacts returned for ${zaloId}`);
        // Clear initial loading ngay khi load xong mà không có data
        setInitialLoading(false);
      }
    } finally {
      useChatStore.getState().setConversationsLoading(zaloId, false);
    }
  };

  /** Thử lại lần tải hội thoại vừa lỗi — nút "Thử lại", backoff, kết nối BOSS phục hồi. */
  const retryConversationLoad = () => {
    const accountId = useAccountStore.getState().activeAccountId;
    if (!accountId || mergedInboxMode) return;
    if (paging.failedPage === 'more') loadMoreConversationsRef.current();
    else void loadFirstConversationPage(accountId, true);
  };
  const retryConversationLoadRef = useRef(retryConversationLoad);
  retryConversationLoadRef.current = retryConversationLoad;

  // Tự thử lại trang lỗi: 2 s → 4 → 8 → 16 → 30 s (5 lần); sau đó chờ cuộn / "Thử lại" / kết nối lại
  useEffect(() => {
    if (paging.failures === 0 || mergedInboxMode) return;
    const delay = retryDelayMs(paging.failures);
    if (delay == null) return;
    const timer = setTimeout(() => retryConversationLoadRef.current(), delay);
    return () => clearTimeout(timer);
  }, [paging.failures, mergedInboxMode, activeAccountId]);

  const labels: LabelData[] = activeAccountId ? (allLabels[activeAccountId] || []) : [];
  const othersConversations: Set<string> = activeAccountId ? (allOthers[activeAccountId] || new Set()) : new Set();
  const localLabels: LocalLabelData[] = mergedInboxMode
    ? (() => {
        // Gộp local labels từ tất cả account trong merged mode, dedup theo name
        const seen = new Map<string, LocalLabelData>();
        for (const zaloId of mergedInboxAccounts) {
          for (const lbl of (localLabelsByAccount[zaloId] || [])) {
            if (!seen.has(lbl.name)) seen.set(lbl.name, lbl);
          }
        }
        return Array.from(seen.values());
      })()
    : (activeAccountId ? (localLabelsByAccount[activeAccountId] || []) : []);

  const loadLocalLabelsForAccount = async (zaloId: string) => {
    try {
      const [labelsRes, threadsRes] = await Promise.all([
        DataAccessor.getLocalLabels({ zaloId }),
        DataAccessor.getLocalLabelThreads({ zaloId }),
      ]);
      const failed = isReadFailure(labelsRes) || isReadFailure(threadsRes);
      setLocalLabelsFailed(prev => (!!prev[zaloId] === failed ? prev : { ...prev, [zaloId]: failed }));
      // Lỗi → giữ nhãn / gán nhãn đang có của tài khoản (trước đây bị thay bằng rỗng: mất nhãn trên danh sách)
      setLocalLabelsByAccount(prev => mergeAccountOnSuccess(prev, zaloId, labelsRes, () => (labelsRes?.labels || [])
        .filter((l: any) => (l?.is_active ?? 1) === 1)
        .sort((a: any, b: any) => {
          const sa = Number(a?.sort_order ?? 0);
          const sb = Number(b?.sort_order ?? 0);
          if (sa !== sb) return sa - sb;
          return String(a?.name || '').localeCompare(String(b?.name || ''));
        })));
      setLocalLabelThreadMapByAccount(prev => mergeAccountOnSuccess(prev, zaloId, threadsRes, () => {
        const map: Record<string, number[]> = {};
        (threadsRes?.threads || []).forEach((row: any) => {
          const tid = String(row.thread_id || '');
          if (!tid) return;
          if (!map[tid]) map[tid] = [];
          map[tid].push(Number(row.label_id));
        });
        return map;
      }));
    } catch {}
  };

  const localLabelsLoadFailed = mergedInboxMode
    ? mergedInboxAccounts.some(id => localLabelsFailed[id])
    : !!(activeAccountId && localLabelsFailed[activeAccountId]);
  const reloadVisibleLocalLabels = () => {
    const ids = mergedInboxMode ? mergedInboxAccounts : (activeAccountId ? [activeAccountId] : []);
    ids.forEach(id => { loadLocalLabelsForAccount(id).catch(() => {}); });
  };

  /** Ghim trong app của `zaloId` — lỗi đọc giữ tập ghim đang có. */
  const reloadLocalPins = (zaloId: string) => {
    DataAccessor.getLocalPinnedConversations({ zaloId }).then((res: any) => {
      setLocalPinsByAccount(prev => mergeAccountOnSuccess(prev, zaloId, res, () => new Set<string>(res?.threadIds || [])));
    }).catch(() => {});
  };

  /** Ghim Zalo (getPinConversations) của tài khoản Zalo — phản hồi lỗi giữ tập ghim đang có. */
  const reloadZaloPins = (zaloId: string, auth: any) => {
    // getPinConversations returns { conversations: string[], version: number }
    // where each ID is prefixed with 'u' (user) or 'g' (group)
    zaloApi('getPinConversations', { auth }).then((res: any) => {
      const convIds = res?.response?.conversations;
      if (!Array.isArray(convIds)) return;
      setZaloPinsByAccount(prev => ({ ...prev, [zaloId]: new Set(convIds.map((id: string) => String(id).replace(/^[ug]/, ''))) }));
    }).catch(() => {});
  };

  // Lần tải dữ liệu phụ gần nhất theo tài khoản (theo vòng đời danh sách: mở lại danh sách thì tải lại)
  const sideDataLoadedAtRef = useRef(new Map<string, number>());

  // Load labels, pinned, and others conversations when account changes
  useEffect(() => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const isZaloChannel = isZalo(acc.channel);
    const auth = buildZaloAuth(acc, activeAccountId);

    // Zalo-only APIs: labels, pin conversations
    if (isZaloChannel) {
      // Labels: dùng cache 12h, không gọi API mỗi lần chuyển tab (luôn gọi: lấy version nhãn của ĐÚNG tài khoản này)
      useAppStore.getState().fetchLabelsWithCache(activeAccountId, auth).then(({ version }) => {
        setLabelsVersion(version);
      }).catch(() => {});
    }

    // Đổi qua lại liên tục: ghim / cờ / nhãn Local / nháp vừa tải → dùng lại, không truy vấn + dựng lại danh sách nữa
    const loadedAt = sideDataLoadedAtRef.current.get(activeAccountId) || 0;
    if (Date.now() - loadedAt < ACCOUNT_SIDE_DATA_TTL_MS) return;
    sideDataLoadedAtRef.current.set(activeAccountId, Date.now());
    if (isZaloChannel) reloadZaloPins(activeAccountId, auth);

    // Load local pinned conversations from DB
    reloadLocalPins(activeAccountId);

    // Load mute + others flags from DB into store cache
    loadFlags(activeAccountId);
    loadLocalLabelsForAccount(activeAccountId).catch(() => {});
    // Load drafts from DB into store for this account
    useChatStore.getState().loadDrafts(activeAccountId).catch(() => {});
  }, [activeAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Load contacts khi chua co (dac biet employee mode qua REST API) ──
  // Khi doi workspace tu BOSS → Employee, App.tsx khong load contacts ma
  // de ConversationList tu load. Neu contacts rong → fetch tu DataAccessor.
  useEffect(() => {
    if (!activeAccountId) return;
    const currentContacts = useChatStore.getState().contacts[activeAccountId] || [];
    if (currentContacts.length > 0) {
      setPaging(prev => {
        const hasMore = currentContacts.length >= PAGE_SIZE && !prev.exhausted;
        return prev.nextOffset === currentContacts.length && prev.hasMore === hasMore
          ? prev
          : { ...prev, nextOffset: currentContacts.length, hasMore };
      });
      // A Telegram event can create one in-memory contact before the initial
      // database hydration runs. Do not treat that partial cache as a complete
      // standalone inbox, otherwise the remaining saved conversations never
      // reach the list after an app restart.
      if (conversationExhausted || currentContacts.length >= PAGE_SIZE) return;
    }
    void loadFirstConversationPage(activeAccountId, true);
  }, [activeAccountId, isEmp, conversationExhausted]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Clear initial loading khi contacts load lần đầu ───────────────────
  // Trong employee mode với high ping, tránh hiển thị empty state trước khi fetch xong
  useEffect(() => {
    if (!activeAccountId) {
      setInitialLoading(true);
      return;
    }
    // Nếu contacts đã có data → initial load complete
    if ((contacts[activeAccountId]?.length || 0) > 0) {
      setInitialLoading(false);
      return;
    }
    // Safety fallback: clear after 8s
    const timeout = setTimeout(() => setInitialLoading(false), INITIAL_LOADING_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [activeAccountId, contacts]);

  // Watch contacts cho account hiện tại - clear initial loading khi data về
  useEffect(() => {
    if (!activeAccountId || !initialLoading) return;
    if ((contacts[activeAccountId]?.length || 0) > 0) {
      setInitialLoading(false);
    }
  }, [activeAccountId, contacts, initialLoading]);

  // Reload local labels when toggled from MessageInput, ChatHeader, CRM, etc. — và khi Boss / nhân viên khác đổi
  // (relay db:localLabelChanged / db:localLabelThreadChanged → useZaloEvents phát lại thành window event)
  useEffect(() => {
    const isVisibleAccount = (zaloId: string) => zaloId === activeAccountId || (mergedInboxMode && mergedInboxAccounts.includes(zaloId));
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const zaloId = detail?.zaloId;
      if (zaloId) {
        loadLocalLabelsForAccount(zaloId).catch(() => {});
      } else {
        // Định nghĩa nhãn dùng chung đổi (không gắn tài khoản) → mọi tài khoản đang hiển thị (cả khi gộp trang)
        reloadVisibleLocalLabels();
      }
    };
    window.addEventListener('local-labels-changed', handler);
    // Also reload when label-thread assignments change (assign/remove/bulkAssign) — đúng tài khoản của event
    const handleThreadLabelsChanged = (e: Event) => {
      const owner = String((e as CustomEvent).detail?.ownerZaloId || '');
      if (owner && !isVisibleAccount(owner)) return; // tài khoản không hiển thị: tải lại khi mở
      const target = owner || activeAccountId;
      if (target) loadLocalLabelsForAccount(target).catch(() => {});
    };
    window.addEventListener('ui:threadLabelsChanged', handleThreadLabelsChanged);
    return () => {
      window.removeEventListener('local-labels-changed', handler);
      window.removeEventListener('ui:threadLabelsChanged', handleThreadLabelsChanged);
    };
  }, [activeAccountId, contacts, mergedInboxMode, mergedInboxAccounts.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for Ctrl+K from MessageInput → focus conversation search
  useEffect(() => {
    const handler = () => {
      setSearchPanelOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    };
    window.addEventListener('focus:conversationSearch', handler);
    return () => window.removeEventListener('focus:conversationSearch', handler);
  }, []);

  // Refresh local pinned threads when pin state changes: Ctrl+P (MessageInput — chỉ có zaloId → đọc lại) hoặc relay
  // db:pinnedConversationChanged (useZaloEvents — có threadId + isPinned → áp thẳng, không hỏi lại Boss; tiếng vọng
  // thao tác của chính mình / ghim từ ConversationInfo, GroupInfoPanel cũng tới đây)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const zaloId = detail?.zaloId ? String(detail.zaloId) : '';
      if (!zaloId) return;
      const threadId = detail?.threadId ? String(detail.threadId) : '';
      if (threadId && typeof detail?.isPinned === 'boolean') {
        const pinned: boolean = detail.isPinned;
        setLocalPinsByAccount(prev => {
          const current = prev[zaloId];
          // Tài khoản chưa nạp ghim (nạp khi mở) / trạng thái như cũ → giữ nguyên object (không render lại)
          if (!current || current.has(threadId) === pinned) return prev;
          return withThreadPinned(prev, zaloId, threadId, pinned);
        });
        return;
      }
      if (zaloId === activeAccountId) reloadLocalPins(zaloId);
    };
    window.addEventListener('local-pin-changed', handler);
    return () => window.removeEventListener('local-pin-changed', handler);
  }, [activeAccountId, contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mergedInboxMode) return;
    mergedInboxAccounts.forEach((zaloId) => {
      loadLocalLabelsForAccount(zaloId).catch(() => {});
    });
  }, [mergedInboxMode, mergedInboxAccounts.join(',')]);

  // Ảnh nhóm: tải theo hàng đang hiện (ConversationGroupAvatar → groupAvatarLoader), không quét cả tài khoản.

  // Background fetch group info for groups without real names
  // Chỉ chạy 1 lần khi activeAccountId thay đổi - KHÔNG depend vào contacts
  // để tránh gọi API liên tục mỗi khi nhận tin nhắn mới
  const groupNamesFetchedAtRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    // Guard: chỉ fetch group info cho Zalo accounts
    if (isNonZalo(acc.channel)) return;
    // Đổi qua lại giữa các tài khoản: đã hỏi tên nhóm của tài khoản này trong 10 phút → bỏ qua
    const fetchedAt = groupNamesFetchedAtRef.current.get(activeAccountId) || 0;
    if (Date.now() - fetchedAt < 10 * 60_000) return;
    groupNamesFetchedAtRef.current.set(activeAccountId, Date.now());
    const auth = buildZaloAuth(acc, activeAccountId);

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
          DataAccessor.updateContactProfile({
            zaloId: activeAccountId,
            contactId: gId,
            displayName: name,
            avatarUrl: avatar,
            phone: '',
            contactType: 'group'  // ← FIX
          }).catch(() => {});

          // Parse và lưu members nếu có - chỉ khi DB chưa có (tránh ghi đè mỗi lần chuyển account)
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
            // Check DB trước - nếu đã có members rồi thì bỏ qua
            const existingMembers = await DataAccessor.getGroupMembers({ zaloId: activeAccountId, groupId: gId }).catch(() => null);
            if (!existingMembers?.members?.length) {
              DataAccessor.saveGroupMembers({ zaloId: activeAccountId, groupId: gId, members }).catch(() => {});
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
  // Unread riêng của thư mục "Khác" - chỉ dùng để hiện dấu chấm đỏ
  const othersUnreadCount = accountContacts.reduce((s, c) => {
    if (!othersConversations.has(c.contact_id) || isTelegramNonMember(c)) return s;
    return s + (c.unread_count > 0 ? 1 : 0);
  }, 0);
  // const unrepliedCount = accountContacts.reduce((s, c) => s + (c.unread_count > 0 && c.is_replied !== 1 ? 1 : 0), 0);
  const othersCount = accountContacts.reduce((s, c) => s + (othersConversations.has(c.contact_id) ? 1 : 0), 0);

  // Zalo "My Documents": hội thoại CÓ SẴN của Zalo, đồng bộ với Zalo (ID = loginInfo.send2me_id, KHÔNG phải UID của
  // mình). Như Zalo: luôn ở đầu danh sách của tài khoản, không bỏ ghim được; hộp thư gộp chỉ ghim khi đã có tin.
  // Ít khi có tin mới nên thường nằm ở trang sau → tải bù theo id như hội thoại ghim (không tự dựng hội thoại nào).
  const accountOf = useCallback(
    (accountId?: string | null) => allAccountsList.find(a => a.zalo_id === accountId),
    [allAccountsList],
  );
  const activeMyDocsId = myDocumentsThreadId(activeAccountObj);

  // Ghim Zalo + ghim trên máy + My Documents của tài khoản đang xem (không áp cho hộp thư gộp)
  const pinnedIdsKey = useMemo(() => {
    if (!activeAccountId || mergedInboxMode) return '';
    const ids = new Set<string>([...pinnedThreads, ...localPinnedThreads]);
    if (activeMyDocsId) ids.add(activeMyDocsId);
    return [...ids].filter(Boolean).sort().join(',');
  }, [activeAccountId, mergedInboxMode, pinnedThreads, localPinnedThreads, activeMyDocsId]);
  const loadedContactCount = activeAccountId ? (contacts[activeAccountId]?.length || 0) : 0;
  const pinnedExtrasRef = useRef(pinnedExtrasByAccount);
  pinnedExtrasRef.current = pinnedExtrasByAccount;
  /** Tải bù theo id các hội thoại chưa có trong trang nào đã tải (DB, không gọi Zalo). */
  const requestPinnedExtras = useCallback((accountId: string, ids: string[]) => {
    const loaded = new Set((useChatStore.getState().contacts[accountId] || []).map((contact) => contact.contact_id));
    const fetched = new Set((pinnedExtrasRef.current[accountId] || []).map((contact: any) => contact.contact_id));
    const missing = ids.filter((id) => id && !loaded.has(id) && !fetched.has(id));
    if (missing.length === 0) return;
    // Mỗi bộ id chỉ hỏi 1 lần (id không có trong DB thì thôi); lỗi đọc → cho hỏi lại lần sau
    const requestKey = `${accountId}|${missing.join(',')}`;
    if (pinnedExtrasRequestedRef.current.has(requestKey)) return;
    pinnedExtrasRequestedRef.current.add(requestKey);
    DataAccessor.getConversationsByIds(accountId, missing).then((result: any) => {
      if (!result?.success) {
        pinnedExtrasRequestedRef.current.delete(requestKey);
        return;
      }
      const items: any[] = Array.isArray(result.items) ? result.items : [];
      if (items.length === 0) return;
      setPinnedExtrasByAccount((prev) => {
        const byId = new Map((prev[accountId] || []).map((contact: any) => [contact.contact_id, contact]));
        for (const contact of items) byId.set(contact.contact_id, contact);
        return { ...prev, [accountId]: [...byId.values()] };
      });
    }).catch(() => { pinnedExtrasRequestedRef.current.delete(requestKey); });
  }, []);
  useEffect(() => {
    if (!activeAccountId || !pinnedIdsKey) return;
    requestPinnedExtras(activeAccountId, pinnedIdsKey.split(','));
  }, [activeAccountId, pinnedIdsKey, loadedContactCount, requestPinnedExtras]);
  // Hộp thư gộp: My Documents của từng tài khoản Zalo đang gộp
  const mergedMyDocsKey = useMemo(() => {
    if (!mergedInboxMode) return '';
    return mergedInboxAccounts
      .map((accountId) => {
        const threadId = myDocumentsThreadId(accountOf(accountId));
        return threadId ? `${accountId}:${threadId}` : '';
      })
      .filter(Boolean)
      .join(',');
  }, [mergedInboxMode, mergedInboxAccounts, accountOf]);
  useEffect(() => {
    if (!mergedMyDocsKey) return;
    for (const pair of mergedMyDocsKey.split(',')) {
      const [accountId, threadId] = pair.split(':');
      requestPinnedExtras(accountId, [threadId]);
    }
  }, [mergedMyDocsKey, requestPinnedExtras]);

  // Danh sách hiển thị = các trang đã tải + hội thoại ghim tải bù (chưa có trong trang nào, vẫn đang được ghim)
  const pinnedExtras = (activeAccountId && pinnedExtrasByAccount[activeAccountId]) || EMPTY_PINNED_EXTRAS;
  const accountContactsWithPinned = useMemo(() => {
    if (pinnedExtras.length === 0) return accountContacts;
    const loaded = new Set(accountContacts.map((contact) => contact.contact_id));
    const extras = pinnedExtras.filter((contact: any) => !loaded.has(contact.contact_id) && (
      pinnedThreads.has(contact.contact_id) || localPinnedThreads.has(contact.contact_id)
      || isMyDocumentsContact(contact, activeAccountObj)
    ));
    return extras.length > 0 ? [...accountContacts, ...extras] : accountContacts;
  }, [accountContacts, pinnedExtras, pinnedThreads, localPinnedThreads, activeAccountObj]);

  // ── Filtered list: dùng DB result khi có filter, fallback memory filter ──
  const filtered = useMemo(() => {
    // Ưu tiên DB-filtered result (nhanh, đã filter channel/search/unread/others ở DB level)
    const rawSource = dbFilteredContactsWithLiveState ?? accountContactsWithPinned;
    // Safety: luôn loại bỏ hội thoại "Khác" khi không ở tab "Khác"
    const source = filter === 'others'
      ? rawSource.filter(c => othersConversations.has(c.contact_id))
      : rawSource.filter(c => !othersConversations.has(c.contact_id));

    // Label filter + unreplied filter vẫn cần làm ở memory (DB chưa hỗ trợ)
    const preFiltered = (filter === 'label' || filter === 'unreplied')
      ? source.filter((c) => {
          if (filter === 'unreplied') return c.unread_count > 0 && c.is_replied !== 1;
          // label filter
          if (effectiveFilterLabelSource === 'local') {
            const threadMap = localLabelThreadMapByAccount[activeAccountId || ''] || {};
            const threadLabelIds = threadMap[c.contact_id] || [];
            if (filterLabelIds.length > 0) {
              return filterLabelMode === 'all'
                ? filterLabelIds.every(id => threadLabelIds.includes(id))
                : filterLabelIds.some(id => threadLabelIds.includes(id));
            }
            return threadLabelIds.length > 0;
          } else {
            const isGroupC = c.contact_type === 'group';
            const labelCId = isGroupC ? `g${c.contact_id}` : c.contact_id;
            if (filterLabelIds.length > 0) {
              const matchFn = (id: number) => {
                const lbl = labels.find(l => l.id === id);
                return lbl ? (lbl.conversations.includes(labelCId) || lbl.conversations.includes(c.contact_id)) : false;
              };
              return filterLabelMode === 'all'
                ? filterLabelIds.every(matchFn)
                : filterLabelIds.some(matchFn);
            }
            return labels.some(l => l.conversations.includes(labelCId) || l.conversations.includes(c.contact_id));
          }
        })
      : source;

    // The DB snapshot can be stale after opening a conversation. Reapply the
    // unread predicate against live store state so both standard and Others
    // views react in the same render as clearUnread().
    const liveFiltered = filter === 'unread'
      ? preFiltered.filter(c => c.unread_count > 0)
      : preFiltered;

    // Khoá sắp xếp tính 1 lần / hội thoại (thứ tự y hệt): trước đây mỗi lần so sánh lại ghép chuỗi + tra Set
    const sortKeys = new Map<any, { md: number; lp: number; p: number; out: number; hasDraft: boolean; draftTs: number; time: number }>();
    for (const c of liveFiltered) {
      const draftKey = `${activeAccountId}_${c.contact_id}`;
      sortKeys.set(c, {
        md: isMyDocumentsContact(c, activeAccountObj) ? 1 : 0,
        lp: localPinnedThreads.has(c.contact_id) ? 1 : 0,
        p: pinnedThreads.has(c.contact_id) ? 1 : 0,
        out: filter === 'others' && isTelegramNonMember(c) ? 1 : 0,
        hasDraft: c.contact_id !== activeThreadId && !!drafts[draftKey],
        draftTs: draftTimestamps[draftKey] || 0,
        time: c.last_message_time || 0,
      });
    }
    return liveFiltered.sort((a, b) => {
      const ka = sortKeys.get(a)!, kb = sortKeys.get(b)!;
      if (ka.md !== kb.md) return kb.md - ka.md;
      if (ka.lp !== kb.lp) return kb.lp - ka.lp;
      if (ka.p !== kb.p) return kb.p - ka.p;
      // Groups/channels the account is no longer in never update; keep them
      // below the archived conversations, under their own heading.
      if (filter === 'others' && ka.out !== kb.out) return ka.out - kb.out;
      if (ka.hasDraft !== kb.hasDraft) return ka.hasDraft ? -1 : 1;
      if (ka.hasDraft && kb.hasDraft) return kb.draftTs - ka.draftTs;
      return kb.time - ka.time;
    });
  }, [dbFilteredContactsWithLiveState, accountContactsWithPinned, filter, othersConversations, filterLabelIds, effectiveFilterLabelSource, filterLabelMode, labels, localLabelThreadMapByAccount, activeAccountId, localPinnedThreads, pinnedThreads, activeThreadId, drafts, draftTimestamps, activeAccountObj]);

  // Nhãn Zalo đầu tiên (theo thứ tự nhãn của tài khoản) của mỗi hội thoại: tính 1 lần khi nhãn đổi, thay vì mỗi hàng
  // quét toàn bộ nhãn × danh sách hội thoại của nhãn ở mỗi lần render
  const firstZaloLabelIndex = useMemo(() => {
    const index = new Map<string, Map<string, { label: LabelData; order: number }>>();
    for (const [zaloId, accountLabels] of Object.entries(allLabels)) {
      const byConversation = new Map<string, { label: LabelData; order: number }>();
      (accountLabels || []).forEach((label, order) => {
        for (const conversationId of label.conversations || []) {
          if (!byConversation.has(conversationId)) byConversation.set(conversationId, { label, order });
        }
      });
      index.set(zaloId, byConversation);
    }
    return index;
  }, [allLabels]);

  const nonMemberSectionIndex = filter === 'others' && !mergedInboxMode
    ? filtered.findIndex(contact => isTelegramNonMember(contact))
    : -1;

  // ── Chế độ Gộp trang: gộp contacts từ tất cả tài khoản được chọn ──────────
  const mergedContacts = useMemo(() => {
    if (!mergedInboxMode) return null;
    const result: import('@/store/chatStore').ContactItem[] = [];
    for (const zaloId of mergedInboxAccounts) {
      const acctContacts = contacts[zaloId] || [];
      result.push(...acctContacts);
      // My Documents ở trang chưa tải (tải bù theo id)
      const account = accountOf(zaloId);
      for (const extra of pinnedExtrasByAccount[zaloId] || []) {
        if (isMyDocumentsContact(extra, account) && !acctContacts.some(c => c.contact_id === extra.contact_id)) result.push(extra);
      }
    }
    // Draft priority: conversations with drafts sort to top; skip draft for the currently active thread.
    // Khoá tính 1 lần / hội thoại (thứ tự y hệt) — danh sách gộp có thể vài nghìn mục, sắp lại theo mỗi tin nhắn.
    const sortKeys = new Map<any, { md: number; hasDraft: boolean; draftTs: number; time: number }>();
    for (const c of result) {
      const draftKey = `${c.owner_zalo_id}_${c.contact_id}`;
      sortKeys.set(c, {
        md: isPinnedMyDocuments(c, accountOf(c.owner_zalo_id)) ? 1 : 0,
        hasDraft: c.contact_id !== activeThreadId && !!drafts[draftKey],
        draftTs: draftTimestamps[draftKey] || 0,
        time: c.last_message_time || 0,
      });
    }
    result.sort((a, b) => {
      const ka = sortKeys.get(a)!, kb = sortKeys.get(b)!;
      if (ka.md !== kb.md) return kb.md - ka.md;
      if (ka.hasDraft !== kb.hasDraft) return ka.hasDraft ? -1 : 1;
      if (ka.hasDraft && kb.hasDraft) return kb.draftTs - ka.draftTs;
      return kb.time - ka.time;
    });
    return result;
  }, [mergedInboxMode, mergedInboxAccounts, contacts, drafts, draftTimestamps, activeThreadId, accountOf, pinnedExtrasByAccount]);

  // Merge nhãn từ tất cả tài khoản trong merged mode - trùng tên thì gộp 1
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
    // Ưu tiên DB-filtered result khi có filter
    const hasFilter = channelFilter !== 'all' || !!search || filter === 'unread' || filter === 'others';
    const rawSource = (hasFilter && dbFilteredContactsWithLiveState) ? dbFilteredContactsWithLiveState : mergedContacts;

    // Account filter (from sidebar)
    const accountFiltered = mergedInboxFilterAccount
      ? rawSource.filter(c => c.owner_zalo_id === mergedInboxFilterAccount)
      : rawSource;

    // Others safety filter
    const source = filter === 'others'
      ? accountFiltered.filter(c => {
          const ownerOthers = (allOthers[c.owner_zalo_id!] || new Set()) as Set<string>;
          return ownerOthers.has(c.contact_id);
        })
      : accountFiltered.filter(c => {
          const ownerOthers = (allOthers[c.owner_zalo_id!] || new Set()) as Set<string>;
          return !ownerOthers.has(c.contact_id);
        });

    const unreadFiltered = filter === 'unread'
      ? source.filter(c => c.unread_count > 0)
      : source;

    // Label filter (memory, vì DB chưa hỗ trợ cross-account label)
    if (filter === 'label') {
      return unreadFiltered.filter(c => {
        if (effectiveFilterLabelSource === 'local') {
          const threadMap = localLabelThreadMapByAccount[c.owner_zalo_id!] || {};
          const threadLabelIds = threadMap[c.contact_id] || [];
          if (filterLabelIds.length > 0) {
            return filterLabelMode === 'all'
              ? filterLabelIds.every(id => threadLabelIds.includes(id))
              : filterLabelIds.some(id => threadLabelIds.includes(id));
          }
          return threadLabelIds.length > 0;
        } else {
          const ownerLabels: LabelData[] = allLabels[c.owner_zalo_id!] || [];
          const isGroupC = c.contact_type === 'group';
          const labelCId = isGroupC ? `g${c.contact_id}` : c.contact_id;
          if (filterLabelIds.length > 0) {
            const matchFn = (id: number) => {
              const selectedText = mergedLabels?.find(l => l.id === id)?.text;
              const matchingLabels = selectedText != null
                ? ownerLabels.filter(l => l.text === selectedText)
                : ownerLabels.filter(l => l.id === id);
              return matchingLabels.some(l => l.conversations.includes(labelCId) || l.conversations.includes(c.contact_id));
            };
            return filterLabelMode === 'all'
              ? filterLabelIds.every(matchFn)
              : filterLabelIds.some(matchFn);
          }
          return ownerLabels.some(l => l.conversations.includes(labelCId) || l.conversations.includes(c.contact_id));
        }
      });
    }

    // Unreplied filter
    if (filter === 'unreplied') {
      return unreadFiltered.filter(c => c.unread_count > 0 && c.is_replied !== 1);
    }

    return unreadFiltered;
  }, [mergedContacts, dbFilteredContactsWithLiveState, mergedInboxFilterAccount, channelFilter, search, filter, filterLabelIds, allOthers, allLabels, mergedLabels, effectiveFilterLabelSource, filterLabelMode, localLabelThreadMapByAccount]);

  const mergedUnreadCount = mergedContacts
    ? mergedContacts.reduce((s, c) => {
        const ownerOthers = (allOthers[c.owner_zalo_id!] || new Set()) as Set<string>;
        if (ownerOthers.has(c.contact_id)) return s;
        return s + (c.unread_count > 0 ? 1 : 0);
      }, 0) : 0;

  const mergedOthersUnreadCount = mergedContacts
    ? mergedContacts.reduce((s, c) => {
        const ownerOthers = (allOthers[c.owner_zalo_id!] || new Set()) as Set<string>;
        if (!ownerOthers.has(c.contact_id) || isTelegramNonMember(c)) return s;
        return s + (c.unread_count > 0 ? 1 : 0);
      }, 0) : 0;

  // Sentinel cuộn vô hạn có đang hiển thị: observer phải gắn lại khi sentinel xuất hiện SAU lần render đầu
  // (danh sách tải xong / trang lỗi được thử lại) — trước đây chỉ gắn khi đổi panel, bộ lọc hoặc tài khoản.
  const showConversationSentinel = displayCount < (mergedInboxMode ? (filteredMerged?.length ?? 0) : filtered.length)
    || (!mergedInboxMode && conversationHasMore);

  // Infinite scroll: IntersectionObserver trên sentinel element
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = listContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setDisplayCount(prev => prev + CONVERSATION_DISPLAY_STEP);
          loadMoreConversationsRef.current();
        }
      },
      // Hiện thêm trước khi cuộn chạm cuối danh sách (đỡ khựng khi cuộn)
      { root: container, threshold: 0.1, rootMargin: '0px 0px 600px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [searchPanelOpen, filter, activeAccountId, showConversationSentinel]); // re-attach khi panel/filter/account/sentinel thay đổi

  // ── Chế độ nhân viên: kết nối BOSS phục hồi → tải lại phần đang hiển thị (lỗi trong lúc mất kết nối đã được
  // giữ dữ liệu cũ, giờ làm mới): cờ + nhãn (appStore), Nhãn Local, ghim, hội thoại, tin nhắn hội thoại đang mở nếu
  // lần tải trước lỗi (trống).
  useEmployeeResync(async () => {
    const accountId = useAccountStore.getState().activeAccountId;
    const ids = mergedInboxMode && mergedInboxAccounts.length > 0 ? mergedInboxAccounts : (accountId ? [accountId] : []);
    if (ids.length === 0) return;
    const tasks: Promise<unknown>[] = [useAppStore.getState().reloadEmployeeData(ids)];
    for (const id of ids) {
      tasks.push(loadLocalLabelsForAccount(id));
      const isActiveList = !mergedInboxMode && id === accountId;
      const listEmpty = !(useChatStore.getState().contacts[id]?.length);
      // Trang đầu: tải lại (lần đầu lỗi / danh sách trống → đặt lại phân trang; còn lại chỉ gộp, giữ phần đã tải)
      tasks.push(loadFirstConversationPage(id, isActiveList && (paging.failedPage === 'first' || listEmpty)));
      // Trang tiếp theo vừa lỗi → thử lại ngay
      if (isActiveList && paging.failedPage === 'more') loadMoreConversationsRef.current();
    }
    if (accountId) {
      reloadLocalPins(accountId);
      const acc = useAccountStore.getState().getActiveAccount();
      if (acc && isZalo(acc.channel)) reloadZaloPins(accountId, buildZaloAuth(acc, accountId));
      // Hội thoại đang mở → tải trang tin mới nhất. Chưa có tin (lần tải lúc mất kết nối lỗi) → đặt luôn. Đã có tin →
      // gộp: tin trong trang mới lấy bản của Boss (thu hồi / cảm xúc / sửa trong lúc mất kết nối), giữ tin cũ hơn đã
      // tải + tin đang gửi (temp_). Mất kết nối lâu / Boss khởi động lại (catch-up không phát lại được) thì tin đã lỡ
      // chỉ về qua đây — trước đây hội thoại đang mở thiếu tin tới khi mở lại.
      const chat = useChatStore.getState();
      const threadId = chat.activeThreadId;
      if (threadId && !chat.activeTopicId) {
        tasks.push(DataAccessor.getMessages({ zaloId: accountId, threadId, limit: MESSAGE_LOAD_LIMIT, offset: 0 }).then((res: any) => {
          const msgs: any[] = res?.messages || res?.items || [];
          if (isReadFailure(res) || msgs.length === 0) return;
          const latest = useChatStore.getState();
          if (latest.activeThreadId !== threadId || latest.activeTopicId || useAccountStore.getState().activeAccountId !== accountId) return;
          const fresh = [...msgs].reverse();
          const cached = latest.messages[getMessageCacheKey(accountId, threadId)] || [];
          if (cached.length === 0) {
            latest.setMessages(accountId, threadId, fresh);
            return;
          }
          const isTemp = (m: any) => String(m.msg_id || '').startsWith('temp_');
          const freshIds = new Set(fresh.map((m: any) => String(m.msg_id)));
          const newestCached = cached.reduce((max, m) => (isTemp(m) ? max : Math.max(max, Number(m.timestamp || 0))), 0);
          const oldestFresh = fresh.reduce((min, m: any) => Math.min(min, Number(m.timestamp || 0)), Number.POSITIVE_INFINITY);
          // Trang mới đầy và toàn tin mới hơn bộ nhớ → giữa hai phần có thể còn khoảng trống: thay hẳn (giữ tin đang gửi)
          const kept = fresh.length >= MESSAGE_LOAD_LIMIT && oldestFresh > newestCached
            ? cached.filter(isTemp)
            : cached.filter((m) => !freshIds.has(String(m.msg_id)));
          const merged = [...kept, ...fresh].sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));
          latest.setMessages(accountId, threadId, merged);
        }));
      }
    }
    await Promise.allSettled(tasks);
  });


  // ── Helper: thực sự tìm kiếm SĐT với tài khoản đã xác định ──────────────────
  const doPhoneSearch = async (acc: import('@/store/accountStore').AccountInfo, phone: string) => {
    if (!channelSupports((acc.channel || CHANNEL.ZALO) as Channel, 'supportsCRMSearch')) { setPhoneResult({ _notFound: true }); setPhoneSearching(false); return; }
    setPhoneSearching(true); setPhoneResult(null);
    try {
      const auth = buildZaloAuth(acc);
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

  // Ref để debounce labels load - không gọi quá 1 lần / 1 tiếng
  const lastLabelsFetchRef = useRef<number>(0);
  const loadLabelsIfStale = async () => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc || !channelSupports(acc.channel || CHANNEL.ZALO, 'supportsLabel')) return; // Labels are Zalo-only
    const now = Date.now();
    if (now - lastLabelsFetchRef.current < LABELS_DEBOUNCE_MS) return;
    lastLabelsFetchRef.current = now;
    const auth = buildZaloAuth(acc, activeAccountId);
    try {
      const res = await zaloApi('getLabels', { auth });
      if (res?.response?.labelData) {
        setLabels(activeAccountId, res.response.labelData);
        setLabelsVersion(res.response.version || 0);
      }
    } catch {}
  };

  /** Kiểm tra contact chỉ có UID chưa có tên thật (do getUserInfo chập chờn) */
  const isUidOnlyName = (c: { display_name?: string; alias?: string; contact_id: string } | undefined): boolean => {
    if (!c) return true;
    if (c.alias) return false;
    const dn = c.display_name || '';
    return !dn || dn === c.contact_id || /^\d{8,15}$/.test(dn);
  };

  const handleSelect = async (contactId: string, threadType: number, overrideZaloId?: string) => {
    // Đọc activeAccountId trực tiếp từ store, tránh closure stale
    const currentAccountId = useAccountStore.getState().activeAccountId || activeAccountId;
    const zaloId = overrideZaloId || currentAccountId;
    if (!zaloId) {
      console.warn(`[ConversationList] handleSelect: no zaloId (activeAccountId=${currentAccountId})`);
      return;
    }

    setForumChatId(null);
    setForumAccountId(null);
    // Clear topic state so that re-selecting the same forum group shows the topic panel
    useChatStore.setState({ activeTopicId: null, activeForumTopicId: null, activeTopicTitle: null });

    // Telegram Forum: NON-BLOCKING check — open chat first, check forum in background
    const accChannel = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId)?.channel || CHANNEL.ZALO;
    const selectedContact = (contacts[zaloId] || []).find(c => c.contact_id === contactId);
    const isTgGroup = threadType === 1 && isTelegramUser(selectedContact?.channel || accChannel);

    // Tin trong máy được hỏi TRƯỚC mọi lệnh khác: main xử lý IPC lần lượt (SQLite đồng bộ) nên các lệnh ghi bên dưới (đã
    // đọc, cờ @…) không được chen trước db:getMessages. Hội thoại đã có tin trong bộ nhớ thì hiện ngay; phần đã cuộn lên
    // xem lần trước được cắt về trang mới nhất (như khi đọc DB) để lần vẽ đầu không phải dựng hàng trăm tin.
    const messageKey = getMessageCacheKey(zaloId, contactId);
    const cachedMessages = useChatStore.getState().messages[messageKey];
    if (cachedMessages && useChatStore.getState().activeThreadId !== contactId) {
      const newest = newestMessages(cachedMessages, MESSAGE_LOAD_LIMIT);
      if (newest !== cachedMessages) setMessages(zaloId, contactId, [...newest]);
    }
    const messagesRequest = DataAccessor.getMessages({ zaloId, threadId: contactId, limit: MESSAGE_LOAD_LIMIT, offset: 0 });

    // Always open chat first (non-blocking) — clear topic state
    useChatStore.setState({
      activeThreadId: contactId,
      activeThreadType: threadType,
      activeTopicId: null,
      activeForumTopicId: null,
      activeTopicTitle: null,
      messagesLoading: true,
    });
    if (isMobile) setMobileShowChat(true);
    DataAccessor.markAsRead({ zaloId, contactId }).catch(() => {});
    // Telegram needs an MTProto read acknowledgement as well as the local DB
    // unread reset (ReadHistory + @-mentions + reactions). This applies to channels,
    // groups, forums and their topics. Facebook: read receipt (was missing here).
    // Zalo: sendSeenForThread once the messages are loaded (below).
    const openedChannel = selectedContact?.channel || accChannel;
    if (isTelegramUser(openedChannel) || isFacebook(openedChannel)) {
      void import('@/lib/adapters/registry')
        .then(({ getAdapter }) => getAdapter(isFacebook(openedChannel) ? 'facebook' : 'telegram_user')
          .markAsRead({ accountId: zaloId, threadId: contactId }))
        .catch(() => {});
    }
    clearUnread(zaloId, contactId);
    // Clear @mention flag when conversation is opened — chỉ khi cờ đang bật / chưa biết: mỗi lần ghi là 1 lệnh DB + phát
    // event cho nhân viên + sắp lại cả danh sách hội thoại.
    const openedContact = (useChatStore.getState().contacts[zaloId] || []).find(c => c.contact_id === contactId);
    if (!openedContact || openedContact.has_mention !== 0) {
      DataAccessor.setContactFlags?.({ zaloId, contactId, flags: { has_mention: 0 } }).catch(() => {});
      updateContact(zaloId, { contact_id: contactId, has_mention: 0 } as any);
    }
    ipc.app?.setBadge(getFilteredUnreadCount());
    if (!overrideZaloId) loadLabelsIfStale();

    // Forum check: DB first → API if null
    if (isTgGroup) {
      const contact = selectedContact;
      const cachedIsForum = contact?.is_forum; // null = chưa check, 0 = not forum, 1 = forum

      if (Number(cachedIsForum) === 1) {
        // Already known forum → show panel immediately
        setForumChatId(contactId);
        setForumChatName(contact?.display_name || contactId);
        setForumAccountId(zaloId);
      } else {
        // Revalidate groups that are not already known forums. A forum can be
        // enabled after the first sync, so a cached `0` must not hide topics.
        (async () => {
          try {
            const adapter = (await import('@/lib/adapters/registry')).getAdapter('telegram_user');
            // The main process checks its authoritative Telegram peer registry
            // first and heals a stale contacts.is_forum flag when necessary.
            const forumRes = await (adapter as any).isForum({ accountId: zaloId, threadId: contactId, forceApi: false });
            const current = useChatStore.getState();
            const stillSelected = current.activeThreadId === contactId
              && useAccountStore.getState().activeAccountId === zaloId;
            if (!stillSelected) return;
            if (forumRes?.success && forumRes.isForum) {
              // Update contact in store
              useChatStore.getState().updateContact(zaloId, { contact_id: contactId, is_forum: 1 } as any);
              setForumChatId(contactId);
              setForumChatName(contact?.display_name || contactId);
              setForumAccountId(zaloId);
            } else if (forumRes?.success) {
              useChatStore.getState().updateContact(zaloId, { contact_id: contactId, is_forum: 0 } as any);
            }
          } catch {}
        })();
      }
    }

    // Load messages (skip if forum detected later)
    // (Forum check runs in background above — if detected, forumChatId will be set)

    try {
    const res = await messagesRequest;
    const dbMessages = res?.messages || res?.items || [];
    if (dbMessages.length > 0) {
      // Build lookup map for reply_to_id → original message content
      const msgLookup = new Map<string, { content: string; type: string }>();
      for (const m of dbMessages) {
        msgLookup.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
      }
      const missingLookup: Array<{ msg: any; replyToId: string }> = [];
      const mapped = dbMessages.map((m: any) => {
        // Telegram quote repair is thread-scoped and may require MTProto. The
        // generic account-wide lookup below can collide on channel msg IDs.
        if (m.channel !== 'telegram_user' && m.reply_to_id && !m.quote_data) {
          const orig = msgLookup.get(m.reply_to_id);
          if (orig) {
            return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
          }
          // Original not in loaded batch - defer async DB lookup
          missingLookup.push({ msg: m, replyToId: m.reply_to_id });
          return m;
        }
        return m;
      });
      const page = [...mapped].reverse();
      // Bộ nhớ đã đúng trang này (mở lại hội thoại vừa xem) → giữ mảng cũ, khỏi vẽ lại mọi tin ngay sau khi vừa hiện
      if (!isSameMessagePage(useChatStore.getState().messages[messageKey], page)) setMessages(zaloId, contactId, page);
      // Gửi sự kiện đã đọc — truyền lastMsg để tránh query lại DB
      const lastMsg = dbMessages[0]; // already sorted DESC
      sendSeenForThread(zaloId, contactId, threadType, null, lastMsg);
      // Async fixup: batch query DB for original messages not in the loaded batch
      if (missingLookup.length > 0) {
        (async () => {
          try {
            const replyIds = [...new Set(missingLookup.map(item => item.replyToId))];
            const batchRes = await DataAccessor.getMessagesByIds({ zaloId, msgIds: replyIds });
            const origMsgs = batchRes?.messages || [];
            const origMap = new Map<string, any>();
            for (const m of origMsgs) origMap.set(m.msg_id, m);

            const store = useChatStore.getState();
            const key = `${zaloId}_${contactId}`;
            let msgs = store.messages[key];
            if (!msgs) return;
            let changed = false;
            const updated = msgs.slice();
            for (const item of missingLookup) {
              const origMsg = origMap.get(item.replyToId);
              if (!origMsg?.msg_type && !origMsg?.content) continue;
              const idx = updated.findIndex((m2: any) => m2.msg_id === item.msg.msg_id);
              if (idx >= 0 && !(updated[idx] as any).quote_data) {
                updated[idx] = {
                  ...updated[idx],
                  quote_data: JSON.stringify({
                    msgId: item.replyToId,
                    msg: origMsg.content || '',
                    senderId: '',
                    msgType: origMsg.msg_type || 'text',
                  }),
                };
                changed = true;
              }
            }
            if (changed) store.setMessages(zaloId, contactId, updated);
          } catch {}
        })();
      }
      // Sync is_replied dựa trên tin nhắn cuối thực tế
      syncRepliedState(zaloId, contactId, zaloId);
      // Facebook: tin rỗng trong trang mới nhất (tin mẫu / đính kèm mà bản cũ chưa đọc được) → tải lại trang mới nhất qua
      // bridge (lưu DB sửa đúng hàng rỗng) rồi vá các tin đó. Chỉ khi có hàng rỗng nên không tốn mạng mỗi lần mở.
      const emptyFbIds = isFacebook(accChannel) ? dbMessages.filter(isEmptyFacebookRow).map((m: any) => String(m.msg_id)) : [];
      if (emptyFbIds.length > 0) {
        void (async () => {
          try {
            const res: any = await ipc.fb?.fetchOlderMessages({ accountId: zaloId!, threadId: contactId });
            if (!res?.success || !(res.stored > 0)) return;
            const fixed = await DataAccessor.getMessagesByIds({ zaloId: zaloId!, msgIds: emptyFbIds });
            for (const row of fixed?.messages || []) {
              if (isEmptyFacebookRow(row)) continue;
              useChatStore.getState().patchMessage(zaloId!, contactId, row.msg_id, {
                content: row.content, msg_type: row.msg_type, attachments: row.attachments, is_recalled: row.is_recalled,
              } as any);
            }
          } catch { /* lần mở sau thử lại */ }
        })();
      }
    } else {
      // Employee mode: load từ REST API qua DataAccessor
      const isEmp = useEmployeeStore.getState().mode === 'employee';
      if (isEmp) {
        try {
          const result = await DataAccessor.getMessages({ zaloId: zaloId!, threadId: contactId, limit: MESSAGE_LOAD_LIMIT });
          const msgs = result?.items || [];
          console.log(`[ConversationList] handleSelect: loaded ${msgs.length} msgs from REST for ${contactId}`);
          if (msgs.length > 0) {
            setMessages(zaloId!, contactId, [...msgs].reverse());
          }
        } catch (err) {
          console.warn(`[ConversationList] handleSelect REST error:`, err);
        }
      } else {
        // Boss/standalone: fallback — dùng DataAccessor (-> IPC -> DB)
        console.log(`[ConversationList] handleSelect: boss mode, loading from IPC...`);
        try {
          const result = await DataAccessor.getMessages({ zaloId: zaloId!, threadId: contactId, limit: MESSAGE_LOAD_LIMIT });
          const msgs = result?.items || [];
          if (msgs.length > 0) {
            setMessages(zaloId!, contactId, [...msgs].reverse());
          } else {
            console.warn(`[ConversationList] handleSelect: no messages found in DB for ${contactId}`);
            // For Telegram: try to get messages from API when DB is empty
            if (isTelegramUser(accChannel)) {
              try {
                const tgRes = await ipc.telegramUser?.getMessages({ accountId: zaloId!, chatId: contactId, limit: MESSAGE_LOAD_LIMIT });
                if (tgRes?.success && tgRes.messages?.length) {
                  setMessages(zaloId!, contactId, [...tgRes.messages].reverse());
                  // Update contact last_message/last_message_time from newest message
                  const newest = tgRes.messages[0];
                  if (newest) {
                    const content = newest.content || '';
                    const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;
                    useChatStore.getState().updateContact(zaloId!, {
                      contact_id: contactId,
                      last_message: preview,
                      last_message_time: newest.timestamp || Date.now(),
                    });
                  }
                }
              } catch (tgErr) {
                console.warn(`[ConversationList] Telegram getMessages fallback error:`, tgErr);
              }
            } else if (isFacebook(accChannel)) {
              // The initial Facebook refresh persists bridge history. This
              // fallback covers a thread opened before that background sync
              // reaches it; regular chats are available through GraphQL.
              try {
                // Trang mới nhất: hội thoại chưa có tin nào trong máy làm mốc cho FetchMessagesTask → main lấy qua GraphQL
                // (source 'graphql', đã thử thì không gọi lại); bridge chưa chạy / bản cũ → đường GraphQL cũ. Hội thoại
                // mã hoá đầu cuối: Facebook không cho tải tin cũ.
                const bridgeRes: any = await ipc.fb?.fetchOlderMessages({ accountId: zaloId!, threadId: contactId });
                const fbRes: any = bridgeRes?.success || bridgeRes?.code === 'E2EE' || bridgeRes?.source === 'graphql'
                  ? bridgeRes
                  : await ipc.fb?.fetchThreadMessages({ accountId: zaloId!, threadId: contactId, limit: MESSAGE_LOAD_LIMIT });
                if (fbRes?.success) {
                  const refreshed = await DataAccessor.getMessages({
                    zaloId: zaloId!, threadId: contactId, limit: MESSAGE_LOAD_LIMIT,
                  });
                  const refreshedMessages = refreshed?.messages || refreshed?.items || [];
                  if (refreshedMessages.length > 0) {
                    setMessages(zaloId!, contactId, [...refreshedMessages].reverse());
                  }
                }
              } catch (fbErr) {
                console.warn(`[ConversationList] Facebook history fallback error:`, fbErr);
              }
            }
          }
        } catch (err) {
          console.warn(`[ConversationList] handleSelect error:`, err);
        }
      }
    }
    } catch (err) {
      console.warn(`[ConversationList] handleSelect error:`, err);
    } finally {
      useChatStore.getState().setMessagesLoading(false);
    }

    // Auto-fetch contact info nếu chỉ có UID chưa có tên thật (fire-and-forget)
    if (threadType === 0) {
      const contacts = useChatStore.getState().contacts[zaloId!] || [];
      const contact = contacts.find(c => c.contact_id === contactId);
      if (isUidOnlyName(contact)) {
        const acc = overrideZaloId
          ? useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId)
          : useAccountStore.getState().getActiveAccount();
        if (acc && isZalo(acc.channel)) {
          const auth = buildZaloAuth(acc, zaloId || activeAccountId);
          ipc.zalo?.getUserInfo({ auth, zaloId, userId: contactId })
            .then((res: any) => {
              const rawProfile = res?.response?.changed_profiles?.[contactId]
                || res?.response?.data?.[contactId];
              if (!rawProfile) return;
              const { displayName, avatar, phone, gender, birthday, alias } = extractUserProfile(rawProfile);
              if (!displayName) return;
              const patch: any = { contact_id: contactId, display_name: displayName };
              if (avatar) patch.avatar_url = avatar;
              if (phone) patch.phone = phone;
              if (alias) patch.alias = alias;
              useChatStore.getState().updateContact(zaloId!, patch);
              DataAccessor.updateContactProfile({
                zaloId: zaloId!, contactId, displayName, avatarUrl: avatar, phone, gender, birthday,
              }).catch(() => {});
              if (alias) {
                DataAccessor.setContactAlias({ zaloId: zaloId!, contactId, alias }).catch(() => {});
              }
            })
            .catch(() => {});
        }
        // Telegram: fetch user profile if name is missing
        if (acc && isTelegramUser(acc.channel)) {
          ipc.telegramUser?.getUserProfile({ accountId: zaloId!, userId: contactId })
            .then((res: any) => {
              if (!res?.success || !res.profile) return;
              const profile = res.profile;
              const displayName = profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || '';
              if (!displayName) return;
              const patch: any = { contact_id: contactId, display_name: displayName };
              if (profile.avatar) patch.avatar_url = profile.avatar;
              if (profile.username) patch.username = profile.username;
              useChatStore.getState().updateContact(zaloId!, patch);
              DataAccessor.updateContactProfile({
                zaloId: zaloId!, contactId, displayName, avatarUrl: profile.avatar || '',
              }).catch(() => {});
            })
            .catch(() => {});
        }
      }
      // Daily alias background refresh cho contact đã có tên thật
      if (!isUidOnlyName(contact)) {
        refreshContactAlias(zaloId!, contactId);
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
  // CHỈ khôi phục UI state — KHÔNG gửi read receipt (handleSelect gửi read receipt)
  useEffect(() => {
    if (isManualSelectingRef.current) {
      isManualSelectingRef.current = false;
      return;
    }
    if (!activeAccountId) { setActiveThread(null); return; }
    const saved = useChatStore.getState().perAccountThread[activeAccountId];
    if (saved?.threadId) {
      // Restore UI state only — no read receipt to server
      useChatStore.setState({
        activeThreadId: saved.threadId,
        activeThreadType: saved.threadType,
        activeTopicId: null,
        activeForumTopicId: null,
        activeTopicTitle: null,
        messagesLoading: true,
      });
      // Load messages from DB
      DataAccessor.getMessages({ zaloId: activeAccountId, threadId: saved.threadId, limit: MESSAGE_RESTORE_LIMIT, offset: 0 }).then((res: any) => {
        const msgs = res?.items || res?.messages || [];
        if (msgs.length > 0) {
          useChatStore.getState().setMessages(activeAccountId, saved.threadId, [...msgs].reverse());
        }
        useChatStore.getState().setMessagesLoading(false);
      }).catch(() => { useChatStore.getState().setMessagesLoading(false); });
    } else {
      setActiveThread(null);
    }
}, [activeAccountId]);


  /** Chọn hội thoại trong chế độ Gộp trang - tự động chuyển tài khoản */
  const handleMergedClick = async (contact: import('@/store/chatStore').ContactItem) => {
    const zaloId = contact.owner_zalo_id;
    if (!zaloId) return;
    // Lưu thread hiện tại trước khi chuyển
    if (activeAccountId && activeThreadId) {
      saveAccountThread(activeAccountId, activeThreadId, activeThreadType);
    }
    // Đánh dấu thủ công để effect không override
    isManualSelectingRef.current = true;
    // Chuyển tài khoản - zustand cập nhật đồng bộ
    setActiveAccount(zaloId);
    const threadType = contact.contact_type === 'group' ? 1 : 0;
    await handleSelect(contact.contact_id, threadType, zaloId);
    setFilterDropdownOpen(false);
  };

  /** Thao tác nhanh (tạo / tham gia nhóm, thêm bạn) xong → mở hội thoại, đổi tài khoản nếu thao tác bằng tài khoản khác. */
  const openQuickActionConversation: OpenQuickConversation = (accountId, threadId, threadType, info) => {
    if (!accountId || !threadId) return;
    const existing = (useChatStore.getState().contacts[accountId] || []).find(c => c.contact_id === threadId);
    updateContact(accountId, {
      contact_id: threadId,
      ...(info?.display_name && isUidOnlyName(existing) ? { display_name: info.display_name } : {}),
      ...(info?.avatar_url && !existing?.avatar_url ? { avatar_url: info.avatar_url } : {}),
      ...(info?.channel ? { channel: info.channel as Channel } : {}),
      ...(existing ? {} : { contact_type: threadType === 1 ? 'group' : 'user', last_message_time: Date.now() }),
    });
    setSearchPanelOpen(false);
    if (accountId !== useAccountStore.getState().activeAccountId) {
      if (activeAccountId && activeThreadId) saveAccountThread(activeAccountId, activeThreadId, activeThreadType);
      isManualSelectingRef.current = true;
      setActiveAccount(accountId);
      void handleSelect(threadId, threadType, accountId);
    } else {
      void handleSelect(threadId, threadType);
    }
  };


  const handleTogglePin = async (contactId: string, threadType: number) => {
    const acc = useAccountStore.getState().getActiveAccount(); if (!acc) return;
    const wasPinned = pinnedThreads.has(contactId);
    if (!channelSupports(acc.channel || CHANNEL.ZALO, 'supportsPinConversation')) {
      await handleToggleLocalPin(contactId);
      return;
    }
    // Telegram: đồng bộ pin lên Telegram server
    if (isTelegramUser(acc.channel)) {
      const result = await ipc.telegramUser?.setDialogPin({ accountId: acc.zalo_id, chatId: contactId, pinned: !wasPinned });
      if (result?.success) {
        setZaloPinsByAccount(prev => withThreadPinned(prev, acc.zalo_id, contactId, !wasPinned));
        showNotification(wasPinned ? 'Đã bỏ ghim hội thoại' : 'Đã ghim hội thoại', 'success');
      } else {
        showNotification('Lỗi ghim: ' + (result?.error || 'Không thể ghim'), 'error');
      }
      setCtxMenu(null);
      return;
    }
    const auth = buildZaloAuth(acc, activeAccountId);
    const result = await zaloApi('setPinConversation', { auth, conversations: [{ threadId: contactId, type: threadType }], isPin: !wasPinned });
    if (result?.success) {
      setZaloPinsByAccount(prev => withThreadPinned(prev, acc.zalo_id, contactId, !wasPinned));
      showNotification(wasPinned ? 'Đã bỏ ghim hội thoại' : 'Đã ghim hội thoại', 'success');
    } else {
      showNotification('Lỗi ghim: ' + (result?.error || 'Không thể ghim'), 'error');
    }
    setCtxMenu(null);
  };

  // ─── Tự động đánh dấu đã đọc: phạm vi = tài khoản đang xem (hoặc các tài khoản Gộp trang) của kênh đang lọc ──
  const autoReadAccountIds = React.useMemo(() => {
    const base = mergedInboxMode && mergedInboxAccounts.length ? mergedInboxAccounts : (activeAccountId ? [activeAccountId] : []);
    return base.filter(id => channelFilter === 'all' || (allAccountsList.find(a => a.zalo_id === id)?.channel || CHANNEL.ZALO) === channelFilter);
  }, [mergedInboxMode, mergedInboxAccounts, activeAccountId, channelFilter, allAccountsList]);
  const autoReadScopeLabel = React.useMemo(() => {
    if (autoReadAccountIds.length === 0) return 'không có tài khoản phù hợp kênh đang lọc';
    const names = autoReadAccountIds.map(id => {
      const account = allAccountsList.find(a => a.zalo_id === id);
      return account?.full_name || (account as any)?.display_name || id;
    });
    const channelPart = channelFilter !== 'all' ? ` · kênh ${getChannelLabel(channelFilter as Channel)}` : '';
    return (names.length <= 2 ? names.join(', ') : `${names.length} tài khoản`) + channelPart;
  }, [autoReadAccountIds, allAccountsList, channelFilter]);

  // ─── Tin đánh dấu ──────────────────────────────────────────────────────────
  const starredAccountIds = React.useMemo(
    () => (mergedInboxMode && mergedInboxAccounts.length ? mergedInboxAccounts : (activeAccountId ? [activeAccountId] : [])),
    [mergedInboxMode, mergedInboxAccounts, activeAccountId],
  );
  // Số tin đánh dấu theo đúng phạm vi panel: gộp trang → mọi tài khoản đang gộp (hoặc tài khoản đang lọc)
  const starredCountIds = React.useMemo(() => {
    if (mergedInboxMode && mergedInboxFilterAccount && starredAccountIds.includes(mergedInboxFilterAccount)) {
      return [mergedInboxFilterAccount];
    }
    return starredAccountIds;
  }, [mergedInboxMode, mergedInboxFilterAccount, starredAccountIds]);
  const starredCount = useStarredStore(s => starredCountIds.reduce((sum, id) => sum + (s.keys[id]?.size || 0), 0));
  useEffect(() => {
    for (const id of starredCountIds) void useStarredStore.getState().load(id);
  }, [starredCountIds]);

  /** Mở hội thoại của tin đánh dấu rồi nhảy tới tin (ChatWindow chờ hội thoại tải xong mới nhảy). */
  const openStarredMessage = (item: StarredItem) => {
    if (item.ownerId && item.ownerId !== activeAccountId) {
      isManualSelectingRef.current = true;
      setActiveAccount(item.ownerId);
      handleSelect(item.threadId, item.threadType, item.ownerId);
    } else if (item.threadId !== activeThreadId) {
      handleSelect(item.threadId, item.threadType);
    }
    window.dispatchEvent(new CustomEvent('chat:jumpToMessage', {
      detail: { accountId: item.ownerId || activeAccountId, threadId: item.threadId, messageId: item.msgId },
    }));
  };

  const handleToggleLocalPin = async (contactId: string) => {
    const zId = activeAccountId; if (!zId) return;
    const wasPinned = localPinnedThreads.has(contactId);
    const res: any = await DataAccessor.setLocalPinnedConversation({ zaloId: zId, threadId: contactId, isPinned: !wasPinned });
    setCtxMenu(null);
    // Nhân viên: Boss từ chối / mất kết nối → báo lỗi, không đổi trạng thái ghim trên UI (trước đây luôn báo thành công)
    if (res?.success === false) {
      showNotification(`Không ${wasPinned ? 'bỏ ghim' : 'ghim'} được: ${res.error || 'lỗi không xác định'}`, 'error');
      return;
    }
    setLocalPinsByAccount(prev => withThreadPinned(prev, zId, contactId, !wasPinned));
    showNotification(wasPinned ? 'Đã bỏ ghim khỏi app' : 'Đã ghim trong app', 'success');
  };

  const handleMute = (contactId: string, until: number, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    setMuted(zId, contactId, until);
    showNotification('Đã tắt thông báo', 'success');
    setMuteSubmenuId(null); setCtxMenu(null);
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (accObj && isTelegramUser(accObj.channel)) {
      const muteUntil = until === 0 ? 2147483647 : Math.floor(until / 1000);
      ipc.telegramUser?.setDialogMute({ accountId: zId, chatId: contactId, muteUntil })
        .then(res => { if (!res?.success) showNotification(res?.error || 'Không thể đồng bộ tắt thông báo với Telegram', 'error'); })
        .catch(() => showNotification('Không thể đồng bộ tắt thông báo với Telegram', 'error'));
      useChatStore.getState().updateContact(zId, { contact_id: contactId, is_muted: until === 0 ? 1 : 0, mute_until: until === 0 ? 0 : until } as any);
      return;
    }
    if (!accObj || !channelSupports(accObj.channel || CHANNEL.ZALO, 'supportsMuteSync')) return;
    const auth = buildZaloAuth(accObj);
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    const duration = muteUntilToDuration(until);
    zaloApi('setMute', { auth, threadId: contactId, threadType, duration, action: 1 }).catch(() => {});
  };

  const handleUnmute = (contactId: string, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    clearMuted(zId, contactId);
    showNotification('Đã bật thông báo', 'success');
    setMuteSubmenuId(null); setCtxMenu(null);
    const accObj2 = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (accObj2 && isTelegramUser(accObj2.channel)) {
      ipc.telegramUser?.setDialogMute({ accountId: zId, chatId: contactId, muteUntil: 0 })
        .then(res => { if (!res?.success) showNotification(res?.error || 'Không thể đồng bộ bật thông báo với Telegram', 'error'); })
        .catch(() => showNotification('Không thể đồng bộ bật thông báo với Telegram', 'error'));
      useChatStore.getState().updateContact(zId, { contact_id: contactId, is_muted: 0, mute_until: 0 } as any);
      return;
    }
    if (!accObj2 || !channelSupports((accObj2.channel || CHANNEL.ZALO) as Channel, 'supportsMuteSync')) return;
    const auth = { cookies: accObj2.cookies, imei: accObj2.imei, userAgent: accObj2.user_agent };
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    zaloApi('setMute', { auth, threadId: contactId, threadType, action: 3 }).catch(() => {});
  };

  const handleMoveToOthers = (contactId: string, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    addToOthers(zId, contactId);
    setMuted(zId, contactId, 0);
    showNotification('Đã chuyển vào thư mục Khác và tắt thông báo', 'success');
    setCtxMenu(null);
    // Cập nhật badge taskbar - conversation giờ nằm trong "Khác" nên không đếm nữa
    ipc.app?.setBadge(getFilteredUnreadCount());
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj) return;
    const ch = (accObj.channel || CHANNEL.ZALO) as Channel;
    // Telegram: đồng bộ archive + mute lên Telegram server
    if (isTelegramUser(ch)) {
      ipc.telegramUser?.setDialogArchived({ accountId: zId, chatId: contactId, archived: true }).catch(() => {});
      ipc.telegramUser?.setDialogMute({ accountId: zId, chatId: contactId, muteUntil: 2147483647 }).catch(() => {});
      useChatStore.getState().updateContact(zId, { contact_id: contactId, telegram_folder_id: 1, telegram_archived: 1 });
      return;
    }
    if (!channelSupports(ch, 'supportsMuteSync')) return;
    const auth = buildZaloAuth(accObj);
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    zaloApi('setMute', { auth, threadId: contactId, threadType, duration: -1, action: 1 }).catch(() => {});
  };

  const handleRemoveFromOthers = (contactId: string, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    removeFromOthers(zId, contactId);
    clearMuted(zId, contactId);
    showNotification('Đã chuyển về danh sách chính và bật thông báo', 'success');
    // Cập nhật badge taskbar - conversation giờ quay lại danh sách chính
    ipc.app?.setBadge(getFilteredUnreadCount());
    setCtxMenu(null);
    const accObj2 = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj2) return;
    const ch2 = (accObj2.channel || CHANNEL.ZALO) as Channel;
    // Telegram: đồng bộ unarchive + unmute lên Telegram server
    if (isTelegramUser(ch2)) {
      ipc.telegramUser?.setDialogArchived({ accountId: zId, chatId: contactId, archived: false }).catch(() => {});
      ipc.telegramUser?.setDialogMute({ accountId: zId, chatId: contactId, muteUntil: 0 }).catch(() => {});
      useChatStore.getState().updateContact(zId, { contact_id: contactId, telegram_folder_id: 0, telegram_archived: 0 });
      return;
    }
    if (!channelSupports(ch2, 'supportsMuteSync')) return;
    const auth2 = { cookies: accObj2.cookies, imei: accObj2.imei, userAgent: accObj2.user_agent };
    const contact = (useChatStore.getState().contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;
    zaloApi('setMute', { auth: auth2, threadId: contactId, threadType, action: 3 }).catch(() => {});
  };

  const handleMarkRead = async (contactId: string, asRead: boolean, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    const isZaloAcc = accObj && isZalo(accObj.channel);
    const auth = (isZaloAcc && accObj) ? buildZaloAuth(accObj) : null;
    const contact = (contacts[zId] || []).find(c => c.contact_id === contactId);
    const threadType = contact?.contact_type === 'group' ? 1 : 0;

    if (asRead) {
      // App (DB + store, cả dấu @) rồi nền tảng: Zalo seen + bỏ dấu chưa đọc, Telegram ReadHistory + @/reaction, Facebook
      void markConversationRead({ accountId: zId, threadId: contactId, threadType });
    } else {
      useChatStore.getState().updateContact(zId, { contact_id: contactId, unread_count: 1 });
      if (auth) zaloApi('addUnreadMark', { auth, threadId: contactId, type: threadType }).catch(() => {});
    }
    setCtxMenu(null);
  };

  const handleAssignLabel = async (contactId: string, labelId: number, overrideZaloId?: string) => {
    const zId = overrideZaloId || activeAccountId;
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zId);
    if (!accObj || !zId) return;
    if (!channelSupports(accObj.channel || CHANNEL.ZALO, 'supportsLabel')) {
      showNotification('Nhãn Zalo không khả dụng cho kênh Facebook', 'warning');
      return;
    }
    const auth = buildZaloAuth(accObj);

    // Use 'g' prefix for groups - consistent with Zalo's label API
    const contact = (contacts[zId] || []).find(c => c.contact_id === contactId);
    const isGroupContact = contact?.contact_type === 'group';
    const labelContactId = isGroupContact ? `g${contactId}` : contactId;

    // Helper: fetch latest labels from server
    const fetchFreshLabels = async (): Promise<{ labels: any[]; version: number } | null> => {
      const res = await zaloApi('getLabels', { auth });
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
    let result = await zaloApi('updateLabels', { auth, labelData: updated, version: freshVersion, labelDiffs });

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
        result = await zaloApi('updateLabels', { auth, labelData: updated, version: freshVersion, labelDiffs: retryDiffs });
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

    if (accObj && isZalo(accObj.channel)) {
      try {
        const auth = buildZaloAuth(accObj);
        const msgRes = await DataAccessor.getMessages({ zaloId: zId, threadId: contactId, limit: 1 });
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

    await DataAccessor.deleteConversation({ zaloId: zId, contactId });
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
    const ctxChannelCap = getCapability((contact.channel || CHANNEL.ZALO) as Channel);
    const isMuted = isMutedFn(ctxZaloId, contact.contact_id);
    const hasUnread = contact.unread_count > 0;
    const ctxOthers: Set<string> = (allOthers[ctxZaloId] || new Set()) as Set<string>;
    const ctxLabels: LabelData[] = allLabels[ctxZaloId] || [];
    // My Documents: Zalo luôn ghim ở đầu, không bỏ ghim / chuyển vào Khác / mời vào nhóm
    const ctxIsMyDocs = isMyDocumentsContact(contact, accountOf(ctxZaloId));
    return (
      <div ref={ctxRef} className="fixed z-50 bg-card border border-border rounded-xl shadow-2xl py-1 min-w-[190px]"
        style={{ top: Math.min(ctxMenu.y, window.innerHeight - 320), left: Math.min(ctxMenu.x, window.innerWidth - 210) }}>
        <CtxItem icon={hasUnread ? <CheckIcon className="w-4 h-4" /> : <CircleIcon className="w-4 h-4" />} label={hasUnread ? 'Đánh dấu đã đọc' : 'Đánh dấu chưa đọc'} onClick={() => handleMarkRead(contact.contact_id, hasUnread, ctxZaloId)} />

        {/* Mute sub-menu */}
        <div className="relative"
          onMouseEnter={() => setMuteSubmenuId(contact.contact_id)}
          onMouseLeave={() => setMuteSubmenuId(null)}>
          {isMuted ? (
            <CtxItem icon={<BellIcon className="w-4 h-4" />} label="Bật thông báo" onClick={() => handleUnmute(contact.contact_id, ctxZaloId)} />
          ) : (
            <CtxItem icon={<BellOffIcon className="w-4 h-4" />} label="Tắt thông báo" hasArrow onClick={() => {}} />
          )}
          {!isMuted && muteSubmenuId === contact.contact_id && (
            <div className="absolute left-full top-0 bg-card border border-border rounded-xl shadow-xl min-w-[200px] py-1 z-50">
              {MUTE_OPTIONS.map(opt => (
                <button key={opt.label} onClick={() => handleMute(contact.contact_id, opt.until(), ctxZaloId)}
                  className="w-full flex items-center px-4 py-2 text-sm text-foreground/80 hover:bg-muted hover:text-foreground text-left transition-colors">
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {ctxChannelCap.supportsPinConversation && !ctxIsMyDocs && (
          <CtxItem icon={isPinned ? <MapPinIcon className="w-4 h-4" /> : <PinIcon className="w-4 h-4" />} label={isPinned ? `Bỏ ghim (${isTelegramUser(contact.channel) ? 'Telegram' : 'Zalo'})` : `Ghim (đồng bộ ${isTelegramUser(contact.channel) ? 'Telegram' : 'Zalo'})`} onClick={() => handleTogglePin(contact.contact_id, threadType)} />
        )}
        {!ctxIsMyDocs && (
          <CtxItem icon={isLocalPinned ? <BookmarkIcon className="w-4 h-4" /> : <PaperclipIcon className="w-4 h-4" />} label={isLocalPinned ? 'Bỏ ghim trong app' : 'Ghim trong app'} onClick={() => handleToggleLocalPin(contact.contact_id)} />
        )}
        {ctxIsMyDocs ? null : ctxOthers.has(contact.contact_id) ? (
          <CtxItem icon={<GlobeIcon className="w-4 h-4" />} label="Chuyển về Chính" onClick={() => handleRemoveFromOthers(contact.contact_id, ctxZaloId)} />
        ) : (
          <div className="flex items-center">
            <button
              onClick={() => handleMoveToOthers(contact.contact_id, ctxZaloId)}
              className="flex-1 flex items-center gap-2 px-3 py-1.5 text-sm text-foreground/80 hover:bg-muted hover:text-foreground text-left transition-colors"
            >
              <span><FolderIcon className="w-4 h-4" /></span>
              <span>Chuyển vào Khác</span>
            </button>
            <div className="relative group pr-2">
              <span className="w-4 h-4 rounded-full border border-border-strong text-muted-foreground hover:border-gray-300 hover:text-foreground/80 flex items-center justify-center text-xs cursor-default select-none transition-colors">
                ?
              </span>
              <div className="absolute right-0 bottom-full mb-1 w-64 bg-popover border border-input rounded-lg shadow-xl p-3 text-xs text-foreground/80 leading-relaxed z-[60] hidden group-hover:block pointer-events-none">
                <p>Dùng để lưu các hội thoại không quan trọng. Các hội thoại trong thư mục này sẽ <span className="text-yellow-400 font-medium">không phát âm thanh</span> và <span className="text-yellow-400 font-medium">không hiện thông báo</span> khi có tin nhắn mới.</p>
              </div>
            </div>
          </div>
        )}

        {contact.contact_type !== 'group' && ctxChannelCap.supportsInviteToGroup && !ctxIsMyDocs && (
          <>
            <div className="border-t border-border my-1" />
            <CtxItem icon={<UsersIcon className="w-4 h-4" />} label="Mời vào nhóm" onClick={() => { setCtxMenu(null); setInviteContactId(contact.contact_id); }} />
          </>
        )}
        <div className="border-t border-border my-1" />
        <div className="flex items-center">
          <CtxItem icon={<TrashIcon className="w-4 h-4" />} label="Xóa hội thoại" onClick={() => handleDeleteConversation(contact.contact_id, ctxZaloId)} danger />
          <div className="relative group pr-2">
              <span className="w-4 h-4 rounded-full border border-border-strong text-muted-foreground hover:border-gray-300 hover:text-foreground/80 flex items-center justify-center text-xs cursor-default select-none transition-colors">
                ?
              </span>
            <div className="absolute right-0 bottom-full mb-1 w-64 bg-popover border border-input rounded-lg shadow-xl p-3 text-xs text-foreground/80 leading-relaxed z-[60] hidden group-hover:block pointer-events-none">
              <p>Chỉ xoá dữ liệu <span className="text-yellow-400 font-medium">trên app này</span></p>
            </div>
          </div>
        </div>
      </div>
    );
  })() : null;

  // Telegram keeps the topic list at full width while the selected topic is
  // open; collapsing it into an icon rail loses titles and selection context.
  if (forumChatId && forumAccountId && (!isMobile || !activeTopicId)) {
    return (
      <div className={`${isMobile ? 'w-full' : 'w-full'} border-r border-border flex-shrink-0`}>
        <ForumTopicsPanel
          accountId={forumAccountId}
          chatId={forumChatId}
          chatName={forumChatName}
          activeTopicId={activeTopicId}
          compact={false}
          onSelectTopic={(topicId, topicTitle, forumTopicId, topMessageId) => {
            useChatStore.getState().setMessages(forumAccountId, forumChatId, [], topicId);
            useChatStore.setState({
              activeThreadId: forumChatId,
              activeThreadType: 1,
              activeTopicId: topicId,
              activeForumTopicId: forumTopicId || topicId,
              activeTopicTitle: topicTitle,
              messagesLoading: true,
            });
            // Mark as read — local DB + Telegram (per-topic via ReadDiscussion)
            DataAccessor.markAsRead({ zaloId: forumAccountId, contactId: forumChatId }).catch(() => {});
            clearUnread(forumAccountId, forumChatId);
            // Gửi read receipt cho topic cụ thể (messages.ReadDiscussion)
            // topMessageId = ID tin nhắn mới nhất trong topic → dùng làm readMaxId
            void import('@/lib/adapters/registry')
              .then(({ getAdapter }) => (getAdapter('telegram_user') as any).markTopicAsRead({
                accountId: forumAccountId, threadId: forumChatId, topicId, topMessageId,
              }))
              .catch(() => {});
          }}
          onBack={() => { setForumChatId(null); setForumAccountId(null); }}
        />
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full bg-card relative w-full`}>
      {/* Search row - Zalo style */}
      <div className="px-2 pt-2 pb-1 border-b border-border flex items-center gap-1.5">
        {/* Search input wrapper */}
        <div className={`flex items-center gap-2 bg-muted/60 border rounded-full px-3 py-1.5 transition-all flex-1 min-w-0 ${searchPanelOpen ? 'border-blue-500 bg-muted' : 'border-input hover:border-border-strong'}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setSearchPanelOpen(false); setSearch(''); searchInputRef.current?.blur(); } }}
            placeholder="Tìm kiếm..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder-subtle-foreground focus:outline-none min-w-0"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); setPhoneResult(null); setSearchPanelOpen(false); searchInputRef.current?.blur(); }}
              className="w-4 h-4 rounded-full bg-accent hover:bg-gray-400 flex items-center justify-center text-gray-900 flex-shrink-0 transition-colors"
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
          <QuickActionsButton activeThread={quickActiveThread} onOpenConversation={openQuickActionConversation} />
        )}
      </div>

      {/* GlobalSearchPanel - fills remaining space below search bar when active */}
      {searchPanelOpen && (
        <div className="flex-1 overflow-hidden relative">
          <GlobalSearchPanel
            query={search}
            activeAccountId={activeAccountId}
            contacts={mergedInboxMode && mergedContacts ? mergedContacts : accountContacts}
            allAccounts={allAccountsList}
            mergedInboxMode={mergedInboxMode}
            mergedInboxAccounts={mergedInboxAccounts}
            onSelectConversation={(contactId, threadType, overrideZaloId, userInfo) => {
              // Nếu có userInfo từ phone/username search → cập nhật contact trước khi mở hội thoại
              if (userInfo) {
                const targetZaloId = overrideZaloId || activeAccountId;
                if (targetZaloId) {
                  updateContact(targetZaloId, {
                    contact_id: contactId,
                    display_name: userInfo.display_name,
                    avatar_url: userInfo.avatar_url,
                    contact_type: 'user',
                    ...(userInfo.channel ? { channel: userInfo.channel as Channel } : {}),
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

              // Message not in initial page - load messages around its timestamp
              const zaloId = msg.owner_zalo_id || activeAccountId;
              if (!zaloId || !msg.thread_id || !msg.timestamp) return;
              try {
                const aroundRes = await DataAccessor.getMessagesAround({
                  zaloId,
                  threadId: msg.thread_id,
                  timestamp: Number(msg.timestamp),
                  limit: MESSAGE_SEARCH_LIMIT,
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

      {/* Tin đánh dấu - thay chỗ tab + danh sách hội thoại */}
      {!searchPanelOpen && starredPanelOpen && (
        <StarredMessagesPanel
          accountIds={starredAccountIds}
          showChannel={mergedInboxMode}
          onOpen={openStarredMessage}
          onClose={() => setStarredPanelOpen(false)}
        />
      )}

      {/* Filter tabs + Contact list - hidden when global search / Tin đánh dấu is open */}
      {!searchPanelOpen && !starredPanelOpen && (<>
      <div className="flex border-b border-border relative">
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
            <div className="absolute top-full left-0 z-30 bg-card border border-border rounded-xl shadow-xl min-w-[220px] py-1">
              {/* Local / Zalo sub-tabs */}
              <div className="px-2 pt-1.5 pb-1 border-b border-border/60">
                <div className="flex bg-muted/60 rounded-md p-0.5 gap-0.5">
                  <button onClick={() => { setFilterLabelSource('local'); setFilterLabelIds([]); }}
                    className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                      effectiveFilterLabelSource === 'local' ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground'
                    }`}><HardDriveIcon className="w-4 h-4 inline" /> Local</button>
                  {canUseZaloLabelFilter && (
                    <button onClick={() => { setFilterLabelSource('zalo'); setFilterLabelIds([]); }}
                      className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                        effectiveFilterLabelSource === CHANNEL.ZALO ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground'
                      }`}><CloudIcon className="w-4 h-4 inline" /> Zalo</button>
                  )}
                </div>
              </div>

              {/* AND/OR filter mode radio */}
              <div className="px-2 py-1.5 border-b border-border/60">
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted/50 cursor-pointer text-xs"
                    onClick={() => setFilterLabelMode('all')}>
                    <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${filterLabelMode === 'all' ? 'border-blue-500' : 'border-border-strong'}`}>
                      {filterLabelMode === 'all' && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                    </div>
                    <span className="text-foreground/80">Tất cả nhãn đã chọn</span>
                  </label>
                  <label className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted/50 cursor-pointer text-xs"
                    onClick={() => setFilterLabelMode('any')}>
                    <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${filterLabelMode === 'any' ? 'border-blue-500' : 'border-border-strong'}`}>
                      {filterLabelMode === 'any' && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                    </div>
                    <span className="text-foreground/80">Có chứa 1 trong số nhãn</span>
                  </label>
                </div>
              </div>

              {effectiveFilterLabelSource === 'local' ? (
                /* ── Local labels list (multi-select) ── */
                <>
                  <button onClick={() => { setFilterLabelIds([]); setFilterDropdownOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left ${filterLabelIds.length === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                    <span className="w-3 h-3 rounded-full bg-accent flex-shrink-0" />
                    <span className="text-blue-700">Tất cả Nhãn Local</span>
                    {filterLabelIds.length === 0 && <span className="ml-auto text-blue-600">✓</span>}
                  </button>
                  {localLabels.length === 0 && localLabelsLoadFailed ? (
                    <LoadFailedNotice text="Không tải được Nhãn Local" onRetry={reloadVisibleLocalLabels} />
                  ) : localLabels.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-3 py-2 italic">Chưa có Nhãn Local</p>
                  ) : localLabels.map(l => {
                    const isActive = filterLabelIds.includes(l.id);
                    return (
                      <button key={l.id} onClick={() => {
                        setFilterLabelIds(prev => isActive ? prev.filter(x => x !== l.id) : [...prev, l.id]);
                      }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left ${isActive ? 'text-foreground' : 'text-foreground/80'}`}>
                        <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[10px] ${isActive ? 'bg-blue-600 border-blue-600 text-white' : 'border-border-strong'}`}>
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
                  <div className="px-3 py-1.5 border-b border-border/60 flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium">Nhãn Zalo</span>
                    <button
                      onClick={async () => {
                        if (syncingLabels) return;
                        setSyncingLabels(true);
                        try {
                          if (mergedInboxMode) {
                            for (const zaloId of mergedInboxAccounts) {
                              const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
                              if (!accObj || !channelSupports((accObj.channel || CHANNEL.ZALO) as Channel, 'supportsLabel')) continue;
                              const auth = buildZaloAuth(accObj);
                              const res = await zaloApi('getLabels', { auth });
                              if (res?.response?.labelData) setLabels(zaloId, res.response.labelData);
                            }
                            showNotification('Đã cập nhật nhãn cho tất cả tài khoản', 'success');
                          } else {
                            const acc = useAccountStore.getState().getActiveAccount();
                            if (!acc || !activeAccountId) return;
                            const auth = buildZaloAuth(acc, activeAccountId);
                            const res = await zaloApi('getLabels', { auth });
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
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left ${filterLabelIds.length === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                    <span className="w-3 h-3 rounded-full bg-accent flex-shrink-0" />
                    <span>Tất cả nhãn Zalo</span>
                    {filterLabelIds.length === 0 && <span className="ml-auto text-blue-400">✓</span>}
                  </button>
                  {(mergedInboxMode ? mergedLabels! : labels).length === 0 ? (
                    <p className="text-xs text-muted-foreground px-3 py-2 italic">Chưa có nhãn Zalo</p>
                  ) : (mergedInboxMode ? mergedLabels! : labels).map(l => {
                    const isActive = filterLabelIds.includes(l.id);
                    return (
                      <button key={l.id} onClick={() => {
                        setFilterLabelIds(prev => isActive ? prev.filter(x => x !== l.id) : [...prev, l.id]);
                      }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left ${isActive ? 'text-foreground' : 'text-foreground/80'}`}>
                        <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[10px] ${isActive ? 'bg-blue-600 border-blue-600 text-white' : 'border-border-strong'}`}>
                          {isActive && '✓'}
                        </span>
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: l.color || '#3b82f6' }} />
                        {l.emoji && <span>{l.emoji}</span>}
                        <span className="truncate">{l.text}</span>
                      </button>
                    );
                  })}
                  {/* Chỉnh sửa nhãn Zalo */}
                  <div className="px-3 py-2 border-t border-border mt-1">
                    <button
                      onClick={() => {
                        setFilterDropdownOpen(false);
                        if (mergedInboxMode) setEditLabelsPickerOpen(true);
                        else setEditLabelsZaloId(activeAccountId);
                      }}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
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
            className={`h-10 px-3 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ${(filter === 'unreplied' || filter === 'others' || channelFilter !== 'all' || moreMenuOpen) ? 'bg-muted text-foreground' : ''}`}
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
            <div className="absolute top-full left-0 z-30 bg-card border border-border rounded-xl shadow-xl min-w-[160px] py-1 mt-1">
              {/*<button*/}
              {/*  onClick={() => {*/}
              {/*    setFilter('unreplied');*/}
              {/*    setFilterLabelId(null);*/}
              {/*    setMoreMenuOpen(false);*/}
              {/*  }}*/}
              {/*  className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted text-left ${filter === 'unreplied' ? 'text-foreground bg-muted/50' : 'text-foreground/80'}`}*/}
              {/*>*/}
              {/*  <span><ChatIcon className="w-4 h-4" /></span>*/}
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
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted text-left ${filter === 'others' ? 'text-foreground bg-muted/50' : 'text-foreground/80'}`}
              >
                <span><PluginIcon className="w-4 h-4" /></span>
                <span>Khác</span>
                {othersCount > 0 && <span className="ml-auto bg-accent text-foreground text-xs rounded-full px-1.5 min-w-[18px] text-center">{othersCount}</span>}
                {filter === 'others' && <span className="ml-auto text-blue-400">✓</span>}
                <div className="relative group pr-2">
                  <span className="w-4 h-4 rounded-full border border-border-strong text-muted-foreground hover:border-gray-300 hover:text-foreground/80 flex items-center justify-center text-xs cursor-default select-none transition-colors">
                    ?
                  </span>
                    <div className="absolute right-0 top-full mb-1 w-64 bg-popover border border-input rounded-lg shadow-xl p-3 text-xs text-foreground/80 leading-relaxed z-[60] hidden group-hover:block pointer-events-none">
                      <p>Dùng để lưu các hội thoại không quan trọng. Các hội thoại trong thư mục này sẽ <span className="text-yellow-400 font-medium">không phát âm thanh</span> và <span className="text-yellow-400 font-medium">không hiện thông báo</span> khi có tin nhắn mới.</p>
                    </div>
                </div>
              </button>

              {/* Tin đánh dấu (như Zalo) */}
              <button
                onClick={() => { setStarredPanelOpen(true); setMoreMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted text-left text-foreground/80"
              >
                <span className="text-yellow-500"><StarIcon className="w-4 h-4" /></span>
                <span>Tin đánh dấu</span>
                {starredCount > 0 && <span className="ml-auto bg-accent text-foreground text-xs rounded-full px-1.5 min-w-[18px] text-center">{starredCount}</span>}
              </button>

              {/* Tự động */}
              <div className="border-t border-border mt-1 pt-1">
                <div className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">Tự động</div>
                <button
                  onClick={() => { setAutoReadOpen(true); setMoreMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left text-foreground/80"
                >
                  <span><CheckCircleIcon className="w-4 h-4" /></span>
                  <span>Tự động đánh dấu đã đọc</span>
                  {autoReadProgress && <span className="ml-auto text-[10px] text-blue-400 tabular-nums" title="Đang chạy">{autoReadProgress}</span>}
                </button>
              </div>

              {/* Channel filter submenu */}
              <div className="border-t border-border mt-1 pt-1">
                <div className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">Kênh</div>
                {(['all', 'zalo', 'facebook', 'telegram_user', 'telegram_bot'] as const).map(ch => (
                  <button
                    key={ch}
                    onClick={() => { setChannelFilter(ch as any); setMoreMenuOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left ${channelFilter === ch ? 'text-foreground bg-muted/50' : 'text-foreground/80'}`}
                  >
                    <span>{ch === 'all' ? <GlobeIcon className="w-4 h-4" /> : <ChannelBadge channel={ch as Channel} size="sm" />}</span>
                    <span>{ch === 'all' ? 'Tất cả kênh' : getChannelLabel(ch as Channel)}</span>
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
        <div className="border-b border-border bg-card px-3 py-2">
          <p className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Chọn tài khoản để tìm <span className="text-foreground font-medium">{phoneSearchPendingPhone}</span>:
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
                  className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted hover:bg-accent text-xs text-foreground transition-colors"
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
        <div className="border-b border-border bg-card px-3 py-2">
          {phoneSearching ? <p className="text-xs text-muted-foreground">Đang tìm...</p> : phoneResult ? (
            phoneResult._notFound ? (
              <p className="text-xs text-muted-foreground">Không tìm thấy người dùng với số này hoặc người dùng đã chặn tìm kiếm với người lạ</p>
            ) : (
            <div className="flex items-center gap-2">
              {phoneResult.avatar ? <img src={phoneResult.avatar} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                : <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">{(phoneResult.display_name || 'U').charAt(0).toUpperCase()}</div>}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{phoneResult.display_name || phoneResult.zalo_name}</p>
                {phoneResult.isBlocked === 1 ? <p className="text-xs text-red-400"><CloseIcon className="w-4 h-4 inline" /> Đã chặn</p>
                  : phoneResult.isFr === 1 ? <p className="text-xs text-green-400">✓ Bạn bè</p>
                  : phoneResult._sentRequest ? <p className="text-xs text-yellow-400">✓ Đã gửi lời mời</p>
                  : <p className="text-xs text-muted-foreground">Chưa kết bạn</p>}
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {phoneResult.isBlocked !== 1 && phoneResult.isFr !== 1 && !phoneResult._sentRequest && (
                  <button
                    onClick={() => setAddFriendModal({ userId: phoneResult.uid, displayName: phoneResult.display_name || phoneResult.zalo_name || phoneResult.uid, avatar: phoneResult.avatar || '' })}
                    className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded-lg">
                    + Kết bạn
                  </button>
                )}
                <button onClick={() => handleOpenPhoneResult(phoneResult)} className="bg-muted hover:bg-accent text-foreground text-xs px-2 py-1 rounded-lg"><ChatIcon className="w-4 h-4" /></button>
              </div>
            </div>
            )
          ) : null}
        </div>
      )}

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto relative" ref={setListContainer} onScroll={handleListScroll}>
        {initialLoading && activeAccountId && accountContacts.length === 0 ? (
          <PageLoading variant="skeleton" skeletonVariant="table" />
        ) : (mergedInboxMode ? (filteredMerged?.length ?? 0) : filtered.length) === 0 ? (
          useChatStore.getState().conversationsLoading[activeAccountId || ''] ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2">
              <span className="w-5 h-5 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
              <p>Đang tải hội thoại...</p>
            </div>
          ) : !mergedInboxMode && paging.failures > 0 && accountContacts.length === 0 ? (
            // Lần tải lỗi (mất kết nối BOSS…) ≠ "không có hội thoại": tự thử lại theo backoff / khi kết nối lại
            <EmptyState
              compact
              className="h-full"
              title="Không tải được hội thoại"
              description="Danh sách sẽ tự tải lại khi kết nối ổn định."
              action={<Button variant="outline" size="sm" onClick={retryConversationLoad}>Thử lại</Button>}
            />
          ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm"><p>Không có hội thoại</p></div>
          )
        ) : (mergedInboxMode ? filteredMerged! : filtered).slice(0, displayCount).map((contact, index) => {
          const threadType = contact.contact_type === 'group' ? 1 : 0;
          const membershipNotice = getTelegramMembershipNotice(contact);
          const startsNonMemberSection = index === nonMemberSectionIndex;
          const contactZaloId = contact.owner_zalo_id || activeAccountId || '';
          const isPinned = pinnedThreads.has(contact.contact_id);
          const isLocalPinned = localPinnedThreads.has(contact.contact_id);
          const isMuted = contactZaloId ? isMutedFn(contactZaloId, contact.contact_id) : false;
          const isGroupC = contact.contact_type === 'group';
          const labelCId = isGroupC ? `g${contact.contact_id}` : contact.contact_id;
          // Hàng chỉ dùng nhãn đầu tiên (theo thứ tự nhãn của tài khoản) → tra chỉ mục dựng sẵn
          const labelIndex = firstZaloLabelIndex.get(contactZaloId);
          const labelByGroupId = labelIndex?.get(labelCId);
          const labelByContactId = labelIndex?.get(contact.contact_id);
          const firstLabelEntry = labelByGroupId && labelByContactId
            ? (labelByGroupId.order <= labelByContactId.order ? labelByGroupId : labelByContactId)
            : (labelByGroupId || labelByContactId);
          const contactLabels: LabelData[] = firstLabelEntry ? [firstLabelEntry.label] : [];
          // Local labels for this thread
          const threadLocalLabelIds = (localLabelThreadMapByAccount[contactZaloId] || {})[contact.contact_id] || [];
          const threadLocalLabelsArr = threadLocalLabelIds
            .map(lid => (localLabelsByAccount[contactZaloId] || []).find(l => l.id === lid))
            .filter(Boolean) as LocalLabelData[];
          // Badge tài khoản sở hữu (chỉ trong chế độ Gộp trang)
          const ownerAcc = mergedInboxMode ? allAccountsList.find(a => a.zalo_id === contact.owner_zalo_id) : null;
          const contactAccount = accountOf(contactZaloId);
          const isMyDocs = isMyDocumentsContact(contact, contactAccount);
          // Danh sách của tài khoản: luôn ghim như Zalo; hộp thư gộp: khi đã có tin (như thứ tự sắp xếp)
          const myDocsPinned = isMyDocs && (!mergedInboxMode || isPinnedMyDocuments(contact, contactAccount));
          return (
            <React.Fragment key={`${contact.owner_zalo_id}_${contact.contact_id}`}>
            {startsNonMemberSection && (
              <div
                className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground"
                title="Telegram không gửi tin nhắn của nhóm/kênh bạn không còn tham gia"
              >
                Không còn là thành viên · không đồng bộ realtime
              </div>
            )}
            <div
              className={`group/conv relative w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted transition-colors cursor-pointer ${threadLocalLabelsArr.length > 0 ? 'min-h-[72px]' : 'max-h-[80px] min-h-[80px]'} ${activeThreadId === contact.contact_id && activeAccountId === contact.owner_zalo_id ? 'bg-selected hover:bg-selected' : ''}`}
              onClick={() => { if (mergedInboxMode) { handleMergedClick(contact); } else { handleSelect(contact.contact_id, threadType, contact.owner_zalo_id || activeAccountId); setFilterDropdownOpen(false); } }}>
              <div className="relative flex-shrink-0">
                {isMyDocs && (!contact.avatar_url || failedAvatars.has(contact.contact_id)) ? (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-br from-sky-400 to-blue-600" style={{ color: '#fff' }} title={MY_DOCUMENTS_NAME}>
                    <CloudIcon className="w-5 h-5" />
                  </div>
                ) : threadType === 1 ? (
                  <ConversationGroupAvatar
                    accountId={contactZaloId}
                    groupId={contact.contact_id}
                    avatarUrl={contact.avatar_url}
                    name={contact.alias || contact.display_name}
                    observer={groupAvatarObserver}
                  />
                ) : contact.avatar_url && !failedAvatars.has(contact.contact_id) ? (
                  <img src={toLocalMediaUrl(contact.avatar_url)} alt="" loading="lazy" decoding="async" className="w-10 h-10 rounded-full object-cover"
                    onError={() => {
                      setFailedAvatars(prev => new Set(prev).add(contact.contact_id));
                      // Retry avatar cho cả Zalo + Facebook
                      const ownerId = contact.owner_zalo_id || activeAccountId;
                      if (ownerId) {
                        import('@/lib/avatarRetry').then(({ handleAvatarError }) =>
                          handleAvatarError({ ownerId, contactId: contact.contact_id, channel: contact.channel || CHANNEL.ZALO })
                        ).then(newUrl => {
                          if (newUrl) {
                            updateContact(ownerId, { contact_id: contact.contact_id, avatar_url: newUrl });
                            setFailedAvatars(prev => { const next = new Set(prev); next.delete(contact.contact_id); return next; });
                          }
                        }).catch(() => {});
                      }
                    }} />
                ) : (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold bg-blue-600">{(contact.alias || contact.display_name).charAt(0).toUpperCase()}</div>
                )}
                {/* Badge tài khoản - chỉ hiện trong chế độ Gộp trang */}
                {mergedInboxMode && ownerAcc && (
                  <div className="absolute -bottom-1.5 -right-1.5 w-5 h-5 rounded-full border border-border overflow-hidden z-10 flex-shrink-0" title={ownerAcc.full_name || ownerAcc.zalo_id}>
                    {ownerAcc.avatar_url
                      ? <img src={ownerAcc.avatar_url} alt="" className="w-full h-full object-cover" />
                      : <div className="w-full h-full bg-purple-600 flex items-center justify-center text-white text-[6px] font-bold">{(ownerAcc.full_name || ownerAcc.zalo_id).charAt(0).toUpperCase()}</div>
                    }
                  </div>
                )}
                {/* Channel badge overlay - hiện trong chế độ Gộp trang */}
                {mergedInboxMode && (
                  <div className="absolute top-1 left-1 z-10">
                    <ChannelBadgeOverlay channel={(contact.channel || CHANNEL.ZALO) as Channel} size="sm" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                    {myDocsPinned && <span title="My Documents luôn ở đầu (như Zalo)"><PinIcon className="w-4 h-4" /></span>}
                    {!isMyDocs && isLocalPinned && <span title="Ghim trong app">📍</span>}
                    {!isMyDocs && isPinned && <span title="Ghim Zalo"><PinIcon className="w-4 h-4" /></span>}
                    <span className="truncate">{contact.alias || contact.display_name || (isMyDocs ? MY_DOCUMENTS_NAME : contact.contact_id)}</span>
                    {membershipNotice && (
                      <span
                        className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none bg-amber-500/15 text-amber-400"
                        title={membershipNotice.description}
                      >
                        {membershipNotice.label}
                      </span>
                    )}
                  </span>
                  {/* Fixed-width slot: always reserve space to prevent layout shift on hover */}
                  <div className="flex-shrink-0 w-14 flex items-center justify-end gap-1">
                    {/* Rê chuột: nút ⋯ thay chỗ giờ — CSS group-hover (state hover làm cả danh sách render lại mỗi lần rê chuột) */}
                    <button onClick={(e) => { e.stopPropagation(); setCtxMenu({ contactId: contact.contact_id, zaloId: contactZaloId, x: e.clientX, y: e.clientY }); setLabelPickerId(null); }}
                      className="hidden group-hover/conv:flex w-6 h-4 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground">
                      {/* Horizontal 3-dot (⋯) */}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
                      </svg>
                    </button>
                    {contact.last_message_time ? (
                      <span className="text-xs text-muted-foreground whitespace-nowrap group-hover/conv:hidden">{formatTime(contact.last_message_time)}</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-1 mt-1">
                  <span className="text-sm text-muted-foreground truncate flex items-center gap-1">
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
                          return <><span className="text-red-400">Chưa gửi: </span><span className="text-muted-foreground">{draftText}</span></>;
                        }
                        return formatLastMessage(contact.last_message) || (contact.phone ? `${contact.phone}` : '');
                      })()}
                    </span>
                  </span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isMuted && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>}
                    {contact.has_main_app === 1 && isTelegramUser(contact.channel) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          (async () => {
                            try {
                              const res = await (ipc as any).telegramUser?.requestMainWebView({
                                accountId: contact.owner_zalo_id, botId: contact.contact_id,
                              });
                              if (res?.success && res.webViewUrl) window.open(res.webViewUrl, '_blank');
                            } catch {}
                          })();
                        }}
                        className="text-[10px] text-blue-400 hover:text-blue-300 font-medium px-1.5 py-0.5 rounded hover:bg-blue-500/10 transition-colors"
                      >
                        Open
                      </button>
                    )}
                    {!membershipNotice && contact.has_mention === 1 && contact.unread_count > 0 && (
                      <span className="bg-cyan-600 text-white-important text-[10px] rounded-full w-4 h-4 flex items-center justify-center font-bold">@</span>
                    )}
                    {/* A left group's unread count is frozen from when the account was in it. */}
                    {!membershipNotice && contact.unread_count > 0
                      ? <span className="bg-primary text-primary-foreground text-[10px] font-medium leading-none tabular-nums rounded-full h-[18px] min-w-[18px] px-1.5 inline-flex items-center justify-center">{contact.unread_count > 99 ? '99+' : contact.unread_count}</span>
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
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {threadLocalLabelsArr.map(label => (
                      <span key={label.id}
                        className="inline-flex items-center gap-0.5 px-2 py-1 rounded-full text-[11px] flex-shrink-0 max-w-[160px] leading-none"
                        style={{ backgroundColor: label.color || '#3b82f6', color: label.text_color || '#ffffff' }}
                        title={label.name}
                      >
                        {label.emoji && <span className="text-[8px] leading-none">{label.emoji}</span>}
                        <span className="truncate">{label.name}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            </React.Fragment>
          );
        })}
        {/* Trang tiếp theo (hoặc trang đầu khi đã có vài hội thoại) tải lỗi: giữ danh sách, báo gọn + thử lại */}
        {!mergedInboxMode && paging.failures > 0 && accountContacts.length > 0 && (
          <LoadFailedNotice
            text={paging.failedPage === 'more' ? 'Không tải được thêm hội thoại' : 'Không tải được hội thoại mới nhất'}
            onRetry={retryConversationLoad}
            busy={conversationLoadingMore}
          />
        )}
        {/* Sentinel element for infinite scroll */}
        {showConversationSentinel && (
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
              const auth = buildZaloAuth(accObj);
              const res = await zaloApi('getLabels', { auth });
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

      {autoReadOpen && (
        <AutoMarkReadModal
          accountIds={autoReadAccountIds}
          scopeLabel={autoReadScopeLabel}
          onClose={() => setAutoReadOpen(false)}
        />
      )}

      {/* Modals */}
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
          <div className="bg-card rounded-xl shadow-2xl w-72 flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">Chọn trang để chỉnh sửa nhãn</h3>
              <button onClick={() => setEditLabelsPickerOpen(false)} className="text-muted-foreground hover:text-foreground">
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
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted text-left transition-colors"
                  >
                    {acc?.avatar_url
                      ? <img src={acc.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                      : <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{(acc?.full_name || zaloId).charAt(0).toUpperCase()}</div>
                    }
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">{acc?.full_name || zaloId}</p>
                      <p className="text-muted-foreground text-[12px]">{acc?.phone || zaloId}</p>
                      <p className="text-xs text-muted-foreground">{accLabels.length} nhãn</p>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
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
            // Only supported for Zalo
            if (isNonZalo(acc.channel)) {
              alert('Tính năng chưa hỗ trợ cho kênh này');
              setAddFriendModal(null);
              return;
            }
            setSendingFriendReq(true);
            try {
              await ipc.zalo?.sendFriendRequest({
                auth: buildZaloAuth(acc),
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
    <button onClick={onClick} className={`${fullWidth ? 'w-full' : 'flex-1'} h-10 flex items-center justify-center text-xs font-medium transition-colors whitespace-nowrap px-3 ${active ? 'text-blue-400 border-b-2 border-blue-400' : 'text-muted-foreground hover:text-foreground/80'}`}>
      {label}
      {badge !== undefined && badge > 0 && <span className="ml-1 bg-blue-600 text-white text-[9px] rounded-full px-1.5 min-w-[16px] text-center">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

function CtxItem({ icon, label, onClick, hasArrow, danger }: { icon: React.ReactNode; label: string; onClick: () => void; hasArrow?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${danger ? 'text-red-400 hover:bg-red-900/30 hover:text-red-300' : 'text-foreground/80 hover:bg-muted hover:text-foreground'}`}>
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
        'File': 'File: ',
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
        return `Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
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
            return `Link: ${url.hostname}`;
          } catch { }
        }
        return 'Link: ';
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
        return `Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
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
    // File with title - only when msgType is file OR content has file-specific fields
    if (mt.includes('file') || mt === 'share.file') return p?.title ? `File: ${p.title}` : 'File: ';
    // Location
    if (mt === 'chat.location.new') {
      const desc = p?.description || '';
      return desc ? `📍 ${desc}` : '📍 [Vị trí]';
    }
    // Parse params for further checks
    const par = (() => { try { return typeof p?.params === 'string' ? JSON.parse(p.params) : (p?.params || {}); } catch { return {}; } })();
    // File heuristic: title + file-specific fields
    if (p?.title && (par?.fileSize || par?.fileExt || par?.fileUrl || p?.normalUrl || p?.fileUrl)) return `File: ${p.title}`;
    // Image (by URL fields) - but prefer text content if the message has both
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
      className="fixed z-[200] bg-card border border-border rounded-xl shadow-2xl min-w-[185px]"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
    >
      <p className="text-[11px] text-muted-foreground px-3 pt-1.5 pb-1 font-medium uppercase tracking-wide">Nhãn</p>
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
