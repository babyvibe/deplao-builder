/**
 * After the laptop wakes or the screen unlocks, Deplao asks the main window for a fresh picture (webContents.invalidate)
 * and times how long the UI takes to paint again. The time goes to Settings → Logs as "[Hiệu năng] …", so a slow wake can
 * be measured instead of guessed.
 *
 * Also the Chromium switches that keep the picture during sleep (disabledChromiumFeatures). Pure, tested; main.ts wires it.
 */

/** A paint slower than this after waking is logged as a warning. */
export const WAKE_PAINT_SLOW_MS = 2_000;
/** No paint after this long: the UI is stuck or paged out; logged once. */
export const WAKE_PAINT_TIMEOUT_MS = 20_000;
/** A second wake report within this window is the same wake. */
export const DUPLICATE_WAKE_MS = 5_000;

/**
 * Chromium features to turn off, as ONE comma-separated value: a second appendSwitch('disable-features') replaces the
 * first, so the old two calls only turned off "Autofill".
 *  - AutofillServerCommunication, Autofill: no DevTools "Autofill.enable" / "Autofill.setAddresses" errors.
 *  - CalculateNativeWinOcclusion (Windows): Chromium marks every window as covered while the screen is off or locked (lid
 *    closed, Modern Standby) and drops its picture; on wake the window stayed dark until the renderer, paged out by Windows
 *    during sleep, drew a whole new frame. VS Code turns it off for the same reason. Cost: a window covered by other
 *    windows keeps drawing (a minimized or hidden window still stops).
 */
export function disabledChromiumFeatures(platform: string): string {
  const features = ['AutofillServerCommunication', 'Autofill'];
  if (platform === 'win32') features.push('CalculateNativeWinOcclusion');
  return features.join(',');
}

export interface WakePaintTarget {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  webContents: { invalidate(): void; send(channel: string, ...args: unknown[]): void };
}

export interface WakePaintDeps {
  now: () => number;
  log: (message: string) => void;
  warn: (message: string) => void;
  setTimer: (fn: () => void, ms: number) => void;
}

/** IPC: main → preload asks for a paint; preload → main answers with the same id two animation frames later. */
export const WAKE_PAINT_REQUEST = 'app:wakePaint';
export const WAKE_PAINT_DONE = 'app:wakePainted';

const seconds = (ms: number) => (ms / 1000).toFixed(1);

export function createWakePaintCheck(deps: WakePaintDeps) {
  let seq = 0;
  let pending: { id: number; at: number } | null = null;
  return {
    /** The machine woke: nudge a repaint and time it. false = nothing to check (window closed, hidden in the tray, minimized). */
    start(win: WakePaintTarget | null | undefined): boolean {
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
      // The same wake reported twice (powerMonitor + the wake watch): keep timing from the first report
      if (pending && deps.now() - pending.at < DUPLICATE_WAKE_MS) return true;
      const id = ++seq;
      pending = { id, at: deps.now() };
      try { win.webContents.invalidate(); } catch { /* the window is closing */ }
      try { win.webContents.send(WAKE_PAINT_REQUEST, id); } catch { /* the window is closing */ }
      deps.setTimer(() => {
        if (pending?.id !== id) return;
        pending = null;
        deps.warn(`[Hiệu năng] Giao diện chưa vẽ lại sau ${seconds(WAKE_PAINT_TIMEOUT_MS)} s kể từ khi máy thức dậy`);
      }, WAKE_PAINT_TIMEOUT_MS);
      return true;
    },
    /** The renderer painted for request `id`; returns the time it took (null = stale or unknown id). */
    painted(id: unknown): number | null {
      if (!pending || pending.id !== Number(id)) return null;
      const elapsed = Math.max(0, deps.now() - pending.at);
      pending = null;
      const line = `[Hiệu năng] Giao diện vẽ lại sau khi máy thức dậy: ${seconds(elapsed)} s`;
      if (elapsed >= WAKE_PAINT_SLOW_MS) deps.warn(line); else deps.log(line);
      return elapsed;
    },
  };
}
