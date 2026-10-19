/**
 * Ô sticker / GIF Telegram trong lưới (bảng ô nhập, popup bộ sticker). Chỉ tải khi ô hiện ra: ảnh tĩnh nhỏ (thumbnail
 * Telegram) cho lưới; rê chuột vào sticker động / video / GIF thì tải cả file và phát (như Telegram, nhưng không phát
 * cả lưới cùng lúc — vài chục Lottie / video chạy song song làm khung chat giật).
 */
import React from 'react';
import { cn } from '@/lib/cn';
import { useInView } from '@/lib/media/inView';
import { loadTgsJson } from '@/lib/media/tgs';
import { useStickerFile, type TelegramStickerItem } from '@/lib/chat/telegramStickerStore';

/** Lottie (.tgs). `playing` = false → đứng ở khung đầu. `onReady`: đã vẽ khung đầu. */
export function TgsAnimation({ url, playing, className, onReady, onError }: {
  url: string;
  playing: boolean;
  className?: string;
  onReady?: () => void;
  onError?: () => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const animationRef = React.useRef<any>(null);
  const playingRef = React.useRef(playing);
  playingRef.current = playing;
  const callbacksRef = React.useRef({ onReady, onError });
  callbacksRef.current = { onReady, onError };

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await loadTgsJson(url);
      const lottie = (await import('lottie-web')).default;
      if (cancelled || !containerRef.current) return;
      const animation = lottie.loadAnimation({
        container: containerRef.current,
        renderer: 'svg',
        loop: true,
        autoplay: playingRef.current,
        animationData: JSON.parse(json),
      });
      animationRef.current = animation;
      // animationData không có ảnh ngoài: lottie có thể đã vẽ xong ngay trong loadAnimation (trước khi kịp nghe sự kiện)
      if ((animation as any).isLoaded) callbacksRef.current.onReady?.();
      else animation.addEventListener('DOMLoaded', () => { if (!cancelled) callbacksRef.current.onReady?.(); });
    })().catch(() => { if (!cancelled) callbacksRef.current.onError?.(); });
    return () => {
      cancelled = true;
      animationRef.current?.destroy();
      animationRef.current = null;
    };
  }, [url]);

  React.useEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;
    if (playing) animation.play();
    else animation.goToAndStop(0, true);
  }, [playing]);

  return <div ref={containerRef} className={className} />;
}

