import React from 'react';
import { toLocalMediaUrl } from '@/lib/localMedia';
import ipc from '@/lib/ipc';

interface FBVideoThumbProps {
  videoPath: string;
}

export default function FBVideoThumb({ videoPath }: FBVideoThumbProps) {
  const [thumbDataUrl, setThumbDataUrl] = React.useState<string | null>(null);
  const [captureFailed, setCaptureFailed] = React.useState(false);
  const [opening, setOpening] = React.useState(false);

  const mediaUrl = videoPath ? toLocalMediaUrl(videoPath) : '';

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
      const captured = capture();
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
      if (mounted) setCaptureFailed(true);
      cleanup();
    };

    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('error', onError);
    video.src = mediaUrl;
    video.load();

    // Overall timeout for very large files (15s)
    const timeoutId = setTimeout(() => {
      if (mounted && !thumbDataUrl) {
        setCaptureFailed(true);
        cleanup();
      }
    }, 15000);

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      cleanup();
    };
  }, [mediaUrl]);

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (opening || !videoPath) return;
    setOpening(true);
    const p = ipc.file?.openPath(videoPath);
    if (p) p.finally(() => setOpening(false)); else setOpening(false);
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
      onClick={handlePlay}
      className="relative group/video cursor-pointer rounded-xl overflow-hidden bg-black ring-1 ring-black/[0.12] select-none"
      style={{ width: '17.5rem', height: '10rem' }}
    >
      {/* Background: captured thumbnail or gray placeholder */}
      {thumbDataUrl ? (
        <img src={thumbDataUrl} alt="video thumb" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-400">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        </div>
      )}

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

      {/* Action buttons - top right, on hover */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/video:opacity-100 transition-opacity">
        <button onClick={handleOpenFolder} title="Mở thư mục"
          className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white transition-colors">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
        </button>
        <button onClick={handleSaveAs} title="Lưu về máy"
          className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white transition-colors">
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
