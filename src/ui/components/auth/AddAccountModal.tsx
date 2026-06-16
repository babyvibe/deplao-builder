import React, { useState, useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import {ZaloIcon, FacebookIcon, TelegramIcon} from '../common/ChannelBadge';
import cookieGuideImg from '../../../assets/login/hd_login_fb_cookie.png';

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
type Step = 'channel' | 'proxy' | 'detail';

export default function AddAccountModal({ onClose }: AddAccountModalProps) {
  const [step, setStep] = useState<Step>('channel');
  const [channel, setChannel] = useState<Channel>('zalo');
  const [tab, setTab] = useState<'qr' | 'cookie'>('qr');
  const [fbTab, setFbTab] = useState<'account' | 'cookie'>('account');
  const [selectedProxyId, setSelectedProxyId] = useState<number | null>(null);
  const [proxies, setProxies] = useState<any[]>([]);
  const [proxyLoading, setProxyLoading] = useState(false);

  // Load proxies khi bước proxy được hiển thị
  useEffect(() => {
    if (step === 'proxy') {
      setProxyLoading(true);
      ipc.proxy?.list().then((res) => {
        setProxies(res?.proxies || []);
      }).finally(() => setProxyLoading(false));
    }
  }, [step]);

  const handleSelectChannel = (ch: Channel) => {
    setChannel(ch);
    setStep('proxy');
  };

  const handleBack = () => {
    if (step === 'detail') setStep('proxy');
    else if (step === 'proxy') setStep('channel');
    else setStep('channel');
  };

  const headerTitle =
    step === 'channel' ? 'Thêm tài khoản'
    : step === 'proxy' ? 'Chọn Proxy (tuỳ chọn)'
    : channel === 'zalo' ? 'Đăng nhập Zalo cá nhân'
    : 'Đăng nhập Facebook cá nhân';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-2xl w-full max-w-md shadow-2xl border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            {step !== 'channel' && (
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
                <span className="absolute top-2 right-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/40">Mới</span>
                <div className="w-14 h-14 rounded-full bg-[#1877F2]/20 flex items-center justify-center group-hover:bg-[#1877F2]/30 transition-colors">
                  <FacebookIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-white font-semibold text-sm">Facebook cá nhân</p>
                  <p className="text-gray-400 text-xs mt-0.5">Tài khoản hoặc Cookie</p>
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

        {/* Step 2 — Proxy selection (chỉ Zalo) */}
        {step === 'proxy' && (
          <ProxySelectStep
            proxies={proxies}
            loading={proxyLoading}
            selectedProxyId={selectedProxyId}
            onSelect={setSelectedProxyId}
            onContinue={() => setStep('detail')}
          />
        )}

        {/* Step 3 — Login Detail */}
        {step === 'detail' && channel === 'zalo' && (
          <>
            {/* Proxy indicator */}
            {selectedProxyId && proxies.length > 0 && (
              <div className="px-6 pt-3 pb-0">
                <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-1.5">
                  <span className="text-green-400 text-sm">🔒</span>
                  <span className="text-xs text-green-300">
                    Proxy: <strong>{proxies.find(p => p.id === selectedProxyId)?.name}</strong>
                  </span>
                  <button
                    onClick={() => setSelectedProxyId(null)}
                    className="ml-auto text-gray-500 hover:text-gray-300 text-xs"
                  >✕</button>
                </div>
              </div>
            )}
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
                <QRLoginTab onSuccess={onClose} proxyId={selectedProxyId} />
              ) : (
                <CookieLoginTab onSuccess={onClose} proxyId={selectedProxyId} />
              )}
            </div>
          </>
        )}

        {step === 'detail' && channel === 'facebook' && (
          <>
            {/* Proxy indicator */}
            {selectedProxyId && proxies.length > 0 && (
              <div className="px-6 pt-3 pb-0">
                <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-1.5">
                  <span className="text-green-400 text-sm">🔒</span>
                  <span className="text-xs text-green-300">
                    Proxy: <strong>{proxies.find(p => p.id === selectedProxyId)?.name}</strong>
                  </span>
                  <button
                    onClick={() => setSelectedProxyId(null)}
                    className="ml-auto text-gray-500 hover:text-gray-300 text-xs"
                  >✕</button>
                </div>
              </div>
            )}
            {/* Facebook sub-tabs */}
            <div className="flex border-b border-gray-700">
              {(['account', 'cookie'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setFbTab(t)}
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    fbTab === t
                      ? 'text-blue-400 border-b-2 border-blue-400'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {t === 'account' ? '🔑 Tài khoản' : '🍪 Cookie'}
                </button>
              ))}
            </div>
            <div className="p-6">
              {fbTab === 'account' ? (
                <FacebookAccountLoginTab onSuccess={onClose} proxyId={selectedProxyId} />
              ) : (
                <FacebookCookieLoginTab onSuccess={onClose} proxyId={selectedProxyId} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Proxy Select Step ────────────────────────────────────────────────────────
function ProxySelectStep({
  proxies,
  loading,
  selectedProxyId,
  onSelect,
  onContinue,
}: {
  proxies: any[];
  loading: boolean;
  selectedProxyId: number | null;
  onSelect: (id: number | null) => void;
  onContinue: () => void;
}) {
  const { setView, setAddAccountModalOpen } = useAppStore();
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testError, setTestError] = useState('');

  const selectedProxy = proxies.find((p) => p.id === selectedProxyId);

  const handleTest = async () => {
    if (!selectedProxy) return;
    setTestState('testing');
    setTestError('');
    const res = await ipc.proxy?.test(selectedProxy);
    if (res?.success) {
      setTestState('ok');
    } else {
      setTestState('fail');
      setTestError(res?.error || 'Proxy không hoạt động');
    }
  };

  // Reset test state khi đổi proxy
  const handleSelect = (id: number | null) => {
    onSelect(id);
    setTestState('idle');
    setTestError('');
  };

  return (
    <div className="p-6 space-y-4">
      <p className="text-gray-400 text-sm">
        Chọn proxy cho tài khoản này (không bắt buộc).
        Nếu bỏ qua, tài khoản sẽ kết nối trực tiếp.
      </p>

      {loading ? (
        <div className="flex justify-center py-6">
          <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : proxies.length === 0 ? (
        <div className="text-center py-6 space-y-3">
          <div className="text-3xl">🔒</div>
          <p className="text-sm text-gray-400">Chưa có proxy nào được cài đặt</p>
          <button
            onClick={() => {
              setAddAccountModalOpen(false);
              setView('settings');
              window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'proxy' } }));
            }}
            className="text-blue-400 hover:text-blue-300 text-xs underline"
          >
            Vào Cài đặt → Proxy để thêm
          </button>
        </div>
      ) : (
        <div className="space-y-2 max-h-56 overflow-y-auto">
          {/* Option: No proxy */}
          <button
            onClick={() => handleSelect(null)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all ${
              selectedProxyId === null
                ? 'border-blue-500 bg-blue-500/10 text-white'
                : 'border-gray-600 text-gray-400 hover:border-gray-500'
            }`}
          >
            <span className="text-lg">🚫</span>
            <div className="text-left">
              <p className="text-sm font-medium">Không dùng proxy</p>
              <p className="text-xs text-gray-500">Kết nối trực tiếp</p>
            </div>
            {selectedProxyId === null && (
              <svg className="ml-auto text-blue-400" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 6L9 17l-5-5" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
          {proxies.map((proxy) => (
            <button
              key={proxy.id}
              onClick={() => handleSelect(proxy.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all ${
                selectedProxyId === proxy.id
                  ? 'border-blue-500 bg-blue-500/10 text-white'
                  : 'border-gray-600 text-gray-400 hover:border-gray-500'
              }`}
            >
              <span className="text-lg">🔒</span>
              <div className="text-left flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{proxy.name}</p>
                <p className="text-xs text-gray-500 font-mono truncate">
                  {proxy.type.toUpperCase()} · {proxy.host}:{proxy.port}
                </p>
              </div>
              {selectedProxyId === proxy.id && (
                <svg className="ml-auto text-blue-400 flex-shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 6L9 17l-5-5" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Test proxy section (khi đã chọn proxy cụ thể) */}
      {selectedProxy && (
        <div className={`rounded-xl p-3 border ${
          testState === 'ok' ? 'bg-green-900/20 border-green-700/40' :
          testState === 'fail' ? 'bg-red-900/20 border-red-700/40' :
          'bg-gray-750 border-gray-600'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Kiểm tra kết nối proxy trước khi đăng nhập</span>
            <button
              type="button"
              onClick={handleTest}
              disabled={testState === 'testing'}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                testState === 'ok' ? 'text-green-400 bg-green-900/30' :
                testState === 'fail' ? 'text-red-400 bg-red-900/30' :
                'text-blue-400 bg-blue-900/30 hover:bg-blue-900/50'
              }`}
            >
              {testState === 'testing' ? (
                <><svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg> Đang test...</>
              ) : testState === 'ok' ? '✅ Kết nối tốt'
              : testState === 'fail' ? '🔄 Test lại'
              : '🔌 Test ngay'}
            </button>
          </div>
          {testState === 'fail' && testError && (
            <p className="mt-2 text-xs text-red-400">⚠️ {testError}</p>
          )}
        </div>
      )}

      {/* Cảnh báo khi proxy lỗi */}
      {testState === 'fail' && (
        <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-3">
          <p className="text-xs text-yellow-400 font-medium">⚠️ Proxy không hoạt động</p>
          <p className="text-xs text-yellow-300/70 mt-1">
            Đăng nhập qua proxy lỗi sẽ thất bại. Bạn vẫn có thể tiếp tục không dùng proxy.
          </p>
        </div>
      )}

      <button
        onClick={onContinue}
        className="btn-primary text-white w-full"
      >
        {selectedProxyId ? '✅ Tiếp tục với proxy' : 'Tiếp tục không có proxy →'}
      </button>
    </div>
  );
}

// ─── QR Login Tab ─────────────────────────────────────────────────────────────

const QR_TIMEOUT_SECONDS = 60;

function QRLoginTab({ onSuccess, proxyId }: { onSuccess: () => void; proxyId?: number | null }) {
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
    await ipc.login?.loginQR(tempId.current, proxyId ?? null);
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

// ─── Facebook Account Login Tab ────────────────────────────────────────────────

function FacebookAccountLoginTab({ onSuccess, proxyId }: { onSuccess: () => void; proxyId?: number | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [twoFASecret, setTwoFASecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [need2FA, setNeed2FA] = useState(false);
  const [showSecretGuide, setShowSecretGuide] = useState(false);
  const { showNotification } = useAppStore();
  const { setAccounts } = useAccountStore();

  const handleLogin = async () => {
    if (!username.trim()) { setError('Vui lòng nhập email hoặc số điện thoại Facebook'); return; }
    if (!password) { setError('Vui lòng nhập mật khẩu'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await ipc.fb?.addAccountWithCredentials({
        username: username.trim(),
        password,
        twoFASecret: twoFASecret.trim() || undefined,
        proxyId,
      });
      if (result?.success) {
        showNotification('Đăng nhập Facebook thành công! 🎉 Đang hoàn tất thiết lập tài khoản...', 'success');

        const res = await ipc.login?.getAccounts();
        if (res?.accounts) setAccounts(res.accounts);

        showNotification('✅ Tài khoản Facebook đã được thêm vào ứng dụng!', 'success');
        onSuccess();
      } else if (result?.need2FA) {
        setNeed2FA(true);
        setError(result?.error || 'Tài khoản yêu cầu xác thực 2 yếu tố (2FA). Vui lòng nhập mã bí mật 2FA.');
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
          Email hoặc số điện thoại
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => { setUsername(e.target.value); setError(''); }}
          placeholder="example@gmail.com hoặc số điện thoại"
          className="input-field text-sm"
          disabled={loading}
          autoComplete="username"
          spellCheck={false}
        />
      </div>

      <div>
        <label className="text-xs text-gray-400 mb-1 block font-medium">
          Mật khẩu
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(''); }}
          placeholder="••••••••"
          className="input-field text-sm"
          disabled={loading}
          autoComplete="current-password"
        />
      </div>

      {/* 2FA field — luôn hiển thị */}
      <div className={`rounded-xl p-3 border transition-all ${
        need2FA
          ? 'bg-red-900/20 border-red-700/40'
          : 'bg-indigo-900/15 border-indigo-700/30'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <p className={`text-xs font-medium ${need2FA ? 'text-red-400' : 'text-indigo-300'}`}>
            {need2FA ? (
              '⚠️ Tài khoản yêu cầu xác thực 2 yếu tố (2FA)'
            ) : (
              '🔐 Mã bí mật 2FA (2FA Secret Key)'
            )}
          </p>
          <button
            type="button"
            onClick={() => setShowSecretGuide(true)}
            className="text-indigo-400 hover:text-indigo-300 text-[11px] underline underline-offset-2 transition-colors flex items-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Hướng dẫn lấy mã
          </button>
        </div>
        <input
          type="text"
          value={twoFASecret}
          onChange={(e) => { setTwoFASecret(e.target.value); setError(''); }}
          placeholder={need2FA
            ? '⚠️ Nhập mã bí mật 2FA để đăng nhập (32 ký tự)'
            : 'Nhập mã bí mật 2FA từ Facebook (để trống nếu không có)'
          }
          className={`input-field text-sm font-mono ${
            need2FA && !twoFASecret.trim()
              ? 'border-red-600 focus:border-red-500'
              : ''
          }`}
          disabled={loading}
          autoComplete="off"
          spellCheck={false}
        />
        {need2FA && (
          <p className="text-red-400/70 text-[11px] mt-1.5 flex items-center gap-1">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Bắt buộc nhập mã bí mật 2FA để đăng nhập
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-2 text-red-400 text-xs">
          {error}
        </div>
      )}

      <button
        onClick={handleLogin}
        disabled={loading || !username.trim() || !password || (need2FA && !twoFASecret.trim())}
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

      <TosFooter />

      {showSecretGuide && <SecretKeyGuidePopup onClose={() => setShowSecretGuide(false)} />}
    </div>
  );
}

// ─── Facebook Cookie Login Tab ─────────────────────────────────────────────────

function FacebookCookieLoginTab({ onSuccess, proxyId }: { onSuccess: () => void; proxyId?: number | null }) {
  const [cookie, setCookie] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const { showNotification } = useAppStore();
  const { setAccounts } = useAccountStore();

  const handleLogin = async () => {
    if (!cookie.trim()) { setError('Vui lòng dán cookie Facebook'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await ipc.fb?.addAccount({ cookie: cookie.trim(), proxyId });
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
          <button
            type="button"
            onClick={() => setShowGuide(true)}
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
          >
            📖 Xem hướng dẫn lấy Cookie Facebook
          </button>
        </p>
      </div>

      {/* Cookie expiry warning */}
      <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-3 flex gap-2.5 items-start">
        <span className="text-orange-400 text-base mt-0.5">⚠️</span>
        <div>
          <p className="text-orange-500 text-xs font-semibold mb-0.5">Lưu ý: Cookie có thời hạn</p>
          <p className="text-orange-400 text-[11px] leading-relaxed">
            Cookie Facebook sẽ <strong className="text-orange-300">hết hạn nếu bạn đăng xuất</strong> khỏi Facebook trên trình duyệt hoặc sau một thời gian dài không hoạt động hoặc Facebook nghi ngờ hoạt động bất thường. Khi cookie hết hạn, tài khoản sẽ bị ngắt kết nối và bạn cần lấy cookie mới để đăng nhập lại.
          </p>
        </div>
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

      {showGuide && <CookieGuidePopup onClose={() => setShowGuide(false)} />}
    </div>
  );
}

// ─── Cookie Guide Popup ──────────────────────────────────────────────────────────

function CookieGuidePopup({ onClose }: { onClose: () => void }) {
  const steps = [
    { title: 'Mở Facebook trên trình duyệt, đăng nhập', desc: 'Dùng Chrome, Edge hoặc Cốc Cốc.' },
    { title: 'Nhấn F12 → chọn tab Network', desc: 'Developer Tools hiện ra. Click vào tab "Network" (Mạng).' },
    { title: 'Gõ "graphql" vào ô Filter hoặc Tìm trên danh sách request', desc: 'Nếu chưa thấy request, nhấn F5 để tải lại trang.' },
    { title: 'Click vào request graphql → tab Headers', desc: 'Bảng chi tiết mở ra, chọn tab "Headers".' },
    { title: 'Tìm dòng "Cookie" trong Request Headers', desc: 'Kéo xuống phần Request Headers, tìm dòng bắt đầu bằng cookie:.' },
    { title: 'Copy toàn bộ giá trị → dán vào ô bên trái', desc: 'Bôi đen toàn bộ chuỗi dài sau "Cookie" → Copy → Dán vào app.' },
  ];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]">
      <div className="bg-gray-800 rounded-2xl w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col shadow-2xl border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-blue-400 text-xl">🍪</span>
            <h3 className="text-white font-semibold">Hướng dẫn lấy Cookie Facebook</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </div>

        {/* Body: Left = text steps, Right = image */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left: scrollable step list */}
          <div className="w-1/2 overflow-y-auto p-6 border-r border-gray-700 space-y-1">
            {steps.map((s, i) => (
              <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-gray-700/40 transition-colors">
                <span className="w-7 h-7 rounded-full bg-blue-600/30 text-blue-400 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-white text-xs font-semibold">{s.title}</p>
                  <p className="text-gray-500 text-[11px] mt-0.5">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Right: image */}
          <div className="w-1/2 p-3 flex items-center justify-center">
            <img
              src={cookieGuideImg}
              alt="Hướng dẫn lấy cookie Facebook"
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-700 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            ✅ Đã hiểu, dán cookie ngay!
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Cookie Login Tab ─────────────────────────────────────────────────────────

function CookieLoginTab({ onSuccess, proxyId }: { onSuccess: () => void; proxyId?: number | null }) {
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
      const result = await ipc.login?.loginAuth(authJson.trim(), proxyId ?? null);
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

// ─── Secret Key Guide Popup ──────────────────────────────────────────────────

function SecretKeyGuidePopup({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'have-2fa' | 'setup-2fa'>('have-2fa');

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]">
      <div className="bg-gray-800 rounded-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col shadow-2xl border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-indigo-400 text-xl">🔐</span>
            <h3 className="text-white font-semibold">Hướng dẫn lấy mã bí mật 2FA (Secret Key) từ Facebook</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </div>

        {/* Tab selector */}
        <div className="flex border-b border-gray-700">
          <button
            onClick={() => setTab('have-2fa')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === 'have-2fa'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            ✅ Đã có 2FA — Cách lấy Secret Key
          </button>
          <button
            onClick={() => setTab('setup-2fa')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === 'setup-2fa'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            🛠 Chưa có 2FA — Cách thiết lập
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-6 space-y-4">
          {tab === 'have-2fa' ? <Have2FAGuide /> : <Setup2FAGuide />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-700 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            ✅ Đã hiểu
          </button>
        </div>
      </div>
    </div>
  );
}

function Have2FAGuide() {
  const steps = [
    {
      title: 'Vào Facebook → Ảnh đại diện → Cài đặt & quyền riêng tư → Cài đặt',
      desc: 'Mở Facebook trên trình duyệt (khuyến nghị Chrome/Edge), nhấn vào ảnh đại diện góc trên bên phải, chọn "Cài đặt & quyền riêng tư" → "Cài đặt".',
    },
    {
      title: 'Chọn Trung tâm tài khoản (Accounts Center)',
      desc: 'Trong menu bên trái, tìm và chọn "Trung tâm tài khoản" (Accounts Center) — mục này thường nằm ở phía trên cùng hoặc dưới phần "Đăng nhập".',
    },
    {
      title: 'Mật khẩu và bảo mật → Xác thực hai yếu tố',
      desc: 'Trong Trung tâm tài khoản, chọn "Mật khẩu và bảo mật", sau đó chọn "Xác thực hai yếu tố" (Two-Factor Authentication).',
    },
    {
      title: 'Chọn tài khoản Facebook',
      desc: 'Nếu bạn có nhiều tài khoản, chọn tài khoản Facebook bạn muốn lấy mã bí mật.',
    },
    {
      title: 'Chọn "Ứng dụng xác thực" (Authentication App)',
      desc: 'Phương thức xác thực bạn cần tìm là "Ứng dụng xác thực" — bấm vào đó để xem chi tiết.',
    },
    {
      title: 'Tìm tùy chọn hiện mã bí mật',
      desc: (
        <span>
          Lúc này Facebook thường hiển thị <strong className="text-indigo-300">mã QR</strong>. Bên dưới hoặc cạnh mã QR
          sẽ có một trong các liên kết sau:
          <br />• "Nhập khóa theo cách thủ công"
          <br />• "Không quét được mã?"
          <br />• "Thiết lập trên thiết bị khác"
          <br />• "Can't scan it?"
          <br /><br />
          <strong className="text-indigo-300">Bấm vào đó!</strong>
        </span>
      ),
    },
    {
      title: 'Sao chép mã bí mật (Secret Key)',
      desc: (
        <span>
          Facebook sẽ hiển thị một chuỗi ký tự dạng:
          <br />
          <code className="block bg-gray-900 text-indigo-300 px-3 py-2 rounded-lg my-2 text-center text-xs font-mono tracking-widest select-all">
            ABCD EFGH IJKL MNOP QRST UVWX YZ12 3456
          </code>
          Đó là mã bí mật 2FA (Secret Key) — <strong className="text-indigo-300">copy nguyên chuỗi này</strong> (kể cả khoảng trắng, app tự xử lý) và dán vào ô "Mã bí mật 2FA" phía trên.
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-1">
      <div className="bg-indigo-900/20 border border-indigo-700/30 rounded-xl p-3 mb-4">
        <p className="text-indigo-300 text-xs leading-relaxed">
          <strong>📌 Mục "Mã bí mật (Secret Key)"</strong> không phải tài khoản Facebook nào cũng hiện sẵn vì Facebook thường xuyên thay đổi giao diện.
          Nếu bạn không thấy Secret Key trong giao diện hiện tại, hãy làm theo các bước dưới đây.
        </p>
      </div>
      {steps.map((s, i) => (
        <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-gray-700/40 transition-colors">
          <span className="w-7 h-7 rounded-full bg-indigo-600/30 text-indigo-400 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className="text-white text-xs font-semibold">{s.title}</p>
            <p className="text-gray-400 text-[11px] mt-1 leading-relaxed">{s.desc}</p>
          </div>
        </div>
      ))}

      {/* Tips */}
      <div className="bg-emerald-600 border border-emerald-700/30 rounded-xl p-3 mt-4 space-y-2">
        <p className="text-emerald-300 text-xs font-semibold">💡 Mẹo nhỏ</p>
        <ul className="text-white-important text-[11px] space-y-1.5 list-disc list-inside leading-relaxed">
          <li>Nếu đã thấy mục "Ứng dụng xác thực" hiển thị trạng thái "Đã bật" — bấm vào để xem lại mã.</li>
          <li>Dùng trình duyệt trên máy tính (không dùng app điện thoại) để dễ thao tác.</li>
          <li>Secret Key không thay đổi trừ khi bạn tắt và thiết lập lại 2FA.</li>
        </ul>
      </div>
    </div>
  );
}

function Setup2FAGuide() {
  const steps = [
    {
      title: 'Vào Facebook → Cài đặt & quyền riêng tư → Cài đặt',
      desc: 'Mở Facebook trên trình duyệt, nhấn ảnh đại diện → "Cài đặt & quyền riêng tư" → "Cài đặt".',
    },
    {
      title: 'Chọn Trung tâm tài khoản (Accounts Center)',
      desc: 'Tìm "Trung tâm tài khoản" trong menu bên trái.',
    },
    {
      title: 'Mật khẩu và bảo mật → Xác thực hai yếu tố',
      desc: 'Chọn "Mật khẩu và bảo mật" → "Xác thực hai yếu tố". Chọn tài khoản Facebook cần cấu hình.',
    },
    {
      title: 'Thêm phương thức bảo mật → Chọn "Ứng dụng xác thực"',
      desc: (
        <span>
          Nếu chưa có phương thức nào, Facebook sẽ yêu cầu chọn loại xác thực. Chọn <strong className="text-indigo-300">"Ứng dụng xác thực"</strong>
          {' '}(Authentication App) — <strong className="text-indigo-300">KHÔNG chọn SMS</strong> vì SMS không cung cấp Secret Key.
        </span>
      ),
    },
    {
      title: 'Xác nhận mật khẩu',
      desc: 'Facebook sẽ yêu cầu nhập lại mật khẩu để xác nhận quyền truy cập.',
    },
    {
      title: 'Quét mã QR — nhưng hãy tìm Secret Key',
      desc: (
        <span>
          Facebook hiển thị mã QR để quét. <strong className="text-indigo-300">Đừng vội quét!</strong> Hãy tìm một trong các liên kết sau:
          <br />• <strong className="text-indigo-300">"Nhập khóa theo cách thủ công"</strong>
          <br />• "Không quét được mã?"
          <br />• "Thiết lập trên thiết bị khác"
          <br />• "Can't scan it?"
          <br /><br />
          Bấm vào đó để hiển thị Secret Key.
        </span>
      ),
    },
    {
      title: 'Sao chép Secret Key và dán vào app',
      desc: (
        <span>
          Bạn sẽ thấy một chuỗi ký tự dạng:
          <br />
          <code className="block bg-gray-900 text-indigo-300 px-3 py-2 rounded-lg my-2 text-center text-xs font-mono tracking-widest select-all">
            ABCD EFGH IJKL MNOP QRST UVWX YZ12 3456
          </code>
          Copy chuỗi này và dán vào ô <strong className="text-indigo-300">"Mã bí mật 2FA"</strong> trong app.
        </span>
      ),
    },
    {
      title: 'Hoàn tất thiết lập 2FA trên Facebook',
      desc: (
        <span>
          Sau khi lấy được Secret Key, hãy hoàn tất các bước còn lại trên Facebook:
          <br />• Mở Google Authenticator, Authy hoặc 2FAS trên điện thoại
          <br />• Quét mã QR (hoặc nhập Secret Key thủ công)
          <br />• Nhập mã 6 số từ ứng dụng xác thực vào Facebook để xác nhận
          <br />• Lưu lại mã dự phòng nếu Facebook cung cấp
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-1">
      <div className="bg-amber-900/20 border border-amber-700/30 rounded-xl p-3 mb-4">
        <p className="text-amber-300 text-xs leading-relaxed">
          <strong>⚠️ Hướng dẫn dành cho tài khoản CHƯA bật 2FA</strong>
          {' — hoặc đã bật 2FA nhưng không tìm thấy Secret Key, cần thiết lập lại từ đầu.'}
        </p>
      </div>

      {steps.map((s, i) => (
        <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-gray-700/40 transition-colors">
          <span className="w-7 h-7 rounded-full bg-amber-600/30 text-amber-400 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className="text-white text-xs font-semibold">{s.title}</p>
            <p className="text-gray-400 text-[11px] mt-1 leading-relaxed">{s.desc}</p>
          </div>
        </div>
      ))}

      {/* When secret key is hidden */}
      <div className="bg-red-900/20 border border-red-700/30 rounded-xl p-3 mt-4">
        <p className="text-red-300 text-xs font-semibold mb-2">❓ Vẫn không thấy Secret Key?</p>
        <ul className="text-red-400 text-[11px] space-y-1.5 list-disc list-inside leading-relaxed">
          <li>Bạn đã bật 2FA từ trước — Facebook chỉ hiện QR mà không hiện khóa thủ công.</li>
          <li>Tài khoản đang dùng Passkey hoặc phương thức bảo mật khác.</li>
        </ul>
        <div className="bg-gray-900/50 rounded-lg p-3 mt-2">
          <p className="text-gray-300 text-xs font-medium mb-1">Giải pháp:</p>
          <ol className="text-gray-400 text-[11px] space-y-1.5 list-decimal list-inside leading-relaxed">
            <li>Tắt phương thức <strong className="text-red-300">"Ứng dụng xác thực"</strong> hiện tại.</li>
            <li>Thiết lập lại từ đầu theo hướng dẫn phía trên.</li>
            <li>Ở bước quét QR, tìm tùy chọn <strong className="text-red-300">"Can't scan it?"</strong> hoặc <strong className="text-red-300">"Nhập mã thủ công"</strong> để lấy Secret Key.</li>
            <li>Hoặc dùng ứng dụng 2FA đã quét trước đó để xem lại Secret Key (Authy/2FAS có tùy chọn hiển thị).</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

