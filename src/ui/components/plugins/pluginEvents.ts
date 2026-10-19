/**
 * Gom đăng ký sự kiện của mọi khung (trang, panel) cùng một plugin: main chỉ giữ một đăng ký
 * mỗi plugin với hợp các loại sự kiện; renderer lọc lại theo từng khung trước khi chuyển vào iframe.
 */
import ipc from '@/lib/ipc';

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

/** Đặt (hoặc đổi) loại sự kiện một khung muốn nhận. Trả kết quả từ main (lỗi quyền → reject). */
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
  if (res && res.success === false) throw Object.assign(new Error(res.error || 'Không đăng ký được sự kiện'), { code: res.code });
}

export function removeFrame(pluginId: string, key: symbol): void {
  const map = frames.get(pluginId);
  if (!map || !map.delete(key)) return;
  if (!map.size) frames.delete(pluginId);
  void sync(pluginId);
}
