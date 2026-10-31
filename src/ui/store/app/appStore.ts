import { create } from 'zustand';
import { useAccountStore } from '../accounts/accountStore';
import { useEmployeeStore } from '../employee/employeeStore';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { isZalo } from '@/lib/channels/channelHelper';
import {
  NOTIF_OVERRIDES_STORAGE_KEY, effectiveNotifSettings, normalizeNotifOverrides, withAccountNotifSettings,
  type NotifSettingsOverride,
} from '@/lib/notifications/notifSettingsOverrides';

type AppView = 'chat' | 'friends' | 'settings' | 'dashboard' | 'crm' | 'workflow' | 'integration' | 'analytics' | 'erp' | 'plugin';
export type AppTheme = 'dark' | 'light';

export interface GroupMember {
  userId: string;
  displayName: string;
  avatar: string;
  role: number; // 0 = thành viên; chủ / phó nhóm tuỳ kênh (Zalo 2 / 1, Telegram 1 / 2) — đọc qua shared/chat/groupMemberRoles
  username?: string; // Telegram @username
  status?: string;
  statusText?: string;
  lastSeenAt?: number;
  onlineUntil?: number;
}

export interface CachedGroupInfo {
  groupId: string;
  name: string;
  avatar: string;
  memberCount: number;
  onlineCount?: number;
  peerType?: string;
  canSend?: boolean;
  canManageTopics?: boolean;
  sendReason?: string;
  membershipState?: string;
  joinAction?: string;
  members: GroupMember[];
  creatorId?: string;
  adminIds?: string[];
  settings?: Record<string, any>;
  fetchedAt: number;
}

export interface LabelData {
  id: number;
  text: string;
  color: string;
  emoji: string;
  conversations: string[];
  version?: number;
}

export interface NotifSettings {
  soundEnabled: boolean;
  desktopEnabled: boolean;
  volume: number; // 0–1
}

export interface QuickChatTarget {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  threadType: number; // 0=user, 1=group
  phone?: string;
}

export interface PinnedIntegrationShortcut {
  id: string;
  integrationId: string;
  integrationType: string;
  integrationName: string;
  action: string;
  actionLabel: string;
  icon: string; // emoji
}

interface AppStore {
  view: AppView;
  /** Trang plugin đang mở khi view === 'plugin'. */
  activePluginPage: { pluginId: string; pageId: string } | null;
  openPluginPage: (pluginId: string, pageId: string) => void;
  /** Trang "Ứng dụng": lưới các ứng dụng (plugin) đã cài. */
  openPluginHub: () => void;
  /** Ngăn đang mở ở trang Ứng dụng (installed | dev = Phát triển ứng dụng). */
  pluginHubTab: 'installed' | 'dev';
  setPluginHubTab: (tab: 'installed' | 'dev') => void;
  /** Phần đang mở ở trang Ứng dụng, API & Webhook (Công cụ → Ứng dụng, API & Webhook). */
  pluginHubSection: 'plugins' | 'api' | 'webhooks';
  setPluginHubSection: (section: 'plugins' | 'api' | 'webhooks') => void;
  /** Panel plugin bên phải màn chat (đóng các panel phải khác khi mở). */
  activePluginPanel: { pluginId: string; panelId: string } | null;
  setActivePluginPanel: (panel: { pluginId: string; panelId: string } | null) => void;
  isLoading: boolean;
  notification: { message: string; type: 'success' | 'error' | 'info' | 'warning' } | null;
  erpPermissionDialog: { title: string; message: string; details?: string } | null;
  addAccountModalOpen: boolean;
  addAccountInitialChannel: string | null;  // Channel to pre-select when opening Add Account modal (e.g., re-login)
  addAccountInitialProxyId: number | null;  // Proxy to pre-select on re-login (keeps the account's current proxy)
  showConversationInfo: boolean;
  showGroupBoard: boolean;
  showIntegrationQuickPanel: boolean;
  showAIQuickPanel: boolean;
  openReminderPanel: boolean;
  searchOpen: boolean;
  // AI Suggestions
  aiSuggestionsEnabled: boolean;
  aiSuggestions: string[];
  aiSuggestionsLoading: boolean;
  aiAutoInjectZaloContext: boolean;
  aiQuickPanelContextCountOverride: number | null;
  /** Cache: threadKey → last used assistantId for AI Quick Panel */
  aiThreadAssistantMap: Record<string, string>;
  /** Threads where AI suggestion is disabled: Set of "zaloId_threadId" */
  aiSuggestDisabledThreads: Record<string, boolean>;
  /** Accounts where AI suggestion is disabled: Set of zaloId */
  aiSuggestDisabledAccounts: Record<string, boolean>;
  /** Active query string to highlight in chat messages when in-chat search is open */
  searchHighlightQuery: string;
  // Quick chat popup
  quickChatOpen: boolean;
  quickChatTarget: QuickChatTarget | null;
  quickChatZaloId: string | null;
  /** Hội thoại đang hiện trong popup Nhắn tin nhanh: tin mới của nó coi như đang xem (không chuông / thẻ, đã đọc) */
  quickChatThread: { zaloId: string; threadId: string; threadType: number } | null;
  setQuickChatThread: (thread: { zaloId: string; threadId: string; threadType: number } | null) => void;
  openQuickChat: (opts?: { target?: QuickChatTarget; zaloId?: string }) => void;
  closeQuickChat: () => void;
  labels: Record<string, LabelData[]>;
  /** Per-account label version from Zalo API (needed for updateLabels) */
  labelsVersionMap: Record<string, number>;
  /** Per-account timestamp of last getLabels API call */
  labelsFetchedAt: Record<string, number>;
  setLabelsVersion: (zaloId: string, version: number) => void;
  /**
   * Fetch labels with 12-hour cache. Returns cached data if fresh enough.
   * Pass `force: true` to bypass cache (e.g. before updateLabels).
   */
  fetchLabelsWithCache: (zaloId: string, auth: any, force?: boolean) => Promise<{ labels: LabelData[]; version: number }>;
  /**
   * In-memory mute cache: zaloId -> contactId -> until (0=indefinite, ms=timed)
   * Source of truth is DB; this is just a fast read cache loaded on account switch.
   */
  mutedThreads: Record<string, Record<string, number>>;
  notifSettings: NotifSettings;
  /** Cài đặt riêng của từng tài khoản: zaloId → các mục KHÁC mặc định (lib/notifications/notifSettingsOverrides, lưu trên máy này) */
  notifSettingsOverrides: Record<string, NotifSettingsOverride>;
  /** In-memory others cache: zaloId -> Set<contactId> */
  othersConversations: Record<string, Set<string>>;
  /** Hội thoại Zalo đang ẩn bằng PIN (ZL-03): zaloId → contact_id (contacts.zalo_hidden) */
  hiddenConversations: Record<string, Set<string>>;
  /** Tài khoản đang mở khoá hội thoại ẩn (đã gõ đúng PIN): zaloId → thời điểm mở (ms) — chỉ máy này */
  hiddenUnlocked: Record<string, number>;

  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  fontSizeScale: number;
  setFontSizeScale: (scale: number) => void;

