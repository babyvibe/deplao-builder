/**
 * SyncEngine: syncs ONE local workspace to R2 (base snapshot + change segments + manifest + log).
 *
 *  - 'hourly'  : one cycle every hour (pushes all dirty rows as ≤ 5000 rows per segment).
 *  - 'realtime': the worker checks _cloud_dirty every 2 s; if there are changes → push after ~5 s. No changes → R2 is not called.
 *  - Take a new base snapshot when: there is no base yet, the DB was replaced (db_uid / path / AUTOINCREMENT went backwards), the schema changed, triggers are missing,
 *    the total segments > 25% of the base, the base is > 24 h old (window 02:00-04:00; older than 30 h → do it right away), a cycle has > 100k dirty rows,
 *    the backup password changed, or the sync scope changed (the manifest records a different scope than the current one).
 *    The new base is uploaded to R2 and the manifest points to it, and only then are the old base/segments cleaned up (R2 keeps ONE copy).
 *  - The scope (accounts + from date) of THIS workspace only (ctx.scope(id)): the base snapshot is filtered on the copy in the worker, and change
 *    segments do not send rows outside the scope. Each cycle uses ONE scope (read at the start) for the checks as well as the packing/snapshot.
 *  - Each workspace has one work queue (no overlaps); one base snapshot at a time for the whole machine (baseLock).
 *  - Errors: R2_BUSY / network → back off 30 s … 5 min; permission error → 'error' + 15 min; 2 consecutive errors → report to the UI.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CloudScope, DbSyncMode, DbSyncProgress, DbSyncWorkspaceStatus, SyncLogEntry } from '../../../shared/cloud/cloudContracts';
import { ALL_SCOPE, isAllScope, normalizeScope } from '../../../shared/cloud/cloudContracts';
import { CloudError } from '../contracts';
import { beginDbBaseUpload } from '../uploadCoordinator';
import type { CloudflareCore, R2Client } from '../contracts';
import { DbOps, asBuffer } from './DbOpsClient';
import type { DirtyStats, TrackingInfo } from './DirtyTracker';
import {
    DbManifest, REBASE_DIRTY_ROWS, appendSegment, baseKey, dbPrefix, followersPrefix, manifestKey, newManifest,
    parseManifest, rebaseReason, segmentKey, totalSegments,
} from './Manifest';
import { SEGMENT_MAX_BYTES, SEGMENT_ROW_LIMIT } from './Segment';
import {
    BASE_WAIT_LABEL, BASE_WAIT_RECHECK_MS, BaseWaitReason, BaseWindowInfo, baseWaitReason, isDeferrableRebase, isOptionalRebase,
} from './baseWindow';
import { TIME_JUMP_MS } from '../../../utils/startup/systemIdle';
import type { StateStore, WorkspaceSyncState } from './state';
import type { LogInput } from './syncLog';

export const START_DELAY_MS = 20_000;
/**
 * No automatic cycle runs during the first few minutes after the app OPENS: the UI is still being built and the channels are catching up on sync,
 * and a cycle may have to reinstall the triggers + take the base snapshot (a real 2.7 GB DB: ~1.5 min of CPU / disk time, measured 10/2026).
 * "Đồng bộ ngay" (Sync now) and the user's request for a base snapshot (requestBase) do not have to wait.
 */
export const STARTUP_QUIET_MS = 5 * 60_000;
/** Tick that checks whether the machine sleeps while the base snapshot is being taken. */
const BASE_HEARTBEAT_MS = 10_000;
export const RECHECK_DELAY_MS = 3_000;
export const REALTIME_DELAY_MS = 5_000;
export const HOUR_MS = 3_600_000;
export const WATCH_INTERVAL_MS = 2_000;
export const MAINTENANCE_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const AUTH_RETRY_MS = 15 * 60_000;
const LOG_CACHE = 500;

/** Step weights used when computing the % of the whole base snapshot (the upload is usually the longest). */
const PHASE_WEIGHTS: Record<DbSyncProgress['phase'], number> = { copy: 0.2, filter: 0.05, compress: 0.2, encrypt: 0.05, upload: 0.5 };
const PHASE_ORDER: Array<DbSyncProgress['phase']> = ['copy', 'filter', 'compress', 'encrypt', 'upload'];

function overallPercent(phase: DbSyncProgress['phase'], done: number, total: number): number {
    let before = 0;
    for (const p of PHASE_ORDER) {
        if (p === phase) break;
        before += PHASE_WEIGHTS[p];
    }
    const frac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
    return Math.max(0, Math.min(99, Math.round((before + PHASE_WEIGHTS[phase] * frac) * 100)));
}

async function fileSize(p: string): Promise<number> {
    try { return (await fs.promises.stat(p)).size; } catch { return 0; }
}

function mb(bytes: number): string {
    return (bytes / 1048576).toFixed(1);
}

export class Mutex {
    private tail: Promise<unknown> = Promise.resolve();
    run<T>(fn: () => Promise<T>): Promise<T> {
        const p = this.tail.then(fn, fn);
        this.tail = p.then(() => undefined, () => undefined);
        return p;
    }
}

export interface EngineWorkspace {
    id: string;
    name: string;
    dbPath: string;
}

export interface EngineContext {
    core: CloudflareCore;
    ops: DbOps;
    state: StateStore;
    mode(): DbSyncMode;
    /** Sync scope (accounts + from date) of this workspace: saved per workspace; missing = all. */
    scope?(workspaceId: string): CloudScope;
    /** Ensure the machine's bucket exists (created once) → the bucket name. */
    ensureBucket(): Promise<string>;
    appVersion(): string;
    log(level: 'log' | 'warn' | 'error', msg: string): void;
    notify(urgent?: boolean): void;
    baseLock: Mutex;
    now(): number;
    /** When the app process started (ms). If set → automatic cycles do not run before this time + STARTUP_QUIET_MS. */
    appStartedAt?(): number;
    /** When the machine last woke up / was unlocked (powerMonitor; 0 = never). Automatic cycles wait the same way as after opening the app. */
    lastWakeAt?(): number;
    /** Whether the machine is idle enough to take a base snapshot by itself (baseWindow.ts). Missing / null = unknown → take it right away, as before. */
    baseWindow?(): BaseWindowInfo | null;
    /** Only one engine may use a workspaceUid (a DB copied between two workspaces must not overwrite each other's copies). */
    claimUid(uid: string, engineId: string): string | null;
    onBaseDone(engine: SyncEngine, manifest: DbManifest, bucket: string): void;
}

class AbortJob extends Error {
    code = 'DBSYNC_ABORTED';
}

