import React, { useRef, useState, useEffect } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { useWorkspaceStore } from '@/store/app/workspaceStore';
import { useVisibleAccounts } from '@/hooks/accounts/useVisibleAccounts';
import AccountCard from './AccountCard';
import MergedInboxModal from './MergedInboxModal';
import EmployeeLoginModal from './EmployeeLoginModal';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { matchAccountSearch } from '@/lib/accounts/accountSearch';
import PageLoading from '@/components/common/PageLoading';
import { RestoreStateBanner } from '../settings/cloud/restore/RestoreStateBanner';
import { BugIcon, HomeIcon, RefreshIcon, SunIcon, TargetIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';
import LanguagePicker from '@/components/common/i18n/LanguagePicker';

const SUPPORT_GITHUB_URL = 'https://github.com/babyvibe/deplao-builder';

export default function Dashboard() {
  const { updateAccountStatus, reorderAccounts } = useAccountStore();
  const { showNotification, mergedInboxMode, exitMergedInbox } = useAppStore();
  const previewEmployeeId = useEmployeeStore(s => s.previewEmployeeId);
  const empMode = useEmployeeStore(s => s.mode);
  const isSimulating = empMode !== 'employee' && !!previewEmployeeId;
  const accounts = useVisibleAccounts();
  const [search, setSearch] = useState('');
  const [mergedModalOpen, setMergedModalOpen] = useState(false);
  const [employeeLoginOpen, setEmployeeLoginOpen] = useState(false);
  const activeWs = useWorkspaceStore(s => s.activeWorkspace());
  const assignedAccounts = useEmployeeStore(s => s.assignedAccounts);

  const isRemoteWs = activeWs?.type === 'remote' || empMode === 'employee';
  const isEmployeeWorkspace = activeWs?.type === 'remote' && empMode === 'employee';
  // Restore data from cloud storage: Cloudflare R2 or Google Drive (server side; app builds with the Cloudflare module).
  const canRestoreFromCloud = !isRemoteWs && !!(ipc as { cloudflare?: unknown }).cloudflare;
  const openCloudRestore = () => {
    void import('../settings/cloud/restore/RestoreWizard').then(m => { m.openRestoreWizard({ mode: 'new' }); });
  };

  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 300);
    return () => clearTimeout(timer);
  }, []);

  const handleReconnect = async (acc: any) => {
    showNotification(tr('Đang kết nối {{v1}}...', { v1: acc.full_name || acc.zalo_id }), 'info');
    try {
      const auth = buildZaloAuth(acc);
      // In employee/remote mode, proxy the reconnect to the Boss
      const res = isRemoteWs
        ? await ipc.employee?.proxyAction('login:connect', { ...auth, zaloId: acc.zalo_id })
        : await ipc.login?.connectAccount(auth);
      if (res?.success) {
        updateAccountStatus(acc.zalo_id, true, true);
        showNotification(tr('Kết nối thành công!'), 'success');
      } else {
        showNotification(res?.error || tr('Kết nối thất bại'), 'error');
      }
    } catch (err: any) {
      showNotification(err.message, 'error');
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from !== null && from !== toIndex) {
      reorderAccounts(from, toIndex);
    }
    dragIndexRef.current = null;
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  };

  // Name (without diacritics), UID, phone number. Previously the search box with text did not filter: the phone number was compared with an empty string, which always matched.
  const q = search.trim();
  const filtered = q ? accounts.filter((a) => matchAccountSearch(a, q)) : accounts;
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <PageLoading text={tr('Đang tải dashboard...')} />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
        {/* First run: pick the UI language before anything else (flags + native names, readable without Vietnamese) */}
        <LanguagePicker variant="chips" className="mb-4" />
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="opacity-20">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
          <circle cx="9" cy="7" r="4" />
        </svg>
        {isSimulating ? (
          <>
            <p className="text-lg font-medium">{tr('Nhân viên này chưa được gán tài khoản')}</p>
            <p className="text-sm">{tr('Quay lại Cài đặt → Quản lý nhân viên để gán tài khoản Zalo cho nhân viên.')}</p>
            <button
              onClick={() => useEmployeeStore.getState().setPreviewEmployeeId(null)}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors"
            >
              {tr('Thoát giả lập')}
            </button>
          </>
        ) : activeWs?.type === 'remote' || empMode === 'employee' ? (
          <>
            <p className="text-lg font-medium text-foreground/80">{tr('Chưa có trang nào được quản lý')}</p>
            <p className="text-sm text-muted-foreground">{tr('Liên hệ BOSS để được gán tài khoản Zalo vào workspace này.')}</p>
            <div className="flex items-center gap-3 mt-2">
            </div>
          </>
        ) : (
          <>
            <p className="text-lg font-medium">{tr('Chưa có tài khoản nào')}</p>
            <p className="text-sm">{tr('Nhấn nút + để thêm tài khoản Zalo hoặc đăng nhập nhân viên')}</p>
            <div className="flex items-center gap-3">
              <button onClick={() => useAppStore.getState().setAddAccountModalOpen(true)} className="btn-primary text-white-important">
                {tr('+ Thêm tài khoản')}
              </button>
            </div>
            {canRestoreFromCloud && (
              <p className="text-xs text-muted-foreground">
                {tr('Chuyển từ máy khác? ')}
                <button type="button" onClick={openCloudRestore} className="text-primary hover:underline underline-offset-2">
                  {tr('Khôi phục dữ liệu từ đám mây')}
                </button>
              </p>
            )}
          </>
        )}
        <button
            onClick={() => setEmployeeLoginOpen(true)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-muted hover:bg-accent text-foreground border border-input transition-colors"
        >{trx('<0/> Đăng nhập dành cho nhân viên', { 0: <UserIcon className="w-4 h-4 inline" /> })}
        </button>
        <button
          onClick={() => ipc.shell?.openExternal(SUPPORT_GITHUB_URL)}
          className="flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 transition-colors mt-2"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
          </svg>
          {tr('Cần hỗ trợ, báo lỗi? Liên hệ Github')}
        </button>
        {employeeLoginOpen && <EmployeeLoginModal onClose={() => setEmployeeLoginOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Just restored from Cloudflare: automations are paused (nothing shown in normal operation) */}
      {!isRemoteWs && <RestoreStateBanner className="mb-4" />}
      {/* Header + search */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h2 className="text-lg font-semibold text-foreground">{tr('Dashboard')}</h2>
        <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
          {trx('{{count}} tài khoản', { count: accounts.length })}
        </span>
        {isSimulating && (() => {
          const simEmp = useEmployeeStore.getState().getPreviewEmployee();
          return simEmp ? (
            <span className="text-xs text-amber-300 bg-amber-900/30 border border-amber-700/40 px-2.5 py-0.5 rounded-full flex items-center gap-1.5">{trx('<0/> Giả lập: {{display_name}}', { 0: <RefreshIcon className="w-4 h-4 inline" />, display_name: simEmp.display_name })}
            </span>
          ) : null;
        })()}

        <div className="ml-auto flex items-center gap-2 flex-wrap">

          {/* Add account - always visible */}
          <button
            onClick={() => useAppStore.getState().setAddAccountModalOpen(true)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
              <line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
            </svg>
            {tr('Thêm tài khoản')}
          </button>

          {/* Merge accounts button - available for both owner and employee (uses visible/assigned accounts) */}
          {accounts.length > 1 && (
            mergedInboxMode ? (
              <div className="relative group">
                <button
                    onClick={() => { exitMergedInbox(); }}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
                  </svg>
                  {tr('Đang Gộp tài khoản')}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
                <div className="absolute top-full right-0 mt-2 w-64 bg-card border border-input/60 rounded-xl shadow-2xl p-3 z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none">
                  <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">{trx('<0/> Chế độ gộp đang bật', { 0: <TargetIcon className="w-4 h-4 inline" /> })}</p>
                  <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                    {trx('Đang xem <0>tất cả hội thoại</0> từ {{count}} tài khoản trong cùng một danh sách. Nhấn nút này hoặc chọn lại tài khoản cụ thể để <1>thoát chế độ gộp</1>.', { 0: <span className="text-blue-400 font-medium" />, count: accounts.length, 1: <span className="text-foreground/80" /> })}
                  </p>
                  <div className="absolute -top-1.5 right-4 w-3 h-3 bg-card border-l border-t border-input/60 rotate-45" />
                </div>
              </div>
            ) : (
              <div className="relative group">
                <button
                    onClick={() => setMergedModalOpen(true)}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-muted hover:bg-accent text-foreground border border-input transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
                  </svg>
                  {tr('Gộp tài khoản')}
                </button>
                <div className="absolute top-full right-0 mt-2 w-72 bg-card border border-input/60 rounded-xl shadow-2xl p-3 z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none">
                  <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">{trx('<0/> Gộp hội thoại đa tài khoản', { 0: <UsersIcon className="w-4 h-4 inline" /> })}</p>
                  <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                    {trx('Xem và trả lời tin nhắn từ <0>tất cả tài khoản</0> trong cùng một danh sách hội thoại - không cần chuyển qua lại.', { 0: <span className="text-amber-400 font-medium" /> })}
                  </p>
                  <div className="border-t border-border pt-2 mt-2 space-y-1">
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="text-green-400">✓</span>
                      <span>{trx('Gộp tin nhắn từ {{count}} tài khoản hiện có', { count: accounts.length })}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="text-green-400">✓</span>
                      <span>{tr('Trả lời đúng tài khoản ngay trong ô chat')}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="text-green-400">✓</span>
                      <span>{tr('Tiết kiệm thời gian, không bỏ lỡ tin nhắn')}</span>
                    </div>
                  </div>
                  <div className="absolute -top-1.5 right-4 w-3 h-3 bg-card border-l border-t border-input/60 rotate-45" />
                </div>
              </div>
            )
          )}

          {/* Add workspace - always visible */}
          <div className="relative group">
            <button
              onClick={() => {
                window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'workspace' } })), 80);
              }}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="3"/>
                <line x1="12" y1="8" x2="12" y2="16"/>
                <line x1="8" y1="12" x2="16" y2="12"/>
              </svg>
              {tr('Thêm workspace')}
            </button>
            {/* Tooltip */}
            <div className="absolute top-full right-0 mt-2 w-72 bg-card border border-input/60 rounded-xl shadow-2xl p-3 z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none">
              <div className="flex items-start gap-2 mb-2">
                <span className="text-lg"><HomeIcon className="w-4 h-4" /></span>
                <div>
                  <p className="text-xs font-semibold text-foreground">{tr('Tạo workspace mới')}</p>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                    {trx('Đăng nhập với tư cách <0>Boss</0> hoặc <1>Nhân viên</1>. Dữ liệu và database sẽ <2>độc lập</2> với workspace hiện tại.', { 0: <span className="text-amber-400 font-medium" />, 1: <span className="text-sky-400 font-medium" />, 2: <span className="text-red-400 font-medium" /> })}
                  </p>
                </div>
              </div>
              <div className="border-t border-border pt-2 mt-2 space-y-1.5">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="w-4 h-4 rounded bg-purple-900/40 flex items-center justify-center text-purple-400"><HomeIcon className="w-4 h-4" /></span>
                  <span>{trx('<0>Boss (Local)</0> - Quản lý trực tiếp, lưu DB trên máy', { 0: <span className="text-foreground/80" /> })}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="w-4 h-4 rounded bg-blue-900/40 flex items-center justify-center text-blue-400"><UserIcon className="w-4 h-4" /></span>
                  <span>{trx('<0>Nhân viên (Remote)</0> - Kết nối tới máy Boss từ xa', { 0: <span className="text-foreground/80" /> })}</span>
                </div>
              </div>
              {/* Arrow */}
              <div className="absolute -top-1.5 right-4 w-3 h-3 bg-card border-l border-t border-input/60 rotate-45" />
            </div>
          </div>

          {/* Support button - always visible */}
          <div className="relative group">
            <button
                onClick={() => ipc.shell?.openExternal(SUPPORT_GITHUB_URL)}
                className="flex text-white items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
              </svg>
              {tr('Hỗ trợ, báo lỗi')}
            </button>
            <div className="absolute top-full right-0 mt-2 w-[300px] bg-card border border-input/60 rounded-xl shadow-2xl p-3.5 z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none">
              <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">{trx('<0/> Báo lỗi & Đóng góp', { 0: <BugIcon className="w-4 h-4 inline" /> })}</p>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                {tr('Gặp lỗi hoặc có góp ý? Hãy gửi trên GitHub - chúng tôi sẽ xử lý nhanh nhất có thể.')}
              </p>
              <div className="border-t border-border pt-2 mt-2.5 space-y-1.5">
                <p className="text-[10px] text-amber-400 font-medium mb-1">{trx('<0/> Mẹo để được hỗ trợ nhanh:', { 0: <SunIcon className="w-4 h-4 inline" /> })}</p>
                <div className="flex items-start gap-2 text-[10px] text-muted-foreground">
                  <span className="text-amber-400 flex-shrink-0 mt-px">1.</span>
                  <span>{trx('Mô tả <0>các bước thao tác</0> cụ thể dẫn đến lỗi', { 0: <span className="text-foreground/80" /> })}</span>
                </div>
                <div className="flex items-start gap-2 text-[10px] text-muted-foreground">
                  <span className="text-amber-400 flex-shrink-0 mt-px">2.</span>
                  <span>{trx('Đính kèm <0>ảnh chụp màn hình</0> hoặc <1>video quay màn hình</1>', { 0: <span className="text-foreground/80" />, 1: <span className="text-foreground/80" /> })}</span>
                </div>
                <div className="flex items-start gap-2 text-[10px] text-muted-foreground">
                  <span className="text-amber-400 flex-shrink-0 mt-px">3.</span>
                  <span>{trx('Ghi rõ <0>phiên bản ứng dụng</0> (góc trái thanh trên)', { 0: <span className="text-foreground/80" /> })}</span>
                </div>
              </div>
              <p className="text-[10px] text-green-600 font-medium mt-2.5 flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {tr('Thông tin càng chi tiết → sửa càng nhanh!')}
              </p>
              <div className="absolute -top-1.5 right-4 w-3 h-3 bg-card border-l border-t border-input/60 rotate-45" />
            </div>
          </div>
        </div>
      </div>

      {/* Search + drag hint row */}
      <div className="flex items-center gap-2 mb-4">
        {!q && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/>
              <polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/>
              <line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>
            </svg>
            {tr('Kéo thả để sắp xếp thứ tự')}
          </p>
        )}
        <div className="flex-1" />
        <div className="relative w-64">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tr('Tên, SĐT, UID...')}
            className="bg-muted text-foreground placeholder-subtle-foreground text-sm pl-8 pr-3 py-1.5 rounded-lg border border-input focus:outline-none focus:border-blue-500 w-full"
          />
          {search && (
            <button onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Separator */}
      {!q && accounts.length > 0 && (
        <div className="flex items-center gap-2 mt-6 mb-3">
          <h3 className="text-sm font-semibold text-foreground/80"> {tr('Tài khoản')}</h3>
          <span className="text-[10px] text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">{accounts.length}</span>
          <div className="flex-1 border-t border-border/50" />
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          <p className="text-sm">{trx('Không tìm thấy tài khoản "{{search}}"', { search })}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((acc, index) => {
            const isDragOver = !q && dragOverIndex === index;
            return (
              <div
                key={acc.zalo_id}
                draggable={!q && !isEmployeeWorkspace}
                onDragStart={!q && !isEmployeeWorkspace ? (e) => handleDragStart(e, index) : undefined}
                onDragOver={!q && !isEmployeeWorkspace ? (e) => handleDragOver(e, index) : undefined}
                onDrop={!q && !isEmployeeWorkspace ? (e) => handleDrop(e, index) : undefined}
                onDragEnd={!q && !isEmployeeWorkspace ? handleDragEnd : undefined}
                className={`transition-all rounded-xl ${isDragOver ? 'ring-2 ring-blue-400 scale-[1.02] opacity-80' : ''}`}
                style={{ cursor: q || isEmployeeWorkspace ? 'default' : 'grab' }}
              >
                <AccountCard
                  key={acc.zalo_id}
                  account={acc}
                  onReconnect={handleReconnect}
                  employeeChatOnly={isEmployeeWorkspace}
                />
              </div>
            );
          })}
        </div>
      )}
      {mergedModalOpen && <MergedInboxModal onClose={() => setMergedModalOpen(false)} />}
    </div>
  );
}