  setView: (view: AppView) => void;
  setLoading: (loading: boolean) => void;
  showNotification: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  hideNotification: () => void;
  showErpPermissionDialog: (payload?: { title?: string; message?: string; details?: string }) => void;
  hideErpPermissionDialog: () => void;
  setAddAccountModalOpen: (open: boolean, initialChannel?: string, initialProxyId?: number | null) => void;
  toggleConversationInfo: () => void;
  setShowGroupBoard: (open: boolean) => void;
  toggleIntegrationQuickPanel: () => void;
  toggleAIQuickPanel: () => void;
  setAiSuggestionsEnabled: (enabled: boolean) => void;
  setAiSuggestions: (suggestions: string[]) => void;
  setAiSuggestionsLoading: (loading: boolean) => void;
  setAiAutoInjectZaloContext: (enabled: boolean) => void;
  setAiQuickPanelContextCountOverride: (count: number | null) => void;
  setAiThreadAssistant: (threadKey: string, assistantId: string) => void;
  toggleAiDisableForThread: (zaloId: string, threadId: string) => void;
  toggleAiDisableForAccount: (zaloId: string) => void;
  isAiSuggestDisabled: (zaloId: string, threadId: string) => boolean;
  setOpenReminderPanel: (open: boolean) => void;
  toggleSearch: () => void;
  setSearchOpen: (open: boolean) => void;
  setSearchHighlightQuery: (query: string) => void;
  setLabels: (zaloId: string, labels: LabelData[]) => void;

  /**
   * Bulk-load mute + others flags from DB into in-memory cache.
   * Call this whenever the active account changes.
   * A failed read keeps the cached flags (never replaced with an empty set).
   */
  loadFlags: (zaloId: string) => Promise<void>;

  /**
   * Employee mode: tải lại cờ (tắt tiếng / "Khác") + nhãn của các tài khoản đang xem sau khi kết nối BOSS
   * phục hồi (useEmployeeResync). Không có `zaloIds` → tài khoản đang mở / các tài khoản gộp trang.
   * Chế độ chủ/standalone: không làm gì.
   */
  reloadEmployeeData: (zaloIds?: string[]) => Promise<void>;

  /** Mute a contact. Persists to DB + updates in-memory cache. */
  setMuted: (zaloId: string, contactId: string, until: number) => void;
  /** Unmute a contact. Persists to DB + updates in-memory cache. */
  clearMuted: (zaloId: string, contactId: string) => void;
  /** Returns true if contact is actively muted (checks expiry). Fast in-memory read. */
  isMuted: (zaloId: string, contactId: string) => boolean;
  getMuteUntil: (zaloId: string, contactId: string) => number | undefined;

  setNotifSettings: (settings: Partial<NotifSettings>) => void;

  /** Get notification settings for a specific account (override + fallback to global) */
  getNotifSettingsForAccount: (zaloId: string) => NotifSettings;
  /** Chỉnh cài đặt riêng của một tài khoản (chỉ lưu phần khác mặc định, localStorage của máy này) */
  setNotifSettingsForAccount: (zaloId: string, settings: Partial<NotifSettings>) => Promise<void>;
  /** Bỏ cài đặt riêng: tài khoản theo lại cài đặt mặc định */
  resetNotifSettingsForAccount: (zaloId: string) => void;

  /** Move a contact to Others folder. Persists to DB + updates in-memory cache. */
  addToOthers: (zaloId: string, contactId: string) => void;
  /** Remove a contact from Others folder. Persists to DB + updates in-memory cache. */
  removeFromOthers: (zaloId: string, contactId: string) => void;
  /** Fast in-memory check. */
  isInOthers: (zaloId: string, contactId: string) => boolean;
  /** Hội thoại đang ẩn trên Zalo (bất kể đã mở khoá): không âm thanh / thông báo / số chưa đọc (quyết định Q3). */
  isZaloHidden: (zaloId: string, contactId: string) => boolean;
  /** Ẩn và tài khoản đang khoá → không hiện ở danh sách / tìm kiếm. */
  isHiddenLocked: (zaloId: string, contactId: string) => boolean;
  setHiddenUnlocked: (zaloId: string, unlocked: boolean) => void;
  /** Ẩn lại mọi tài khoản đang mở (khoá app, đổi tài khoản, 5 phút không thao tác). */
  lockAllHidden: () => void;
  /** Thay danh sách hội thoại ẩn của một tài khoản (sau khi mở khoá / ẩn / bỏ ẩn). */
  setHiddenThreads: (zaloId: string, contactIds: string[]) => void;
  /**
   * Áp dụng cờ tắt tiếng / "Khác" vừa đổi ở nơi khác (db:contactFlagsChanged — Boss hoặc nhân viên khác, hoặc tiếng
   * vọng thay đổi của chính mình) vào bộ nhớ đệm. KHÔNG ghi DB. Giá trị như đang có → không đổi state (không render lại).
   */
  applyContactFlags: (zaloId: string, contactId: string, flags: { is_muted?: number; mute_until?: number; is_in_others?: number; zalo_hidden?: number }) => void;

  // Group info cache
  groupInfoCache: Record<string, Record<string, CachedGroupInfo>>;
  setGroupInfo: (zaloId: string, groupId: string, info: CachedGroupInfo) => void;
  getGroupInfo: (zaloId: string, groupId: string) => CachedGroupInfo | undefined;
  clearGroupInfo: (zaloId: string, groupId: string) => void;

