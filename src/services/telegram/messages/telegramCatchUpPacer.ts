/**
 * Telegram catch-up pacing after going offline (GetDifference, ChannelDifference, TooLong channel history, conversation resync,
 * dialog watch pass). Each message is a few synchronous SQLite commands + one event:message; `await handleNewMessage` only yields a
 * microtask, so thousands of messages run as ONE block on the main thread: the UI's IPC (opening a conversation, loading messages) must wait for the
 * whole block. The pacer lets the work run for at most `sliceMs`, then rests `restMs` (setTimeout) so IPC, realtime messages and user actions
 * can get in: catch-up speed drops to about 60 %, and no block is longer than ~12 ms. With few messages nothing gets slower.
 *
 * One pacer is shared by all accounts and all catch-up passes: while it rests, every pass waits together (if each pass had its own pacer,
 * one pass would rest while another kept working, and the main thread would never rest).
 */
export const CATCH_UP_SLICE_MS = 12;
export const CATCH_UP_REST_MS = 8;

export type CatchUpPacer = () => Promise<void>;

type PacerOptions = {
  sliceMs?: number;
  restMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const monotonicNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createCatchUpPacer(options: PacerOptions = {}): CatchUpPacer {
  const sliceMs = options.sliceMs ?? CATCH_UP_SLICE_MS;
  const restMs = options.restMs ?? CATCH_UP_REST_MS;
  const now = options.now ?? monotonicNow;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let sliceStart: number | null = null;
  let resting: Promise<void> | null = null;
  return async () => {
    if (resting) return resting;
    const at = now();
    // First call (or the clock went back) opens a refresh pass
    if (sliceStart === null || at < sliceStart) {
      sliceStart = at;
      return;
    }
    if (at - sliceStart < sliceMs) return;
    resting = sleep(restMs).then(() => {
      resting = null;
      sliceStart = now();
    });
    return resting;
  };
}

/** Items of the open conversation go first, keeping the order within each group (the order of messages within a conversation does not change). */
export function focusFirst<T>(items: T[], isFocused: (item: T) => boolean): T[] {
  const focused: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isFocused(item) ? focused : rest).push(item);
  return focused.length && rest.length ? [...focused, ...rest] : items;
}