export function TelegramStickerTile({ accountId, item, size = 64, cover = false, title, onClick, onContextMenu, className, children }: {
  accountId: string;
  item: TelegramStickerItem;
  /** Cạnh ô (px). `cover` (GIF): chiều cao ô, rộng theo cột, ảnh phủ kín. */
  size?: number;
  cover?: boolean;
  title?: string;
  onClick?: (item: TelegramStickerItem) => void;
  onContextMenu?: (event: React.MouseEvent, item: TelegramStickerItem) => void;
  className?: string;
  /** Lớp phủ thêm (vd. nút bỏ GIF đã lưu) — không đặt <button> bên trong (ô đã là button). */
  children?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const visible = useInView(ref, { rootMargin: '160px' });
  const [hover, setHover] = React.useState(false);
  const [broken, setBroken] = React.useState(false);
  // Bản động đã vẽ được khung đầu → ẩn ảnh tĩnh phía sau (sticker nền trong suốt, để cả hai thì thấy 2 hình chồng nhau)
  const [overlayReady, setOverlayReady] = React.useState(false);
  React.useEffect(() => { if (!hover) setOverlayReady(false); }, [hover]);

  const animated = item.format === 'tgs' || item.format === 'webm' || item.format === 'gif';
  const thumb = useStickerFile(accountId, item.id, 'thumb', visible);
  // Không có ảnh tĩnh → "thumb" đã là cả file (tgs nhỏ / video), phát luôn bản đó khi rê chuột
  const thumbIsFull = !!thumb && thumb.kind !== 'image';
  const full = useStickerFile(accountId, item.id, 'full', visible && hover && animated && !thumbIsFull);
  const fit = cover ? 'h-full w-full object-cover' : 'h-full w-full object-contain';

  let base: React.ReactNode = null;
  if (thumb && !broken) {
    if (thumb.kind === 'image') {
      base = <img src={thumb.url} alt={item.emoji} draggable={false} className={cn(fit, overlayReady && 'invisible')} onError={() => setBroken(true)} />;
    } else if (thumb.kind === 'tgs') {
      base = <TgsAnimation url={thumb.url} playing={hover} className="h-full w-full" onError={() => setBroken(true)} />;
    } else {
      base = <HoverVideo src={thumb.url} playing={hover} className={fit} onError={() => setBroken(true)} />;
    }
  }

  // Phủ đúng vùng ảnh tĩnh (ô sticker có đệm p-1)
  const box = cover ? 'absolute inset-0' : 'absolute inset-1';
  let overlay: React.ReactNode = null;
  if (hover && animated && full && !thumbIsFull && !broken) {
    if (full.kind === 'tgs') {
      overlay = <TgsAnimation url={full.url} playing className={box} onReady={() => setOverlayReady(true)} />;
    } else if (full.kind === 'video') {
      overlay = (
        <video src={full.url} muted loop playsInline autoPlay onLoadedData={() => setOverlayReady(true)}
          className={cn(box, cover ? 'h-full w-full object-cover' : 'h-[calc(100%-0.5rem)] w-[calc(100%-0.5rem)] object-contain')} />
      );
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      title={title ?? item.emoji}
      aria-label={title ?? (item.emoji ? `Sticker ${item.emoji}` : item.format === 'gif' ? 'GIF' : 'Sticker')}
      onClick={() => onClick?.(item)}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, item) : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={cover ? { height: size } : { width: size, height: size }}
      className={cn(
        'group relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        cover ? 'w-full bg-muted/60' : 'p-1 hover:bg-muted',
        className,
      )}
    >
      {base ?? (
        <span className={cn('select-none leading-none', cover ? 'text-xs font-semibold' : 'text-2xl', thumb === undefined && visible ? 'animate-pulse opacity-50' : 'opacity-40')}>
          {item.format === 'gif' ? 'GIF' : item.emoji || '🙂'}
        </span>
      )}
      {overlay}
      {children}
    </button>
  );
}

/** Ảnh tĩnh của sticker (biểu tượng bộ ở thanh chọn bộ) — không bấm được, không phát. */
export function StickerThumb({ accountId, item, className }: { accountId: string; item: TelegramStickerItem; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const visible = useInView(ref, { rootMargin: '80px' });
  const thumb = useStickerFile(accountId, item.id, 'thumb', visible);
  const [broken, setBroken] = React.useState(false);
  let content: React.ReactNode = <span className="text-base leading-none opacity-60">{item.emoji || '🙂'}</span>;
  if (thumb && !broken) {
    if (thumb.kind === 'image') content = <img src={thumb.url} alt="" draggable={false} className="h-full w-full object-contain" onError={() => setBroken(true)} />;
    else if (thumb.kind === 'tgs') content = <TgsAnimation url={thumb.url} playing={false} className="h-full w-full" onError={() => setBroken(true)} />;
    else content = <video src={thumb.url} muted playsInline preload="metadata" className="h-full w-full object-contain" onError={() => setBroken(true)} />;
  }
  return <span ref={ref} aria-hidden className={cn('flex items-center justify-center overflow-hidden', className)}>{content}</span>;
}

/** Video không có ảnh tĩnh: đứng ở khung đầu, phát khi rê chuột. */
function HoverVideo({ src, playing, className, onError }: { src: string; playing: boolean; className?: string; onError?: () => void }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (playing) video.play().catch(() => {});
    else { video.pause(); video.currentTime = 0; }
  }, [playing]);
  return <video ref={ref} src={src} muted loop playsInline preload="metadata" className={className} onError={onError} />;
}
