import React, { useRef, useState } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useVisibleAccounts } from '@/hooks/useVisibleAccounts';
import AccountCard from './AccountCard';
import MergedInboxModal from './MergedInboxModal';
import EmployeeLoginModal from './EmployeeLoginModal';
import ipc from '@/lib/ipc';

const SUPPORT_GITHUB_URL = 'https://github.com/babyvibe/deplao-builder/issues';

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
  const [syncing, setSyncing] = useState(false);
  const activeWs = useWorkspaceStore(s => s.activeWorkspace());
  const assignedAccounts = useEmployeeStore(s => s.assignedAccounts);
  const bossConnected = useEmployeeStore(s => s.bossConnected);

  const isRemoteWs = activeWs?.type === 'remote' || empMode === 'employee';
  const isEmployeeWorkspace = activeWs?.type === 'remote' && empMode === 'employee';

  const handleSyncFromBoss = async () => {
    if (syncing) return;
    const zaloIds = assignedAccounts;
    if (!zaloIds || zaloIds.length === 0) {
      showNotification('Chưa có tài khoản được gán. Hãy kết nối với BOSS trước.', 'warning');
      return;
    }
    setSyncing(true);
    showNotification('Đang tải dữ liệu từ Boss...', 'info');
    try {
      const res = await ipc.sync?.requestFullSync(zaloIds);
      if (res?.success) {
        showNotification('Đồng bộ dữ liệu thành công!', 'success');
      } else {
        showNotification(res?.error || 'Đồng bộ thất bại', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Lỗi đồng bộ', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleReconnect = async (acc: any) => {
    showNotification(`Đang kết nối ${acc.full_name || acc.zalo_id}...`, 'info');
    try {
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      const res = await ipc.login?.connectAccount(auth);
      if (res?.success) {
        updateAccountStatus(acc.zalo_id, true, true);
        showNotification('Kết nối thành công!', 'success');
      } else {
        showNotification(res?.error || 'Kết nối thất bại', 'error');
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

  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter((a) =>
        (a.full_name || '').toLowerCase().includes(q) ||
        a.zalo_id.includes(q) ||
        (a.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '')) ||
        (a.phone || '').includes(q)
      )
    : accounts;
  if (accounts.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 gap-4">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="opacity-20">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
          <circle cx="9" cy="7" r="4" />
        </svg>
        {isSimulating ? (
          <>
            <p className="text-lg font-medium">Nhân viên này chưa được gán tài khoản</p>
            <p className="text-sm">Quay lại Cài đặt → Quản lý nhân viên để gán tài khoản Zalo cho nhân viên.</p>
            <button
              onClick={() => useEmployeeStore.getState().setPreviewEmployeeId(null)}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors"
            >
              Thoát giả lập
            </button>
          </>
        ) : activeWs?.type === 'remote' || empMode === 'employee' ? (
          <>
            <p className="text-lg font-medium text-gray-300">Chưa có trang nào được quản lý</p>
            <p className="text-sm text-gray-500">Liên hệ BOSS để được gán tài khoản Zalo vào workspace này.</p>
            <div className="flex items-center gap-3 mt-2">
              {isRemoteWs && (
              <button
                onClick={handleSyncFromBoss}
                disabled={syncing || !bossConnected}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
                title={!bossConnected ? 'Cần kết nối với BOSS trước' : 'Tải dữ liệu tin nhắn, danh bạ từ BOSS'}
              >
                {syncing ? (
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                )}
                {syncing ? 'Đang tải...' : 'Tải dữ liệu từ Boss'}
              </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-lg font-medium">Chưa có tài khoản nào</p>
            <p className="text-sm">Nhấn nút + để thêm tài khoản Zalo hoặc đăng nhập nhân viên</p>
            <div className="flex items-center gap-3">
              <button onClick={() => useAppStore.getState().setAddAccountModalOpen(true)} className="btn-primary text-white-important">
                + Thêm tài khoản
              </button>
            </div>
          </>
        )}
        <button
            onClick={() => setEmployeeLoginOpen(true)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 border border-gray-600 transition-colors"
        >
          👤 Đăng nhập dành cho nhân viên
        </button>
        <button
          onClick={() => ipc.shell?.openExternal(SUPPORT_GITHUB_URL)}
          className="flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 transition-colors mt-2"
        >
          Cần hỗ trợ, báo lỗi? Liên hệ Github
        </button>
        {employeeLoginOpen && <EmployeeLoginModal onClose={() => setEmployeeLoginOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header + search */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h2 className="text-lg font-semibold text-white">Dashboard</h2>
        <span className="text-xs text-gray-500 bg-gray-700/50 px-2 py-0.5 rounded-full">
          {accounts.length} tài khoản
        </span>
        {isSimulating && (() => {
          const simEmp = useEmployeeStore.getState().getPreviewEmployee();
          return simEmp ? (
            <span className="text-xs text-amber-300 bg-amber-900/30 border border-amber-700/40 px-2.5 py-0.5 rounded-full flex items-center gap-1.5">
              🔄 Giả lập: {simEmp.display_name}
            </span>
          ) : null;
        })()}

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {/* Sync from boss — remote workspace only */}
          {isRemoteWs && (
            <button
              onClick={handleSyncFromBoss}
              disabled={syncing || !bossConnected}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
              title={!bossConnected ? 'Cần kết nối với BOSS trước' : 'Tải dữ liệu DB + media từ BOSS'}
            >
              {syncing ? (
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              )}
              {syncing ? 'Đang tải...' : 'Tải dữ liệu từ Boss'}
            </button>
          )}

          {/* Gộp tài khoản button — available for both boss and employee (uses visible/assigned accounts) */}
          {accounts.length > 1 && (
            mergedInboxMode ? (
              <button
                  onClick={() => { exitMergedInbox(); }}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
                </svg>
                Đang Gộp tài khoản
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            ) : (
              <button
                  onClick={() => setMergedModalOpen(true)}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 border border-gray-600 transition-colors"
                  title="Gộp hội thoại từ nhiều tài khoản vào một nơi"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
                </svg>
                Gộp tài khoản
              </button>
            )
          )}

          {/* Nút hỗ trợ — always visible */}
          <button
              onClick={() => ipc.shell?.openExternal(SUPPORT_GITHUB_URL)}
              className="flex text-white items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 transition-colors"
              title="Liên hệ hỗ trợ qua Github"
          >
            Hỗ trợ, báo lỗi
          </button>
          {/* Search */}
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tên, SĐT, UID..."
              className="bg-gray-700 text-gray-200 placeholder-gray-400 text-sm pl-8 pr-3 py-1.5 rounded-lg border border-gray-600 focus:outline-none focus:border-blue-500 w-44"
            />
            {search && (
              <button onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {!q && (
        <p className="text-xs text-gray-500 mb-3 flex items-center gap-1">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/>
            <polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/>
            <line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>
          </svg>
          Kéo thả để sắp xếp thứ tự
        </p>
      )}

      {/* Separator */}
      {!q && accounts.length > 0 && (
        <div className="flex items-center gap-2 mt-6 mb-3">
          <h3 className="text-sm font-semibold text-gray-300"> Tài khoản</h3>
          <span className="text-[10px] text-gray-500 bg-gray-700/50 px-2 py-0.5 rounded-full">{accounts.length}</span>
          <div className="flex-1 border-t border-gray-700/50" />
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center text-gray-500 py-12">
          <p className="text-sm">Không tìm thấy tài khoản "{search}"</p>
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
