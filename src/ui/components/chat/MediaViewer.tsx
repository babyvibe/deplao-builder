import React, { useEffect, useCallback, useRef, useState } from 'react';
import { TransformWrapper, TransformComponent, ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { toLocalMediaUrl } from '@/lib/localMedia';

export interface MediaViewerImage {
  src: string;           // remote/view URL
  displaySrc?: string;   // local display URL (if any)
  alt?: string;
  localPath?: string;    // absolute local file path (for show-in-folder)
  defaultName?: string;
  msgId?: string;        // message ID for repair
  threadId?: string;     // thread ID for event emission
}

interface MediaViewerProps {
  /** If providing a list, use `images` + `initialIndex`. Otherwise use `src` for single image. */
  src?: string;
  images?: MediaViewerImage[];
  initialIndex?: number;
  alt?: string;
  zaloId?: string;
  onClose: () => void;
}

export default function MediaViewer({ src, images, initialIndex = 0, alt = 'ảnh', zaloId, onClose }: MediaViewerProps) {
  const showNotification = useAppStore(s => s.showNotification);
  // Build internal image list
  const imageList: MediaViewerImage[] = React.useMemo(() => {
    if (images && images.length > 0) return images;
    if (src) return [{ src, alt }];
    return [];
  }, [images, src, alt]);

  // Primary state: track the currently shown image by its display URL.
  // This survives imageList reshuffling (async full gallery load) with zero visual artifacts —
  // when the list grows, currentSrc stays the same and currentIndex just recomputes.
  const [currentSrc, setCurrentSrc] = useState<string>(() => {
    const idx = Math.min(Math.max(0, initialIndex), Math.max(0, imageList.length - 1));
    const img = imageList[idx];
    return img?.displaySrc || img?.src || '';
  });

  // Derived: find current image's position in the (possibly reshuffled) list.
  const currentIndex = React.useMemo(() => {
    if (!currentSrc || !imageList.length) return 0;
    const idx = imageList.findIndex(img => (img.displaySrc || img.src) === currentSrc);
    return idx >= 0 ? idx : 0;
  }, [currentSrc, imageList]);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [mainImageError, setMainImageError] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [saving, setSaving] = useState(false);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Track pointer drag to avoid closing dialog after panning
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const hasDragged = useRef(false);
  // Guard auto-repair: only attempt once per image to avoid infinite loops
  const repairAttemptedRef = useRef(false);
  // Skip resetTransform on the very first render — centerOnInit handles it.
  // Calling resetTransform(0) on mount fights against centerOnInit and causes a visible jump.
  const isMountedRef = useRef(false);
  // Guard thumbnail scroll — only scroll when a genuinely different image becomes active,
  // not when the same image just shifts to a new index because the full list loaded.
  const lastScrolledSrcRef = useRef('');

  const current = imageList[currentIndex];
  const displaySrc = currentSrc || current?.src || ''; // currentSrc IS the displaySrc (local > remote)
  const viewSrc = current?.src || '';
  const currentAlt = current?.alt || alt;
  const localPath = current?.localPath || '';
  const hasMany = imageList.length > 1;

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // No imageList-sync effect needed: currentIndex is derived from currentSrc via useMemo.
  // When the full gallery loads and imageList grows, currentSrc stays the same →
  // currentIndex recomputes automatically → zero re-renders, zero visual artifacts.

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
    setIsImageLoading(false); // Reset — don't show spinner immediately
    setMainImageError(false);
    repairAttemptedRef.current = false; // Allow repair attempt for new image

    // Immediately check if the image is already loaded (cache hit).
    // img.src might not match yet on the first render tick, so we wait one frame.
    let cancelled = false;
    const frameCheck = requestAnimationFrame(() => {
      if (cancelled) return;
      const img = imgRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        // Already loaded — nothing to do
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

      // Absolute safety timeout — never spin longer than 15 seconds.
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

  // Preload adjacent images to reduce switch delay/flicker.
  useEffect(() => {
    if (imageList.length <= 1) return;
    const prevIdx = (currentIndex - 1 + imageList.length) % imageList.length;
    const nextIdx = (currentIndex + 1) % imageList.length;
    [prevIdx, nextIdx].forEach((idx) => {
      const srcToPreload = imageList[idx]?.displaySrc || imageList[idx]?.src;
      if (!srcToPreload) return;
      const img = new Image();
      img.src = srcToPreload;
      if ((img as any).decode) {
        (img as any).decode().catch(() => {});
      }
    });
  }, [currentIndex, imageList]);

  // Reset zoom+pan when switching to a DIFFERENT image.
  // Use displaySrc (not currentIndex) as dep: when the full DB list loads, the index shifts
  // for the same image — displaySrc stays the same → no reset → no flash.
  // Only actually reset when the user navigates to a genuinely different image.
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

  // Scroll thumbnail into view only when a genuinely different image becomes active.
  // Do NOT scroll when the same image just shifts to a new index (full list loaded from DB).
  useEffect(() => {
    if (lastScrolledSrcRef.current === displaySrc) return; // Same image — suppress scroll
    lastScrolledSrcRef.current = displaySrc;
    if (!thumbsRef.current) return;
    const thumb = thumbsRef.current.children[currentIndex] as HTMLElement;
    if (thumb) thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [currentIndex, displaySrc]);

  const goNext = useCallback(() => {
    if (imageList.length <= 1) return;
    const next = imageList[(currentIndex + 1) % imageList.length];
    setCurrentSrc(next?.displaySrc || next?.src || '');
  }, [imageList, currentIndex]);

  const goPrev = useCallback(() => {
    if (imageList.length <= 1) return;
    const prev = imageList[(currentIndex - 1 + imageList.length) % imageList.length];
    setCurrentSrc(prev?.displaySrc || prev?.src || '');
  }, [imageList, currentIndex]);

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
    try {
      const srcUrl = displaySrc || viewSrc;
      if (!srcUrl) {
        showNotification('Không có ảnh để sao chép', 'error');
        return;
      }

      const response = await fetch(srcUrl);
      const blob = await response.blob();
      let pngBlob = blob;

      if (blob.type !== 'image/png') {
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          showNotification('Không thể sao chép ảnh: Canvas context unavailable', 'error');
          return;
        }
        ctx.drawImage(bmp, 0, 0);
        pngBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Không thể chuyển ảnh sang PNG')), 'image/png');
        });
      }

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob }),
      ]);
      showNotification('Đã sao chép ảnh vào clipboard', 'success');
    } catch (err: any) {
      showNotification(`Không thể sao chép ảnh: ${err?.message || 'Lỗi không xác định'}`, 'error');
    }
  }, [closeContextMenu, displaySrc, viewSrc, showNotification]);

  const handleShowInFolder = useCallback(async () => {
    closeContextMenu();
    if (localPath) {
      await ipc.file?.showItemInFolder(localPath);
    } else {
      showNotification('Ảnh chưa được tải về máy', 'info');
    }
  }, [closeContextMenu, localPath, showNotification]);

  const handleSave = async () => {
    if (saving || !viewSrc) return;
    setSaving(true);
    try {
      const filename = current?.defaultName || viewSrc.split('/').pop()?.split('?')[0] || `image_${Date.now()}.jpg`;
      const res = await ipc.file?.saveImage({ zaloId: zaloId || 'default', url: viewSrc, filename });
      if (!res?.success) ipc.shell?.openExternal(viewSrc);
    } catch { ipc.shell?.openExternal(viewSrc); }
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
              <span className="text-white/50 text-xs bg-black/40 px-2 py-0.5 rounded-full">
                {currentIndex + 1} / {imageList.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 pointer-events-auto">
            {/* Zoom out */}
            <button onClick={() => transformRef.current?.zoomOut(0.5, 200)}
              title="Thu nhỏ (-)" disabled={zoomLevel <= 0.25}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition-colors disabled:opacity-30">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            {/* Zoom level */}
            <button onClick={() => transformRef.current?.resetTransform(200)}
              title="Reset zoom (0)"
              className="text-xs text-white/60 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg px-2 h-8 min-w-[44px] transition-colors font-mono">
              {Math.round(zoomLevel * 100)}%
            </button>
            {/* Zoom in */}
            <button onClick={() => transformRef.current?.zoomIn(0.5, 200)}
              title="Phóng to (+)" disabled={zoomLevel >= 6}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition-colors disabled:opacity-30">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <div className="w-px h-5 bg-white/20 mx-1" />
            {/* Open external */}
            <button onClick={() => ipc.shell?.openExternal(viewSrc)} title="Mở trong trình duyệt"
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
            {/* Save */}
            <button onClick={handleSave} disabled={saving} title="Lưu ảnh"
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition-colors disabled:opacity-40">
              {saving
                ? <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
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

        {/* Prev/Next buttons */}
        {hasMany && (
          <>
            <button onClick={goPrev}
              className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 bg-black/50 hover:bg-black/80 text-white rounded-full flex items-center justify-center transition-colors shadow-lg"
              title="Ảnh trước (←)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button onClick={goNext}
              className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 bg-black/50 hover:bg-black/80 text-white rounded-full flex items-center justify-center transition-colors shadow-lg"
              title="Ảnh tiếp theo (→)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </>
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
              <div className="w-8 h-8 rounded-full border-2 border-white/20 border-t-white/80 animate-spin" />
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
                  // Attempt auto-repair if we have a local path (corrupted local file)
                  const img = imageList[currentIndex];
                  if (img?.localPath && img?.src && zaloId && img?.msgId && !repairAttemptedRef.current) {
                    repairAttemptedRef.current = true;
                    ipc.file?.repairImage({
                      zaloId,
                      msgId: img.msgId,
                      threadId: img.threadId,
                      localPath: img.localPath,
                      remoteUrl: img.src,
                    }).then((res) => {
                      if (res?.success && res.newLocalPath) {
                        const newDisplaySrc = toLocalMediaUrl(res.newLocalPath);
                        setCurrentSrc(newDisplaySrc);
                        setMainImageError(false);
                      } else {
                        setMainImageError(true);
                      }
                    }).catch(() => setMainImageError(true));
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
              className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl py-1 w-56 text-sm select-none"
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
                label="Sao chép ảnh"
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
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-white/30 text-xs pointer-events-none">
          {zoomLevel <= 1.05 ? 'Cuộn để phóng to · Double-click để phóng 2x' : 'Double-click để reset · Kéo để di chuyển'}
          {hasMany && ' · ← → để chuyển ảnh'}
        </div>
      </div>

      {/* ── Right thumbnail strip ── */}
      {hasMany && (
        <div
          className="w-20 flex flex-col bg-black/60 border-l border-white/10 overflow-hidden"
          onClick={e => {
            const target = e.target as HTMLElement;
            if (target.closest('button') || target.closest('img')) return;
            onClose();
          }}
        >
          <div className="px-2 py-2 text-[11px] text-white/40 font-medium text-center border-b border-white/10 flex-shrink-0">
            BỘ SƯU TẬP
          </div>
          <div ref={thumbsRef} className="flex-1 overflow-y-auto py-1 space-y-1 px-1.5"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.2) transparent' }}>
            {imageList.map((img, idx) => (
              <button
                key={idx}
                onClick={() => {
                  const img = imageList[idx];
                  setCurrentSrc(img?.displaySrc || img?.src || '');
                }}
                className={`w-full aspect-square rounded overflow-hidden flex-shrink-0 border-2 transition-all ${
                  idx === currentIndex
                    ? 'border-blue-400 opacity-100 scale-100'
                    : 'border-transparent opacity-50 hover:opacity-80 scale-95 hover:scale-100'
                }`}
                title={`Ảnh ${idx + 1}${img.alt ? ': ' + img.alt : ''}`}
              >
                <img
                  src={img.displaySrc || img.src}
                  alt={`thumb ${idx + 1}`}
                  className="w-full h-full object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ViewerMenuItem({ icon, label, onClick }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700 transition-colors text-left text-gray-200"
    >
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

