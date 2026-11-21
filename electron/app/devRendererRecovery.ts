/**
 * Dev build only: the renderer comes from the dev server (http://localhost:27799). While the laptop sleeps Windows
 * suspends the loopback socket (ERR_NETWORK_IO_SUSPENDED) and pages the dev server's process out, so a reload started right
 * after waking can fail and leave an empty dark window. These are the recovery rules (pure, tested); electron/main.ts owns
 * the timers, the reachability check and the navigation. Packaged builds load local files and are never reloaded here.
 */

/** Waits between recovery attempts: 1.5 s, 3 s, 5 s, then every 10 s. */
export const DEV_RENDERER_RETRY_DELAYS_MS = [1_500, 3_000, 5_000, 10_000] as const;
/** Stop after this long without a successful load (the dev server is probably stopped): start it again, then F5. */
export const DEV_RENDERER_RECOVERY_WINDOW_MS = 10 * 60_000;
/** Chromium net error: the navigation was replaced by another one (F5, the dev client's own reload, a recovery attempt). */
export const ERR_ABORTED = -3;

export type DevLoadFailure = 'ignore' | 'suspended' | 'retry';

/**
 * A failed load in the main window: what recovery does. Sub-frames (app pages, Mini Apps, embedded previews) never reload
 * the whole UI; they used to, so one iframe failing during sleep reloaded the app into a dark window.
 */
export function classifyDevLoadFailure(errorCode: number, errorDescription: string, isMainFrame: boolean): DevLoadFailure {
  if (!isMainFrame || errorCode === ERR_ABORTED) return 'ignore';
  if (String(errorDescription || '').includes('ERR_NETWORK_IO_SUSPENDED')) return 'suspended';
  return 'retry';
}

/** Delay before recovery attempt `attempt` (0-based). */
export function devRendererRetryDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(Number(attempt) || 0), DEV_RENDERER_RETRY_DELAYS_MS.length - 1));
  return DEV_RENDERER_RETRY_DELAYS_MS[index];
}

/** Recovery started at `startedAt` has run out of time (0 = not started yet). */
export function devRecoveryExpired(startedAt: number, now: number): boolean {
  return startedAt > 0 && now - startedAt > DEV_RENDERER_RECOVERY_WINDOW_MS;
}