  // ── Merged inbox (Gộp tài khoản) ─────────────────────────────────────────────
  mergedInboxMode: boolean;
  /** Danh sách zaloId được gộp vào inbox chung */
  mergedInboxAccounts: string[];
  /** null = show all; zaloId = filter by this account */
  mergedInboxFilterAccount: string | null;
  enterMergedInbox: (accountIds: string[]) => void;
  exitMergedInbox: () => void;
  setMergedInboxFilter: (zaloId: string | null) => void;

  // ── Mobile responsive: Telegram-style single panel ────────────────────────
  /** When true on small screens, show chat detail instead of conversation list */
  mobileShowChat: boolean;
  setMobileShowChat: (show: boolean) => void;

  // ── Pinned integration shortcuts ──────────────────────────────────────────
  pinnedIntegrationShortcuts: PinnedIntegrationShortcut[];
  /** When set, the panel auto-navigates to this integration + action on next open */
  integrationPanelTarget: { integrationId: string; action: string } | null;
  pinIntegrationShortcut: (shortcut: Omit<PinnedIntegrationShortcut, 'id'>) => void;
  unpinIntegrationShortcut: (id: string) => void;
  editPinnedShortcutIcon: (id: string, icon: string) => void;
  setIntegrationPanelTarget: (target: { integrationId: string; action: string } | null) => void;
  /** Open integration panel and navigate directly to a specific integration + action */
  openIntegrationPanelTo: (integrationId: string, action: string) => void;

  /** Initial tab for Analytics page when navigating from other modules */
  analyticsInitialTab: string | null;
  /** Per-account red-dot marker for CRM friend requests tab */
  crmRequestUnseenByAccount: Record<string, boolean>;
  setAnalyticsInitialTab: (tab: string | null) => void;
  /** Navigate to Analytics page with a specific tab */
  navigateToAnalytics: (tab?: string) => void;
  markCRMRequestUnseen: (zaloId: string) => void;
  clearCRMRequestUnseen: (zaloId: string) => void;
  hasCRMRequestUnseen: (zaloId: string) => boolean;
  hasAnyCRMRequestUnseen: () => boolean;

  // ── Account switcher (Ctrl+Tab) ──────────────────────────────────────────
  // ── Sidebar expanded ────────────────────────────────────────────
  sidebarExpanded: boolean;
  toggleSidebarExpanded: () => void;

  accountSwitcherOpen: boolean;
  accountSwitcherIndex: number;
  openAccountSwitcher: () => void;
  closeAccountSwitcher: (select?: boolean) => void;
  nextAccountSwitcher: () => void;
  prevAccountSwitcher: () => void;
}

// ─── fontSizeScale persists in localStorage ─────────────────────────────────
// Scale range: 0.75 (12px) → 1.5 (24px), step 0.0625 (1px), default 1 (16px)
export const FONT_SCALE_MIN = 0.75;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.0625;
const FONT_SCALE_KEY = 'app_fontSizeScale';
const loadFontSizeScale = (): number => {
  try {
    const stored = localStorage.getItem(FONT_SCALE_KEY);
    if (stored !== null) {
      const parsed = Number(stored);
      if (parsed >= FONT_SCALE_MIN && parsed <= FONT_SCALE_MAX) return parsed;
    }
  } catch {}
  return 1;
};

