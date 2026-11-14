/**
 * When the DB base snapshot may be taken AUTOMATICALLY. A base snapshot = copy + filter + count + compress the whole DB: a 2.9 GB DB ≈ 9 GB of disk reads / writes. Measured 11/2026
 * on a real machine: 66 s when the machine is idle at night, but 17 minutes right after the machine is switched on in the morning (RAM full, Windows is reloading its memory
 * from disk, the channels are catching up on sync) → disk at 100%, the app freezes. At that point the base was already over 30 hours old, so the cycle was due right when the machine
 * woke up and took it straight away. Modern Standby also wakes the machine for a few seconds at night → a snapshot is cut midway, freezes until morning, then finishes
 * right when the user comes back.
 *
 * General rule "only when the machine is idle" (utils/startup/systemIdle.ts):
 *  - 15 minutes after the machine wakes up / is unlocked / the app opens: no snapshot;
 *  - the user has not touched the machine for ≥ 10 minutes, and it is plugged in;
 *  - if waiting takes too long, it still runs: a periodic base snapshot (while waiting, change segments still push onto the old base) after 72 hours; a required self-triggered base snapshot (schema change,
 *    reinstalled follow… while waiting, no segments can be pushed, the changes wait in the DB) after 6 hours.
 * A snapshot caused by the user's own action (turning sync on, "Đồng bộ ngay" (Sync now), changing scope / storage / password / folder) does not wait.
 */
import {
    IDLE_MIN_MS, IDLE_WAIT_LABEL, IdleWaitReason, SystemIdleInfo, WAKE_QUIET_MS, idleWaitReason,
} from '../../../utils/startup/systemIdle';

export type BaseWindowInfo = SystemIdleInfo;
export type BaseWaitReason = IdleWaitReason;

export const BASE_WAKE_QUIET_MS = WAKE_QUIET_MS;
export const BASE_IDLE_MS = IDLE_MIN_MS;
export const BASE_OPTIONAL_MAX_WAIT_MS = 72 * 3_600_000;
export const BASE_REQUIRED_MAX_WAIT_MS = 6 * 3_600_000;
/** Waiting for an idle machine to take the base snapshot: check again every 10 minutes (a cycle with no changes costs almost nothing). */
export const BASE_WAIT_RECHECK_MS = 10 * 60_000;

export const BASE_WAIT_LABEL = IDLE_WAIT_LABEL;

/** Periodic base snapshot: can wait, change segments are still applied onto the old base ('bulk': while waiting, push as segments instead of taking a base snapshot). */
export function isOptionalRebase(reason: string): boolean {
    return reason === 'age' || reason === 'age-night' || reason === 'segments-size' || reason === 'bulk';
}

/** Required base snapshot but self-triggered (not caused by the user's action: an update that changes the schema / scope policy…). */
const DEFERRABLE_REQUIRED = new Set(['schema', 'tracking', 'db-replaced', 'older-db', 'scope-policy']);

export function isDeferrableRebase(reason: string): boolean {
    return isOptionalRebase(reason) || DEFERRABLE_REQUIRED.has(reason);
}

/**
 * null = take it right away; otherwise = the reason it has to wait. window null (no Electron: tests, old build) or a reason caused by the user's
 * own action (the first base snapshot, changing the folder / password / scope) = as before, no waiting.
 */
export function baseWaitReason(p: {
    reason: string;
    /** When the base snapshot was first needed (0 = just done). */
    dueSince: number;
    now: number;
    /** Most recent wake-up / unlock / app-open time. */
    lastWakeAt: number;
    window: BaseWindowInfo | null;
}): BaseWaitReason | null {
    if (!isDeferrableRebase(p.reason)) return null;
    return idleWaitReason({
        now: p.now,
        wakeAt: p.lastWakeAt,
        dueSince: p.dueSince,
        maxWaitMs: isOptionalRebase(p.reason) ? BASE_OPTIONAL_MAX_WAIT_MS : BASE_REQUIRED_MAX_WAIT_MS,
        info: p.window,
    });
}
