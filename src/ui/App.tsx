import React, { Suspense, useCallback, useEffect, useState, useRef } from 'react';
import TopBar from './components/layout/topbar/TopBar';
import Sidebar from './components/layout/sidebar/Sidebar';
import AccountPanel from './components/layout/sidebar/AccountPanel';
import ConversationList from './components/chat/conversations/ConversationList';
import ChatHeader from './components/chat/header/ChatHeader';
import ChatWindow from './components/chat/window/ChatWindow';
import MessageInput from './components/chat/composer/MessageInput';
import { TelegramPostDiscussionHost } from './components/chat/telegram/posts/TelegramPostDiscussion';
import ConversationInfo from './components/chat/info/ConversationInfo';
import GroupBoardPanel from './components/chat/groups/GroupBoardPanel';
import IntegrationQuickPanel from './components/integration/IntegrationQuickPanel';
import PluginPagesHost from './components/plugins/runtime/PluginPagesHost';
import PluginChatPanel from './components/plugins/contributions/PluginChatPanel';
import { initPluginStore } from './store/plugins/pluginStore';
import AIQuickPanel from './components/integration/ai/AIQuickPanel';
import ReminderNotification, { type ReminderData } from './components/chat/reminders/ReminderNotification';
import {
  ERP_EVENT_EMOJI, erpReminderHeading, erpReminderNote, erpReminderWhen, isErpReminderForMe, isMissedErpReminder,
} from './lib/erp/erpReminder';
import { playNotificationSound, showDesktopNotification } from './lib/notifications/NotificationService';
import { openLinkedConversation } from './lib/erp/erpLinkedConversation';
import { useErpReminderAttention } from './store/erp/erpReminderAttentionStore';
import { erpReminderLeadText } from '../shared/erp/erpReminderText';
import FriendRequestNotification, { FriendRequestNotifData } from './components/common/notifications/FriendRequestNotification';
import InAppMessageToasts from './components/common/notifications/InAppMessageToasts';
import { useInAppNotifyStore } from './store/chat/inAppNotifyStore';
import QuickChatModal from './components/chat/quick/QuickChatModal';
import AccountInitPanel from './components/common/accounts/AccountInitPanel';
import AccountSwitcherOverlay from './components/common/accounts/AccountSwitcherOverlay';
import TelegramIncomingCall from './components/chat/telegram/quick/TelegramIncomingCall';
import { UpdateNotification } from './components/common/notifications/UpdateNotification';
import { useAppStore } from './store/app/appStore';
import { useAccountStore } from './store/accounts/accountStore';
import { useChatStore } from './store/chat/chatStore';
import { useShallow } from 'zustand/react/shallow';
import { useCRMStore } from './store/crm/crmStore';
import { useZaloEvents } from './hooks/chat/useZaloEvents';
import { useChatEvents } from './hooks/chat/useChatEvents';
import useIsMobile from './hooks/layout/useIsMobile';
import ipc, { buildZaloAuth } from './lib/ipc';
import { reportUiSettledWhenReady } from '@/lib/app/startupSettled';
import { liveReadSync } from './lib/chat/read/liveReadSync';
import { getFilteredUnreadCount } from './lib/notifications/badgeUtils';
import DataAccessor, { isReadFailure } from './lib/data/DataAccessor';
import { reloadAccountContacts } from './lib/chat/conversations/accountContacts';
import { checkAccountInitNeeds } from './lib/zalo/zaloInitUtils';
import AddAccountModal from "@/components/auth/login/AddAccountModal";
import EmployeeConnectionBanner from "@/components/common/notifications/EmployeeConnectionBanner";
import { useWorkspaceStore } from './store/app/workspaceStore';
import { useEmployeeStore } from './store/employee/employeeStore';
import RestQueryService from '../services/http/RestQueryService';
import {
  AUTH_EXPIRED_MESSAGE,
  createThrottleGate,
  normalizeBossUrl,
  SNAPSHOT_REFRESH_THROTTLE_MS,
} from '../shared/employee/employeeConnection';
import LockScreen from './components/auth/lock/LockScreen';
import { Spinner } from '@/components/common/PageLoading';
import { GlobeIcon } from '@/components/common/icons';
import { CHANNEL, isZalo, isNonZalo, isFacebook } from '@/lib/channels/channelHelper';

// These pages pull in editors, charts, React Flow and large ERP modules. They
// are not needed for the first chat frame, so defer them until their view opens.
const Dashboard = React.lazy(() => import('./components/dashboard/Dashboard'));
const Settings = React.lazy(() => import('./components/settings/Settings'));
const CRMPage = React.lazy(() => import('./components/crm/CRMPage'));
const WorkflowPage = React.lazy(() => import('./components/workflow/WorkflowPage'));
const IntegrationPage = React.lazy(() => import('./components/integration/IntegrationPage'));
const AnalyticsPage = React.lazy(() => import('./components/analytics/AnalyticsPage'));
const ErpPage = React.lazy(() => import('./components/erp/ErpPage'));

const HEALTH_CHECK_INTERVAL_MS = 60 * 1000; // 1 phút
const NETWORK_RECONNECT_COOLDOWN_MS = 15 * 1000; // 15 giây

type WorkspacePermissionCache = { module: string; can_access: boolean };
type WorkspaceAccountCache = {
  zalo_id: string;
  full_name: string;
  avatar_url: string;
  phone?: string;
  is_business?: number;
  is_active?: number;
  listener_active?: number;
  /** zalo | facebook | telegram_user | telegram_bot — Boss gửi trong snapshot (bản Boss cũ không có → Zalo) */
  channel?: string;
};

function buildPermissionsMap(permissions?: WorkspacePermissionCache[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const permission of (permissions || [])) {
    result[permission.module] = !!permission.can_access;
  }
  return result;
}

function normalizeWorkspaceAccounts(accounts?: WorkspaceAccountCache[]) {
  return (accounts || []).map((account: any) => {
    const listenerState = account.listener_active ?? account.listenerActive ?? (account.isConnected ? 1 : 0);
    const fullName = account.full_name || account.display_name || account.zalo_id;
    // Kênh của tài khoản (snapshot Boss): thiếu thì tài khoản Facebook / Telegram bị coi là Zalo (sai adapter, không có
    // nút đồng bộ…). Trạng thái (listener_active) Boss tính theo kênh — không hỏi phiên cục bộ của máy nhân viên.
    const channel = typeof account.channel === 'string' && account.channel ? account.channel : undefined;
    return {
    zalo_id: account.zalo_id,
    ...(channel ? { channel } : {}),
    ...(channel === 'facebook' ? { facebook_id: account.facebook_id || account.zalo_id } : {}),
    display_name: fullName,
    full_name: fullName,
    avatar_url: account.avatar_url || '',
    phone: account.phone || '',
    is_business: account.is_business || 0,
    ...(account.send2me_id ? { send2me_id: String(account.send2me_id) } : {}),
    imei: '',
    user_agent: '',
    cookies: '',
    is_active: account.is_active ?? 1,
    created_at: '',
    listenerActive: !!listenerState,
    isConnected: !!listenerState,
    isOnline: !!listenerState,
  };
  });
}

function buildCurrentEmployeeFromWorkspace(ws: any) {
  if (!ws || ws.type !== 'remote') return null;
  const cachedEmployee = ws.cachedEmployeesData?.find((employee: any) => employee.employee_id === (ws.employeeId || ''));
  return {
    employee_id: ws.employeeId || '',
    username: cachedEmployee?.username || ws.employeeUsername || '',
    display_name: cachedEmployee?.display_name || ws.employeeName || ws.name || 'Nhân viên',
    avatar_url: cachedEmployee?.avatar_url || '',
    role: 'employee' as const,
    is_active: cachedEmployee?.is_active ?? 1,
    permissions: cachedEmployee?.permissions || ws.cachedPermissions || [],
    assigned_accounts: cachedEmployee?.assigned_accounts || ws.cachedAssignedAccounts || [],
  };
}

function ensureActiveAccount(accounts: Array<{ zalo_id: string }>) {
  if (!accounts.length) return;
  const accountStore = useAccountStore.getState();
  const activeAccountStillVisible = !!accountStore.activeAccountId
    && accounts.some((account) => account.zalo_id === accountStore.activeAccountId);
  if (!activeAccountStillVisible) {
    accountStore.setActiveAccount(accounts[0].zalo_id);
  }
}

/**
 * Init REST client của nhân viên bằng Boss URL + token LẤY TỪ CẤU HÌNH WORKSPACE Ở MAIN (nguồn sự thật
 * duy nhất): getActive() lúc mở app, payload workspace:switched, sự kiện employee:credentials.
 * Không bao giờ init từ kết quả đăng nhập ở renderer. RestQueryService.init idempotent (cùng giá trị → giữ nguyên).
 */
function applyEmployeeCredentials(bossUrl: string | undefined, token: string | undefined, source: string): void {
  const url = normalizeBossUrl(bossUrl);
  if (!url || !token) return;
  RestQueryService.getInstance().init(url, token);
  const empStore = useEmployeeStore.getState();
  if (empStore.bossUrl !== url) empStore.setBossUrl(url);
  if (empStore.token !== token) empStore.setToken(token);
  console.log(`[App] REST credentials (${source}): ${url}`);
}

const snapshotRefreshGate = createThrottleGate(SNAPSHOT_REFRESH_THROTTLE_MS);

/**
 * Làm mới snapshot nhân viên (quyền + tài khoản được giao) qua đường boot/snapshot của main
 * (/api/sync/snapshot → workspace:initialState { forced }) — tối đa 1 lần / 10 s / workspace.
 */
function refreshEmployeeSnapshot(reason: string): void {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!workspaceId || useEmployeeStore.getState().mode !== 'employee') return;
  if (!snapshotRefreshGate(workspaceId)) return;
  console.log(`[App] Làm mới snapshot nhân viên (${reason})`);
  ipc.workspace?.refreshSnapshot?.(workspaceId, reason)
    .then((res) => {
      if (!res?.success) console.warn(`[App] refreshSnapshot (${reason}) thất bại: ${res?.error || 'unknown'}`);
    })
    .catch(() => {});
}

async function loadEmployeeConversationsForAccounts(accounts: Array<{ zalo_id: string }>, limit = 200) {
  if (!accounts.length) return;
  const chatStore = useChatStore.getState();
  for (const account of accounts) {
    chatStore.setConversationsLoading(account.zalo_id, true);
  }
  try {
    for (const account of accounts) {
      const existing = useChatStore.getState().contacts[account.zalo_id];
      if ((existing?.length || 0) >= limit) continue;

      try {
        const result = await DataAccessor.getConversations(account.zalo_id, limit, 0);
        const items = Array.isArray(result?.items) ? result.items : [];
        if (items.length > 0) {
          console.log(`[App] Loaded ${items.length} conversations from REST for ${account.zalo_id}`);
          const current = useChatStore.getState().contacts[account.zalo_id] || [];
          const seen = new Set(items.map((contact: any) => contact.contact_id));
          useChatStore.getState().setContacts(account.zalo_id, [
            ...items,
            ...current.filter((contact: any) => !seen.has(contact.contact_id)),
          ]);
        } else {
          console.warn(`[App] REST returned 0 conversations for ${account.zalo_id}`);
        }
      } catch (err) {
        console.warn(`[App] Failed to load conversations from REST for ${account.zalo_id}:`, err);
      }
    }
  } finally {
    for (const account of accounts) {
      useChatStore.getState().setConversationsLoading(account.zalo_id, false);
    }
  }
}

