import React, { useState, useRef, useEffect } from 'react';
import { AccountInfo } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import ipc from '@/lib/ipc';
import { formatPhone } from '@/utils/phoneUtils';
import PhoneDisplay from '../common/PhoneDisplay';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/utils/apiError';

interface AccountCardProps {
  account: AccountInfo;
  onReconnect?: (acc: AccountInfo) => void;
  employeeChatOnly?: boolean;
}

// ─── FB Cookie Update Modal ───────────────────────────────────────────────────
function FBUpdateCookieModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [cookie, setCookie] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { showNotification } = useAppStore();

  const handleSave = async () => {
    if (!cookie.trim()) { setError('Vui lòng dán cookie mới'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await ipc.fb?.updateCookie({ accountId, cookie: cookie.trim() });
      if (res?.success) {
        showNotification('Cập nhật cookie Facebook thành công!', 'success');
        ipc.fb?.connect({ accountId }).catch(() => {});
        onClose();
      } else {
        setError(res?.error || 'Cập nhật thất bại');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[200]" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl w-full max-w-sm p-5 border border-gray-700 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-white font-semibold mb-3">Cập nhật Cookie Facebook</h3>
        <textarea
          value={cookie}
          onChange={e => { setCookie(e.target.value); setError(''); }}
          placeholder="c_user=...; xs=...; datr=..."
          rows={5}
          className="input-field text-xs resize-none font-mono w-full"
          disabled={loading}
        />
        {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
        <div className="flex gap-2 mt-3">
          <button onClick={onClose} className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs py-2 rounded-lg">Hủy</button>
          <button onClick={handleSave} disabled={loading || !cookie.trim()} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs py-2 rounded-lg disabled:opacity-50">
            {loading ? 'Đang lưu...' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AccountCard({ account: acc, onReconnect, employeeChatOnly = false }: AccountCardProps) {
  const { setActiveAccount, updateAccountStatus, updateListenerActive } = useAccountStore();
  const { setView, showNotification, setAddAccountModalOpen } = useAppStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [updatingInfo, setUpdatingInfo] = useState(false);
  const [fbCookieModalOpen, setFbCookieModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isFacebook = (acc.channel || 'zalo') === 'facebook';

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // listenerActive: undefined = chưa biết, true = OK, false = chết
  const listenerDead = acc.listenerActive === false;

  const handleReconnect = async () => {
    if (onReconnect && !isFacebook) { onReconnect(acc); return; }
    showNotification(`Đang kết nối ${acc.full_name || acc.zalo_id}...`, 'info');
    try {
      if (isFacebook) {
        const res = await ipc.fb?.connect({ accountId: acc.zalo_id });
        if (res?.success) {
          updateAccountStatus(acc.zalo_id, true, true);
          showNotification('Kết nối Facebook thành công!', 'success');
        } else {
          showNotification(res?.error || 'Kết nối Facebook thất bại', 'error');
        }
        return;
      }
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      const res = await ipc.login?.connectAccount(auth);
      if (res?.success) {
        updateAccountStatus(acc.zalo_id, true, true);
        updateListenerActive(acc.zalo_id, true);
        showNotification('Kết nối thành công!', 'success');
      } else {
        updateListenerActive(acc.zalo_id, false);
        showNotification(res?.error || 'Kết nối thất bại', 'error');
      }
    } catch (err: any) {
      updateListenerActive(acc.zalo_id, false);
      showNotification(err.message, 'error');
    }
  };

  const handleDisconnect = async () => {
    try {
      if (isFacebook) {
        await ipc.fb?.disconnect({ accountId: acc.zalo_id });
      } else {
        await ipc.login?.disconnectAccount(acc.zalo_id);
      }
      updateAccountStatus(acc.zalo_id, false, false);
      showNotification('Đã ngắt kết nối', 'info');
    } catch (err: any) {
      showNotification(err.message, 'error');
    }
  };

  const handleDeleteAccount = async () => {
    setMenuOpen(false);
    const ok = await showConfirm({
      title: 'Xóa tài khoản này?',
      message: `Tài khoản "${acc.full_name || acc.zalo_id}" sẽ bị xóa khỏi ứng dụng. Bạn cần đăng nhập lại để thêm lại.`,
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!ok) return;
    if (isFacebook) {
      const res = await ipc.fb?.removeAccount({ accountId: acc.zalo_id });
      if (res?.success) {
        useAccountStore.getState().removeAccount(acc.zalo_id);
        showNotification('Đã xóa tài khoản Facebook', 'success');
      } else {
        showNotification(res?.error || 'Xóa tài khoản thất bại', 'error');
      }
      return;
    }
    const res = await ipc.login?.removeAccount(acc.zalo_id);
    if (res?.success) {
      useAccountStore.getState().removeAccount(acc.zalo_id);
      showNotification('Đã xóa tài khoản', 'success');
    } else {
      showNotification(extractApiError(res, 'Xóa tài khoản thất bại'), 'error');
    }
  };

  const handleUpdateInfo = async () => {
    setMenuOpen(false);
    setUpdatingInfo(true);
    try {
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      const res = await ipc.zalo?.getContext({ auth });
      if (res?.success && res.response) {
        const ctx = res.response;
        const loginInfo = ctx.loginInfo || {};
        const uid: string = ctx.uid || acc.zalo_id;

        // displayName: context không chứa tên, giữ nguyên hoặc lấy từ DB
        const displayName: string = acc.full_name || acc.zalo_id;
        const avatarUrl: string = acc.avatar_url || '';

        // SĐT: trường chính xác từ loginInfo là phone_number (vd: "84944767139")
        const rawPhone: string =
          loginInfo.phone_number ||
          loginInfo.phoneNumber ||
          loginInfo.phone ||
          loginInfo.msisdn ||
          '';
        const phone: string = formatPhone(rawPhone) || acc.phone || '';

        // Cập nhật DB
        if (phone && phone !== acc.phone) {
          // Cập nhật bảng contacts (để hiển thị trong chat)
          await ipc.db?.updateContactProfile({ zaloId: uid, contactId: uid, displayName, avatarUrl, phone });
          // Cập nhật bảng accounts (để lưu qua restart)
          await ipc.db?.updateAccountPhone({ zaloId: uid, phone });
          // Cập nhật store
          useAccountStore.getState().updateAccount(uid, { phone });
          showNotification('Đã cập nhật số điện thoại: ' + phone, 'success');
        } else {
          showNotification('Thông tin đã cập nhật (SĐT không đổi)', 'info');
        }
      } else {
        showNotification('Không thể tải thông tin: ' + (res?.error || 'Lỗi không xác định'), 'error');
      }
    } catch (err: any) {
      showNotification('Lỗi cập nhật: ' + err.message, 'error');
    } finally {
      setUpdatingInfo(false);
    }
  };

  const handleUpdateFBInfo = async () => {
    setMenuOpen(false);
    setUpdatingInfo(true);
    try {
      const res = await ipc.fb?.refreshProfile({ accountId: acc.zalo_id });
      if (res?.success) {
        const updates: Partial<AccountInfo> = {};
        if (res.name) updates.full_name = res.name;
        if (res.avatarUrl) updates.avatar_url = res.avatarUrl;
        if (res.facebookId) updates.facebook_id = res.facebookId;
        if (Object.keys(updates).length > 0) {
          useAccountStore.getState().updateAccount(acc.zalo_id, updates);
        }
        showNotification(`Đã cập nhật: ${res.name || acc.full_name}`, 'success');
      } else {
        showNotification(res?.error || 'Cập nhật thông tin FB thất bại', 'error');
      }
    } catch (err: any) {
      showNotification('Lỗi cập nhật: ' + err.message, 'error');
    } finally {
      setUpdatingInfo(false);
    }
  };

  // Trạng thái badge
  const statusBadge = (() => {
    if (listenerDead) {
      return { label: '⚠ Listener chết', cls: 'bg-red-900/40 text-red-400 border border-red-700/50', dot: 'bg-red-400 animate-pulse' };
    }
    if (acc.isOnline) {
      return { label: 'Online', cls: 'bg-green-900/40 text-green-400 border border-green-700/50', dot: 'bg-green-400' };
    }
    if (acc.isConnected) {
      return { label: 'Đang kết nối', cls: 'bg-yellow-900/40 text-yellow-400 border border-yellow-700/50', dot: 'bg-yellow-400 animate-pulse' };
    }
    return { label: 'Offline', cls: 'bg-gray-700/50 text-gray-500 border border-gray-600/50', dot: 'bg-gray-500' };
  })();

  return (
    <>
    <div className={`bg-gray-800 rounded-xl p-4 border transition-colors ${listenerDead ? 'border-red-700/60' : 'border-gray-700 hover:border-gray-600'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-shrink-0">
          {acc.avatar_url ? (
            <img src={acc.avatar_url} alt="" className="w-12 h-12 rounded-full object-cover" />
          ) : (
            <div className={`w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-lg ${isFacebook ? 'bg-blue-800' : 'bg-blue-600'}`}>
              {isFacebook ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
              ) : (acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
            </div>
          )}
          <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-gray-800 ${statusBadge.dot}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-200 truncate flex items-center gap-1.5">
            {acc.full_name || (isFacebook ? 'Facebook Account' : acc.zalo_id)}
            {listenerDead && (
              <span className="relative group flex-shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded-lg text-[10px] text-red-300 whitespace-nowrap z-50 hidden group-hover:block shadow-lg">
                  Listener bị ngắt — Thử kết nối lại hoặc quét QR mới
                </span>
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500 truncate">
            {isFacebook ? `${acc.facebook_id || acc.zalo_id}` : acc.zalo_id}
          </p>
          {acc.phone && (
            <p className="text-xs text-gray-400 truncate mt-0.5">
              📞 <PhoneDisplay phone={acc.phone} className="text-xs text-gray-400" />
            </p>
          )}
        </div>

        {/* 3-dot menu */}
        {!employeeChatOnly && (
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
            title="Tùy chọn"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
            </svg>
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-8 w-52 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 py-1 overflow-hidden">
              {isFacebook ? (
                <>
                <button
                  onClick={handleUpdateFBInfo}
                  disabled={updatingInfo}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-50"
                >
                  {updatingInfo ? (
                    <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                    </svg>
                  )}
                  {updatingInfo ? 'Đang cập nhật...' : 'Cập nhật thông tin'}
                </button>
                <button
                  onClick={() => { setMenuOpen(false); setFbCookieModalOpen(true); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  Cập nhật Cookie FB
                </button>
                </>
              ) : (
              <button
                onClick={handleUpdateInfo}
                disabled={updatingInfo}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                {updatingInfo ? (
                  <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                )}
                {updatingInfo ? 'Đang cập nhật...' : 'Cập nhật thông tin'}
              </button>
              )}

              <div className="border-t border-gray-700 my-1" />

              <button
                onClick={() => { setMenuOpen(false); setActiveAccount(acc.zalo_id); setView('chat'); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                </svg>
                Mở Chat
              </button>

              <div className="border-t border-gray-700 my-1" />

              <button
                onClick={handleDeleteAccount}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                  <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                </svg>
                Xóa tài khoản
              </button>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {/* Row 1: Chat + Connect/Disconnect — ẩn Chat khi listener chết */}
        <div className="flex gap-2">
          {!listenerDead && (
            <button
              onClick={() => { setActiveAccount(acc.zalo_id); setView('chat'); }}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs py-1.5 rounded-lg transition-colors font-medium"
            >
              Chat
            </button>
          )}

          {/* Chỉ hiện nút connect/disconnect khi listener KHÔNG chết */}
          {!employeeChatOnly && !listenerDead && (acc.isConnected ? (
            <button
              title="Ngắt kết nối sẽ dừng nghe tin nhắn và đánh dấu tài khoản offline."
              onClick={handleDisconnect}
              className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs py-1.5 rounded-lg transition-colors font-medium"
            >
              Ngắt kết nối
            </button>
          ) : (
            <button
              title="Kết nối lại để tiếp tục nhận tin nhắn."
              onClick={handleReconnect}
              className="flex-1 bg-orange-700 text-white-important hover:bg-gray-600 text-gray-300 text-xs py-1.5 rounded-lg transition-colors font-medium"
            >
              Kết nối lại
            </button>
          ))}
        </div>

        {/* Row 2: chỉ hiện khi listener chết — 2 nút Reconnect + QR/Cookie */}
        {!employeeChatOnly && listenerDead && (
          <div className="flex gap-2">
            <button
              onClick={handleReconnect}
              className="flex-1 bg-orange-700 hover:bg-orange-600 text-white-important text-xs py-1.5 rounded-lg transition-colors font-medium flex items-center justify-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Reconnect
            </button>
            <button
              onClick={() => isFacebook ? setFbCookieModalOpen(true) : setAddAccountModalOpen(true)}
              className="flex-1 bg-blue-800 hover:bg-blue-700 text-white text-xs py-1.5 rounded-lg transition-colors font-medium flex items-center justify-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="5" height="5" /><rect x="16" y="3" width="5" height="5" />
                <rect x="3" y="16" width="5" height="5" /><path d="M21 16h-3v3M21 21h-3v-3M16 21h-3v-3M13 16h3" />
              </svg>
              {isFacebook ? 'Cập nhật Cookie' : 'Quét QR mới'}
            </button>
          </div>
        )}
      </div>
    </div>
    {fbCookieModalOpen && (
      <FBUpdateCookieModal accountId={acc.zalo_id} onClose={() => setFbCookieModalOpen(false)} />
    )}
    </>
  );
}
