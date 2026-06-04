import React, { useState, useEffect, useRef, useCallback } from 'react';
import ipc from '@/lib/ipc';

interface Props {
  onUnlock: () => void;
}

type Screen = 'password' | 'recovery' | 'resetPassword';

export default function LockScreen({ onUnlock }: Props) {
  const [screen, setScreen] = useState<Screen>('password');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check cooldown on mount
  useEffect(() => {
    ipc.lockScreen.status().then(res => {
      if (res.isCoolingDown && res.remainingCooldown) {
        setCooldown(res.remainingCooldown);
      }
    });
  }, []);

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  // Focus input on mount and screen change
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [screen]);

  const handleVerify = useCallback(async () => {
    if (!password.trim() || loading || cooldown > 0) return;
    setLoading(true);
    setError('');

    try {
      const res = await ipc.lockScreen.verify({ password: password.trim() });
      if (res.success) {
        onUnlock();
      } else {
        setError(res.error || 'Sai mật khẩu');
        if (res.cooldownRemaining && res.cooldownRemaining > 0) {
          setCooldown(res.cooldownRemaining);
        }
        setPassword('');
        inputRef.current?.focus();
      }
    } catch {
      setError('Lỗi xác thực');
    } finally {
      setLoading(false);
    }
  }, [password, loading, cooldown, onUnlock]);

  const handleRecoveryVerify = useCallback(async () => {
    if (!recoveryKey.trim() || loading) return;
    setLoading(true);
    setError('');

    try {
      const res = await ipc.lockScreen.verifyRecovery({ recoveryKey: recoveryKey.trim() });
      if (res.success) {
        setScreen('resetPassword');
        setError('');
      } else {
        setError(res.error || 'Recovery key không đúng');
      }
    } catch {
      setError('Lỗi xác thực recovery key');
    } finally {
      setLoading(false);
    }
  }, [recoveryKey, loading]);

  const handleResetPassword = useCallback(async () => {
    if (loading) return;
    if (newPassword.length < 4) {
      setError('Mật khẩu phải có ít nhất 4 ký tự');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await ipc.lockScreen.resetPassword({
        recoveryKey: recoveryKey.trim(),
        newPassword,
      });
      if (res.success) {
        onUnlock();
      } else {
        setError(res.error || 'Đặt lại mật khẩu thất bại');
      }
    } catch {
      setError('Lỗi đặt lại mật khẩu');
    } finally {
      setLoading(false);
    }
  }, [newPassword, confirmPassword, recoveryKey, loading, onUnlock]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (screen === 'password') handleVerify();
      else if (screen === 'recovery') handleRecoveryVerify();
      else if (screen === 'resetPassword') handleResetPassword();
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #0f0a1e 0%, #1a0b2e 25%, #2d1b69 50%, #1e1145 75%, #0f0a1e 100%)' }}>

      {/* ── Animated background blobs ─────────────────────────────── */}
      <style>{`
        @keyframes lockFloat1 { 0%,100%{transform:translate(0,0) scale(1)} 25%{transform:translate(80px,-60px) scale(1.1)} 50%{transform:translate(-40px,80px) scale(0.9)} 75%{transform:translate(-80px,-30px) scale(1.05)} }
        @keyframes lockFloat2 { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(-100px,50px) scale(1.15)} 66%{transform:translate(60px,-80px) scale(0.85)} }
        @keyframes lockFloat3 { 0%,100%{transform:translate(0,0) rotate(0deg)} 50%{transform:translate(50px,60px) rotate(180deg)} }
        @keyframes lockSpin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
        @keyframes lockPulse { 0%,100%{opacity:0.4;transform:scale(1)} 50%{opacity:0.7;transform:scale(1.2)} }
        @keyframes lockParticle { 0%{transform:translateY(0) scale(1);opacity:0.6} 50%{opacity:1} 100%{transform:translateY(-100vh) scale(0);opacity:0} }
        @keyframes lockShimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        .lock-blob-1 { animation: lockFloat1 20s ease-in-out infinite; }
        .lock-blob-2 { animation: lockFloat2 25s ease-in-out infinite; }
        .lock-blob-3 { animation: lockFloat3 30s ease-in-out infinite; }
        .lock-orbit { animation: lockSpin 40s linear infinite; }
        .lock-pulse-ring { animation: lockPulse 3s ease-in-out infinite; }
      `}</style>

      {/* Big glowing orbs */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="lock-blob-1 absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(147,51,234,0.35) 0%, transparent 70%)', filter: 'blur(60px)' }} />
        <div className="lock-blob-2 absolute -bottom-40 -right-40 w-[600px] h-[600px] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.3) 0%, transparent 70%)', filter: 'blur(80px)' }} />
        <div className="lock-blob-3 absolute top-1/3 right-1/4 w-[350px] h-[350px] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(236,72,153,0.2) 0%, transparent 70%)', filter: 'blur(50px)' }} />
        <div className="lock-blob-2 absolute bottom-1/4 left-1/3 w-[400px] h-[400px] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.25) 0%, transparent 70%)', filter: 'blur(70px)', animationDelay: '-8s' }} />
      </div>

      {/* Orbiting ring decoration */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="lock-orbit w-[600px] h-[600px] rounded-full border border-purple-500/10" />
        <div className="absolute lock-orbit w-[750px] h-[750px] rounded-full border border-blue-500/5" style={{ animationDirection: 'reverse', animationDuration: '55s' }} />
        <div className="absolute lock-orbit w-[450px] h-[450px] rounded-full border border-pink-500/8" style={{ animationDuration: '30s' }} />
      </div>

      {/* Floating particles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[...Array(12)].map((_, i) => (
          <div key={i} className="absolute rounded-full"
            style={{
              width: 3 + (i % 4) * 2 + 'px',
              height: 3 + (i % 4) * 2 + 'px',
              left: (i * 8.3) % 100 + '%',
              bottom: '-10px',
              background: i % 3 === 0 ? '#a78bfa' : i % 3 === 1 ? '#60a5fa' : '#f472b6',
              animation: `lockParticle ${8 + i * 1.5}s linear infinite`,
              animationDelay: `${i * 0.8}s`,
              opacity: 0.5,
            }} />
        ))}
      </div>

      {/* Pulsing rings behind card */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="lock-pulse-ring w-64 h-64 rounded-full border-2 border-purple-500/20" />
        <div className="absolute lock-pulse-ring w-80 h-80 rounded-full border border-blue-500/10" style={{ animationDelay: '1s' }} />
        <div className="absolute lock-pulse-ring w-96 h-96 rounded-full border border-purple-500/5" style={{ animationDelay: '2s' }} />
      </div>

      {/* ── Main card ────────────────────────────────────────────── */}
      <div className="relative z-10 w-full max-w-md mx-4">
        {/* Logo */}
        <div className="text-center mb-6">
          <div className="relative inline-flex items-center justify-center mb-4">
            {/* Glow behind logo */}
            <div className="absolute w-24 h-24 bg-purple-500/30 rounded-full blur-2xl" />
            <div className="relative w-20 h-20 rounded-2xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #3b82f6, #ec4899)', boxShadow: '0 0 40px rgba(147,51,234,0.4), 0 0 80px rgba(59,130,246,0.2)' }}>
              <svg className="w-10 h-10 text-white-important drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
          </div>
          <h1 className="text-3xl font-bold text-white-important tracking-tight" style={{ textShadow: '0 0 30px rgba(147,51,234,0.5)' }}>Deplao</h1>
          <p className="text-white/50 text-sm mt-1 font-medium tracking-wide">Ứng dụng đã được bảo vệ</p>
        </div>

        {/* Glass card */}
        <div className="relative rounded-2xl p-8"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 25px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}>
          {/* Shimmer top edge */}
          <div className="absolute top-0 left-0 right-0 h-px overflow-hidden rounded-t-2xl">
            <div className="w-full h-full" style={{
              background: 'linear-gradient(90deg, transparent, rgba(168,85,247,0.4), rgba(59,130,246,0.4), transparent)',
              backgroundSize: '200% 100%',
              animation: 'lockShimmer 4s linear infinite',
            }} />
          </div>

          {screen === 'password' && (
            <>
              {/* Password Input */}
              <label className="block text-sm font-semibold text-white/70 mb-2 tracking-wide">Mật khẩu</label>
              <div className="relative">
                <input
                  ref={inputRef}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  onKeyDown={handleKeyDown}
                  placeholder="Nhập mật khẩu..."
                  disabled={loading || cooldown > 0}
                  className="w-full px-4 py-3 rounded-xl text-white-important placeholder-white/30 focus:outline-none disabled:opacity-50 pr-12 transition-all duration-200"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                  onFocus={e => { e.target.style.borderColor = 'rgba(147,51,234,0.5)'; e.target.style.boxShadow = '0 0 0 3px rgba(147,51,234,0.15)'; }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.12)'; e.target.style.boxShadow = 'none'; }}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition-colors"
                >
                  {showPassword ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  )}
                </button>
              </div>

              {/* Error */}
              {error && (
                <p className="mt-3 text-sm text-red-400 flex items-center gap-1.5">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {error}
                </p>
              )}

              {/* Cooldown */}
              {cooldown > 0 && (
                <p className="mt-3 text-sm text-amber-400 flex items-center gap-1.5">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  Thử lại sau {cooldown} giây
                </p>
              )}

              {/* Unlock Button */}
              <button
                onClick={handleVerify}
                disabled={!password.trim() || loading || cooldown > 0}
                className="w-full mt-6 py-3 text-white-important font-semibold rounded-xl transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-purple-500/25 hover:-translate-y-0.5 active:translate-y-0"
                style={{
                  background: 'linear-gradient(135deg, #7c3aed, #3b82f6)',
                  boxShadow: '0 4px 20px rgba(124,58,237,0.3)',
                }}
              >
                {loading ? (
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>
                )}
                {loading ? 'Đang xác thực...' : 'Mở khoá'}
              </button>

              {/* Recovery Link */}
              <button
                onClick={() => { setScreen('recovery'); setError(''); setRecoveryKey(''); }}
                className="w-full mt-4 text-sm text-white/40 hover:text-white/70 transition-colors text-center"
              >
                Quên mật khẩu?
              </button>
            </>
          )}

          {screen === 'recovery' && (
            <>
              <button
                onClick={() => { setScreen('password'); setError(''); }}
                className="flex items-center gap-1 text-sm text-white/50 hover:text-white/80 transition-colors mb-4"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                Quay lại
              </button>

              <h2 className="text-lg font-semibold text-white-important mb-2">Khôi phục bằng Recovery Key</h2>
              <p className="text-sm text-white/50 mb-4">
                Nhập recovery key đã lưu khi bạn thiết lập mật khẩu.
              </p>

              <label className="block text-sm font-semibold text-white/70 mb-2 tracking-wide">Recovery Key</label>
              <input
                ref={inputRef}
                type="text"
                value={recoveryKey}
                onChange={e => { setRecoveryKey(e.target.value.toUpperCase()); setError(''); }}
                onKeyDown={handleKeyDown}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                disabled={loading}
                className="w-full px-4 py-3 rounded-xl text-white-important placeholder-white/30 focus:outline-none disabled:opacity-50 font-mono tracking-wider transition-all duration-200"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
                onFocus={e => { e.target.style.borderColor = 'rgba(147,51,234,0.5)'; e.target.style.boxShadow = '0 0 0 3px rgba(147,51,234,0.15)'; }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.12)'; e.target.style.boxShadow = 'none'; }}
                autoComplete="off"
              />

              {error && (
                <p className="mt-3 text-sm text-red-400 flex items-center gap-1.5">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {error}
                </p>
              )}

              <button
                onClick={handleRecoveryVerify}
                disabled={!recoveryKey.trim() || loading}
                className="w-full mt-6 py-3 text-white-important font-semibold rounded-xl transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-lg hover:shadow-purple-500/25 hover:-translate-y-0.5 active:translate-y-0"
                style={{
                  background: 'linear-gradient(135deg, #7c3aed, #3b82f6)',
                  boxShadow: '0 4px 20px rgba(124,58,237,0.3)',
                }}
              >
                {loading ? 'Đang xác thực...' : 'Xác nhận Recovery Key'}
              </button>
            </>
          )}

          {screen === 'resetPassword' && (
            <>
              <h2 className="text-lg font-semibold text-white mb-2">Đặt mật khẩu mới</h2>
              <p className="text-sm text-emerald-400 mb-4 flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Recovery key hợp lệ. Hãy đặt mật khẩu mới.
              </p>

              <label className="block text-sm font-semibold text-white/70 mb-2 tracking-wide">Mật khẩu mới</label>
              <input
                ref={inputRef}
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={e => { setNewPassword(e.target.value); setError(''); }}
                placeholder="Tối thiểu 4 ký tự"
                disabled={loading}
                className="w-full px-4 py-3 rounded-xl text-white placeholder-white/30 focus:outline-none disabled:opacity-50 mb-3 transition-all duration-200"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
                onFocus={e => { e.target.style.borderColor = 'rgba(147,51,234,0.5)'; e.target.style.boxShadow = '0 0 0 3px rgba(147,51,234,0.15)'; }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.12)'; e.target.style.boxShadow = 'none'; }}
                autoComplete="new-password"
              />

              <label className="block text-sm font-semibold text-white/70 mb-2 tracking-wide">Xác nhận mật khẩu</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => { setConfirmPassword(e.target.value); setError(''); }}
                onKeyDown={handleKeyDown}
                placeholder="Nhập lại mật khẩu"
                disabled={loading}
                className="w-full px-4 py-3 rounded-xl text-white placeholder-white/30 focus:outline-none disabled:opacity-50 transition-all duration-200"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
                onFocus={e => { e.target.style.borderColor = 'rgba(147,51,234,0.5)'; e.target.style.boxShadow = '0 0 0 3px rgba(147,51,234,0.15)'; }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.12)'; e.target.style.boxShadow = 'none'; }}
                autoComplete="new-password"
              />

              <label className="flex items-center gap-2 mt-3 text-sm text-white/50 cursor-pointer hover:text-white/70 transition-colors">
                <input
                  type="checkbox"
                  checked={showPassword}
                  onChange={e => setShowPassword(e.target.checked)}
                  className="rounded accent-purple-500"
                />
                Hiện mật khẩu
              </label>

              {error && (
                <p className="mt-3 text-sm text-red-400 flex items-center gap-1.5">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {error}
                </p>
              )}

              <button
                onClick={handleResetPassword}
                disabled={!newPassword || !confirmPassword || loading}
                className="w-full mt-6 py-3 text-white font-semibold rounded-xl transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-lg hover:shadow-emerald-500/25 hover:-translate-y-0.5 active:translate-y-0"
                style={{
                  background: 'linear-gradient(135deg, #059669, #10b981)',
                  boxShadow: '0 4px 20px rgba(5,150,105,0.3)',
                }}
              >
                {loading ? 'Đang đặt lại...' : 'Đặt mật khẩu mới'}
              </button>
            </>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-white/60 text-xs mt-6 font-medium tracking-wider">
          🔐 Dữ liệu được bảo vệ bởi mã hoá cục bộ
          <br />
          Các tính năng vẫn được chạy ngầm khi bạn khoá màn hình
        </p>
      </div>
    </div>
  );
}
