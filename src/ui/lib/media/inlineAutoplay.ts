import React from 'react';

/**
 * Tự phát video không tiếng trong khung chat (như Telegram) mà không làm nặng app:
 * - chỉ video đang hiện ≥ 50% trên màn hình; ra khỏi màn hình thì gỡ hẳn trình phát (giải phóng bộ giải mã),
 * - tối đa MAX_INLINE_AUTOPLAY video cùng lúc (video thứ 4 chờ tới lượt, hiện ảnh bìa),
 * - dừng khi cửa sổ bị ẩn / thu nhỏ, khi đang mở trình phát toàn màn hình, hoặc hệ thống bật "giảm chuyển động".
 */
export const MAX_INLINE_AUTOPLAY = 3;

const holders = new Set<object>();
const waiting = new Map<object, () => void>(); // thứ tự chèn = hàng đợi
let suspended = false;
const listeners = new Set<() => void>();

export function requestAutoplaySlot(token: object, grant: () => void): void {
  if (holders.has(token) || waiting.has(token)) return;
  if (holders.size < MAX_INLINE_AUTOPLAY) {
    holders.add(token);
    grant();
    return;
  }
  waiting.set(token, grant);
}

export function releaseAutoplaySlot(token: object): void {
  waiting.delete(token);
  if (!holders.delete(token)) return;
  const next = waiting.entries().next();
  if (next.done) return;
  const [nextToken, grant] = next.value;
  waiting.delete(nextToken);
  holders.add(nextToken);
  grant();
}

/** Đang mở trình phát toàn màn hình (có tiếng) → dừng mọi video tự phát trong khung chat. */
export function setInlineAutoplaySuspended(value: boolean): void {
  if (suspended === value) return;
  suspended = value;
  listeners.forEach((listener) => listener());
}

// Bật tiếng ngay trong khung chat: mỗi lúc chỉ 1 video có tiếng — bật video khác thì video trước tự tắt tiếng.
let soundOwner: object | null = null;
const soundLosers = new Map<object, () => void>();

export function claimInlineSound(token: object, onLose: () => void): void {
  if (soundOwner && soundOwner !== token) {
    const lose = soundLosers.get(soundOwner);
    soundLosers.delete(soundOwner);
    lose?.();
  }
  soundOwner = token;
  soundLosers.set(token, onLose);
}

export function releaseInlineSound(token: object): void {
  if (soundOwner === token) soundOwner = null;
  soundLosers.delete(token);
}

/** Chỉ dùng trong test. */
export function getInlineAutoplayState() {
  return { playing: holders.size, waiting: waiting.size, suspended, hasSound: !!soundOwner };
}

function usePageVisible(): boolean {
  const [visible, setVisible] = React.useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  React.useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

function useSuspended(): boolean {
  const [value, setValue] = React.useState(suspended);
  React.useEffect(() => {
    const listener = () => setValue(suspended);
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return value;
}

/** true khi video ở `ref` được phép phát ngay lúc này. */
export function useInlineAutoplay(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [inView, setInView] = React.useState(false);
  const [granted, setGranted] = React.useState(false);
  const pageVisible = usePageVisible();
  const isSuspended = useSuspended();
  const reducedMotion = React.useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  React.useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(!!entry && entry.isIntersecting && entry.intersectionRatio >= 0.5),
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(element);
    return () => { observer.disconnect(); setInView(false); };
  }, [enabled, ref]);

  const wants = enabled && inView && pageVisible && !isSuspended && !reducedMotion;
  React.useEffect(() => {
    if (!wants) return;
    const token = {};
    requestAutoplaySlot(token, () => setGranted(true));
    return () => {
      releaseAutoplaySlot(token);
      setGranted(false);
    };
  }, [wants]);

  return wants && granted;
}
