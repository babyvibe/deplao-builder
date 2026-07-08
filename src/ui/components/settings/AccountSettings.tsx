import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/utils/apiError';
import { FolderIcon, GlobeIcon, HardDriveIcon, SettingsIcon, TrashIcon, UserIcon } from '@/components/common/icons';

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4">
      {children}
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

export default function AccountSettings() {
  const { accounts, removeAccount } = useAccountStore();
  const { showNotification } = useAppStore();

  // Settings modal state
  const [settingsModalAcc, setSettingsModalAcc] = useState<string | null>(null);
  const [localConfig, setLocalConfig] = useState<{ enabled: boolean; days: number }>({ enabled: false, days: 30 });
  const [configLoaded, setConfigLoaded] = useState(false);
  const [savingMedia, setSavingMedia] = useState(false);

  // Delete modal state
  const [deleteModalAcc, setDeleteModalAcc] = useState<string | null>(null);
  const [deleteWithData, setDeleteWithData] = useState(true);

  // Load config khi mở modal
  useEffect(() => {
    if (settingsModalAcc) {
      setConfigLoaded(false);
      setLocalConfig({ enabled: false, days: 30 });
      ipc.login?.getMediaAutoDelete(settingsModalAcc).then((res: any) => {
        if (res?.success && res.config) {
          setLocalConfig(res.config);
        }
        setConfigLoaded(true);
      });
    }
  }, [settingsModalAcc]);

  const handleSaveMediaConfig = async () => {
    if (!settingsModalAcc) return;
    setSavingMedia(true);
    try {
      const res = await ipc.login?.setMediaAutoDelete(settingsModalAcc, localConfig.enabled, localConfig.days);
      if (res?.success) {
        showNotification(res.message || 'Đã lưu cấu hình xoá media', 'success');
        setSettingsModalAcc(null);
      } else {
        showNotification('Lỗi lưu cấu hình', 'error');
      }
    } catch (err: any) {
      showNotification('Lỗi lưu cấu hình', 'error');
    } finally {
      setSavingMedia(false);
    }
  };

  const handleDeleteAccount = async (zaloId: string) => {
    const ok = await showConfirm({
      title: deleteWithData ? 'Xoá tài khoản và tất cả dữ liệu?' : 'Xoá tài khoản này?',
      message: deleteWithData
        ? 'Tài khoản, tin nhắn, hội thoại, danh bạ, khách hàng, file media, nhãn, ghi chú và tất cả dữ liệu CRM sẽ bị XOÁ VĨNH VIỄN. Không thể khôi phục!'
        : 'Tài khoản sẽ bị xoá khỏi ứng dụng. Bạn cần đăng nhập lại để thêm lại. Dữ liệu tin nhắn và media được giữ lại.',
      confirmText: deleteWithData ? 'Xoá tất cả' : 'Xoá tài khoản',
      variant: deleteWithData ? 'danger' : 'warning',
    });
    if (!ok) return;
    const res = await ipc.login?.removeAccount(zaloId, deleteWithData);
    if (res?.success) {
      removeAccount(zaloId);
      showNotification(
        deleteWithData ? 'Đã xoá tài khoản và toàn bộ dữ liệu' : 'Đã xoá tài khoản',
        'success'
      );
      setDeleteModalAcc(null);
    } else {
      showNotification(extractApiError(res, 'Xoá tài khoản thất bại'), 'error');
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold text-white"><UserIcon className="w-4 h-4 inline" /> Tài khoản đã đăng nhập</h2>
      </div>
      <Section>
        <div className="space-y-2">
          {accounts.map((acc) => (
            <div key={acc.zalo_id}>
              {/* Account card row */}
              <div className="flex items-center gap-3 p-2.5 bg-gray-700 rounded-xl">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-400' : 'bg-gray-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-gray-200 truncate font-medium">{acc.full_name || acc.zalo_id}</p>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${(acc.channel || 'zalo') === 'facebook' ? 'bg-blue-900/50 text-blue-400' : 'bg-blue-900/50 text-blue-300'}`}>
                      {(acc.channel || 'zalo') === 'facebook' ? 'FB' : 'Zalo'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">{acc.zalo_id}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-900/50 text-green-400' : 'bg-gray-600 text-gray-400'}`}>
                  {acc.isOnline ? 'Online' : 'Offline'}
                </span>
                {/* Settings gear icon */}
                <button
                  onClick={() => setSettingsModalAcc(acc.zalo_id)}
                  className="text-gray-400 hover:text-white transition-colors p-1"
                  title="Cài đặt tài khoản"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                {/* Delete button */}
                <button
                  onClick={() => setDeleteModalAcc(acc.zalo_id)}
                  className="text-red-400 hover:text-red-300 text-xs flex-shrink-0 ml-1"
                >
                  Xóa
                </button>
              </div>
            </div>
          ))}
          {accounts.length === 0 && <p className="text-gray-400 text-sm">Chưa có tài khoản nào</p>}
        </div>
      </Section>

      {/* ── Settings popup (auto-delete media) ── */}
      {settingsModalAcc && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setSettingsModalAcc(null)}>
          <div className="bg-gray-800 border border-gray-600 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-5 pt-5 pb-3 border-b border-gray-700">
              <div className="flex items-center gap-3 mb-1">
                <SettingsIcon className="w-6 h-6" />
                <h3 className="text-base font-semibold text-white">Cài đặt tài khoản</h3>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {accounts.find(a => a.zalo_id === settingsModalAcc)?.full_name || settingsModalAcc}
              </p>
            </div>

            {/* Body */}
            <div className="p-5 space-y-5">
              {/* Auto-delete media */}
              <div>
                <p className="text-sm font-semibold text-gray-200 mb-3"><FolderIcon className="w-4 h-4 inline" /> Tự động xoá media</p>
                {configLoaded ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-300">Bật tự động xoá</p>
                        <p className="text-xs text-gray-400">Xoá file media cũ hơn số ngày cài đặt</p>
                      </div>
                      <Toggle
                        value={localConfig.enabled}
                        onChange={(v) => setLocalConfig(prev => ({ ...prev, enabled: v }))}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block">Xoá sau (ngày)</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={localConfig.days}
                          onChange={(e) => setLocalConfig(prev => ({ ...prev, days: parseInt(e.target.value) || 30 }))}
                          className={`w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border transition-colors ${localConfig.enabled ? 'border-gray-600' : 'border-gray-700 opacity-60'}`}
                          disabled={!localConfig.enabled}
                        />
                        <span className="text-xs text-gray-400 flex-shrink-0">ngày</span>
                      </div>
                    </div>
                    <p className="text-[11px] text-gray-400 leading-relaxed">
                      Hệ thống sẽ tự động kiểm tra và xoá media cũ mỗi ngày một lần (3:00 AM).
                      Khi lưu, thao tác dọn dẹp sẽ được chạy ngay lập tức.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-gray-400 py-3">
                    <div className="w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
                    Đang tải cấu hình...
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 pb-5 flex gap-2">
              <button
                onClick={() => setSettingsModalAcc(null)}
                className="flex-1 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-xl transition-colors"
              >
                Huỷ
              </button>
              <button
                onClick={handleSaveMediaConfig}
                disabled={savingMedia || !configLoaded}
                className="flex-1 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-xl transition-colors disabled:opacity-50"
              >
                {savingMedia ? 'Đang lưu...' : 'Lưu & chạy ngay'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete account confirmation modal ── */}
      {deleteModalAcc && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setDeleteModalAcc(null)}>
          <div className="bg-gray-800 border border-gray-600 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-5 pt-5 pb-3 border-b border-gray-700">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-2xl"><TrashIcon className="w-4 h-4" /></span>
                <h3 className="text-base font-semibold text-white">Xoá tài khoản</h3>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {accounts.find(a => a.zalo_id === deleteModalAcc)?.full_name || deleteModalAcc}
              </p>
            </div>

            {/* Options */}
            <div className="p-4 space-y-3">
              <label className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-colors cursor-pointer ${deleteWithData ? 'border-red-500 bg-red-500/10' : 'border-gray-600 hover:bg-gray-700'}`}>
                <input
                  type="radio"
                  name="deleteMode"
                  checked={deleteWithData}
                  onChange={() => setDeleteWithData(true)}
                  className="mt-0.5 accent-red-500"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-red-300">Xoá tất cả dữ liệu</p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                    Xoá vĩnh viễn tài khoản, tin nhắn, hội thoại, danh bạ, khách hàng,
                    nhãn, ghi chú, chiến dịch CRM, workflow và toàn bộ file media (ảnh,
                    video, file đính kèm). <strong className="text-red-400">Không thể khôi phục!</strong>
                  </p>
                </div>
              </label>

              <label className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-colors cursor-pointer ${!deleteWithData ? 'border-blue-500 bg-blue-500/10' : 'border-gray-600 hover:bg-gray-700'}`}>
                <input
                  type="radio"
                  name="deleteMode"
                  checked={!deleteWithData}
                  onChange={() => setDeleteWithData(false)}
                  className="mt-0.5 accent-blue-500"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-blue-300">Chỉ xoá tài khoản</p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                    Xoá tài khoản khỏi danh sách đăng nhập. Dữ liệu tin nhắn,
                    danh bạ, CRM và file media được giữ nguyên trên ổ cứng.
                  </p>
                </div>
              </label>
            </div>

            {/* Footer */}
            <div className="px-4 pb-4 flex gap-2">
              <button
                onClick={() => setDeleteModalAcc(null)}
                className="flex-1 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-xl transition-colors"
              >
                Hủy
              </button>
              <button
                onClick={() => handleDeleteAccount(deleteModalAcc)}
                className={`flex-1 py-2 text-sm font-medium text-white rounded-xl transition-colors ${deleteWithData ? 'bg-red-600 hover:bg-red-500' : 'bg-orange-600 hover:bg-orange-500'}`}
              >
                {deleteWithData ? <><TrashIcon className="w-4 h-4 inline" /> Xoá tất cả</> : 'Xoá tài khoản'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
