/**
 * Catch-up messages after being offline (Telegram difference / channel history, old messages reloaded) flood the UI as thousands of adjacent event:message
 * events: each message triggers a store update + a redraw of the conversation list (log 28/10/2026: "Giao diện bận 14.3 s" (UI busy 14.3 s) when the app opened
 * after 1 day). Silent messages of a conversation that is NOT open are batched and processed later, within ≤ `delayMs`, each task ≤ `sliceMs`
 * (React draws once for the whole part, and between the parts the user's actions are still handled). The open conversation and normal messages are processed
 * right away, after the pending messages have been handled, so the message order does not change.
 */
export const CATCH_UP_DELAY_MS = 250;
export const CATCH_UP_SLICE_MS = 8;

export type CatchUpBatcher<T> = {
  /** Puts into the queue. */
  defer: (item: T) => void;
  /** Processes every pending message right away, in order (before messages that must be handled now, before edit / delete / reaction events). */
  flush: () => void;
  /** Processes the remaining pending messages, then stops accepting new ones. */
  close: () => void;
  size: () => number;
};

type BatcherOptions = {
  delayMs?: number;
  sliceMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
};

export function createCatchUpBatcher<T>(process: (item: T) => void, options: BatcherOptions = {}): CatchUpBatcher<T> {
  const delayMs = options.delayMs ?? CATCH_UP_DELAY_MS;
  const sliceMs = options.sliceMs ?? CATCH_UP_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  const onError = options.onError ?? ((err: unknown) => console.error('[catchUpEventBatcher]', err));
  let queue: T[] = [];
  let head = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const pending = () => queue.length - head;
  const takeNext = (): T => {
    const item = queue[head++];
    if (head === queue.length) {
      queue = [];
      head = 0;
    }
    return item;
  };
  const runOne = (item: T) => {
    try {
      process(item);
    } catch (err) {
      onError(err);
    }
  };
  const schedule = (ms: number) => {
    if (timer === null && pending() > 0) timer = setTimeout(drainSlice, ms);
  };
  function drainSlice() {
    timer = null;
    const start = now();
    while (pending() > 0) {
      runOne(takeNext());
      if (now() - start >= sliceMs) break;
    }
    schedule(0);
  }
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    while (pending() > 0) runOne(takeNext());
  };

  return {
    defer(item) {
      if (closed) {
        runOne(item);
        return;
      }
      queue.push(item);
      schedule(delayMs);
    },
    flush,
    close() {
      closed = true;
      flush();
    },
    size: pending,
  };
}

/** An event:message that can be batched: a silent message (catch-up after offline / old message), not my own, not in the open conversation. */
export function isDeferrableCatchUpMessage(
  data: any,
  active: { accountId?: string | null; threadId?: string | null },
): boolean {
  const message = data?.message;
  if (!message || message.isSelf === true) return false;
  if (message._silentNotification !== true && message._silent !== true) return false;
  const threadId = String(message.threadId || '');
  if (!threadId) return false;
  return !(threadId === String(active.threadId || '') && String(data?.zaloId || '') === String(active.accountId || ''));
}
