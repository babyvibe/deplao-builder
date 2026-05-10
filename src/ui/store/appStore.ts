import { create } from 'zustand';

type AppView = 'chat' | 'friends' | 'settings' | 'dashboard' | 'crm' | 'workflow' | 'integration' | 'analytics' | 'erp';
export type AppTheme = 'dark' | 'light';

export interface GroupMember {
  userId: string;
  displayName: string;
  avatar: string;
  role: number; // 0=member, 1=owner, 2=deputy
}

export interface CachedGroupInfo {
  groupId: string;
  name: string;
  avatar: string;
  memberCount: number;
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
  isLoading: boolean;
  notification: { message: string; type: 'success' | 'error' | 'info' | 'warning' } | null;
  erpPermissionDialog: { title: string; message: string; details?: string } | null;
  addAccountModalOpen: boolean;
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
  /** In-memory others cache: zaloId -> Set<contactId> */
  othersConversations: Record<string, Set<string>>;

  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;

  setView: (view: AppView) => void;
  setLoading: (loading: boolean) => void;
  showNotification: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  hideNotification: () => void;
  showErpPermissionDialog: (payload?: { title?: string; message?: string; details?: string }) => void;
  hideErpPermissionDialog: () => void;
  setAddAccountModalOpen: (open: boolean) => void;
  toggleConversationInfo: () => void;
  setShowGroupBoard: (open: boolean) => void;
  toggleIntegrationQuickPanel: () => void;
  toggleAIQuickPanel: () => void;
  setAiSuggestionsEnabled: (enabled: boolean) => void;
  setAiSuggestions: (suggestions: string[]) => void;
  setAiSuggestionsLoading: (loading: boolean) => void;
  setAiAutoInjectZaloContext: (enabled: boolean) => void;
  setAiQuickPanelContextCountOverride: (count: number | null) => void;
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
   */
  loadFlags: (zaloId: string) => Promise<void>;

  /** Mute a contact. Persists to DB + updates in-memory cache. */
  setMuted: (zaloId: string, contactId: string, until: number) => void;
  /** Unmute a contact. Persists to DB + updates in-memory cache. */
  clearMuted: (zaloId: string, contactId: string) => void;
  /** Returns true if contact is actively muted (checks expiry). Fast in-memory read. */
  isMuted: (zaloId: string, contactId: string) => boolean;
  getMuteUntil: (zaloId: string, contactId: string) => number | undefined;

  setNotifSettings: (settings: Partial<NotifSettings>) => void;

  /** Move a contact to Others folder. Persists to DB + updates in-memory cache. */
  addToOthers: (zaloId: string, contactId: string) => void;
  /** Remove a contact from Others folder. Persists to DB + updates in-memory cache. */
  removeFromOthers: (zaloId: string, contactId: string) => void;
  /** Fast in-memory check. */
  isInOthers: (zaloId: string, contactId: string) => boolean;

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
}

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

// ─── Helper: write flag to DB via IPC (fire-and-forget) ─────────────────────
function persistFlag(zaloId: string, contactId: string, flags: { is_muted?: number; mute_until?: number; is_in_others?: number }) {
  try {
    // ipc is imported lazily to avoid circular dependency at module init time
    const ipc = (window as any).electronAPI?.db;
    if (ipc?.setContactFlags) {
      ipc.setContactFlags({ zaloId, contactId, flags }).catch(() => {});
    }
  } catch {}
}

