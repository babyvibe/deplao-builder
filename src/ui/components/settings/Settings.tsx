import React, { useState, useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { playNotificationSound, requestNotificationPermission, showDesktopNotification } from '@/utils/NotificationService';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/utils/apiError';
import IntroductionSettings from './IntroductionSettings';
import ChangelogSettings from './ChangelogSettings';
import ConversationSettings from './ConversationSettings';
import EmployeeSettings from './EmployeeSettings';
import WorkspaceSettings from './WorkspaceSettings';
import { loadSeenTabs, markTabSeen, SETTINGS_WATCHLIST } from '@/utils/settingsSeenTabs';

type SettingsTab = 'notifications' | 'accounts' | 'storage' | 'conversation' | 'employees' | 'workspace' | 'introduction' | 'changelog' | 'appearance';

export default function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('conversation');
  const [seenTabs, setSeenTabs] = useState<Set<string>>(() => loadSeenTabs());
  const [storagePath, setStoragePath] = useState<string>('');
  const [defaultStoragePath, setDefaultStoragePath] = useState<string>('');
  const [actualDbPath, setActualDbPath] = useState<string>('');
  const [changingStorage, setChangingStorage] = useState(false);
  // Pending folder with existing data — shown in choice modal
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  // Live progress khi đang copy media
  const [copyProgress, setCopyProgress] = useState<number>(0);
  const [copyTotal, setCopyTotal] = useState<number>(0);
  const { accounts, removeAccount } = useAccountStore();
  const { showNotification, notifSettings, setNotifSettings, theme, setTheme } = useAppStore();

  useEffect(() => {
    ipc.db?.getStoragePath().then((res: any) => {
      if (res?.success) {
        setStoragePath(res.path || '');
        setDefaultStoragePath(res.defaultPath || '');
        setActualDbPath(res.actualDbPath || '');
      }
    });
  }, []);

  // Lắng nghe sự kiện điều hướng từ các màn hình khác (ví dụ: link điều khoản trong modal đăng nhập)
  useEffect(() => {
    const handler = (e: Event) => {
      const { tab } = (e as CustomEvent).detail || {};
      if (tab) setActiveTab(tab as SettingsTab);
    };
    window.addEventListener('nav:settings', handler);
    return () => window.removeEventListener('nav:settings', handler);
  }, []);

  // Đánh dấu tab đã xem khi người dùng mở lần đầu
  useEffect(() => {
    if ((SETTINGS_WATCHLIST as readonly string[]).includes(activeTab)) {
      markTabSeen(activeTab);
      setSeenTabs(loadSeenTabs());
    }
  }, [activeTab]);

  const handleRemoveAccount = async (zaloId: string) => {
    const ok = await showConfirm({
      title: 'Xóa tài khoản này?',
      message: 'Tài khoản sẽ bị xóa khỏi ứng dụng. Bạn cần đăng nhập lại để thêm lại.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await ipc.login?.removeAccount(zaloId);
    if (res?.success) {
      removeAccount(zaloId);
      showNotification('Đã xóa tài khoản', 'success');
    } else {
      showNotification(extractApiError(res, 'Xóa tài khoản thất bại'), 'error');
    }
  };


  const handleChangeStorageFolder = async () => {
    setChangingStorage(true);
    try {
      const folderRes = await ipc.db?.selectStorageFolder();
      if (!folderRes?.success || folderRes.canceled) return;
      const newFolder = folderRes.folder;
      if (!newFolder) return;

      // Thư mục đích đã có dữ liệu cũ → hỏi người dùng muốn làm gì
      if (folderRes.hasExistingData) {
        setPendingFolder(newFolder);
        return; // modal sẽ gọi applyStorageChange
      }

      // Thư mục trống → xác nhận sao chép bình thường
      const ok = await showConfirm({
        title: 'Thay đổi thư mục lưu trữ?',
        message: `Thư mục mới:\n${newFolder}\n\nDữ liệu hiện tại sẽ được sao chép sang thư mục mới tự động.`,
        confirmText: 'Tiếp tục',
        variant: 'warning',
      });
      if (!ok) return;
      await applyStorageChange(newFolder, false);
    } catch (err: any) {
      showNotification(extractApiError(err, 'Lỗi đổi thư mục'), 'error');
    } finally {
      setChangingStorage(false);
    }
  };

  /** Áp dụng đổi thư mục — useExisting=true: chỉ đổi con trỏ, không copy */
  const applyStorageChange = async (newFolder: string, useExisting: boolean) => {
    setChangingStorage(true);
    setCopyProgress(0);
    setCopyTotal(0);

    // Lắng nghe progress event từ main process
    const unsub = ipc.on?.('db:copyProgress', (data: { copied: number; total?: number; done?: boolean }) => {
      setCopyProgress(data.copied);
      if (data.total) setCopyTotal(data.total);
    });

    try {
      const res = await ipc.db?.setStoragePath({ newFolder, useExisting });
      if (res?.success) {
        setStoragePath(newFolder);
        setActualDbPath(res.newPath || '');
        const msg = res.message || 'Đã đổi thư mục lưu trữ thành công!';
        const extra = res.mediaError ? ` (⚠️ Media: ${res.mediaError})` : '';
        showNotification(msg + extra, res.mediaError ? 'warning' : 'success');
      } else {
        showNotification(extractApiError(res, 'Không thể đổi thư mục'), 'error');
      }
    } catch (err: any) {
      showNotification(extractApiError(err, 'Lỗi đổi thư mục'), 'error');
    } finally {
      unsub?.();
      setChangingStorage(false);
      setCopyProgress(0);
      setCopyTotal(0);
      setPendingFolder(null);
    }
  };

  const handleResetStoragePath = async () => {
    const ok = await showConfirm({
      title: 'Đặt lại thư mục mặc định?',
      message: 'Dữ liệu sẽ được sao chép về thư mục mặc định và áp dụng ngay.',
      confirmText: 'Đặt lại',
      variant: 'warning',
    });
    if (!ok) return;
    await applyStorageChange(defaultStoragePath, false);
  };

  const NAV_ITEMS: { id: SettingsTab; icon: string; label: string; requiredPerm?: string }[] = [
    { id: 'conversation',  icon: '💬', label: 'Hội thoại' },
    { id: 'appearance',    icon: '🎨', label: 'Giao diện' },
    { id: 'notifications', icon: '🔔', label: 'Thông báo' },
    { id: 'accounts',      icon: '👤', label: 'Tài khoản', requiredPerm: 'settings_accounts' },
    { id: 'employees',     icon: '👥', label: 'Nhân viên', requiredPerm: 'settings_employees' },
    { id: 'workspace',     icon: '🗂️', label: 'Workspace' },
    { id: 'storage',       icon: '📁', label: 'Lưu trữ' },
    { id: 'introduction',  icon: '📖', label: 'Giới thiệu' },
    { id: 'changelog',     icon: '🗒️', label: 'Log phiên bản' },
  ];

  // Filter nav items by permission — employee/simulation mode may hide certain tabs
  const { mode: empMode, permissions: empPermissions } = useEmployeeStore();
  const hasSettingsPerm = (perm?: string) => {
    if (!perm) return true; // no permission required
    return useEmployeeStore.getState().hasPermission(perm);
  };
  const visibleNavItems = NAV_ITEMS.filter(item => hasSettingsPerm(item.requiredPerm));

  // Guard: nếu activeTab không còn trong visibleNavItems (do đổi workspace/quyền) → reset về tab đầu tiên
  useEffect(() => {
    const isVisible = visibleNavItems.some(item => item.id === activeTab);
    if (!isVisible && visibleNavItems.length > 0) {
      setActiveTab(visibleNavItems[0].id);
    }
  }, [empMode, empPermissions]);

  return (
    <>
    <div className="flex h-full overflow-hidden">
      {/* ─── Left sidebar ─── */}
      <div className="w-44 flex-shrink-0 border-r border-gray-700 bg-gray-850 flex flex-col py-3 gap-0.5 overflow-y-auto">
        <p className="px-4 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Cài đặt</p>
        {visibleNavItems.map((item, idx) => (
          <React.Fragment key={item.id}>
            <button onClick={() => setActiveTab(item.id)}
              className={`flex items-center gap-2.5 w-full px-4 py-2.5 text-sm rounded-none transition-colors text-left ${
                activeTab === item.id
                  ? 'bg-blue-600/20 text-blue-400 border-r-2 border-blue-500'
                  : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}>
              <span className="text-base leading-none">{item.icon}</span>
              <span className="font-medium">{item.label}</span>
              {/* Chấm đỏ "mới" — chỉ hiện khi tab chưa được xem lần nào */}
              {(SETTINGS_WATCHLIST as readonly string[]).includes(item.id) && !seenTabs.has(item.id) && (
                <span className="ml-auto w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
              )}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* ─── Right content ─── */}
      <div className="flex-1 overflow-y-auto pb-6 p-2 space-y-5">

        {/* ── Appearance ── */}
        {activeTab === 'appearance' && (
          <>
            <h2 className="text-base font-semibold text-white">🎨 Giao diện</h2>
            <Section>
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-gray-200 font-medium mb-3">Chủ đề màu sắc</p>
                  <div className="flex gap-3">
                    {/* Dark theme option */}
                    <button
                      onClick={() => setTheme('dark')}
                      className={`flex-1 flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                        theme === 'dark'
                          ? 'border-blue-500 bg-blue-600/10'
                          : 'border-gray-600 hover:border-gray-500'
                      }`}
                    >
                      <div className="w-full h-14 rounded-lg bg-gray-900 border border-gray-700 flex items-end p-1.5 gap-1 overflow-hidden">
                        <div className="w-6 h-10 rounded bg-gray-800 flex-shrink-0" />
                        <div className="flex-1 flex flex-col gap-1">
                          <div className="h-3 rounded bg-gray-700 w-3/4" />
                          <div className="h-2 rounded bg-blue-600 w-1/2 self-end" />
                          <div className="h-2 rounded bg-gray-700 w-2/3" />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {theme === 'dark' && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-blue-400">
                            <path d="M20 6L9 17l-5-5" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                        <span className={`text-xs font-medium ${theme === 'dark' ? 'text-blue-400' : 'text-gray-400'}`}>🌙 Tối</span>
                      </div>
                    </button>

                    {/* Light theme option */}
                    <button
                      onClick={() => setTheme('light')}
                      className={`flex-1 flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                        theme === 'light'
                          ? 'border-blue-500 bg-blue-600/10'
                          : 'border-gray-600 hover:border-gray-500'
                      }`}
                    >
                      <div className="w-full h-14 rounded-lg border border-stone-200 flex items-end p-1.5 gap-1 overflow-hidden" style={{ backgroundColor: '#f7f6f3' }}>
                        <div className="w-6 h-10 rounded flex-shrink-0" style={{ backgroundColor: '#e8e4de' }} />
                        <div className="flex-1 flex flex-col gap-1">
                          <div className="h-3 rounded w-3/4" style={{ backgroundColor: '#e3dfd8' }} />
                          <div className="h-2 rounded bg-blue-500 w-1/2 self-end" />
                          <div className="h-2 rounded w-2/3" style={{ backgroundColor: '#e3dfd8' }} />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {theme === 'light' && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-blue-400">
                            <path d="M20 6L9 17l-5-5" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                        <span className={`text-xs font-medium ${theme === 'light' ? 'text-blue-400' : 'text-gray-400'}`}>☀️ Sáng</span>
                      </div>
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Thay đổi giao diện áp dụng ngay lập tức và được lưu tự động.
                </p>
              </div>
            </Section>
          </>
        )}

        {/* ── Notifications ── */}
        {activeTab === 'notifications' && (
          <>
            <h2 className="text-base font-semibold text-white">🔔 Cài đặt thông báo</h2>
            <Section>
              <div className="space-y-4">
                <ToggleRow
                  title="Thông báo màn hình"
                  desc="Hiện popup ở góc màn hình khi có tin nhắn mới"
                  value={notifSettings.desktopEnabled}
                  onChange={(v) => {
                    if (v) requestNotificationPermission().then(granted => {
                      if (!granted) { showNotification('Trình duyệt đã chặn thông báo. Vui lòng cấp quyền trong cài đặt.', 'warning'); return; }
                      setNotifSettings({ desktopEnabled: true });
                    });
                    else setNotifSettings({ desktopEnabled: false });
                  }}
                />
                <ToggleRow
                  title="Âm thanh thông báo"
                  desc="Phát tiếng khi nhận tin nhắn mới"
                  value={notifSettings.soundEnabled}
                  onChange={(v) => setNotifSettings({ soundEnabled: v })}
                />
                {notifSettings.soundEnabled && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-400">Âm lượng</p>
                      <span className="text-xs text-gray-400">{Math.round(notifSettings.volume * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="100" step="5"
                      value={Math.round(notifSettings.volume * 100)}
                      onChange={e => setNotifSettings({ volume: parseInt(e.target.value) / 100 })}
                      className="w-full accent-blue-500" />
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { if (notifSettings.soundEnabled) playNotificationSound(notifSettings.volume); else showNotification('Hãy bật âm thanh trước', 'info'); }}
                    className="flex-1 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors">
                    🔊 Test âm thanh
                  </button>
                  <button onClick={() => {
                    requestNotificationPermission().then(granted => {
                      if (!granted) { showNotification('Cần cấp quyền thông báo', 'warning'); return; }
                      showDesktopNotification('Deplao', 'Đây là thông báo thử nghiệm 🎉');
                    });
                  }} className="flex-1 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors">
                    🖥 Test popup
                  </button>
                </div>
                <p className="text-xs text-gray-500 leading-relaxed">
                  * Thông báo không hiện với những hội thoại đã tắt thông báo.<br />
                  * <strong>Windows:</strong> Kiểm tra quyền trong Settings &gt; Notifications.<br />
                  * <strong>macOS:</strong> Kiểm tra trong System Settings &gt; Notifications &gt; Deplao.<br />
                  * Khi tắt notification ở cấp hệ điều hành, âm thanh cũng sẽ bị tắt theo.
                </p>
              </div>
            </Section>
          </>
        )}

        {/* ── Accounts ── */}
        {activeTab === 'accounts' && (() => {
          return (
            <>
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold text-white">👤 Tài khoản đã đăng nhập</h2>
              </div>
              <Section>
                <div className="space-y-2">
                  {accounts.map((acc) => {
                    return (
                      <div key={acc.zalo_id} className="flex items-center gap-3 p-2.5 bg-gray-700 rounded-xl">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-400' : 'bg-gray-500'}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-200 truncate font-medium">{acc.full_name || acc.zalo_id}</p>
                          <p className="text-xs text-gray-500">{acc.zalo_id}</p>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-900/50 text-green-400' : 'bg-gray-600 text-gray-400'}`}>
                          {acc.isOnline ? 'Online' : 'Offline'}
                        </span>
                        <button onClick={() => handleRemoveAccount(acc.zalo_id)} className="text-red-400 hover:text-red-300 text-xs flex-shrink-0 ml-1">
                          Xóa
                        </button>
                      </div>
                    );
                  })}
                  {accounts.length === 0 && <p className="text-gray-500 text-sm">Chưa có tài khoản nào</p>}
                </div>
              </Section>
            </>
          );
        })()}

        {/* ── Storage ── */}
        {activeTab === 'storage' && (
          <>
            <h2 className="text-base font-semibold text-white">📁 Thư mục lưu trữ dữ liệu</h2>

            {/* ── Khuyến nghị đổi ổ lưu trữ ── */}
            <div className="bg-amber-900/20 border border-amber-500/40 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">⚠️</span>
                <p className="text-sm font-semibold text-amber-300">Khuyến nghị: Đổi sang ổ khác (không dùng ổ C:)</p>
              </div>
              <ul className="space-y-1.5 pl-1">
                {[
                  { icon: '💾', text: 'Ổ C: thường là ổ hệ thống, dung lượng trống ít — tin nhắn, ảnh, video sẽ tích lũy nhanh theo thời gian.' },
                  { icon: '🔄', text: 'Khi cài lại Windows, toàn bộ dữ liệu trên ổ C: bị xóa. Lưu ở ổ D:, E:... giúp bảo toàn lịch sử chat qua mọi lần cài lại.' },
                  { icon: '⚡', text: 'Trên máy SSD đa ổ, tách DB sang ổ phụ giảm áp lực I/O cho ổ hệ thống, app chạy mượt hơn.' },
                  { icon: '📦', text: 'Dễ backup: chỉ cần copy một thư mục sang ổ ngoài / cloud là có toàn bộ dữ liệu.' },
                  { icon: '🔒', text: 'Tránh bị antivirus/Windows Update can thiệp nhầm vào dữ liệu app khi quét ổ C:.' },
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-amber-300/80">
                    <span className="flex-shrink-0 mt-0.5">{item.icon}</span>
                    <span className="leading-relaxed">{item.text}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-amber-400 font-medium pt-1">
                👉 Nhấn <strong>"Chọn thư mục khác"</strong> bên dưới để chuyển sang ổ D:, E:, hoặc ổ ngoài. Dữ liệu sẽ được sao chép tự động.
              </p>
            </div>
            <Section>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Thư mục cấu hình:</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-gray-700 text-green-300 px-2 py-1.5 rounded truncate block">{storagePath || 'Đang tải...'}</code>
                    <button onClick={() => ipc.file?.openPath(storagePath)} className="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0" title="Mở thư mục">📂</button>
                  </div>
                </div>
                {actualDbPath && (
                  <div>
                    <p className="text-xs text-gray-400 mb-1">File DB đang dùng:</p>
                    <code className="w-full text-xs bg-gray-700 text-yellow-300 px-2 py-1.5 rounded truncate block">{actualDbPath}</code>
                  </div>
                )}
                {/* Cảnh báo nếu DB thực tế khác với config (thường xảy ra sau khi cài lại) */}
                {actualDbPath && storagePath && !actualDbPath.startsWith(storagePath) && (
                  <div className="bg-red-900/40 border border-red-500/50 rounded-lg p-3">
                    <p className="text-xs text-red-300 font-semibold mb-1">⚠️ Phát hiện không khớp thư mục!</p>
                    <p className="text-xs text-red-200 leading-relaxed">
                      DB đang đọc từ vị trí khác với cấu hình. Điều này thường xảy ra khi nâng cấp Electron làm thay đổi <code>userData</code> path.<br/>
                      Nhấn <strong>Chọn thư mục khác</strong> và trỏ lại đúng thư mục để khôi phục dữ liệu.
                    </p>
                  </div>
                )}
                <p className="text-xs text-gray-500">
                  Dữ liệu tin nhắn, liên hệ và cài đặt được lưu trong thư mục này.
                  Khi thay đổi, dữ liệu được sao chép sang vị trí mới và áp dụng ngay (không cần khởi động lại).
                </p>
                <div className="flex gap-2">
                  <button onClick={handleChangeStorageFolder} disabled={changingStorage}
                    className="btn-primary text-white text-sm flex-1 disabled:opacity-50">
                    {changingStorage
                      ? copyProgress > 0
                        ? `📁 ${copyProgress.toLocaleString()}${copyTotal > 0 ? ` / ${copyTotal.toLocaleString()}` : ''} files…`
                        : 'Đang xử lý...'
                      : '📂 Chọn thư mục khác'}
                  </button>
                  {storagePath && storagePath !== defaultStoragePath && (
                    <button onClick={handleResetStoragePath} className="btn-secondary text-sm">Đặt lại mặc định</button>
                  )}
                </div>
              </div>
            </Section>
          </>
        )}

        {/* ── Conversation ── */}
        {activeTab === 'conversation' && <ConversationSettings />}

        {/* ── Employees ── */}
        {activeTab === 'employees' && <EmployeeSettings />}
        {activeTab === 'workspace' && <WorkspaceSettings />}

        {/* ── Introduction ── */}
        {activeTab === 'introduction' && <IntroductionSettings />}

        {/* ── Changelog ── */}
        {activeTab === 'changelog' && <ChangelogSettings />}

      </div>
    </div>

    {/* ── Modal chọn hành động khi thư mục đích có dữ liệu cũ ── */}
    {pendingFolder && (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
        onClick={() => !changingStorage && setPendingFolder(null)}>
        <div className="bg-gray-800 border border-gray-600 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
          onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="px-5 pt-5 pb-3 border-b border-gray-700">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-2xl">📂</span>
              <h3 className="text-base font-semibold text-white">Thư mục đã có dữ liệu</h3>
            </div>
            <p className="text-xs text-gray-400 break-all leading-relaxed mt-1">
              <span className="font-mono text-green-300">{pendingFolder}</span>
            </p>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              Thư mục này đã có file dữ liệu (<code className="text-yellow-300">deplao-tool.db</code>).
              Bạn muốn làm gì?
            </p>
          </div>

          {/* Options */}
          <div className="p-4 space-y-3">
            {/* Option A: Use existing data */}
            <button
              disabled={changingStorage}
              onClick={() => applyStorageChange(pendingFolder, true)}
              className="w-full flex items-start gap-3 p-3.5 rounded-xl border-2 border-blue-500 bg-blue-500/10 hover:bg-blue-500/20 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-xl flex-shrink-0 mt-0.5">🗄️</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-blue-300">Dùng dữ liệu cũ tại đây</p>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                  Chuyển sang DB có sẵn trong thư mục này. Dữ liệu hiện tại giữ nguyên ở vị trí cũ, không bị xóa.
                </p>
              </div>
            </button>

            {/* Option B: Copy current data */}
            <button
              disabled={changingStorage}
              onClick={async () => {
                const ok = await showConfirm({
                  title: 'Ghi đè dữ liệu cũ?',
                  message: `Dữ liệu hiện tại sẽ được sao chép vào:\n${pendingFolder}\n\nFile deplao-tool.db cũ tại đó sẽ bị GHI ĐÈ. Thao tác không thể hoàn tác.`,
                  confirmText: 'Ghi đè',
                  variant: 'danger',
                });
                if (!ok) return;
                await applyStorageChange(pendingFolder, false);
              }}
              className="w-full flex items-start gap-3 p-3.5 rounded-xl border border-gray-600 hover:bg-gray-700 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-xl flex-shrink-0 mt-0.5">📋</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-200">Sao chép dữ liệu hiện tại vào đây</p>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                  Sao chép DB + toàn bộ ảnh, video, file đính kèm sang thư mục mới.{' '}
                  <span className="text-red-400">Dữ liệu cũ tại đây sẽ bị ghi đè.</span>
                </p>
              </div>
            </button>
          </div>

          {/* Footer */}
          <div className="px-4 pb-4">
            {/* Progress khi đang copy media */}
            {changingStorage && (
              <div className="mb-3 bg-gray-700/60 rounded-xl px-3 py-3">
                {copyProgress > 0 ? (
                  <>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                        <span className="text-xs text-blue-300 font-medium">Đang sao chép media...</span>
                      </div>
                      <span className="text-xs text-gray-300 font-mono tabular-nums">
                        {copyProgress.toLocaleString()}
                        {copyTotal > 0 && <span className="text-gray-500"> / {copyTotal.toLocaleString()}</span>}
                      </span>
                    </div>
                    {/* Progress bar */}
                    <div className="w-full h-1.5 bg-gray-600 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-200"
                        style={{ width: copyTotal > 0 ? `${Math.min(100, (copyProgress / copyTotal) * 100).toFixed(1)}%` : '100%' }}
                      />
                    </div>
                    {copyTotal > 0 && (
                      <p className="text-[11px] text-gray-500 mt-1">
                        {((copyProgress / copyTotal) * 100).toFixed(0)}% — vui lòng không đóng ứng dụng
                      </p>
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    <span className="text-xs text-gray-400">Đang chuẩn bị...</span>
                  </div>
                )}
              </div>
            )}
            <button
              disabled={changingStorage}
              onClick={() => setPendingFolder(null)}
              className="w-full py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-xl transition-colors disabled:opacity-50"
            >
              {changingStorage ? (
                copyProgress > 0
                  ? `${copyProgress.toLocaleString()}${copyTotal > 0 ? ` / ${copyTotal.toLocaleString()}` : ''} files copied…`
                  : 'Đang xử lý...'
              ) : 'Hủy'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4">
      {children}
    </div>
  );
}

function ToggleRow({ title, desc, value, onChange }: { title: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <p className="text-sm text-gray-200 font-medium">{title}</p>
        {desc && <p className="text-xs text-gray-500 mt-0.5">{desc}</p>}
      </div>
      <Toggle value={value} onChange={onChange} />
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${value ? 'bg-blue-600' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 left-0 w-5 h-5 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}
