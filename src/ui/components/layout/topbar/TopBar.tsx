import React, { useState, useEffect, useCallback, useRef } from 'react';
import ipc from '@/lib/ipc';
import { DataAccessor, isReadFailure } from '@/lib/data/DataAccessor';

const SUPPORT_GITHUB_URL = 'https://github.com/babyvibe/deplao-builder';
import { useAppStore, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP } from '@/store/app/appStore';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useUpdateStore } from '@/store/app/updateStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { useWorkspaceStore } from '@/store/app/workspaceStore';
import { useCRMStore } from '@/store/crm/crmStore';
import { hasUnseenAffiliate, markAffiliateSeen } from '@/lib/app/settingsSeenTabs';
import { useChatStore } from '@/store/chat/chatStore';
import WorkspaceSwitcher from '@/components/common/accounts/WorkspaceSwitcher';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useErpReminderAttention } from '@/store/erp/erpReminderAttentionStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useCurrentEmployeeId, useErpPermissions } from '@/hooks/erp/useErpContext';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { useQuickErpAccess } from '@/hooks/erp/useQuickErpAccess';
import { useUpcomingEvents } from '@/hooks/erp/useUpcomingEvents';
import NotificationCenter from '@/components/erp/notifications/NotificationCenter';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, BellOffIcon, KeyIcon, MonitorIcon, PluginIcon, RefreshIcon, StarIcon } from '@/components/common/icons';
import { useInAppNotifyStore } from '@/store/chat/inAppNotifyStore';
import { summarizeInAppNotify } from '@/lib/chat/notifications/inAppNotify';
import FeatureLauncherPanel from './FeatureLauncherPanel';
import LanguagePicker from '@/components/common/i18n/LanguagePicker';
import MobileSyncButton from './MobileSyncButton';
import FacebookSyncButton from './FacebookSyncButton';
import { isTelegram, isTelegramBot, isTelegramUser } from '@/lib/channels/channelHelper';
import RestQueryService from '../../../../services/http/RestQueryService';
import { AUTH_EXPIRED_MESSAGE, isWrongPasswordLogin, normalizeBossUrl } from '../../../../shared/employee/employeeConnection';
import { normalizePastedBossUrl } from '../../../../shared/cloud/tunnelAddress';
import { erpReminderLeadText } from '../../../../shared/erp/erpReminderText';
import { useBossAddressWatch } from './useBossAddressWatch';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';


const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';

/** Old build's localStorage key (base64 password): read only, to move it to main and then delete it. */
const LEGACY_PASSWORD_KEY = 'deplao_employee_password';

/** Map scale factor to px value for display */
const scaleToPx = (s: number) => Math.round(16 * s);

