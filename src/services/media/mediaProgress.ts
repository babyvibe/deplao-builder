/**
 * Download progress of a message's media (video) → the renderer draws a progress ring + "2.1 / 5.0 MB" like Telegram, and does not open the player
 * until the file has finished downloading (event:mediaProgress; ui/lib/media/mediaProgress.ts).
 *
 * Sent straight to the renderer (sendDirect): it does not go through the relay / workflow / API event hooks, because progress ticks are not business events.
 * Throttled: at most ~4 times / second / message; a state change, reaching 100 %, completion or an error is sent immediately.
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
    // Reporting progress must never break the download
  }
  return true;
}

/**
 * Reports progress for one download: `queued` when it joins the queue, `progress(received, total)` for the axios / GramJS callback
 * (accepts a number or bigInt), `done` after event:localPath has been sent, `failed` when the download fails.
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

/** Forgets the throttle state (for tests). */
export function resetMediaProgress(): void {
  lastSent.clear();
}