// STORAGE_FULL (Google Drive out of space): the user must clean up / upgrade the plan → back off like a permission error, do not retry in a burst
const AUTH_CODES = new Set(['R2_FORBIDDEN', 'TOKEN_INACTIVE', 'INVALID_TOKEN', 'BAD_TOKEN', 'NOT_CONNECTED', 'R2_NOT_ENABLED', 'STORAGE_FULL']);

export function isAuthError(err: any): boolean {
    return AUTH_CODES.has(String(err?.code || '')) || err?.status === 401 || err?.status === 403;
}

/** Vietnamese error message for the user. */
export function userMessage(err: any): string {
    const code = String(err?.code || '');
    switch (code) {
        case 'R2_FORBIDDEN':
        case 'TOKEN_INACTIVE':
        case 'INVALID_TOKEN':
        case 'BAD_TOKEN':
            // Google Drive errors already have their own messages; the rest are Cloudflare token errors
            if (err instanceof CloudError && /Google/i.test(err.message)) return err.message;
            return 'Cloudflare từ chối truy cập R2 (token hết hạn hoặc thiếu quyền R2) — kiểm tra lại kết nối Cloudflare.';
        case 'NOT_CONNECTED':
            return err instanceof CloudError && err.message ? err.message : 'Chưa kết nối kho lưu.';
        case 'NO_PASSPHRASE':
            return 'Chưa đặt mật khẩu sao lưu.';
        case 'DBSYNC_WORKER':
            return 'Không chạy được tiến trình nền đồng bộ DB — hãy khởi động lại ứng dụng.';
        default:
            break;
    }
    const msg = String(err?.message || err || 'Lỗi không rõ');
    if (err instanceof CloudError) return msg;
    if (/SQLITE_BUSY|database is locked/i.test(msg)) return 'DB đang bận — sẽ thử lại sau.';
    if (/ENOSPC/i.test(msg)) return 'Ổ đĩa đầy — không tạo được bản sao tạm để đồng bộ.';
    if (/SQLITE_CORRUPT|malformed/i.test(msg)) return 'File DB có dấu hiệu hỏng — không đồng bộ được. Hãy kiểm tra DB.';
    return `Lỗi đồng bộ DB: ${msg}`;
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const x = path.resolve(a);
    const y = path.resolve(b);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Short description of the scope for the log (does not print account ids). */
export function describeScope(scope: CloudScope | null | undefined): string {
    const s = normalizeScope(scope);
    if (isAllScope(s)) return 'tất cả';
    const parts: string[] = [s.accounts === 'all' ? 'mọi tài khoản' : `${s.accounts.length} tài khoản`];
    if (s.fromTs !== null) {
        // fromTs = 00:00 machine time on the chosen day → printed in machine date/time (UTC would shift it to the day before at UTC+7).
        const d = new Date(s.fromTs);
        const pad = (n: number) => String(n).padStart(2, '0');
        parts.push(`từ ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    return parts.join(', ');
}

/** Scope sent to the worker: null = everything (the worker filters nothing). */
function scopeArg(scope: CloudScope): CloudScope | null {
    return isAllScope(scope) ? null : scope;
}

function startOfLocalHour(ts: number): number {
    const d = new Date(ts);
    d.setMinutes(0, 0, 0);
    return d.getTime();
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
    const fh = await fs.promises.open(file, 'r');
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

async function removeQuietly(...files: string[]): Promise<void> {
    for (const f of files) {
        if (!f) continue;
        try { await fs.promises.rm(f, { force: true }); } catch { /* ignore */ }
    }
}

/** Run fn for each item, at most `limit` jobs in parallel. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

export class SyncEngine {
    readonly id: string;
    name: string;
    dbPath: string;

    private readonly st: WorkspaceSyncState;
    private chain: Promise<void> = Promise.resolve();
    private queued: Promise<void> | null = null;
    private running = false;
    private runtime: 'idle' | 'syncing' | 'snapshotting' = 'idle';
    private paused = false;
    private stopped = true;
    private failures = 0;
    private authFailed = false;
    private backoffUntil = 0;
    private forceBaseReason: string | null = null;
    private chainPassphrase: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private timerAt = 0;
    private maintTimer: ReturnType<typeof setInterval> | null = null;
    private watching = false;
    private pendingDirty = false;
    private logCache: SyncLogEntry[] = [];
    private logLoaded = false;
    private hourRow: { id: number; hourStart: number; entry: LogInput } | null = null;
    private failRow: { id: number; entry: LogInput } | null = null;
    private warnedUnsupported = false;
    private sweeping = false;
    /** Progress of the base snapshot currently running (null = not running). */
    private progress: DbSyncProgress | null = null;
    private uploadSample: { at: number; sent: number } | null = null;
    private uploadLoggedQuarter = 0;
    /** The engine notices the process was just frozen (a timer that ran late) → treats it as the machine having just woken up now. */
    private detectedWakeAt = 0;
    private maintLastAt = 0;
    /** Why a self-triggered base snapshot is waiting for the machine to be idle (baseWindow.ts; null = not waiting), plus the reason already logged. */
    private baseWaiting: BaseWaitReason | null = null;
    private baseWaitLogged: string | null = null;
    /** The base snapshot currently running: a self-triggered one can be stopped when the machine sleeps; stamp = temp file name (tells the worker to stop). */
    private baseRun: { automatic: boolean; stamp: number; slept: boolean } | null = null;

    constructor(ws: EngineWorkspace, private readonly ctx: EngineContext) {
        this.id = ws.id;
        this.name = ws.name;
        this.dbPath = ws.dbPath;
        this.st = ctx.state.workspace(ws.id);
    }

    get workspaceUid(): string | null {
        return this.st.workspaceUid;
    }

    get manifest(): DbManifest | null {
        return this.st.manifest;
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    start(): void {
        this.stopped = false;
        void this.loadLogCache();
        // Clean up the temp files of an unfinished base snapshot (the app quit midway): queue it so it does not race with the first cycle.
        this.chain = this.chain.then(() => this.cleanupTmp()).catch(() => undefined);
        this.applyMode(START_DELAY_MS);
    }

    /** Change mode (hourly ↔ realtime) or restart the schedule. */
    applyMode(firstDelayMs = RECHECK_DELAY_MS): void {
        this.clearTimers();
        const mode = this.ctx.mode();
        if (this.stopped || mode === 'off') {
            void this.unwatch();
            return;
        }
        if (this.paused) return;
        const now = this.ctx.now();
        if (mode === 'realtime') {
            void this.watch();
            this.maintLastAt = now;
            this.maintTimer = setInterval(() => this.onMaintenanceTick(), MAINTENANCE_MS);
            (this.maintTimer as any)?.unref?.();
            this.scheduleAt(now + firstDelayMs);
        } else {
            void this.unwatch();
            const last = this.st.lastSyncAt || 0;
            const due = this.st.manifest?.base ? Math.max(now + firstDelayMs, last + HOUR_MS) : now + firstDelayMs;
            this.scheduleAt(due);
        }
    }

    pause(): void {
        this.paused = true;
        this.clearTimers();
        void this.unwatch();
    }

    resume(): void {
        if (!this.paused) return;
        this.paused = false;
        this.applyMode(RECHECK_DELAY_MS);
        if (this.pendingDirty) {
            this.pendingDirty = false;
            this.scheduleAt(this.ctx.now() + REALTIME_DELAY_MS);
        }
    }

    /** Stop completely (sync turned off / workspace deleted / app quit). Waits for the running job for at most timeoutMs. */
    async stop(timeoutMs = 30_000): Promise<void> {
        this.stopped = true;
        this.pause();
        await this.idle(timeoutMs);
    }

    /** Wait for the job queue to empty (at most timeoutMs). true = it is empty. */
    async idle(timeoutMs = 30_000): Promise<boolean> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(false), timeoutMs);
            (timer as any)?.unref?.();
        });
        const done = this.chain.then(() => true, () => true);
        const res = await Promise.race([done, timeout]);
        if (timer) clearTimeout(timer);
        return res;
    }

    isBusy(): boolean {
        return this.running;
    }

    /**
     * After replacing the DB file (pauseFor): check db_uid / the path again early.
     * resetBackoff: just reconnected to Cloudflare → drop the back-off time caused by permission/network errors.
     */
    recheck(resetBackoff = false): void {
        if (this.stopped || this.paused || this.ctx.mode() === 'off') return;
        if (resetBackoff) {
            this.backoffUntil = 0;
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
                this.timerAt = 0;
            }
        }
        this.scheduleAt(this.ctx.now() + RECHECK_DELAY_MS);
    }

    updateWorkspace(ws: EngineWorkspace): void {
        this.name = ws.name;
    }

    requestBase(reason: string): void {
        this.forceBaseReason = reason;
        this.chainPassphrase = null;
        if (!this.stopped && !this.paused && this.ctx.mode() !== 'off') this.scheduleAt(this.ctx.now() + RECHECK_DELAY_MS);
    }

    /** The "Đồng bộ ngay" (Sync now) button: ignores the back-off time and throws errors to the caller. */
    syncNow(): Promise<void> {
        this.backoffUntil = 0;
        return this.enqueue('manual', true);
    }

    /** Event from the worker: _cloud_dirty has rows (realtime mode). */
    onDirty(): void {
        if (this.stopped) return;
        if (this.paused) {
            this.pendingDirty = true;
            return;
        }
        if (this.ctx.mode() !== 'realtime') return;
        this.scheduleAt(this.ctx.now() + REALTIME_DELAY_MS);
    }

    /**
     * The machine is about to sleep / has just woken up / has just been unlocked (powerMonitor via index.ts, or the engine notices a timer ran late).
     * If a self-triggered base snapshot is running when the machine sleeps → stop at the next step (the worker stops compressing), instead of
     * finishing right when the user comes back; take it again when the machine is idle. Unlocking does not stop it (the machine is still awake), it only postpones the next snapshot.
     */
    onPowerEvent(ev: 'suspend' | 'resume' | 'unlock', at = this.ctx.now()): void {
        if (ev !== 'suspend') this.detectedWakeAt = Math.max(this.detectedWakeAt, at);
        const run = this.baseRun;
        if (ev === 'unlock' || !run || !run.automatic || run.slept) return;
        run.slept = true;
        this.baseWaiting = 'wake';
        this.ctx.log('log', `[CloudDb] ${this.id}: máy ${ev === 'suspend' ? 'sắp ngủ' : 'vừa ngủ dậy'} giữa lúc chụp bản gốc → dừng, chụp lại khi máy rảnh`);
        void this.ctx.ops.call('cancelSnapshot', { dbPath: this.dbPath, stamp: run.stamp }).catch(() => undefined);
    }

    // ─── Status / log ─────────────────────────────────────────────────────

    view(): DbSyncWorkspaceStatus {
        const m = this.st.manifest;
        let state: DbSyncWorkspaceStatus['state'] = 'idle';
        if (this.paused && !this.running) state = 'paused';
        else if (this.running) state = this.runtime === 'snapshotting' ? 'snapshotting' : 'syncing';
        else if (this.authFailed || this.failures >= 2) state = 'error';
        return {
            workspaceId: this.id,
            name: this.name,
            lastSyncAt: this.st.lastSyncAt,
            lastChanges: this.st.lastChanges,
            baseAt: m?.base?.at ?? null,
            segments: totalSegments(m),
            bytes: m ? (m.base?.bytes || 0) + (m.segmentsBytes || 0) : 0,
            state,
            lastError: this.st.lastError,
            scope: this.currentScope(),
            progress: this.progress ? { ...this.progress, retry: this.progress.retry ? { ...this.progress.retry } : null } : null,
            baseWaiting: this.baseWaiting,
        };
    }

    // ─── Base snapshot progress ─────────────────────────────────────────────────

    private setProgress(phase: DbSyncProgress['phase'], done: number, total: number): void {
        const now = this.ctx.now();
        const prev = this.progress;
        if (!prev) return;
        const phaseChanged = prev.phase !== phase;
        this.progress = {
            ...prev,
            phase,
            done: Math.max(0, done),
            total: Math.max(0, total),
            percent: overallPercent(phase, done, total),
            phaseStartedAt: phaseChanged ? now : prev.phaseStartedAt,
            rate: phase === 'upload' ? prev.rate ?? null : null,
            retry: phase === 'upload' ? prev.retry ?? null : null,
        };
        this.ctx.notify();
    }

    /** Events from the worker during the base snapshot (scope filtering, compression). */
    onSnapshotProgress(phase: 'filter' | 'compress', done: number, total: number): void {
        if (!this.progress) return;
        this.setProgress(phase, Number(done) || 0, Number(total) || 0);
    }

    private onUploadProgress(sent: number, total: number): void {
        if (!this.progress) return;
        const now = this.ctx.now();
        const sample = this.uploadSample;
        if (!sample) {
            this.uploadSample = { at: now, sent };
        } else if (now - sample.at >= 2000) {
            const inst = ((sent - sample.sent) * 1000) / (now - sample.at);
            const prevRate = this.progress.rate;
            const rate = prevRate ? prevRate * 0.6 + inst * 0.4 : inst;
            this.uploadSample = { at: now, sent };
            this.progress = { ...this.progress, rate: Math.max(0, rate) };
        }
        // Can keep running → remove the "đang thử lại" (retrying) line after 30 s.
        if (this.progress.retry && now - this.progress.retry.at > 30_000) this.progress = { ...this.progress, retry: null };
        this.setProgress('upload', sent, total);
        const quarter = total > 0 ? Math.floor((sent / total) * 4) : 0;
        if (quarter > this.uploadLoggedQuarter && quarter < 4) {
            this.uploadLoggedQuarter = quarter;
            this.ctx.log('log', `[CloudDb] ${this.id}: đang tải bản gốc lên R2 ${quarter * 25}% (${mb(sent)} / ${mb(total)} MB)`);
        }
    }

    private onUploadRetry(info: { part: number | null; attempt: number; maxAttempts: number; error: string }): void {
        this.ctx.log('warn', `[CloudDb] ${this.id}: tải bản gốc lên R2 — phần ${info.part ?? '?'} lỗi (${info.error}), thử lại lần ${info.attempt}/${info.maxAttempts}`);
        if (!this.progress) return;
        this.progress = { ...this.progress, retry: { ...info, at: this.ctx.now() } };
        this.ctx.notify();
    }

    logs(): SyncLogEntry[] {
        return this.logCache.slice();
    }

    async reloadLogs(): Promise<void> {
        this.logLoaded = false;
        this.hourRow = null;
        this.failRow = null;
        await this.loadLogCache();
    }

    private async loadLogCache(): Promise<void> {
        if (this.logLoaded) return;
        try {
            const list = await this.ctx.ops.call<SyncLogEntry[]>('readLog', { dbPath: this.dbPath, limit: LOG_CACHE });
            const known = new Set(this.logCache.map(e => e.id));
            this.logCache = [...this.logCache, ...(list || []).filter(e => !known.has(e.id))].sort((a, b) => b.id - a.id).slice(0, LOG_CACHE);
            this.logLoaded = true;
        } catch { /* next time */ }
    }

    private cacheLog(e: SyncLogEntry): void {
        const idx = this.logCache.findIndex(x => x.id === e.id);
        if (idx >= 0) this.logCache[idx] = e;
        else this.logCache.unshift(e);
        if (this.logCache.length > LOG_CACHE) this.logCache.length = LOG_CACHE;
    }

    private async writeLog(entry: LogInput, updateId?: number | null): Promise<number | null> {
        try {
            if (updateId) {
                await this.ctx.ops.call('updateLog', { dbPath: this.dbPath, id: updateId, entry });
                this.cacheLog({ id: updateId, ...entry });
                return updateId;
            }
            const id = await this.ctx.ops.call<number>('appendLog', { dbPath: this.dbPath, entry });
            this.cacheLog({ id, ...entry });
            return id;
        } catch (err: any) {
            this.ctx.log('warn', `[CloudDb] ${this.id}: không ghi được nhật ký đồng bộ: ${err?.message || err}`);
            return null;
        }
    }

    private async logCycle(kind: 'base' | 'segment', at: number, pushes: number, rows: number, bytes: number, result: 'ok' | 'retried' | 'error', error: string | null): Promise<void> {
        const now = this.ctx.now();
        const durationMs = Math.max(0, now - at);
        if (kind === 'base') {
            await this.writeLog({ workspaceId: this.id, at, endAt: now, kind: 'base', pushes, rows, bytes, durationMs, result, error });
            return;
        }
        if (this.ctx.mode() === 'realtime') {
            const hourStart = startOfLocalHour(now);
            if (this.hourRow && this.hourRow.hourStart === hourStart) {
                const e = this.hourRow.entry;
                e.endAt = now;
                e.pushes += pushes;
                e.rows += rows;
                e.bytes += bytes;
                e.durationMs += durationMs;
                if (result === 'error') {
                    e.result = 'error';
                    e.error = error;
                } else if (e.result === 'error' || e.result === 'retried' || result === 'retried') {
                    e.result = 'retried';
                }
                await this.writeLog({ ...e }, this.hourRow.id);
            } else {
                const entry: LogInput = { workspaceId: this.id, at, endAt: now, kind: 'segments-hour', pushes, rows, bytes, durationMs, result, error };
                const id = await this.writeLog(entry);
                this.hourRow = id ? { id, hourStart, entry: { ...entry } } : null;
            }
            return;
        }
        if (result === 'error') {
            // A run of consecutive errors = one row (updates the end time + the latest error), so the log does not fill up.
            if (this.failRow) {
                const e = { ...this.failRow.entry, endAt: now, pushes: this.failRow.entry.pushes + pushes, error };
                this.failRow.entry = e;
                await this.writeLog(e, this.failRow.id);
            } else {
                const entry: LogInput = { workspaceId: this.id, at, endAt: now, kind: 'segment', pushes, rows, bytes, durationMs, result, error };
                const id = await this.writeLog(entry);
                this.failRow = id ? { id, entry } : null;
            }
            return;
        }
        this.failRow = null;
        if (rows > 0 || result === 'retried') {
            await this.writeLog({ workspaceId: this.id, at, endAt: now, kind: 'segment', pushes, rows, bytes, durationMs, result, error: null });
        }
    }

    // ─── Schedule ────────────────────────────────────────────────────────────

    private clearTimers(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            this.timerAt = 0;
        }
        if (this.maintTimer) {
            clearInterval(this.maintTimer);
            this.maintTimer = null;
        }
    }

    /** Most recent app open / machine wake-up / unlock (0 = unknown). */
    private wakeAt(): number {
        return Math.max(this.ctx.appStartedAt?.() || 0, this.ctx.lastWakeAt?.() || 0, this.detectedWakeAt);
    }

    private scheduleAt(ts: number): void {
        if (this.stopped || this.paused || this.ctx.mode() === 'off') return;
        // Automatic cycles (timer, Realtime) wait for STARTUP_QUIET_MS to pass after the app opens / the machine wakes up / is unlocked; a base snapshot requested by
        // the user does not wait.
        const wake = this.forceBaseReason ? 0 : this.wakeAt();
        const quietUntil = wake ? wake + STARTUP_QUIET_MS : 0;
        const at = Math.max(ts, this.backoffUntil, quietUntil);
        if (this.timer && this.timerAt <= at) return; // a schedule earlier than this already exists
        if (this.timer) clearTimeout(this.timer);
        this.timerAt = at;
        this.timer = setTimeout(() => {
            const now = this.ctx.now();
            const late = now - this.timerAt;
            this.timer = null;
            this.timerAt = 0;
            // Due while the machine was asleep → run right when it wakes up: treat it as the machine having just woken up now.
            if (late > TIME_JUMP_MS && !this.forceBaseReason) this.onPowerEvent('resume', now);
            // Scheduled before the machine woke up / was unlocked: not run yet, postponed until the quiet period is over.
            const wake = this.forceBaseReason ? 0 : this.wakeAt();
            if (wake && now < wake + STARTUP_QUIET_MS) {
                this.scheduleAt(now);
                return;
            }
            void this.enqueue('timer');
        }, Math.max(0, at - this.ctx.now()));
        (this.timer as any)?.unref?.();
    }

    /** Realtime: a 15-minute maintenance cycle (catches missed changes, periodic base snapshots); right after waking up it waits like a timer. */
    private onMaintenanceTick(): void {
        const now = this.ctx.now();
        if (this.maintLastAt && now - this.maintLastAt > MAINTENANCE_MS + TIME_JUMP_MS) this.onPowerEvent('resume', now);
        this.maintLastAt = now;
        const wake = this.wakeAt();
        if (wake && now < wake + STARTUP_QUIET_MS) {
            this.scheduleAt(now); // postponed until the quiet period is over
            return;
        }
        void this.enqueue('maintenance');
    }

    private async watch(): Promise<void> {
        try {
            await this.ctx.ops.call('watch', { dbPath: this.dbPath, intervalMs: WATCH_INTERVAL_MS });
            this.watching = true;
        } catch (err: any) {
            this.ctx.log('warn', `[CloudDb] ${this.id}: không theo dõi được thay đổi: ${err?.message || err}`);
        }
    }

    private async unwatch(): Promise<void> {
        if (!this.watching) return;
        this.watching = false;
        try { await this.ctx.ops.call('unwatch', { dbPath: this.dbPath }); } catch { /* worker already stopped */ }
    }

    private async rearm(): Promise<void> {
        if (!this.watching) return;
        try {
            const ok = await this.ctx.ops.call<boolean>('rearm', { dbPath: this.dbPath });
            if (!ok) {
                // The worker was just recreated (died / was stopped) → the watch loop is lost → set it up again.
                this.watching = false;
                await this.watch();
            }
        } catch { /* worker already stopped, next time */ }
    }

    // ─── Sync cycle ───────────────────────────────────────────────────────

    private enqueue(reason: string, throwErrors = false): Promise<void> {
        // A cycle is already waiting (not run yet) → share it, do not queue another.
        if (!throwErrors && this.queued) return this.queued;
        let entry: Promise<void> | null = null;
        const run = async () => {
            if (entry && this.queued === entry) this.queued = null;
            if (this.stopped || this.paused || this.ctx.mode() === 'off') {
                if (throwErrors) throw new CloudError('DBSYNC_PAUSED', 'Đồng bộ DB đang tạm dừng hoặc đã tắt.');
                return;
            }
            await this.runCycle(reason, throwErrors);
        };
        const p: Promise<void> = this.chain.then(run, run);
        this.chain = p.catch(() => undefined);
        if (throwErrors) return p;
        entry = p.catch(() => undefined);
        this.queued = entry;
        return entry;
    }

    private checkRunnable(): void {
        if (this.stopped || this.paused) throw new AbortJob('Đồng bộ tạm dừng');
    }

    private r2For(bucket: string): R2Client {
        return this.ctx.core.r2(bucket);
    }

    private passphrase(): string {
        let p: string | null = null;
        try { p = this.ctx.core.settings.getPassphrase(); } catch { p = null; }
        if (!p) throw new CloudError('NO_PASSPHRASE', 'Chưa đặt mật khẩu sao lưu.');
        return p;
    }

    /** The scope configured for this workspace (not the scope of the base snapshot on R2). */
    currentScope(): CloudScope {
        try {
            return normalizeScope(this.ctx.scope ? this.ctx.scope(this.id) : ALL_SCOPE);
        } catch {
            return ALL_SCOPE;
        }
    }

    private async chainPassOk(m: DbManifest, passphrase: string): Promise<boolean> {
        if (this.chainPassphrase !== null) return this.chainPassphrase === passphrase;
        if (!m.passCheck) {
            this.chainPassphrase = passphrase;
            return true;
        }
        let ok = false;
        try {
            ok = await this.ctx.core.crypto.verifyPassphrase(Buffer.from(m.passCheck, 'base64'), passphrase);
        } catch {
            ok = false;
        }
        if (ok) this.chainPassphrase = passphrase;
        return ok;
    }

    private async runCycle(reason: string, throwErrors: boolean): Promise<void> {
        const startedAt = this.ctx.now();
        this.running = true;
        this.runtime = 'syncing';
        this.ctx.notify();
        let pushes = 0;
        let rows = 0;
        let bytes = 0;
        let baseDone = false;
        let kind: 'base' | 'segment' = 'segment';
        try {
            const bucket = await this.ctx.ensureBucket();
            const r2 = this.r2For(bucket);
            // Storage switch (R2 ↔ Google Drive): the manifest in memory belongs to the old storage → read it again on the new storage (none yet → take a new base snapshot)
            const provider = this.ctx.core.storageProvider();
            if ((this.st.provider || 'r2') !== provider) {
                this.st.provider = provider;
                this.st.manifest = null;
                this.ctx.state.save();
            }
            const passphrase = this.passphrase();
            // One scope for the whole cycle: if the scope changes midway, the next cycle sees a manifest with a different scope → take a new base snapshot.
            const scope = this.currentScope();
            this.checkRunnable();
            const t = await this.ctx.ops.call<TrackingInfo>('ensureTracking', { dbPath: this.dbPath });
            if (!this.st.trackingInstalled) {
                this.st.trackingInstalled = true;
                this.ctx.state.save();
            }
            if (!t.workspaceUid) throw new CloudError('DBSYNC_NO_SETTINGS', 'DB của workspace thiếu bảng app_settings — không đồng bộ được.');
            if (t.unsupported.length && !this.warnedUnsupported) {
                this.warnedUnsupported = true;
                this.ctx.log('warn', `[CloudDb] ${this.id}: bảng không theo dõi được (WITHOUT ROWID): ${t.unsupported.join(', ')}`);
            }
            const owner = this.ctx.claimUid(t.workspaceUid, this.id);
            if (owner && owner !== this.id) {
                throw new CloudError('DBSYNC_DUP_UID', 'DB của workspace này trùng mã với một workspace khác (file DB sao chép) — tạm không đồng bộ để không ghi đè bản sao của nhau.');
            }
            if (this.st.workspaceUid !== t.workspaceUid) {
                this.st.workspaceUid = t.workspaceUid;
                this.st.manifest = null;
            }
            const uid = t.workspaceUid;
            let manifest = this.st.manifest && this.st.manifest.workspaceUid === uid ? this.st.manifest : null;
            if (!manifest) {
                manifest = parseManifest(await r2.getObject(manifestKey(uid)));
                if (manifest) {
                    this.st.manifest = manifest;
                    this.ctx.state.save();
                }
            }
            const lastPushedId = Math.max(this.st.lastAckedId || 0, manifest?.segments.length ? manifest.segments[manifest.segments.length - 1].toId : 0, manifest?.base?.highWater || 0);
            let rebase: string | null = this.forceBaseReason
                // A required base snapshot was postponed waiting for an idle machine: a sign such as "triggers just reinstalled" only exists in the cycle that detects it → remember it in the state
                || this.st.pendingBase
                || (t.reinstalled ? 'tracking' : null)
                || (this.st.dbPath && !samePath(this.st.dbPath, this.dbPath) ? 'db-path' : null)
                || (t.dirtySeq < lastPushedId ? 'older-db' : null)
                // Includes the scope: the manifest records a different scope (or none while the current scope is limited) → new base snapshot.
                || rebaseReason(manifest, { now: this.ctx.now(), fingerprint: t.fingerprint, dbUid: t.dbUid, scope });
            if (!rebase && manifest && !(await this.chainPassOk(manifest, passphrase))) rebase = 'passphrase';

            // Self-triggered base snapshots (age, large segments, schema change…) wait for an idle machine (baseWindow.ts); a periodic base snapshot still pushes
            // change segments onto the old base while waiting. A user request ("Đồng bộ ngay" (Sync now), changing the scope / storage / password) does not wait.
            // t.created: sync was just turned on for this DB → the first base snapshot runs right away.
            const automatic = reason !== 'manual' && !this.forceBaseReason && !t.created;
            this.baseWaiting = null;
            const waitBase = (why: string) => automatic && this.mustWaitForBase(why);
            if (rebase && isOptionalRebase(rebase) && waitBase(rebase)) rebase = null;
            if (!rebase) {
                const stats = await this.ctx.ops.call<DirtyStats>('dirtyStats', { dbPath: this.dbPath });
                if (stats.count > REBASE_DIRTY_ROWS && !waitBase('bulk')) {
                    rebase = 'bulk';
                } else if (stats.count > 0) {
                    const res = await this.pushSegments(r2, manifest as DbManifest, passphrase, stats.count, scope);
                    pushes += res.pushes;
                    rows += res.rows;
                    bytes += res.bytes;
                    rebase = res.rebase;
                }
            }
            // A required self-triggered base snapshot (schema change…) also waits, for at most 6 hours: while waiting, the changes stay in the DB and cannot be pushed yet.
            if (rebase && !isOptionalRebase(rebase) && waitBase(rebase)) {
                if (this.st.pendingBase !== rebase) {
                    this.st.pendingBase = rebase;
                    this.ctx.state.save();
                }
                rebase = null;
            }
            if (!rebase && !this.baseWaiting) this.clearBaseWait();
            if (rebase) {
                this.checkRunnable();
                kind = 'base';
                this.ctx.log('log', `[CloudDb] ${this.id}: chụp bản gốc mới (${rebase}, phạm vi: ${describeScope(scope)})`);
                const b = await this.makeBase(r2, bucket, passphrase, t, rebase, scope, automatic);
                pushes += 1;
                rows += b.rows;
                bytes += b.bytes;
                baseDone = true;
                this.clearBaseWait();
            }

            // Success
            const hadFailures = this.failures > 0;
            this.failures = 0;
            this.authFailed = false;
            this.backoffUntil = 0;
            this.st.lastError = null;
            this.st.lastSyncAt = this.ctx.now();
            if (pushes > 0) this.st.lastChanges = rows;
            this.st.dbPath = this.dbPath;
            this.st.dbUid = t.dbUid;
            this.st.fingerprint = this.st.manifest?.schemaFingerprint || t.fingerprint;
            this.ctx.state.save();
            if (pushes > 0 || hadFailures) {
                await this.logCycle(kind, startedAt, pushes, rows, bytes, hadFailures ? 'retried' : 'ok', null);
            }
            this.ctx.notify(hadFailures || baseDone);
        } catch (err: any) {
            if (err instanceof AbortJob || ((this.paused || this.stopped) && !throwErrors)) {
                // Paused midway (switching workspace / deleting / restoring): not counted as an error, runs again when it resumes.
                this.pendingDirty = true;
                return;
            }
            this.onFailure(err, startedAt, kind);
            if (throwErrors) throw err instanceof CloudError ? err : new CloudError(String(err?.code || 'DBSYNC_ERROR'), userMessage(err));
        } finally {
            this.running = false;
            this.runtime = 'idle';
            this.reschedule();
        }
    }

    private onFailure(err: any, startedAt: number, kind: 'base' | 'segment'): void {
        const now = this.ctx.now();
        const message = userMessage(err);
        this.failures++;
        const auth = isAuthError(err);
        let delay: number;
        if (auth) delay = AUTH_RETRY_MS;
        else if (err?.code === 'NO_PASSPHRASE') delay = 10 * 60_000;
        else delay = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(4, this.failures - 1));
        const retryAfter = Number(err?.retryAfterMs) || 0;
        if (retryAfter > delay) delay = Math.min(MAX_BACKOFF_MS, retryAfter);
        this.backoffUntil = now + delay;
        this.authFailed = auth;
        this.st.lastError = message;
        this.ctx.state.save();
        this.ctx.log('warn', `[CloudDb] ${this.id}: đồng bộ lỗi (${this.failures} lần liên tiếp, thử lại sau ${Math.round(delay / 1000)} s): ${err?.message || err}`);
        void this.logCycle(kind, startedAt, 0, 0, 0, 'error', message);
        // Two consecutive errors (or a permission error) → the UI shows a warning.
        if (auth || this.failures === 2) this.ctx.notify(true);
        else this.ctx.notify();
    }

    /**
     * Does a self-triggered base snapshot have to wait for an idle machine (baseWindow.ts)? Recorded when a snapshot is first needed (into the state: the maximum wait
     * counted across app openings) + one log line each time the reason changes. true = not taken in this run.
     */
    private mustWaitForBase(rebase: string): boolean {
        if (!isDeferrableRebase(rebase)) return false;
        const now = this.ctx.now();
        if (!this.st.baseDueSince) {
            this.st.baseDueSince = now;
            this.ctx.state.save();
        }
        let window: BaseWindowInfo | null = null;
        try { window = this.ctx.baseWindow?.() ?? null; } catch { window = null; }
        const wait = baseWaitReason({ reason: rebase, dueSince: this.st.baseDueSince, now, lastWakeAt: this.wakeAt(), window });
        if (!wait) return false;
        const key = `${rebase}:${wait}`;
        if (key !== this.baseWaitLogged) {
            this.baseWaitLogged = key;
            this.ctx.log('log', `[CloudDb] ${this.id}: chờ máy rảnh mới chụp bản gốc (${rebase}; ${BASE_WAIT_LABEL[wait]})`);
        }
        this.baseWaiting = wait;
        return true;
    }

    private clearBaseWait(): void {
        this.baseWaiting = null;
        this.baseWaitLogged = null;
        if (this.st.baseDueSince || this.st.pendingBase) {
            this.st.baseDueSince = 0;
            this.st.pendingBase = null;
            this.ctx.state.save();
        }
    }

    private reschedule(): void {
        if (this.stopped || this.paused) return;
        const mode = this.ctx.mode();
        if (mode === 'off') return;
        const now = this.ctx.now();
        if (this.backoffUntil > now) {
            this.scheduleAt(this.backoffUntil);
            return;
        }
        // Waiting for an idle machine to take the base snapshot: check again early (the user's idle window may be short)
        if (this.baseWaiting) this.scheduleAt(now + BASE_WAIT_RECHECK_MS);
        else if (mode === 'hourly') this.scheduleAt(now + HOUR_MS);
        if (mode !== 'hourly') void this.rearm();
    }

    // ─── Change segments ────────────────────────────────────────────────────────

    private async pushSegments(
        r2: R2Client, manifest: DbManifest, passphrase: string, countAtStart: number, scope: CloudScope = ALL_SCOPE,
    ): Promise<{ pushes: number; rows: number; bytes: number; rebase: string | null }> {
        let m = manifest;
        let pushes = 0;
        let rows = 0;
        let bytes = 0;
        let processed = 0;
        for (let guard = 0; guard < 1000; guard++) {
            this.checkRunnable();
            const packed = await this.ctx.ops.call<any>('pack', {
                dbPath: this.dbPath,
                limit: SEGMENT_ROW_LIMIT,
                maxBytes: SEGMENT_MAX_BYTES,
                now: this.ctx.now(),
                // Same scope as the base snapshot (checked in runCycle): rows outside the scope must not send content.
                scope: scopeArg(scope),
            });
            if (!packed) break;
            if (packed.rows > 0) {
                // The schema changed after the base snapshot (e.g. a migration ran midway) → the segment cannot be applied to the old base → take a new base snapshot.
                if (packed.fingerprint !== m.schemaFingerprint) return { pushes, rows, bytes, rebase: 'schema' };
                const enc = await this.ctx.core.crypto.encryptBuffer(asBuffer(packed.gz), passphrase);
                const key = segmentKey(m.workspaceUid, packed.fromId, packed.toId, packed.at);
                await r2.putObject(key, enc, { contentType: 'application/octet-stream' });
                const next = appendSegment(m, { key, fromId: packed.fromId, toId: packed.toId, at: packed.at, rows: packed.rows, bytes: enc.length });
                if (next.page) {
                    await r2.putObject(next.page.key, JSON.stringify({ version: 1, segments: next.page.segments }), { contentType: 'application/json' });
                }
                await this.writeManifest(r2, next.manifest);
                m = next.manifest;
                pushes++;
                rows += packed.rows;
                bytes += enc.length;
            }
            await this.ctx.ops.call('ack', { dbPath: this.dbPath, upToId: packed.toId });
            this.st.lastAckedId = Math.max(this.st.lastAckedId || 0, packed.toId);
            this.ctx.state.save();
            processed += packed.rows + packed.skipped;
            // Only push what was dirty when the cycle started; new changes get the next cycle (realtime: the worker reports them again).
            if (!packed.hasMore || processed >= countAtStart) break;
        }
        return { pushes, rows, bytes, rebase: null };
    }

    private async writeManifest(r2: R2Client, m: DbManifest): Promise<void> {
        const s = this.ctx.core.settings.get();
        m.workspaceName = this.name;
        m.machineId = s.machineId;
        m.machineName = s.machineName;
        m.appVersion = this.ctx.appVersion();
        m.updatedAt = this.ctx.now();
        await r2.putObject(manifestKey(m.workspaceUid), JSON.stringify(m), { contentType: 'application/json' });
        this.st.manifest = m;
        this.ctx.state.save();
    }

    // ─── Base snapshot ─────────────────────────────────────────────────────────

    private tmpDir(): string {
        return path.join(path.dirname(this.dbPath), '.cloud-sync-tmp');
    }

    private async cleanupTmp(): Promise<void> {
        try { await fs.promises.rm(this.tmpDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    }

    /**
     * Marks the base snapshot as running + a tick that checks whether the machine sleeps (a gap between two ticks > TIME_JUMP_MS = the process was frozen
     * → onPowerEvent stops the self-triggered snapshot). Returns the end function.
     */
    private beginBaseRun(run: { automatic: boolean; stamp: number; slept: boolean }): () => void {
        this.baseRun = run;
        let beat = this.ctx.now();
        const heartbeat = setInterval(() => {
            const now = this.ctx.now();
            if (now - beat > TIME_JUMP_MS) this.onPowerEvent('resume', now);
            beat = now;
        }, BASE_HEARTBEAT_MS);
        (heartbeat as any)?.unref?.();
        return () => {
            clearInterval(heartbeat);
            if (this.baseRun === run) this.baseRun = null;
        };
    }

    private async makeBase(
        r2: R2Client, bucket: string, passphrase: string, t: TrackingInfo, reason: string, scope: CloudScope = ALL_SCOPE,
        automatic = false,
    ): Promise<{ rows: number; bytes: number }> {
        return this.ctx.baseLock.run(async () => {
            this.checkRunnable();
            this.runtime = 'snapshotting';
            const at = this.ctx.now();
            // Copy step: the worker copies in one go (a consistent snapshot), so main measures the temp file size itself every second.
            const liveBytes = (await fileSize(this.dbPath)) + (await fileSize(`${this.dbPath}-wal`));
            this.progress = { phase: 'copy', percent: 0, done: 0, total: liveBytes, startedAt: at, phaseStartedAt: at, rate: null, retry: null };
            this.uploadSample = null;
            this.uploadLoggedQuarter = 0;
            this.ctx.notify();
            const rawPath = path.join(this.tmpDir(), `base-${at}.db`);
            const copyPoll = setInterval(() => {
                if (this.progress?.phase !== 'copy') return;
                void fileSize(rawPath).then(size => {
                    if (this.progress?.phase === 'copy' && size > 0) this.setProgress('copy', Math.min(size, liveBytes), liveBytes);
                });
            }, 1000);
            (copyPoll as any)?.unref?.();
            // A self-triggered snapshot that the machine sleeps through midway (Modern Standby wakes it for a few seconds at night, and it sleeps again when idle): stop at the
            // next step instead of finishing right when the user comes back.
            const run = { automatic, stamp: at, slept: false };
            const endRun = this.beginBaseRun(run);
            const checkAwake = () => {
                this.checkRunnable();
                if (run.slept) throw new AbortJob('Máy ngủ giữa lúc chụp bản gốc');
            };
            let snap: any;
            try {
                // Scope filtering is done in the worker, on the copy that was just backed up (does not touch the live DB).
                snap = await this.ctx.ops.call<any>('snapshot', { dbPath: this.dbPath, tmpDir: this.tmpDir(), stamp: at, scope: scopeArg(scope) });
            } catch (err) {
                this.progress = null;
                this.ctx.notify();
                endRun();
                if (run.slept) throw new AbortJob('Máy ngủ giữa lúc chụp bản gốc');
                throw err;
            } finally {
                clearInterval(copyPoll);
            }
            const encPath = `${snap.gzPath}.dplc`;
            try {
                checkAwake();
                const gzBytes = Number(snap.gzBytes) || (await fileSize(snap.gzPath));
                this.setProgress('encrypt', 0, gzBytes);
                const encPoll = setInterval(() => {
                    void fileSize(encPath).then(size => {
                        if (this.progress?.phase === 'encrypt') this.setProgress('encrypt', Math.min(size, gzBytes), gzBytes);
                    });
                }, 1000);
                (encPoll as any)?.unref?.();
                let enc: { bytes: number };
                try {
                    enc = await this.ctx.core.crypto.encryptFile(snap.gzPath, encPath, passphrase);
                } finally {
                    clearInterval(encPoll);
                }
                await removeQuietly(snap.gzPath);
                checkAwake();
                const passCheck = (await readHead(encPath, 64)).toString('base64');
                const uid = t.workspaceUid as string;
                const key = baseKey(uid, at);
                this.setProgress('upload', 0, enc.bytes);
                this.ctx.log('log', `[CloudDb] ${this.id}: bắt đầu tải bản gốc lên R2 (${mb(enc.bytes)} MB)`);
                // While the base snapshot uploads, media saving runs one file at a time (yields bandwidth to uploadCoordinator).
                const endUpload = beginDbBaseUpload();
                try {
                    await r2.putFile(key, encPath, {
                        contentType: 'application/octet-stream',
                        onProgress: (sent, total) => this.onUploadProgress(sent, total),
                        onRetry: info => this.onUploadRetry(info),
                    });
                } finally {
                    endUpload();
                }
                const s = this.ctx.core.settings.get();
                const m = newManifest({
                    workspaceUid: uid,
                    workspaceName: this.name,
                    machineId: s.machineId,
                    machineName: s.machineName,
                    appVersion: this.ctx.appVersion(),
                    schemaFingerprint: snap.fingerprint,
                    dbUid: snap.dbUid || t.dbUid,
                    passCheck,
                    base: { key, at, highWater: Number(snap.highWater) || 0, bytes: enc.bytes, rawBytes: Number(snap.rawBytes) || 0 },
                    rowCounts: snap.rowCounts || {},
                    scope,
                    accountNames: Array.isArray(snap.accountNames) ? snap.accountNames : [],
                });
                await this.writeManifest(r2, m);
                this.chainPassphrase = passphrase;
                this.forceBaseReason = null;
                // Changes that arrived before the snapshot are already in the base snapshot. New chain → the confirmation mark is recalculated from the base snapshot
                // (after turning sync off/on, the new _cloud_dirty numbers again from the start).
                await this.ctx.ops.call('ack', { dbPath: this.dbPath, upToId: m.base!.highWater });
                this.st.lastAckedId = m.base!.highWater;
                this.st.dbPath = this.dbPath;
                this.st.dbUid = m.dbUid;
                this.st.fingerprint = m.schemaFingerprint;
                this.ctx.state.save();
                this.hourRow = null;
                const removed = Object.values<number>(snap.scopeReport?.removed || {}).reduce((s2, n) => s2 + (Number(n) || 0), 0);
                this.ctx.log('log', `[CloudDb] ${this.id}: bản gốc ${key} (${enc.bytes} byte, lý do: ${reason}`
                    + `${snap.scopeReport ? `, phạm vi ${describeScope(scope)}: bỏ ${removed} dòng` : ''})`);
                try { this.ctx.onBaseDone(this, m, bucket); } catch { /* ignore */ }
                void this.sweepOld(r2, uid, key);
                const rows = Object.values<number>(snap.rowCounts || {}).reduce((s2, n) => s2 + (Number(n) || 0), 0);
                return { rows, bytes: enc.bytes };
            } finally {
                endRun();
                this.progress = null;
                this.uploadSample = null;
                this.ctx.notify();
                await removeQuietly(snap.gzPath, encPath);
            }
        });
    }

    /**
     * Cleans up the old chain after a new base snapshot exists: every object under <uid>/db/ older than the new base snapshot (by R2 time), except the manifest,
     * the standby machine heartbeats and the current manifest object that is still referenced. One List per base snapshot.
     */
    private async sweepOld(r2: R2Client, uid: string, newBaseKey: string): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const all: Array<{ key: string; lastModified: number }> = [];
            let token: string | null = null;
            for (let page = 0; page < 200; page++) {
                const res = await r2.listObjects(dbPrefix(uid), { continuationToken: token || undefined, maxKeys: 1000 });
                for (const o of res.objects) all.push({ key: o.key, lastModified: o.lastModified });
                token = res.nextToken;
                if (!token) break;
            }
            const baseObj = all.find(o => o.key === newBaseKey);
            if (!baseObj || !baseObj.lastModified) return;
            const keep = new Set<string>([newBaseKey, manifestKey(uid)]);
            const cur = this.st.manifest;
            if (cur) {
                if (cur.base) keep.add(cur.base.key);
                for (const s of cur.segments) keep.add(s.key);
                for (const p of cur.segmentPages) keep.add(p.key);
            }
            const victims = all
                .filter(o => !keep.has(o.key) && !o.key.startsWith(followersPrefix(uid)) && o.lastModified > 0 && o.lastModified < baseObj.lastModified)
                .map(o => o.key);
            if (!victims.length) return;
            await pool(victims, 6, async key => {
                try { await r2.deleteObject(key); } catch { /* clean up next time */ }
            });
            this.ctx.log('log', `[CloudDb] ${this.id}: đã dọn ${victims.length} object của chuỗi cũ`);
        } catch (err: any) {
            this.ctx.log('warn', `[CloudDb] ${this.id}: dọn chuỗi cũ lỗi: ${err?.message || err}`);
        } finally {
            this.sweeping = false;
        }
    }
}
