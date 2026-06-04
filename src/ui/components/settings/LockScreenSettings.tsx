import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';

type Tab = 'security' | 'recovery' | 'disable';

export default function LockScreenSettings() {
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState<Tab>('security');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [savedRecoveryKey, setSavedRecoveryKey] = useState('');
  const [keySavedConfirm, setKeySavedConfirm] = useState(false);
  // Recovery key viewing state
  const [recoveryView, setRecoveryView] = useState<'idle' | 'show'>('idle');

  // Load status on mount
  useEffect(() => {
    ipc.lockScreen.status().then(res => {
      if (res.success) {
        setEnabled(res.enabled);
      }
    });
  }, []);

  const clearMessages = () => { setError(''); setSuccess(''); };

  // ─── Setup password ───────────────────────────────────────────────────────
  const handleSetup = useCallback(async () => {
    clearMessages();
    if (password.length < 4) {
      setError('Mật khẩu phải có ít nhất 4 ký tự');
      return;
    }
    if (password !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.setup({ password });
      if (res.success) {
        setSavedRecoveryKey(res.recoveryKey || '');
        setEnabled(true);
        setPassword('');
        setConfirmPassword('');
        // Show recovery key inline
        setRecoveryView('show');
      } else {
        setError(res.error || 'Lỗi thiết lập mật khẩu');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [password, confirmPassword]);

  // ─── Change password ─────────────────────────────────────────────────────
  const handleChangePassword = useCallback(async () => {
    clearMessages();
    if (!oldPassword.trim()) {
      setError('Vui lòng nhập mật khẩu hiện tại');
      return;
    }
    if (newPassword.length < 4) {
      setError('Mật khẩu mới phải có ít nhất 4 ký tự');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.changePassword({ oldPassword, newPassword });
      if (res.success) {
        setSuccess('Đổi mật khẩu thành công');
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setError(res.error || 'Đổi mật khẩu thất bại');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [oldPassword, newPassword, confirmPassword]);

  // ─── Disable lock screen ─────────────────────────────────────────────────
  const handleDisable = useCallback(async () => {
    clearMessages();
    if (!password.trim()) {
      setError('Vui lòng nhập mật khẩu để tắt khoá');
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.disable({ password });
      if (res.success) {
        setEnabled(false);
        setPassword('');
        setSuccess('Đã tắt khoá màn hình');
      } else {
        setError(res.error || 'Mật khẩu không đúng');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [password]);

  // ─── Show recovery key ───────────────────────────────────────────────────
  const handleShowRecovery = useCallback(async () => {
    clearMessages();
    if (!password.trim()) {
      setError('Vui lòng nhập mật khẩu');
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.getRecoveryKey({ password });
      if (res.success && res.recoveryKey) {
        setRecoveryKey(res.recoveryKey);
        setRecoveryView('show');
        setPassword('');
      } else {
        setError(res.error || 'Mật khẩu không đúng');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [password]);

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setSuccess('Đã sao chép recovery key');
  };

  // ─── Tab button helper ───────────────────────────────────────────────────
  const TabBtn = ({ id, label, icon }: { id: Tab; label: string; icon: string }) => (
    <button
      onClick={() => { setTab(id); clearMessages(); setRecoveryView('idle'); setPassword(''); }}
      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-all ${
        tab === id
          ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
          : 'text-gray-400 hover:text-gray-300 hover:bg-gray-700/50 border border-transparent'
      }`}
    >
      <span>{icon}</span>
      {label}
    </button>
  );

  // ─── Message banners ─────────────────────────────────────────────────────
  const MessageBanners = () => (
    <>
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-600/10 border border-red-600/20 rounded-lg">
          <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-600/10 border border-green-600/20 rounded-lg">
          <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm text-green-400">{success}</span>
        </div>
      )}
    </>
  );

  // ─── Setup recovery key view (after first setup) ─────────────────────────
  if (enabled && savedRecoveryKey && recoveryView === 'show' && !recoveryKey) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <span>🛡️</span> Bảo mật
        </h2>

        <div className="bg-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <p className="text-sm font-semibold text-green-400">Khoá màn hình đã được bật!</p>
          </div>

          <p className="text-sm text-gray-300 mb-3">
            Lưu recovery key bên dưới ở nơi an toàn. Nếu quên mật khẩu, bạn cần key này để khôi phục.
          </p>

          <div className="bg-gray-900 rounded-lg p-4 text-center mb-4">
            <p className="text-lg font-mono font-bold text-amber-400 tracking-widest select-all">
              {savedRecoveryKey}
            </p>
          </div>

          <div className="flex gap-2 mb-4">
            <button
              onClick={() => handleCopyKey(savedRecoveryKey)}
              className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              📋 Sao chép
            </button>
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={keySavedConfirm}
              onChange={e => setKeySavedConfirm(e.target.checked)}
              className="mt-0.5 rounded"
            />
            <span>Tôi đã lưu recovery key ở nơi an toàn</span>
          </label>

          <button
            onClick={() => {
              setSavedRecoveryKey('');
              setKeySavedConfirm(false);
              setRecoveryView('idle');
              setSuccess('');
            }}
            disabled={!keySavedConfirm}
            className="w-full mt-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Hoàn tất
          </button>
        </div>

        {success && (
          <div className="flex items-center gap-2 p-3 bg-green-600/10 border border-green-600/20 rounded-lg">
            <span className="text-sm text-green-400">{success}</span>
          </div>
        )}
      </div>
    );
  }

  // ─── Recovery key detail view (from tab) ─────────────────────────────────
  if (recoveryKey && recoveryView === 'show') {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <span>🛡️</span> Bảo mật
        </h2>

        <div className="bg-gray-800 rounded-xl p-4">
          <button
            onClick={() => { setRecoveryView('idle'); setRecoveryKey(''); setTab('recovery'); clearMessages(); }}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors mb-3"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Quay lại
          </button>

          <p className="text-sm text-gray-300 mb-3">Recovery key của bạn:</p>

          <div className="bg-gray-900 rounded-lg p-4 text-center mb-4">
            <p className="text-lg font-mono font-bold text-amber-400 tracking-widest select-all">
              {recoveryKey}
            </p>
          </div>

          <button
            onClick={() => handleCopyKey(recoveryKey)}
            className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            📋 Sao chép Recovery Key
          </button>
        </div>

        {success && (
          <div className="flex items-center gap-2 p-3 bg-green-600/10 border border-green-600/20 rounded-lg">
            <span className="text-sm text-green-400">{success}</span>
          </div>
        )}
      </div>
    );
  }

  // ─── Not enabled: setup form ─────────────────────────────────────────────
  if (!enabled) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <span>🛡️</span> Bảo mật
        </h2>

        <div className="bg-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-medium text-white">Khoá màn hình</p>
              <p className="text-xs text-gray-400 mt-0.5">Yêu cầu mật khẩu khi mở ứng dụng</p>
            </div>
            <span className="px-2.5 py-1 bg-gray-600/40 text-gray-400 text-xs font-medium rounded-full">
              Chưa bật
            </span>
          </div>

          <div className="space-y-3">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => { setPassword(e.target.value); clearMessages(); }}
              placeholder="Đặt mật khẩu (tối thiểu 4 ký tự)"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); clearMessages(); }}
              placeholder="Xác nhận mật khẩu"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} className="rounded" />
              Hiện mật khẩu
            </label>
            <button
              onClick={handleSetup}
              disabled={loading || !password.trim()}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Đang thiết lập...' : 'Bật khoá màn hình'}
            </button>
          </div>
        </div>

        <MessageBanners />
      </div>
    );
  }

  // ─── Enabled: tabbed view ────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-white flex items-center gap-2">
        <span>🛡️</span> Bảo mật
      </h2>

      {/* Status bar */}
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-white">Khoá màn hình</p>
            <p className="text-xs text-gray-400 mt-0.5">Yêu cầu mật khẩu khi mở ứng dụng</p>
          </div>
          <span className="px-2.5 py-1 bg-green-600/20 text-green-400 text-xs font-medium rounded-full">
            Đã bật
          </span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1.5 bg-gray-800/60 rounded-xl p-1">
        <TabBtn id="security" label="Đổi MK" icon="🔑" />
        <TabBtn id="recovery" label="Recovery" icon="🗝️" />
        <TabBtn id="disable" label="Tắt khoá" icon="🔓" />
      </div>

      {/* ── Tab: Security (change password + biometric) ─────────────────── */}
      {tab === 'security' && (
        <div className="space-y-4">
          {/* Change password */}
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-sm font-medium text-white mb-3">Đổi mật khẩu</p>
            <div className="space-y-3">
              <input
                type={showPassword ? 'text' : 'password'}
                value={oldPassword}
                onChange={e => { setOldPassword(e.target.value); clearMessages(); }}
                placeholder="Mật khẩu hiện tại"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={e => { setNewPassword(e.target.value); clearMessages(); }}
                placeholder="Mật khẩu mới (tối thiểu 4 ký tự)"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => { setConfirmPassword(e.target.value); clearMessages(); }}
                placeholder="Xác nhận mật khẩu mới"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} className="rounded" />
                Hiện mật khẩu
              </label>
              <button
                onClick={handleChangePassword}
                disabled={loading}
                className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {loading ? 'Đang xử lý...' : 'Đổi mật khẩu'}
              </button>
            </div>
          </div>

          <MessageBanners />
        </div>
      )}

      {/* ── Tab: Recovery key ───────────────────────────────────────────── */}
      {tab === 'recovery' && (
        <div className="space-y-4">
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-sm font-medium text-white mb-2">Xem Recovery Key</p>
            <p className="text-xs text-gray-400 mb-3">
              Nhập mật khẩu để xem recovery key. Giữ key này ở nơi an toàn.
            </p>
            <div className="space-y-3">
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); clearMessages(); }}
                placeholder="Nhập mật khẩu để xem recovery key"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleShowRecovery}
                disabled={loading}
                className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {loading ? 'Đang xử lý...' : 'Xem Recovery Key'}
              </button>
            </div>
          </div>

          <MessageBanners />
        </div>
      )}

      {/* ── Tab: Disable ────────────────────────────────────────────────── */}
      {tab === 'disable' && (
        <div className="space-y-4">
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-sm font-medium text-white mb-1">Tắt khoá màn hình</p>
            <p className="text-xs text-gray-400 mb-3">
              Bạn sẽ không cần mật khẩu khi mở ứng dụng nữa.
            </p>
            <div className="space-y-3">
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); clearMessages(); }}
                placeholder="Nhập mật khẩu để tắt"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleDisable}
                disabled={loading}
                className="w-full py-2 bg-red-600/80 hover:bg-red-600 text-white-important text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {loading ? 'Đang xử lý...' : 'Tắt khoá màn hình'}
              </button>
            </div>
          </div>

          <MessageBanners />
        </div>
      )}
    </div>
  );
}
