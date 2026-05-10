import React, { useCallback, useEffect, useState, useRef } from 'react';
import TopBar from './components/layout/TopBar';
import Sidebar from './components/layout/Sidebar';
import Dashboard from './components/dashboard/Dashboard';
import ConversationList from './components/chat/ConversationList';
import ChatHeader from './components/chat/ChatHeader';
import ChatWindow from './components/chat/ChatWindow';
import MessageInput from './components/chat/MessageInput';
import ConversationInfo from './components/chat/ConversationInfo';
import GroupBoardPanel from './components/chat/GroupBoardPanel';
import IntegrationQuickPanel from './components/integration/IntegrationQuickPanel';
import AIQuickPanel from './components/integration/AIQuickPanel';
import ReminderNotification from './components/chat/ReminderNotification';
import FriendRequestNotification, { FriendRequestNotifData } from './components/common/FriendRequestNotification';
import QuickChatModal from './components/chat/QuickChatModal';
import Settings from './components/settings/Settings';
import CRMPage from './components/crm/CRMPage';
import WorkflowPage from './components/workflow/WorkflowPage';
import IntegrationPage from './components/integration/IntegrationPage';
import AnalyticsPage from './components/analytics/AnalyticsPage';
import ErpPage from './features/erp/ErpPage';
import AccountInitPanel from './components/common/AccountInitPanel';
import { UpdateNotification } from './components/common/UpdateNotification';
import { useAppStore } from './store/appStore';
import { useAccountStore } from './store/accountStore';
import { useChatStore } from './store/chatStore';
import { useCRMStore } from './store/crmStore';
import { useZaloEvents } from './hooks/useZaloEvents';
import { useChatEvents } from './hooks/useChatEvents';
import useIsMobile from './hooks/useIsMobile';
import ipc from './lib/ipc';
import { sendSeenForThread } from './lib/sendSeenHelper';
import { getFilteredUnreadCount } from './lib/badgeUtils';
import { playNotificationSound, showDesktopNotification } from './utils/NotificationService';
import { checkAccountInitNeeds } from './lib/zaloInitUtils';
import AddAccountModal from "@/components/auth/AddAccountModal";
import EmployeeConnectionBanner from "@/components/common/EmployeeConnectionBanner";
import { useWorkspaceStore } from './store/workspaceStore';
import { useEmployeeStore } from './store/employeeStore';

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
    return {
    zalo_id: account.zalo_id,
    display_name: fullName,
    full_name: fullName,
    avatar_url: account.avatar_url || '',
    phone: account.phone || '',
    is_business: account.is_business || 0,
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

export default function App() {
  const {
    view, setView, notification, hideNotification,
    erpPermissionDialog, hideErpPermissionDialog,
    addAccountModalOpen, setAddAccountModalOpen,
    showConversationInfo, toggleConversationInfo,
    showGroupBoard, setShowGroupBoard,
    showIntegrationQuickPanel, toggleIntegrationQuickPanel,
    showAIQuickPanel, toggleAIQuickPanel,
    openQuickChat, quickChatOpen, theme
  } = useAppStore();
  const { setAccounts, updateListenerActive, accounts } = useAccountStore();
  const { setContacts } = useChatStore();
  const { activeThreadId, activeThreadType, contacts } = useChatStore();
  const { activeAccountId } = useAccountStore();
  const [initializing, setInitializing] = useState(true);
  const isMobile = useIsMobile();
  const { mobileShowChat, setMobileShowChat } = useAppStore();

  // ─── Sync theme to <html> element ────────────────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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

  const [reminderNotification, setReminderNotification] = useState<{
    emoji: string;
    title: string;
    description: string;
    accountName: string;
    conversationName: string;
    color: number;
    zaloId: string;
    threadId: string;
    threadType: number;
  } | null>(null);
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
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
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
    const currentAccounts = useAccountStore.getState().accounts.filter(a => (a.channel || 'zalo') === 'zalo');
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
      `🌐 Mạng đã khôi phục — đang kết nối lại ${candidates.length} tài khoản`,
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
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
    await ipc.zalo?.acceptFriendRequest({ auth, userId });
    await ipc.db?.removeFriendRequest({ zaloId, userId, direction: 'received' }).catch(() => {});
    await ipc.db?.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
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
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
    await ipc.zalo?.rejectFriendRequest({ auth, userId });
    await ipc.db?.removeFriendRequest({ zaloId, userId, direction: 'received' }).catch(() => {});
    await ipc.db?.getFriendRequests({ zaloId, direction: 'received' }).then((res: any) => {
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
    const channel = acc?.channel || 'zalo';
    // Already checked this account this session
    if (initCheckedRef.current.has(activeAccountId)) return;
    initCheckedRef.current.add(activeAccountId);

    // Each account is checked at most once per app session.
    const accountId = activeAccountId;
    if (channel === 'facebook') {
      // FB init: simpler flow — just sync threads
      import('@/lib/fbInitUtils').then(({ checkFBAccountInitNeeds }) => {
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
        console.warn('[App] workspace:switched handler timeout — forcing isSwitching=false');
        useWorkspaceStore.getState().setIsSwitching(false);
      }, 15000);
      try {
      // Use workspace from event payload directly — no extra IPC roundtrip
      const ws = data.workspace;
      console.log(`[App] Workspace switched to: ${ws.name} (${ws.id}) type=${ws.type}`);

      // Update workspace store FIRST — so all subsequent checks use the correct activeWorkspaceId
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
        empStore.setPermissions(buildPermissionsMap(ws.cachedPermissions));
        empStore.setAssignedAccounts(ws.cachedAssignedAccounts || []);
        empStore.setEmployees(ws.cachedEmployeesData || []);

        // Use snapshot from event payload (merged by main process) — no IPC needed
        const snapshot = ws._snapshot;
        if (snapshot) {
          empStore.setBossConnected(true);
          if (snapshot.assignedAccounts?.length) empStore.setAssignedAccounts(snapshot.assignedAccounts);
          if (snapshot.permissions?.length) empStore.setPermissions(buildPermissionsMap(snapshot.permissions));
          if (snapshot.employeesData) empStore.setEmployees(snapshot.employeesData);
        } else {
          empStore.setBossConnected(!!ws._connected);
        }
      } else {
        empStore.reset();
      }

      // Reset stores to reflect new workspace data
      try {
        let nextAccounts: any[];
        if (ws.type === 'remote') {
          // Remote: use snapshot or cached accounts — no DB query needed
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

        // Reload contacts from local DB (non-blocking, with timeout)
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
  // Fired when employee successfully connects to boss — contains permissions + assignedAccounts.
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:initialState', async (data: any) => {
      if (!data?.workspaceId) return;
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
      empStore.setBossConnected(true);
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
        console.log(`[App] Accounts set from initialState: ${cachedAccounts.length} accounts`, cachedAccounts.map(a => ({ zalo_id: a.zalo_id, full_name: a.full_name })));
      } else {
        setAccounts([]);
        console.log(`[App] No accountsData in initialState`);
      }

      // ── Auto full-sync on first connection (no previous sync) ─────────────
      const syncAccountIds = assignedAccounts;
      if (syncAccountIds.length > 0) {
        try {
          const syncStatus = await ipc.sync?.getStatus();
          if (!syncStatus?.lastSyncTs) {
            ipc.sync?.requestFullSync(syncAccountIds).then((res: any) => {
              if (res?.success) {
              } else {
              }
            }).catch(() => {
            });
          }
        } catch { /* ignore sync status check failure */ }
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
    });
    return () => unsub?.();
  }, []);

  // ─── Track remote workspace connection status ───────────
  useEffect(() => {
    const unsub = window.electronAPI?.on('workspace:connectionStatus', (data: any) => {
      if (!data?.workspaceId) return;
      useWorkspaceStore.getState().setConnectionStatus(data.workspaceId, {
        connected: !!data.connected,
        latency: data.latency ?? 0,
      });
      // Update employeeStore.bossConnected if this is the active workspace
      const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (data.workspaceId === activeWsId) {
        const empStore = useEmployeeStore.getState();
        if (empStore.mode === 'employee') {
          empStore.setBossConnected(!!data.connected);
          if (data.latency !== undefined) empStore.setLatency(data.latency);
        }
      }
    });
    return () => unsub?.();
  }, []);

  // ─── nav:view — navigate to a top-level view from other components ───────────
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
        // Không flash cho tin nhắn của chính mình, hội thoại muted hoặc trong thư mục "Khác"
        if (isSelf) return;
        const { isMuted, isInOthers } = useAppStore.getState();
        if (isMuted(zaloId, threadId) || isInOthers(zaloId, threadId)) return;
        window.electronAPI?.app?.flashFrame?.(true);
      }
    });
    return () => unsub?.();
  }, []);

  // ─── Facebook: flash taskbar + notification on new message ───────────────
  useEffect(() => {
    const unsub = window.electronAPI?.on('fb:onMessage', (data: any) => {
      const body = data?.message?.body;
      const threadId = data?.message?.replyToID || '';
      const accountId = data?.fbAccountId || '';
      const isSelf = data?.message?.isSelf || (data?.message?.senderID === accountId);

      // Don't notify for own messages
      if (isSelf) return;

      // Check mute/others
      const appState = useAppStore.getState();
      const { notifSettings, isMuted, isInOthers } = appState;
      if (isMuted(accountId, threadId) || isInOthers(accountId, threadId)) return;

      // Flash taskbar when window not focused
      if (!isWindowFocusedRef.current) {
        window.electronAPI?.app?.flashFrame?.(true);
      }

      // Check if this thread is currently active and window is focused → skip notification
      const { activeThreadId } = useChatStore.getState();
      const { activeAccountId } = useAccountStore.getState();
      if (threadId === activeThreadId && accountId === activeAccountId && isWindowFocusedRef.current) return;

      // Sound
      const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';
      if (notifSettings.soundEnabled && notifAllowed) {
        playNotificationSound(notifSettings.volume);
      }

      // Desktop notification
      if (notifSettings.desktopEnabled && notifAllowed && body) {
        const contacts = useChatStore.getState().contacts[accountId] || [];
        const contact = contacts.find((c: any) => c.contact_id === threadId);
        const contactName = contact?.alias || contact?.display_name || 'Facebook';
        showDesktopNotification(
          contactName,
          body.slice(0, 120),
          contact?.avatar_url,
          { zaloId: accountId, threadId, threadType: 0 }
        );
      }
    });
    return () => unsub?.();
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'N') {
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
        const account = accounts.find(a => a.zalo_id === zaloId);
        const accountName = account?.display_name || account?.phone || 'Tài khoản';

        // Lấy thông tin conversation
        const contactList = contacts[zaloId] || [];
        const contact = contactList.find(c => c.contact_id === threadId);
        const conversationName = contact?.display_name || 'Hội thoại';

        // Hiển thị notification
        setReminderNotification({
          emoji: reminderData.emoji || '⏰',
          title: reminderData.params?.title || content.title || 'Nhắc hẹn',
          description: content.description || '',
          accountName,
          conversationName,
          color: reminderData.color ?? -1,
          zaloId,
          threadId,
          threadType: contact?.contact_type === 'group' ? 1 : 0,
        });
      } catch (err) {
        console.error('[ReminderNotification] Parse error:', err);
      }
    };

    window.addEventListener('zalo:reminder', handleReminderEvent);
    return () => window.removeEventListener('zalo:reminder', handleReminderEvent);
  }, [accounts, contacts]);

  // Initialize on app start
  useEffect(() => {
    const init = async () => {
      try {
        // 1. Load saved accounts
        const accountsRes = await ipc.login?.getAccounts();
        if (accountsRes?.accounts) {
          setAccounts(accountsRes.accounts);

          // 2. Load contacts for each account
          for (const acc of accountsRes.accounts) {
            const contactsRes = await ipc.db?.getContacts(acc.zalo_id);
            if (contactsRes?.contacts) {
              setContacts(acc.zalo_id, contactsRes.contacts);
            }
          }

          // 2b. Load muted + others flags trước khi tính badge
          //     (nếu không, isInOthers/isMuted luôn trả false → badge sai)
          const { loadFlags } = useAppStore.getState();
          for (const acc of accountsRes.accounts) {
            await loadFlags(acc.zalo_id);
          }

          // Sync badge
          ipc.app?.setBadge(getFilteredUnreadCount());

          // 3. Auto-reconnect saved Zalo accounts
          for (const acc of accountsRes.accounts) {
            if ((acc.channel || 'zalo') !== 'zalo') continue; // Skip FB accounts
            if (!acc.isConnected) {
              const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
              ipc.login?.connectAccount(auth).catch(() => {});
            }
          }

          // 4b. Sync FB account connection status from main process
          //     (reconnectAllFBAccounts runs in main process before renderer is ready,
          //      so the fb:onConnectionStatus event may have been missed)
          const fbAccounts = accountsRes.accounts.filter((a: any) => (a.channel || 'zalo') === 'facebook');
          if (fbAccounts.length > 0) {
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
            empStore.setBossUrl(activeWs.bossUrl || '');
            // Query actual connection status instead of hardcoding false
            // (connectAutoWorkspaces may have already connected by the time init reaches here)
            const connStatus = await ipc.workspace?.getConnectionStatus?.(activeWs.id).catch(() => null);
            empStore.setBossConnected(!!connStatus?.connected);
            if (connStatus?.latency !== undefined) empStore.setLatency(connStatus.latency);
            // Load from cached data in workspace config (populated after first successful connection)
            empStore.setPermissions(buildPermissionsMap(activeWs.cachedPermissions));
            empStore.setAssignedAccounts(activeWs.cachedAssignedAccounts || []);

            if (useAccountStore.getState().accounts.length === 0 && activeWs.cachedAccountsData?.length) {
              setAccounts(normalizeWorkspaceAccounts(activeWs.cachedAccountsData) as any);
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
      const currentAccounts = useAccountStore.getState().accounts;
      if (!currentAccounts.length) return;

      const connectedIds = currentAccounts
        .filter((a) => a.isConnected && (a.channel || 'zalo') === 'zalo')
        .map((a) => a.zalo_id);

      if (!connectedIds.length) return;

      const results = await checkListenerHealth(connectedIds);
      if (!results.length) return;

      for (const r of results) {
        if (!r.healthy) {
          console.warn(`[HealthCheck] ${r.zaloId} unhealthy: readyState=${r.readyState} reason=${r.reason}`);
          updateListenerActive(r.zaloId, false);

          const acc = currentAccounts.find((a) => a.zalo_id === r.zaloId);
          if (acc) {
            void reconnectAccountNow(acc, 'healthcheck');
          }
        } else {
          updateListenerActive(r.zaloId, true);
        }
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
        '🌐 Mất kết nối internet — ứng dụng sẽ thử kết nối lại khi mạng trở lại',
        'warning',
      );
    };

    const handleOnline = () => {
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

  const rightInfoOverlayOpen =
      showGroupBoard || showConversationInfo || showIntegrationQuickPanel || showAIQuickPanel;

  const closeRightInfoOverlay = () => {
    if (showGroupBoard) setShowGroupBoard(false);
    if (showConversationInfo) toggleConversationInfo();
    if (showIntegrationQuickPanel) toggleIntegrationQuickPanel();
    if (showAIQuickPanel) toggleAIQuickPanel();
  };

  if (initializing) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <TopBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <svg className="animate-spin w-10 h-10 text-blue-400 mx-auto mb-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-gray-400 text-sm">Đang khởi động...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-900 overflow-hidden">
      <TopBar />
      <EmployeeConnectionBanner />

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: account list + nav */}
        <Sidebar onAddAccount={() => setAddAccountModalOpen(true)} />

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          {view === 'chat' && (
            <>
              {/* Responsive: On small screens, show either list OR chat (Telegram-style) */}
              {(!isMobile || !mobileShowChat) && (
                <ConversationList />
              )}
              {(!isMobile || mobileShowChat) && (
                <div className="flex flex-col flex-1 overflow-hidden">
                  {/* Chat header with title + info toggle */}
                  <ChatHeader />
                  <div className="flex flex-1 overflow-hidden relative">
                    {/* Chat content */}
                    <div className="flex flex-col flex-1 overflow-hidden"
                         onClick={() => {
                           if (rightInfoOverlayOpen) closeRightInfoOverlay();
                         }}>
                      <ChatWindow />
                      <MessageInput />
                    </div>
                    {/* Bảng tin nhóm panel */}
                    {showGroupBoard && activeThreadId && activeAccountId && (() => {
                      const contactList = contacts[activeAccountId] || [];
                      const contact = contactList.find(c => c.contact_id === activeThreadId);
                      const isGroupThread = activeThreadType === 1 || contact?.contact_type === 'group';
                      return isGroupThread ? (
                        <div className="absolute inset-y-0 right-0 z-50 w-80 max-w-[92vw] border-l border-gray-700 bg-gray-800 flex flex-col overflow-hidden shadow-2xl"
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

                              const scrollAndHighlight = (el: HTMLElement) => {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                el.classList.add('ring-2', 'ring-yellow-400', 'ring-opacity-75');
                                setTimeout(() => el.classList.remove('ring-2', 'ring-yellow-400', 'ring-opacity-75'), 2000);
                              };

                              await new Promise(r => setTimeout(r, 100));
                              const el = document.getElementById(`msg-${msgId}`);
                              if (el) {
                                scrollAndHighlight(el);
                                return;
                              }

                              // Message not in DOM — load messages around its timestamp
                              if (!activeAccountId || !activeThreadId) return;
                              try {
                                const msgRes = await ipc.db?.getMessageById({ zaloId: activeAccountId, msgId });
                                const targetMsg = msgRes?.message;
                                if (!targetMsg?.timestamp) return;

                                const { setMessages } = useChatStore.getState();
                                const aroundRes = await ipc.db?.getMessagesAround({
                                  zaloId: activeAccountId,
                                  threadId: activeThreadId,
                                  timestamp: targetMsg.timestamp,
                                  limit: 80,
                                });
                                const aroundMsgs = aroundRes?.messages;
                                if (!aroundMsgs?.length) return;

                                setMessages(activeAccountId, activeThreadId, aroundMsgs);

                                await new Promise<void>(resolve => {
                                  requestAnimationFrame(() => {
                                    requestAnimationFrame(() => resolve());
                                  });
                                });

                                const el2 = document.getElementById(`msg-${msgId}`);
                                if (el2) {
                                  scrollAndHighlight(el2);
                                }
                              } catch (err) {
                                console.error('[GroupBoard:onScrollToMsg] Failed to load messages around target:', err);
                              }
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
                          <button type="button"
                              onClick={closeRightInfoOverlay}
                              title="Đóng"
                              className="absolute top-2 left-2 z-50 w-8 h-8 rounded-full text-gray-200 flex items-center justify-center transition-colors">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
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
                                const cl = activeAccountId ? (contacts[activeAccountId] || []) : [];
                                const c = cl.find((x: any) => x.contact_id === activeThreadId);
                                const raw = c?.phone || '';
                                if (!raw) return '';
                                const digits = raw.startsWith('+') ? raw.slice(1) : raw;
                                if (digits.startsWith('84') && digits.length >= 11) return '0' + digits.slice(2);
                                return raw;
                              })()}
                              contextName={(() => {
                                const cl = activeAccountId ? (contacts[activeAccountId] || []) : [];
                                const c = cl.find((x: any) => x.contact_id === activeThreadId);
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
                  </div>
                </div>
              )}
            </>
          )}

          {view === 'settings' && (
            <div className="flex-1 h-full overflow-hidden">
              <Settings />
            </div>
          )}

          {view === 'crm' && (
            <div className="flex-1 h-full overflow-hidden">
              <CRMPage />
            </div>
          )}

          {view === 'workflow' && (
            <div className="flex-1 h-full overflow-hidden">
              <WorkflowPage />
            </div>
          )}

          {view === 'integration' && (
            <div className="flex-1 h-full overflow-hidden">
              <IntegrationPage />
            </div>
          )}


          {view === 'analytics' && (
            <div className="flex-1 h-full overflow-hidden">
              <AnalyticsPage />
            </div>
          )}
          {view === 'erp' && (
            <div className="flex-1 h-full overflow-hidden">
              <ErpPage />
            </div>
          )}
          {view === 'dashboard' && (
            <Dashboard />
          )}
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
              : 'bg-gray-900 border border-gray-700/70 shadow-black/60'
            }`}
          style={{
            borderLeftWidth: 4,
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
              ${theme === 'light' ? 'text-gray-800' : 'text-gray-100'}`}>
              {notification.message}
            </p>
          </div>

          {/* Close */}
          <button
            onClick={(e) => { e.stopPropagation(); hideNotification(); }}
            className={`flex-shrink-0 mt-0.5 w-6 h-6 flex items-center justify-center rounded-full transition-colors
              ${theme === 'light'
                ? 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/60'}`}>
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
            className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden ${theme === 'light' ? 'bg-white border-red-200 shadow-gray-400/30' : 'bg-gray-900 border-gray-700 shadow-black/60'}`}
          >
            <div className={`px-5 py-4 border-b ${theme === 'light' ? 'border-red-100 bg-red-50/80' : 'border-gray-800 bg-red-500/10'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-red-500/15 text-red-500 flex items-center justify-center text-xl font-bold flex-shrink-0">!</div>
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${theme === 'light' ? 'text-gray-900' : 'text-white'}`}>{erpPermissionDialog.title}</p>
                    <p className={`text-xs mt-1 ${theme === 'light' ? 'text-red-700' : 'text-red-300'}`}>Hệ thống đã chặn thao tác vì tài khoản hiện tại không đủ quyền.</p>
                  </div>
                </div>
                <button
                  onClick={hideErpPermissionDialog}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${theme === 'light' ? 'text-gray-400 hover:text-gray-700 hover:bg-white' : 'text-gray-500 hover:text-white hover:bg-gray-800'}`}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="px-5 py-4 space-y-3">
              <p className={`text-sm leading-relaxed ${theme === 'light' ? 'text-gray-700' : 'text-gray-200'}`}>
                {erpPermissionDialog.message}
              </p>
              {erpPermissionDialog.details && (
                <div className={`rounded-xl border px-3 py-2 ${theme === 'light' ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/80'}`}>
                  <p className={`text-[11px] uppercase tracking-wider mb-1 ${theme === 'light' ? 'text-gray-500' : 'text-gray-500'}`}>Chi tiết</p>
                  <p className={`text-xs break-words ${theme === 'light' ? 'text-gray-600' : 'text-gray-300'}`}>{erpPermissionDialog.details}</p>
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

      {/* Reminder Notification */}
      {reminderNotification && (
        <ReminderNotification
          data={reminderNotification}
          onClose={() => setReminderNotification(null)}
          onOpenThread={(zaloId, threadId, threadType) => {
            setReminderNotification(null);
            // Switch active thread
            const { setActiveThread, setMessages, clearUnread } = useChatStore.getState();
            const { setActiveAccount } = useAccountStore.getState();
            setActiveAccount(zaloId);
            setActiveThread(threadId, threadType);
            clearUnread(zaloId, threadId);
            // Load messages
            ipc.db?.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
            sendSeenForThread(zaloId, threadId, threadType);
            ipc.db?.getMessages({ zaloId, threadId, limit: 50, offset: 0 }).then((res: any) => {
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

      {/* Friend Request In-App Notification — show one at a time from queue */}
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

      {/* Account Init Panel — shown once for new/uninitialized accounts */}
      {accountInitId && (
        <AccountInitPanel
          accountId={accountInitId}
          onClose={() => setAccountInitId(null)}
        />
      )}

      {/* Auto-update notification — bottom-right corner */}
      <UpdateNotification />
    </div>
  );
}
