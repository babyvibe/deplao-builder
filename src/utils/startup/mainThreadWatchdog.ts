/**
 * Detects when the main thread of the main process is blocked. Windows reports "Not Responding" when this thread stays busy for ≥ 5 s
 * (synchronous SQLite, long loops…). It only writes to Logs when there is a real block, so it costs almost nothing normally, and so that
 * the next time the app freezes you can see right away what caused it (Settings → Logs, filter "Hiệu năng" (Performance)):
 *  - startMainThreadWatchdog(): a 1 s timer; a delay ≥ BLOCK_LOG_MS → "Luồng chính bị chặn ~X s (N s sau khi mở app)" (main thread blocked ~X s, N s after app start).
 *  - timeIpc(): measures the synchronous part of an IPC handler (handlerRegistry wraps every ipcMain.handle) → writes the channel name.
 */
import Logger from '../Logger';

/** Only log from this level up (under 1 s is a minor stutter that does not make the app "Not Responding"). */
export const BLOCK_LOG_MS = 1000;
const TICK_MS = 1000;

const APP_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const sinceStart = (ts: number): string => `${Math.max(0, Math.round((ts - APP_STARTED_AT) / 1000))} s sau khi mở app`;

let started = false;

export function startMainThreadWatchdog(): void {
    if (started) return;
    started = true;
    let expected = Date.now() + TICK_MS;
    const timer = setInterval(() => {
        const now = Date.now();
        const lag = now - expected;
        expected = now + TICK_MS;
        if (lag >= BLOCK_LOG_MS) {
            Logger.warn(`[Hiệu năng] Luồng chính bị chặn ~${(lag / 1000).toFixed(1)} s (${sinceStart(now - lag)})`);
        }
    }, TICK_MS);
    (timer as any).unref?.();
}

/** Run the handler and measure the synchronous part (up to the first await); ≥ BLOCK_LOG_MS → log the IPC channel that blocked the main thread. */
export function timeIpc<T>(channel: string, run: () => T): T {
    const t0 = Date.now();
    try {
        return run();
    } finally {
        const ms = Date.now() - t0;
        if (ms >= BLOCK_LOG_MS) {
            Logger.warn(`[Hiệu năng] IPC ${channel} chạy đồng bộ ${ms} ms trên luồng chính (${sinceStart(t0)})`);
        }
    }
}
