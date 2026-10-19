/**
 * "Phần tử đang hiện trong vùng cuộn?" bằng IntersectionObserver DÙNG CHUNG theo (vùng cuộn, lề) — lưới vài trăm sticker
 * không tạo vài trăm observer. `root` = khung cuộn chứa phần tử (lề `rootMargin` chỉ có tác dụng với root, nên muốn tải
 * trước khi cuộn tới thì truyền khung cuộn). Môi trường không có IntersectionObserver (test) → coi như đang hiện.
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

/** Khung cuộn của bảng sticker / GIF — ô trong bảng đo "đang hiện" theo khung này. */
export const InViewRootContext = React.createContext<Element | null>(null);

/** `once`: đã hiện 1 lần thì giữ true (mục đã dựng không gỡ khi cuộn qua). */
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