export const useAppStore = create<AppStore>((set, get) => ({
  view: 'dashboard',
  isLoading: false,
  notification: null,
  erpPermissionDialog: null,
  addAccountModalOpen: false,
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
  aiSuggestDisabledThreads: loadAiDisabledThreads(),
  aiSuggestDisabledAccounts: loadAiDisabledAccounts(),
  quickChatOpen: false,
  quickChatTarget: null,
  quickChatZaloId: null,
  labels: {},
  labelsVersionMap: {},
  labelsFetchedAt: {},
  mutedThreads: {},
  notifSettings: loadNotifSettings(),
  theme: loadTheme(),
  groupInfoCache: {},
  othersConversations: {},
  mergedInboxMode: false,
  mergedInboxAccounts: [],
  mergedInboxFilterAccount: null,
  pinnedIntegrationShortcuts: loadPinnedShortcuts(),
  integrationPanelTarget: null,
  analyticsInitialTab: null as string | null,
  crmRequestUnseenByAccount: loadCRMRequestUnseen(),

  openQuickChat: (opts) => set({
    quickChatOpen: true,
    quickChatTarget: opts?.target ?? null,
    quickChatZaloId: opts?.zaloId ?? null,
  }),
  closeQuickChat: () => set({ quickChatOpen: false, quickChatTarget: null, quickChatZaloId: null }),

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
  setAddAccountModalOpen: (addAccountModalOpen) => set({ addAccountModalOpen }),
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
      const ipcDb = (window as any).electronAPI?.db;
      if (!ipcDb?.getContactsWithFlags) return;
      const res = await ipcDb.getContactsWithFlags({ zaloId });
      if (!res?.success) return;

      const newMuted: Record<string, number> = {};
      const othersSet = new Set<string>();

      for (const row of (res.rows || [])) {
        // Mute: is_muted=1 (indefinite) OR mute_until > now (timed)
        if (row.is_muted === 1) {
          newMuted[row.contact_id] = 0; // indefinite
        } else if (row.mute_until > 0 && row.mute_until > Date.now()) {
          newMuted[row.contact_id] = row.mute_until;
        }
        if (row.is_in_others === 1) {
          othersSet.add(row.contact_id);
        }
      }

      set((s) => ({
        mutedThreads: { ...s.mutedThreads, [zaloId]: newMuted },
        othersConversations: { ...s.othersConversations, [zaloId]: othersSet },
      }));
    } catch {}
  },

  // ─── Mute ────────────────────────────────────────────────────────────
  setMuted: (zaloId, contactId, until) => {
    // until=0 → indefinite, until>0 → epoch ms expiry
    set((s) => ({
      mutedThreads: { ...s.mutedThreads, [zaloId]: { ...(s.mutedThreads[zaloId] || {}), [contactId]: until } },
    }));
    // Persist: is_muted=1 for indefinite, mute_until=epoch for timed
    if (until === 0) {
      persistFlag(zaloId, contactId, { is_muted: 1, mute_until: 0 });
    } else {
      persistFlag(zaloId, contactId, { is_muted: 0, mute_until: until });
    }
  },

  clearMuted: (zaloId, contactId) => {
    set((s) => {
      const prev = { ...(s.mutedThreads[zaloId] || {}) };
      delete prev[contactId];
      return { mutedThreads: { ...s.mutedThreads, [zaloId]: prev } };
    });
    persistFlag(zaloId, contactId, { is_muted: 0, mute_until: 0 });
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

  setTheme: (theme) => {
    try { localStorage.setItem('app_theme', theme); } catch {}
    set({ theme });
  },

  // ─── Others folder ───────────────────────────────────────────────────
  addToOthers: (zaloId, contactId) => {
    set((s) => {
      const prev = new Set(s.othersConversations[zaloId] || []);
      prev.add(contactId);
      return { othersConversations: { ...s.othersConversations, [zaloId]: prev } };
    });
    persistFlag(zaloId, contactId, { is_in_others: 1 });
  },

  removeFromOthers: (zaloId, contactId) => {
    set((s) => {
      const prev = new Set(s.othersConversations[zaloId] || []);
      prev.delete(contactId);
      return { othersConversations: { ...s.othersConversations, [zaloId]: prev } };
    });
    persistFlag(zaloId, contactId, { is_in_others: 0 });
  },

  isInOthers: (zaloId, contactId) => {
    return (get().othersConversations[zaloId] || new Set()).has(contactId);
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
}));
