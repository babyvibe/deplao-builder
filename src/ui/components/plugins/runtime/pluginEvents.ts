/**
 * Groups the event subscriptions of all frames (pages, panels) of the same plugin: main keeps only one subscription
 * per plugin with the union of event types; the renderer filters again per frame before passing events into the iframe.
 */
import ipc from '@/lib/ipc';
import { tr } from '../../../../shared/i18n';

type Deliver = (event: any) => void;

const frames = new Map<string, Map<symbol, { types: string[]; deliver: Deliver }>>();
let offListener: (() => void) | null = null;

export function typeMatches(patterns: string[], type: string): boolean {
  return patterns.some(p => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}

function sync(pluginId: string): Promise<any> {
  const map = frames.get(pluginId);
  const union = new Set<string>();
  map?.forEach(f => f.types.forEach(t => union.add(t)));
  if (!union.size) return ipc.plugins?.unsubscribeEvents(pluginId) ?? Promise.resolve();
  return ipc.plugins?.subscribeEvents(pluginId, Array.from(union)) ?? Promise.resolve();
}

function ensureListener(): void {
  if (offListener || !ipc.on) return;
  offListener = ipc.on('plugins:event', (payload: { pluginId: string; event: any }) => {
    const map = frames.get(payload?.pluginId);
    if (!map) return;
    map.forEach(f => {
      if (typeMatches(f.types, String(payload.event?.type || ''))) f.deliver(payload.event);
    });
  });
}

/** Sets (or changes) the event types a frame wants to receive. Returns the result from main (permission error → reject). */
export async function setFrameEventTypes(pluginId: string, key: symbol, types: string[], deliver: Deliver): Promise<void> {
  let map = frames.get(pluginId);
  if (!map) {
    map = new Map();
    frames.set(pluginId, map);
  }
  if (types.length) map.set(key, { types, deliver });
  else map.delete(key);
  ensureListener();
  const res: any = await sync(pluginId);
  if (res && res.success === false) throw Object.assign(new Error(res.error || tr('Không đăng ký được sự kiện')), { code: res.code });
}

export function removeFrame(pluginId: string, key: symbol): void {
  const map = frames.get(pluginId);
  if (!map || !map.delete(key)) return;
  if (!map.size) frames.delete(pluginId);
  void sync(pluginId);
}
