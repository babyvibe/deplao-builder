/**
 * The "app đã ổn định" (app settled) marker after the app opens (main process): the UI has finished loading the conversation list (the renderer sends
 * app:uiSettled) and the main thread is no longer busy. Heavy background work (Telegram catch-up sync / reloading old messages, scanning the conversation list,
 * restoring channel queues…) waits for this marker: running it right when the app opens competes for CPU / IPC while the UI is still being built, and the app stutters. New
 * messages that arrive directly (socket) do not have to wait.
 *
 * If the renderer does not report it (error, window not loaded…), it opens by itself after armStartupSettleFallback. Once open, it stays open for the whole session
 * (a reconnect in the middle does not have to wait again).
 */
import Logger from '../Logger';

type SettledTask = () => void;

let settled = false;
let waiting: SettledTask[] = [];
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let idleWatchStarted = false;

export function isStartupSettled(): boolean {
  return settled;
}

/** Run `task` once the app has settled (immediately if it already has). */
export function whenStartupSettled(task: SettledTask): void {
  if (settled) {
    task();
    return;
  }
  waiting.push(task);
}

export function markStartupSettled(reason: string): void {
  if (settled) return;
  settled = true;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  const tasks = waiting;
  waiting = [];
  Logger.log(`[startup] App settled (${reason}); starting ${tasks.length} deferred background task(s)`);
  for (const task of tasks) {
    try {
      task();
    } catch (err: any) {
      Logger.warn(`[startup] Deferred task failed: ${err?.message || err}`);
    }
  }
}

/** Safety net: the renderer does not report the UI loaded within `ms` → the marker still opens. */
export function armStartupSettleFallback(ms: number): void {
  if (settled || fallbackTimer) return;
  fallbackTimer = setTimeout(() => markStartupSettled('fallback'), ms);
  (fallbackTimer as any).unref?.();
}

const IDLE_SAMPLE_MS = 250;
const IDLE_MAX_LAG_MS = 40;
const IDLE_CALM_SAMPLES = 4;

/**
 * The UI has loaded: open the marker when the main thread is also idle (timer delay < 40 ms in 4 consecutive measurements, after at least
 * `minDelayMs`). A Zalo / Facebook login running at startup may still be going. Waits at most `maxWaitMs`.
 */
export function settleWhenMainIdle(reason: string, opts: { minDelayMs?: number; maxWaitMs?: number } = {}): void {
  if (settled || idleWatchStarted) return;
  idleWatchStarted = true;
  const minDelayMs = opts.minDelayMs ?? 2_000;
  const maxWaitMs = opts.maxWaitMs ?? 20_000;
  const startedAt = Date.now();
  let calm = 0;
  let expectedAt = startedAt + IDLE_SAMPLE_MS;
  const sample = () => {
    if (settled) return;
    const now = Date.now();
    calm = now - expectedAt < IDLE_MAX_LAG_MS ? calm + 1 : 0;
    const elapsed = now - startedAt;
    if ((elapsed >= minDelayMs && calm >= IDLE_CALM_SAMPLES) || elapsed >= maxWaitMs) {
      markStartupSettled(elapsed >= maxWaitMs && calm < IDLE_CALM_SAMPLES ? `${reason}, main still busy` : reason);
      return;
    }
    expectedAt = now + IDLE_SAMPLE_MS;
    const timer = setTimeout(sample, IDLE_SAMPLE_MS);
    (timer as any).unref?.();
  };
  const timer = setTimeout(sample, IDLE_SAMPLE_MS);
  (timer as any).unref?.();
}

/** Test only. */
export function __resetStartupSettleForTests(): void {
  settled = false;
  waiting = [];
  idleWatchStarted = false;
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = null;
}
