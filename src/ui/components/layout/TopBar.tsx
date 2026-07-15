import React, { useState, useEffect, useCallback, useRef } from 'react';
import ipc from '@/lib/ipc';

const SUPPORT_GITHUB_URL = 'https://github.com/babyvibe/deplao-builder';
import { useAppStore, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useUpdateStore } from '@/store/updateStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useChatStore } from '@/store/chatStore';
import WorkspaceSwitcher from '@/components/common/WorkspaceSwitcher';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useCurrentEmployeeId, useErpPermissions } from '@/hooks/erp/useErpContext';
import NotificationCenter from '@/features/erp/notifications/NotificationCenter';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, KeyIcon, MonitorIcon, PluginIcon, RefreshIcon, StarIcon } from '@/components/common/icons';


const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';

/** Map scale factor to px value for display */
const scaleToPx = (s: number) => Math.round(16 * s);

export default function TopBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const { theme, setTheme, showNotification, fontSizeScale, setFontSizeScale } = useAppStore();
  const { activeAccountId } = useAccountStore();
  const [loadingOldMsgs, setLoadingOldMsgs] = useState(false);
  const [lockScreenEnabled, setLockScreenEnabled] = useState(false);

  // More dropdown (guide + bug report + font size)
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // Font size slider: local temp value, only applies on release
  const [fontTemp, setFontTemp] = useState(fontSizeScale);

  // Update state
  const { status: updateStatus, updateInfo, platform, setShowPopup, openUpdatePopup } = useUpdateStore();
  const isMac = platform === 'darwin';

  // Employee store
  const { mode: empMode, currentEmployee, bossConnected, bossUrl, latency, previewEmployeeId, employees, setBossConnected, setToken } = useEmployeeStore();
  const previewEmployee = previewEmployeeId ? employees.find((e: any) => e.employee_id === previewEmployeeId) : null;

  // Reconnect popup state
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState('');
  const [savedPassword, setSavedPassword] = useState('');
  const bossUrlRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Load saved password từ localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('deplao_employee_password');
      if (raw) setSavedPassword(atob(raw));
    } catch { /* ignore */ }
  }, []);

  // Save password khi kết nối thành công
  const savePassword = useCallback((password: string) => {
    try {
      localStorage.setItem('deplao_employee_password', btoa(password));
      setSavedPassword(password);
    } catch { /* ignore */ }
  }, []);

  // ── Ngắt kết nối khỏi BOSS ──────────────────────────────────────────────
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      // Reset REST client — stop health check, clear token
      const RestQueryService = (await import('../../../services/http/RestQueryService')).default;
      RestQueryService.getInstance().reset();

      // Chỉ set disconnected, KHÔNG reset currentEmployee/mode
      // => giữ nguyên badge + nút kết nối lại trên UI
      setBossConnected(false);
      setToken('');

      showNotification('Đã ngắt kết nối khỏi BOSS', 'success');
    } catch (err: any) {
      showNotification(err.message || 'Lỗi ngắt kết nối', 'error');
    } finally {
      setDisconnecting(false);
    }
  }, [disconnecting, showNotification, setBossConnected, setToken]);

  const handleReconnect = useCallback(async () => {
    setReconnectError('');
    const bossAddr = bossUrlRef.current?.value.trim();
    const username = usernameRef.current?.value.trim();
    const password = passwordRef.current?.value || savedPassword;

    if (!bossAddr) { setReconnectError('Vui lòng nhập địa chỉ BOSS'); return; }
    if (!username) { setReconnectError('Vui lòng nhập tên đăng nhập'); return; }
    if (!password) { setReconnectError('Vui lòng nhập mật khẩu'); return; }

    setReconnecting(true);
    try {
      const RestQueryService = (await import('../../../services/http/RestQueryService')).default;

      const loginRes = await RestQueryService.login(bossAddr, username, password);
      if (!loginRes.success) {
        setReconnectError(loginRes.error || 'Đăng nhập thất bại');
        setReconnecting(false);
        return;
      }

      // Boss trả về {success, token, employee, snapshot} — KHÔNG có data wrapper
      const token = (loginRes as any).token || loginRes.data?.token;
      const employee = (loginRes as any).employee || loginRes.data?.employee;
      if (!token || !employee) {
        setReconnectError('Phản hồi từ BOSS không hợp lệ');
        setReconnecting(false);
        return;
      }

      RestQueryService.getInstance().init(bossAddr, token);
      // Theo dõi trạng thái kết nối RestQueryService → cập nhật header real-time
      RestQueryService.getInstance().setOnStatusChange((connected, latency) => {
        useEmployeeStore.getState().setBossConnected(connected);
        if (latency > 0) useEmployeeStore.getState().setLatency(latency);
      });
      await ipc.employee?.setMode('employee');
      await ipc.employee?.connectToBoss(bossAddr, token);

      const permsMap: Record<string, boolean> = {};
      if (employee.permissions) {
        for (const p of employee.permissions) permsMap[p.module] = p.can_access;
      }

      useEmployeeStore.getState().setCurrentEmployee(employee);
      useEmployeeStore.getState().setPermissions(permsMap);
      useEmployeeStore.getState().setAssignedAccounts(employee.assigned_accounts || []);
      useEmployeeStore.getState().setBossUrl(bossAddr);
      // Persist bossUrl to workspace cache — không bị cached URL cũ ghi đè
      ipc.workspace?.update?.(useWorkspaceStore.getState().activeWorkspaceId, { bossUrl: bossAddr } as any).catch(() => {});
      useEmployeeStore.getState().setBossConnected(true);
      useEmployeeStore.getState().setToken(token);
      useEmployeeStore.getState().setMode('employee');

      showNotification(`Đã kết nối lại! Xin chào ${employee.display_name}`, 'success');
      savePassword(password);
      setReconnectOpen(false);
      setReconnecting(false);
    } catch (err: any) {
      setReconnectError(err.message || 'Lỗi kết nối');
      setReconnecting(false);
    }
  }, [showNotification]);

  // ERP notifications + attendance
  const erpPerms = useErpPermissions();
  const erpEid = useCurrentEmployeeId();
  const { unreadCount, loadUnreadCount } = useErpNotificationStore();
  const { loadTodayAttendance } = useErpEmployeeStore();
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!bellOpen) return;
    const handler = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [bellOpen]);

  // Đóng more dropdown khi click ra ngoài
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

  // Đóng reconnect popup khi click ra ngoài
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

  // ── Tải tin nhắn cũ / đồng bộ lại hội thoại ────────────────────────────────
  const handleRequestOldMessages = useCallback(async () => {
    if (!activeAccountId || loadingOldMsgs) return;

    // Detect channel of active account
    const activeAccount = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    const channel = activeAccount?.channel || 'zalo';

    setLoadingOldMsgs(true);
    try {
      if (channel === 'facebook') {
        // Facebook: force-refresh threads + reload contacts into store
        showNotification('Đang đồng bộ hội thoại Facebook...', 'success');
        const res = await ipc.fb?.getThreads({ accountId: activeAccountId, forceRefresh: true });
        if (res?.success) {
          const count = res.threads?.length ?? 0;
          // Reload contacts from DB into chat store
          try {
            const contactsRes = await ipc.db?.getContacts(activeAccountId);
            const contacts = contactsRes?.contacts ?? contactsRes ?? [];
            if (contacts.length > 0) {
              useChatStore.getState().setContacts(activeAccountId, contacts);
            }
          } catch {}
          // Refresh avatar cho active thread nếu là 1-1 Facebook
          const chatState = useChatStore.getState();
          const activeThreadId = chatState.activeThreadId;
          const activeThreadType = chatState.activeThreadType;
          if (activeThreadId && activeThreadType !== 1 && /^\d+$/.test(activeThreadId)) {
            ipc.fb.refreshContactAvatar({ accountId: activeAccountId, userId: activeThreadId })
              .then(refreshRes => {
                if (refreshRes.success && refreshRes.avatarUrl) {
                  useChatStore.getState().updateContact(activeAccountId, {
                    contact_id: activeThreadId,
                    avatar_url: refreshRes.avatarUrl,
                  });
                }
              }).catch(() => {});
          }
          showNotification(`Đã đồng bộ ${count} hội thoại Facebook`, 'success');
        } else {
          showNotification(res?.error || 'Không thể đồng bộ hội thoại Facebook', 'error');
        }
      } else {
        // Zalo: request old messages as before
        const res = await ipc.login?.requestOldMessages(activeAccountId);
        if (res?.success) {
          showNotification('Đang tải tin nhắn cũ… Tin nhắn sẽ xuất hiện dần.', 'success');
        } else {
          showNotification(res?.error || 'Không thể tải tin nhắn cũ', 'error');
        }
      }
    } catch (e: any) {
      showNotification('Lỗi: ' + (e.message || 'Không thể tải'), 'error');
    } finally {
      setLoadingOldMsgs(false);
    }
  }, [activeAccountId, loadingOldMsgs, showNotification]);

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
      className="flex items-center justify-between h-9 bg-gray-900 border-b border-gray-700 flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center gap-2 px-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <span className="text-blue-400 font-bold text-sm">Deplao</span>
        <span className="text-gray-400 text-xs">v{APP_VERSION}</span>
        {updateInfo && updateStatus === 'available' && (
          <button onClick={openUpdatePopup}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/15 border border-orange-500/30 text-orange-600 text-[10px] font-semibold hover:bg-orange-500/25 transition-colors"
            title={`Có bản mới v${updateInfo.version} - nhấn để cập nhật`}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v13M5 12l7 7 7-7"/><line x1="3" y1="22" x2="21" y2="22"/></svg>
            New v{updateInfo.version}
          </button>
        )}

        {/* Workspace switcher - only shows when multiple workspaces exist */}
        <WorkspaceSwitcher />

        {/* Employee mode indicator + reconnect popup */}
        {empMode === 'employee' && currentEmployee && (
          <div className="relative flex items-center gap-2">
            {/* Status badge (không click được) */}
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-800 border border-gray-600 select-none">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${bossConnected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
              <span className="text-[11px] text-gray-300">{bossConnected ? (latency > 0 ? `Online - ${latency}ms` : 'Online') : 'Offline'}</span>
              <span className="text-[11px] text-gray-300">- {currentEmployee.display_name}</span>
            </div>

            {/* Nút Ngắt kết nối — chỉ hiện khi đang connected */}
            {bossConnected && (
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-700/80 text-gray-400 text-[11px] font-medium transition-all duration-200 hover:bg-red-600/30 hover:text-red-300 hover:border-red-500/30 border border-gray-600/50 disabled:opacity-50"
                title="Ngắt kết nối khỏi BOSS"
              >
                {disconnecting ? (
                  <span className="w-3 h-3 border-2 border-gray-500 border-t-gray-300 rounded-full animate-spin" />
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
                    <span>Ngắt kết nối</span>
                  </>
                )}
              </button>
            )}

            {/* Nút Kết nối lại riêng biệt — chỉ hiện khi disconnected */}
            {!bossConnected && (
              <button
                onClick={() => setReconnectOpen(v => !v)}
                className="employee-badge reconnect-btn relative flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-700/90 text-white text-[11px] font-semibold transition-all duration-300 hover:bg-green-700 hover:shadow-green-400/50 overflow-hidden border border-green-500/40"
                style={{ animation: 'reconnectShake 0.6s ease-in-out infinite' }}
              >
                <span className="relative z-10 flex items-center gap-1.5 text-white-important">
                  <span className="drop-shadow-[0_0_4px_rgba(34,197,94,0.6)]"><PluginIcon className="w-4 h-4" /></span>
                  <span className="drop-shadow-[0_0_6px_rgba(34,197,94,0.4)]">Kết nối lại</span>
                </span>
              </button>
            )}

            {/* Reconnect popup */}
            {reconnectOpen && (
              <div className="reconnect-popup absolute left-0 top-full mt-2 w-72 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-[9999] p-4">
                <p className="text-xs text-gray-400 font-medium mb-2"><PluginIcon className="w-4 h-4 inline" /> Kết nối lại với BOSS</p>
                <div className="space-y-2">
                  <input
                    ref={bossUrlRef}
                    defaultValue={bossUrl}
                    placeholder="Địa chỉ BOSS (IP:Port hoặc Tunnel URL)"
                    className="w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-gray-200 placeholder-gray-500"
                  />
                  <input
                    ref={usernameRef}
                    defaultValue={currentEmployee?.username || ''}
                    placeholder="Tên đăng nhập"
                    className="w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-gray-200 placeholder-gray-500"
                  />
                  <input
                    ref={passwordRef}
                    type="password"
                    placeholder={savedPassword ? '••••••••' : 'Mật khẩu'}
                    defaultValue={savedPassword || ''}
                    onKeyDown={e => e.key === 'Enter' && handleReconnect()}
                    className="w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-gray-200 placeholder-gray-500"
                  />
                  {savedPassword && (
                    <p className="text-[10px] text-gray-400 text-right"><KeyIcon className="w-4 h-4 inline" /> Đã lưu mật khẩu</p>
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
                        Đang kết nối...
                      </>
                    ) : '🔌 Kết nối lại'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Boss preview mode indicator */}
        {empMode !== 'employee' && previewEmployee && (
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-amber-900/40 border border-amber-600/40">
            <span className="text-[11px] text-amber-300">👁 Đang xem: {previewEmployee.display_name}</span>
          </div>
        )}
      </div>

      {/* Window controls */}
      <div
        className="flex items-center"
        style={{ WebkitAppRegion: 'no-drag' } as any}
      >
        {/* Tải tin nhắn cũ (toàn phiên đăng nhập) - ẩn với nhân viên */}
        {activeAccountId && empMode !== 'employee' && (
          <button
            onClick={handleRequestOldMessages}
            disabled={loadingOldMsgs}
            className={`w-9 h-9 flex items-center justify-center transition-colors ${loadingOldMsgs ? 'text-blue-400 bg-gray-700' : 'text-gray-400 hover:bg-gray-700 hover:text-white'}`}
            title={(() => {
              const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
              return (acc?.channel || 'zalo') === 'facebook'
                ? 'Đồng bộ lại hội thoại Facebook'
                : 'Tải tin nhắn cũ Zalo (theo phiên đăng nhập)';
            })()}
          >
            {loadingOldMsgs ? (
              <Spinner size={3} />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            )}
          </button>
        )}

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
        {/*      todayAttendance?.check_in_at ? 'text-blue-400 hover:bg-gray-700' :*/}
        {/*      'text-gray-400 hover:bg-gray-700 hover:text-white'*/}
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

        {/* ── ERP Notifications bell ── */}
        {erpPerms.can('erp.access') && (
          <div className="relative" ref={bellRef}>
            <button
              onClick={() => setBellOpen(v => !v)}
              className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition-colors relative"
              title="Thông báo ERP"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[14px] h-3.5 px-1 bg-red-500 text-white text-[9px] rounded-full flex items-center justify-center">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            {bellOpen && (
              <div className="absolute right-0 top-full mt-1 z-[9999]">
                <NotificationCenter onClose={() => setBellOpen(false)} />
              </div>
            )}
          </div>
        )}

        {/* GitHub Star button */}
        <button
          onClick={() => ipc.shell?.openExternal(SUPPORT_GITHUB_URL)}
          className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-yellow-400 transition-colors relative group/gh"
          title={"Star Deplao trên GitHub\nDự án mã nguồn mở - Ủng hộ team bằng cách ghé thăm và thả sao nhé!"}
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



        {/* Lock screen button - only visible when lock screen is enabled */}
        {lockScreenEnabled && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('lockScreen:lock'))}
            className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-amber-400 transition-colors"
            title="Khoá ứng dụng (Ctrl+Shift+L)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </button>
        )}

        {/* Theme toggle */}
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
          title={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
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

        {/* ── More dropdown (guide + bug report + font size) ── */}
        <div className="relative" ref={moreRef}>
          <button
            onClick={() => setMoreOpen(v => !v)}
            className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
            title="Thêm (cỡ chữ, hướng dẫn, báo lỗi)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1.5"/>
              <circle cx="5" cy="12" r="1.5"/>
              <circle cx="19" cy="12" r="1.5"/>
            </svg>
          </button>

          {moreOpen && (
            <div className="absolute right-0 top-full mt-1 w-64 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-[9999] overflow-hidden">
              {/* Font size slider */}
              <div className="px-4 py-3 border-b border-gray-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400 font-medium">Cỡ chữ</span>
                  <span className="text-xs text-gray-200 font-semibold min-w-[2.5rem] text-right">
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
                    bg-gray-600 accent-blue-500
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500
                    [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-gray-800
                    [&::-webkit-slider-thumb]:shadow-md"
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-gray-400">12px</span>
                  <span className="text-[10px] text-gray-400">24px</span>
                </div>
              </div>

              {/* Hướng dẫn sử dụng */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'overview' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-blue-400 transition-colors text-left"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">Hướng dẫn sử dụng</p>
                  <p className="text-[10px] text-gray-400">Tính năng & thao tác cơ bản</p>
                </div>
              </button>

              {/* Báo lỗi */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'bugreport' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-red-400 transition-colors text-left border-t border-gray-700/50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>
                  <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z"/>
                  <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17H2M18 13h4M17.47 9c1.93-.2 3.53-1.9 3.53-4M18 17h4"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">Báo lỗi</p>
                  <p className="text-[10px] text-gray-400">Gửi phản hồi & báo cáo lỗi</p>
                </div>
              </button>

              {/* Donate Coffee */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'donate' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-amber-400 transition-colors text-left border-t border-gray-700/50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M18 8h1a4 4 0 0 1 0 8h-1"/>
                  <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
                  <line x1="6" y1="1" x2="6" y2="4"/>
                  <line x1="10" y1="1" x2="10" y2="4"/>
                  <line x1="14" y1="1" x2="14" y2="4"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">☕ Donate Coffee</p>
                  <p className="text-[10px] text-gray-400">Các bác có thể ủng hộ em mua token AI để fix bug nhé!</p>
                </div>
              </button>
            </div>
          )}
        </div>

        <button
          onClick={() => ipc.window?.minimize()}
          className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
          title="Thu nhỏ"
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
          className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
          title={isMaximized ? 'Phục hồi' : 'Phóng to'}
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
          className="w-9 h-9 flex items-center justify-center text-gray-400 hover:bg-red-600 hover:text-white transition-colors"
          title="Đóng"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <line x1="0" y1="0" x2="10" y2="10" />
            <line x1="10" y1="0" x2="0" y2="10" />
          </svg>
        </button>
      </div>
    </div>
    </>
  );
}

