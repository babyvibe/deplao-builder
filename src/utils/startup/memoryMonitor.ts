/**
 * Deplao RAM per process (app.getAppMetrics: main, windows, GPU, utility) is written to Logs as "[Hiệu năng]" (Performance)
 * every 30 minutes and when a window is hidden / shown again, so the next time the machine is slow you can see right away which process holds the RAM. Measured in 11/2026 (dev build running for
 * 6 hours): GPU 1,015 MB private but only 28 MB in RAM, main window 937 MB (378 MB in RAM), main 293 MB.
 *
 * A window hidden / minimized for 2 minutes: the preload calls webFrame.clearCache() (app:trimMemory) so Chromium drops the image cache and resources that are no longer on screen
 * (images of conversations that were closed…). Images currently shown stay; old images that are opened again are read
 * from disk again. No UI data or state is changed.
 */
import Logger from '../Logger';
import { appLocale } from '../../shared/i18n';

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
const fmt = (mb: number) => mb.toLocaleString(appLocale());

/** A one-line summary: total private + each process group; GPU includes the part held in RAM. */
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
    } catch { /* a failed measurement does not affect the app */ }
}

/** main.ts (after app ready): writes RAM per process every 30 minutes. */
export function startMemoryMonitor(metrics: () => AppProcessMetric[]): void {
    if (started) return;
    started = true;
    metricsFn = metrics;
    logMemory('khi mở app');
    const timer = setInterval(() => logMemory('định kỳ'), MEMORY_LOG_INTERVAL_MS);
    (timer as any).unref?.();
}

/** The main window was just hidden / minimized: 2 minutes later, if it is still hidden, release the window's cache. */
export function noteWindowHidden(win: WindowLike): void {
    if (trimTimer) return;
    hiddenSince = Date.now();
    trimTimer = setTimeout(() => {
        trimTimer = null;
        try {
            if (win.isDestroyed() || (win.isVisible() && !win.isMinimized())) return;
            logMemory('cửa sổ ẩn 2 phút, nhả bộ đệm');
            win.webContents.send('app:trimMemory');
        } catch { /* the window was just closed */ }
    }, TRIM_AFTER_HIDDEN_MS);
    (trimTimer as any).unref?.();
}

/** The main window is shown again. */
export function noteWindowShown(): void {
    if (trimTimer) {
        clearTimeout(trimTimer);
        trimTimer = null;
    }
    if (hiddenSince && Date.now() - hiddenSince >= TRIM_AFTER_HIDDEN_MS) logMemory('cửa sổ hiện lại');
    hiddenSince = 0;
}
