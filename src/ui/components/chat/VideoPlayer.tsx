/**
 * VideoPlayer.tsx - Modal overlay cho播放 video inline (giống Telegram).
 *
 * Hỗ trợ:
 *   - Local file (local-media:// protocol)
 *   - Remote CDN URL (http/https)
 *   - Keyboard shortcuts: Space (play/pause), Esc (close), F (fullscreen), Arrow keys (seek/volume)
 *   - Toolbar: play/pause, volume, progress, time, fullscreen, download, open folder, close
 *   - Gate: chỉ decode video đang play, release khi close
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { Spinner } from '@/components/common/PageLoading';

export interface VideoPlayerProps {
  /** Local filesystem path (absolute) */
  localPath?: string;
  /** Remote URL (CDN, http/https) */
  remoteUrl?: string;
  /** Thumbnail URL for poster */
  thumbUrl?: string;
  /** Video dimensions */
  width?: number;
  height?: number;
  /** Duration in seconds */
  duration?: number;
  /** Message ID for save/repair */
  msgId?: string;
  /** Thread ID */
  threadId?: string;
  /** Close handler */
  onClose: () => void;
}

export default function VideoPlayer({
  localPath,
  remoteUrl,
  thumbUrl,
  width,
  height,
  duration: _duration,
  msgId,
  threadId,
  onClose,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false);

  // Resolve video source
  const localMediaUrl = localPath ? toLocalMediaUrl(localPath) : '';
  const videoSrc = localMediaUrl || remoteUrl || '';

  // ─── Video event handlers ───────────────────────────────────────────
  const onPlay = useCallback(() => setIsPlaying(true), []);
  const onPause = useCallback(() => setIsPlaying(false), []);
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (v) setCurrentTime(v.currentTime);
  }, []);
  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      setTotalDuration(v.duration);
      setIsBuffering(false);
    }
  }, []);
  const onWaiting = useCallback(() => setIsBuffering(true), []);
  const onCanPlay = useCallback(() => setIsBuffering(false), []);
  const onEnded = useCallback(() => setIsPlaying(false), []);
  const onStalled = useCallback(() => {
    console.warn('[VideoPlayer] Stalled:', { src: videoSrc, networkState: videoRef.current?.networkState });
  }, [videoSrc]);

  // Track retry state to avoid infinite loops
  const retryCountRef = useRef(0);

  const retryPlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    console.log('[VideoPlayer] Retrying playback');
    v.src = videoSrc + '?t=' + Date.now();
    v.load();
    v.play().catch(() => {});
  }, [videoSrc]);

  const onError = useCallback(() => {
    const v = videoRef.current;
    const error = v?.error;
    // MEDIA_ERR_ABORTED=1, MEDIA_ERR_NETWORK=2, MEDIA_ERR_DECODE=3, MEDIA_ERR_SRC_NOT_SUPPORTED=4
    const errorNames: Record<number, string> = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    console.error('[VideoPlayer] Error:', {
      src: videoSrc,
      errorCode: error?.code,
      errorName: error?.code ? errorNames[error.code] : 'UNKNOWN',
      errorMessage: error?.message,
      networkState: v?.networkState,
      readyState: v?.readyState,
    });

    // AUTO-REPAIR: If SRC_NOT_SUPPORTED for a local MP4, try ensureFaststart
    // Only attempt once per mount to avoid infinite loops
    if (error?.code === 4 && localPath && localPath.endsWith('.mp4') && retryCountRef.current === 0) {
      retryCountRef.current = 1;
      console.log('[VideoPlayer] Attempting faststart repair for:', localPath);
      setRepairing(true);
      ipc.file?.ensureFaststart({ filePath: localPath }).then((res: any) => {
        console.log('[VideoPlayer] ensureFaststart result:', res);
        setRepairing(false);
        if (res?.success) {
          // Always retry after ensureFaststart — file may already be fixed
          // or was just fixed. Use small delay to let ffmpeg finish writing.
          setTimeout(retryPlayback, 300);
        } else {
          setLoadError(true);
        }
      }).catch((err: any) => {
        console.error('[VideoPlayer] ensureFaststart error:', err);
        setLoadError(true);
        setRepairing(false);
      });
      return;
    }

    setLoadError(true);
  }, [videoSrc, localPath, retryPlayback]);

  // ─── Auto-play on mount ─────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    console.log('[VideoPlayer] Loading video:', { localPath, remoteUrl, videoSrc });
    v.play().catch(() => {});
  }, [videoSrc]);

  // ─── Auto-hide controls after 3s of inactivity ──────────────────────
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setShowControls(false);
      }
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    };
  }, []);

  // ─── Fullscreen ─────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ─── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          v.paused ? v.play() : v.pause();
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.1);
          setVolume(v.volume);
          setIsMuted(false);
          break;
        case 'ArrowDown':
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          setVolume(v.volume);
          break;
        case 'm':
          e.preventDefault();
          v.muted = !v.muted;
          setIsMuted(v.muted);
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, toggleFullscreen]);

  // ─── Progress bar click ─────────────────────────────────────────────
  const handleProgressClick = useCallback((e: React.MouseEvent) => {
    const bar = progressBarRef.current;
    const v = videoRef.current;
    if (!bar || !v) return;
    const rect = bar.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    v.currentTime = ratio * (v.duration || 0);
  }, []);

  // ─── Toggle play/pause ──────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  }, []);

  // ─── Toggle mute ────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  }, []);

  // ─── Save as ────────────────────────────────────────────────────────
  const handleSaveAs = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const defaultName = localPath
        ? localPath.replace(/.*[/\\]/, '')
        : `video_${msgId || Date.now()}.mp4`;
      await ipc.file?.saveAs({
        localPath: localPath || undefined,
        remoteUrl: remoteUrl || undefined,
        defaultName,
      });
    } finally {
      setSaving(false);
    }
  }, [saving, localPath, remoteUrl, msgId]);

  // ─── Open folder ────────────────────────────────────────────────────
  const handleOpenFolder = useCallback(() => {
    if (localPath) {
      const parentDir = localPath.replace(/[/\\][^/\\]+$/, '');
      ipc.file?.openPath(parentDir);
    }
  }, [localPath]);

  // ─── Format time ────────────────────────────────────────────────────
  const fmt = (s: number) => {
    if (!s || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // ─── Progress percentage ────────────────────────────────────────────
  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  if (!videoSrc) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center"
      onMouseMove={resetHideTimer}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* ── Video element ── */}
      <video
        ref={videoRef}
        src={videoSrc}
        poster={thumbUrl || undefined}
        className="max-w-[90vw] max-h-[80vh] object-contain"
        style={{ cursor: showControls ? 'default' : 'none' }}
        playsInline
        preload="auto"
        onPlay={onPlay}
        onPause={onPause}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onWaiting={onWaiting}
        onCanPlay={onCanPlay}
        onEnded={onEnded}
        onStalled={onStalled}
        onError={onError}
        onLoadStart={() => console.log('[VideoPlayer] onLoadStart:', videoSrc)}
        onProgress={() => {
          const v = videoRef.current;
          if (v) {
            const buffered = v.buffered;
            if (buffered.length > 0) {
              console.log('[VideoPlayer] Progress:', {
                buffered: `${buffered.start(0)}-${buffered.end(0)}`,
                currentTime: v.currentTime,
                duration: v.duration,
              });
            }
          }
        }}
        onClick={togglePlay}
      />

      {/* ── Buffering spinner ── */}
      {isBuffering && !loadError && !repairing && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-12 h-12 rounded-full border-3 border-white/20 border-t-white animate-spin" />
        </div>
      )}

      {/* ── Repairing spinner ── */}
      {repairing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <div className="w-12 h-12 rounded-full border-3 border-blue-400/30 border-t-blue-400 animate-spin" />
          <p className="text-sm text-blue-300">Đang sửa file video...</p>
        </div>
      )}

      {/* ── Load error ── */}
      {loadError && !repairing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/60">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <p className="text-sm">Không thể phát video</p>
          {localPath && (
            <button
              onClick={() => ipc.file?.openPath(localPath)}
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Mở bằng app bên ngoài
            </button>
          )}
          {remoteUrl && (
            <button
              onClick={() => ipc.shell?.openExternal(remoteUrl)}
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Mở trong trình duyệt
            </button>
          )}
        </div>
      )}

      {/* ── Top bar: filename + actions ── */}
      <div
        className={`absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent z-20 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <div className="text-white/50 text-xs truncate max-w-[60%]">
          {localPath ? localPath.replace(/.*[/\\]/, '') : ''}
        </div>
        <div className="flex items-center gap-2">
          {localPath && (
            <button
              onClick={handleOpenFolder}
              title="Mở thư mục"
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
              </svg>
            </button>
          )}
          <button
            onClick={handleSaveAs}
            disabled={saving}
            title="Lưu về máy"
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition-colors disabled:opacity-40"
          >
            {saving ? (
              <Spinner size={3} />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            )}
          </button>
          <button
            onClick={onClose}
            title="Đóng (Esc)"
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-red-600/70 flex items-center justify-center text-white/80 hover:text-white transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="1" y1="1" x2="11" y2="11"/>
              <line x1="11" y1="1" x2="1" y2="11"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Bottom controls ── */}
      <div
        className={`absolute bottom-0 left-0 right-0 px-4 pb-4 pt-10 bg-gradient-to-t from-black/80 to-transparent z-20 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        {/* Progress bar */}
        <div
          ref={progressBarRef}
          className="w-full h-1.5 bg-white/20 rounded-full cursor-pointer group/progress mb-3 relative"
          onClick={handleProgressClick}
        >
          <div
            className="h-full bg-blue-500 rounded-full relative"
            style={{ width: `${progress}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full shadow-md opacity-0 group-hover/progress:opacity-100 transition-opacity" />
          </div>
        </div>

        {/* Control buttons */}
        <div className="flex items-center gap-3">
          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            className="w-9 h-9 flex items-center justify-center text-white hover:text-blue-400 transition-colors"
            title={isPlaying ? 'Tạm dừng (Space)' : 'Phát (Space)'}
          >
            {isPlaying ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <rect x="6" y="4" width="4" height="16" rx="1"/>
                <rect x="14" y="4" width="4" height="16" rx="1"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            )}
          </button>

          {/* Volume */}
          <button
            onClick={toggleMute}
            className="w-8 h-8 flex items-center justify-center text-white/70 hover:text-white transition-colors"
            title={isMuted ? 'Bật tiếng (M)' : 'Tắt tiếng (M)'}
          >
            {isMuted || volume === 0 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" y1="9" x2="17" y2="15"/>
                <line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
            ) : volume < 0.5 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 010 7.07"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
              </svg>
            )}
          </button>

          {/* Time */}
          <span className="text-white/70 text-xs font-mono min-w-[80px]">
            {fmt(currentTime)} / {fmt(totalDuration)}
          </span>

          <div className="flex-1" />

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="w-8 h-8 flex items-center justify-center text-white/70 hover:text-white transition-colors"
            title={isFullscreen ? 'Thoát fullscreen (F)' : 'Fullscreen (F)'}
          >
            {isFullscreen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 00-2 2v3m18-5h-3m3 0v3m0 12v-3m0 3h-3M3 16v3a2 2 0 002 2h3"/>
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
