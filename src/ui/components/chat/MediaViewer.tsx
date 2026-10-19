import React, { useEffect, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { TransformWrapper, TransformComponent, ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { ensureMediaLocal } from '@/lib/employeeMediaSync';
import { Spinner } from '@/components/common/PageLoading';
import { copyImageToClipboard } from '@/lib/chat/copyImage';
import { galleryInsertShift, galleryItemKey } from '@/lib/chat/mediaGallery';

export interface MediaViewerImage {
  src: string;           // remote/view URL (ưu tiên cao nhất)
  displaySrc?: string;   // local display URL (nếu có)
  thumbSrc?: string;     // ảnh nhỏ nhất cho dải "Bộ sưu tập" (thumb Zalo / Telegram / Facebook) - không có thì dùng displaySrc
  fallbackSrc?: string;  // fallback URL (Zalo CDN) khi src không load được
  alt?: string;
  localPath?: string;    // absolute local file path (for show-in-folder)
  defaultName?: string;
  msgId?: string;        // message ID for repair
  threadId?: string;     // thread ID for event emission
  timestamp?: number;    // message time - gallery is shown oldest → newest (like Zalo)
}

interface MediaViewerProps {
  /** If providing a list, use `images` + `initialIndex`. Otherwise use `src` for single image. */
  src?: string;
  images?: MediaViewerImage[];
  initialIndex?: number;
  alt?: string;
  zaloId?: string;
  onClose: () => void;
  /**
   * Paged gallery (useMediaGallery): more images exist before / after `images`. With onReachStart / onReachEnd the
   * viewer asks for them when the strip nears an end or when ←/→ goes past the first / last loaded image (and then
   * continues once the page arrives). Without them the viewer just shows `images`.
   */
  hasOlder?: boolean;
  hasNewer?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  /** Load older images (they are merged in before `images[0]`). */
  onReachStart?: () => void;
  /** Load newer images (merged in after the last one). */
  onReachEnd?: () => void;
}

// ── Gallery strip geometry ───────────────────────────────────────────────────
// Fixed square tiles: no layout shift while thumbnails load, O(1) windowing and an exact scroll
// compensation (inserted tiles × pitch) when an older page is merged in above the visible ones.
const THUMB_SIZE = 60;
const THUMB_GAP = 6;
const THUMB_PITCH = THUMB_SIZE + THUMB_GAP;
const STRIP_PAD = 6;
/** Tiles kept mounted above / below the visible part of the strip. */
const STRIP_OVERSCAN = 8;
/** Ask for the next page when the strip is scrolled this close to an end (~8 tiles). */
const STRIP_EDGE_PX = THUMB_PITCH * 8;
/** …or when the shown image is this close to the first / last loaded one. */
const NAV_PREFETCH = 5;
/** A ←/→ press at the end of the loaded images waits this long for the next page. */
const PENDING_STEP_TTL_MS = 15_000;

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, Math.floor(index) || 0), Math.max(0, length - 1));
}

