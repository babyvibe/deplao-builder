/**
 * Tiến độ tải media của một tin (video) → renderer vẽ vòng tiến độ + "2.1 / 5.0 MB" như Telegram và không mở trình phát
 * khi file chưa tải xong (event:mediaProgress; ui/lib/media/mediaProgress.ts).
 *
 * Chỉ gửi thẳng về renderer (sendDirect): không qua hook relay / workflow / sự kiện API — nhịp tiến độ không phải sự kiện
 * nghiệp vụ. Gom nhịp: tối đa ~4 lần / giây / tin; đổi trạng thái, đủ 100 %, xong hoặc lỗi thì gửi ngay.
 */
import EventBroadcaster from '../event/EventBroadcaster';

export type MediaProgressState = 'queued' | 'downloading' | 'done' | 'failed';

export interface MediaProgressEvent {
  zaloId: string;
  threadId: string;
  msgId: string;
  state: MediaProgressState;
  received: number;
  total: number;
}

export const MEDIA_PROGRESS_MIN_INTERVAL_MS = 250;

const lastSent = new Map<string, { at: number; state: MediaProgressState }>();

const toBytes = (value: unknown): number => {
  const n = Number((value as any)?.toString?.() ?? value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function reportMediaProgress(event: MediaProgressEvent, now = Date.now()): boolean {
  const zaloId = String(event.zaloId || '');
  const msgId = String(event.msgId || '');
  if (!zaloId || !msgId) return false;
  const threadId = String(event.threadId || '');
  const key = `${zaloId}|${threadId}|${msgId}`;
  const received = toBytes(event.received);
  const total = toBytes(event.total);
  const final = event.state === 'done' || event.state === 'failed';
  const previous = lastSent.get(key);
  const complete = total > 0 && received >= total;
  if (!final && previous && previous.state === event.state && !complete && now - previous.at < MEDIA_PROGRESS_MIN_INTERVAL_MS) {
    return false;
  }
  if (final) lastSent.delete(key);
  else lastSent.set(key, { at: now, state: event.state });
  try {
    EventBroadcaster.sendDirect('event:mediaProgress', { zaloId, threadId, msgId, state: event.state, received, total });
  } catch {
    // Báo tiến độ không bao giờ được làm hỏng lượt tải
  }
  return true;
}

/**
 * Báo tiến độ cho một lượt tải: `queued` lúc xếp hàng, `progress(received, total)` cho callback của axios / GramJS
 * (nhận số hoặc bigInt), `done` sau khi đã gửi event:localPath, `failed` khi tải hỏng.
 */
export function mediaProgressReporter(zaloId: string, threadId: string, msgId: string, knownTotal: unknown = 0) {
  let total = toBytes(knownTotal);
  const send = (state: MediaProgressState, received: unknown) =>
    reportMediaProgress({ zaloId, threadId, msgId, state, received: toBytes(received), total });
  return {
    queued: () => { send('queued', 0); },
    progress: (received: unknown, fullSize?: unknown) => {
      const size = toBytes(fullSize);
      if (size > 0) total = size;
      send('downloading', received);
    },
    done: () => { send('done', total); },
    failed: () => { send('failed', 0); },
  };
}

/** Quên trạng thái gom nhịp (test). */
export function resetMediaProgress(): void {
  lastSent.clear();
}
