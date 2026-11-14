/**
 * "Is the element visible in the scroll area?" using a SHARED IntersectionObserver per (scroll area, margin): a grid of hundreds of stickers
 * does not create hundreds of observers. `root` = the scroll container holding the element (`rootMargin` only has an effect with a root, so to load
 * before scrolling to it, pass the scroll container). Environments without IntersectionObserver (tests) → treated as visible.
 */
import React from 'react';

type Callback = (visible: boolean) => void;
interface SharedObserver { observer: IntersectionObserver; callbacks: Map<Element, Callback> }

const byRoot = new WeakMap<Element, Map<string, SharedObserver>>();
const byViewport = new Map<string, SharedObserver>();

function observersFor(root: Element | null): Map<string, SharedObserver> {
  if (!root) return byViewport;
  let map = byRoot.get(root);
  if (!map) byRoot.set(root, (map = new Map()));
  return map;
}

export function observeInView(element: Element, root: Element | null, rootMargin: string, callback: Callback): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    callback(true);
    return () => {};
  }
  const map = observersFor(root);
  let shared = map.get(rootMargin);
  if (!shared) {
    const callbacks = new Map<Element, Callback>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin });
    shared = { observer, callbacks };
    map.set(rootMargin, shared);
  }
  const current = shared;
  current.callbacks.set(element, callback);
  current.observer.observe(element);
  return () => {
    current.observer.unobserve(element);
    current.callbacks.delete(element);
    if (current.callbacks.size === 0) {
      current.observer.disconnect();
      if (map.get(rootMargin) === current) map.delete(rootMargin);
    }
  };
}

/** Scroll container of the sticker / GIF panel: cells in the panel are measured for "đang hiện" (visible) against this container. */
export const InViewRootContext = React.createContext<Element | null>(null);

/** `once`: once shown, stays true (a built item is not removed when scrolled past). */
export function useInView(ref: React.RefObject<Element | null>, options: { rootMargin?: string; once?: boolean } = {}): boolean {
  const root = React.useContext(InViewRootContext);
  const { rootMargin = '0px', once = false } = options;
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let stopped = false;
    let unobserve: (() => void) | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unobserve?.();
    };
    unobserve = observeInView(element, root, rootMargin, (next) => {
      if (stopped) return;
      setVisible(next);
      if (next && once) stop();
    });
    if (stopped) unobserve();
    return stop;
  }, [ref, root, rootMargin, once]);
  return visible;
}