// ─── theme persists in localStorage ─────────────────────────────────────────
const loadTheme = (): AppTheme => {
  try {
    const stored = localStorage.getItem('app_theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'light';
};

// ─── notifSettings persists in localStorage (not account-specific) ──────────
const loadNotifSettings = (): NotifSettings => {
  try {
    const stored = JSON.parse(localStorage.getItem('app_notifSettings') || '{}');
    return { soundEnabled: true, desktopEnabled: true, volume: 0.6, ...stored };
  } catch {
    return { soundEnabled: true, desktopEnabled: true, volume: 0.6 };
  }
};

// ─── Cài đặt thông báo riêng của từng tài khoản: localStorage của máy này (như notifSettings) ──────────────
const loadNotifOverrides = (): Record<string, NotifSettingsOverride> => {
  try {
    return normalizeNotifOverrides(JSON.parse(localStorage.getItem(NOTIF_OVERRIDES_STORAGE_KEY) || '{}'));
  } catch {
    return {};
  }
};

const saveNotifOverrides = (overrides: Record<string, NotifSettingsOverride>) => {
  try { localStorage.setItem(NOTIF_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides)); } catch {}
};

// ─── Pinned shortcuts persist in localStorage ────────────────────────────────
function loadPinnedShortcuts(): PinnedIntegrationShortcut[] {
  try {
    const s = localStorage.getItem('integration_pinned_shortcuts');
    if (s) return JSON.parse(s);
  } catch {}
  return [];
}
function savePinnedShortcuts(shortcuts: PinnedIntegrationShortcut[]) {
  try { localStorage.setItem('integration_pinned_shortcuts', JSON.stringify(shortcuts)); } catch {}
}

function loadCRMRequestUnseen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem('crm_request_unseen_accounts');
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCRMRequestUnseen(map: Record<string, boolean>) {
  try { localStorage.setItem('crm_request_unseen_accounts', JSON.stringify(map)); } catch {}
}

// ─── AI disabled threads/accounts persist in localStorage ────────────────────
function loadAiDisabledThreads(): Record<string, boolean> {
  try { const s = localStorage.getItem('ai_disabled_threads'); if (s) return JSON.parse(s); } catch {}
  return {};
}
function loadAiDisabledAccounts(): Record<string, boolean> {
  try { const s = localStorage.getItem('ai_disabled_accounts'); if (s) return JSON.parse(s); } catch {}
  return {};
}
function loadAiSuggestionsEnabled(): boolean {
  try { return localStorage.getItem('ai_suggestions_enabled') === 'true'; } catch {}
  return false;
}
function loadAiAutoInjectZaloContext(): boolean {
  try {
    const stored = localStorage.getItem('ai_auto_inject_zalo_context');
    return stored === null ? true : stored === 'true';
  } catch {}
  return true;
}
function loadAiQuickPanelContextCountOverride(): number | null {
  try {
    const stored = localStorage.getItem('ai_quick_panel_context_count_override');
    if (!stored) return null;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(100, Math.max(1, Math.round(parsed)));
  } catch {}
  return null;
}
function loadAiThreadAssistantMap(): Record<string, string> {
  try {
    const stored = localStorage.getItem('ai_thread_assistant_map');
    return stored ? JSON.parse(stored) : {};
  } catch {}
  return {};
}

// ─── Helper: write flag to DB via IPC (fire-and-forget) ─────────────────────
/**
 * Lưu cờ tắt thông báo / "Khác". UI đã đổi trước (optimistic); ghi lỗi (nhân viên mất kết nối Boss, không có quyền…)
 * → `revert()` trả lại trạng thái cũ + báo lỗi. Trước đây lỗi bị bỏ qua: UI báo đã tắt thông báo nhưng Boss không lưu.
 */
function persistFlag(
  zaloId: string,
  contactId: string,
  flags: { is_muted?: number; mute_until?: number; is_in_others?: number },
  revert: () => void,
) {
  const fail = (error?: string) => {
    revert();
    useAppStore.getState().showNotification(`Không lưu được thay đổi${error ? `: ${error}` : ''}`, 'error');
  };
  DataAccessor.setContactFlags({ zaloId, contactId, flags })
    .then((res: any) => { if (res && res.success === false) fail(res.error); })
    .catch((err: any) => fail(err?.message));
}

export const useAppStore = create<AppStore>((set, get) => ({
  view: 'dashboard',
  activePluginPage: null,
  openPluginPage: (pluginId, pageId) => set({ view: 'plugin', activePluginPage: { pluginId, pageId } }),
  openPluginHub: () => set({ view: 'plugin', activePluginPage: null }),
  pluginHubTab: 'installed',
  setPluginHubTab: (tab) => set({ pluginHubTab: tab }),
  pluginHubSection: 'plugins',
  setPluginHubSection: (section) => set({ pluginHubSection: section }),
  activePluginPanel: null,
  setActivePluginPanel: (panel) => set(panel
    ? { activePluginPanel: panel, showConversationInfo: false, showGroupBoard: false, showIntegrationQuickPanel: false, showAIQuickPanel: false }
    : { activePluginPanel: null }),
  isLoading: false,
  notification: null,
  erpPermissionDialog: null,
  addAccountModalOpen: false,
  addAccountInitialChannel: null,
  addAccountInitialProxyId: null,
  showConversationInfo: false,
  showGroupBoard: false,
  showIntegrationQuickPanel: false,
  showAIQuickPanel: false,
  openReminderPanel: false,
  searchOpen: false,
  searchHighlightQuery: '',
  aiSuggestionsEnabled: loadAiSuggestionsEnabled(),
  aiSuggestions: [],
  aiSuggestionsLoading: false,
  aiAutoInjectZaloContext: loadAiAutoInjectZaloContext(),
  aiQuickPanelContextCountOverride: loadAiQuickPanelContextCountOverride(),
  aiThreadAssistantMap: loadAiThreadAssistantMap(),
  aiSuggestDisabledThreads: loadAiDisabledThreads(),
  aiSuggestDisabledAccounts: loadAiDisabledAccounts(),
  quickChatOpen: false,
  quickChatTarget: null,
  quickChatZaloId: null,
  quickChatThread: null,
  labels: {},
  labelsVersionMap: {},
  labelsFetchedAt: {},
  mutedThreads: {},
  notifSettings: loadNotifSettings(),
  notifSettingsOverrides: loadNotifOverrides(),
  theme: loadTheme(),
  fontSizeScale: loadFontSizeScale(),
  groupInfoCache: {},
  othersConversations: {},
  hiddenConversations: {},
  hiddenUnlocked: {},
  mergedInboxMode: false,
  mergedInboxAccounts: [],
  mergedInboxFilterAccount: null,
  pinnedIntegrationShortcuts: loadPinnedShortcuts(),
  integrationPanelTarget: null,
  analyticsInitialTab: null as string | null,
  crmRequestUnseenByAccount: loadCRMRequestUnseen(),
  sidebarExpanded: false,
  accountSwitcherOpen: false,
  accountSwitcherIndex: 0,

  toggleSidebarExpanded: () => set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

  openQuickChat: (opts) => set({
    quickChatOpen: true,
    quickChatTarget: opts?.target ?? null,
    quickChatZaloId: opts?.zaloId ?? null,
  }),
  closeQuickChat: () => set({ quickChatOpen: false, quickChatTarget: null, quickChatZaloId: null, quickChatThread: null }),
  setQuickChatThread: (thread) => set((state) => {
    const current = state.quickChatThread;
    if (current?.zaloId === thread?.zaloId && current?.threadId === thread?.threadId && current?.threadType === thread?.threadType) return state;
    return { quickChatThread: thread };
  }),

  setView: (view) => set({ view }),
  setLoading: (isLoading) => set({ isLoading }),
  showNotification: (message, type = 'info') => {
    set({ notification: { message, type } });
    setTimeout(() => set({ notification: null }), 4000);
  },
  hideNotification: () => set({ notification: null }),
  showErpPermissionDialog: (payload) => set({
    erpPermissionDialog: {
      title: payload?.title || 'Không có quyền thực hiện',
      message: payload?.message || 'Tài khoản hiện tại không có quyền thực hiện thao tác ERP này. Vui lòng liên hệ quản trị viên để được cấp quyền phù hợp.',
      details: payload?.details,
    },
  }),
  hideErpPermissionDialog: () => set({ erpPermissionDialog: null }),
  setAddAccountModalOpen: (addAccountModalOpen, initialChannel, initialProxyId) => set({
    addAccountModalOpen,
    addAccountInitialChannel: initialChannel || null,
    addAccountInitialProxyId: initialProxyId ?? null,
  }),
  toggleConversationInfo: () => set((s) => ({
    showConversationInfo: !s.showConversationInfo,
    showGroupBoard: !s.showConversationInfo ? false : s.showGroupBoard,
    showIntegrationQuickPanel: !s.showConversationInfo ? false : s.showIntegrationQuickPanel,
    showAIQuickPanel: !s.showConversationInfo ? false : s.showAIQuickPanel,
  })),
  setShowGroupBoard: (open) => set((s) => ({
    showGroupBoard: open,
    showConversationInfo: open ? false : s.showConversationInfo,
    showIntegrationQuickPanel: open ? false : s.showIntegrationQuickPanel,
    showAIQuickPanel: open ? false : s.showAIQuickPanel,
  })),
  toggleIntegrationQuickPanel: () => set((s) => ({
    showIntegrationQuickPanel: !s.showIntegrationQuickPanel,
    showConversationInfo: !s.showIntegrationQuickPanel ? false : s.showConversationInfo,
    showGroupBoard: !s.showIntegrationQuickPanel ? false : s.showGroupBoard,
    showAIQuickPanel: !s.showIntegrationQuickPanel ? false : s.showAIQuickPanel,
  })),
  toggleAIQuickPanel: () => set((s) => ({
    showAIQuickPanel: !s.showAIQuickPanel,
    showConversationInfo: !s.showAIQuickPanel ? false : s.showConversationInfo,
    showGroupBoard: !s.showAIQuickPanel ? false : s.showGroupBoard,
    showIntegrationQuickPanel: !s.showAIQuickPanel ? false : s.showIntegrationQuickPanel,
  })),
  setAiSuggestionsEnabled: (enabled) => {
    try { localStorage.setItem('ai_suggestions_enabled', String(enabled)); } catch {}
    set({ aiSuggestionsEnabled: enabled, aiSuggestions: [] });
  },
  setAiSuggestions: (suggestions) => set({ aiSuggestions: suggestions }),
  setAiSuggestionsLoading: (loading) => set({ aiSuggestionsLoading: loading }),
  setAiAutoInjectZaloContext: (enabled) => {
    try { localStorage.setItem('ai_auto_inject_zalo_context', String(enabled)); } catch {}
    set({ aiAutoInjectZaloContext: enabled });
  },
  setAiQuickPanelContextCountOverride: (count) => {
    const normalized = count === null
      ? null
      : Math.min(100, Math.max(1, Math.round(Number(count) || 30)));
    try {
      if (normalized === null) localStorage.removeItem('ai_quick_panel_context_count_override');
      else localStorage.setItem('ai_quick_panel_context_count_override', String(normalized));
    } catch {}
    set({ aiQuickPanelContextCountOverride: normalized });
  },
  setAiThreadAssistant: (threadKey, assistantId) => {
    set((s) => {
      const next = { ...s.aiThreadAssistantMap, [threadKey]: assistantId };
      try { localStorage.setItem('ai_thread_assistant_map', JSON.stringify(next)); } catch {}
      return { aiThreadAssistantMap: next };
    });
  },
  toggleAiDisableForThread: (zaloId, threadId) => set((s) => {
    const key = `${zaloId}_${threadId}`;
    const next = { ...s.aiSuggestDisabledThreads };
    if (next[key]) { delete next[key]; } else { next[key] = true; }
    try { localStorage.setItem('ai_disabled_threads', JSON.stringify(next)); } catch {}
    return { aiSuggestDisabledThreads: next };
  }),
  toggleAiDisableForAccount: (zaloId) => set((s) => {
    const next = { ...s.aiSuggestDisabledAccounts };
    if (next[zaloId]) { delete next[zaloId]; } else { next[zaloId] = true; }
    try { localStorage.setItem('ai_disabled_accounts', JSON.stringify(next)); } catch {}
    return { aiSuggestDisabledAccounts: next };
  }),
  isAiSuggestDisabled: (zaloId, threadId) => {
    const s = get();
    if (!s.aiSuggestionsEnabled) return true;
    if (s.aiSuggestDisabledAccounts[zaloId]) return true;
    if (s.aiSuggestDisabledThreads[`${zaloId}_${threadId}`]) return true;
    return false;
  },
  setOpenReminderPanel: (open) => set({ openReminderPanel: open }),
  toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),
  setSearchOpen: (open) => set((s) => ({ searchOpen: open, searchHighlightQuery: open ? s.searchHighlightQuery : '' })),
  setSearchHighlightQuery: (query) => set({ searchHighlightQuery: query }),
  setLabels: (zaloId, ls) => set((s) => ({ labels: { ...s.labels, [zaloId]: ls } })),
  setLabelsVersion: (zaloId, version) => set((s) => ({ labelsVersionMap: { ...s.labelsVersionMap, [zaloId]: version } })),

  // ─── Labels cache (12h TTL, errors cached for 5 mins) ──────────────────
  fetchLabelsWithCache: async (zaloId, auth, force) => {
    const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours for success
    const ERROR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes for errors (don't retry too fast)
    
    const state = get();
    const lastFetched = state.labelsFetchedAt[zaloId] || 0;
    const cached = state.labels[zaloId];
    const cachedVersion = state.labelsVersionMap[zaloId] || 0;

    // Return cache if fresh enough and not forced
    if (!force && cached && (Date.now() - lastFetched) < CACHE_TTL) {
      return { labels: cached, version: cachedVersion };
    }

    // If we recently fetched (within error TTL), return cache to prevent spam
    if (!force && (Date.now() - lastFetched) < ERROR_CACHE_TTL) {
      return { labels: cached || [], version: cachedVersion };
    }

    // Employee mode: labels from Boss REST API
    if (useEmployeeStore.getState().mode === 'employee') {
      try {
        const res = await DataAccessor.getLocalLabels({ zaloId });
        // Lỗi: KHÔNG cache (trước đây lỗi = nhãn rỗng suốt 12 h) và giữ nhãn đang có. Không đóng dấu
        // labelsFetchedAt → lần đổi tài khoản / kết nối lại sau hỏi lại BOSS.
        if (isReadFailure(res)) return { labels: cached || [], version: cachedVersion };
        const labels = (res?.labels || []).map((l: any) => ({
          id: l.id,
          text: l.name || '',
          color: l.color || '#6b7280',
          emoji: l.emoji || '',
          conversations: [],
          textKey: `label_${l.id}`,
          offset: 0,
          createTime: Date.now(),
        }));
        set((s) => ({
          labels: { ...s.labels, [zaloId]: labels },
          labelsVersionMap: { ...s.labelsVersionMap, [zaloId]: 0 },
          labelsFetchedAt: { ...s.labelsFetchedAt, [zaloId]: Date.now() },
        }));
        return { labels, version: 0 };
      } catch {
        // Máy nhân viên không có phiên Zalo: không rơi xuống gọi Zalo API (lỗi đó lại bị cache 5 phút)
        return { labels: cached || [], version: cachedVersion };
      }
    }

    // Fetch from Zalo API
    try {
      const ipc = (window as any).electronAPI;
      const res = await ipc?.zalo?.getLabels({ auth });

      if (res?.success === false) {
        // Cache the error
        set((s) => ({
          labelsFetchedAt: { ...s.labelsFetchedAt, [zaloId]: Date.now() },
        }));
        return { labels: cached || [], version: cachedVersion };
      }
      
      if (res?.response?.labelData) {
        const labels = res.response.labelData;
        const version = res.response.version || 0;
        set((s) => ({
          labels: { ...s.labels, [zaloId]: labels },
          labelsVersionMap: { ...s.labelsVersionMap, [zaloId]: version },
          labelsFetchedAt: { ...s.labelsFetchedAt, [zaloId]: Date.now() },
        }));
        return { labels, version };
      }
      
      // No labelData in response - cache empty result
      set((s) => ({
        labels: { ...s.labels, [zaloId]: [] },
        labelsFetchedAt: { ...s.labelsFetchedAt, [zaloId]: Date.now() },
      }));
      return { labels: [], version: cachedVersion };
      
    } catch (err) {
      // Cache the error timestamp to prevent retry spam
      set((s) => ({
        labelsFetchedAt: { ...s.labelsFetchedAt, [zaloId]: Date.now() },
      }));
      
      // Return whatever cache we have
      return { labels: cached || [], version: cachedVersion };
    }
  },

  // ─── Bulk load flags from DB ─────────────────────────────────────────
  loadFlags: async (zaloId) => {
    try {
      const res = await DataAccessor.getContactsWithFlags(zaloId);
      // Lỗi (employee: mất kết nối BOSS) → giữ cờ đang có: thay bằng rỗng làm "Khác" trống và hội thoại
      // đang tắt tiếng kêu lại. reloadEmployeeData tải lại khi kết nối phục hồi.
      if (!res?.success) return;

      const newMuted: Record<string, number> = {};
      const othersSet = new Set<string>();
      const hiddenSet = new Set<string>();

      for (const row of (res.rows || [])) {
        // Mute: is_muted=1 (indefinite) OR mute_until > now (timed)
        if (row.is_muted === 1) {
          newMuted[row.contact_id] = 0; // indefinite
        } else if (row.mute_until > 0 && row.mute_until > Date.now()) {
          newMuted[row.contact_id] = row.mute_until;
        }
        // "Khác" folder: is_in_others=1 hoặc telegram_archived=1
        if (row.is_in_others === 1 || row.telegram_archived === 1) {
          othersSet.add(row.contact_id);
        }
        // Hội thoại ẩn bằng PIN của Zalo (ZL-03)
        if (Number(row.zalo_hidden) === 1) hiddenSet.add(row.contact_id);
      }

      set((s) => ({
        mutedThreads: { ...s.mutedThreads, [zaloId]: newMuted },
        othersConversations: { ...s.othersConversations, [zaloId]: othersSet },
        hiddenConversations: { ...s.hiddenConversations, [zaloId]: hiddenSet },
      }));
    } catch {}
  },

  reloadEmployeeData: async (zaloIds) => {
    if (useEmployeeStore.getState().mode !== 'employee') return;
    const s = get();
    const activeId = useAccountStore.getState().activeAccountId;
    const ids = (zaloIds && zaloIds.length > 0)
      ? zaloIds
      : (s.mergedInboxMode && s.mergedInboxAccounts.length > 0 ? s.mergedInboxAccounts : (activeId ? [activeId] : []));
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    const accounts = useAccountStore.getState().accounts;
    await Promise.allSettled(unique.flatMap((zaloId) => {
      const tasks: Promise<unknown>[] = [get().loadFlags(zaloId)];
      // Nhãn chỉ nạp cho tài khoản Zalo (như ConversationList). `force`: nhãn đã cache trước lúc mất kết nối có
      // thể đã đổi trên BOSS; nhánh nhân viên không dùng auth.
      if (isZalo(accounts.find((a) => a.zalo_id === zaloId)?.channel)) {
        tasks.push(get().fetchLabelsWithCache(zaloId, null, true));
      }
      return tasks;
    }));
  },

  // ─── Mute ────────────────────────────────────────────────────────────
  setMuted: (zaloId, contactId, until) => {
    const previous = get().mutedThreads[zaloId]?.[contactId];
    // until=0 → indefinite, until>0 → epoch ms expiry
    set((s) => ({
      mutedThreads: { ...s.mutedThreads, [zaloId]: { ...(s.mutedThreads[zaloId] || {}), [contactId]: until } },
    }));
    // Lỗi lưu → trả về giá trị trước (nếu chưa ai đổi tiếp)
    const revert = () => set((s) => {
      if (s.mutedThreads[zaloId]?.[contactId] !== until) return {};
      const next = { ...(s.mutedThreads[zaloId] || {}) };
      if (previous === undefined) delete next[contactId]; else next[contactId] = previous;
      return { mutedThreads: { ...s.mutedThreads, [zaloId]: next } };
    });
    // Persist: is_muted=1 for indefinite, mute_until=epoch for timed
    if (until === 0) {
      persistFlag(zaloId, contactId, { is_muted: 1, mute_until: 0 }, revert);
    } else {
      persistFlag(zaloId, contactId, { is_muted: 0, mute_until: until }, revert);
    }
  },

  clearMuted: (zaloId, contactId) => {
    const previous = get().mutedThreads[zaloId]?.[contactId];
    set((s) => {
      const prev = { ...(s.mutedThreads[zaloId] || {}) };
      delete prev[contactId];
      return { mutedThreads: { ...s.mutedThreads, [zaloId]: prev } };
    });
    persistFlag(zaloId, contactId, { is_muted: 0, mute_until: 0 }, () => set((s) => {
      if (previous === undefined || s.mutedThreads[zaloId]?.[contactId] !== undefined) return {};
      return { mutedThreads: { ...s.mutedThreads, [zaloId]: { ...(s.mutedThreads[zaloId] || {}), [contactId]: previous } } };
    }));
  },

  isMuted: (zaloId, contactId) => {
    const until = (get().mutedThreads[zaloId] || {})[contactId];
    if (until === undefined) return false;
    if (until === 0) return true;          // indefinite
    return Date.now() < until;             // timed
  },

  getMuteUntil: (zaloId, contactId) => (get().mutedThreads[zaloId] || {})[contactId],

  setNotifSettings: (settings) => set((s) => {
    const updated = { ...s.notifSettings, ...settings };
    try { localStorage.setItem('app_notifSettings', JSON.stringify(updated)); } catch {}
    return { notifSettings: updated };
  }),

  getNotifSettingsForAccount: (zaloId) => {
    const state = get();
    return effectiveNotifSettings(state.notifSettings, state.notifSettingsOverrides[zaloId]);
  },

  setNotifSettingsForAccount: async (zaloId, settings) => {
    if (!zaloId) return;
    const state = get();
    const overrides = withAccountNotifSettings(state.notifSettings, state.notifSettingsOverrides, zaloId, settings);
    saveNotifOverrides(overrides);
    set({ notifSettingsOverrides: overrides });
  },

  resetNotifSettingsForAccount: (zaloId) => {
    const current = get().notifSettingsOverrides;
    if (!current[zaloId]) return;
    const overrides = { ...current };
    delete overrides[zaloId];
    saveNotifOverrides(overrides);
    set({ notifSettingsOverrides: overrides });
  },

  setTheme: (theme) => {
    try { localStorage.setItem('app_theme', theme); } catch {}
    set({ theme });
  },

  setFontSizeScale: (scale) => {
    try { localStorage.setItem(FONT_SCALE_KEY, String(scale)); } catch {}
    set({ fontSizeScale: scale });
    document.documentElement.style.fontSize = `${16 * scale}px`;
  },

  // ─── Others folder ───────────────────────────────────────────────────
  addToOthers: (zaloId, contactId) => {
    const wasIn = (get().othersConversations[zaloId] || new Set()).has(contactId);
    set((s) => {
      const prev = new Set(s.othersConversations[zaloId] || []);
      prev.add(contactId);
      return { othersConversations: { ...s.othersConversations, [zaloId]: prev } };
    });
    persistFlag(zaloId, contactId, { is_in_others: 1 }, () => {
      if (wasIn) return;
      set((s) => {
        const prev = new Set(s.othersConversations[zaloId] || []);
        prev.delete(contactId);
        return { othersConversations: { ...s.othersConversations, [zaloId]: prev } };
      });
    });
  },

  removeFromOthers: (zaloId, contactId) => {
    const wasIn = (get().othersConversations[zaloId] || new Set()).has(contactId);
    set((s) => {
      const prev = new Set(s.othersConversations[zaloId] || []);
      prev.delete(contactId);
      return { othersConversations: { ...s.othersConversations, [zaloId]: prev } };
    });
    persistFlag(zaloId, contactId, { is_in_others: 0 }, () => {
      if (!wasIn) return;
      set((s) => {
        const prev = new Set(s.othersConversations[zaloId] || []);
        prev.add(contactId);
        return { othersConversations: { ...s.othersConversations, [zaloId]: prev } };
      });
    });
  },

  isInOthers: (zaloId, contactId) => {
    return (get().othersConversations[zaloId] || new Set()).has(contactId);
  },

  isZaloHidden: (zaloId, contactId) => !!get().hiddenConversations[zaloId]?.has(contactId),

  isHiddenLocked: (zaloId, contactId) => !!get().hiddenConversations[zaloId]?.has(contactId) && !get().hiddenUnlocked[zaloId],

  setHiddenUnlocked: (zaloId, unlocked) => set((s) => {
    if (!zaloId || !!s.hiddenUnlocked[zaloId] === unlocked) return s;
    const next = { ...s.hiddenUnlocked };
    if (unlocked) next[zaloId] = Date.now();
    else delete next[zaloId];
    return { hiddenUnlocked: next };
  }),

  lockAllHidden: () => set((s) => (Object.keys(s.hiddenUnlocked).length === 0 ? s : { hiddenUnlocked: {} })),

  setHiddenThreads: (zaloId, contactIds) => set((s) => ({
    hiddenConversations: { ...s.hiddenConversations, [zaloId]: new Set(contactIds.map(String)) },
  })),

  applyContactFlags: (zaloId, contactId, flags) => {
    if (!zaloId || !contactId || !flags) return;
    set((s) => {
      const patch: Partial<AppStore> = {};
      // Tắt tiếng: is_muted=1 → vô thời hạn (0); mute_until > now → có hạn; còn lại → bỏ tắt tiếng.
      // Thiếu một nửa (chỉ is_muted / chỉ mute_until) → nửa còn lại lấy theo giá trị đang có.
      if (flags.is_muted !== undefined || flags.mute_until !== undefined) {
        const accountMuted = s.mutedThreads[zaloId] || {};
        const current = accountMuted[contactId];
        const isMuted = flags.is_muted !== undefined ? Number(flags.is_muted) === 1 : current === 0;
        const until = flags.mute_until !== undefined ? Number(flags.mute_until) || 0 : (current && current > 0 ? current : 0);
        const next = isMuted ? 0 : (until > Date.now() ? until : undefined);
        if (next !== current) {
          const updated = { ...accountMuted };
          if (next === undefined) delete updated[contactId];
          else updated[contactId] = next;
          patch.mutedThreads = { ...s.mutedThreads, [zaloId]: updated };
        }
      }
      if (flags.is_in_others !== undefined) {
        const others = s.othersConversations[zaloId];
        const inOthers = Number(flags.is_in_others) === 1;
        if (!!others?.has(contactId) !== inOthers) {
          const updated = new Set(others || []);
          if (inOthers) updated.add(contactId);
          else updated.delete(contactId);
          patch.othersConversations = { ...s.othersConversations, [zaloId]: updated };
        }
      }
      if (flags.zalo_hidden !== undefined) {
        const current = s.hiddenConversations[zaloId];
        const isHidden = Number(flags.zalo_hidden) === 1;
        if (!!current?.has(contactId) !== isHidden) {
          const updated = new Set(current || []);
          if (isHidden) updated.add(contactId);
          else updated.delete(contactId);
          patch.hiddenConversations = { ...s.hiddenConversations, [zaloId]: updated };
        }
      }
      return Object.keys(patch).length > 0 ? patch : s;
    });
  },

  // ─── Merged inbox ────────────────────────────────────────────────────
  enterMergedInbox: (accountIds) => set({ mergedInboxMode: true, mergedInboxAccounts: accountIds, mergedInboxFilterAccount: null, view: 'chat' }),
  exitMergedInbox: () => set({ mergedInboxMode: false, mergedInboxAccounts: [], mergedInboxFilterAccount: null }),
  setMergedInboxFilter: (zaloId) => set({ mergedInboxFilterAccount: zaloId }),

  // ─── Group info cache ─────────────────────────────────────────────────
  setGroupInfo: (zaloId, groupId, info) => set((s) => ({
    groupInfoCache: {
      ...s.groupInfoCache,
      [zaloId]: { ...(s.groupInfoCache[zaloId] || {}), [groupId]: info },
    },
  })),

  getGroupInfo: (zaloId, groupId) => {
    return (get().groupInfoCache[zaloId] || {})[groupId];
  },

  clearGroupInfo: (zaloId, groupId) => set((s) => {
    const accountCache = { ...(s.groupInfoCache[zaloId] || {}) };
    delete accountCache[groupId];
    return { groupInfoCache: { ...s.groupInfoCache, [zaloId]: accountCache } };
  }),

  // ─── Mobile responsive ──────────────────────────────────────────────
  mobileShowChat: false,
  setMobileShowChat: (show) => set({ mobileShowChat: show }),

  // ─── Pinned integration shortcuts ──────────────────────────────────────────
  pinIntegrationShortcut: (shortcut) => set((s) => {
    // Prevent duplicates for same integration+action
    const existing = s.pinnedIntegrationShortcuts.find(
      p => p.integrationId === shortcut.integrationId && p.action === shortcut.action
    );
    if (existing) return {};
    const newShortcut: PinnedIntegrationShortcut = {
      ...shortcut,
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    };
    const updated = [...s.pinnedIntegrationShortcuts, newShortcut];
    savePinnedShortcuts(updated);
    return { pinnedIntegrationShortcuts: updated };
  }),

  unpinIntegrationShortcut: (id) => set((s) => {
    const updated = s.pinnedIntegrationShortcuts.filter(p => p.id !== id);
    savePinnedShortcuts(updated);
    return { pinnedIntegrationShortcuts: updated };
  }),

  editPinnedShortcutIcon: (id, icon) => set((s) => {
    const updated = s.pinnedIntegrationShortcuts.map(p => p.id === id ? { ...p, icon } : p);
    savePinnedShortcuts(updated);
    return { pinnedIntegrationShortcuts: updated };
  }),

  setIntegrationPanelTarget: (target) => set({ integrationPanelTarget: target }),

  openIntegrationPanelTo: (integrationId, action) => set({
    integrationPanelTarget: { integrationId, action },
    showIntegrationQuickPanel: true,
    showConversationInfo: false,
    showGroupBoard: false,
  }),

  // ─── Analytics navigation ──────────────────────────────────────────
  setAnalyticsInitialTab: (tab) => set({ analyticsInitialTab: tab }),
  navigateToAnalytics: (tab) => set({ view: 'analytics', analyticsInitialTab: tab || null }),

  markCRMRequestUnseen: (zaloId) => set((s) => {
    if (!zaloId || s.crmRequestUnseenByAccount[zaloId]) return {};
    const next = { ...s.crmRequestUnseenByAccount, [zaloId]: true };
    saveCRMRequestUnseen(next);
    return { crmRequestUnseenByAccount: next };
  }),

  clearCRMRequestUnseen: (zaloId) => set((s) => {
    if (!zaloId || !s.crmRequestUnseenByAccount[zaloId]) return {};
    const next = { ...s.crmRequestUnseenByAccount };
    delete next[zaloId];
    saveCRMRequestUnseen(next);
    return { crmRequestUnseenByAccount: next };
  }),

  hasCRMRequestUnseen: (zaloId) => !!get().crmRequestUnseenByAccount[zaloId],
  hasAnyCRMRequestUnseen: () => Object.values(get().crmRequestUnseenByAccount).some(Boolean),

  // ── Account switcher (Ctrl+Tab) ──────────────────────────────────────────
  /** Số items: merged mode → "Tất cả" (index 0) + accounts; normal → chỉ accounts */
  openAccountSwitcher: () => set((s) => {
    const accs = useAccountStore.getState().accounts;
    const total = s.mergedInboxMode ? accs.length + 1 : accs.length;
    if (s.accountSwitcherOpen) {
      // Ctrl still held + Tab again → advance
      return { accountSwitcherIndex: (s.accountSwitcherIndex + 1) % total };
    }
    // Find current active account to highlight it
    const activeId = useAccountStore.getState().activeAccountId;
    let startIdx = accs.findIndex(a => a.zalo_id === activeId);
    if (startIdx < 0) startIdx = 0;
    if (s.mergedInboxMode) startIdx += 1; // "Tất cả" ở index 0
    return { accountSwitcherOpen: true, accountSwitcherIndex: startIdx };
  }),
  closeAccountSwitcher: (select) => set((s) => {
    if (!s.accountSwitcherOpen) return {};
    if (select) {
      const accs = useAccountStore.getState().accounts;
      const idx = s.accountSwitcherIndex;
      // Merged mode: index 0 = "Tất cả", 1..N = accounts[0..N-1]
      // Normal mode: 0..N-1 = accounts[0..N-1] directly
      if (s.mergedInboxMode) {
        if (idx === 0) {
          return { accountSwitcherOpen: false, accountSwitcherIndex: 0, mergedInboxFilterAccount: null };
        }
        const acc = accs[idx - 1];
        if (acc) {
          return { accountSwitcherOpen: false, accountSwitcherIndex: 0, mergedInboxFilterAccount: acc.zalo_id };
        }
      } else {
        const acc = accs[idx];
        const activeId = useAccountStore.getState().activeAccountId;
        if (acc && acc.zalo_id !== activeId) {
          useAccountStore.getState().setActiveAccount(acc.zalo_id);
        }
      }
    }
    return { accountSwitcherOpen: false, accountSwitcherIndex: 0 };
  }),
  nextAccountSwitcher: () => set((s) => {
    const accs = useAccountStore.getState().accounts;
    const total = s.mergedInboxMode ? accs.length + 1 : accs.length;
    return { accountSwitcherIndex: (s.accountSwitcherIndex + 1) % total };
  }),
  prevAccountSwitcher: () => set((s) => {
    const accs = useAccountStore.getState().accounts;
    const total = s.mergedInboxMode ? accs.length + 1 : accs.length;
    return { accountSwitcherIndex: (s.accountSwitcherIndex - 1 + total) % total };
  }),
}));
