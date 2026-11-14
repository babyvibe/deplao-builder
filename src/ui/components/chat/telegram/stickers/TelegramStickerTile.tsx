/**
 * Telegram sticker / GIF tile in the grid (input box panel, sticker set popup). Loads only when the tile is shown: a small static image (Telegram
 * thumbnail) for the grid; hovering over an animated / video / GIF sticker loads the whole file and plays it (like Telegram, but not
 * the whole grid at once: dozens of Lottie / video playing in parallel makes the chat window stutter).
 */
import React from 'react';
import { cn } from '@/lib/cn';
import { useInView } from '@/lib/media/inView';
import { loadTgsJson } from '@/lib/media/tgs';
import { useStickerFile, type TelegramStickerItem } from '@/lib/chat/telegram/telegramStickerStore';
import { tr } from '../../../../../shared/i18n';

/** Lottie (.tgs). `playing` = false → stays on the first frame. `onReady`: the first frame has been drawn. */
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
      // animationData has no external images: lottie may finish drawing right inside loadAnimation (before the event listener can be attached)
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
  /** Tile edge (px). `cover` (GIF): the tile height, width follows the column, image covers fully. */
  size?: number;
  cover?: boolean;
  title?: string;
  onClick?: (item: TelegramStickerItem) => void;
  onContextMenu?: (event: React.MouseEvent, item: TelegramStickerItem) => void;
  className?: string;
  /** Extra overlay (e.g. the remove button for a saved GIF): do not put a <button> inside (the tile is already a button). */
  children?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const visible = useInView(ref, { rootMargin: '160px' });
  const [hover, setHover] = React.useState(false);
  const [broken, setBroken] = React.useState(false);
  // The animated version has drawn its first frame → hide the static image behind it (a transparent-background sticker would show two images stacked on top of each other)
  const [overlayReady, setOverlayReady] = React.useState(false);
  React.useEffect(() => { if (!hover) setOverlayReady(false); }, [hover]);

  const animated = item.format === 'tgs' || item.format === 'webm' || item.format === 'gif';
  const thumb = useStickerFile(accountId, item.id, 'thumb', visible);
  // No static image → the "thumb" is already the whole file (small tgs / video), play that copy on hover
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

  // Cover exactly the static image area (the sticker tile has p-1 padding)
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
      aria-label={title ?? (item.emoji ? tr('Sticker {{emoji}}', { emoji: item.emoji }) : item.format === 'gif' ? tr('GIF') : tr('Sticker'))}
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
          {item.format === 'gif' ? tr('GIF') : item.emoji || '🙂'}
        </span>
      )}
      {overlay}
      {children}
    </button>
  );
}

/** Static image of a sticker (the set icon in the set picker bar): not clickable, does not play. */
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

/** Video without a static image: stays on the first frame, plays on hover. */
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