export default function App() {
  const {
    view, setView, notification, hideNotification,
    erpPermissionDialog, hideErpPermissionDialog,
    addAccountModalOpen, setAddAccountModalOpen,
    showConversationInfo, toggleConversationInfo,
    showGroupBoard, setShowGroupBoard,
    showIntegrationQuickPanel, toggleIntegrationQuickPanel,
    showAIQuickPanel, toggleAIQuickPanel,
    openQuickChat, quickChatOpen, theme, fontSizeScale,
    sidebarExpanded
  } = useAppStore(useShallow(s => ({
    view: s.view, setView: s.setView, notification: s.notification, hideNotification: s.hideNotification,
    erpPermissionDialog: s.erpPermissionDialog, hideErpPermissionDialog: s.hideErpPermissionDialog,
    addAccountModalOpen: s.addAccountModalOpen, setAddAccountModalOpen: s.setAddAccountModalOpen,
    showConversationInfo: s.showConversationInfo, toggleConversationInfo: s.toggleConversationInfo,
    showGroupBoard: s.showGroupBoard, setShowGroupBoard: s.setShowGroupBoard,
    showIntegrationQuickPanel: s.showIntegrationQuickPanel,
    toggleIntegrationQuickPanel: s.toggleIntegrationQuickPanel, showAIQuickPanel: s.showAIQuickPanel,
    toggleAIQuickPanel: s.toggleAIQuickPanel, openQuickChat: s.openQuickChat, quickChatOpen: s.quickChatOpen,
    theme: s.theme, fontSizeScale: s.fontSizeScale, sidebarExpanded: s.sidebarExpanded,
  })));
  const activePluginPanel = useAppStore(s => s.activePluginPanel);
  const setActivePluginPanel = useAppStore(s => s.setActivePluginPanel);
  // Plugin: trang sidebar, panel chat, nút soạn tin của plugin đang bật (rỗng nếu không có plugin).
  useEffect(() => initPluginStore(), []);
  const { setAccounts, updateListenerActive, accounts } = useAccountStore(useShallow(s => ({
    setAccounts: s.setAccounts, updateListenerActive: s.updateListenerActive, accounts: s.accounts,
  })));
  const { activeAccountId } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId,
  })));
  // App là gốc cả giao diện: subscribe cả store (hay cả map contacts — đổi theo mọi tin nhắn đến) làm MỌI component
  // render lại theo mọi tin nhắn / đang gõ / đã xem của mọi tài khoản. Chỉ lấy hội thoại đang mở.
  const { setContacts, activeThreadId, activeThreadType } = useChatStore(useShallow(s => ({
    setContacts: s.setContacts, activeThreadId: s.activeThreadId, activeThreadType: s.activeThreadType,
  })));
  // Đang mở phần bình luận của một bài trong kênh đang xem (TelegramPostDiscussionHost)
  const postDiscussionOpen = useChatStore(s => (
    !!s.postDiscussion && s.postDiscussion.accountId === activeAccountId && s.postDiscussion.channelId === activeThreadId
  ));
  const activeContact = useChatStore(s => (
    activeAccountId && activeThreadId ? s.contacts[activeAccountId]?.find(c => c.contact_id === activeThreadId) : undefined
  ));
  const [initializing, setInitializing] = useState(true);
  const [lockEnabled, setLockEnabled] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  // Khoá app → ẩn lại hội thoại Zalo đã mở bằng PIN (ZL-03)
  useEffect(() => { if (isLocked) useAppStore.getState().lockAllHidden(); }, [isLocked]);
  // Khoá app → không hiện thông báo tin nhắn trong app (lộ nội dung trên màn khoá), bỏ thẻ đang hiện
  useEffect(() => { useInAppNotifyStore.getState().setSuspended(lockEnabled && isLocked); }, [lockEnabled, isLocked]);
  const startupInitStartedRef = useRef(false);
  const isMobile = useIsMobile();
  const { mobileShowChat, setMobileShowChat } = useAppStore(useShallow(s => ({
    mobileShowChat: s.mobileShowChat, setMobileShowChat: s.setMobileShowChat,
  })));

  // ─── Resizable sidebar width ────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try { return Number(localStorage.getItem('deplao:sidebar-width') || '0') || 288; }
    catch { return 288; }
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarResizingRef = useRef(false);
  const MIN_SIDEBAR_WIDTH = 240;
  const MAX_SIDEBAR_WIDTH = 480;

  // Load from DB on mount (async override of localStorage default)
  useEffect(() => {
    DataAccessor.getSetting('sidebar_width').then(val => {
      const n = Number(val);
      if (n >= MIN_SIDEBAR_WIDTH && n <= MAX_SIDEBAR_WIDTH) setSidebarWidth(n);
    }).catch(() => {});
  }, []);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarResizingRef.current = true;
    setSidebarResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let lastX = startX;
    const onMouseMove = (ev: MouseEvent) => {
      if (!sidebarResizingRef.current) return;
      lastX = ev.clientX;
      const delta = ev.clientX - startX;
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      sidebarResizingRef.current = false;
      setSidebarResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist final width to DB + localStorage
      const finalWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidth + (lastX - startX)));
      try { localStorage.setItem('deplao:sidebar-width', String(Math.round(finalWidth))); } catch {}
      DataAccessor.setSetting('sidebar_width', String(Math.round(finalWidth))).catch(() => {});
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  // ─── Sync theme to <html> element ────────────────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // ─── Sync font size scale to <html> element ──────────────────────────────
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * fontSizeScale}px`;
  }, [fontSizeScale]);

  // ─── Lock screen: check status on mount ─────────────────────────────────
  useEffect(() => {
    ipc.lockScreen.status().then(res => {
      if (res.success && res.enabled) {
        setLockEnabled(true);
        setIsLocked(true);
      }
    });
  }, []);

  // ─── Early init RestQueryService (employee mode) — trước workspace:switched ──
  // UI components mount và gọi REST API ngay lập tức, nhưng workspace:switched
  // event có độ trễ → RestQueryService chưa init → request bị "blocked".
  // Fix: init ngay từ mount effect với thông tin workspace hiện tại (cùng cấu hình ở main).
  useEffect(() => {
    (async () => {
      try {
        const wsRes = await ipc.workspace?.getActive();
        const ws = wsRes?.workspace;
        if (ws?.type === 'remote' && ws.bossUrl && ws.token) {
          applyEmployeeCredentials(ws.bossUrl, ws.token, 'startup');
        }
      } catch {}
    })();
  }, []);

  // ─── Employee ↔ Boss: URL/token từ main, badge kết hợp, resync, 403 ACCOUNT_FORBIDDEN ──
  useEffect(() => {
    const rest = RestQueryService.getInstance();
    // Nửa REST của badge: bị chặn (lỗi transport liên tiếp) hoặc chưa có URL/token → "đang khôi phục"
    const syncRestBlocked = () => {
      useEmployeeStore.getState().setRestBlocked(rest.isBlocked() || !rest.getBaseUrl() || !rest.getToken());
    };
    syncRestBlocked();
    const offRestStatus = rest.addStatusListener(() => syncRestBlocked());

    // Main vừa kết nối / đổi URL-token → REST client theo đúng cấu hình đó
    const offCredentials = window.electronAPI?.on('employee:credentials', (data) => {
      if (!data?.workspaceId || !data.bossUrl || !data.token) return;
      const rendererActive = useWorkspaceStore.getState().activeWorkspaceId;
      // Đang chuyển workspace (renderer còn ở workspace cũ) → bỏ qua; workspace:switched init đúng thời điểm
      const isActive = rendererActive ? data.workspaceId === rendererActive : data.active;
      if (!isActive) return;
      applyEmployeeCredentials(data.bossUrl, data.token, `main:${data.reason}`);
    });

    // Kết nối hồi phục sau khoảng mất > 10 s / máy ngủ dậy → data loader tải lại (window 'employee:resync')
    const offResync = window.electronAPI?.on('employee:resync', (data) => {
      if (!data?.workspaceId) return;
      const activeId = useWorkspaceStore.getState().activeWorkspaceId;
      if (activeId && data.workspaceId !== activeId) return;
      console.log(`[App] employee:resync (${data.reason}, mất kết nối ~${Math.round((data.gapMs || 0) / 1000)}s)`);
      window.dispatchEvent(new CustomEvent('employee:resync', { detail: data }));
      refreshEmployeeSnapshot(`resync:${data.reason}`);
    });

    // REST gặp 403 ACCOUNT_FORBIDDEN → quyền / tài khoản được giao đã đổi → lấy lại snapshot (≤ 1 lần / 10 s)
    const onAccountForbidden = () => refreshEmployeeSnapshot('accountForbidden');
    window.addEventListener('employee:accountForbidden', onAccountForbidden);

    return () => {
      offRestStatus();
      offCredentials?.();
      offResync?.();
      window.removeEventListener('employee:accountForbidden', onAccountForbidden);
    };
  }, []);

  // ─── Lock screen: listen for lock events + keyboard shortcut ───────────
  useEffect(() => {
    if (!lockEnabled) return;
    const handleLockEvent = () => setIsLocked(true);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        setIsLocked(true);
      }
    };
    window.addEventListener('lockScreen:lock', handleLockEvent);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('lockScreen:lock', handleLockEvent);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [lockEnabled]);

  // ─── Lock screen: react to enable/disable from Settings ───────────────
  useEffect(() => {
    const handleChanged = (e: Event) => {
      const enabled = (e as CustomEvent).detail?.enabled ?? false;
      // Vừa bật trong Cài đặt: chỉ bật phím tắt Ctrl+Shift+L / nút khoá, KHÔNG khoá ngay — khoá ngay gỡ cả Cài đặt nên màn
      // "Lưu recovery key" hiện một lần sau khi bật (LockScreenSettings) không bao giờ thấy. Lần mở app sau sẽ hỏi mật khẩu.
      setLockEnabled(enabled);
    };
    window.addEventListener('lockScreen:changed', handleChanged);
    return () => window.removeEventListener('lockScreen:changed', handleChanged);
  }, []);

  // ─── Account switcher (Ctrl+Tab): global keyboard handler ──────────────
  useEffect(() => {
    const ctrlHeldRef = { current: false };

    const handleKeyDown = (e: KeyboardEvent) => {
      const store = useAppStore.getState();
      // Ctrl+Tab: open account switcher
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();
        if (!store.accountSwitcherOpen) {
          store.openAccountSwitcher();
        } else {
          if (e.shiftKey) store.prevAccountSwitcher();
          else store.nextAccountSwitcher();
        }
        ctrlHeldRef.current = true;
        return;
      }
      // Escape while switcher open: close without switching
      if (e.key === 'Escape' && store.accountSwitcherOpen) {
        store.closeAccountSwitcher(false);
        ctrlHeldRef.current = false;
        return;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Ctrl/Meta released while switcher open → select account
      if ((e.key === 'Control' || e.key === 'Meta') && ctrlHeldRef.current) {
        ctrlHeldRef.current = false;
        const store = useAppStore.getState();
        if (store.accountSwitcherOpen) {
          e.preventDefault();
          store.closeAccountSwitcher(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // ─── Employee permission guard: redirect to dashboard if current view is not allowed ──
  useEffect(() => {
    return useEmployeeStore.subscribe((empState) => {
      const { mode, permissions } = empState;
      if (mode !== 'employee') return;
      // Map view → required permission module (null = always allowed)
      const VIEW_PERM_MAP: Record<string, string | null> = {
        dashboard:   null,
        settings:    null,
        chat:        'chat',
        friends:     'friends',
        crm:         'crm',
        erp:         'erp',
        workflow:    'workflow',
        integration: 'integration',
        analytics:   'analytics',
      };
      const currentView = useAppStore.getState().view;
      const requiredPerm = VIEW_PERM_MAP[currentView];
      if (requiredPerm !== undefined && requiredPerm !== null && !permissions[requiredPerm]) {
        useAppStore.getState().setView('dashboard');
      }
    });
  }, []);

  // ─── Reset mobileShowChat when window grows back to desktop size ─────────
  useEffect(() => {
    if (!isMobile) setMobileShowChat(false);
  }, [isMobile]);

  // Popup nhắc hẹn (Zalo chat.ecard + lịch Quản lý công việc): hàng đợi, hiện lần lượt từng cái
  const [reminderQueue, setReminderQueue] = useState<Array<ReminderData & { key: string; kind: 'zalo' | 'erp'; msgId?: string }>>([]);
  const reminderNotification = reminderQueue[0] || null;
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isWindowFocusedRef = useRef(true);
  /** Queue of friend request notifications (show one at a time) */
  const [friendRequestQueue, setFriendRequestQueue] = useState<FriendRequestNotifData[]>([]);
  /** Account ID currently being initialized (shows AccountInitPanel) */
  const [accountInitId, setAccountInitId] = useState<string | null>(null);
  /** Tracks which accounts we already checked for init needs this session */
  const initCheckedRef = useRef<Set<string>>(new Set());
  const reconnectInFlightRef = useRef<Set<string>>(new Set());
  const reconnectCooldownRef = useRef<Map<string, number>>(new Map());

  // Register Zalo event listeners
  useZaloEvents();

  // Register unified multi-channel event listeners (FB → chatStore)
  useChatEvents();

  const reconnectAccountNow = useCallback(async (
    acc: { zalo_id: string; cookies: string; imei: string; user_agent: string },
    reason: 'healthcheck' | 'network-online'
  ): Promise<boolean> => {
    const now = Date.now();
    const lastAttemptAt = reconnectCooldownRef.current.get(acc.zalo_id) ?? 0;

    if (reconnectInFlightRef.current.has(acc.zalo_id)) {
      console.log(`[Reconnect:${reason}] Skip ${acc.zalo_id}: already in flight`);
      return false;
    }

    if (now - lastAttemptAt < NETWORK_RECONNECT_COOLDOWN_MS) {
      console.log(`[Reconnect:${reason}] Skip ${acc.zalo_id}: cooldown active`);
      return false;
    }

    reconnectInFlightRef.current.add(acc.zalo_id);
    reconnectCooldownRef.current.set(acc.zalo_id, now);

    try {
      const auth = buildZaloAuth(acc);
      const res = await ipc.login?.connectAccount(auth);

      if (!res?.success) {
        updateListenerActive(acc.zalo_id, false);
        console.warn(`[Reconnect:${reason}] ${acc.zalo_id} failed:`, res?.error || 'unknown_error');
        return false;
      }

      return true;
    } catch (err) {
      updateListenerActive(acc.zalo_id, false);
      console.warn(`[Reconnect:${reason}] ${acc.zalo_id} error:`, err);
      return false;
    } finally {
      reconnectInFlightRef.current.delete(acc.zalo_id);
    }
  }, [updateListenerActive]);

  const checkListenerHealth = useCallback(async (zaloIds: string[]) => {
    if (!zaloIds.length) return [] as Array<{ zaloId: string; healthy: boolean; readyState: number | null; reason?: string }>;

    try {
      const res = await ipc.login?.checkHealth(zaloIds);
      if (!res?.success || !Array.isArray(res.results)) return [];
      return res.results;
    } catch (err) {
      console.warn('[HealthCheck] error:', err);
      return [];
    }
  }, []);

  const reconnectAfterNetworkRestore = useCallback(async () => {
    // Skip for employee (remote) workspace - boss owns Zalo connections
    const netActiveWs = await ipc.workspace?.getActive?.().then((r: any) => r?.workspace).catch(() => null);
    if (netActiveWs?.type === 'remote') return;

    const currentAccounts = useAccountStore.getState().accounts.filter(a => isZalo(a.channel));
    if (!currentAccounts.length) return;

    const connectedIds = currentAccounts
      .filter((a) => a.isConnected)
      .map((a) => a.zalo_id);

    const healthResults = await checkListenerHealth(connectedIds);
    const unhealthyIds = new Set<string>();

    for (const result of healthResults) {
      if (!result.healthy) {
        unhealthyIds.add(result.zaloId);
        updateListenerActive(result.zaloId, false);
      } else {
        updateListenerActive(result.zaloId, true);
      }
    }

    const candidates = currentAccounts.filter((acc) => {
      if (unhealthyIds.has(acc.zalo_id)) return true;
      if (acc.listenerActive === false) return true;
      return !acc.isConnected;
    });

    if (!candidates.length) return;

    useAppStore.getState().showNotification(
      `🌐 Mạng đã khôi phục - đang kết nối lại ${candidates.length} tài khoản`,
      'info',
    );

    await Promise.allSettled(candidates.map((acc) => reconnectAccountNow(acc, 'network-online')));
  }, [checkListenerHealth, reconnectAccountNow, updateListenerActive]);

  // ─── Listen for in-app friend request notification ──────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as FriendRequestNotifData;
      if (!detail?.userId) return;
      setFriendRequestQueue(prev => {
        // Avoid duplicates
        if (prev.some(r => r.userId === detail.userId && r.zaloId === detail.zaloId)) return prev;
        return [...prev, detail];
      });
    };
    window.addEventListener('friendRequest:show', handler);
    return () => window.removeEventListener('friendRequest:show', handler);
  }, []);

  const handleFriendRequestAccept = async (zaloId: string, userId: string) => {
    const acc = accounts.find(a => a.zalo_id === zaloId);
    if (!acc) return;
    const auth = buildZaloAuth(acc, zaloId);
    await ipc.zalo?.acceptFriendRequest({ auth, userId });
    await DataAccessor.removeFriendRequest({ zaloId, userId, direction: 'received' }).catch(() => {});
    await DataAccessor.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
      if (isReadFailure(res)) return; // đọc lỗi → giữ số đếm và chấm "mới" như cũ
      const count = res?.requests?.length ?? 0;
      if (useAccountStore.getState().activeAccountId === zaloId) {
        useCRMStore.getState().setRequestCount(count);
      }
      if (count === 0) {
        useAppStore.getState().clearCRMRequestUnseen(zaloId);
      }
    }).catch(() => {});
    useAppStore.getState().showNotification('Đã chấp nhận lời mời kết bạn!', 'success');
  };

  const handleFriendRequestReject = async (zaloId: string, userId: string) => {
    const acc = accounts.find(a => a.zalo_id === zaloId);
    if (!acc) return;
    const auth = buildZaloAuth(acc, zaloId);
    await ipc.zalo?.rejectFriendRequest({ auth, userId });
    await DataAccessor.removeFriendRequest({ zaloId, userId, direction: 'received' }).catch(() => {});
    await DataAccessor.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
      if (isReadFailure(res)) return; // đọc lỗi → giữ số đếm và chấm "mới" như cũ
      const count = res?.requests?.length ?? 0;
      if (useAccountStore.getState().activeAccountId === zaloId) {
        useCRMStore.getState().setRequestCount(count);
      }
      if (count === 0) {
        useAppStore.getState().clearCRMRequestUnseen(zaloId);
      }
    }).catch(() => {});
    useAppStore.getState().showNotification('Đã từ chối lời mời kết bạn', 'info');
  };

  const handleFriendRequestOpenAll = (zaloId: string) => {
    const { activeAccountId, setActiveAccount } = useAccountStore.getState();
    if (activeAccountId !== zaloId) {
      setActiveAccount(zaloId);
    }
    useCRMStore.getState().setTab('requests');
    useAppStore.getState().setView('crm');
    setTimeout(() => window.dispatchEvent(new CustomEvent('nav:friendRequests')), 100);
  };

  // ─── Account init: check when entering Chat view or switching account ─────
  // Each account is checked at most once per app session.
  useEffect(() => {
    if (!activeAccountId || view !== 'chat') return;
    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    const channel = acc?.channel || CHANNEL.ZALO;
    // Already checked this account this session
    if (initCheckedRef.current.has(activeAccountId)) return;
    initCheckedRef.current.add(activeAccountId);

    // Each account is checked at most once per app session.
    const accountId = activeAccountId;
    if (isFacebook(channel)) {
      // FB init: simpler flow - just sync threads
      import('@/lib/facebook/fbInitUtils').then(({ checkFBAccountInitNeeds }) => {
        checkFBAccountInitNeeds(accountId).then(needs => {
          if (needs.any) {
            setAccountInitId(accountId);
          }
        }).catch(() => {});
      });
    } else {
      checkAccountInitNeeds(accountId).then(needs => {
        if (needs.any) {
          setAccountInitId(accountId);
        }
      }).catch(() => {});
    }
  }, [activeAccountId, view]);

  // ─── Workspace switch: reload all data when workspace changes ─────────────
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:switched', async (data: any) => {
      if (!data?.workspace) {
        useWorkspaceStore.getState().setIsSwitching(false);
        return;
      }
      const switchTimeout = setTimeout(() => {
        console.warn('[App] workspace:switched handler timeout - forcing isSwitching=false');
        useWorkspaceStore.getState().setIsSwitching(false);
      }, 15000);
      try {
      // Use workspace from event payload directly - no extra IPC roundtrip
      const ws = data.workspace;
      console.log(`[App] Workspace switched to: ${ws.name} (${ws.id}) type=${ws.type}`);

      // Update workspace store FIRST - so all subsequent checks use the correct activeWorkspaceId
      useWorkspaceStore.getState().setActiveWorkspaceId(ws.id);

      // ── Clear init-checked set so account init re-runs for the new workspace ──
      initCheckedRef.current.clear();

      // ── Clear ALL stale state from the previous workspace ──────────────────
      useChatStore.getState().resetForWorkspaceSwitch();
      useAccountStore.getState().setActiveAccount(null);

      const appState = useAppStore.getState();
      if (appState.mergedInboxMode) appState.exitMergedInbox();
      useAppStore.setState({ groupInfoCache: {} } as any);

      // ── Setup employee mode or clear it ────────────────────────
      const empStore = useEmployeeStore.getState();
      // Always clear preview employee so permissions don't carry over between workspaces
      empStore.setPreviewEmployeeId?.(null);
      if (ws.type === 'remote') {
        empStore.reset();
        empStore.setMode('employee');
        empStore.setCurrentEmployee(buildCurrentEmployeeFromWorkspace(ws));
        empStore.setBossUrl(ws.bossUrl || '');
        empStore.setToken(ws.token || '');
        console.log(`[App] 🪙 Token from workspace: ${ws.token ? ws.token.slice(0, 20) + '...' : 'EMPTY!'} bossUrl=${ws.bossUrl}`);
        empStore.setPermissions(buildPermissionsMap(ws.cachedPermissions));
        empStore.setAssignedAccounts(ws.cachedAssignedAccounts || []);
        empStore.setEmployees(ws.cachedEmployeesData || []);

        // Init RestQueryService để employee có thể gọi REST API — URL/token trong payload là cấu hình
        // workspace ở main (cùng nguồn với employee:credentials), init SAU khi đã reset store cũ.
        applyEmployeeCredentials(ws.bossUrl, ws.token, 'workspace:switched');

        // Use snapshot from event payload (merged by main process) - no IPC needed
        // Snapshot chỉ là dữ liệu cache, KHÔNG đồng nghĩa đang connected
        const snapshot = ws._snapshot;
        empStore.setHeartbeatConnected(!!ws._connected);
        empStore.setAuthExpired(!!ws._authExpired);
        if (snapshot) {
          if (snapshot.assignedAccounts?.length) empStore.setAssignedAccounts(snapshot.assignedAccounts);
          if (snapshot.permissions?.length) empStore.setPermissions(buildPermissionsMap(snapshot.permissions));
          if (snapshot.employeesData) empStore.setEmployees(snapshot.employeesData);
        }
      } else {
        empStore.reset();
        // Rời chế độ nhân viên → REST client ngừng gọi Boss (DataAccessor dùng IPC cho workspace local)
        RestQueryService.getInstance().reset();
      }

      // Reset stores to reflect new workspace data
      try {
        let nextAccounts: any[];
        if (ws.type === 'remote') {
          // Remote: use snapshot or cached accounts - no DB query needed
          const snapshotAccounts = ws._snapshot?.accountsData;
          nextAccounts = normalizeWorkspaceAccounts(
            snapshotAccounts?.length ? snapshotAccounts : (ws.cachedAccountsData || [])
          );
        } else {
          // Local: load from DB
          const accountsRes = await ipc.login?.getAccounts();
          nextAccounts = accountsRes?.accounts || [];
        }

        setAccounts(nextAccounts);

        // ── Auto-select first page if no active account ─────────────
        if (nextAccounts.length > 0) {
          useAccountStore.getState().setActiveAccount(nextAccounts[0].zalo_id);
        }

        // Load contacts: local workspace → từ DB; remote workspace → từ REST (để DataAccessor/ConversationList tự load)
        if (ws.type !== 'remote') {
          for (const acc of nextAccounts) {
            try {
              const contactsRes = await Promise.race([
                ipc.db?.getContacts(acc.zalo_id),
                new Promise(r => setTimeout(() => r(null), 5000)),
              ]) as any;
              if (contactsRes?.contacts) {
                setContacts(acc.zalo_id, contactsRes.contacts);
              }
            } catch {}
          }
        }

        // Load flags (non-blocking, with timeout)
        const { loadFlags } = useAppStore.getState();
        for (const acc of nextAccounts) {
          try {
            await Promise.race([
              loadFlags(acc.zalo_id),
              new Promise(r => setTimeout(r, 3000)),
            ]);
          } catch {}
        }

        ipc.app?.setBadge(getFilteredUnreadCount());
      } catch (err) {
        console.error('[App] Workspace switch reload error:', err);
      }

      // Clear workspace switching state
      clearTimeout(switchTimeout);
      useWorkspaceStore.getState().setIsSwitching(false);
      } catch (outerErr) {
        console.error('[App] workspace:switched outer error:', outerErr);
        clearTimeout(switchTimeout);
        useWorkspaceStore.getState().setIsSwitching(false);
      }
    });
    return () => unsub?.();
  }, [setAccounts, setContacts]);

  // ─── Handle relay:initialState forwarded from SocketConnectionManager ────────
  // Fired when employee successfully connects to boss - contains permissions + assignedAccounts.
  // NOTE: SSE watchdog reconnect cũng fire event này → throttle 30s tránh redundant REST calls
  const lastInitialStateTs = useRef<Record<string, number>>({});
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:initialState', async (data: any) => {
      if (!data?.workspaceId) return;

      // Throttle: bỏ qua nếu đã xử lý trong 60s gần nhất (SSE reconnect loop).
      // forced = làm mới chủ động (403 ACCOUNT_FORBIDDEN / resync, đã throttle 10 s) → áp dụng ngay.
      const now = Date.now();
      const lastTs = lastInitialStateTs.current[data.workspaceId] || 0;
      if (!data.forced && now - lastTs < 60_000) {
        return;
      }
      lastInitialStateTs.current[data.workspaceId] = now;

      console.log(`[App] workspace:initialState received:`, {
        workspaceId: data.workspaceId,
        assignedAccounts: data.assignedAccounts,
        accountsDataCount: data.accountsData?.length ?? 0,
        accountsData: data.accountsData,
      });
      const storeActiveWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      const activeWorkspaceId = storeActiveWorkspaceId
        || (await ipc.workspace?.getActive?.().then((res: any) => res?.workspace?.id).catch(() => ''));
      const cachedAccounts = normalizeWorkspaceAccounts(data.accountsData || []);
      const permissions = data.permissions || [];
      const assignedAccounts = data.assignedAccounts || [];
      const employeesData = data.employeesData || [];

      // Always persist workspace-specific cache, even for background remote workspaces.
      const cacheUpdateResult = await ipc.workspace?.update(data.workspaceId, {
        cachedPermissions: permissions,
        cachedAssignedAccounts: assignedAccounts,
        cachedErpRole: data.erpRole || '',
        cachedErpExtraJson: data.erpExtraJson || '',
        cachedEmployeesData: employeesData,
        cachedAccountsData: cachedAccounts,
      }).catch(() => null);
      useWorkspaceStore.getState().setWorkspaces(
        useWorkspaceStore.getState().workspaces.map((workspace: any) => workspace.id === data.workspaceId
          ? {
              ...workspace,
              cachedPermissions: permissions,
              cachedAssignedAccounts: assignedAccounts,
              cachedErpRole: data.erpRole || '',
              cachedErpExtraJson: data.erpExtraJson || '',
              cachedEmployeesData: employeesData,
              cachedAccountsData: cachedAccounts,
            }
          : workspace)
      );
      console.log('[App] workspace:initialState cache write', {
        workspaceId: data.workspaceId,
        success: !!cacheUpdateResult?.success,
      });

      if (data.workspaceId !== activeWorkspaceId) {
        return;
      }

      const empStore = useEmployeeStore.getState();

      // Ensure employee mode is set when receiving initialState
      if (empStore.mode !== 'employee') {
        empStore.reset();
        empStore.setMode('employee');
      }
      empStore.setCurrentEmployee(buildCurrentEmployeeFromWorkspace(useWorkspaceStore.getState().activeWorkspace()));

      // Build permissions map from array
      const permsMap = buildPermissionsMap(permissions);
      empStore.setPermissions(permsMap);
      empStore.setAssignedAccounts(assignedAccounts);
      // Trạng thái kết nối KHÔNG ghi ở đây: badge chỉ theo heartbeat (workspace:connectionStatus) + REST
      empStore.setEmployees(employeesData);
      empStore.setCurrentEmployee(buildCurrentEmployeeFromWorkspace({
        ...useWorkspaceStore.getState().activeWorkspace(),
        cachedPermissions: permissions,
        cachedAssignedAccounts: assignedAccounts,
        cachedEmployeesData: employeesData,
      }));

      // Populate account store with account data from boss for the active workspace only
      if (cachedAccounts.length > 0) {
        setAccounts(cachedAccounts as any);
        ensureActiveAccount(cachedAccounts);
        console.log(`[App] Accounts set from initialState: ${cachedAccounts.length} accounts`, cachedAccounts.map(a => ({ zalo_id: a.zalo_id, full_name: a.full_name })));

        // Load conversations từ Boss qua REST API (chỉ khi chưa có)
        const existingContacts = useChatStore.getState().contacts;
        const needsLoad = cachedAccounts.some((acc: any) => !existingContacts[acc.zalo_id]?.length);
        if (needsLoad) {
          for (const acc of cachedAccounts) {
            useChatStore.getState().setConversationsLoading(acc.zalo_id, true);
          }
          (async () => {
            for (const acc of cachedAccounts) {
              try {
                const result = await DataAccessor.getConversations(acc.zalo_id, 200, 0);
                if (result?.items && result.items.length > 0) {
                  console.log(`[App] ✅ Loaded ${result.items.length} conversations from REST for ${acc.zalo_id}`);
                  useChatStore.getState().setContacts(acc.zalo_id, result.items);
                } else {
                  console.warn(`[App] ⚠️ REST returned 0 conversations for ${acc.zalo_id}`);
                }
              } catch (err) {
                console.warn(`[App] Failed to load conversations from REST for ${acc.zalo_id}:`, err);
              }
            }
            for (const acc of cachedAccounts) {
              useChatStore.getState().setConversationsLoading(acc.zalo_id, false);
            }
          })();
        }
      } else {
        setAccounts([]);
        console.log(`[App] No accountsData in initialState`);
      }
    });
    return () => unsub?.();
  }, [setAccounts]);

  // ─── Handle relay:accountAccessUpdate (boss changed employee assignments) ─────
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:accountAccessUpdate', async (data: any) => {
      if (!data?.workspaceId) return;

      const assignedAccounts = data.assignedAccounts || [];
      const cachedAccounts = normalizeWorkspaceAccounts(data.accountsData || []);

      // Update workspace cache for both active and background remote workspaces.
      const cacheUpdateResult = await ipc.workspace?.update(data.workspaceId, {
        cachedAssignedAccounts: assignedAccounts,
        cachedAccountsData: cachedAccounts,
      }).catch(() => null);
      useWorkspaceStore.getState().setWorkspaces(
        useWorkspaceStore.getState().workspaces.map((workspace: any) => workspace.id === data.workspaceId
          ? {
              ...workspace,
              cachedAssignedAccounts: assignedAccounts,
              cachedAccountsData: cachedAccounts,
            }
          : workspace)
      );
      console.log('[App] workspace:accountAccessUpdate cache write', {
        workspaceId: data.workspaceId,
        success: !!cacheUpdateResult?.success,
      });

      const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
        || (await ipc.workspace?.getActive?.().then((res: any) => res?.workspace?.id).catch(() => ''));

      if (data.workspaceId !== activeWorkspaceId) {
        console.log('[App] workspace:accountAccessUpdate ignored for inactive workspace', {
          workspaceId: data.workspaceId,
          activeWorkspaceId,
        });
        return;
      }

      useEmployeeStore.getState().setAssignedAccounts(assignedAccounts);

      // Update account store with new account data from boss for the active workspace only.
      const assignedSet = new Set(assignedAccounts);
      const nextAccounts = cachedAccounts.length > 0
        ? cachedAccounts.filter(a => assignedSet.has(a.zalo_id))
        : useAccountStore.getState().accounts.filter(a => assignedSet.has(a.zalo_id));

      setAccounts(nextAccounts as any);
      ensureActiveAccount(nextAccounts);
      loadEmployeeConversationsForAccounts(nextAccounts);
    });
    return () => unsub?.();
  }, []);

  // ─── Handle relay:permissionUpdate (boss changed ERP/permissions — no throttle) ─────
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:permissionUpdate', async (data: any) => {
      if (!data?.workspaceId) return;

      const permissions = data.permissions || [];
      const erpRole = data.erpRole || '';
      const erpExtraJson = data.erpExtraJson || '';
      const employeesData = data.employeesData || [];

      // Update workspace cache
      await ipc.workspace?.update(data.workspaceId, {
        cachedPermissions: permissions,
        cachedErpRole: erpRole,
        cachedErpExtraJson: erpExtraJson,
        cachedEmployeesData: employeesData,
      }).catch(() => null);
      useWorkspaceStore.getState().setWorkspaces(
        useWorkspaceStore.getState().workspaces.map((ws: any) => ws.id === data.workspaceId
          ? { ...ws, cachedPermissions: permissions, cachedErpRole: erpRole, cachedErpExtraJson: erpExtraJson, cachedEmployeesData: employeesData }
          : ws)
      );

      const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      if (data.workspaceId !== activeWorkspaceId) return;

      // Update employee store immediately — no throttle
      const empStore = useEmployeeStore.getState();
      const permsMap = buildPermissionsMap(permissions);
      empStore.setPermissions(permsMap);
      empStore.setEmployees(employeesData);
      empStore.setCurrentEmployee(buildCurrentEmployeeFromWorkspace({
        ...useWorkspaceStore.getState().activeWorkspace(),
        cachedPermissions: permissions,
        cachedEmployeesData: employeesData,
      }));

      console.log('[App] workspace:permissionUpdate applied', {
        workspaceId: data.workspaceId,
        erpRole,
        permCount: permissions.length,
      });
    });
    return () => unsub?.();
  }, []);

  // ─── Track remote workspace connection status (heartbeat của main) ───────────
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:connectionStatus', (data) => {
      if (!data?.workspaceId) return;
      useWorkspaceStore.getState().setConnectionStatus(data.workspaceId, {
        connected: !!data.connected,
        latency: data.latency ?? 0,
      });
      // Nửa heartbeat của badge — chỉ cho workspace đang active
      const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (data.workspaceId !== activeWsId) return;
      const empStore = useEmployeeStore.getState();
      const wasExpired = empStore.authExpired;
      empStore.setHeartbeatConnected(!!data.connected);
      if (data.latency !== undefined) empStore.setLatency(data.latency);
      if (data.connected) empStore.setAuthExpired(false);
      else if (typeof data.authExpired === 'boolean') empStore.setAuthExpired(data.authExpired);

      if (empStore.mode === 'employee') {
        if (data.authExpired && !wasExpired) {
          useAppStore.getState().showNotification(AUTH_EXPIRED_MESSAGE, 'warning');
        }
        if (data.kicked) {
          useAppStore.getState().showNotification(data.reason || 'Bị ngắt kết nối bởi quản lý', 'warning');
        }
      }

      if (data.reason === 'user-disconnect' || data.kicked) {
        // Người dùng ngắt / bị Boss kick → REST cũng dừng: badge giữ Offline, không gọi Boss nữa
        RestQueryService.getInstance().reset();
      } else if (data.connected) {
        // Lưới an toàn: main đã nối mà REST chưa có URL/token → lấy từ cấu hình workspace ở main
        const rest = RestQueryService.getInstance();
        if (!rest.getBaseUrl() || !rest.getToken()) {
          ipc.workspace?.getActive?.().then((res) => {
            const ws = res?.workspace;
            if (ws?.id === data.workspaceId && ws.type === 'remote') {
              applyEmployeeCredentials(ws.bossUrl, ws.token, 'connectionStatus');
            }
          }).catch(() => {});
        }
      }
    });
    return () => unsub?.();
  }, []);

  // ─── Handle employee mode change (disconnect → standalone) ────────
  useEffect(() => {
    const unsub = window.electronAPI?.on('employee:modeChanged', (data: any) => {
      if (data?.mode) {
        useEmployeeStore.getState().setMode(data.mode);
        if (data.mode !== 'employee') {
          useEmployeeStore.getState().setCurrentEmployee(null);
          useEmployeeStore.getState().setBossConnected(false);
          useEmployeeStore.getState().setToken('');
          useEmployeeStore.getState().setPermissions({});
          useEmployeeStore.getState().setAssignedAccounts([]);
        }
      }
    });
    return () => unsub?.();
  }, []);

  // ─── Handle sync completion - reload data after full/delta sync ────────────
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:syncComplete', async (data: any) => {
      if (!data?.workspaceId) return;
      const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (data.workspaceId !== activeWsId) return;

      console.log(`[App] workspace:syncComplete received: type=${data.syncType} workspace=${data.workspaceId}`);

      // Reload contacts for all assigned accounts — nhân viên đọc từ BOSS (ipc.db.getContacts ở máy nhân viên chỉ là
      // stub `{ success: true }` → trước đây không nạp gì); lỗi đọc giữ danh sách (reloadAccountContacts)
      const empStore = useEmployeeStore.getState();
      const accounts = empStore.assignedAccounts || [];
      if (accounts.length > 0) {
        for (const zaloId of accounts) {
          try {
            await Promise.race([
              reloadAccountContacts(zaloId),
              new Promise(r => setTimeout(() => r(null), 5000)),
            ]);
          } catch {}
        }
        // Reload flags
        const { loadFlags } = useAppStore.getState();
        for (const zaloId of accounts) {
          try {
            await Promise.race([
              loadFlags(zaloId),
              new Promise(r => setTimeout(r, 3000)),
            ]);
          } catch {}
        }
      }
    });
    return () => unsub?.();
  }, [setContacts]);

  // ─── nav:view - navigate to a top-level view from other components ───────────
  useEffect(() => {
    const handler = (e: Event) => {
      const { view: targetView } = (e as CustomEvent).detail || {};
      if (targetView) setView(targetView);
    };
    window.addEventListener('nav:view', handler);
    return () => window.removeEventListener('nav:view', handler);
  }, [setView]);

  // ─── Track window focus, stop taskbar flash when app is brought to front ────
  useEffect(() => {
    const unsub = window.electronAPI?.on('app:windowFocus', (focused: boolean) => {
      isWindowFocusedRef.current = focused;
      if (focused) {
        window.electronAPI?.app?.flashFrame?.(false);
      }
    });
    return () => unsub?.();
  }, []);

  // ─── Flash taskbar on new incoming message when window not focused ────────
  useEffect(() => {
    const unsub = window.electronAPI?.on('event:message', (data: any) => {
      if (!isWindowFocusedRef.current) {
        const zaloId = data?.zaloId || '';
        const threadId = data?.message?.threadId || '';
        const isSelf = !!data?.message?.isSelf;
        const suppressNotification = data?.message?._silentNotification === true
          || data?.message?._commentOnly === true; // bình luận ở nhóm thảo luận chưa tham gia
        // Không flash cho tin nhắn của chính mình, hội thoại muted hoặc trong thư mục "Khác"
        if (isSelf || suppressNotification) return;
        const { isMuted, isInOthers, isZaloHidden } = useAppStore.getState();
        if (isMuted(zaloId, threadId) || isInOthers(zaloId, threadId) || isZaloHidden(zaloId, threadId)) return;
        window.electronAPI?.app?.flashFrame?.(true);
      }
    });
    return () => unsub?.();
  }, []);

  // ─── Facebook: flash taskbar on new message when window not focused ─────────
  // Âm thanh, thông báo trong app và popup hệ điều hành của tin FB: hooks/chat/useChatEvents (trước đây báo ở cả hai nơi →
  // mỗi tin kêu 2 lần, 2 popup).
  useEffect(() => {
    const unsub = window.electronAPI?.on('fb:onMessage', (data: any) => {
      if (isWindowFocusedRef.current) return;
      // Bản phát lại của tin đã báo (MQTT và bridge cùng nhận): không nháy lần nữa
      if (data?.message?.repeat === true) return;
      const threadId = data?.message?.replyToID || '';
      const accountId = data?.fbAccountId || '';
      // The backend owns Facebook sender attribution. `senderID` was not
      // even the event field name (`userID` is), and client-side fallback can
      // mark another participant's message as the logged-in account.
      if (data?.message?.isSelf === true) return;
      const { isMuted, isInOthers, isZaloHidden } = useAppStore.getState();
      if (isMuted(accountId, threadId) || isInOthers(accountId, threadId) || isZaloHidden(accountId, threadId)) return;
      window.electronAPI?.app?.flashFrame?.(true);
    });
    return () => unsub?.();
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // e.code: Caps Lock bật thì e.key là 'n'
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyN' || e.key.toLowerCase() === 'n')) {
        e.preventDefault();
        openQuickChat();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openQuickChat]);

  // ─── Listen for reminder notifications ────────────────────────────────────
  useEffect(() => {
    const handleReminderEvent = (event: any) => {
      const { detail } = event;
      if (!detail) return;

      // Parse reminder data từ webhook
      try {
        const { zaloId, threadId, msgType, content } = detail;

        // Kiểm tra xem có phải reminder không
        if (msgType !== 'chat.ecard' || !content?.params) return;

        const params = typeof content.params === 'string' ? JSON.parse(content.params) : content.params;
        const actions = params?.actions?.[0];
        if (!actions || !actions.data) return;

        const actionData = typeof actions.data === 'string' ? JSON.parse(actions.data) : actions.data;
        if (actionData.act !== 'remind_reminder11') return;

        const reminderData = typeof actionData.data === 'string' ? JSON.parse(actionData.data) : actionData.data;

        // Lấy thông tin account
        const account = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
        const accountName = account?.display_name || account?.phone || 'Tài khoản';

        // Lấy thông tin conversation
        const contactList = useChatStore.getState().contacts[zaloId] || [];
        const contact = contactList.find(c => c.contact_id === threadId);
        const conversationName = contact?.display_name || 'Hội thoại';

        // Hiển thị notification
        setReminderQueue(queue => [...queue, {
          key: `zalo:${zaloId}:${threadId}:${Date.now()}`,
          kind: 'zalo',
          emoji: reminderData.emoji || '⏰',
          title: reminderData.params?.title || content.title || 'Nhắc hẹn',
          description: content.description || '',
          accountName,
          conversationName,
          color: reminderData.color ?? -1,
          zaloId,
          threadId,
          threadType: contact?.contact_type === 'group' ? 1 : 0,
        }]);
      } catch (err) {
        console.error('[ReminderNotification] Parse error:', err);
      }
    };

    window.addEventListener('zalo:reminder', handleReminderEvent);
    return () => window.removeEventListener('zalo:reminder', handleReminderEvent);
  }, []);

  // ─── Nhắc lịch Quản lý công việc (ERP): popup như nhắc hẹn Zalo ──────────────
  // Main (ErpCalendarService) phát 'erp:event:reminder' tới giờ nhắc; trước đây chỉ trang ERP nghe và không hiện gì.
  // Đúng giờ → popup; nhắc trước → thông báo thường trong chuông (main tạo) + chuông rung "15 phút nữa tới lịch hẹn".
  useEffect(() => {
    const unsub = window.electronAPI?.on('erp:event:reminder', (payload: any) => {
      const event = payload?.event;
      if (!event?.id) return;
      const employee = useEmployeeStore.getState();
      const myId = employee.mode === 'employee' ? String(employee.currentEmployee?.employee_id || '') : 'boss';
      // Máy Boss nhận nhắc lịch của cả workspace: chỉ hiện lịch mình tổ chức / được mời
      if (!isErpReminderForMe(event, myId)) return;
      const now = Date.now();
      const when = erpReminderWhen(event, new Date(now));
      if ((Number(payload?.minutesBefore) || 0) > 0) {
        const startAt = Number(event.start_at) || 0;
        if (startAt <= now) return;
        useErpReminderAttention.getState().raise({ eventId: String(event.id), title: String(event.title || ''), startAt });
        const { notifSettings } = useAppStore.getState();
        if (notifSettings.soundEnabled) playNotificationSound(notifSettings.volume);
        // Cửa sổ đang ở nền: popup hệ điều hành + nháy taskbar
        if (!isWindowFocusedRef.current) {
          if (notifSettings.desktopEnabled) {
            showDesktopNotification(
              `${ERP_EVENT_EMOJI[event.type as keyof typeof ERP_EVENT_EMOJI] || '📅'} ${event.title}`,
              `${erpReminderLeadText(startAt - now)} · ${when}`,
            );
          }
          window.electronAPI?.app?.flashFrame?.(true);
        }
        return;
      }
      // Tới giờ: popup đúng giờ thay chữ đếm ngược trên thanh tiêu đề
      useErpReminderAttention.getState().dismiss([String(event.id)]);
      if (isMissedErpReminder(event, now)) {
        // Máy tắt lúc tới giờ, mở lại mới nhắc bù → báo nhẹ, không bật popup có nhạc
        useAppStore.getState().showNotification(`Đã lỡ lịch "${event.title}" (${when})`, 'info');
        return;
      }
      const accountId = String(event.linked_account_id || '');
      const threadId = String(event.linked_contact_id || '');
      const account = accountId ? useAccountStore.getState().accounts.find(a => a.zalo_id === accountId) : undefined;
      const contact = account && threadId
        ? (useChatStore.getState().contacts[accountId] || []).find(c => c.contact_id === threadId)
        : undefined;
      const heading = erpReminderHeading(Number(payload?.minutesBefore) || 0);
      setReminderQueue(queue => [...queue, {
        key: `erp:${event.id}:${payload?.minutesBefore ?? ''}:${now}`,
        kind: 'erp',
        emoji: ERP_EVENT_EMOJI[event.type as keyof typeof ERP_EVENT_EMOJI] || '📅',
        heading,
        title: event.title,
        description: [when, event.location].filter(Boolean).join(' · '),
        note: erpReminderNote(event.description, 6, !!(account && threadId)),
        color: -1,
        colorHex: /^#[0-9a-f]{6}$/i.test(String(event.color || '')) ? event.color : '#3b82f6',
        ...(account && threadId ? {
          zaloId: accountId,
          threadId,
          threadType: contact?.contact_type === 'group' ? 1 : 0,
          accountName: account.full_name || accountId,
          conversationName: contact?.alias || contact?.display_name || 'Hội thoại',
          msgId: event.linked_msg_id ? String(event.linked_msg_id) : undefined,
        } : {
          secondaryAction: {
            label: 'Xem lịch',
            onClick: () => {
              window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'erp' } }));
              window.setTimeout(() => window.dispatchEvent(new CustomEvent('nav:erp', { detail: { subView: 'calendar' } })), 80);
            },
          },
        }),
      }]);
      // Cửa sổ đang ở nền: thêm popup hệ điều hành + nháy taskbar để không lỡ
      if (!isWindowFocusedRef.current) {
        if (useAppStore.getState().notifSettings.desktopEnabled) {
          showDesktopNotification(
            `${ERP_EVENT_EMOJI[event.type as keyof typeof ERP_EVENT_EMOJI] || '📅'} ${event.title}`,
            `${heading} · ${when}`,
            undefined,
            account && threadId ? { zaloId: accountId, threadId, threadType: contact?.contact_type === 'group' ? 1 : 0 } : undefined,
          );
        }
        window.electronAPI?.app?.flashFrame?.(true);
      }
    });
    return () => unsub?.();
  }, []);

  // Initialize on app start
  useEffect(() => {
    // React StrictMode intentionally mounts effects twice in development. The
    // old startup effect therefore loaded contacts and tried reconnects twice.
    if (startupInitStartedRef.current) return;
    startupInitStartedRef.current = true;

    // Tell the main process that React has committed a frame before it starts
    // expensive channel recovery. A large contact table must not hold the
    // window blank while startup hydration is still running.
    ipc.app?.rendererReady?.();
    // Danh sách hội thoại tải xong + trình duyệt rảnh → báo main bắt đầu việc nền nặng (đồng bộ bù tin cũ Telegram…)
    reportUiSettledWhenReady();
    setInitializing(false);
    // Chạy bằng "Run as administrator": Windows chặn kéo-thả file từ File Explorer vào app → báo người dùng một lần
    ipc.app?.isElevated?.().then((elevated) => {
      if (elevated) {
        useAppStore.getState().showNotification(
          'Deplao đang chạy bằng quyền quản trị — Windows chặn kéo-thả ảnh / file từ File Explorer vào app. '
          + 'Đóng và mở lại Deplao bình thường (không chọn "Run as administrator") để kéo-thả được.',
          'warning',
        );
      }
    }).catch(() => {});

    const init = async () => {
      try {
        // 1. Load saved accounts
        const accountsRes = await ipc.login?.getAccounts();
        if (accountsRes?.accounts) {
          setAccounts(accountsRes.accounts);

          // ConversationList loads the visible account in pages. Loading every
          // contact here serializes a large payload over IPC before first paint.
          const { loadFlags } = useAppStore.getState();
          void Promise.allSettled(accountsRes.accounts.map((acc: any) => loadFlags(acc.zalo_id)))
            .then(() => ipc.app?.setBadge(getFilteredUnreadCount()));

          // 3. Auto-reconnect saved Zalo accounts (ONLY for boss/local workspace)
          // Employee (remote) workspace must NOT connect Zalo directly -
          // boss owns all Zalo connections and relays events via SSE.
          const initActiveWs = await ipc.workspace?.getActive?.().then((r: any) => r?.workspace).catch(() => null);
          const isEmployeeMode = initActiveWs?.type === 'remote';
          if (!isEmployeeMode) {
            for (const acc of accountsRes.accounts) {
              if (isNonZalo(acc.channel)) continue; // Skip non-Zalo accounts
              if (!acc.isConnected) {
                const auth = buildZaloAuth(acc);
                ipc.login?.connectAccount(auth).catch(() => {});
              }
            }

            // 3b. Auto-reconnect Telegram accounts (main process handles actual reconnect,
            //     here we just sync status and mark as connected in UI)
            const telegramAccounts = accountsRes.accounts.filter((a: any) => {
              const ch = a.channel || CHANNEL.ZALO;
              return ch === 'telegram_bot' || ch === 'telegram_user';
            });
            for (const tgAcc of telegramAccounts) {
              (async () => {
                try {
                  const ch = tgAcc.channel || 'telegram_user';
                  // Đợi 2s để main process reconnect xong
                  await new Promise(r => setTimeout(r, 2000));
                  if (ch === 'telegram_user') {
                    const health = await ipc.telegramUser?.isConnected(tgAcc.zalo_id);
                    if (health?.connected) {
                      useAccountStore.getState().updateAccountStatus(tgAcc.zalo_id, true, true);
                      useAccountStore.getState().updateListenerActive(tgAcc.zalo_id, true);
                    }
                  } else if (ch === 'telegram_bot') {
                    const health = await (ipc as any).telegram?.getActiveBots?.();
                    const isActive = health?.bots?.some((b: any) => b.accountId === tgAcc.zalo_id) ?? false;
                    if (isActive) {
                      useAccountStore.getState().updateAccountStatus(tgAcc.zalo_id, true, true);
                      useAccountStore.getState().updateListenerActive(tgAcc.zalo_id, true);
                    }
                  }
                } catch {}
              })();
            }
          }

          // 4. Check + refresh avatar URLs for connected Zalo accounts
          //    Avatar CDN URLs expire over time - verify validity and refresh if needed.
          for (const acc of accountsRes.accounts) {
            if (isNonZalo(acc.channel)) continue;
            if (!acc.isConnected) continue;
            (async () => {
              try {
                const result = await ipc.login?.checkAndRefreshAvatar(acc.zalo_id);
                if (result?.success && result.refreshed && result.avatar_url) {
                  useAccountStore.getState().updateAccount(acc.zalo_id, {
                    avatar_url: result.avatar_url,
                    ...(result.full_name ? { full_name: result.full_name } : {}),
                  });
                }
              } catch { /* fire-and-forget, don't block init */ }
            })();
          }

          // 4b. Sync FB account connection status from main process
          //     (reconnectAllFBAccounts runs in main process before renderer is ready,
          //      so the fb:onConnectionStatus event may have been missed)
          //     Nhân viên: phiên Facebook chạy trên Boss — trạng thái lấy từ snapshot + fb:onConnectionStatus (relay),
          //     fb:checkHealth ở máy nhân viên là thao tác chỉ Boss.
          const fbAccounts = accountsRes.accounts.filter((a: any) => (a.channel || CHANNEL.ZALO) === 'facebook');
          if (fbAccounts.length > 0 && !isEmployeeMode) {
            setTimeout(async () => {
              for (const fbAcc of fbAccounts) {
                try {
                  const health = await ipc.fb?.checkHealth({ accountId: fbAcc.zalo_id });
                  if (health?.success && health.alive) {
                    useAccountStore.getState().updateAccountStatus(fbAcc.zalo_id, true, true);
                  }
                } catch {}
              }
            }, 2000);
          }
        }

        // ── Restore employee mode based on active workspace ─────────────────
        try {
          const activeWsRes = await ipc.workspace?.getActive();
          const activeWs = activeWsRes?.workspace;
          if (activeWs?.id) {
            useWorkspaceStore.getState().setActiveWorkspaceId(activeWs.id);
          }
          if (activeWs?.type === 'remote') {
            const empStore = useEmployeeStore.getState();
            empStore.reset();
            empStore.setMode('employee');
            empStore.setCurrentEmployee(buildCurrentEmployeeFromWorkspace(activeWs));
            empStore.setBossUrl(normalizeBossUrl(activeWs.bossUrl));
            empStore.setToken(activeWs.token || '');
            console.log(`[App] 🪙 Recovery token: ${activeWs.token ? activeWs.token.slice(0, 20) + '...' : 'EMPTY!'}`);
            // RestQueryService: đã init ở effect "Early init" từ CÙNG cấu hình workspace, sau đó theo
            // employee:credentials của main (kết nối / đổi URL-token). Status listener đăng ký 1 lần ở effect riêng.
            if (!activeWs.bossUrl || !activeWs.token) {
              console.warn(`[App] ⚠️ Remote workspace thiếu cấu hình: bossUrl=${!!activeWs.bossUrl} token=${!!activeWs.token}`);
            }
            // Query actual connection status instead of hardcoding false
            // (connectAutoWorkspaces may have already connected by the time init reaches here)
            const connStatus = await ipc.workspace?.getConnectionStatus?.(activeWs.id).catch(() => null);
            empStore.setHeartbeatConnected(!!connStatus?.connected);
            empStore.setAuthExpired(!!connStatus?.authExpired);
            if (connStatus?.latency !== undefined) empStore.setLatency(connStatus.latency);
            // Load from cached data in workspace config (populated after first successful connection)
            empStore.setPermissions(buildPermissionsMap(activeWs.cachedPermissions));
            empStore.setAssignedAccounts(activeWs.cachedAssignedAccounts || []);

            if (useAccountStore.getState().accounts.length === 0 && activeWs.cachedAccountsData?.length) {
              const cachedAccounts = normalizeWorkspaceAccounts(activeWs.cachedAccountsData);
              setAccounts(cachedAccounts as any);
              ensureActiveAccount(cachedAccounts);
              loadEmployeeConversationsForAccounts(cachedAccounts);
            }

          }
          // If local workspace, mode stays as default (standalone/boss)
        } catch { /* ignore */ }
      } catch (err) {
        console.error('Init error:', err);
      } finally {
        setInitializing(false);
      }
    };

    init();
  }, []);

  useEffect(() => {
    const runHealthCheck = async () => {
      // Skip health check for employee (remote) workspace - boss owns Zalo connections
      const hcActiveWs = await ipc.workspace?.getActive?.().then((r: any) => r?.workspace).catch(() => null);
      if (hcActiveWs?.type === 'remote') return;

      const currentAccounts = useAccountStore.getState().accounts;
      if (!currentAccounts.length) return;

      // ── Zalo health check ──
      const connectedIds = currentAccounts
        .filter((a) => a.isConnected && isZalo(a.channel))
        .map((a) => a.zalo_id);

      if (connectedIds.length) {
        const results = await checkListenerHealth(connectedIds);
        for (const r of results) {
          if (!r.healthy) {
            console.warn(`[HealthCheck] ${r.zaloId} unhealthy: readyState=${r.readyState} reason=${r.reason}`);
            updateListenerActive(r.zaloId, false);
            const acc = currentAccounts.find((a) => a.zalo_id === r.zaloId);
            if (acc) void reconnectAccountNow(acc, 'healthcheck');
          } else {
            updateListenerActive(r.zaloId, true);
          }
        }
      }

      // ── Telegram Bot health check ──
      const botAccounts = currentAccounts.filter(a => a.channel === 'telegram_bot');
      if (botAccounts.length) {
        try {
          const activeBots = await (ipc as any).telegram?.getActiveBots?.();
          const activeBotIds = new Set<string>(
            (activeBots?.bots || []).map((b: any) => String(b.accountId))
          );
          for (const acc of botAccounts) {
            const isActive = activeBotIds.has(acc.zalo_id);
            if (!isActive && acc.isConnected) {
              console.warn(`[HealthCheck] Telegram Bot ${acc.zalo_id} disconnected, reconnecting...`);
              useAccountStore.getState().updateAccountStatus(acc.zalo_id, false, false);
              // Reconnect: start bot again
              (ipc as any).telegram?.startBot?.({
                accountId: acc.zalo_id,
                botToken: acc.cookies || '',
                botUsername: (acc as any).username || '',
                botFirstName: acc.full_name || '',
              }).then((res: any) => {
                if (res?.success) {
                  useAccountStore.getState().updateAccountStatus(acc.zalo_id, true, true);
                  useAccountStore.getState().updateListenerActive(acc.zalo_id, true);
                  console.log(`[HealthCheck] Telegram Bot ${acc.zalo_id} reconnected`);
                }
              }).catch(() => {});
            } else if (isActive) {
              useAccountStore.getState().updateAccountStatus(acc.zalo_id, true, true);
              useAccountStore.getState().updateListenerActive(acc.zalo_id, true);
            }
          }
        } catch {}
      }
    };

    // Chạy ngay lần đầu sau 10s, sau đó mỗi 1 phút
    const initialTimer = setTimeout(() => {
      runHealthCheck();
      healthTimerRef.current = setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL_MS);
    }, 10_000);

    return () => {
      clearTimeout(initialTimer);
      if (healthTimerRef.current) clearInterval(healthTimerRef.current);
    };
  }, [checkListenerHealth, reconnectAccountNow, updateListenerActive]);

  // ─── Network online/offline handling ─────────────────────────────────────
  useEffect(() => {
    const handleOffline = () => {
      useAppStore.getState().showNotification(
        '🌐 Mất kết nối internet - ứng dụng sẽ thử kết nối lại khi mạng trở lại',
        'warning',
      );
    };

    const handleOnline = () => {
      // Telegram User connections live in the main process; let them skip the
      // reconnect backoff. Independent of the Zalo reconnect below.
      ipc.telegramUser?.networkOnline?.().catch(() => {});
      // Remote workspace (nhân viên ↔ Boss): main thử lại / heartbeat ngay thay vì chờ backoff
      ipc.workspace?.networkOnline?.().catch(() => {});
      reconnectAfterNetworkRestore().catch((err) => {
        console.warn('[NetworkReconnect] error:', err);
      });
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [reconnectAfterNetworkRestore]);

  const pluginPanelOpen = !!activePluginPanel && !showGroupBoard && !showConversationInfo && !showIntegrationQuickPanel && !showAIQuickPanel;
  const rightInfoOverlayOpen =
      showGroupBoard || showConversationInfo || showIntegrationQuickPanel || showAIQuickPanel || pluginPanelOpen;

  const closeRightInfoOverlay = () => {
    if (showGroupBoard) setShowGroupBoard(false);
    if (showConversationInfo) toggleConversationInfo();
    if (showIntegrationQuickPanel) toggleIntegrationQuickPanel();
    if (showAIQuickPanel) toggleAIQuickPanel();
    if (activePluginPanel) setActivePluginPanel(null);
  };

  // ─── Lock screen gate: block entire app until unlocked ───────────────────
  if (lockEnabled && isLocked) {
    return <LockScreen onUnlock={() => setIsLocked(false)} />;
  }

  if (initializing) {
    return (
      <div className="h-screen flex flex-col bg-background">
        <TopBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Spinner size={10} className="mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">Đang khởi động...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <TopBar />
      <EmployeeConnectionBanner />

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: account list + nav */}
        <Sidebar onAddAccount={() => setAddAccountModalOpen(true)} />

        {/* Account panel (sidebar expanded) - chỉ hiện ở chat view */}
        {view === 'chat' && sidebarExpanded && (
          <AccountPanel onAddAccount={() => setAddAccountModalOpen(true)} />
        )}

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          {view === 'chat' && (
            <>
              {/* Responsive: On small screens, show either list OR chat (Telegram-style) */}
              {(!isMobile || !mobileShowChat) && (
                <>
                  <div data-sidebar data-sidebar-width={sidebarWidth} style={{ width: sidebarWidth, flexShrink: 0 }} className="relative">
                    <ConversationList />
                  </div>
                  {/* Resizable divider */}
                  {!isMobile && (
                    <div
                      onMouseDown={handleSidebarResizeStart}
                      className={`w-1 flex-shrink-0 cursor-col-resize border-r border-border hover:bg-primary/40 transition-colors z-10 ${sidebarResizing ? 'bg-primary/60' : 'bg-card'}`}
                      title="Kéo để thay đổi chiều rộng"
                    />
                  )}
                </>
              )}
              {(!isMobile || mobileShowChat) && (
                <div className="flex flex-col flex-1 overflow-hidden">
                  {/* Chat header with title + info toggle */}
                  <ChatHeader />
                  <div className="flex flex-1 overflow-hidden relative">
                    {/* Chat content */}
                    <div className="flex flex-col flex-1 overflow-hidden relative"
                         onClick={() => {
                           if (rightInfoOverlayOpen) closeRightInfoOverlay();
                         }}>
                      <ChatWindow />
                      {/* Đang mở phần bình luận bài đăng kênh: phần đó có ô soạn tin riêng (gửi vào nhóm thảo luận) → bỏ ô
                          của kênh để chỉ một ô nhận dán / kéo thả / trích dẫn; tin nháp vẫn giữ trong store */}
                      {!postDiscussionOpen && <MessageInput />}
                      {/* Bình luận bài đăng kênh Telegram: phủ lên kênh + ô soạn tin (kênh giữ nguyên vị trí cuộn bên dưới) */}
                      <TelegramPostDiscussionHost activeAccountId={activeAccountId} activeThreadId={activeThreadId} />
                    </div>
                    {/* Bảng tin nhóm panel */}
                    {showGroupBoard && activeThreadId && activeAccountId && (() => {
                      const contact = activeContact;
                      const isGroupThread = activeThreadType === 1 || contact?.contact_type === 'group';
                      return isGroupThread ? (
                        <div className="absolute inset-y-0 right-0 z-50 w-80 max-w-[92vw] border-l border-border bg-card flex flex-col overflow-hidden shadow-2xl"
                              onClick={(e) => e.stopPropagation()}>
                          <GroupBoardPanel
                            zaloId={activeAccountId}
                            threadId={activeThreadId}
                            onBack={() => setShowGroupBoard(false)}
                            onCreateNote={() => {
                              window.dispatchEvent(new CustomEvent('groupinfo:createNote', { detail: { groupId: activeThreadId } }));
                            }}
                            onScrollToMsg={async (msgId) => {
                              setShowGroupBoard(false);
                              window.dispatchEvent(new CustomEvent('chat:jumpToMessage', {
                                detail: {
                                  accountId: activeAccountId,
                                  threadId: activeThreadId,
                                  messageId: msgId,
                                },
                              }));
                            }}
                            onNoteClick={(note) => {
                              window.dispatchEvent(new CustomEvent('groupinfo:viewNote', { detail: note }));
                            }}
                          />
                        </div>
                      ) : null;
                    })()}
                    {/* Right panel: conversation info */}
                    {showConversationInfo && activeThreadId && (
                        <div className="absolute inset-y-0 right-0 z-40 max-w-[92vw] overflow-hidden"
                            onClick={(e) => e.stopPropagation()}>
                          <ConversationInfo />
                        </div>
                    )}
                    {/* Right panel: integration quick panel */}
                    {showIntegrationQuickPanel && (
                        <div
                            className="absolute inset-y-0 right-0 z-40 max-w-[92vw] overflow-hidden"
                            onClick={(e) => e.stopPropagation()}
                        >
                          <IntegrationQuickPanel
                              onClose={toggleIntegrationQuickPanel}
                              contextPhone={(() => {
                                const c = activeContact;
                                const raw = c?.phone || '';
                                if (!raw) return '';
                                const digits = raw.startsWith('+') ? raw.slice(1) : raw;
                                if (digits.startsWith('84') && digits.length >= 11) return '0' + digits.slice(2);
                                return raw;
                              })()}
                              contextName={(() => {
                                const c = activeContact;
                                return c?.alias || c?.display_name || '';
                              })()}
                          />
                        </div>
                    )}
                    {/* Right panel: AI quick panel */}
                    {showAIQuickPanel && (
                        <div
                            className="absolute inset-y-0 right-0 z-40 max-w-[92vw] overflow-hidden"
                            onClick={(e) => e.stopPropagation()}
                        >
                          <AIQuickPanel onClose={toggleAIQuickPanel} />
                        </div>
                    )}
                    {/* Right panel: plugin (contributes.chatPanels) */}
                    {pluginPanelOpen && (
                        <div
                            className="absolute inset-y-0 right-0 z-40 max-w-[92vw] overflow-hidden"
                            onClick={(e) => e.stopPropagation()}
                        >
                          <PluginChatPanel />
                        </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner size={8} /></div>}>
            {view === 'settings' && <div className="flex-1 h-full overflow-hidden"><Settings /></div>}
            {view === 'crm' && <div className="flex-1 h-full overflow-hidden"><CRMPage /></div>}
            {view === 'workflow' && <div className="flex-1 h-full overflow-hidden"><WorkflowPage /></div>}
            {view === 'integration' && <div className="flex-1 h-full overflow-hidden"><IntegrationPage /></div>}
            {view === 'analytics' && <div className="flex-1 h-full overflow-hidden"><AnalyticsPage /></div>}
            {view === 'erp' && <div className="flex-1 h-full overflow-hidden"><ErpPage /></div>}
            {view === 'dashboard' && <Dashboard />}
            {/* Trang plugin: giữ iframe đã mở khi chuyển view (ẩn bằng CSS) */}
            <PluginPagesHost />
          </Suspense>
        </div>
      </div>

      {/* Add Account Modal */}
      {addAccountModalOpen && (
        <AddAccountModal onClose={() => setAddAccountModalOpen(false)} />
      )}

      {/* Global Notification */}
      {notification && (
        <div
          onClick={hideNotification}
          className={`fixed top-6 right-6 z-50 max-w-sm w-[calc(100vw-3rem)] cursor-pointer
            flex items-start gap-3 pl-4 pr-3 py-3.5 rounded-2xl shadow-2xl transition-all
            ${theme === 'light'
              ? 'bg-white border border-gray-200 shadow-gray-300/50'
              : 'bg-background border border-border/70 shadow-black/60'
            }`}
          style={{
            borderLeftWidth: '0.25rem',
            borderLeftStyle: 'solid',
            borderLeftColor:
              notification.type === 'success' ? '#22c55e'
              : notification.type === 'error'   ? '#ef4444'
              : notification.type === 'warning' ? '#f59e0b'
              : '#3b82f6',
          }}
        >
          {/* Icon badge */}
          <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold mt-0.5
            ${notification.type === 'success' ? 'bg-green-500/15 text-green-500'
            : notification.type === 'error'   ? 'bg-red-500/15 text-red-500'
            : notification.type === 'warning' ? 'bg-amber-500/15 text-amber-500'
            : 'bg-blue-500/15 text-blue-500'}`}>
            {notification.type === 'success' ? '✓'
            : notification.type === 'error'   ? '✕'
            : notification.type === 'warning' ? '!'
            : 'i'}
          </div>

          {/* Text */}
          <div className="flex-1 min-w-0 pt-0.5">
            <p className={`text-[10px] font-semibold uppercase tracking-widest mb-0.5
              ${notification.type === 'success' ? 'text-green-500'
              : notification.type === 'error'   ? 'text-red-500'
              : notification.type === 'warning' ? 'text-amber-500'
              : 'text-blue-500'}`}>
              {notification.type === 'success' ? 'Thành công'
              : notification.type === 'error'   ? 'Lỗi'
              : notification.type === 'warning' ? 'Cảnh báo'
              : 'Thông báo'}
            </p>
            <p className={`text-sm leading-snug font-medium break-words
              ${theme === 'light' ? 'text-gray-800' : 'text-foreground'}`}>
              {notification.message}
            </p>
          </div>

          {/* Close */}
          <button
            onClick={(e) => { e.stopPropagation(); hideNotification(); }}
            className={`flex-shrink-0 mt-0.5 w-6 h-6 flex items-center justify-center rounded-full transition-colors
              ${theme === 'light'
                ? 'text-muted-foreground hover:text-muted-foreground hover:bg-gray-100'
                : 'text-muted-foreground hover:text-foreground/80 hover:bg-muted/60'}`}>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
              <path d="M6.06 5l2.47-2.47A.75.75 0 007.47 1.47L5 3.94 2.53 1.47A.75.75 0 001.47 2.53L3.94 5 1.47 7.47a.75.75 0 001.06 1.06L5 6.06l2.47 2.47a.75.75 0 001.06-1.06L6.06 5z"/>
            </svg>
          </button>
        </div>
      )}

      {erpPermissionDialog && (
        <div className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4" onClick={hideErpPermissionDialog}>
          <div
            onClick={e => e.stopPropagation()}
            className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden ${theme === 'light' ? 'bg-white border-red-200 shadow-gray-400/30' : 'bg-popover border-border shadow-black/60'}`}
          >
            <div className={`px-5 py-4 border-b ${theme === 'light' ? 'border-red-100 bg-red-50/80' : 'border-border bg-red-500/10'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-red-500/15 text-red-500 flex items-center justify-center text-xl font-bold flex-shrink-0">!</div>
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${theme === 'light' ? 'text-gray-900' : 'text-foreground'}`}>{erpPermissionDialog.title}</p>
                    <p className={`text-xs mt-1 ${theme === 'light' ? 'text-red-700' : 'text-red-300'}`}>Hệ thống đã chặn thao tác vì tài khoản hiện tại không đủ quyền.</p>
                  </div>
                </div>
                <button
                  onClick={hideErpPermissionDialog}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${theme === 'light' ? 'text-muted-foreground hover:text-gray-700 hover:bg-white' : 'text-muted-foreground hover:text-foreground hover:bg-card'}`}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="px-5 py-4 space-y-3">
              <p className={`text-sm leading-relaxed ${theme === 'light' ? 'text-gray-700' : 'text-foreground'}`}>
                {erpPermissionDialog.message}
              </p>
              {erpPermissionDialog.details && (
                <div className={`rounded-xl border px-3 py-2 ${theme === 'light' ? 'border-gray-200 bg-gray-50' : 'border-border bg-card'}`}>
                  <p className={`text-[11px] uppercase tracking-wider mb-1 ${theme === 'light' ? 'text-muted-foreground' : 'text-muted-foreground'}`}>Chi tiết</p>
                  <p className={`text-xs break-words ${theme === 'light' ? 'text-muted-foreground' : 'text-foreground/80'}`}>{erpPermissionDialog.details}</p>
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={hideErpPermissionDialog}
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors"
                >
                  Đã hiểu
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reminder Notification (hàng đợi: nhắc hẹn Zalo + lịch Quản lý công việc) */}
      {reminderNotification && (
        <ReminderNotification
          key={reminderNotification.key}
          data={reminderNotification}
          onClose={() => setReminderQueue(queue => queue.slice(1))}
          onOpenThread={(zaloId, threadId, threadType) => {
            const current = reminderNotification;
            setReminderQueue(queue => queue.slice(1));
            if (current.kind === 'erp') {
              // Lịch từ tin nhắn: mở hội thoại như bấm thông báo (đổi tài khoản, báo đã đọc) rồi nhảy tới tin đã thêm vào lịch
              openLinkedConversation({ linked_account_id: zaloId, linked_contact_id: threadId, linked_msg_id: current.msgId });
              return;
            }
            // Switch active thread
            const { setActiveThread, setMessages, clearUnread } = useChatStore.getState();
            const { setActiveAccount } = useAccountStore.getState();
            setActiveAccount(zaloId);
            setActiveThread(threadId, threadType);
            clearUnread(zaloId, threadId);
            // Load messages
            DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
            // Chủ động mở hội thoại từ nhắc hẹn → báo đã đọc lên nền tảng như khi bấm trong danh sách
            void liveReadSync.syncOpenedThread({ accountId: zaloId, threadId, threadType });
            DataAccessor.getMessages({ zaloId, threadId, limit: 50, offset: 0 }).then((res: any) => {
              const msgs = res?.messages || [];
              if (msgs.length > 0) {
                setMessages(zaloId, threadId, [...msgs].reverse());
              }
            }).catch(() => {});
            // Chuyển sang view chat nếu đang ở view khác
            const { setView } = useAppStore.getState();
            setView('chat');
          }}
        />
      )}

      {/* Thông báo tin nhắn mới trong app (góc trên bên phải, dưới thanh tiêu đề) */}
      <InAppMessageToasts belowFriendRequest={friendRequestQueue.length > 0} />

      {/* Friend Request In-App Notification - show one at a time from queue */}
      {friendRequestQueue.length > 0 && (
        <FriendRequestNotification
          key={`${friendRequestQueue[0].zaloId}_${friendRequestQueue[0].userId}`}
          data={friendRequestQueue[0]}
          onAccept={handleFriendRequestAccept}
          onReject={handleFriendRequestReject}
          onOpenRequests={handleFriendRequestOpenAll}
          onClose={() => setFriendRequestQueue(prev => prev.slice(1))}
        />
      )}

      {/* Quick Chat Modal */}
      {quickChatOpen && <QuickChatModal />}

      {/* Account Init Panel - shown once for new/uninitialized accounts */}
      {accountInitId && (
        <AccountInitPanel
          accountId={accountInitId}
          onClose={() => setAccountInitId(null)}
        />
      )}

      {/* Auto-update notification - bottom-right corner */}
      <UpdateNotification />
      <AccountSwitcherOverlay />
      {/* Cuộc gọi Telegram đến: từ chối / mở chat (Deplao chưa nghe máy được) */}
      <TelegramIncomingCall />
    </div>
  );
}
