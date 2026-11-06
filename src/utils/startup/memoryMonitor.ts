/**
 * RAM của Deplao theo từng tiến trình (app.getAppMetrics: main, cửa sổ, GPU, tiện ích) ghi vào Nhật ký "[Hiệu năng]"
 * mỗi 30 phút và khi cửa sổ ẩn / hiện lại: lần sau máy chậm biết ngay tiến trình nào giữ RAM. Đo 11/2026 (bản dev chạy
 * 6 giờ): GPU 1.015 MB riêng nhưng chỉ 28 MB trong RAM, cửa sổ chính 937 MB (378 MB trong RAM), main 293 MB.
 *
 * Cửa sổ ẩn / thu nhỏ từ 2 phút: preload gọi webFrame.clearCache() (app:trimMemory) để Chromium bỏ bộ đệm ảnh, tài
 * nguyên không còn trên màn hình (ảnh của các hội thoại đã đóng…). Ảnh đang hiển thị giữ nguyên; ảnh cũ mở lại thì đọc
 * lại từ ổ đĩa. Không đổi dữ liệu hay trạng thái nào của giao diện.
 */
import Logger from '../Logger';

export interface AppProcessMetric {
    type: string;
    name?: string;
    memory: { workingSetSize: number; privateBytes?: number };
}

interface WindowLike {
    isDestroyed(): boolean;
    isVisible(): boolean;
    isMinimized(): boolean;
    webContents: { send(channel: string): void };
}

export const MEMORY_LOG_INTERVAL_MS = 30 * 60_000;
export const TRIM_AFTER_HIDDEN_MS = 2 * 60_000;

const MB = (kb: number) => Math.round(kb / 1024);
const fmt = (mb: number) => mb.toLocaleString('vi-VN');

/** Một dòng tóm tắt: tổng riêng (private) + từng nhóm tiến trình; GPU kèm phần đang nằm trong RAM. */
export function describeAppMemory(metrics: AppProcessMetric[]): string {
    const priv = (m: AppProcessMetric) => MB(m.memory.privateBytes ?? m.memory.workingSetSize);
    let total = 0;
    const main: number[] = [];
    const windows: number[] = [];
    const gpu: Array<{ priv: number; ws: number }> = [];
    let other = 0;
    for (const m of metrics) {
        const p = priv(m);
        total += p;
        if (m.type === 'Browser') main.push(p);
        else if (m.type === 'Tab') windows.push(p);
        else if (m.type === 'GPU') gpu.push({ priv: p, ws: MB(m.memory.workingSetSize) });
        else other += p;
    }
    windows.sort((a, b) => b - a);
    const parts = [`tổng ${fmt(total)} MB`];
    if (main.length) parts.push(`main ${main.map(fmt).join(' + ')}`);
    if (windows.length) parts.push(`cửa sổ ${windows.map(fmt).join(' + ')}`);
    for (const g of gpu) parts.push(`GPU ${fmt(g.priv)} (trong RAM ${fmt(g.ws)})`);
    if (other) parts.push(`khác ${fmt(other)}`);
    return parts.join(' · ');
}

let started = false;
let metricsFn: (() => AppProcessMetric[]) | null = null;
let trimTimer: ReturnType<typeof setTimeout> | null = null;
let hiddenSince = 0;

function logMemory(reason: string): void {
    if (!metricsFn) return;
    try {
        Logger.log(`[Hiệu năng] RAM Deplao (${reason}): ${describeAppMemory(metricsFn())}`);
    } catch { /* đo lỗi không ảnh hưởng app */ }
}

/** main.ts (sau app ready): ghi RAM theo tiến trình mỗi 30 phút. */
export function startMemoryMonitor(metrics: () => AppProcessMetric[]): void {
    if (started) return;
    started = true;
    metricsFn = metrics;
    logMemory('khi mở app');
    const timer = setInterval(() => logMemory('định kỳ'), MEMORY_LOG_INTERVAL_MS);
    (timer as any).unref?.();
}

/** Cửa sổ chính vừa ẩn / thu nhỏ: 2 phút sau mà vẫn ẩn thì nhả bộ đệm của cửa sổ. */
export function noteWindowHidden(win: WindowLike): void {
    if (trimTimer) return;
    hiddenSince = Date.now();
    trimTimer = setTimeout(() => {
        trimTimer = null;
        try {
            if (win.isDestroyed() || (win.isVisible() && !win.isMinimized())) return;
            logMemory('cửa sổ ẩn 2 phút, nhả bộ đệm');
            win.webContents.send('app:trimMemory');
        } catch { /* cửa sổ vừa đóng */ }
    }, TRIM_AFTER_HIDDEN_MS);
    (trimTimer as any).unref?.();
}

/** Cửa sổ chính hiện lại. */
export function noteWindowShown(): void {
    if (trimTimer) {
        clearTimeout(trimTimer);
        trimTimer = null;
    }
    if (hiddenSince && Date.now() - hiddenSince >= TRIM_AFTER_HIDDEN_MS) logMemory('cửa sổ hiện lại');
    hiddenSince = 0;
}
