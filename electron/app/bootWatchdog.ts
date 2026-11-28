/**
 * The app page loaded again (F5, the dev server reconnecting after the laptop wakes, a hung-window reload, a language
 * change) but the app never started: a module request can stall without an error while the network or the disk is still
 * waking up, so there is no did-fail-load and nothing retries; the boot screen of index.html stayed until F5.
 *
 * BOOT_CHECK_AFTER_MS after the page's DOM is ready without app:rendererReady, main asks the page whether the app module
 * has run (src/ui/main.tsx sets html[data-deplao-app]):
 *  - not run: the load stalled → reload, at most BOOT_AUTO_RELOAD_LIMIT times per BOOT_AUTO_RELOAD_WINDOW_MS;
 *  - running: only slow → keep waiting (the boot screen offers Tải lại);
 *  - no answer: the page is busy → the hung-window guard (hungWindow.ts) owns that case.
 * Pure, tested; electron/main.ts wires it.
 */

export const BOOT_CHECK_AFTER_MS = 30_000;
export const BOOT_PROBE_TIMEOUT_MS = 5_000;
export const BOOT_AUTO_RELOAD_LIMIT = 2;
export const BOOT_AUTO_RELOAD_WINDOW_MS = 10 * 60_000;
/** A boot slower than this is written to the log when it finally shows. */
export const BOOT_SLOW_LOG_MS = 10_000;

export interface BootWatchdogDeps {
  now: () => number;
  log: (message: string) => void;
  warn: (message: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** The window still exists (not closed). */
  alive: () => boolean;
  /** html[data-deplao-app] of the page: '' while the app module has not run; null when the page did not answer in time. */
  probe: () => Promise<string | null>;
  reload: () => void;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

export function createBootWatchdog(deps: BootWatchdogDeps) {
  let timer: unknown = null;
  /** When the current page's DOM was ready (null = no boot being watched). */
  let startedAt: number | null = null;
  /** Bumped by every new page and by ready(): a probe answering for an older page is ignored. */
  let generation = 0;
  const autoReloads: number[] = [];

  const stopTimer = () => {
    if (timer === null) return;
    deps.clearTimer(timer);
    timer = null;
  };

  const check = async (gen: number) => {
    timer = null;
    if (gen !== generation || !deps.alive() || startedAt === null) return;
    const waited = seconds(deps.now() - startedAt);
    const app = await deps.probe();
    if (gen !== generation || !deps.alive()) return; // the app showed up, or another page started, while probing
    if (app === null) {
      deps.warn(`[Khởi động] Giao diện chưa hiện sau ${waited} s và trang không trả lời: chờ thêm`);
      return;
    }
    if (app) {
      deps.log(`[Khởi động] Giao diện chưa hiện sau ${waited} s nhưng app đang chạy (${app}): chờ thêm`);
      return;
    }
    const now = deps.now();
    while (autoReloads.length && now - autoReloads[0] > BOOT_AUTO_RELOAD_WINDOW_MS) autoReloads.shift();
    if (autoReloads.length >= BOOT_AUTO_RELOAD_LIMIT) {
      deps.warn(`[Khởi động] Giao diện vẫn kẹt sau ${waited} s, đã tự tải lại ${autoReloads.length} lần gần đây: chờ người dùng bấm Tải lại`);
      return;
    }
    autoReloads.push(now);
    deps.warn(`[Khởi động] Giao diện kẹt ${waited} s, app chưa chạy (mạng / ổ đĩa có thể vừa thức dậy): tự tải lại (lần ${autoReloads.length})`);
    deps.reload();
  };

  return {
    /** The page's DOM is ready (webContents 'dom-ready', top-level frame): the app module starts loading now. */
    pageLoaded(): void {
      stopTimer();
      generation++;
      startedAt = deps.now();
      const gen = generation;
      timer = deps.setTimer(() => { void check(gen); }, BOOT_CHECK_AFTER_MS);
    },
    /** app:rendererReady: React committed its first frame. */
    ready(): void {
      stopTimer();
      generation++;
      if (startedAt === null) return;
      const took = deps.now() - startedAt;
      startedAt = null;
      if (took >= BOOT_SLOW_LOG_MS) deps.log(`[Khởi động] Giao diện hiện sau ${seconds(took)} s`);
    },
  };
}
