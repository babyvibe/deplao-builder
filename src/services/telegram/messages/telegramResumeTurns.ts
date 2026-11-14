/**
 * Telegram catch-up after the machine wakes up / unlocks: each account ONE AT A TIME (the account with the open conversation first), each turn
 * a few seconds after the previous one. Previously every account caught up in full at the same time (GetDifference, channel history, conversation resync)
 * just as Windows was reloading memory from disk, and the app froze. The catch-up work for each account is unchanged; only the start time changes.
 *
 * Outside the window after waking (windowMs), when nobody is waiting: runs at once as before. A catch-up turn longer than maxTurnMs means the next
 * account stops waiting (the long turn still keeps running).
 */

export const RESUME_TURN_WINDOW_MS = 5 * 60_000;
export const RESUME_TURN_GAP_MS = 3_000;
export const RESUME_TURN_MAX_MS = 60_000;

export interface ResumeTurns {
  /** The machine just woke up / was unlocked: catch-up turns within windowMs run one after another. */
  noteWake(at?: number): void;
  /** Wait for the account's turn; returns a release function (call it when catch-up is done; calling again is harmless). */
  turn(accountId: string): Promise<() => void>;
  /** Number of accounts waiting for a turn. */
  waiting(): number;
}

type Timer = unknown;

export function createResumeTurns(opts: {
  /** Accounts with an open Telegram conversation (they go first). */
  focusedAccount: () => string | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  windowMs?: number;
  gapMs?: number;
  maxTurnMs?: number;
}): ResumeTurns {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as any)?.unref?.();
    return t;
  });
  const clearTimer = opts.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const windowMs = opts.windowMs ?? RESUME_TURN_WINDOW_MS;
  const gapMs = opts.gapMs ?? RESUME_TURN_GAP_MS;
  const maxTurnMs = opts.maxTurnMs ?? RESUME_TURN_MAX_MS;

  let windowUntil = 0;
  let nextAt = 0;
  let holder: { release: () => void } | null = null;
  let pumpTimer: Timer | null = null;
  const queue: Array<{ accountId: string; grant: (release: () => void) => void }> = [];
  const noop = () => undefined;

  const pump = (): void => {
    if (holder || !queue.length || pumpTimer) return;
    const wait = nextAt - now();
    if (wait > 0) {
      pumpTimer = setTimer(() => {
        pumpTimer = null;
        pump();
      }, wait);
      return;
    }
    const focused = opts.focusedAccount();
    const idx = focused ? queue.findIndex(w => w.accountId === focused) : -1;
    const [next] = queue.splice(idx >= 0 ? idx : 0, 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimer(maxTimer);
      if (holder === current) holder = null;
      nextAt = now() + gapMs;
      pump();
    };
    const current = { release };
    holder = current;
    const maxTimer = setTimer(release, maxTurnMs);
    next.grant(release);
  };

  return {
    noteWake(at = now()) {
      windowUntil = Math.max(windowUntil, at + windowMs);
    },
    turn(accountId: string) {
      if (now() >= windowUntil && !holder && !queue.length) return Promise.resolve(noop);
      return new Promise<() => void>(resolve => {
        queue.push({ accountId: String(accountId), grant: resolve });
        pump();
      });
    },
    waiting: () => queue.length,
  };
}
