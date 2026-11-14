import React from 'react';

/**
 * Autoplay videos muted inside the chat frame (like Telegram) without making the app heavy:
 * - only videos at least 50% visible on screen; when they leave the screen the player is removed completely (frees the decoder),
 * - at most MAX_INLINE_AUTOPLAY videos at once (the 4th video waits for its turn and shows the cover image),
 * - stops when the window is hidden / minimized, when the fullscreen player is open, or when the system turns on "giảm chuyển động" (reduce motion).
 */
export const MAX_INLINE_AUTOPLAY = 3;

const holders = new Set<object>();
const waiting = new Map<object, () => void>(); // insertion order = queue order
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

/** Fullscreen player open (with sound) → stop all autoplaying videos in the chat frame. */
export function setInlineAutoplaySuspended(value: boolean): void {
  if (suspended === value) return;
  suspended = value;
  listeners.forEach((listener) => listener());
}

// Unmute inside the chat frame: only 1 video can have sound at a time; unmuting another video mutes the previous one.
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

/** Test only. */
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

/** true when the video in `ref` is allowed to play right now. */
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
