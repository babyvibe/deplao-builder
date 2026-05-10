import React, { useState, useEffect, useCallback, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useUpdateStore } from '@/store/updateStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useChatStore } from '@/store/chatStore';
import WorkspaceSwitcher from '@/components/common/WorkspaceSwitcher';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useCurrentEmployeeId, useErpPermissions } from '@/hooks/erp/useErpContext';
import NotificationCenter from '@/features/erp/notifications/NotificationCenter';

const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';

export default function TopBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const { theme, setTheme, showNotification } = useAppStore();
  const { activeAccountId } = useAccountStore();
  const [loadingOldMsgs, setLoadingOldMsgs] = useState(false);

  // Update state
  const { status: updateStatus, updateInfo, platform, setDismissed } = useUpdateStore();
  const isMac = platform === 'darwin';
  const [macDropdownOpen, setMacDropdownOpen] = useState(false);
  const macDropdownRef = useRef<HTMLDivElement>(null);

  // Employee store
  const { mode: empMode, currentEmployee, bossConnected, previewEmployeeId, employees } = useEmployeeStore();
  const previewEmployee = previewEmployeeId ? employees.find((e: any) => e.employee_id === previewEmployeeId) : null;

  // ERP notifications + attendance
  const erpPerms = useErpPermissions();
  const erpEid = useCurrentEmployeeId();
  const { unreadCount, loadUnreadCount } = useErpNotificationStore();
  const { todayAttendance, loadTodayAttendance, checkIn, checkOut } = useErpEmployeeStore();
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

  // Hiện nút update khi: có bản mới + (chưa tải xong HOẶC lỗi/treo)
  const showUpdateBtn = !!updateInfo && ['available', 'error', 'stalled', 'downloading'].includes(updateStatus);

  useEffect(() => {
    ipc.window?.isMaximized().then(setIsMaximized);
  }, []);

  // Đóng macOS dropdown khi click ra ngoài
  useEffect(() => {
    if (!macDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (macDropdownRef.current && !macDropdownRef.current.contains(e.target as Node)) {
        setMacDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [macDropdownOpen]);

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

  // Xử lý click nút update
  const handleUpdateClick = useCallback(() => {
    if (isMac) {
      // macOS: mở dropdown chọn bản tải
      setMacDropdownOpen(prev => !prev);
    } else {
      // Windows: trigger auto-update download + hiện popup
      setDismissed(false);
      if (updateStatus === 'error' || updateStatus === 'stalled') {
        (window as any).electronAPI?.update?.download();
      }
    }
  }, [isMac, setDismissed, updateStatus]);

  return (
    <div
      className="flex items-center justify-between h-9 bg-gray-900 border-b border-gray-700 flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center gap-2 px-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <span className="text-blue-400 font-bold text-sm">Deplao</span>
        <span className="text-gray-500 text-xs">v{APP_VERSION}</span>

        {/* Workspace switcher — only shows when multiple workspaces exist */}
        <WorkspaceSwitcher />

        {/* Employee mode indicator */}
        {empMode === 'employee' && currentEmployee && (
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-gray-800 border border-gray-600">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${bossConnected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
            <span className="text-[11px] text-gray-300">{bossConnected ? 'Connected' : 'Disconnected'}</span>
            <span className="text-[11px] text-gray-300">- {currentEmployee.display_name}</span>
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
        {/* Tải tin nhắn cũ (toàn phiên đăng nhập) — ẩn với nhân viên */}
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
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            )}
          </button>
        )}

        {/* ── Nút cập nhật ── */}
        {showUpdateBtn && (
          <div className="relative" ref={macDropdownRef}>
            <button
              onClick={handleUpdateClick}
              className="w-9 h-9 flex items-center justify-center text-orange-400 hover:bg-orange-500/20 hover:text-orange-300 transition-colors relative"
              title={`Cập nhật v${updateInfo!.version} ${isMac ? '— Chọn bản tải' : '— Nhấn để cập nhật'}`}
            >
              {/* Arrow-down-circle icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v13M5 12l7 7 7-7"/>
                <line x1="3" y1="22" x2="21" y2="22"/>
              </svg>
              {/* Chấm đỏ nhỏ */}
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            </button>

            {/* macOS dropdown: chọn bản tải */}
            {isMac && macDropdownOpen && updateInfo && (
              <div className="absolute right-0 top-full mt-1 w-56 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-[9999] overflow-hidden">
                <div className="px-3 py-2 border-b border-gray-700">
                  <p className="text-xs text-gray-400">Cập nhật v{updateInfo.version}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Chọn bản phù hợp với máy Mac của bạn</p>
                </div>
                <a
                  href={`https://deplaoapp.com/file/Deplao-${updateInfo.version}-arm64.dmg`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMacDropdownOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-200 hover:bg-blue-600/20 hover:text-white transition-colors no-underline"
                >
                  <span className="text-base">🍎</span>
                  <div>
                    <p className="text-xs font-semibold">Apple Silicon</p>
                    <p className="text-[10px] text-gray-500">MacBook Chip M</p>
                  </div>
                </a>
                <a
                  href={`https://deplaoapp.com/file/Deplao-${updateInfo.version}.dmg`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMacDropdownOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-200 hover:bg-blue-600/20 hover:text-white transition-colors no-underline"
                >
                  <span className="text-base">💻</span>
                  <div>
                    <p className="text-xs font-semibold">Intel Mac</p>
                    <p className="text-[10px] text-gray-500">MacBook Chip Intel</p>
                  </div>
                </a>
                {/* Thử cập nhật tự động */}
                <button
                  onClick={() => {
                    setMacDropdownOpen(false);
                    setDismissed(false);
                    (window as any).electronAPI?.update?.download();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors border-t border-gray-700"
                >
                  <span className="text-base">🔄</span>
                  <p className="text-xs">Thử cập nhật tự động</p>
                </button>
              </div>
            )}
          </div>
        )}

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
  );
}

