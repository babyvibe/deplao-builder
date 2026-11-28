import React from 'react';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import ipc from '@/lib/ipc';
import { claimInlineSound, releaseInlineSound, useInlineAutoplay } from '@/lib/media/inlineAutoplay';
import { fitMediaBox, getKnownDims, rememberDims, type MediaDims } from '@/lib/chat/media/mediaDims';
import { isTransferring, useMessageMediaProgress } from '@/lib/media/mediaProgress';
import { VideoDownloadOverlay } from './MediaDownloadProgress';
import { TelegramPostLayoutContext, telegramPostMediaAspect } from '../telegram/posts/telegramPostLayout';
import { tr } from '../../../../shared/i18n';

interface FBVideoThumbProps {
  videoPath: string;
  /** Called when user clicks play. If provided, opens inline player instead of external app. */
  onPlay?: () => void;
  /** Real size (Telegram): frame follows the video's aspect ratio; portrait video is not cropped, matches the frame before loading. */
  width?: number;
  height?: number;
  /** Message containing a video: remember the size measured from the file (old records stored 0), so the right frame shows next time. */
  dimsMsg?: any;
  /** Blurred cover image included in the message, shown until the first frame can be captured. */
  placeholderSrc?: string;
  /** Autoplay muted while on screen (Telegram, small video), see lib/media/inlineAutoplay. */
  autoPlayInline?: boolean;
  /** Duration in seconds for the time-remaining label when the file does not report a duration. */
  duration?: number;
}