export default function MediaViewer({
  src, images, initialIndex = 0, alt = 'ảnh', zaloId, onClose,
  hasOlder = false, hasNewer = false, loadingOlder = false, loadingNewer = false, onReachStart, onReachEnd,
}: MediaViewerProps) {
  const showNotification = useAppStore(s => s.showNotification);
  // Build internal image list
  const imageList: MediaViewerImage[] = React.useMemo(() => {
    if (images && images.length > 0) return images;
    if (src) return [{ src, alt }];
    return [];
  }, [images, src, alt]);

  // Primary state: the shown image by a stable key (message id, else URL) - not by index and not by URL.
  // Pages merged in front of it (older images) only shift its index: what is shown never changes, and an
  // auto-repaired local copy (new URL) stays the same item.
  const [currentKey, setCurrentKey] = useState<string>(() => {
    const img = imageList[clampIndex(initialIndex, imageList.length)];
    return img ? galleryItemKey(img) : '';
  });
  const lastIndexRef = useRef(clampIndex(initialIndex, imageList.length));
  const currentIndex = React.useMemo(() => {
    if (!imageList.length) return 0;
    const idx = currentKey ? imageList.findIndex(img => galleryItemKey(img) === currentKey) : -1;
    return idx >= 0 ? idx : clampIndex(lastIndexRef.current, imageList.length);
  }, [currentKey, imageList]);
  useEffect(() => { lastIndexRef.current = currentIndex; }, [currentIndex]);
  /** Local copy re-downloaded by the auto-repair, per image key. */
  const [repairedSrc, setRepairedSrc] = useState<Record<string, string>>({});
  /** ←/→ pressed on the first / last loaded image while its next page loads → step once it arrives. */
  const [pendingStep, setPendingStep] = useState<{ dir: -1 | 1; at: number } | null>(null);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [mainImageError, setMainImageError] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [saving, setSaving] = useState(false);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Track pointer drag to avoid closing dialog after panning
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const hasDragged = useRef(false);
  // Guard auto-repair: at most once per image (by key) while the viewer is open. Not reset when the URL
  // changes: a repaired copy that fails again must not start a repair → fallback → repair loop.
  const repairAttemptedRef = useRef(new Set<string>());
  // Skip resetTransform on the very first render - centerOnInit handles it.
  // Calling resetTransform(0) on mount fights against centerOnInit and causes a visible jump.
  const isMountedRef = useRef(false);

  const current = imageList[currentIndex];
  const currentItemKey = current ? galleryItemKey(current) : '';
  const currentItemKeyRef = useRef(currentItemKey);
  currentItemKeyRef.current = currentItemKey;
  const primarySrc = (currentItemKey && repairedSrc[currentItemKey]) || current?.displaySrc || current?.src || '';
  const fallbackSrc = current?.fallbackSrc || '';
  // Khi primarySrc lỗi → fallback sang fallbackSrc (Zalo CDN)
  const displaySrc = useFallback && fallbackSrc ? fallbackSrc : primarySrc;
  const viewSrc = current?.src || '';
  const currentAlt = current?.alt || alt;
  const localPath = current?.localPath || '';
  const hasMany = imageList.length > 1;
  // Paged gallery: more images exist before / after the loaded ones
  const moreOlder = hasOlder && !!onReachStart;
  const moreNewer = hasNewer && !!onReachEnd;
  // Like Zalo: newest image is last; "<" = older, ">" = newer, both stop at the real ends (no wrap-around)
  const canPrev = currentIndex > 0 || (hasMany && moreOlder);
  const canNext = currentIndex < imageList.length - 1 || (hasMany && moreNewer);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Show loading spinner only when truly needed:
  //   - Start with no spinner (false), then after a short delay check if image has loaded.
  //   - If image is already cached/complete → never show spinner (no flash).
  //   - If image is still loading after the delay → show spinner.
  //   - Absolute timeout fallback (15s) to never spin forever.
  useEffect(() => {
    if (!displaySrc) {
      setIsImageLoading(false);
      setMainImageError(true);
      return;
    }
    setIsImageLoading(false); // Reset - don't show spinner immediately
    setMainImageError(false);
    // KHÔNG reset useFallback ở đây — nếu không sẽ tạo infinite loop:
    //   primary lỗi → useFallback(true) → effect chạy → useFallback(false) → về primary → lỗi lại → ...
    // Chỉ reset fallback khi user chuyển ảnh (selectIndex).

    // Immediately check if the image is already loaded (cache hit).
    // img.src might not match yet on the first render tick, so we wait one frame.
    let cancelled = false;
    const frameCheck = requestAnimationFrame(() => {
      if (cancelled) return;
      const img = imgRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        // Already loaded - nothing to do
        return;
      }
      // Image is not yet loaded → show spinner after a 80 ms grace period
      // (avoids flash for very-fast network loads)
      const spinnerTimer = setTimeout(() => {
        if (cancelled) return;
        const img2 = imgRef.current;
        if (img2 && img2.complete && img2.naturalWidth > 0) return;
        setIsImageLoading(true);
      }, 80);

      // Absolute safety timeout - never spin longer than 15 seconds.
      const safetyTimer = setTimeout(() => {
        if (cancelled) return;
        setIsImageLoading(prev => {
          if (prev) console.warn('[MediaViewer] Loading timeout for:', displaySrc.substring(0, 80));
          return false;
        });
      }, 15_000);

      // Store timers so cleanup can reach them
      (frameCheck as any)._spinnerTimer = spinnerTimer;
      (frameCheck as any)._safetyTimer = safetyTimer;
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameCheck);
      clearTimeout((frameCheck as any)._spinnerTimer);
      clearTimeout((frameCheck as any)._safetyTimer);
    };
  }, [displaySrc]);

  // Preload the adjacent full images to reduce switch delay/flicker (keyed by URL: merging a page
  // into the list does not preload again).
  const prevPreloadSrc = currentIndex > 0 ? (imageList[currentIndex - 1]?.displaySrc || imageList[currentIndex - 1]?.src || '') : '';
  const nextPreloadSrc = currentIndex < imageList.length - 1 ? (imageList[currentIndex + 1]?.displaySrc || imageList[currentIndex + 1]?.src || '') : '';
  useEffect(() => {
    [prevPreloadSrc, nextPreloadSrc].forEach((srcToPreload) => {
      if (!srcToPreload) return;
      const img = new Image();
      img.decoding = 'async';
      img.src = srcToPreload;
      if ((img as any).decode) {
        (img as any).decode().catch(() => {});
      }
    });
  }, [prevPreloadSrc, nextPreloadSrc]);

  // Reset zoom+pan when switching to a DIFFERENT image.
  // Use displaySrc (not currentIndex) as dep: when a page is merged in, the index shifts
  // for the same image - displaySrc stays the same → no reset → no flash.
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      return;
    }
    if (transformRef.current) {
      transformRef.current.resetTransform(0);
      setZoomLevel(1);
    }
    setContextMenu(null);
  }, [displaySrc]);

  const selectIndex = useCallback((idx: number) => {
    const target = imageList[idx];
    if (!target) return;
    setCurrentKey(galleryItemKey(target));
    setUseFallback(false);
    setPendingStep(null);
  }, [imageList]);

  /** Index of the next different image in `direction`, or -1 at the end of the loaded list. */
  const neighbourIndex = useCallback((direction: -1 | 1): number => {
    let idx = currentIndex + direction;
    while (idx >= 0 && idx < imageList.length && galleryItemKey(imageList[idx]) === currentItemKey) idx += direction;
    return idx >= 0 && idx < imageList.length ? idx : -1;
  }, [currentIndex, currentItemKey, imageList]);

  const goTo = useCallback((direction: -1 | 1) => {
    const idx = neighbourIndex(direction);
    if (idx >= 0) {
      selectIndex(idx);
      return;
    }
    // First / last loaded image: load the next page and continue once it arrives
    if (direction < 0 ? moreOlder : moreNewer) {
      setPendingStep({ dir: direction, at: Date.now() });
      (direction < 0 ? onReachStart : onReachEnd)?.();
    }
  }, [neighbourIndex, selectIndex, moreOlder, moreNewer, onReachStart, onReachEnd]);
  const goNext = useCallback(() => goTo(1), [goTo]);
  const goPrev = useCallback(() => goTo(-1), [goTo]);

  // A pending ←/→ continues as soon as the page brings a neighbour; a page without a displayable image
  // (videos…) asks for the next one; the real end (or a timeout) drops it.
  useEffect(() => {
    if (!pendingStep) return;
    const idx = neighbourIndex(pendingStep.dir);
    if (idx >= 0) {
      selectIndex(idx);
      return;
    }
    const more = pendingStep.dir < 0 ? moreOlder : moreNewer;
    if (!more || Date.now() - pendingStep.at > PENDING_STEP_TTL_MS) {
      setPendingStep(null);
      return;
    }
    const loading = pendingStep.dir < 0 ? loadingOlder : loadingNewer;
    if (!loading) (pendingStep.dir < 0 ? onReachStart : onReachEnd)?.();
  }, [pendingStep, neighbourIndex, selectIndex, moreOlder, moreNewer, loadingOlder, loadingNewer, onReachStart, onReachEnd]);

  // Prefetch: the shown image is close to the first / last loaded one → load the next page before it is needed
  useEffect(() => {
    if (!imageList.length) return;
    if (moreOlder && !loadingOlder && currentIndex < NAV_PREFETCH) onReachStart?.();
    if (moreNewer && !loadingNewer && imageList.length - 1 - currentIndex < NAV_PREFETCH) onReachEnd?.();
  }, [currentIndex, imageList.length, moreOlder, moreNewer, loadingOlder, loadingNewer, onReachStart, onReachEnd]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goNext(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPrev(); }
    if (e.key === '+' || e.key === '=') {
      transformRef.current?.zoomIn(0.5, 200);
    }
    if (e.key === '-') {
      transformRef.current?.zoomOut(0.5, 200);
    }
    if (e.key === '0') {
      transformRef.current?.resetTransform(200);
    }
  }, [onClose, goNext, goPrev]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu, closeContextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 220),
      y: Math.min(e.clientY, window.innerHeight - 160),
    });
  }, []);

  const handleCopyImage = useCallback(async () => {
    closeContextMenu();
    if (!displaySrc && !viewSrc) {
      showNotification('Không có ảnh để sao chép', 'error');
      return;
    }
    try {
      await copyImageToClipboard({ localPath, remoteUrl: fallbackSrc || viewSrc, fallbackSrc: displaySrc || viewSrc });
      showNotification('Đã sao chép ảnh vào clipboard', 'success');
    } catch (err: any) {
      showNotification(`Không thể sao chép ảnh: ${err?.message || 'Lỗi không xác định'}`, 'error');
    }
  }, [closeContextMenu, displaySrc, viewSrc, fallbackSrc, localPath, showNotification]);

  const handleShowInFolder = useCallback(async () => {
    closeContextMenu();
    const mode = useEmployeeStore.getState().mode;
    if (mode === 'employee' && localPath) {
      // Employee: download ảnh từ Boss → show in folder
      const bossUrl = toLocalMediaUrl(localPath);
      if (bossUrl) {
        const { localPath: cachedPath } = await ensureMediaLocal(bossUrl, 'image');
        if (cachedPath) {
          await ipc.file?.showItemInFolder(cachedPath);
          return;
        }
      }
    }
    if (localPath) {
      await ipc.file?.showItemInFolder(localPath);
    } else {
      showNotification('Ảnh chưa được tải về máy', 'info');
    }
  }, [closeContextMenu, localPath, showNotification]);

  /**
   * Mở ảnh ngoài app. Ảnh trên Boss (máy nhân viên): /api/media cần token phiên nhân viên, trình duyệt ngoài không có
   * (401) → tải về máy qua main (gắn token) rồi mở bằng trình xem ảnh mặc định. URL khác (CDN) mở như cũ.
   */
  const openExternally = useCallback(async (src: string) => {
    if (!src) return;
    const { mode, bossUrl } = useEmployeeStore.getState();
    const bossBase = String(bossUrl || '').replace(/\/+$/, '');
    if (mode === 'employee' && bossBase && src.startsWith(`${bossBase}/`)) {
      const { localPath: cachedPath } = await ensureMediaLocal(src, 'image');
      if (cachedPath) await ipc.file?.openPath(cachedPath);
      else showNotification('Không tải được ảnh từ Boss', 'error');
      return;
    }
    ipc.shell?.openExternal(src);
  }, [showNotification]);

  const handleSave = async () => {
    if (saving || !viewSrc) return;
    setSaving(true);
    try {
      const filename = current?.defaultName || viewSrc.split('/').pop()?.split('?')[0] || `image_${Date.now()}.jpg`;
      const res = await ipc.file?.saveImage({ zaloId: zaloId || 'default', url: viewSrc, filename });
      if (!res?.success) await openExternally(viewSrc);
    } catch { await openExternally(viewSrc); }
    finally { setSaving(false); }
  };

  if (!imageList.length) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex">
      {/* ── Main viewer ── */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Toolbar */}
        <div
          className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent z-20 pointer-events-none"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 pointer-events-auto">
            <span className="text-white/70 text-sm truncate max-w-xs">{currentAlt}</span>
            {hasMany && (
              <span
                className="text-white/50 text-xs bg-black/40 px-2 py-0.5 rounded-full tabular-nums"
                title={moreOlder || moreNewer ? 'Vị trí trong số ảnh đã tải - còn ảnh khác, cuộn bộ sưu tập để tải thêm' : undefined}
              >
                {currentIndex + 1} / {imageList.length}{moreOlder || moreNewer ? '+' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 pointer-events-auto">
            {/* Zoom out */}
            <button onClick={() => transformRef.current?.zoomOut(0.5, 200)}
              title="Thu nhỏ (-)" disabled={zoomLevel <= 0.25}
              className="w-8 h-8 rounded-lg bg-foreground/10 hover:bg-foreground/20 flex items-center justify-center text-foreground/80 hover:text-foreground transition-colors disabled:opacity-30">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            {/* Zoom level */}
            <button onClick={() => transformRef.current?.resetTransform(200)}
              title="Reset zoom (0)"
              className="text-xs text-foreground/60 hover:text-foreground bg-foreground/10 hover:bg-foreground/20 rounded-lg px-2 h-8 min-w-[44px] transition-colors font-mono">
              {Math.round(zoomLevel * 100)}%
            </button>
            {/* Zoom in */}
            <button onClick={() => transformRef.current?.zoomIn(0.5, 200)}
              title="Phóng to (+)" disabled={zoomLevel >= 6}
              className="w-8 h-8 rounded-lg bg-foreground/10 hover:bg-foreground/20 flex items-center justify-center text-foreground/80 hover:text-foreground transition-colors disabled:opacity-30">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <div className="w-px h-5 bg-foreground/20 mx-1" />
            {/* Copy image (straight to the clipboard) */}
            <button onClick={handleCopyImage} title="Copy hình ảnh"
              className="w-8 h-8 rounded-lg bg-foreground/10 hover:bg-foreground/20 flex items-center justify-center text-foreground/80 hover:text-foreground transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            {/* Open external */}
            <button onClick={() => { void openExternally(viewSrc); }} title="Mở trong trình duyệt"
              className="w-8 h-8 rounded-lg bg-foreground/10 hover:bg-foreground/20 flex items-center justify-center text-foreground/80 hover:text-foreground transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
            {/* Save */}
            <button onClick={handleSave} disabled={saving} title="Lưu ảnh"
              className="w-8 h-8 rounded-lg bg-foreground/10 hover:bg-foreground/20 flex items-center justify-center text-foreground/80 hover:text-foreground transition-colors disabled:opacity-40">
              {saving
                ? <Spinner size={3} />
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              }
            </button>
            {/* Close */}
            <button onClick={onClose} title="Đóng (Esc)"
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-red-600/70 flex items-center justify-center text-white/80 hover:text-white transition-colors">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>
            </button>
          </div>
        </div>

        {/* Prev (older) / Next (newer) buttons - hidden at the real ends, no wrap-around */}
        {canPrev && (
          <button onClick={goPrev}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 bg-black/50 hover:bg-black/80 text-white rounded-full flex items-center justify-center transition-colors shadow-lg"
            title="Ảnh cũ hơn (←)">
            {pendingStep?.dir === -1 && loadingOlder
              ? <Spinner size={4} />
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>}
          </button>
        )}
        {canNext && (
          <button onClick={goNext}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 bg-black/50 hover:bg-black/80 text-white rounded-full flex items-center justify-center transition-colors shadow-lg"
            title="Ảnh mới hơn (→)">
            {pendingStep?.dir === 1 && loadingNewer
              ? <Spinner size={4} />
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>}
          </button>
        )}

        {/* Image container with react-zoom-pan-pinch */}
        <div
          className="flex-1 flex items-center justify-center overflow-hidden relative"
          onPointerDown={e => {
            pointerDownPos.current = { x: e.clientX, y: e.clientY };
            hasDragged.current = false;
          }}
          onPointerMove={e => {
            if (pointerDownPos.current) {
              const dx = e.clientX - pointerDownPos.current.x;
              const dy = e.clientY - pointerDownPos.current.y;
              if (Math.sqrt(dx * dx + dy * dy) > 5) {
                hasDragged.current = true;
              }
            }
          }}
          onClick={e => {
            // If the pointer moved (drag/pan), don't treat it as a close-click
            if (hasDragged.current) {
              hasDragged.current = false;
              pointerDownPos.current = null;
              return;
            }
            pointerDownPos.current = null;
            const target = e.target as HTMLElement;
            if (!target.closest('img')) onClose();
          }}
          onContextMenu={handleContextMenu}
        >
          {isImageLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none bg-black/20">
              <div className="w-8 h-8 rounded-full border-2 border-foreground/20 border-t-white/80 animate-spin" />
            </div>
          )}
          <TransformWrapper
            ref={transformRef}
            initialScale={1}
            minScale={0.2}
            maxScale={8}
            centerOnInit={true}
            centerZoomedOut={true}
            limitToBounds={false}
            doubleClick={{
              mode: 'toggle',
              step: 2,
              animationTime: 200,
            }}
            wheel={{
              step: 0.15,
              smoothStep: 0.004,
            }}
            panning={{
              velocityDisabled: false,
            }}
            onTransformed={(_ref, state) => {
              setZoomLevel(state.scale);
            }}
          >
            <TransformComponent
              wrapperStyle={{
                width: '100%',
                height: '100%',
              }}
              contentStyle={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <img
                ref={imgRef}
                key={displaySrc}
                src={displaySrc}
                alt={currentAlt}
                className={`select-none rounded-sm shadow-2xl transition-opacity duration-200 ${
                  isImageLoading ? 'opacity-0' : 'opacity-100'
                } ${mainImageError ? 'opacity-30' : ''}`}
                style={{
                  maxWidth: '90vw',
                  maxHeight: '85vh',
                  objectFit: 'contain',
                }}
                loading="eager"
                decoding="async"
                draggable={false}
                onLoad={() => setIsImageLoading(false)}
                onError={() => {
                  setIsImageLoading(false);
                  // Try-cascade: fallback to Zalo CDN URL nếu có
                  const img = current;
                  if (!useFallback && img?.fallbackSrc && img.fallbackSrc !== primarySrc) {
                    setUseFallback(true);
                    return;
                  }
                  // Attempt auto-repair if we have a local path (corrupted local file)
                  const key = img ? galleryItemKey(img) : '';
                  if (img?.localPath && img?.src && zaloId && img?.msgId && !repairAttemptedRef.current.has(key)) {
                    repairAttemptedRef.current.add(key);
                    ipc.file?.repairImage({
                      zaloId,
                      msgId: img.msgId,
                      threadId: img.threadId,
                      localPath: img.localPath,
                      remoteUrl: img.src,
                    }).then((res) => {
                      const stillShown = currentItemKeyRef.current === key;
                      if (res?.success && res.newLocalPath) {
                        // Same path re-downloaded → bust the cached broken response (the protocol ignores the query)
                        const repaired = toLocalMediaUrl(res.newLocalPath);
                        const fresh = repaired.startsWith('local-media:') ? `${repaired}${repaired.includes('?') ? '&' : '?'}r=${Date.now()}` : repaired;
                        setRepairedSrc(prev => ({ ...prev, [key]: fresh }));
                        if (stillShown) {
                          setUseFallback(false);
                          setMainImageError(false);
                        }
                      } else if (stillShown) {
                        setMainImageError(true);
                      }
                    }).catch(() => {
                      if (currentItemKeyRef.current === key) setMainImageError(true);
                    });
                  } else {
                    setMainImageError(true);
                  }
                }}
              />
            </TransformComponent>
          </TransformWrapper>

          {contextMenu && (
            <div
              ref={menuRef}
              style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
              className="bg-card border border-input rounded-xl shadow-2xl py-1 w-56 text-sm select-none"
              onClick={e => e.stopPropagation()}
              onContextMenu={e => e.preventDefault()}
            >
              <ViewerMenuItem
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                  </svg>
                }
                label="Copy hình ảnh"
                onClick={handleCopyImage}
              />
              <ViewerMenuItem
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  </svg>
                }
                label="Mở trong thư mục"
                onClick={handleShowInFolder}
              />
            </div>
          )}
        </div>

        {/* Bottom hint */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-foreground/30 text-xs pointer-events-none">
          {zoomLevel <= 1.05 ? 'Cuộn để phóng to · Double-click để phóng 2x' : 'Double-click để reset · Kéo để di chuyển'}
          {hasMany && ' · ← → để chuyển ảnh'}
        </div>
      </div>

      {/* ── Right thumbnail strip ── */}
      {hasMany && (
        <GalleryStrip
          items={imageList}
          currentIndex={currentIndex}
          currentKey={currentItemKey}
          onSelect={selectIndex}
          onBackgroundClick={onClose}
          hasOlder={moreOlder}
          hasNewer={moreNewer}
          loadingOlder={loadingOlder}
          loadingNewer={loadingNewer}
          onReachStart={onReachStart}
          onReachEnd={onReachEnd}
        />
      )}
    </div>
  );
}

