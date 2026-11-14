import React, { useState, useEffect, useRef } from 'react';
import ipc, { type NativeLoginIpcField, type NativeLoginIpcResult, type NativeLoginIpcStep } from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import {ZaloIcon, FacebookIcon, TelegramIcon} from '../../common/avatars/ChannelBadge';
import { getChannelLabel } from '../../../../configs/channels/channelConfig';
import { CHANNEL, isFacebook, isTelegramBot, isTelegramUser } from '@/lib/channels/channelHelper';
import cookieGuideImg from '../../../../assets/login/hd_login_fb_cookie.png';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, BookIcon, CheckIcon, ClockIcon, CloseIcon, EyeIcon, EyeOffIcon, KeyIcon, LockIcon, PinIcon, PluginIcon, RefreshIcon, SmartphoneIcon, StarIcon, SunIcon, WrenchIcon } from '@/components/common/icons';
import TelegramBotLoginStep from './TelegramBotLoginStep';
import PhoneLoginTab from './PhoneLoginTab';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

interface AddAccountModalProps {
  onClose: () => void;
}

/** Terms footer, shared by the QR and Cookie tabs */
function TosFooter() {
  const { setView, setAddAccountModalOpen } = useAppStore();
  return (
    <p className="text-muted-foreground text-[11px] text-center pt-3 leading-relaxed">
      {tr('Khi bạn đăng nhập là đã đồng ý ')}
      <button
        type="button"
        onClick={() => {
          setAddAccountModalOpen(false);
          setView('settings');
          window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction' } }));
        }}
        className="text-blue-500 hover:text-blue-400 underline underline-offset-2 transition-colors"
      >
        {tr('điều khoản sử dụng tại đây')}
      </button>
    </p>
  );
}

type Channel = 'zalo' | 'facebook' | 'telegram_bot' | 'telegram_user';
type Step = 'channel' | 'proxy' | 'detail' | 'telegram' | 'telegram_user';