/** Video frame like an image: sized to the true ratio (portrait 9:16 → 203 × 360), so no part of the video is cropped. */
export function fitVideoBox(dims: MediaDims | null): { width: number; height: number } {
  return dims ? fitMediaBox(dims, { maxW: 280, maxH: 360, minW: 120, minH: 90 }) : { width: 280, height: 160 };
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function FBVideoThumb({ videoPath, onPlay, width, height, dimsMsg, placeholderSrc, autoPlayInline, duration }: FBVideoThumbProps) {
  const [measured, setMeasured] = React.useState<MediaDims | null>(() => (dimsMsg ? getKnownDims(dimsMsg) : null));
  const box = fitVideoBox(width && height ? { w: width, h: height } : measured);
  // Channel post (Telegram): full width of the post (a portrait video does not narrow the frame, as in Telegram)
  const postLayout = React.useContext(TelegramPostLayoutContext);
  const postBox = postLayout ? telegramPostMediaAspect(width || measured?.w, height || measured?.h) : null;
  const boxRef = React.useRef<HTMLDivElement>(null);
  const inlineVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const soundToken = React.useRef({}).current;
  const [inlineStarted, setInlineStarted] = React.useState(false);
  const [inlineFailed, setInlineFailed] = React.useState(false);
  const [soundOn, setSoundOn] = React.useState(false);
  const [remaining, setRemaining] = React.useState<number | null>(null);
  const [thumbDataUrl, setThumbDataUrl] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState(false);

  const mediaUrl = videoPath ? toLocalMediaUrl(videoPath) : '';
  const playingInline = useInlineAutoplay(boxRef, !!autoPlayInline && !!mediaUrl && !inlineFailed);
  // No file yet (Facebook: new message just arrived, main is downloading) → progress ring + "x / y MB" instead of the play button
  const progress = useMessageMediaProgress(videoPath ? null : dimsMsg);
  const transferring = !videoPath && isTransferring(progress);

  // Ref: the message object changes on every update (reaction…), so it must not re-run the first-frame capture below
  const dimsMsgRef = React.useRef(dimsMsg);
  dimsMsgRef.current = dimsMsg;
  const noteDims = React.useCallback((w: number, h: number) => {
    if (!(w > 0 && h > 0)) return;
    if (dimsMsgRef.current) rememberDims(dimsMsgRef.current, w, h);
    setMeasured((previous) => (previous && previous.w === w && previous.h === h ? previous : { w, h }));
  }, []);

  // Has a playback slot → play (muted by default); slot lost (scrolled away, more than 3 videos, window hidden…) → release the source to free the
  // decoder, muted
  React.useEffect(() => {
    if (!playingInline) {
      setInlineStarted(false);
      setRemaining(null);
      setSoundOn(false);
      releaseInlineSound(soundToken);
      return;
    }
    const video = inlineVideoRef.current;
    if (video) {
      video.muted = true;
      void video.play().catch(() => {});
    }
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [playingInline, soundToken]);

  React.useEffect(() => () => releaseInlineSound(soundToken), [soundToken]);

  React.useEffect(() => {
    if (!mediaUrl) return;
    let mounted = true;
    let seekTimer: ReturnType<typeof setTimeout> | null = null;

    const video = document.createElement('video');
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      if (seekTimer) clearTimeout(seekTimer);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    };

    const capture = (): boolean => {
      if (video.videoWidth === 0 || video.videoHeight === 0) return false;
      if (mounted) noteDims(video.videoWidth, video.videoHeight);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 280;
        canvas.height = video.videoHeight || 160;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          if (mounted) setThumbDataUrl(dataUrl);
          return true;
        }
      } catch {}
      return false;
    };

    const onSeeked = () => {
      capture();
      cleanup();
    };

    const trySeekAndCapture = () => {
      if (!mounted) return;
      // First capture current frame (at position 0) as fallback
      capture();
      // Then seek to 0.5s for a better frame - if seeked fires, it replaces the thumb
      video.currentTime = 0.5;
      video.addEventListener('seeked', onSeeked, { once: true });
      // Safety timeout: if seek takes too long (large file), keep the frame-0 capture
      seekTimer = setTimeout(() => {
        if (mounted) cleanup();
      }, 10000);
    };

    const onLoadedData = () => {
      trySeekAndCapture();
    };

    const onError = () => {
      cleanup();
    };

    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('error', onError);
    video.src = mediaUrl;
    video.load();

    // Overall timeout for very large files (15s)
    const timeoutId = setTimeout(() => {
      if (mounted) cleanup();
    }, 15000);

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      cleanup();
    };
  }, [mediaUrl, noteDims]);

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (opening) return;
    // Use inline player callback if provided (it can also play a remote link, e.g. a Facebook video not downloaded),
    // otherwise fallback to external app
    if (onPlay) {
      onPlay();
      return;
    }
    if (!videoPath) return;
    setOpening(true);
    const p = ipc.file?.openPath(videoPath);
    if (p) p.finally(() => setOpening(false)); else setOpening(false);
  };

  // Speaker button: mute / unmute inside the frame (does not open the fullscreen player)
  const toggleSound = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = inlineVideoRef.current;
    if (!video) return;
    if (soundOn) {
      video.muted = true;
      setSoundOn(false);
      releaseInlineSound(soundToken);
      return;
    }
    claimInlineSound(soundToken, () => {
      if (inlineVideoRef.current) inlineVideoRef.current.muted = true;
      setSoundOn(false);
    });
    video.muted = false;
    video.volume = 1;
    setSoundOn(true);
    void video.play().catch(() => {});
  };

  const handleOpenFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!videoPath) return;
    const parentDir = videoPath.replace(/[/\\][^/\\]+$/, '');
    ipc.file?.openPath(parentDir);
  };

  const handleSaveAs = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!videoPath) return;
    const fileName = videoPath.replace(/[/\\]/g, '/').split('/').pop() || 'video.mp4';
    ipc.file?.saveAs({ localPath: videoPath, defaultName: fileName });
  };

  return (
    <div
      ref={boxRef}
      onClick={handlePlay}
      className={`relative group/video overflow-hidden bg-black select-none ${postBox ? '' : 'rounded-xl ring-1 ring-black/[0.12] '}${transferring ? 'cursor-progress' : 'cursor-pointer'}`}
      style={postBox ? { width: '100%', aspectRatio: String(postBox.box) } : { width: box.width, height: box.height, maxWidth: '100%' }}
      title={transferring ? tr('Đang tải video — xem được khi tải xong') : playingInline ? tr('Bấm để xem toàn màn hình') : undefined}
    >
      {/* Channel post, portrait video: the sides are filled by the blurred frame itself (as in Telegram) */}
      {postBox?.letterbox && (thumbDataUrl || placeholderSrc) && (
        <img src={thumbDataUrl || placeholderSrc} alt="" aria-hidden className="pointer-events-none absolute inset-0 w-full h-full object-cover scale-110 blur-2xl opacity-60" />
      )}
      {/* Background: captured thumbnail, blurred in-message thumb, or gray placeholder */}
      {thumbDataUrl ? (
        <img src={thumbDataUrl} alt={tr('video thumb')} className={`w-full h-full ${postBox?.letterbox ? 'relative object-contain' : 'object-cover'}`} />
      ) : placeholderSrc ? (
        <img src={placeholderSrc} alt="" className="w-full h-full object-cover blur-md scale-110" />
      ) : (
        <div className="w-full h-full bg-card flex items-center justify-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </div>
      )}

      {/* Muted autoplay (as in Telegram): click the video to open the fullscreen player, click the speaker to unmute in place */}
      {playingInline && (
        <video
          ref={inlineVideoRef}
          src={mediaUrl}
          muted={!soundOn}
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          className={`absolute inset-0 w-full h-full ${postBox?.letterbox ? 'object-contain' : 'object-cover'} pointer-events-none transition-opacity duration-200 ${inlineStarted ? 'opacity-100' : 'opacity-0'}`}
          onLoadedMetadata={(event) => noteDims(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          onPlaying={() => setInlineStarted(true)}
          onTimeUpdate={(event) => {
            const video = event.currentTarget;
            const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (duration || 0);
            if (!total) return;
            const left = Math.max(0, Math.ceil(total - video.currentTime));
            setRemaining((previous) => (previous === left ? previous : left));
          }}
          onError={() => setInlineFailed(true)}
        />
      )}

      {inlineStarted ? (
        <button
          type="button"
          onClick={toggleSound}
          title={soundOn ? tr('Tắt tiếng') : tr('Bật tiếng')}
          aria-label={soundOn ? tr('Tắt tiếng') : tr('Bật tiếng')}
          aria-pressed={soundOn}
          className="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/55 hover:bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white-important transition-colors"
        >
          {(remaining ?? duration ?? 0) > 0 && <span>{formatClock(remaining ?? duration ?? 0)}</span>}
          {soundOn ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/>
              <path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/>
              <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          )}
        </button>
      ) : transferring && progress ? (
        <VideoDownloadOverlay progress={progress} />
      ) : (
        <>
          {/* Gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50" />

          {/* Centered play button */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-14 h-14 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center group-hover/video:bg-black/80 transition-colors shadow-lg">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
          </div>
        </>
      )}

      {/* Action buttons - top right, on hover */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/video:opacity-100 transition-opacity">
        <button onClick={handleOpenFolder} title={tr('Mở thư mục')}
          className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white-important transition-colors">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
        </button>
        <button onClick={handleSaveAs} title={tr('Lưu về máy')}
          className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white-important transition-colors">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
