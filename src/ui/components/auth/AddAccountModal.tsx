import React, { useState, useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import {ZaloIcon, FacebookIcon, TelegramIcon} from '../common/ChannelBadge';

interface AddAccountModalProps {
  onClose: () => void;
}

/** Footer điều khoản — dùng chung cho cả QR và Cookie tab */
function TosFooter() {
  const { setView, setAddAccountModalOpen } = useAppStore();
  return (
    <p className="text-gray-600 text-[11px] text-center pt-3 leading-relaxed">
      Khi bạn đăng nhập là đã đồng ý{' '}
      <button
        type="button"
        onClick={() => {
          setAddAccountModalOpen(false);
          setView('settings');
          window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction' } }));
        }}
        className="text-blue-500 hover:text-blue-400 underline underline-offset-2 transition-colors"
      >
        điều khoản sử dụng tại đây
      </button>
    </p>
  );
}

type Channel = 'zalo' | 'facebook';

export default function AddAccountModal({ onClose }: AddAccountModalProps) {
  const [step, setStep] = useState<'channel' | 'detail'>('channel');
  const [channel, setChannel] = useState<Channel>('zalo');
  const [tab, setTab] = useState<'qr' | 'cookie'>('qr');

  const handleSelectChannel = (ch: Channel) => {
    setChannel(ch);
    setStep('detail');
  };

  const handleBack = () => {
    setStep('channel');
  };

  const headerTitle = step === 'channel'
    ? 'Thêm tài khoản'
    : channel === 'zalo'
      ? 'Đăng nhập Zalo cá nhân'
      : 'Đăng nhập Facebook cá nhân';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-2xl w-full max-w-md shadow-2xl border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            {step === 'detail' && (
              <button
                onClick={handleBack}
                className="text-gray-400 hover:text-white transition-colors"
                title="Quay lại"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            <h2 className="text-white font-semibold">{headerTitle}</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </div>

        {/* Step 1 — Channel Selection */}
        {step === 'channel' && (
          <div className="p-6 space-y-4">
            <p className="text-gray-400 text-sm text-center mb-6">Chọn kênh bạn muốn thêm tài khoản</p>
            <div className="grid grid-cols-2 gap-4">
              {/* Zalo */}
              <button
                onClick={() => handleSelectChannel('zalo')}
                className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-gray-600 hover:border-blue-500 hover:bg-blue-500/10 bg-gray-700/50 transition-all group"
              >
                <div className="w-14 h-14 rounded-full bg-[#2B6AFF]/20 flex items-center justify-center group-hover:bg-[#2B6AFF]/30 transition-colors">
                  <ZaloIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-white font-semibold text-sm">Zalo cá nhân</p>
                  <p className="text-gray-400 text-xs mt-0.5">QR Code hoặc Cookie</p>
                </div>
              </button>

              {/* Facebook */}
              <button
                onClick={() => handleSelectChannel('facebook')}
                className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-gray-600 hover:border-blue-400 hover:bg-blue-400/10 bg-gray-700/50 transition-all group relative"
              >
                <span className="absolute top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">BETA</span>
                <div className="w-14 h-14 rounded-full bg-[#1877F2]/20 flex items-center justify-center group-hover:bg-[#1877F2]/30 transition-colors">
                  <FacebookIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-white font-semibold text-sm">Facebook cá nhân</p>
                  <p className="text-gray-400 text-xs mt-0.5">Đăng nhập bằng Cookie</p>
                </div>
              </button>
              {/* Telegram */}
              <button
                className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-gray-600 hover:border-blue-400 hover:bg-blue-400/10 bg-gray-700/50 transition-all group relative"
              >
                <span className="absolute top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">(Coming soon)</span>
                <div className="w-14 h-14 rounded-full bg-[#1877F2]/10 flex items-center justify-center group-hover:bg-[#1877F2]/30 transition-colors">
                  <TelegramIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-white font-semibold text-sm">Telegram</p>
                </div>
              </button>
            </div>

            <p className="text-gray-600 text-[11px] text-center pt-2">
              Thêm nhiều tài khoản để quản lý tin nhắn đa kênh
            </p>
          </div>
        )}

        {/* Step 2 — Login Detail */}
        {step === 'detail' && channel === 'zalo' && (
          <>
            {/* Zalo sub-tabs */}
            <div className="flex border-b border-gray-700">
              {(['qr', 'cookie'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    tab === t
                      ? 'text-blue-400 border-b-2 border-blue-400'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {t === 'qr' ? '📱 Quét mã QR' : '🍪 Cookies / IMEI'}
                </button>
              ))}
            </div>
            <div className="p-6">
              {tab === 'qr' ? (
                <QRLoginTab onSuccess={onClose} />
              ) : (
                <CookieLoginTab onSuccess={onClose} />
              )}
            </div>
          </>
        )}

        {step === 'detail' && channel === 'facebook' && (
          <div className="p-6">
            <FacebookLoginTab onSuccess={onClose} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── QR Login Tab ─────────────────────────────────────────────────────────────

const QR_TIMEOUT_SECONDS = 60;

function QRLoginTab({ onSuccess }: { onSuccess: () => void }) {
  const [qrData, setQrData] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'waiting' | 'scanned' | 'success' | 'expired' | 'error'>('idle');
  const [timeLeft, setTimeLeft] = useState(QR_TIMEOUT_SECONDS);
  const tempId = useRef(`qr_${Date.now()}`);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const { showNotification } = useAppStore();
  const { setAccounts, accounts: existingAccounts } = useAccountStore();

  const clearTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const startCountdown = () => {
    clearTimer();
    setTimeLeft(QR_TIMEOUT_SECONDS);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearTimer();
          setStatus('expired');
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  };

  const startQR = async () => {
    // Tạo tempId mới mỗi lần refresh
    tempId.current = `qr_${Date.now()}`;
    setQrData('');
    setStatus('loading');
    clearTimer();

    console.log('[QRLoginTab] Starting QR with tempId:', tempId.current);
    await ipc.login?.loginQR(tempId.current);
  };

  const handleRefresh = async () => {
    // Abort QR cũ trước
    if (tempId.current) {
      await ipc.login?.loginQRAbort?.(tempId.current).catch(() => {});
    }
    startQR();
  };

  useEffect(() => {
    // Subscribe to qr:update events
    const unsub = ipc.on('qr:update', (data: any) => {
      console.log('[QRLoginTab] Received qr:update:', data.status, 'tempId match:', data.tempId === tempId.current, 'qrDataUrl length:', data.qrDataUrl?.length || 0);

      if (data.tempId !== tempId.current) return;

      if (data.status === 'waiting' && data.qrDataUrl) {
        // Đảm bảo luôn có prefix
        const url = data.qrDataUrl.startsWith('data:')
          ? data.qrDataUrl
          : `data:image/png;base64,${data.qrDataUrl}`;
        setQrData(url);
        setStatus('waiting');
        startCountdown();
      }

      if (data.status === 'scanned') {
        clearTimer();
        setStatus('scanned');
      }

      if (data.status === 'success') {
        clearTimer();
        setStatus('success');
        showNotification('Đăng nhập thành công! 🎉 Đang hoàn tất thiết lập tài khoản...', 'success');
        const existingIds = new Set(existingAccounts.map(a => a.zalo_id));

        const loadAccounts = async () => {
          const res = await ipc.login?.getAccounts();
          if (res?.accounts?.length) {
            setAccounts(res.accounts);
            const newAccounts = res.accounts.filter((acc: any) => !existingIds.has(acc.zalo_id));
            if (newAccounts.length > 0) {
              showNotification('✅ Tài khoản đã được thêm vào ứng dụng!', 'success');
            }
            return true;
          }
          return false;
        };

        loadAccounts().then(async (ok) => {
          if (!ok) {
            await new Promise((r) => setTimeout(r, 500));
            await loadAccounts();
          }
          // 2nd pass sau 2.5s: ZaloLoginHelper fetch phone async sau success broadcast
          // → cần reload lại để store có đủ thông tin (phone, isBusiness)
          setTimeout(loadAccounts, 2500);
        });
        setTimeout(onSuccess, 1800);
      }

      if (data.status === 'expired' || data.status === 'declined') {
        clearTimer();
        setStatus('expired');
      }

      if (data.status === 'error') {
        clearTimer();
        setStatus('error');
      }
    });

    unsubRef.current = unsub;
    startQR();

    return () => {
      clearTimer();
      unsub();
      // Huỷ QR đang chờ để tránh orphaned background process
      ipc.login?.loginQRAbort?.(tempId.current).catch(() => {});
    };
  }, []);

  return (
    <div className="text-center">
      {/* Loading */}
      {status === 'idle' || status === 'loading' ? (
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="w-48 h-48 bg-gray-700 rounded-xl flex items-center justify-center">
            <svg className="animate-spin w-8 h-8 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <p className="text-gray-400 text-sm">Đang tạo mã QR...</p>
        </div>
      ) : null}

      {/* QR Waiting */}
      {status === 'waiting' && (
        <div className="flex flex-col items-center gap-3">
          <div className="bg-white p-3 rounded-xl shadow-lg">
            <img src={qrData} alt="QR Code" className="w-52 h-52 object-contain" />
          </div>
          <p className="text-gray-300 text-sm">Mở Zalo → Quét mã QR</p>
          <div className={`text-sm font-mono font-medium ${timeLeft <= 10 ? 'text-red-400' : 'text-gray-400'}`}>
            ⏱ {String(Math.floor(timeLeft / 60)).padStart(2, '0')}:{String(timeLeft % 60).padStart(2, '0')}
          </div>
        </div>
      )}

      {/* Scanned */}
      {status === 'scanned' && (
        <div className="py-8 flex flex-col items-center gap-3">
          <div className="text-5xl">📱</div>
          <p className="text-green-400 font-medium">Đã quét! Đang xác nhận trên điện thoại...</p>
          <svg className="animate-spin w-5 h-5 text-green-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}

      {/* Success */}
      {status === 'success' && (
        <div className="py-8 flex flex-col items-center gap-3">
          <div className="text-5xl">🎉</div>
          <p className="text-green-400 font-semibold text-lg">Đăng nhập thành công!</p>
        </div>
      )}

      {/* Expired / Error → hiện nút Làm mới */}
      {(status === 'expired' || status === 'error') && (
        <div className="py-6 flex flex-col items-center gap-4">
          <div className="text-5xl">{status === 'expired' ? '⏰' : '❌'}</div>
          <p className="text-gray-300 text-sm">
            {status === 'expired' ? 'Mã QR đã hết hạn (1 phút)' : 'Có lỗi xảy ra'}
          </p>
          <button
            onClick={handleRefresh}
            className="btn-primary text-white flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Làm mới QR
          </button>
        </div>
      )}
      <TosFooter />
    </div>
  );
}

// ─── Facebook Login Tab ───────────────────────────────────────────────────────

function FacebookLoginTab({ onSuccess }: { onSuccess: () => void }) {
  const [cookie, setCookie] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { showNotification } = useAppStore();
  const { setAccounts } = useAccountStore();

  const handleLogin = async () => {
    if (!cookie.trim()) { setError('Vui lòng dán cookie Facebook'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await ipc.fb?.addAccount({ cookie: cookie.trim() });
      if (result?.success) {
        showNotification('Đăng nhập Facebook thành công! 🎉 Đang hoàn tất thiết lập tài khoản...', 'success');

        // Reload accounts — FB account is now in unified accounts table
        const res = await ipc.login?.getAccounts();
        if (res?.accounts) setAccounts(res.accounts);

        showNotification('✅ Tài khoản Facebook đã được thêm vào ứng dụng!', 'success');

        onSuccess();
      } else {
        setError(result?.error || 'Thêm tài khoản Facebook thất bại');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Beta notice */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 flex gap-2.5 items-start">
        <span className="text-yellow-400 text-base mt-0.5">⚠️</span>
        <div>
          <p className="text-yellow-400 text-xs font-semibold mb-0.5">Tính năng đang trong giai đoạn Beta</p>
          <p className="text-yellow-300/70 text-[11px] leading-relaxed">
            Hiện chỉ đồng bộ được <strong className="text-yellow-300">tin nhắn nhóm</strong>. Tin nhắn cá nhân (1-1) bị mã hoá đầu cuối, chưa giải mã được — sẽ cập nhật trong phiên bản tới.
          </p>
        </div>
      </div>

      <div>
        <label className="text-xs text-gray-400 mb-1 block font-medium">
          Cookie Facebook{' '}
          <span className="text-gray-600 font-normal">— dán chuỗi cookie từ trình duyệt</span>
        </label>
        <textarea
          value={cookie}
          onChange={(e) => { setCookie(e.target.value); setError(''); }}
          placeholder="c_user=...; xs=...; datr=..."
          rows={6}
          className="input-field text-xs resize-none font-mono leading-relaxed"
          disabled={loading}
          spellCheck={false}
          autoComplete="off"
        />
        <p className="text-gray-600 text-[11px] mt-1">
          Mở Facebook trên trình duyệt → F12 → Application → Cookies → copy tất cả
        </p>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-2 text-red-400 text-xs">
          {error}
        </div>
      )}

      <button
        onClick={handleLogin}
        disabled={loading || !cookie.trim()}
        className="btn-primary text-white w-full"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Đang đăng nhập...
          </span>
        ) : '💙 Đăng nhập Facebook'}
      </button>
    </div>
  );
}

// ─── Cookie Login Tab ─────────────────────────────────────────────────────────

function CookieLoginTab({ onSuccess }: { onSuccess: () => void }) {
  const [authJson, setAuthJson] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { showNotification } = useAppStore();
  const { setAccounts } = useAccountStore();

  // Validate JSON khi user nhập
  const jsonError = (() => {
    if (!authJson.trim()) return '';
    try {
      const p = JSON.parse(authJson);
      if (!p.imei) return 'Thiếu trường "imei"';
      if (!p.cookies) return 'Thiếu trường "cookies"';
      if (!p.userAgent) return 'Thiếu trường "userAgent"';
      return '';
    } catch {
      return 'JSON không hợp lệ';
    }
  })();

  const handleLogin = async () => {
    if (!authJson.trim()) { setError('Vui lòng dán thông tin auth'); return; }
    if (jsonError) { setError(jsonError); return; }
    setLoading(true);
    setError('');
    try {
      const result = await ipc.login?.loginAuth(authJson.trim());
      if (result?.success) {
        showNotification('Đăng nhập thành công! 🎉 Đang hoàn tất thiết lập tài khoản...', 'success');
        const res = await ipc.login?.getAccounts();
        if (res?.accounts) setAccounts(res.accounts);
        if (result.zaloId) {
          showNotification('✅ Tài khoản đã được thêm vào ứng dụng!', 'success');
        }
        onSuccess();
      } else {
        setError(result?.error || 'Đăng nhập thất bại');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-gray-400 mb-1 block font-medium">
          Auth JSON{' '}
          <span className="text-gray-600 font-normal">
            — dán nguyên khối từ tool extract
          </span>
        </label>
        <textarea
          value={authJson}
          onChange={(e) => { setAuthJson(e.target.value); setError(''); }}
          placeholder={'{\n  "imei": "...",\n  "cookies": "...",\n  "userAgent": "..."\n}'}
          rows={7}
          className={`input-field text-xs resize-none font-mono leading-relaxed ${jsonError && authJson ? 'border-yellow-600 focus:border-yellow-500' : ''}`}
          disabled={loading}
          spellCheck={false}
          autoComplete="off"
        />
        {/* Inline JSON validation hint */}
        {jsonError && authJson && (
          <p className="text-yellow-400 text-xs mt-1">⚠ {jsonError}</p>
        )}
      </div>

      {(error) && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-2 text-red-400 text-xs">
          {error}
        </div>
      )}

      <button
        onClick={handleLogin}
        disabled={loading || !authJson.trim() || !!jsonError}
        className="btn-primary text-white w-full"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Đang đăng nhập...
          </span>
        ) : 'Đăng nhập'}
      </button>

      <p className="text-gray-600 text-xs text-center pt-1">
        Lấy auth JSON bằng cách chạy tool extract cookies từ trình duyệt
      </p>
      <TosFooter />
    </div>
  );
}

