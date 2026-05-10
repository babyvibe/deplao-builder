import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { useUpdateStore, UpdateInfo, ProgressInfo, UpdateError } from '@/store/updateStore';

const AUTO_RESTART_SECS = 120;   // đếm ngược 2 phút trước khi tự restart
const POSTPONE_MS = 60 * 60 * 1000;  // hoãn 1 giờ
const DOWNLOAD_STALL_TIMEOUT_MS = 45_000; // 45s không progress → coi như treo (macOS)

export function UpdateNotification() {
  const {
    status, updateInfo, progress, error, dismissed, platform,
    setStatus, setUpdateInfo, setProgress, setError, setDismissed,
  } = useUpdateStore();

  const [countdown, setCountdown] = useState(AUTO_RESTART_SECS);
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

  // Hoãn: ẩn popup, sau 1 giờ hiện lại
  const handlePostpone = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setDismissed(true);
    postponeTimerRef.current = setTimeout(() => {
      setDismissed(false);
      if (status === 'downloaded') startCountdown();
    }, POSTPONE_MS);
  }, [startCountdown, setDismissed, status]);

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
      if (postponeTimerRef.current) clearTimeout(postponeTimerRef.current);
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
          <p className="font-bold text-sm">🆕 Bản cập nhật mới</p>
          <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-blue-100'}`}>Phiên bản {updateInfo.version}</p>
        </div>
        {/* Nút tắt popup */}
        {status !== 'downloaded' && (
          <button
            onClick={handlePostpone}
            className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors ${
              isLight ? 'text-gray-400 hover:text-gray-600 hover:bg-gray-100' : 'text-blue-200 hover:text-white hover:bg-white/10'
            }`}
            title="Hoãn 1 giờ"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <line x1="0" y1="0" x2="10" y2="10" /><line x1="10" y1="0" x2="0" y2="10" />
            </svg>
          </button>
        )}
      </div>

      {/* Đang tải tự động — có progress */}
      {status === 'downloading' && progress && !showStallOrError && (
        <div className="mt-2 space-y-1">
          <div className={`flex justify-between text-xs ${isLight ? 'text-gray-500' : 'text-blue-100'}`}>
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
          <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-blue-100'}`}>
            ⏳ Đang chuẩn bị tải bản cập nhật...
          </p>
        </div>
      )}

      {/* Lỗi hoặc treo — hiện nút retry + tải thủ công */}
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
            >
              🔄 Thử lại
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
              >
                📥 Tải thủ công
              </a>
            )}
          </div>
        </div>
      )}

      {/* Đã tải xong — đếm ngược tự restart */}
      {status === 'downloaded' && (
        <div className="mt-2 space-y-2">
          <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-blue-100'}`}>
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
          <button
            onClick={handlePostpone}
            className={`w-full text-xs text-center transition-colors ${
              isLight ? 'text-gray-400 hover:text-gray-600' : 'text-blue-200 hover:text-white'
            }`}
          >
            ⏰ Hoãn 1 giờ
          </button>
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
      >
        💻 Intel Mac
      </a>
    </div>
  );
}