export default function TopBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const { theme, setTheme, showNotification, fontSizeScale, setFontSizeScale } = useAppStore(useShallow(s => ({
    theme: s.theme, setTheme: s.setTheme, showNotification: s.showNotification, fontSizeScale: s.fontSizeScale,
    setFontSizeScale: s.setFontSizeScale,
  })));
  const { activeAccountId, accounts } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, accounts: s.accounts,
  })));
  const [resyncing, setResyncing] = useState(false);
  const [featurePanelOpen, setFeaturePanelOpen] = useState(false);
  const [lockScreenEnabled, setLockScreenEnabled] = useState(false);

  // More dropdown (guide + bug report + font size)
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // Font size slider: local temp value, only applies on release
  const [fontTemp, setFontTemp] = useState(fontSizeScale);

  // ── Affiliate red dot ────────────────────────────────────────────────
  const [hasNewAffiliate, setHasNewAffiliate] = useState(() => hasUnseenAffiliate());
  useEffect(() => {
    const handler = () => setHasNewAffiliate(hasUnseenAffiliate());
    window.addEventListener('settings:tabSeen', handler);
    return () => window.removeEventListener('settings:tabSeen', handler);
  }, []);

  // Update state
  const { status: updateStatus, updateInfo, platform, openUpdatePopup } = useUpdateStore(useShallow(s => ({
    status: s.status, updateInfo: s.updateInfo, platform: s.platform, openUpdatePopup: s.openUpdatePopup,
  })));
  const isMac = platform === 'darwin';

  // Employee store — badge = heartbeat main + REST (connectionBadge, xem employeeStore)
  const { empMode, currentEmployee, connectionBadge, bossUrl, latency } = useEmployeeStore(useShallow(s => ({
    empMode: s.mode, currentEmployee: s.currentEmployee, connectionBadge: s.connectionBadge,
    bossUrl: s.bossUrl, latency: s.latency,
  })));
  const previewEmployee = useEmployeeStore(s => (
    s.previewEmployeeId ? s.employees.find((e: any) => e.employee_id === s.previewEmployeeId) ?? null : null
  ));
  /** Main heartbeat still connected (Online / Restoring) → Disconnect button; Offline / session expired → Reconnect button. */
  const bossLinked = connectionBadge === 'online' || connectionBadge === 'recovering';

  // Reconnect popup state
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState('');
  /** Main holds the saved password (encrypted with safeStorage) for the open workspace: the renderer never sees the password. */
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const bossUrlRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Did the owner's address (temporary tunnel) change? Detected when the connection is lost for more than 30 s, plus a hint from the owner's notification
  const { deadAddress, announced } = useBossAddressWatch();
  const newAddrRef = useRef<HTMLInputElement>(null);
  const [switchingAddr, setSwitchingAddr] = useState(false);
  const [switchAddrError, setSwitchAddrError] = useState('');
  const autoOpenedForRef = useRef<string | null>(null);

  // Dead address → open the "Kết nối lại" (Reconnect) popup once per address
  useEffect(() => {
    if (!deadAddress || autoOpenedForRef.current === deadAddress.url) return;
    autoOpenedForRef.current = deadAddress.url;
    setSwitchAddrError('');
    setReconnectOpen(true);
  }, [deadAddress]);

  // Connection recovers on its own (e.g. the owner only lost network briefly, address unchanged) → close the popup that was opened automatically
  useEffect(() => {
    if (bossLinked && autoOpenedForRef.current) {
      autoOpenedForRef.current = null;
      setReconnectOpen(false);
    }
  }, [bossLinked]);

  /** The owner just reported a new address, but the workspace is using another address (not switched automatically) → show a hint. */
  const announcedHint = announced && !announced.applied && normalizeBossUrl(announced.newUrl) !== normalizeBossUrl(bossUrl)
    ? announced.newUrl
    : null;

  /**
   * Use the owner's new address: check the address first (if wrong, do not overwrite the config), then save + connect through main
   * (workspace:connectRemote) with the current token: main emits employee:credentials, and App re-inits REST.
   */
  const handleUseNewAddress = useCallback(async (override?: string) => {
    setSwitchAddrError('');
    const url = normalizePastedBossUrl(override ?? newAddrRef.current?.value ?? '');
    if (!url) {
      setSwitchAddrError(tr('Dán địa chỉ mới của BOSS (vd https://ten-ngau-nhien.trycloudflare.com)'));
      return;
    }
    if (deadAddress && url === normalizeBossUrl(deadAddress.url)) {
      setSwitchAddrError(tr('Đây vẫn là địa chỉ cũ — hỏi BOSS địa chỉ mới.'));
      return;
    }
    const wsState = useWorkspaceStore.getState();
    const workspaceId = wsState.activeWorkspaceId;
    const activeWs = wsState.activeWorkspace();
    const token = activeWs?.token || useEmployeeStore.getState().token;
    if (!workspaceId || activeWs?.type !== 'remote' || !token) {
      // No session to reuse → log in with the form below, using the new address
      if (bossUrlRef.current) bossUrlRef.current.value = url;
      setSwitchAddrError(tr('Nhập mật khẩu ở dưới rồi bấm "Kết nối lại" để đăng nhập với địa chỉ mới.'));
      return;
    }
    setSwitchingAddr(true);
    try {
      const probe = await ipc.relay?.probeBossAddress?.({ url });
      if (probe?.success && probe.verdict && probe.verdict !== 'reachable') {
        setSwitchAddrError(tr('Không kết nối được tới địa chỉ này: {{v1}}.', { v1: probe.reason || tr('BOSS không phản hồi') }));
        return;
      }
      const res = await ipc.workspace?.connectRemote(workspaceId, url, token);
      if (res) {
        // main has saved the address into the workspace config (even if this connection attempt failed) → sync the renderer's copy
        const latest = useWorkspaceStore.getState();
        latest.setWorkspaces(latest.workspaces.map(ws => (ws.id === workspaceId ? { ...ws, bossUrl: url } : ws)));
      }
      if (res?.success) {
        showNotification(tr('Đã kết nối tới địa chỉ mới của BOSS'), 'success');
        setReconnectOpen(false);
        return;
      }
      if (res?.authExpired) {
        if (bossUrlRef.current) bossUrlRef.current.value = url;
        setSwitchAddrError(hasSavedPassword
          ? tr('Phiên đăng nhập hết hạn — bấm "Kết nối lại" ở dưới để đăng nhập lại bằng mật khẩu đã lưu.')
          : tr('Phiên đăng nhập hết hạn — nhập mật khẩu ở dưới rồi bấm "Kết nối lại".'));
        return;
      }
      setSwitchAddrError(res?.error || tr('Không kết nối được tới BOSS'));
    } catch (err: any) {
      setSwitchAddrError(err?.message || tr('Lỗi kết nối'));
    } finally {
      setSwitchingAddr(false);
    }
  }, [deadAddress, hasSavedPassword, showNotification]);

  // The old build stored the password as base64 in localStorage (anyone who opens DevTools or the profile folder can read it) → move it to main
  // (encrypted with safeStorage) ONCE if the open workspace is remote, then always delete it from localStorage
  useEffect(() => {
    let legacy: string | null = null;
    try { legacy = localStorage.getItem(LEGACY_PASSWORD_KEY); } catch { /* ignore */ }
    if (!legacy) return;
    const encoded = legacy;
    void (async () => {
      try {
        const res = await ipc.workspace?.getActive();
        const ws = res?.workspace;
        if (ws?.type !== 'remote' || !ws.id) return;
        let password = '';
        try { password = atob(encoded); } catch { return; }
        if (!password) return;
        const saved = await ipc.workspace?.rememberPassword(ws.id, password);
        if (saved?.saved && ws.id === useWorkspaceStore.getState().activeWorkspaceId) setHasSavedPassword(true);
      } catch { /* ignore */ } finally {
        try { localStorage.removeItem(LEGACY_PASSWORD_KEY); } catch { /* ignore */ }
      }
    })();
  }, []);

  // Whether the open workspace has a saved password in main → ask again when switching workspace / opening the "Kết nối lại" (Reconnect) popup
  useEffect(() => {
    if (!activeWorkspaceId) { setHasSavedPassword(false); return; }
    let cancelled = false;
    ipc.workspace?.hasSavedPassword?.(activeWorkspaceId)
      .then((res) => { if (!cancelled) setHasSavedPassword(!!res?.saved); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeWorkspaceId, reconnectOpen]);

  // ── Disconnect from the owner ──────────────────────────────────────────────
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      // Disconnect main too: stop the heartbeat + Socket.IO + auto-retry schedule; if only REST is reset,
      // main's heartbeat would turn the Online badge back on.
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      if (workspaceId) {
        const res = await ipc.workspace?.disconnectRemote(workspaceId);
        if (res && !res.success) throw new Error(res.error || tr('Lỗi ngắt kết nối'));
      }
      // REST client stops (App also resets when main reports 'user-disconnect')
      RestQueryService.getInstance().reset();

      // Only set disconnected, do NOT reset currentEmployee/mode
      // => keep the badge + the reconnect button on the UI
      useEmployeeStore.getState().setHeartbeatConnected(false);

      showNotification(tr('Đã ngắt kết nối khỏi BOSS'), 'success');
    } catch (err: any) {
      showNotification(err.message || tr('Lỗi ngắt kết nối'), 'error');
    } finally {
      setDisconnecting(false);
    }
  }, [disconnecting, showNotification]);

  const handleReconnect = useCallback(async () => {
    setReconnectError('');
    const bossAddr = bossUrlRef.current?.value.trim();
    const username = usernameRef.current?.value.trim();
    // Password field empty + main has a saved password → main decrypts it and logs in (the password never passes through the renderer)
    const typedPassword = passwordRef.current?.value || '';
    const useSaved = !typedPassword && hasSavedPassword;

    if (!bossAddr) { setReconnectError(tr('Vui lòng nhập địa chỉ BOSS')); return; }
    if (!username) { setReconnectError(tr('Vui lòng nhập tên đăng nhập')); return; }
    if (!typedPassword && !useSaved) { setReconnectError(tr('Vui lòng nhập mật khẩu')); return; }

    // Only a remote workspace can connect (the old "nhân viên cũ" (old employee) path that connected under any workspace was removed)
    const wsState = useWorkspaceStore.getState();
    const workspaceId = wsState.activeWorkspaceId;
    const activeWs = wsState.activeWorkspace();
    if (!workspaceId || activeWs?.type !== 'remote') {
      setReconnectError(tr('Workspace đang mở không phải workspace nhân viên — vào Cài đặt → Workspace để kết nối tới BOSS.'));
      return;
    }

    setReconnecting(true);
    try {
      const loginRes: any = useSaved
        ? await ipc.workspace?.loginRemoteSaved(workspaceId, bossAddr, username)
        : await RestQueryService.login(bossAddr, username, typedPassword);
      if (!loginRes?.success) {
        // Main has forgotten the saved password (the owner changed the password / it cannot be decrypted) → show the empty input again
        if (loginRes?.savedPasswordCleared) setHasSavedPassword(false);
        setReconnectError(useSaved && isWrongPasswordLogin(loginRes)
          ? tr('Mật khẩu đã lưu không còn đúng — vui lòng nhập mật khẩu mới')
          : (loginRes?.error || tr('Đăng nhập thất bại')));
        setReconnecting(false);
        return;
      }

      // The owner returns {success, token, employee, snapshot}: NO data wrapper
      const token = loginRes.token || loginRes.data?.token;
      const employee = loginRes.employee || loginRes.data?.employee;
      if (!token || !employee) {
        setReconnectError(tr('Phản hồi từ BOSS không hợp lệ'));
        setReconnecting(false);
        return;
      }

      // Save BOTH the new URL and the new token (the token expires after 7 days) into the workspace config in main, then connect
      // via main → main emits employee:credentials → App inits RestQueryService. Do not init REST here.
      const newBossUrl = normalizeBossUrl(bossAddr);
      const employeeInfo = {
        employeeId: employee.employee_id || activeWs.employeeId || '',
        employeeName: employee.display_name || username,
        employeeUsername: username,
      };
      // Employee info only (no URL/token) → does not trigger a reconnect on the main side
      await ipc.workspace?.update(workspaceId, employeeInfo).catch(() => null);
      const connectRes = await ipc.workspace?.connectRemote(workspaceId, newBossUrl, token);
      wsState.setWorkspaces(useWorkspaceStore.getState().workspaces.map((ws) => (
        ws.id === workspaceId ? { ...ws, ...employeeInfo, bossUrl: newBossUrl, token } : ws
      )));
      if (!connectRes?.success) {
        setReconnectError(connectRes?.error || tr('Không kết nối được tới BOSS'));
        setReconnecting(false);
        return;
      }

      const permsMap: Record<string, boolean> = {};
      if (employee.permissions) {
        for (const p of employee.permissions) permsMap[p.module] = p.can_access;
      }

      const empStore = useEmployeeStore.getState();
      empStore.setCurrentEmployee(employee);
      empStore.setPermissions(permsMap);
      empStore.setAssignedAccounts(employee.assigned_accounts || []);
      empStore.setMode('employee');
      // bossUrl/token of the store + badge status emitted by main (employee:credentials / workspace:connectionStatus)

      showNotification(tr('Đã kết nối lại! Xin chào {{display_name}}', { display_name: employee.display_name }), 'success');
      if (typedPassword) {
        // Remember the password in main (encrypted with the OS key) for the next "Kết nối lại" (Reconnect)
        const saved = await ipc.workspace?.rememberPassword(workspaceId, typedPassword).catch(() => null);
        if (saved?.success) setHasSavedPassword(!!saved.saved);
      }
      setReconnectOpen(false);
      setReconnecting(false);
    } catch (err: any) {
      setReconnectError(err.message || tr('Lỗi kết nối'));
      setReconnecting(false);
    }
  }, [hasSavedPassword, showNotification]);

  // ERP notifications + attendance
  const erpPerms = useErpPermissions();
  const erpEid = useCurrentEmployeeId();
  const unreadCount = useErpNotificationStore(s => s.unreadCount);
  const loadUnreadCount = useErpNotificationStore(s => s.loadUnreadCount);
  const loadTodayAttendance = useErpEmployeeStore(s => s.loadTodayAttendance);
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  // In-app message notifications are off for every account → the bell is crossed out (the state is shown on the button itself, no extra icon)
  const inAppNotifyAllOff = useInAppNotifyStore(s => summarizeInAppNotify(s.prefs, accounts.map(a => a.zalo_id)).allOff);
  // Upcoming event (early reminder): the bell rings + "15 phút nữa tới lịch hẹn" (15 minutes until the appointment) right on the bell button, counting down to the time
  const upcomingReminders = useErpReminderAttention(s => s.items);
  const reminderRinging = useErpReminderAttention(s => s.ringing);
  const [reminderClock, setReminderClock] = useState(() => Date.now());
  useEffect(() => {
    if (!upcomingReminders.length) return;
    const tick = () => {
      const now = Date.now();
      setReminderClock(now);
      useErpReminderAttention.getState().prune(now);
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [upcomingReminders.length]);
  const nextReminder = upcomingReminders.find(item => item.startAt > reminderClock) ?? null;
  const reminderLead = nextReminder ? erpReminderLeadText(nextReminder.startAt - reminderClock) : '';
  // The user's own upcoming events (the "Lịch sắp tới" (Upcoming) tab in the bell; reminders still follow each event's times)
  const { calendar: canSeeCalendar } = useQuickErpAccess();
  const reminderMyId = useEmployeeStore(s => (s.mode === 'employee' ? String(s.currentEmployee?.employee_id || '') : 'boss'));
  useUpcomingEvents(canSeeCalendar, reminderMyId);

  useEffect(() => {
    if (!erpPerms.can('erp.access')) return;
    loadUnreadCount(erpEid);
    loadTodayAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erpEid]);

  useEffect(() => {
    if (!ipc.on) return;
    const unsub = ipc.on('erp:event:notification', () => loadUnreadCount(erpEid));
    return () => unsub?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erpEid]);

  // Employee reconnects after losing the connection: notifications / attendance missed while offline → reload the bell + attendance
  // for today (previously it only reloaded while the ERP page was open)
  useEmployeeResync(() => {
    if (!erpPerms.can('erp.access')) return;
    loadUnreadCount(erpEid);
    loadTodayAttendance();
  });

  useEffect(() => {
    if (!bellOpen) return;
    const handler = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [bellOpen]);

  // Close the more dropdown when clicking outside
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moreOpen]);

  // Sync fontTemp when fontSizeScale changes externally
  useEffect(() => {
    setFontTemp(fontSizeScale);
  }, [fontSizeScale]);

  // Update: now using badge next to version + popup (see below)

  useEffect(() => {
    ipc.window?.isMaximized().then(setIsMaximized);
  }, []);

  // Check lock screen status
  useEffect(() => {
    ipc.lockScreen?.status().then(res => {
      if (res?.success && res.enabled) setLockScreenEnabled(true);
    });
    // Listen for lock screen enable/disable from Settings
    const handleChanged = (e: Event) => {
      const enabled = (e as CustomEvent).detail?.enabled ?? false;
      setLockScreenEnabled(enabled);
    };
    window.addEventListener('lockScreen:changed', handleChanged);
    return () => window.removeEventListener('lockScreen:changed', handleChanged);
  }, []);

  // Close the reconnect popup when clicking outside
  useEffect(() => {
    if (!reconnectOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.reconnect-popup') && !target.closest('.employee-badge')) {
        setReconnectOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [reconnectOpen]);

  // Telegram topbar sync is intentionally background work. Refresh the
  // currently visible DB state once the main process signals completion, while
  // never blocking the topbar button for a long channel/history pass.
  useEffect(() => {
    if (!ipc.on) return;
    return ipc.on('event:telegramSync', (data: any) => {
      if (!data?.zaloId || data.zaloId !== activeAccountId) return;
      if (data.status === 'failed') {
        showNotification(data.error || tr('Không thể đồng bộ tin nhắn Telegram'), 'error');
        return;
      }
      // Show progress while channels are being recovered in background
      if (data.status === 'syncing' && data.pending > 0) {
        showNotification(
          tr('Đang tải nền {{pending}} channel...', { pending: data.pending }),
          'info',
        );
        return;
      }
      if (data.status !== 'completed') return;

      void (async () => {
        const conversationsRes = await DataAccessor.getConversations(data.zaloId, 500, 0);
        // Read error (the owner connection is flaky) → keep the current list, do not clear it
        const contacts = isReadFailure(conversationsRes) ? null : (conversationsRes?.items ?? []);
        if (contacts) useChatStore.getState().setContacts(data.zaloId, contacts);

        const chatState = useChatStore.getState();
        const threadId = chatState.activeThreadId;
        const topicId = chatState.activeTopicId;
        if (threadId) {
          const messagesRes = await DataAccessor.getMessages({
            zaloId: data.zaloId,
            threadId,
            topicId: topicId || undefined,
            limit: topicId ? 50 : 20,
            offset: 0,
          });
          const dbMessages = messagesRes?.messages ?? messagesRes?.items ?? [];
          const latestState = useChatStore.getState();
          if (
            !isReadFailure(messagesRes) &&
            useAccountStore.getState().activeAccountId === data.zaloId &&
            latestState.activeThreadId === threadId &&
            latestState.activeTopicId === topicId
          ) {
            latestState.setMessages(data.zaloId, threadId, [...dbMessages].reverse(), topicId);
          }
        }

        const insertedText = data.inserted ? tr(', thêm {{inserted}} tin nhắn', { inserted: data.inserted }) : '';
        const pendingText = data.pending ? tr('. Phần còn lại đang tiếp tục tải nền') : '';
        showNotification(contacts
          ? tr('Đã đồng bộ {{count}} hội thoại{{insertedText}}{{pendingText}}', { count: contacts.length, insertedText, pendingText })
          : tr('Đã đồng bộ xong{{insertedText}}{{pendingText}}, nhưng chưa tải lại được danh sách — sẽ tự thử lại khi kết nối ổn định', { insertedText, pendingText }),
          contacts ? 'success' : 'warning');
      })().catch(() => {
        showNotification(tr('Đã tải dữ liệu Telegram, nhưng không thể làm mới giao diện.'), 'warning');
      });
    });
  }, [activeAccountId, showNotification]);

  // ── Re-sync Telegram conversations ─────────────────────────────────────────
  // Zalo: the sync-messages-from-phone button; Facebook: FacebookSyncButton (popup to pick an account + time range).
  const activeAccountChannel = accounts.find(a => a.zalo_id === activeAccountId)?.channel;
  const canResync = isTelegram(activeAccountChannel);

  const handleResync = useCallback(async () => {
    if (!activeAccountId || resyncing) return;

    // Detect channel of active account
    const activeAccount = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    if (!isTelegram(activeAccount?.channel)) return;

    setResyncing(true);
    try {
      if (isTelegramUser(activeAccount?.channel)) {
        // Acknowledge immediately. Full account history runs in the main
        // process and completion refreshes the visible state via telegramSync.
        const syncRes = await ipc.telegramUser?.refreshMessages({ accountId: activeAccountId });
        if (!syncRes?.success) {
          showNotification(syncRes?.error || tr('Không thể đồng bộ tin nhắn Telegram'), 'error');
          return;
        }
        showNotification(
          tr('Đang tải tin nhắn Telegram ở nền. Hội thoại sẽ tự cập nhật.'),
          'info',
        );
      } else if (isTelegramBot(activeAccount?.channel)) {
        // Bot API only exposes queued getUpdates; it cannot request arbitrary
        // chat history like a Telegram User/MTProto account can.
        showNotification(
          tr('Bot Telegram sẽ tự nhận các update còn trong hàng đợi. Telegram không hỗ trợ tải lại lịch sử tùy ý cho Bot.'),
          'info',
        );
      }
    } catch (e: any) {
      showNotification(tr('Lỗi: {{v1}}', { v1: (e.message || tr('Không thể tải')) }), 'error');
    } finally {
      setResyncing(false);
    }
  }, [activeAccountId, resyncing, showNotification]);

  return (
    <>
      <style>{`
        @keyframes reconnectShake {
          0%, 100% { transform: translate(0, 0) rotate(0deg); }
          10%      { transform: translate(-1.5px, 0.8px) rotate(-0.8deg); }
          20%      { transform: translate(1.2px, -0.5px) rotate(0.6deg); }
          30%      { transform: translate(-0.8px, -1px) rotate(-0.4deg); }
          40%      { transform: translate(1.5px, 0.5px) rotate(0.7deg); }
          50%      { transform: translate(-1px, 1.2px) rotate(-0.5deg); }
          60%      { transform: translate(0.5px, -0.8px) rotate(0.3deg); }
          70%      { transform: translate(-1.2px, -0.3px) rotate(-0.6deg); }
          80%      { transform: translate(0.8px, 1px) rotate(0.4deg); }
          90%      { transform: translate(-0.5px, -1.2px) rotate(-0.3deg); }
        }
      `}</style>
    <div
      className="flex items-center justify-between h-9 bg-card border-b border-border flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center gap-2 px-3" style={{ WebkitAppRegion: 'no-drag', paddingLeft: isMac ? 72 : 12 } as any}>
        <span className="text-blue-400 font-bold text-sm">Deplao</span>
        <span className="text-muted-foreground text-xs">v{APP_VERSION}</span>
        {updateInfo && (updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'downloaded') && (
          <button onClick={openUpdatePopup}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold transition-colors ${
              updateStatus === 'downloaded'
                ? 'bg-green-500/15 border border-green-500/30 text-green-500 hover:bg-green-500/25'
                : updateStatus === 'downloading'
                ? 'bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/25'
                : 'bg-orange-500/15 border border-orange-500/30 text-orange-600 hover:bg-orange-500/25'
            }`}
            title={updateStatus === 'downloaded'
              ? tr('Đã tải xong v{{version}} — nhấn để cài đặt', { version: updateInfo.version })
              : updateStatus === 'downloading'
              ? tr('Đang tải v{{version}}...', { version: updateInfo.version })
              : tr('Có bản mới v{{version}} - nhấn để cập nhật', { version: updateInfo.version })}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v13M5 12l7 7 7-7"/><line x1="3" y1="22" x2="21" y2="22"/></svg>
            {updateStatus === 'downloaded' ? tr('Sẵn sàng v{{version}}', { version: updateInfo.version }) : tr('New v{{version}}', { version: updateInfo.version })}
          </button>
        )}

        {/* Workspace switcher - only shows when multiple workspaces exist */}
        <WorkspaceSwitcher />

        {/* Employee mode indicator + reconnect popup */}
        {empMode === 'employee' && currentEmployee && (
          <div className="relative flex items-center gap-2">
            {/* Status badge (not clickable): main heartbeat + REST, see connectionBadge */}
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-card border border-input select-none"
              title={connectionBadge === 'recovering'
                ? tr('Vẫn kết nối tới BOSS nhưng tải dữ liệu đang bị gián đoạn — tự khôi phục')
                : connectionBadge === 'expired'
                ? tr('BOSS từ chối phiên đăng nhập (token hết hạn) — bấm "Kết nối lại" để đăng nhập')
                : undefined}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                connectionBadge === 'online' ? 'bg-green-400'
                  : connectionBadge === 'recovering' ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-400 animate-pulse'
              }`} />
              <span className={`text-[11px] ${
                connectionBadge === 'recovering' ? 'text-amber-500'
                  : connectionBadge === 'expired' ? 'text-red-400'
                  : 'text-foreground/80'
              }`}>
                {connectionBadge === 'online' ? (latency > 0 ? tr('Online - {{latency}}ms', { latency }) : tr('Online'))
                  : connectionBadge === 'recovering' ? tr('Đang khôi phục…')
                  : connectionBadge === 'expired' ? AUTH_EXPIRED_MESSAGE
                  : tr('Offline')}
              </span>
              <span className="text-[11px] text-foreground/80">- {currentEmployee.display_name}</span>
            </div>

            {/* Disconnect button - while the heartbeat is still connected (Online / Restoring) */}
            {bossLinked && (
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/80 text-muted-foreground text-[11px] font-medium transition-all duration-200 hover:bg-red-600/30 hover:text-red-300 hover:border-red-500/30 border border-input/50 disabled:opacity-50"
                title={tr('Ngắt kết nối khỏi BOSS')}
              >
                {disconnecting ? (
                  <span className="w-3 h-3 border-2 border-border-strong border-t-gray-300 rounded-full animate-spin" />
                ) : (
                  <>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
                      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                      <line x1="12" y1="20" x2="12.01" y2="20" />
                    </svg>
                    <span>{tr('Ngắt kết nối')}</span>
                  </>
                )}
              </button>
            )}

            {/* Separate Reconnect button - when Offline / session expired (log in again) */}
            {!bossLinked && (
              <button
                onClick={() => setReconnectOpen(v => !v)}
                title={deadAddress ? tr('Địa chỉ BOSS có thể đã đổi — bấm để nhập địa chỉ mới') : undefined}
                className="employee-badge reconnect-btn relative flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-700/90 text-white text-[11px] font-semibold transition-all duration-300 hover:bg-green-700 hover:shadow-green-400/50 overflow-hidden border border-green-500/40"
                style={{ animation: 'reconnectShake 0.6s ease-in-out infinite' }}
              >
                <span className="relative z-10 flex items-center gap-1.5 text-white-important">
                  <span className="drop-shadow-[0_0_4px_rgba(34,197,94,0.6)]"><PluginIcon className="w-4 h-4" /></span>
                  <span className="drop-shadow-[0_0_6px_rgba(34,197,94,0.4)]">{tr('Kết nối lại')}</span>
                  {deadAddress && <span className="w-1.5 h-1.5 rounded-full bg-warning" aria-label={tr('Địa chỉ BOSS có thể đã đổi')} />}
                </span>
              </button>
            )}

            {/* Reconnect popup */}
            {reconnectOpen && (
              <div className={`reconnect-popup absolute left-0 top-full mt-2 ${deadAddress || announcedHint ? 'w-80' : 'w-72'} bg-card border border-input rounded-xl shadow-2xl z-[9999] p-4`}>
                <p className="text-xs text-muted-foreground font-medium mb-2">{trx('<0/> Kết nối lại với BOSS', { 0: <PluginIcon className="w-4 h-4 inline" /> })}</p>

                {/* The owner's temporary address is dead / the owner just reported a new address → paste the new address, keep the login session */}
                {(deadAddress || announcedHint) && (
                  <div className="mb-3 space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5">
                    {deadAddress && (
                      <>
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          {trx('<0/> Địa chỉ BOSS có thể đã đổi', { 0: <AlertIcon className="w-3.5 h-3.5 text-warning flex-shrink-0" /> })}
                        </p>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {trx('Không kết nối được tới <0>{{host}}</0> — {{reason}}. Địa chỉ tạm ({{providerLabel}}) đổi mỗi khi máy BOSS khởi động lại.', { 0: <span className="font-mono text-foreground break-all" />, host: deadAddress.host, reason: deadAddress.reason, providerLabel: deadAddress.providerLabel })}
                        </p>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {tr('Hỏi BOSS địa chỉ mới (Cài đặt → Nhân viên → Kết nối) rồi dán vào đây:')}
                        </p>
                      </>
                    )}
                    {announcedHint && (
                      <div className="space-y-1">
                        <p className="text-[11px] text-muted-foreground">{tr('BOSS vừa báo địa chỉ mới:')}</p>
                        <div className="flex items-center gap-1.5">
                          <code className="flex-1 min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground" title={announcedHint}>{announcedHint}</code>
                          <button
                            type="button"
                            onClick={() => { void handleUseNewAddress(announcedHint); }}
                            disabled={switchingAddr}
                            className="flex-shrink-0 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                          >
                            {tr('Dùng')}
                          </button>
                        </div>
                      </div>
                    )}
                    {deadAddress && (
                      <>
                        <input
                          ref={newAddrRef}
                          placeholder="https://….trycloudflare.com"
                          onKeyDown={e => { if (e.key === 'Enter') void handleUseNewAddress(); }}
                          className="w-full px-2.5 py-1.5 bg-muted border border-input rounded-lg text-xs text-foreground placeholder-subtle-foreground"
                        />
                        <button
                          type="button"
                          onClick={() => { void handleUseNewAddress(); }}
                          disabled={switchingAddr}
                          className="w-full py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium transition-colors hover:bg-primary-hover disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          {switchingAddr ? (
                            <>
                              <span className="w-3 h-3 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                              {tr('Đang kiểm tra địa chỉ…')}
                            </>
                          ) : tr('Kết nối địa chỉ mới')}
                        </button>
                        <p className="text-[10px] text-subtle-foreground">{tr('Không cần nhập lại mật khẩu — vẫn dùng phiên đăng nhập hiện tại.')}</p>
                      </>
                    )}
                    {switchAddrError && (
                      <p className="text-[11px] text-destructive">{switchAddrError}</p>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <input
                    ref={bossUrlRef}
                    defaultValue={bossUrl}
                    placeholder={tr('Địa chỉ BOSS (IP:Port hoặc Tunnel URL)')}
                    className="w-full px-2.5 py-1.5 bg-muted border border-input rounded-lg text-xs text-foreground placeholder-subtle-foreground"
                  />
                  <input
                    ref={usernameRef}
                    defaultValue={currentEmployee?.username || ''}
                    placeholder={tr('Tên đăng nhập')}
                    className="w-full px-2.5 py-1.5 bg-muted border border-input rounded-lg text-xs text-foreground placeholder-subtle-foreground"
                  />
                  {/* A saved password exists (in main): leave empty = use the saved password; type a new password = log in + save it again */}
                  <input
                    ref={passwordRef}
                    type="password"
                    placeholder={hasSavedPassword ? '••••••••' : tr('Mật khẩu')}
                    onKeyDown={e => e.key === 'Enter' && handleReconnect()}
                    className="w-full px-2.5 py-1.5 bg-muted border border-input rounded-lg text-xs text-foreground placeholder-subtle-foreground"
                  />
                  {hasSavedPassword && (
                    <p className="text-[10px] text-muted-foreground text-right">{trx('<0/> Đã lưu mật khẩu', { 0: <KeyIcon className="w-4 h-4 inline" /> })}</p>
                  )}
                  {reconnectError && (
                    <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1">
                      <AlertIcon className="w-3 h-3 inline text-red-400" /> {reconnectError}
                    </p>
                  )}
                  <button
                    onClick={handleReconnect}
                    disabled={reconnecting}
                    className="w-full py-2 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {reconnecting ? (
                      <>
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        {tr('Đang kết nối...')}
                      </>
                    ) : tr('🔌 Kết nối lại')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Boss preview mode indicator */}
        {empMode !== 'employee' && previewEmployee && (
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-amber-900/40 border border-amber-600/40">
            <span className="text-[11px] text-amber-300">{trx('👁 Đang xem: {{display_name}}', { display_name: previewEmployee.display_name })}</span>
          </div>
        )}
      </div>

      {/* Window controls */}
      <div
        className="flex items-center"
        style={{ WebkitAppRegion: 'no-drag' } as any}
      >
        {/* Re-sync Facebook / Telegram conversations - hidden for employees (Zalo uses the phone button next to it) */}
        {activeAccountId && empMode !== 'employee' && canResync && (
          <button
            onClick={handleResync}
            disabled={resyncing}
            className={`w-9 h-9 flex items-center justify-center transition-colors ${resyncing ? 'text-blue-400 bg-muted' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            title={tr('Đồng bộ hội thoại và tin nhắn Telegram')}
          >
            {resyncing ? (
              <Spinner size={3} />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            )}
          </button>
        )}

        {/* Sync messages from phone (Zalo) - hidden for employees */}
        {empMode !== 'employee' && <FacebookSyncButton />}
        {empMode !== 'employee' && <MobileSyncButton />}

        {/* Global feature launcher */}
        <button
          onClick={() => setFeaturePanelOpen(value => !value)}
          className={`w-9 h-9 flex items-center justify-center transition-colors ${featurePanelOpen ? 'text-blue-400 bg-muted' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          title={tr('Tất cả tính năng')}
          aria-label={tr('Tất cả tính năng')}
          aria-expanded={featurePanelOpen}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </button>

        {/* Update: now handled by badge next to version + UpdateNotification popup */}

        {/*/!* ── ERP Attendance quick check-in ── *!/*/}
        {/*{erpPerms.can('attendance.checkin') && (*/}
        {/*  <button*/}
        {/*    onClick={async () => {*/}
        {/*      if (!todayAttendance?.check_in_at) await checkIn();*/}
        {/*      else if (!todayAttendance?.check_out_at) await checkOut();*/}
        {/*      else showNotification('Đã chấm công đầy đủ hôm nay', 'success');*/}
        {/*    }}*/}
        {/*    className={`w-9 h-9 flex items-center justify-center transition-colors ${*/}
        {/*      todayAttendance?.check_out_at ? 'text-green-500' :*/}
        {/*      todayAttendance?.check_in_at ? 'text-blue-400 hover:bg-muted' :*/}
        {/*      'text-muted-foreground hover:bg-muted hover:text-foreground'*/}
        {/*    }`}*/}
        {/*    title={*/}
        {/*      todayAttendance?.check_out_at ? 'Đã check-out hôm nay' :*/}
        {/*      todayAttendance?.check_in_at ? 'Check-out' : 'Check-in'*/}
        {/*    }*/}
        {/*  >*/}
        {/*    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">*/}
        {/*      <circle cx="12" cy="12" r="9" />*/}
        {/*      <polyline points="12 7 12 12 15 14" />*/}
        {/*    </svg>*/}
        {/*  </button>*/}
        {/*)}*/}

        {/* ── Notification bell: updates, ERP (if permitted), ⚙ in-app message notification settings ── */}
        <div className="relative" ref={bellRef}>
          <button
            onClick={() => { setBellOpen(v => !v); useErpReminderAttention.getState().acknowledge(); }}
            className={`h-9 flex items-center justify-center transition-colors relative ${nextReminder
              ? `gap-2.5 px-2.5 text-amber-500 hover:bg-amber-500/10 ${bellOpen ? 'bg-amber-500/10' : ''}`
              : `w-9 hover:bg-muted hover:text-foreground ${bellOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}`}
            title={nextReminder
              ? `${reminderLead}: ${nextReminder.title}`
              : inAppNotifyAllOff ? tr('Thông báo (thông báo tin nhắn trong app đang tắt)') : tr('Thông báo')}
            aria-label={nextReminder ? tr('Thông báo: {{reminderLead}}', { reminderLead }) : tr('Thông báo')}
            aria-expanded={bellOpen}
          >
            <span className="relative inline-flex">
              <span className={`inline-flex ${nextReminder && reminderRinging ? 'erp-bell-ring' : ''}`}>
                {inAppNotifyAllOff && !nextReminder ? (
                  <BellOffIcon className="w-3.5 h-3.5" />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                )}
              </span>
              {erpPerms.can('erp.access') && unreadCount > 0 && (
                <span className="absolute -top-[7px] -right-[7px] min-w-[14px] h-3.5 px-1 bg-red-500 text-white text-[9px] rounded-full flex items-center justify-center">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </span>
            {nextReminder && <span className="max-w-[190px] truncate text-[11px] font-semibold">{reminderLead}</span>}
          </button>
          {bellOpen && (
            <div className="absolute right-0 top-full mt-1 z-[9999]">
              <NotificationCenter onClose={() => setBellOpen(false)} initialTab={nextReminder ? 'upcoming' : 'inbox'} />
            </div>
          )}
        </div>

        {/* Theme toggle */}
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title={theme === 'dark' ? tr('Chuyển sang giao diện sáng') : tr('Chuyển sang giao diện tối')}
        >
          {theme === 'dark' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/>
              <line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>

        {/* Lock screen button - only visible when lock screen is enabled */}
        {lockScreenEnabled && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('lockScreen:lock'))}
            className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-amber-400 transition-colors"
            title={tr('Khoá ứng dụng (Ctrl+Shift+L)')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </button>
        )}

        {/* GitHub Star button */}
        <button
          onClick={() => ipc.shell?.openExternal(SUPPORT_GITHUB_URL)}
          className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-yellow-400 transition-colors relative group/gh"
          title={tr('Star Deplao trên GitHub\nDự án mã nguồn mở - Ủng hộ team bằng cách ghé thăm và thả sao nhé!')}
        >
          <span className="relative">
            {/* GitHub icon */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
            </svg>
            {/* Golden star overlay */}
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="#facc15"
              className="absolute -top-1.5 -right-2 drop-shadow-sm"
            >
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </span>
        </button>

        {/* ── More dropdown (guide + bug report + font size) ── */}
        <div className="relative" ref={moreRef}>
          <button
            onClick={() => setMoreOpen(v => !v)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors relative"
            title={tr('Thêm (cỡ chữ, ngôn ngữ, hướng dẫn, báo lỗi)')}
          >
            {hasNewAffiliate && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse z-10" />
            )}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1.5"/>
              <circle cx="5" cy="12" r="1.5"/>
              <circle cx="19" cy="12" r="1.5"/>
            </svg>
          </button>

          {moreOpen && (
            <div className="absolute right-0 top-full mt-1 w-64 bg-card border border-input rounded-xl shadow-2xl z-[9999] overflow-hidden">
              {/* Font size slider */}
              <div className="px-4 py-3 border-b border-border">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground font-medium">{tr('Cỡ chữ')}</span>
                  <span className="text-xs text-foreground font-semibold min-w-[2.5rem] text-right">
                    {scaleToPx(fontTemp)}px
                  </span>
                </div>
                <input
                  type="range"
                  min={FONT_SCALE_MIN}
                  max={FONT_SCALE_MAX}
                  step={FONT_SCALE_STEP}
                  value={fontTemp}
                  onChange={(e) => setFontTemp(Number(e.target.value))}
                  onMouseUp={() => setFontSizeScale(fontTemp)}
                  onTouchEnd={() => setFontSizeScale(fontTemp)}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer
                    bg-accent accent-blue-500
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500
                    [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-border
                    [&::-webkit-slider-thumb]:shadow-md"
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-muted-foreground">12px</span>
                  <span className="text-[10px] text-muted-foreground">24px</span>
                </div>
              </div>

              {/* UI language (display settings, next to the font size); picking one reloads the window */}
              <LanguagePicker variant="menu" heading onPicked={() => setMoreOpen(false)} />

              {/* User guide */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'overview' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground/80 hover:bg-muted hover:text-blue-400 transition-colors text-left"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">{tr('Hướng dẫn sử dụng')}</p>
                  <p className="text-[10px] text-muted-foreground">{tr('Tính năng & thao tác cơ bản')}</p>
                </div>
              </button>

              {/* Report a bug */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'bugreport' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground/80 hover:bg-muted hover:text-red-400 transition-colors text-left border-t border-border/50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>
                  <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z"/>
                  <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17H2M18 13h4M17.47 9c1.93-.2 3.53-1.9 3.53-4M18 17h4"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">{tr('Báo lỗi')}</p>
                  <p className="text-[10px] text-muted-foreground">{tr('Gửi phản hồi & báo cáo lỗi')}</p>
                </div>
              </button>

              {/* Support */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  ipc.shell?.openExternal('https://fb.com/deplaoapp');
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground/80 hover:bg-muted hover:text-blue-400 transition-colors text-left"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">{tr('Hỗ trợ')}</p>
                  <p className="text-[10px] text-muted-foreground">{tr('Liên hệ Facebook khi gặp vấn đề')}</p>
                </div>
              </button>

              {/* Donate Coffee */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'donate' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground/80 hover:bg-muted hover:text-amber-400 transition-colors text-left border-t border-border/50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M18 8h1a4 4 0 0 1 0 8h-1"/>
                  <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
                  <line x1="6" y1="1" x2="6" y2="4"/>
                  <line x1="10" y1="1" x2="10" y2="4"/>
                  <line x1="14" y1="1" x2="14" y2="4"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">{tr('Donate Coffee')}</p>
                  <p className="text-[10px] text-muted-foreground">{tr('Các bạn thấy hữu ích có thể ủng hộ dự án nhé!')}</p>
                </div>
              </button>
            </div>
          )}
        </div>

        {!isMac && (
          <>
            <button
              onClick={() => ipc.window?.minimize()}
              className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title={tr('Thu nhỏ')}
            >
              <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
                <rect width="10" height="1" />
              </svg>
            </button>
            <button
              onClick={() => {
                ipc.window?.maximize();
                setIsMaximized(!isMaximized);
              }}
              className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title={isMaximized ? tr('Phục hồi') : tr('Phóng to')}
            >
              {isMaximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="2" y="0" width="8" height="8" />
                  <rect x="0" y="2" width="8" height="8" fill="none" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="0" y="0" width="10" height="10" />
                </svg>
              )}
            </button>
            <button
              onClick={() => ipc.window?.close()}
              className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white transition-colors"
              title={tr('Đóng')}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                <line x1="0" y1="0" x2="10" y2="10" />
                <line x1="10" y1="0" x2="0" y2="10" />
              </svg>
            </button>
          </>
        )}
      </div>
      {featurePanelOpen && <FeatureLauncherPanel onClose={() => setFeaturePanelOpen(false)} />}
    </div>
    </>
  );
}
