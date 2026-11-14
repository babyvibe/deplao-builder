/**
 * Whether the machine is idle enough to run heavy work (copying + compressing the whole DB, scanning the whole media folder…). Like Windows maintenance,
 * OneDrive and Time Machine: it does not run right after the machine wakes up / is unlocked / the app opens (Windows is reloading memory from disk,
 * channels are catching up on sync). It waits until the user has not touched the machine for a while and the machine is plugged in; if it waits too long, it runs anyway.
 *
 * main.ts reports powerMonitor events through noteSystemPower(); other modules listen with onSystemPower(). Outside Electron (tests),
 * systemIdleInfo() = null → idleWaitReason() does not wait (runs as before).
 */

export type SystemPowerEvent = 'suspend' | 'resume' | 'unlock';

export interface SystemIdleInfo {
    /** Time since the user last touched the keyboard / mouse (ms; null = unknown). */
    idleMs: number | null;
    onBattery: boolean;
}

export type IdleWaitReason = 'wake' | 'battery' | 'active';

/** After the machine wakes up / is unlocked / the app opens: heavy work has not started yet. */
export const WAKE_QUIET_MS = 15 * 60_000;
/** The user must not touch the machine for this long before it counts as idle. */
export const IDLE_MIN_MS = 10 * 60_000;

export const IDLE_WAIT_LABEL: Record<IdleWaitReason, string> = {
    wake: 'máy vừa thức dậy / mở app',
    battery: 'đang chạy pin',
    active: 'đang có người dùng máy',
};

/**
 * A timer / tick that runs later than this = the process was just frozen (machine asleep / Modern Standby, app hung): treated as
 * the machine having just woken up (memory is being reloaded from disk, the network is not ready yet).
 */
export const TIME_JUMP_MS = 2 * 60_000;
const WAKE_WATCH_INTERVAL_MS = 30_000;

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
let lastWakeAt = 0;
const listeners = new Set<(ev: SystemPowerEvent, at: number) => void>();

/** powerMonitor (main.ts): the machine is about to sleep / just woke up / was just unlocked. */
export function noteSystemPower(ev: SystemPowerEvent, at = Date.now()): void {
    if (ev !== 'suspend') lastWakeAt = Math.max(lastWakeAt, at);
    for (const fn of [...listeners]) {
        try { fn(ev, at); } catch { /* one listener's error does not affect the others */ }
    }
}

export function onSystemPower(fn: (ev: SystemPowerEvent, at: number) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

let wakeWatch: ReturnType<typeof setInterval> | null = null;

/**
 * main.ts: a 30-second tick detects that the machine just woke up when powerMonitor does not report it (two ticks more than TIME_JUMP_MS apart)
 * → noteSystemPower('resume'). It only reports to heavy work that waits for an idle machine; it does not replace each channel's own resume handling.
 */
export function startWakeWatch(): void {
    if (wakeWatch) return;
    let last = Date.now();
    wakeWatch = setInterval(() => {
        const now = Date.now();
        if (now - last > TIME_JUMP_MS) noteSystemPower('resume', now);
        last = now;
    }, WAKE_WATCH_INTERVAL_MS);
    (wakeWatch as any)?.unref?.();
}

/** Time of the most recent wake / unlock (0 = none since the app opened). */
export function lastSystemWakeAt(): number {
    return lastWakeAt;
}

/** Time of the most recent app open / wake / unlock. */
export function lastWakeOrStartAt(): number {
    return Math.max(PROCESS_STARTED_AT, lastWakeAt);
}

/** Whether the user is using the machine / the machine is on battery. Outside Electron (tests) = null. */
export function systemIdleInfo(): SystemIdleInfo | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { powerMonitor } = require('electron');
        if (!powerMonitor || typeof powerMonitor.getSystemIdleTime !== 'function') return null;
        return { idleMs: powerMonitor.getSystemIdleTime() * 1000, onBattery: !!powerMonitor.isOnBatteryPower?.() };
    } catch {
        return null;
    }
}

/**
 * null = heavy work may run right away; otherwise = the reason it must wait. info null (unknown) = do not wait. Just woke up → waits
 * even if it has already waited longer than maxWaitMs (counted from dueSince; dueSince 0 = no limit).
 */
export function idleWaitReason(p: {
    now: number;
    /** Time of the most recent app open / wake / unlock. */
    wakeAt: number;
    /** When the heavy work became due (0 = no maximum wait is counted). */
    dueSince: number;
    maxWaitMs: number;
    info: SystemIdleInfo | null;
}): IdleWaitReason | null {
    if (!p.info) return null;
    if (p.now - p.wakeAt < WAKE_QUIET_MS) return 'wake';
    if (p.dueSince > 0 && p.now - p.dueSince >= p.maxWaitMs) return null;
    if (p.info.onBattery) return 'battery';
    if ((p.info.idleMs ?? 0) >= IDLE_MIN_MS) return null;
    return 'active';
}
