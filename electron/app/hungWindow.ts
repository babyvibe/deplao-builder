/**
 * The main window stopped answering input (BrowserWindow 'unresponsive': Chromium's hang monitor gives up after ~15 s).
 * Right after the laptop wakes, Windows pages the renderer back in while catch-up events pile up, so it can stay busy for
 * tens of seconds and then recover by itself. The old handler reloaded at once: the conversation on screen was dropped and
 * the window went empty again. Now it waits for 'responsive' and
 * reloads only if the window is still hung after UNRESPONSIVE_RELOAD_GRACE_MS. Pure, tested; electron/main.ts wires it.
 */

/** How long a hung window gets to recover by itself before the UI is reloaded. */
export const UNRESPONSIVE_RELOAD_GRACE_MS = 45_000;

export interface HungWindowDeps {
  now: () => number;
  log: (message: string) => void;
  warn: (message: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** The window still exists (not closed). */
  alive: () => boolean;
  reload: () => void;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

export function createHungWindowGuard(deps: HungWindowDeps) {
  /** When the current hang was first reported (null = no hang). */
  let since: number | null = null;
  let timer: unknown = null;
  return {
    /** BrowserWindow 'unresponsive'. Repeated reports while waiting are the same hang. */
    unresponsive(): void {
      if (timer !== null) return;
      const startedAt = deps.now();
      since = startedAt;
      deps.warn(`[Hiệu năng] Cửa sổ không phản hồi: chờ ${seconds(UNRESPONSIVE_RELOAD_GRACE_MS)} s trước khi tải lại giao diện`);
      timer = deps.setTimer(() => {
        timer = null;
        since = null;
        if (!deps.alive()) return;
        deps.warn(`[Hiệu năng] Cửa sổ vẫn không phản hồi sau ${seconds(deps.now() - startedAt)} s: tải lại giao diện`);
        deps.reload();
      }, UNRESPONSIVE_RELOAD_GRACE_MS);
    },
    /** BrowserWindow 'responsive': the window recovered by itself, nothing is reloaded. */
    responsive(): void {
      if (timer !== null) {
        deps.clearTimer(timer);
        timer = null;
      }
      if (since === null) return;
      deps.log(`[Hiệu năng] Cửa sổ phản hồi lại sau ${seconds(deps.now() - since)} s`);
      since = null;
    },
  };
}