export default function AddAccountModal({ onClose }: AddAccountModalProps) {
  const { addAccountInitialChannel, addAccountInitialProxyId } = useAppStore();
  const initialCh = addAccountInitialChannel as Channel | null;

  // If there is an initialChannel (re-login) → skip channel selection
  const getInitialStep = (): Step => {
    if (!initialCh) return 'channel';
    if (isTelegramBot(initialCh)) return 'telegram';
    if (isTelegramUser(initialCh)) return 'telegram_user';
    return 'proxy';
  };

  const [step, setStep] = useState<Step>(getInitialStep());
  const [channel, setChannel] = useState<Channel>(initialCh || 'zalo');
  // Move to another machine: restore data from the copy on Cloudflare R2 (server, app build with the Cloudflare module).
  const canRestoreFromCloud = useEmployeeStore(s => s.mode) !== 'employee' && !!(ipc as { cloudflare?: unknown }).cloudflare;
  const openCloudRestore = () => {
    void import('../../settings/cloud/restore/RestoreWizard').then(m => { m.openRestoreWizard({ mode: 'new' }); });
  };
  const [tab, setTab] = useState<'qr' | 'cookie'>('qr');
  const [fbTab, setFbTab] = useState<'messenger_lite' | 'cookie'>('messenger_lite');
  // Re-login: preselect the account's current proxy (it can still be changed at the proxy step)
  const [selectedProxyId, setSelectedProxyId] = useState<number | null>(addAccountInitialProxyId);
  const [proxies, setProxies] = useState<any[]>([]);
  const [proxyLoading, setProxyLoading] = useState(false);

  // Load proxies when the proxy step is shown
  useEffect(() => {
    if (step === 'proxy') {
      setProxyLoading(true);
      ipc.proxy?.list().then((res) => {
        const list = res?.proxies || [];
        setProxies(list);
        // The proxy preselected for re-login may have been deleted
        if (Array.isArray(res?.proxies)) {
          setSelectedProxyId((id) => (id != null && !list.some((p: any) => p.id === id) ? null : id));
        }
      }).finally(() => setProxyLoading(false));
    }
  }, [step]);

  const handleSelectChannel = (ch: Channel) => {
    setChannel(ch);
    if (isTelegramBot(ch)) {
      setStep('telegram');
    } else if (isTelegramUser(ch)) {
      setStep('telegram_user');
    } else {
      setStep('proxy');
    }
  };

  const handleBack = () => {
    if (step === 'detail') setStep('proxy');
    else if (step === 'proxy') setStep('channel');
    else setStep('channel');
  };

  const headerTitle =
    step === 'channel' ? tr('Thêm tài khoản')
    : step === 'proxy' ? tr('Chọn Proxy (tuỳ chọn)')
    : step === 'telegram' ? tr('Kết nối Telegram Bot')
    : step === 'telegram_user' ? tr('Đăng nhập Telegram cá nhân')
    : channel === CHANNEL.ZALO ? tr('Đăng nhập {{v1}} cá nhân', { v1: getChannelLabel('zalo') })
    : tr('Đăng nhập {{v1}} cá nhân', { v1: getChannelLabel('facebook') });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card rounded-2xl w-full max-w-md shadow-2xl border border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            {step !== 'channel' && (
              <button
                onClick={handleBack}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title={tr('Quay lại')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            <h2 className="text-foreground font-semibold">{headerTitle}</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </div>

        {/* Step 1 - Channel Selection */}
        {step === 'channel' && (
          <div className="p-6 space-y-4">
            <p className="text-muted-foreground text-sm text-center mb-6">{tr('Chọn kênh bạn muốn thêm tài khoản')}</p>
            <div className="grid grid-cols-2 gap-4">
              {/* Zalo */}
              <button
                onClick={() => handleSelectChannel('zalo')}
                className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-input hover:border-blue-500 hover:bg-blue-500/10 bg-muted/50 transition-all group"
              >
                <div className="w-14 h-14 rounded-full bg-[#2B6AFF]/20 flex items-center justify-center group-hover:bg-[#2B6AFF]/30 transition-colors">
                  <ZaloIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-foreground font-semibold text-sm">{tr('Zalo cá nhân')}</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{tr('QR Code hoặc Cookie')}</p>
                </div>
              </button>

              {/* Facebook */}
              <button
                onClick={() => handleSelectChannel('facebook')}
                className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-input hover:border-blue-400 hover:bg-blue-400/10 bg-muted/50 transition-all group relative"
              >
                <div className="w-14 h-14 rounded-full bg-[#1877F2]/20 flex items-center justify-center group-hover:bg-[#1877F2]/30 transition-colors">
                  <FacebookIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-foreground font-semibold text-sm">{tr('Facebook cá nhân')}</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{tr('Tài khoản hoặc Cookie')}</p>
                </div>
              </button>
              {/* Telegram User */}
              <button
                onClick={() => handleSelectChannel('telegram_user')}
                className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-input hover:border-blue-400 hover:bg-blue-400/10 bg-muted/50 transition-all group relative"
              >
                <div className="w-14 h-14 rounded-full bg-[#0088CC]/20 flex items-center justify-center group-hover:bg-[#0088CC]/30 transition-colors">
                  <TelegramIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-foreground font-semibold text-sm">Telegram</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{tr('Đăng nhập bằng SĐT')}</p>
                </div>
              </button>
              {/* Telegram Bot */}
              <button
                  onClick={() => handleSelectChannel('telegram_bot')}
                  className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-input hover:border-blue-400 hover:bg-blue-400/10 bg-muted/50 transition-all group relative"
              >
                <div className="w-14 h-14 rounded-full bg-[#0088CC]/20 flex items-center justify-center group-hover:bg-[#0088CC]/30 transition-colors">
                  <TelegramIcon size={32} />
                </div>
                <div className="text-center">
                  <p className="text-foreground font-semibold text-sm">Telegram Bot</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{tr('Nhập Bot Token')}</p>
                </div>
              </button>
            </div>

            <p className="text-muted-foreground text-[11px] text-center pt-2">
              {tr('Thêm nhiều tài khoản để quản lý tin nhắn đa kênh')}
            </p>
            {canRestoreFromCloud && (
              <p className="text-muted-foreground text-[11px] text-center">
                {tr('Chuyển từ máy khác? ')}
                <button type="button" onClick={openCloudRestore} className="text-primary hover:underline underline-offset-2">
                  {tr('Khôi phục dữ liệu từ đám mây')}
                </button>
              </p>
            )}
          </div>
        )}

        {/* Step 2 - Proxy selection (Zalo only) */}
        {step === 'proxy' && (
          <ProxySelectStep
            proxies={proxies}
            loading={proxyLoading}
            selectedProxyId={selectedProxyId}
            onSelect={setSelectedProxyId}
            onContinue={() => setStep('detail')}
          />
        )}

        {/* Step 3 - Login Detail */}
        {step === 'detail' && channel === CHANNEL.ZALO && (
          <>
            {/* Proxy indicator */}
            {selectedProxyId && proxies.length > 0 && (
              <div className="px-6 pt-3 pb-0">
                <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-1.5">
                  <span className="text-green-400 text-sm"><LockIcon className="w-4 h-4" /></span>
                  <span className="text-xs text-green-300">
                    {tr('Proxy:')} <strong>{proxies.find(p => p.id === selectedProxyId)?.name}</strong>
                  </span>
                  <button
                    onClick={() => setSelectedProxyId(null)}
                    className="ml-auto text-muted-foreground hover:text-foreground/80 text-xs"
                  >✕</button>
                </div>
              </div>
            )}
            {/* Zalo sub-tabs */}
            <div className="flex border-b border-border">
              {(['qr', 'cookie'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    tab === t
                      ? 'text-blue-400 border-b-2 border-blue-400'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t === 'qr' ? tr('Quét mã QR') : tr('Cookies / IMEI')}
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

        {step === 'detail' && isFacebook(channel) && (
          <>
            {/* Proxy indicator */}
            {selectedProxyId && proxies.length > 0 && (
              <div className="px-6 pt-3 pb-0">
                <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-1.5">
                  <span className="text-green-400 text-sm"><LockIcon className="w-4 h-4" /></span>
                  <span className="text-xs text-green-300">
                    {tr('Proxy:')} <strong>{proxies.find(p => p.id === selectedProxyId)?.name}</strong>
                  </span>
                  <button
                    onClick={() => setSelectedProxyId(null)}
                    className="ml-auto text-muted-foreground hover:text-foreground/80 text-xs"
                  >✕</button>
                </div>
              </div>
            )}
            {/* Facebook sub-tabs */}
            <div className="flex border-b border-border">
              {(['messenger_lite', 'cookie'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setFbTab(t)}
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    fbTab === t
                      ? 'text-blue-400 border-b-2 border-blue-400'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t === 'messenger_lite' ? tr('Đăng nhập tài khoản') : tr('Cookie')}
                </button>
              ))}
            </div>
            <div className="p-6">
              {fbTab === 'messenger_lite' ? (
                <FacebookMessengerLiteLoginTab onSuccess={onClose} proxyId={selectedProxyId} />
              ) : (
                <FacebookCookieLoginTab onSuccess={onClose} proxyId={selectedProxyId} />
              )}
            </div>
          </>
        )}

        {/* Step Telegram - Bot Token */}
        {step === 'telegram' && (
          <TelegramBotLoginStep
            onSuccess={onClose}
            onBack={() => setStep('channel')}
          />
        )}

        {/* Step Telegram User - Phone Login */}
        {step === CHANNEL.TELEGRAM_USER && (
          <PhoneLoginTab
            onSuccess={onClose}
            onBack={() => setStep('channel')}
          />
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
      setTestError(res?.error || tr('Proxy không hoạt động'));
    }
  };

  // Reset the test state when the proxy changes
  const handleSelect = (id: number | null) => {
    onSelect(id);
    setTestState('idle');
    setTestError('');
  };

  return (
    <div className="p-6 space-y-4">
      <p className="text-muted-foreground text-sm">
        {trx('Chọn proxy cho tài khoản này <0>(không bắt buộc)</0>. Nếu bỏ qua, tài khoản sẽ kết nối trực tiếp.', { 0: <strong /> })}
      </p>

      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner size={6} />
        </div>
      ) : proxies.length === 0 ? (
        <div className="text-center py-6 space-y-3">
          <div className="text-3xl justify-items-center"><LockIcon className="w-4 h-4" /></div>
          <p className="text-sm text-muted-foreground">{tr('Chưa có proxy nào được cài đặt')}</p>
          <button
            onClick={() => {
              setAddAccountModalOpen(false);
              setView('settings');
              window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'proxy' } }));
            }}
            className="text-blue-400 hover:text-blue-300 text-xs underline"
          >
            {tr('Vào Cài đặt → Proxy để thêm')}
          </button>
        </div>
      ) : (
        <div className="space-y-2 max-h-56 overflow-y-auto">
          {/* Option: No proxy */}
          <button
            onClick={() => handleSelect(null)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all ${
              selectedProxyId === null
                ? 'border-blue-500 bg-blue-500/10 text-foreground'
                : 'border-input text-muted-foreground hover:border-border-strong'
            }`}
          >
            <span className="text-lg"><CloseIcon className="w-4 h-4" /></span>
            <div className="text-left">
              <p className="text-sm font-medium">{tr('Không dùng proxy')}</p>
              <p className="text-xs text-muted-foreground">{tr('Kết nối trực tiếp')}</p>
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
                  ? 'border-blue-500 bg-blue-500/10 text-foreground'
                  : 'border-input text-muted-foreground hover:border-border-strong'
              }`}
            >
              <span className="text-lg"><LockIcon className="w-4 h-4" /></span>
              <div className="text-left flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{proxy.name}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">
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

      {/* Test proxy section (when a specific proxy is selected) */}
      {selectedProxy && (
        <div className={`rounded-xl p-3 border ${
          testState === 'ok' ? 'bg-green-900/20 border-green-700/40' :
          testState === 'fail' ? 'bg-red-900/20 border-red-700/40' :
          'bg-muted border-input'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{tr('Kiểm tra kết nối proxy trước khi đăng nhập')}</span>
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
                <>{trx('<0/> Đang test...', { 0: <Spinner size={3} /> })}</>
              ) : testState === 'ok' ? <>{trx('<0/> Kết nối tốt', { 0: <CheckIcon className="w-4 h-4 inline" /> })}</>
              : testState === 'fail' ? <>{trx('<0/> Test lại', { 0: <RefreshIcon className="w-4 h-4 inline" /> })}</>
              : tr('Test ngay')}
            </button>
          </div>
          {testState === 'fail' && testError && (
            <p className="mt-2 text-xs text-red-400"><AlertIcon className="w-4 h-4 inline" /> {testError}</p>
          )}
        </div>
      )}

      {/* Warning when the proxy has an error */}
      {testState === 'fail' && (
        <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-3">
          <p className="text-xs text-yellow-400 font-medium">{trx('<0/> Proxy không hoạt động', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</p>
          <p className="text-xs text-yellow-300/70 mt-1">
            {tr('Đăng nhập qua proxy lỗi sẽ thất bại. Bạn vẫn có thể tiếp tục không dùng proxy.')}
          </p>
        </div>
      )}

      <button
        onClick={onContinue}
        className="btn-primary w-full"
      >
        {selectedProxyId ? <>{trx('<0/> Tiếp tục với proxy', { 0: <CheckIcon className="w-4 h-4 inline" /> })}</> : tr('Tiếp tục không cần proxy →')}
      </button>
    </div>
  );
}

// ─── QR Login Tab ─────────────────────────────────────────────────────────────

/**
 * zca-js cancels the QR code 100 s after it is created. It used to count 60 s: a code that could still be used was hidden and reported as expired, and the user
 * clicked Refresh, which cancelled the exact attempt just scanned → the phone reported a successful login but Deplao had no account.
 */
const QR_TIMEOUT_SECONDS = 100;

type QRStatus = 'idle' | 'loading' | 'waiting' | 'scanned' | 'success' | 'expired' | 'declined' | 'error';

function QRLoginTab({ onSuccess, proxyId }: { onSuccess: () => void; proxyId?: number | null }) {
  const [qrData, setQrData] = useState<string>('');
  const [status, setStatusState] = useState<QRStatus>('idle');
  // Current state for when the window closes (the effect's cleanup only sees the value at mount time)
  const statusRef = useRef<QRStatus>('idle');
  const setStatus = (next: QRStatus) => {
    statusRef.current = next;
    setStatusState(next);
  };
  const [errorText, setErrorText] = useState('');
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
    // Create a new tempId on every refresh
    tempId.current = `qr_${Date.now()}`;
    setQrData('');
    setErrorText('');
    setStatus('loading');
    clearTimer();

    console.log('[QRLoginTab] Starting QR with tempId:', tempId.current);
    await ipc.login?.loginQR(tempId.current, proxyId ?? null);
  };

  const handleRefresh = async () => {
    // Abort the old QR first
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
        // Make sure the prefix is always there
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
        showNotification(tr('Đăng nhập thành công! 🎉 Đang hoàn tất thiết lập tài khoản...'), 'success');
        const existingIds = new Set(existingAccounts.map(a => a.zalo_id));

        const loadAccounts = async () => {
          const res = await ipc.login?.getAccounts();
          if (res?.accounts?.length) {
            setAccounts(res.accounts);
            const newAccounts = res.accounts.filter((acc: any) => !existingIds.has(acc.zalo_id));
            if (newAccounts.length > 0) {
              showNotification(tr('✅ Tài khoản đã được thêm vào ứng dụng!'), 'success');
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
          // → needs a reload so the store has enough info (phone, isBusiness)
          setTimeout(loadAccounts, 2500);
        });
        setTimeout(onSuccess, 1800);
      }

      if (data.status === 'expired' || data.status === 'declined') {
        clearTimer();
        setStatus(data.status);
      }

      if (data.status === 'error') {
        clearTimer();
        setErrorText(typeof data.message === 'string' ? data.message : '');
        setStatus('error');
      }
    });

    unsubRef.current = unsub;
    startQR();

    return () => {
      clearTimer();
      unsub();
      // Cancel the pending QR to avoid an orphaned background process. Already scanned, waiting for confirmation on the phone → let the login attempt
      // keep running: closing the window at this point used to cancel the exact attempt the phone had just confirmed ("Operation aborted"); after that
      // useZaloEvents reloads the account list.
      if (statusRef.current === 'scanned') return;
      ipc.login?.loginQRAbort?.(tempId.current).catch(() => {});
    };
  }, []);

  return (
    <div className="text-center">
      {/* Loading */}
      {status === 'idle' || status === 'loading' ? (
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="w-48 h-48 bg-muted rounded-xl flex items-center justify-center">
            <Spinner size={8} />
          </div>
          <p className="text-muted-foreground text-sm">{tr('Đang tạo mã QR...')}</p>
        </div>
      ) : null}

      {/* QR Waiting */}
      {status === 'waiting' && (
        <div className="flex flex-col items-center gap-3">
          <div className="bg-white p-3 rounded-xl shadow-lg">
            <img src={qrData} alt={tr('QR Code')} className="w-52 h-52 object-contain" />
          </div>
          <p className="text-foreground/80 text-sm">{tr('Mở Zalo → Quét mã QR')}</p>
          <div className={`text-sm font-mono font-medium ${timeLeft <= 10 ? 'text-red-400' : 'text-muted-foreground'}`}>
            ⏱ {String(Math.floor(timeLeft / 60)).padStart(2, '0')}:{String(timeLeft % 60).padStart(2, '0')}
          </div>
        </div>
      )}

      {/* Scanned */}
      {status === 'scanned' && (
        <div className="py-8 flex flex-col items-center gap-3">
          <div className="text-5xl"><SmartphoneIcon className="w-4 h-4" /></div>
          <p className="text-green-400 font-medium">{tr('Đã quét! Đang xác nhận trên điện thoại...')}</p>
          <Spinner size={5} className="text-green-400" />
        </div>
      )}

      {/* Success */}
      {status === 'success' && (
        <div className="py-8 flex flex-col items-center gap-3">
          <div className="text-5xl"><StarIcon className="w-4 h-4" /></div>
          <p className="text-green-400 font-semibold text-lg">{tr('Đăng nhập thành công!')}</p>
        </div>
      )}

      {/* Expired / Declined / Error → show the Refresh button */}
      {(status === 'expired' || status === 'declined' || status === 'error') && (
        <div className="py-6 flex flex-col items-center gap-4">
          <div className="text-5xl">{status === 'expired' ? <ClockIcon className="w-5 h-5" /> : <CloseIcon className="w-5 h-5" />}</div>
          <p className="text-foreground/80 text-sm">
            {status === 'expired' ? tr('Mã QR đã hết hạn')
              : status === 'declined' ? tr('Đã từ chối đăng nhập trên điện thoại')
              : (errorText || tr('Có lỗi xảy ra'))}
          </p>
          <button
            onClick={handleRefresh}
            className="btn-primary flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {tr('Làm mới QR')}
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
    if (!username.trim()) { setError(tr('Vui lòng nhập email hoặc số điện thoại Facebook')); return; }
    if (!password) { setError(tr('Vui lòng nhập mật khẩu')); return; }
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
        showNotification(tr('Đăng nhập Facebook thành công! 🎉 Đang hoàn tất thiết lập tài khoản...'), 'success');

        const res = await ipc.login?.getAccounts();
        if (res?.accounts) setAccounts(res.accounts);

        showNotification(tr('✅ Tài khoản Facebook đã được thêm vào ứng dụng!'), 'success');
        onSuccess();
      } else if (result?.need2FA) {
        setNeed2FA(true);
        setError(result?.error || tr('Tài khoản yêu cầu xác thực 2 yếu tố (2FA). Vui lòng nhập mã bí mật 2FA.'));
      } else {
        setError(result?.error || tr('Đăng nhập thất bại'));
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
        <label className="text-xs text-muted-foreground mb-1 block font-medium">
          {tr('Email hoặc số điện thoại')}
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => { setUsername(e.target.value); setError(''); }}
          placeholder={tr('example@gmail.com hoặc số điện thoại')}
          className="input-field text-sm"
          disabled={loading}
          autoComplete="username"
          spellCheck={false}
        />
      </div>

      <div>
        <label className="text-xs text-muted-foreground mb-1 block font-medium">
          {tr('Mật khẩu')}
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

      {/* 2FA field - always shown */}
      <div className={`rounded-xl p-3 border transition-all ${
        need2FA
          ? 'bg-red-900/20 border-red-700/40'
          : 'bg-indigo-900/15 border-indigo-700/30'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <p className={`text-xs font-medium ${need2FA ? 'text-red-400' : 'text-indigo-300'}`}>
            {need2FA ? (
              <>{trx('<0/> Tài khoản yêu cầu xác thực 2 yếu tố (2FA)', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</>
            ) : (
              tr('Mã bí mật 2FA (2FA Secret Key)')
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
            {tr('Hướng dẫn lấy mã')}
          </button>
        </div>
        <input
          type="text"
          value={twoFASecret}
          onChange={(e) => { setTwoFASecret(e.target.value); setError(''); }}
          placeholder={need2FA
            ? tr('Nhập mã bí mật 2FA để đăng nhập (32 ký tự)')
            : tr('Nhập mã bí mật 2FA từ Facebook (để trống nếu không có)')
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
            {tr('Bắt buộc nhập mã bí mật 2FA để đăng nhập')}
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
        className="btn-primary w-full"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            {trx('<0/>Đang đăng nhập...', { 0: <Spinner size={4} /> })}
          </span>
        ) : tr('💙 Đăng nhập Facebook')}
      </button>

      <TosFooter />

      {showSecretGuide && <SecretKeyGuidePopup onClose={() => setShowSecretGuide(false)} />}
    </div>
  );
}

// ─── Facebook Messenger Lite Login Tab (fbchat-login-bridge) ────────────────

function FacebookMessengerLiteLoginTab({ onSuccess, proxyId }: { onSuccess: () => void; proxyId?: number | null }) {
  const [sessionId, setSessionId] = useState('');
  const [step, setStep] = useState<NativeLoginIpcStep | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const sessionRef = useRef('');
  const hasStartedRef = useRef(false);
  // Bumped to stop a running approval wait (new step, back, cancel, unmount).
  const waitGenRef = useRef(0);
  const { showNotification } = useAppStore();
  const { setAccounts } = useAccountStore();

  const resetSession = () => {
    waitGenRef.current++;
    sessionRef.current = '';
    setSessionId('');
    setStep(null);
    setValues({});
    setStarted(false);
    setWaiting(false);
    hasStartedRef.current = false;
  };

  const applyResult = async (result: NativeLoginIpcResult) => {
    if (!result.success) {
      // A wait interrupted by "Thử cách khác" or cancel: the caller moved on.
      if (result.cancelled) return;
      setError(result.error || tr('Xác thực Facebook thất bại.'));
      if (result.expired) resetSession();
      return;
    }
    if (result.account || result.facebookId) {
      waitGenRef.current++;
      sessionRef.current = '';
      setSessionId('');
      showNotification(tr('Đăng nhập Facebook thành công! Đang hoàn tất thiết lập tài khoản...'), 'success');
      const accounts = await ipc.login?.getAccounts();
      if (accounts?.accounts) setAccounts(accounts.accounts);
      showNotification(tr('Tài khoản Facebook đã được thêm vào ứng dụng!'), 'success');
      onSuccess();
      return;
    }
    const nextStep = result.step;
    if (!result.sessionId || !nextStep) {
      setError(tr('Facebook chưa trả về bước xác thực tiếp theo. Vui lòng thử lại.'));
      return;
    }
    sessionRef.current = result.sessionId;
    setSessionId(result.sessionId);
    setStep(nextStep);
    // Wrong password → Facebook returns to the old input step: keep the typed email/name, only clear the password and code
    setValues((prev) => Object.fromEntries((nextStep.user_input?.fields || []).map((field) => [
      field.id,
      field.default_value || (field.type === 'username' ? prev[field.id] || '' : ''),
    ])));
    setStarted(true);
    if (nextStep.type === 'display_and_wait') void waitForApproval(result.sessionId);
  };

  // Approval on another device: each call long-polls for about 90 s, so keep
  // asking until it is approved, replaced by another step or cancelled.
  const waitForApproval = async (sid: string) => {
    const gen = ++waitGenRef.current;
    setWaiting(true);
    setError('');
    try {
      while (gen === waitGenRef.current && sessionRef.current === sid) {
        const result = await ipc.fb?.waitMessengerLiteLogin({ sessionId: sid });
        if (gen !== waitGenRef.current || sessionRef.current !== sid) return;
        if (!result) {
          setError(tr('Không kiểm tra được trạng thái xác nhận.'));
          return;
        }
        if (result.success && result.waiting) continue;
        await applyResult(result);
        return;
      }
    } catch (err: any) {
      if (gen === waitGenRef.current) setError(err?.message || tr('Không kiểm tra được trạng thái xác nhận.'));
    } finally {
      if (gen === waitGenRef.current) setWaiting(false);
    }
  };

  const start = async () => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;
    setLoading(true);
    setError('');
    try {
      const result = await ipc.fb?.startMessengerLiteLogin({ proxyId });
      await applyResult(result || { success: false, error: tr('Không thể khởi tạo đăng nhập Facebook.') });
      if (!result?.success) hasStartedRef.current = false;
    } catch (err: any) {
      setError(err.message || tr('Không thể khởi tạo đăng nhập Facebook.'));
      hasStartedRef.current = false;
    } finally {
      setLoading(false);
    }
  };

  /** Run one step action (submit, back, verification window) with a spinner. */
  const runAction = async (action: () => Promise<NativeLoginIpcResult | undefined>, fallbackError: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await action();
      await applyResult(result || { success: false, error: fallbackError });
    } catch (err: any) {
      setError(err.message || fallbackError);
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    if (!sessionId) return;
    const fields = step?.user_input?.fields || [];
    const missing = fields.find((field) => !values[field.id]?.trim());
    if (missing) {
      setError(tr('Vui lòng nhập {{v1}}.', { v1: translateMessengerLiteField(missing.name, missing.id).toLowerCase() }));
      document.getElementById(messengerLiteFieldId(missing.id))?.focus();
      return;
    }
    await runAction(() => ipc.fb?.submitMessengerLiteLogin({ sessionId, input: values, proxyId }), tr('Không thể tiếp tục đăng nhập.'));
  };

  const back = async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    // Stop the wait loop; the login helper interrupts its pending poll itself.
    waitGenRef.current++;
    setWaiting(false);
    await runAction(() => ipc.fb?.backMessengerLiteLogin({ sessionId: sid }), tr('Không thể chuyển sang cách xác minh khác.'));
  };

  const openVerification = async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    await runAction(() => ipc.fb?.runMessengerLiteWebStep({ sessionId: sid }), tr('Không hoàn tất được bước xác minh.'));
  };

  // "Huỷ" abandons this attempt and reopens the credential form.
  const cancel = async () => {
    const sid = sessionRef.current;
    resetSession();
    setError('');
    if (sid) await ipc.fb?.cancelMessengerLiteLogin({ sessionId: sid }).catch(() => {});
    await start();
  };

  // Open directly on the first credential step. The user should not have to
  // understand or manually start the underlying Messenger Lite state machine.
  useEffect(() => { void start(); }, []);

  useEffect(() => () => {
    waitGenRef.current++;
    if (sessionRef.current) void ipc.fb?.cancelMessengerLiteLogin({ sessionId: sessionRef.current });
  }, []);

  // New input step: put the cursor in the first empty field (type, press Enter to continue). Wait for loading to finish, because a field
  // that is locked cannot take focus; each step only focuses once.
  const focusedStepRef = useRef<NativeLoginIpcStep | null>(null);
  useEffect(() => {
    if (loading || !step || step.type !== 'user_input' || focusedStepRef.current === step) return;
    focusedStepRef.current = step;
    const stepFields = step.user_input?.fields || [];
    const target = stepFields.find((field) => !values[field.id]?.trim()) || stepFields[0];
    if (target) document.getElementById(messengerLiteFieldId(target.id))?.focus();
  }, [step, loading, values]);

  const fields = step?.user_input?.fields || [];
  const attachment = step?.user_input?.attachments?.find((item) => item.content && item.info?.mimetype?.startsWith('image/'));
  const isInputStep = step?.type === 'user_input';
  const isWaitStep = step?.type === 'display_and_wait';
  const isWebStep = step?.type === 'cookies';
  const isGoogleStep = isWebStep && !!step?.step_id.endsWith('.google_oauth');
  const canTryAnotherWay = !!(step?.user_input?.can_cancel || step?.display_and_wait?.can_cancel);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-3 text-xs leading-relaxed text-foreground/80">
        <p className="font-semibold text-blue-400 mb-1">{tr('Đăng nhập trực tiếp, không cần tự quản lý Cookie')}</p>
        {tr('Bạn không cần sao chép hay thay Cookie thủ công khi Cookie hết hạn. Ứng dụng quản lý phiên đăng nhập; nếu Facebook yêu cầu xác minh lại, bạn chỉ cần đăng nhập lại tại đây.')}
      </div>

      {!started && !error && <div className="flex justify-center gap-2 py-5 text-sm text-muted-foreground">{trx('<0/> Đang mở biểu mẫu đăng nhập...', { 0: <Spinner size={4} /> })}</div>}
      {!started && error && <button onClick={start} disabled={loading} className="btn-primary w-full">{tr('Thử lại')}</button>}

      {started && step && (
        <>
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="text-sm font-medium text-foreground whitespace-pre-line">{translateMessengerLiteInstruction(step.instructions)}</p>
            {isWaitStep && (
              <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-2">
                {waiting && <Spinner size={4} />}
                {waiting
                  ? tr('Đang chờ bạn xác nhận trên thiết bị khác... Đăng nhập sẽ tự tiếp tục khi bạn đồng ý.')
                  : tr('Hãy xác nhận đăng nhập trên thiết bị khác rồi bấm "Kiểm tra lại".')}
              </p>
            )}
            {isWebStep && !isGoogleStep && (
              <p className="text-xs text-muted-foreground mt-1.5">{tr('Một cửa sổ xác minh sẽ mở ra. Hoàn tất thử thách trong cửa sổ đó, cửa sổ sẽ tự đóng và đăng nhập tiếp tục.')}</p>
            )}
            {isGoogleStep && (
              <p className="text-xs text-amber-400 mt-1.5">{tr('Ứng dụng chưa hỗ trợ xác minh bằng Google. Hãy thêm ứng dụng xác thực hoặc SMS làm xác thực hai lớp cho tài khoản Facebook, hoặc dùng tab đăng nhập bằng Cookie.')}</p>
            )}
          </div>
          {attachment?.content && <img src={`data:${attachment.info?.mimetype || 'image/png'};base64,${attachment.content}`} alt={tr('Captcha')} className="mx-auto max-h-28 rounded-lg border border-input" />}
          {/* Enter in the input = click "Tiếp tục" (Continue) (noValidate: validation happens in submit(), not with the browser's bubbles) */}
          <form
            noValidate
            className="space-y-3"
            onSubmit={(event) => { event.preventDefault(); if (isInputStep && !loading) void submit(); }}
          >
            {fields.map((field) => <MessengerLiteLoginField key={field.id} field={field} value={values[field.id] || ''} disabled={loading} onChange={(value) => { setValues((current) => ({ ...current, [field.id]: value })); setError(''); }} />)}
            {canTryAnotherWay && (
              <button type="button" onClick={back} disabled={loading} className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 disabled:opacity-50">
                {tr('Thử cách xác minh khác')}
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={cancel} disabled={loading} className="btn-secondary flex-1">{tr('Huỷ')}</button>
              {isInputStep && (
                <button type="submit" disabled={loading} className="btn-primary flex-[2]">
                  {loading ? <span className="flex items-center justify-center gap-2">{trx('<0/> Đang xác thực...', { 0: <Spinner size={4} /> })}</span> : tr('Tiếp tục')}
                </button>
              )}
              {isWaitStep && !waiting && (
                <button type="button" onClick={() => void waitForApproval(sessionId)} disabled={loading} className="btn-primary flex-[2]">{tr('Kiểm tra lại')}</button>
              )}
              {isWebStep && !isGoogleStep && (
                <button type="button" onClick={openVerification} disabled={loading} className="btn-primary flex-[2]">
                  {loading ? <span className="flex items-center justify-center gap-2">{trx('<0/> Đang xác minh...', { 0: <Spinner size={4} /> })}</span> : tr('Mở cửa sổ xác minh')}
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {error && <div className="bg-red-900/30 border border-red-700 rounded-lg p-2 text-red-400 text-xs">{error}</div>}
      <TosFooter />
    </div>
  );
}

/** id of the input in the login step: used to attach the label and put the cursor in the field that needs input. */
function messengerLiteFieldId(fieldId: string): string {
  return `fb-native-login-${fieldId}`;
}

function MessengerLiteLoginField({ field, value, disabled, onChange }: { field: NativeLoginIpcField; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const isSecret = field.type === 'password';
  const isCode = field.type === '2fa_code' || field.type === 'captcha_code';
  // Show the password to check it before sending
  const [revealed, setRevealed] = useState(false);
  const inputId = messengerLiteFieldId(field.id);
  const input = (
    <input id={inputId} type={isSecret && !revealed ? 'password' : 'text'} inputMode={isCode ? 'numeric' : undefined} autoComplete={isSecret ? 'current-password' : 'off'} spellCheck={isSecret ? false : undefined} autoCapitalize={isSecret ? 'off' : undefined} autoCorrect={isSecret ? 'off' : undefined} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.type === '2fa_code' ? tr('Mã 6 chữ số') : translateMessengerLiteField(field.name, field.id)} maxLength={field.max_length || undefined} pattern={field.pattern || undefined} disabled={disabled} className={`input-field text-sm ${isCode ? 'font-mono tracking-wider' : ''} ${isSecret ? 'pr-10' : ''}`} />
  );
  return (
    <div>
      <label htmlFor={inputId} className="text-xs text-foreground/80 mb-1 block font-medium">{translateMessengerLiteField(field.name, field.id)}</label>
      {field.description && <p className="text-[11px] text-muted-foreground mb-1">{translateMessengerLiteInstruction(field.description)}</p>}
      {field.type === 'select' ? (
        <select id={inputId} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="input-field text-sm">
          <option value="">{tr('Chọn một mục')}</option>
          {(field.options || []).map((option) => <option key={option} value={option}>{translateMessengerLiteOption(option)}</option>)}
        </select>
      ) : isSecret ? (
        <div className="relative">
          {input}
          {/* Like Facebook's password field: crossed-out eye = hidden, eye = shown */}
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground transition-colors"
            title={revealed ? tr('Ẩn mật khẩu') : tr('Hiện mật khẩu')}
            aria-label={revealed ? tr('Ẩn mật khẩu') : tr('Hiện mật khẩu')}
            aria-pressed={revealed}
          >
            {revealed ? <EyeIcon size={4} /> : <EyeOffIcon size={4} />}
          </button>
        </div>
      ) : input}
    </div>
  );
}

function translateMessengerLiteField(label: string, id: string): string {
  const mapped: Record<string, string> = {
    username: tr('Email hoặc tên người dùng'), password: tr('Mật khẩu'), email_code: tr('Mã xác minh từ email'),
    totp_code: tr('Mã xác thực 6 chữ số'), sms_code: tr('Mã xác minh qua SMS'), whatsapp_code: tr('Mã xác minh qua WhatsApp'),
    backup_code: tr('Mã dự phòng'), captcha_code: tr('Mã captcha'), mfatype: tr('Phương thức xác thực'),
    otp_code: tr('Mã xác minh được gửi cho bạn'), contact_point: tr('Nơi nhận mã xác minh'), dialog_action: tr('Lựa chọn'),
  };
  return mapped[id] || ({
    'Username or email address': tr('Email hoặc tên người dùng'), Password: tr('Mật khẩu'), 'Six-digit code': tr('Mã xác thực 6 chữ số'),
    'Code from email': tr('Mã xác minh từ email'), 'Login method': tr('Phương thức xác thực'), 'Captcha code': tr('Mã captcha'),
    'One-time code sent to you': tr('Mã xác minh được gửi cho bạn'), 'Phone number or email': tr('Số điện thoại hoặc email'),
    'Backup code': tr('Mã dự phòng'), 'Continue login': tr('Lựa chọn'),
  }[label] || label);
}

function translateMessengerLiteOption(value: string): string {
  return ({
    totp: tr('Ứng dụng xác thực'), sms: tr('Tin nhắn SMS'), whatsapp: 'WhatsApp', backup_code: tr('Mã dự phòng'),
    'Notification on another device': tr('Thông báo trên thiết bị khác'), 'Authentication app': tr('Ứng dụng xác thực'),
    Email: 'Email', 'Text message': tr('Tin nhắn SMS'), 'Backup code': tr('Mã dự phòng'), 'Verify with Google': tr('Xác minh bằng Google'),
    Continue: tr('Tiếp tục'), Cancel: tr('Huỷ'), Other: tr('Khác'), OK: 'OK', 'Try another way': tr('Thử cách khác'),
  }[value] || value);
}

function translateMessengerLiteInstruction(value: string): string {
  if (!value) return tr('Hoàn tất bước xác thực trên Facebook.');
  if (value.includes('Enter your Facebook credentials')) {
    if (value.includes('Invalid username or password')) return tr('Email hoặc mật khẩu chưa chính xác. Vui lòng kiểm tra và thử lại.');
    if (value.includes('rejected that login')) return tr('Facebook từ chối lần đăng nhập này. Vui lòng kiểm tra thông tin và thử lại.');
    return tr('Nhập email và mật khẩu Facebook của bạn.');
  }
  if (value.includes('Invalid username or password')) return tr('Email hoặc mật khẩu chưa chính xác. Vui lòng kiểm tra và thử lại.');
  if (value.includes("isn't connected to a Messenger account")) return tr('Tài khoản này chưa được liên kết với Messenger.');
  if (value.includes('rejected that code')) return tr('Mã xác minh chưa đúng. Vui lòng kiểm tra và nhập lại.');
  if (value.includes('That code was not sent')) return tr('Mã chưa được gửi tới Facebook. Vui lòng thử lại.');
  if (value.includes('backup codes')) return tr('Nhập một mã dự phòng của xác thực hai lớp.');
  if (value.includes('Facebook requires solving a captcha')) return tr('Facebook yêu cầu nhập mã captcha hiển thị bên trên.');
  if (value.includes('rejected that captcha')) return tr('Mã captcha chưa đúng. Vui lòng thử lại.');
  if (value.includes('Google reCAPTCHA')) return tr('Facebook yêu cầu hoàn tất thử thách Google reCAPTCHA.');
  if (value.includes('Sign in with your Google account')) return tr('Facebook yêu cầu xác minh bằng tài khoản Google.');
  if (value.includes('Choose the Facebook account')) return tr('Chọn tài khoản Facebook cần kết nối.');
  if (value.includes('Choose how to finish signing in')) return tr('Chọn phương thức để hoàn tất đăng nhập.');
  if (value.includes('Choose where to receive')) return tr('Chọn nơi nhận mã xác minh.');
  if (value.includes('rejected the login without providing a reason')) return tr('Facebook từ chối đăng nhập mà không nêu lý do. Hãy thử lại, đăng nhập trên ứng dụng/website Facebook trước, hoặc đổi cài đặt xác thực hai lớp.');
  if (/^We sent an? .*notification|^Check your notifications|^Open the notification|^You need to sign in on/.test(value)) {
    return tr('Facebook đã gửi thông báo xác nhận đến một thiết bị khác của bạn. Hãy mở thông báo và chọn đồng ý đăng nhập.');
  }
  if (value.includes('SMS code')) return tr('Nhập mã SMS vừa được gửi tới số điện thoại của bạn.');
  if (value.includes('WhatsApp')) return tr('Nhập mã vừa được gửi qua WhatsApp.');
  if (value.includes('code from your email') || value.startsWith('Enter the code') || value.startsWith('We sent a code')) return tr('Nhập mã xác minh Facebook vừa gửi cho bạn.');
  if (value.includes('six-digit')) return tr('Nhập mã xác minh gồm 6 chữ số từ ứng dụng xác thực.');
  if (value.includes('captcha')) return tr('Nhập mã captcha hiển thị bên trên.');
  if (value.includes('requires a confirmation')) return tr('Facebook yêu cầu xác nhận để tiếp tục.');
  // Dialogs and pages carry Facebook's own wording; show it rather than a
  // generic line that hides what is being asked.
  return value;
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
    if (!cookie.trim()) { setError(tr('Vui lòng dán cookie Facebook')); return; }
    setLoading(true);
    setError('');
    try {
      const result = await ipc.fb?.addAccount({ cookie: cookie.trim(), proxyId });
      if (result?.success) {
        showNotification(tr('Đăng nhập Facebook thành công! 🎉 Đang hoàn tất thiết lập tài khoản...'), 'success');

        // Reload accounts - FB account is now in unified accounts table
        const res = await ipc.login?.getAccounts();
        if (res?.accounts) setAccounts(res.accounts);

        showNotification(tr('✅ Tài khoản Facebook đã được thêm vào ứng dụng!'), 'success');

        onSuccess();
      } else {
        setError(result?.error || tr('Thêm tài khoản Facebook thất bại'));
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
        <label className="text-xs text-muted-foreground mb-1 block font-medium">
          {trx('Cookie Facebook <0>- dán chuỗi cookie từ trình duyệt</0>', { 0: <span className="text-muted-foreground font-normal" /> })}
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
        <p className="text-muted-foreground text-[11px] mt-1">
          <button
            type="button"
            onClick={() => setShowGuide(true)}
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
          >{trx('<0/> Xem hướng dẫn lấy Cookie Facebook', { 0: <BookIcon className="w-4 h-4 inline" /> })}
          </button>
        </p>
      </div>

      {/* Cookie expiry warning */}
      <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-3 flex gap-2.5 items-start">
        <span className="text-orange-400 mt-0.5"><AlertIcon className="w-4 h-4" /></span>
        <div>
          <p className="text-orange-500 text-xs font-semibold mb-0.5">{tr('Lưu ý: Cookie có thời hạn')}</p>
          <p className="text-orange-400 text-[11px] leading-relaxed">
            {trx('Cookie Facebook sẽ <0>hết hạn nếu bạn đăng xuất</0> khỏi Facebook trên trình duyệt hoặc sau một thời gian dài không hoạt động hoặc Facebook nghi ngờ hoạt động bất thường. Khi cookie hết hạn, tài khoản sẽ bị ngắt kết nối và bạn cần lấy cookie mới để đăng nhập lại.', { 0: <strong className="text-orange-300" /> })}
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
        className="btn-primary w-full"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            {trx('<0/>Đang đăng nhập...', { 0: <Spinner size={4} /> })}
          </span>
        ) : tr('💙 Đăng nhập Facebook')}
      </button>

      {showGuide && <CookieGuidePopup onClose={() => setShowGuide(false)} />}
    </div>
  );
}

// ─── Cookie Guide Popup ──────────────────────────────────────────────────────────

function CookieGuidePopup({ onClose }: { onClose: () => void }) {
  const steps = [
    { title: tr('Mở Facebook trên trình duyệt, đăng nhập'), desc: tr('Dùng Chrome, Edge hoặc Cốc Cốc.') },
    { title: tr('Nhấn F12 → chọn tab Network'), desc: tr('Developer Tools hiện ra. Click vào tab "Network" (Mạng).') },
    { title: tr('Gõ "graphql" vào ô Filter hoặc Tìm trên danh sách request'), desc: tr('Nếu chưa thấy request, nhấn F5 để tải lại trang.') },
    { title: tr('Click vào request graphql → tab Headers'), desc: tr('Bảng chi tiết mở ra, chọn tab "Headers".') },
    { title: tr('Tìm dòng "Cookie" trong Request Headers'), desc: tr('Kéo xuống phần Request Headers, tìm dòng bắt đầu bằng cookie:.') },
    { title: tr('Copy toàn bộ giá trị → dán vào ô bên trái'), desc: tr('Bôi đen toàn bộ chuỗi dài sau "Cookie" → Copy → Dán vào app.') },
  ];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]">
      <div className="bg-card rounded-2xl w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col shadow-2xl border border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-blue-400 text-xl">🍪</span>
            <h3 className="text-foreground font-semibold">{tr('Hướng dẫn lấy Cookie Facebook')}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </div>

        {/* Body: Left = text steps, Right = image */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left: scrollable step list */}
          <div className="w-1/2 overflow-y-auto p-6 border-r border-border space-y-1">
            {steps.map((s, i) => (
              <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-muted/40 transition-colors">
                <span className="w-7 h-7 rounded-full bg-blue-600/30 text-blue-400 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-foreground text-xs font-semibold">{s.title}</p>
                  <p className="text-muted-foreground text-[11px] mt-0.5">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Right: image */}
          <div className="w-1/2 p-3 flex items-center justify-center">
            <img
              src={cookieGuideImg}
              alt={tr('Hướng dẫn lấy cookie Facebook')}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            {trx('<0/> Đã hiểu, dán cookie ngay!', { 0: <CheckIcon className="w-4 h-4 inline" /> })}
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

  // Validate JSON as the user types
  const jsonError = (() => {
    if (!authJson.trim()) return '';
    try {
      const p = JSON.parse(authJson);
      if (!p.imei) return tr('Thiếu trường "imei"');
      if (!p.cookies) return tr('Thiếu trường "cookies"');
      if (!p.userAgent) return tr('Thiếu trường "userAgent"');
      return '';
    } catch {
      return tr('JSON không hợp lệ');
    }
  })();

  const handleLogin = async () => {
    if (!authJson.trim()) { setError(tr('Vui lòng dán thông tin auth')); return; }
    if (jsonError) { setError(jsonError); return; }
    setLoading(true);
    setError('');
    try {
      const result = await ipc.login?.loginAuth(authJson.trim(), proxyId ?? null);
      if (result?.success) {
        showNotification(tr('Đăng nhập thành công! 🎉 Đang hoàn tất thiết lập tài khoản...'), 'success');
        const res = await ipc.login?.getAccounts();
        if (res?.accounts) setAccounts(res.accounts);
        if (result.zaloId) {
          showNotification(tr('✅ Tài khoản đã được thêm vào ứng dụng!'), 'success');
        }
        onSuccess();
      } else {
        setError(result?.error || tr('Đăng nhập thất bại'));
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
        <label className="text-xs text-muted-foreground mb-1 block font-medium">
          {trx('Auth JSON <0>- dán nguyên khối từ tool extract</0>', { 0: <span className="text-muted-foreground font-normal" /> })}
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
        className="btn-primary w-full"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            {trx('<0/>Đang đăng nhập...', { 0: <Spinner size={4} /> })}
          </span>
        ) : tr('Đăng nhập')}
      </button>

      <p className="text-muted-foreground text-xs text-center pt-1">
        {tr('Lấy auth JSON bằng cách chạy tool extract cookies từ trình duyệt')}
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
      <div className="bg-card rounded-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col shadow-2xl border border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-indigo-400 text-xl"><LockIcon className="w-4 h-4" /></span>
            <h3 className="text-foreground font-semibold">{tr('Hướng dẫn lấy mã bí mật 2FA (Secret Key) từ Facebook')}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </div>

        {/* Tab selector */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setTab('have-2fa')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === 'have-2fa'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {trx('<0/> Đã có 2FA - Cách lấy Secret Key', { 0: <CheckIcon className="w-4 h-4 inline" /> })}
          </button>
          <button
            onClick={() => setTab('setup-2fa')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === 'setup-2fa'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >{trx('<0/> Chưa có 2FA - Cách thiết lập', { 0: <WrenchIcon className="w-4 h-4 inline" /> })}
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-6 space-y-4">
          {tab === 'have-2fa' ? <Have2FAGuide /> : <Setup2FAGuide />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            {trx('<0/> Đã hiểu', { 0: <CheckIcon className="w-4 h-4 inline" /> })}
          </button>
        </div>
      </div>
    </div>
  );
}

function Have2FAGuide() {
  const steps = [
    {
      title: tr('Vào Facebook → Ảnh đại diện → Cài đặt & quyền riêng tư → Cài đặt'),
      desc: tr('Mở Facebook trên trình duyệt (khuyến nghị Chrome/Edge), nhấn vào ảnh đại diện góc trên bên phải, chọn "Cài đặt & quyền riêng tư" → "Cài đặt".'),
    },
    {
      title: tr('Chọn Trung tâm tài khoản (Accounts Center)'),
      desc: tr('Trong menu bên trái, tìm và chọn "Trung tâm tài khoản" (Accounts Center) - mục này thường nằm ở phía trên cùng hoặc dưới phần "Đăng nhập".'),
    },
    {
      title: tr('Mật khẩu và bảo mật → Xác thực hai yếu tố'),
      desc: tr('Trong Trung tâm tài khoản, chọn "Mật khẩu và bảo mật", sau đó chọn "Xác thực hai yếu tố" (Two-Factor Authentication).'),
    },
    {
      title: tr('Chọn tài khoản Facebook'),
      desc: tr('Nếu bạn có nhiều tài khoản, chọn tài khoản Facebook bạn muốn lấy mã bí mật.'),
    },
    {
      title: tr('Chọn "Ứng dụng xác thực" (Authentication App)'),
      desc: tr('Phương thức xác thực bạn cần tìm là "Ứng dụng xác thực" - bấm vào đó để xem chi tiết.'),
    },
    {
      title: tr('Tìm tùy chọn hiện mã bí mật'),
      desc: (
        <span>
          {trx('Lúc này Facebook thường hiển thị <0>mã QR</0>. Bên dưới hoặc cạnh mã QR sẽ có một trong các liên kết sau:<1/>• "Nhập khóa theo cách thủ công"<2/>• "Không quét được mã?"<3/>• "Thiết lập trên thiết bị khác"<4/>• "Can\'t scan it?"<5/><6/><7>Bấm vào đó!</7>', { 0: <strong className="text-indigo-300" />, 1: <br />, 2: <br />, 3: <br />, 4: <br />, 5: <br />, 6: <br />, 7: <strong className="text-indigo-300" /> })}
        </span>
      ),
    },
    {
      title: tr('Sao chép mã bí mật (Secret Key)'),
      desc: (
        <span>
          {trx('Facebook sẽ hiển thị một chuỗi ký tự dạng:<0/><1>ABCD EFGH IJKL MNOP QRST UVWX YZ12 3456</1>Đó là mã bí mật 2FA (Secret Key) - <2>copy nguyên chuỗi này</2> (kể cả khoảng trắng, app tự xử lý) và dán vào ô "Mã bí mật 2FA" phía trên.', { 0: <br />, 1: <code className="block bg-card text-indigo-300 px-3 py-2 rounded-lg my-2 text-center text-xs font-mono tracking-widest select-all" />, 2: <strong className="text-indigo-300" /> })}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-1">
      <div className="bg-indigo-900/20 border border-indigo-700/30 rounded-xl p-3 mb-4">
        <p className="text-indigo-300 text-xs leading-relaxed">
          {trx('<0><1/> Mục "Mã bí mật (Secret Key)"</0> không phải tài khoản Facebook nào cũng hiện sẵn vì Facebook thường xuyên thay đổi giao diện. Nếu bạn không thấy Secret Key trong giao diện hiện tại, hãy làm theo các bước dưới đây.', { 0: <strong />, 1: <PinIcon className="w-4 h-4 inline" /> })}
        </p>
      </div>
      {steps.map((s, i) => (
        <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-muted/40 transition-colors">
          <span className="w-7 h-7 rounded-full bg-indigo-600/30 text-indigo-400 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className="text-foreground text-xs font-semibold">{s.title}</p>
            <p className="text-muted-foreground text-[11px] mt-1 leading-relaxed">{s.desc}</p>
          </div>
        </div>
      ))}

      {/* Tips */}
      <div className="bg-emerald-600 border border-emerald-700/30 rounded-xl p-3 mt-4 space-y-2">
        <p className="text-emerald-300 text-xs font-semibold">{trx('<0/> Mẹo nhỏ', { 0: <SunIcon className="w-4 h-4 inline" /> })}</p>
        <ul className="text-white-important text-[11px] space-y-1.5 list-disc list-inside leading-relaxed">
          <li>{tr('Nếu đã thấy mục "Ứng dụng xác thực" hiển thị trạng thái "Đã bật" - bấm vào để xem lại mã.')}</li>
          <li>{tr('Dùng trình duyệt trên máy tính (không dùng app điện thoại) để dễ thao tác.')}</li>
          <li>{tr('Secret Key không thay đổi trừ khi bạn tắt và thiết lập lại 2FA.')}</li>
        </ul>
      </div>
    </div>
  );
}

function Setup2FAGuide() {
  const steps = [
    {
      title: tr('Vào Facebook → Cài đặt & quyền riêng tư → Cài đặt'),
      desc: tr('Mở Facebook trên trình duyệt, nhấn ảnh đại diện → "Cài đặt & quyền riêng tư" → "Cài đặt".'),
    },
    {
      title: tr('Chọn Trung tâm tài khoản (Accounts Center)'),
      desc: tr('Tìm "Trung tâm tài khoản" trong menu bên trái.'),
    },
    {
      title: tr('Mật khẩu và bảo mật → Xác thực hai yếu tố'),
      desc: tr('Chọn "Mật khẩu và bảo mật" → "Xác thực hai yếu tố". Chọn tài khoản Facebook cần cấu hình.'),
    },
    {
      title: tr('Thêm phương thức bảo mật → Chọn "Ứng dụng xác thực"'),
      desc: (
        <span>
          {trx('Nếu chưa có phương thức nào, Facebook sẽ yêu cầu chọn loại xác thực. Chọn <0>"Ứng dụng xác thực"</0> (Authentication App) - <1>KHÔNG chọn SMS</1> vì SMS không cung cấp Secret Key.', { 0: <strong className="text-indigo-300" />, 1: <strong className="text-indigo-300" /> })}
        </span>
      ),
    },
    {
      title: tr('Xác nhận mật khẩu'),
      desc: tr('Facebook sẽ yêu cầu nhập lại mật khẩu để xác nhận quyền truy cập.'),
    },
    {
      title: tr('Quét mã QR - nhưng hãy tìm Secret Key'),
      desc: (
        <span>
          {trx('Facebook hiển thị mã QR để quét. <0>Đừng vội quét!</0> Hãy tìm một trong các liên kết sau:<1/>• <2>"Nhập khóa theo cách thủ công"</2><3/>• "Không quét được mã?"<4/>• "Thiết lập trên thiết bị khác"<5/>• "Can\'t scan it?"<6/><7/>Bấm vào đó để hiển thị Secret Key.', { 0: <strong className="text-indigo-300" />, 1: <br />, 2: <strong className="text-indigo-300" />, 3: <br />, 4: <br />, 5: <br />, 6: <br />, 7: <br /> })}
        </span>
      ),
    },
    {
      title: tr('Sao chép Secret Key và dán vào app'),
      desc: (
        <span>
          {trx('Bạn sẽ thấy một chuỗi ký tự dạng:<0/><1>ABCD EFGH IJKL MNOP QRST UVWX YZ12 3456</1>Copy chuỗi này và dán vào ô <2>"Mã bí mật 2FA"</2> trong app.', { 0: <br />, 1: <code className="block bg-card text-indigo-300 px-3 py-2 rounded-lg my-2 text-center text-xs font-mono tracking-widest select-all" />, 2: <strong className="text-indigo-300" /> })}
        </span>
      ),
    },
    {
      title: tr('Hoàn tất thiết lập 2FA trên Facebook'),
      desc: (
        <span>
          {trx('Sau khi lấy được Secret Key, hãy hoàn tất các bước còn lại trên Facebook:<0/>• Mở Google Authenticator, Authy hoặc 2FAS trên điện thoại<1/>• Quét mã QR (hoặc nhập Secret Key thủ công)<2/>• Nhập mã 6 số từ ứng dụng xác thực vào Facebook để xác nhận<3/>• Lưu lại mã dự phòng nếu Facebook cung cấp', { 0: <br />, 1: <br />, 2: <br />, 3: <br /> })}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-1">
      <div className="bg-amber-900/20 border border-amber-700/30 rounded-xl p-3 mb-4">
        <p className="text-amber-300 text-xs leading-relaxed">
          {trx('<0><1/> Hướng dẫn dành cho tài khoản CHƯA bật 2FA</0> - hoặc đã bật 2FA nhưng không tìm thấy Secret Key, cần thiết lập lại từ đầu.', { 0: <strong />, 1: <AlertIcon className="w-4 h-4 inline" /> })}
        </p>
      </div>

      {steps.map((s, i) => (
        <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-muted/40 transition-colors">
          <span className="w-7 h-7 rounded-full bg-amber-600/30 text-amber-400 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className="text-foreground text-xs font-semibold">{s.title}</p>
            <p className="text-muted-foreground text-[11px] mt-1 leading-relaxed">{s.desc}</p>
          </div>
        </div>
      ))}

      {/* When secret key is hidden */}
      <div className="bg-red-900/20 border border-red-700/30 rounded-xl p-3 mt-4">
        <p className="text-red-300 text-xs font-semibold mb-2">{tr('❓ Vẫn không thấy Secret Key?')}</p>
        <ul className="text-red-400 text-[11px] space-y-1.5 list-disc list-inside leading-relaxed">
          <li>{tr('Bạn đã bật 2FA từ trước - Facebook chỉ hiện QR mà không hiện khóa thủ công.')}</li>
          <li>{tr('Tài khoản đang dùng Passkey hoặc phương thức bảo mật khác.')}</li>
        </ul>
        <div className="bg-card rounded-lg p-3 mt-2">
          <p className="text-foreground/80 text-xs font-medium mb-1">{tr('Giải pháp:')}</p>
          <ol className="text-muted-foreground text-[11px] space-y-1.5 list-decimal list-inside leading-relaxed">
            <li>{trx('Tắt phương thức <0>"Ứng dụng xác thực"</0> hiện tại.', { 0: <strong className="text-red-300" /> })}</li>
            <li>{tr('Thiết lập lại từ đầu theo hướng dẫn phía trên.')}</li>
            <li>{trx('Ở bước quét QR, tìm tùy chọn <0>"Can\'t scan it?"</0> hoặc <1>"Nhập mã thủ công"</1> để lấy Secret Key.', { 0: <strong className="text-red-300" />, 1: <strong className="text-red-300" /> })}</li>
            <li>{tr('Hoặc dùng ứng dụng 2FA đã quét trước đó để xem lại Secret Key (Authy/2FAS có tùy chọn hiển thị).')}</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
