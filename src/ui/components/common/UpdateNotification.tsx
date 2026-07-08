import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { useUpdateStore, UpdateInfo, ProgressInfo, UpdateError, POSTPONE_MS, POSTPONE_OPTIONS } from '@/store/updateStore';
import { InboxIcon, MonitorIcon, RefreshIcon, SparklesIcon } from '@/components/common/icons';


const AUTO_RESTART_SECS = 120;   // đếm ngược 2 phút trước khi tự restart
const DOWNLOAD_STALL_TIMEOUT_MS = 45_000; // 45s không progress → coi như treo (macOS)

export function UpdateNotification() {
  const {
    status, updateInfo, progress, error, dismissed, postponedUntil, platform,
    setStatus, setUpdateInfo, setProgress, setError, setDismissed, setPostponedUntil, postpone,
  } = useUpdateStore();

  const [countdown, setCountdown] = useState(AUTO_RESTART_SECS);
  const [postponeOpen, setPostponeOpen] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const postponeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLight = useAppStore(s => s.theme) === 'light';
  const isMac = platform === 'darwin';

  // Bắt đầu đếm ngược khi đã tải xong
  const startCountdown = useCallback(() => {
    setCountdown(AUTO_RESTART_SECS);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current!);
          countdownRef.current = null;
          (window as any).electronAPI?.update?.install();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Hoãn với duration tuỳ chọn
  const handlePostpone = useCallback((ms: number = POSTPONE_MS) => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    setPostponeOpen(false);
    postpone(ms);
  }, [postpone]);

  // Watch postponedUntil - khi nó được set, đặt timer để re-show sau đúng thời điểm
  useEffect(() => {
    if (!postponedUntil) return;
    if (postponeTimerRef.current) clearTimeout(postponeTimerRef.current);
    const remaining = postponedUntil - Date.now();
    if (remaining <= 0) {
      setDismissed(false);
      setPostponedUntil(null);
      return;
    }
    postponeTimerRef.current = setTimeout(() => {
      setDismissed(false);
      setPostponedUntil(null);
      if (useUpdateStore.getState().status === 'downloaded') startCountdown();
    }, remaining);
    return () => { if (postponeTimerRef.current) clearTimeout(postponeTimerRef.current); };
  }, [postponedUntil, setDismissed, setPostponedUntil, startCountdown]);

  // Retry download thủ công
  const handleRetryDownload = useCallback(() => {
    setError(null);
    setStatus('downloading');
    setProgress(null);
    (window as any).electronAPI?.update?.download();
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    stallTimerRef.current = setTimeout(() => {
      setStatus('stalled');
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  }, [setError, setStatus, setProgress]);

  // Stall timer helper
  const resetStallTimer = useCallback(() => {
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    stallTimerRef.current = setTimeout(() => {
      setStatus('stalled');
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  }, [setStatus]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.on) return;

    const offAvailable = api.on('update:available', (info: UpdateInfo) => {
      setUpdateInfo(info);
      setDismissed(false);
      setError(null);
      setStatus('available');
      resetStallTimer();
    });

    const offProgress = api.on('update:progress', (p: ProgressInfo) => {
      setStatus('downloading');
      setProgress(p);
      resetStallTimer();
    });

    const offDownloaded = api.on('update:downloaded', (info: UpdateInfo) => {
      setStatus('downloaded');
      setUpdateInfo(info);
      setError(null);
      setProgress(null);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      startCountdown();
    });

    const offError = api.on('update:error', (err: UpdateError) => {
      setError(err);
      setStatus('error');
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    });

    return () => {
      offAvailable?.();
      offProgress?.();
      offDownloaded?.();
      offError?.();
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    };
  }, [startCountdown, resetStallTimer, setStatus, setUpdateInfo, setProgress, setError, setDismissed]);

  if (!updateInfo || dismissed) return null;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatCountdown = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const showStallOrError = (status === 'error' || status === 'stalled');

  return (
    <div className={`fixed bottom-5 right-5 z-[9999] w-80 rounded-2xl shadow-2xl p-4 ${
      isLight
        ? 'bg-white border border-gray-200 text-gray-800 shadow-gray-200/60'
        : 'bg-gradient-to-br from-blue-600 to-blue-700 text-white'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <p className="font-bold text-sm"><SparklesIcon className="w-4 h-4 inline" /> Bản cập nhật mới</p>
          <p className={`text-xs ${isLight ? 'text-gray-400' : 'text-blue-100'}`}>Phiên bản {updateInfo.version}</p>
        </div>
        {/* Nút hoãn có dropdown - ẩn khi đã tải xong (dùng nút riêng bên dưới) */}
        {status !== 'downloaded' && (
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setPostponeOpen(v => !v)}
              className={`w-6 h-6 flex items-center justify-center rounded-full transition-colors text-xs ${
                isLight ? 'text-gray-400 hover:text-gray-400 hover:bg-gray-100' : 'text-blue-200 hover:text-white hover:bg-white/10'
              }`}
              title="Hoãn"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                <line x1="0" y1="0" x2="10" y2="10" /><line x1="10" y1="0" x2="0" y2="10" />
              </svg>
            </button>
            {postponeOpen && (
              <div className="absolute right-0 top-full mt-1 w-28 bg-gray-900 border border-gray-600 rounded-lg shadow-xl z-50 overflow-hidden">
                {POSTPONE_OPTIONS.map(opt => (
                  <button
                    key={opt.ms}
                    onClick={() => handlePostpone(opt.ms)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-blue-600 transition-colors"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Đang tải tự động - có progress */}
      {status === 'downloading' && progress && !showStallOrError && (
        <div className="mt-2 space-y-1">
          <div className={`flex justify-between text-xs ${isLight ? 'text-gray-400' : 'text-blue-100'}`}>
            <span>Đang tải tự động...</span>
            <span>{progress.percent}%</span>
          </div>
          <div className={`rounded-full h-2 overflow-hidden ${isLight ? 'bg-gray-200' : 'bg-blue-500'}`}>
            <div
              className={`h-2 rounded-full transition-all duration-300 ${isLight ? 'bg-blue-500' : 'bg-white'}`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <div className={`flex justify-between text-xs ${isLight ? 'text-gray-400' : 'text-blue-200'}`}>
            <span>{formatBytes(progress.transferred)} / {formatBytes(progress.total)}</span>
            <span>{formatBytes(progress.bytesPerSecond)}/s</span>
          </div>
        </div>
      )}

      {/* Đang đợi tải (autoDownload đã bật, chưa có progress, chưa lỗi) */}
      {(status === 'available' || (status === 'downloading' && !progress)) && !showStallOrError && (
        <div className="mt-1 space-y-1">
          <p className={`text-xs ${isLight ? 'text-gray-400' : 'text-blue-100'}`}>
            ⏳ Đang chuẩn bị tải bản cập nhật...
          </p>
        </div>
      )}

      {/* Lỗi hoặc treo - hiện nút retry + tải thủ công */}
      {showStallOrError && (
        <div className="mt-2 space-y-2">
          <p className={`text-xs ${isLight ? 'text-red-500' : 'text-red-200'}`}>
            {error
              ? '⚠️ Không thể tải tự động. Vui lòng thử lại hoặc tải thủ công.'
              : '⚠️ Quá trình tải bị gián đoạn. Vui lòng thử lại.'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleRetryDownload}
              className={`flex-1 text-xs font-semibold py-1.5 rounded-lg transition-colors ${
                isLight
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-white/20 hover:bg-white/30 text-white'
              }`}
            ><RefreshIcon className="w-4 h-4 inline" /> Thử lại
            </button>
            {isMac ? (
              <MacDownloadLinks version={updateInfo.version} isLight={isLight} />
            ) : (
              <a
                href="https://deplaoapp.com"
                target="_blank"
                rel="noopener noreferrer"
                className={`flex-1 text-xs font-semibold py-1.5 rounded-lg text-center transition-colors ${
                  isLight
                    ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                    : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
              ><InboxIcon className="w-4 h-4 inline" /> Tải thủ công
              </a>
            )}
          </div>
        </div>
      )}

      {/* Đã tải xong - đếm ngược tự restart */}
      {status === 'downloaded' && (
        <div className="mt-2 space-y-2">
          <p className={`text-xs ${isLight ? 'text-gray-400' : 'text-blue-100'}`}>
            ✅ Đã tải xong. Tự khởi động lại sau <strong className={isLight ? 'text-blue-600' : 'text-white'}>{formatCountdown(countdown)}</strong>
          </p>

          {/* Progress bar đếm ngược */}
          <div className={`rounded-full h-1.5 overflow-hidden ${isLight ? 'bg-gray-200' : 'bg-blue-500/40'}`}>
            <div
              className={`h-1.5 rounded-full transition-all duration-1000 ease-linear ${isLight ? 'bg-blue-500' : 'bg-white'}`}
              style={{ width: `${(countdown / AUTO_RESTART_SECS) * 100}%` }}
            />
          </div>

          <button
            onClick={() => (window as any).electronAPI?.update?.install()}
            className={`w-full font-semibold text-sm py-1.5 rounded-lg transition-colors ${
              isLight
                ? 'bg-blue-500 hover:bg-blue-600 text-white'
                : 'bg-green-400 hover:bg-green-300 text-white'
            }`}
          >
            Khởi động lại ngay
          </button>
          {/* Hoãn với dropdown chọn thời gian */}
          <div className="relative">
            <button
              onClick={() => setPostponeOpen(v => !v)}
              className={`w-full text-xs text-center transition-colors ${
                isLight ? 'text-gray-400 hover:text-gray-400' : 'text-blue-200 hover:text-white'
              }`}
            >
              ⏰ Hoãn…
            </button>
            {postponeOpen && (
              <div className="absolute bottom-full mb-1 left-0 right-0 bg-gray-900 border border-gray-600 rounded-lg shadow-xl z-50 overflow-hidden">
                {POSTPONE_OPTIONS.map(opt => (
                  <button
                    key={opt.ms}
                    onClick={() => handlePostpone(opt.ms)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-blue-600 transition-colors"
                  >
                    ⏰ Hoãn {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** macOS: hiện 2 link tải DMG (ARM64 / Intel) */
export function MacDownloadLinks({ version, isLight }: { version: string; isLight: boolean }) {
  const baseUrl = 'https://deplaoapp.com/file';
  return (
    <div className="flex-1 flex flex-col gap-1">
      <a
        href={`${baseUrl}/Deplao-${version}-arm64.dmg`}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-xs font-semibold py-1 rounded-lg text-center transition-colors ${
          isLight
            ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            : 'bg-white/10 hover:bg-white/20 text-white'
        }`}
      >
        🍎 Apple Silicon
      </a>
      <a
        href={`${baseUrl}/Deplao-${version}.dmg`}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-xs font-semibold py-1 rounded-lg text-center transition-colors ${
          isLight
            ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            : 'bg-white/10 hover:bg-white/20 text-white'
        }`}
      ><MonitorIcon className="w-4 h-4 inline" /> Intel Mac
      </a>
    </div>
  );
}
