/**
 * Phát hiện luồng chính của main process bị chặn. Windows báo "Not Responding" khi luồng này bận liền ≥ 5 s
 * (SQLite đồng bộ, vòng lặp dài…). Chỉ ghi Nhật ký khi có chặn thật — lúc bình thường gần như không tốn gì — để lần
 * sau app đứng biết ngay do đâu (Cài đặt → Nhật ký, lọc "Hiệu năng"):
 *  - startMainThreadWatchdog(): đồng hồ 1 s; trễ ≥ BLOCK_LOG_MS → "Luồng chính bị chặn ~X s (N s sau khi mở app)".
 *  - timeIpc(): đo phần chạy đồng bộ của một IPC handler (handlerRegistry bọc mọi ipcMain.handle) → ghi tên kênh.
 */
import Logger from './Logger';

/** Từ mức này mới ghi (dưới 1 s là giật nhẹ, không làm "Not Responding"). */
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

/** Chạy handler và đo phần đồng bộ (tới lần await đầu tiên); ≥ BLOCK_LOG_MS → ghi kênh IPC đã chặn luồng chính. */
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
