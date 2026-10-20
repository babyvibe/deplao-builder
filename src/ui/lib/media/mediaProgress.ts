/**
 * Tiến độ tải media theo từng tin (event:mediaProgress của main — services/media/mediaProgress.ts): video đang tải hiện
 * vòng tiến độ + "2.1 / 5.0 MB" như Telegram, chưa tải xong thì không mở trình phát (file chưa đủ → trình phát báo lỗi).
 * Store riêng ngoài zustand: mỗi nhịp tiến độ chỉ vẽ lại đúng bong bóng của tin đó (useSyncExternalStore theo khoá).
 */
import { useCallback, useSyncExternalStore } from 'react';
import ipc from '@/lib/ipc';

export type MediaProgressState = 'queued' | 'downloading' | 'failed';

export interface MediaProgress {
  state: MediaProgressState;
  received: number;
  /** Tổng dung lượng (byte); 0 = máy chủ không báo. */
  total: number;
}

const entries = new Map<string, MediaProgress>();
const listeners = new Map<string, Set<() => void>>();
const MB = 1024 * 1024;

export function mediaProgressKey(zaloId: unknown, threadId: unknown, msgId: unknown): string {
  return `${String(zaloId ?? '')}|${String(threadId ?? '')}|${String(msgId ?? '')}`;
}

/** Nhận một sự kiện tiến độ: `done` → bỏ (bong bóng đã có file qua event:localPath), còn lại → lưu và báo bong bóng. */
export function applyMediaProgress(event: any): void {
  if (!event?.zaloId || !event?.msgId) return;
  const key = mediaProgressKey(event.zaloId, event.threadId, event.msgId);
  if (event.state === 'done') {
    if (!entries.delete(key)) return;
  } else if (event.state === 'queued' || event.state === 'downloading' || event.state === 'failed') {
    const previous = entries.get(key);
    const total = Number(event.total) > 0 ? Number(event.total) : (previous?.total || 0);
    entries.set(key, { state: event.state, received: Math.max(0, Number(event.received) || 0), total });
  } else {
    return;
  }
  listeners.get(key)?.forEach((listener) => listener());
}

/** Tiến độ hiện tại của một tin (ngoài React). */
export function getMediaProgress(zaloId: unknown, threadId: unknown, msgId: unknown): MediaProgress | null {
  return entries.get(mediaProgressKey(zaloId, threadId, msgId)) ?? null;
}

/** Đang chờ / đang tải (chưa có file để phát). */
export function isTransferring(progress: MediaProgress | null | undefined): progress is MediaProgress {
  return !!progress && (progress.state === 'queued' || progress.state === 'downloading');
}

/** Phần đã tải (0..1) hoặc null khi chưa biết tổng / chưa bắt đầu (vòng xoay). */
export function transferFraction(progress: MediaProgress | null | undefined, fallbackTotal = 0): number | null {
  if (!progress || progress.state !== 'downloading') return null;
  const total = progress.total || fallbackTotal;
  if (!(total > 0)) return null;
  return Math.min(1, Math.max(0, progress.received / total));
}

function formatAmount(bytes: number, unit: number, decimals: number): string {
  return (bytes / unit).toFixed(decimals);
}

/** "2.1 / 5.0 MB" (như Telegram); chưa biết tổng → "2.1 MB"; file nhỏ tính KB. */
export function formatTransferProgress(received: number, total: number): string {
  const r = Math.max(0, Number(received) || 0);
  const t = Math.max(0, Number(total) || 0);
  const scale = Math.max(r, t);
  if (scale < MB) {
    const kb = (value: number) => String(Math.max(value > 0 ? 1 : 0, Math.round(value / 1024)));
    return t > 0 ? `${kb(r)} / ${kb(t)} KB` : `${kb(r)} KB`;
  }
  const decimals = scale >= 100 * MB ? 0 : 1;
  return t > 0 ? `${formatAmount(r, MB, decimals)} / ${formatAmount(t, MB, decimals)} MB` : `${formatAmount(r, MB, decimals)} MB`;
}

let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    ipc.on?.('event:mediaProgress', (data: any) => applyMediaProgress(data));
  } catch {
    subscribed = false;
  }
}

/** Tiến độ tải của một tin (null = không có lượt tải nào đang chạy / đã xong). */
export function useMediaProgress(zaloId: unknown, threadId: unknown, msgId: unknown): MediaProgress | null {
  ensureSubscribed();
  const key = zaloId && msgId ? mediaProgressKey(zaloId, threadId, msgId) : '';
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) listeners.delete(key);
    };
  }, [key]);
  const getSnapshot = useCallback(() => (key ? entries.get(key) ?? null : null), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Tiện cho bong bóng: tiến độ của tin `msg` (owner_zalo_id / thread_id / msg_id). */
export function useMessageMediaProgress(msg: any): MediaProgress | null {
  return useMediaProgress(
    msg?.owner_zalo_id || msg?.zaloId,
    msg?.thread_id ?? msg?.threadId,
    msg?.msg_id ?? msg?.msgId,
  );
}

/** Test. */
export function resetMediaProgressStore(): void {
  entries.clear();
  listeners.clear();
}