// ── Gallery strip ("Bộ sưu tập") ─────────────────────────────────────────────

interface GalleryStripProps {
  items: MediaViewerImage[];
  currentIndex: number;
  currentKey: string;
  onSelect: (index: number) => void;
  onBackgroundClick: () => void;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  onReachStart?: () => void;
  onReachEnd?: () => void;
}

/**
 * Vertical strip, oldest at the top, newest at the bottom (like Zalo). Windowed: only the tiles near the
 * visible part are mounted (any number of loaded images costs ~40 DOM tiles). Memoized, so zooming the main
 * image (a state update per frame) does not re-render it.
 */
const GalleryStrip = React.memo(function GalleryStrip(props: GalleryStripProps) {
  const { items, currentIndex, currentKey, onSelect, onBackgroundClick, loadingOlder, loadingNewer } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef(props);
  latestRef.current = props;
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [seenItems, setSeenItems] = useState(items);
  const [scrollFix, setScrollFix] = useState(0);
  const lastScrolledKeyRef = useRef('');
  const rafRef = useRef(0);

  // Images merged in above the visible tiles (an older page): keep what the user looks at in place, like the
  // chat's load-older - move the render window in this render and the scrollTop before paint (layout effect).
  if (seenItems !== items) {
    const anchor = Math.floor(Math.max(0, viewport.top - STRIP_PAD) / THUMB_PITCH);
    const shift = galleryInsertShift(seenItems, items, anchor);
    setSeenItems(items);
    if (shift !== 0) {
      setViewport({ top: Math.max(0, viewport.top + shift * THUMB_PITCH), height: viewport.height });
      setScrollFix(scrollFix + shift * THUMB_PITCH);
    }
  }

  useLayoutEffect(() => {
    if (!scrollFix) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop += scrollFix;
    setScrollFix(0);
  }, [scrollFix]);

  // First paint: the current image centred in the strip
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, STRIP_PAD + currentIndex * THUMB_PITCH - (el.clientHeight - THUMB_SIZE) / 2);
    lastScrolledKeyRef.current = currentKey;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another image shown → keep its tile (and one neighbour) visible. Keyed by item, so a page merged in
  // (same image, new index) never scrolls.
  useEffect(() => {
    if (!currentKey || lastScrolledKeyRef.current === currentKey) return;
    lastScrolledKeyRef.current = currentKey;
    const el = scrollerRef.current;
    if (!el) return;
    const top = STRIP_PAD + currentIndex * THUMB_PITCH;
    let target = -1;
    if (top - THUMB_GAP < el.scrollTop) target = Math.max(0, top - THUMB_PITCH);
    else if (top + THUMB_SIZE + THUMB_GAP > el.scrollTop + el.clientHeight) target = top + THUMB_SIZE + THUMB_PITCH - el.clientHeight;
    if (target < 0) return;
    el.scrollTo({ top: target, behavior: Math.abs(target - el.scrollTop) > el.clientHeight * 2 ? 'auto' : 'smooth' });
  }, [currentKey, currentIndex]);

  /** Near an end of the strip → ask for the next page (the hook ignores duplicate asks). */
  const checkEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const p = latestRef.current;
    if (p.hasOlder && !p.loadingOlder && el.scrollTop < STRIP_EDGE_PX) p.onReachStart?.();
    if (p.hasNewer && !p.loadingNewer && el.scrollHeight - el.scrollTop - el.clientHeight < STRIP_EDGE_PX) p.onReachEnd?.();
  }, []);

  // After every page / flag change: keeps loading while the strip is not filled or still near an end
  useEffect(() => {
    checkEdges();
  }, [items.length, props.hasOlder, props.hasNewer, loadingOlder, loadingNewer, checkEdges]);

  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollerRef.current;
      if (!el) return;
      const top = el.scrollTop;
      const height = el.clientHeight;
      setViewport(v => (v.top === top && v.height === height ? v : { top, height }));
      checkEdges();
    });
  }, [checkEdges]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const top = el.scrollTop;
      const height = el.clientHeight;
      setViewport(v => (v.top === top && v.height === height ? v : { top, height }));
      checkEdges();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [checkEdges]);

  const count = items.length;
  const viewHeight = viewport.height || window.innerHeight;
  const first = Math.max(0, Math.floor((viewport.top - STRIP_PAD) / THUMB_PITCH) - STRIP_OVERSCAN);
  const last = Math.min(count - 1, Math.ceil((viewport.top + viewHeight - STRIP_PAD) / THUMB_PITCH) + STRIP_OVERSCAN);
  const tiles: React.ReactNode[] = [];
  const usedKeys = new Set<string>();
  for (let i = first; i <= last; i++) {
    const img = items[i];
    let key = galleryItemKey(img);
    if (usedKeys.has(key)) key = `${key}#${i}`; // plain `images` lists may repeat an image
    usedKeys.add(key);
    tiles.push(<GalleryThumb key={key} img={img} index={i} active={i === currentIndex} onSelect={onSelect} />);
  }

  return (
    <div
      className="w-20 flex flex-col bg-black/60 border-l border-white/10 overflow-hidden"
      onClick={e => {
        const target = e.target as HTMLElement;
        if (target.closest('button') || target.closest('img')) return;
        onBackgroundClick();
      }}
    >
      <div className="px-2 py-2 text-[11px] text-white/40 font-medium text-center border-b border-white/10 flex-shrink-0">
        BỘ SƯU TẬP
      </div>
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollerRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto overflow-x-hidden"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.2) transparent', overflowAnchor: 'none' }}
        >
          <div className="relative" style={{ height: count ? STRIP_PAD * 2 + count * THUMB_PITCH - THUMB_GAP : 0 }}>
            {tiles}
          </div>
        </div>
        {loadingOlder && (
          <div className="pointer-events-none absolute top-1 left-0 right-0 flex justify-center">
            <span className="rounded-full bg-black/70 p-1"><Spinner size={3} /></span>
          </div>
        )}
        {loadingNewer && (
          <div className="pointer-events-none absolute bottom-1 left-0 right-0 flex justify-center">
            <span className="rounded-full bg-black/70 p-1"><Spinner size={3} /></span>
          </div>
        )}
      </div>
    </div>
  );
});

/** URLs that failed as a tile (expired CDN thumb, missing file): skipped by later tiles. */
const brokenThumbUrls = new Set<string>();
const thumbTimeFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Smallest first: thumbnail → display (local) → remote → CDN fallback. */
function thumbCandidates(img: MediaViewerImage): string[] {
  const out: string[] = [];
  for (const url of [img.thumbSrc, img.displaySrc, img.src, img.fallbackSrc]) {
    if (url && !out.includes(url) && !brokenThumbUrls.has(url)) out.push(url);
  }
  return out;
}

const GalleryThumb = React.memo(function GalleryThumb({ img, index, active, onSelect }: {
  img: MediaViewerImage;
  index: number;
  active: boolean;
  onSelect: (index: number) => void;
}) {
  const firstSrc = thumbCandidates(img)[0] || '';
  return (
    <button
      type="button"
      onClick={() => onSelect(index)}
      className={`absolute rounded overflow-hidden border-2 bg-white/5 ${
        active
          ? 'border-blue-400 opacity-100 scale-100'
          : 'border-transparent opacity-50 hover:opacity-80 scale-95 hover:scale-100'
      }`}
      style={{
        top: STRIP_PAD + index * THUMB_PITCH,
        left: '50%',
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        marginLeft: -THUMB_SIZE / 2,
        transition: 'opacity 150ms, transform 150ms',
      }}
      title={img.timestamp ? thumbTimeFormat.format(img.timestamp) : `Ảnh ${index + 1}${img.alt ? ': ' + img.alt : ''}`}
    >
      {firstSrc && (
        <img
          src={firstSrc}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="w-full h-full object-cover"
          onError={e => {
            const el = e.currentTarget;
            const failed = el.getAttribute('src') || '';
            if (failed) {
              if (brokenThumbUrls.size >= 2000) brokenThumbUrls.clear();
              brokenThumbUrls.add(failed);
            }
            const next = thumbCandidates(img).find(url => url !== failed);
            if (next) el.src = next;
            else el.style.opacity = '0.3';
          }}
        />
      )}
    </button>
  );
});

function ViewerMenuItem({ icon, label, onClick }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted transition-colors text-left text-foreground"
    >
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
