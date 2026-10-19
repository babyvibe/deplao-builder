/**
 * SyncEngine — đồng bộ MỘT workspace local lên R2 (bản gốc + đoạn thay đổi + manifest + nhật ký).
 *
 *  - 'hourly'  : mỗi giờ một chu kỳ (đẩy hết dòng bẩn thành ≤ 5000 dòng/đoạn).
 *  - 'realtime': worker dò _cloud_dirty mỗi 2 s; có thay đổi → đẩy sau ~5 s. Không có thay đổi → không gọi R2.
 *  - Chụp gốc mới khi: chưa có gốc, DB bị thay (db_uid / đường dẫn / AUTOINCREMENT lùi), schema đổi, thiếu trigger,
 *    tổng đoạn > 25% gốc, gốc > 24 h (khung 02:00–04:00; quá 30 h thì làm ngay), một chu kỳ > 100k dòng bẩn,
 *    đổi mật khẩu sao lưu, đổi phạm vi đồng bộ (manifest ghi phạm vi khác phạm vi hiện tại).
 *    Gốc mới lên R2 + manifest trỏ tới nó rồi mới dọn gốc/đoạn cũ (R2 giữ MỘT bản).
 *  - Phạm vi (tài khoản + từ ngày) của RIÊNG workspace này (ctx.scope(id)): bản gốc lọc trên bản sao trong worker, đoạn
 *    thay đổi không gửi dòng ngoài phạm vi. Mỗi chu kỳ dùng MỘT phạm vi (đọc lúc bắt đầu) cho cả kiểm tra lẫn gói/chụp.
 *  - Mỗi workspace một hàng đợi công việc (không chồng chéo); một bản gốc tại một thời điểm cho cả máy (baseLock).
 *  - Lỗi: R2_BUSY / mạng → lùi 30 s … 5 phút; lỗi quyền → 'error' + 15 phút; 2 lần lỗi liên tiếp → báo UI.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CloudScope, DbSyncMode, DbSyncProgress, DbSyncWorkspaceStatus, SyncLogEntry } from '../../../shared/cloudContracts';
import { ALL_SCOPE, isAllScope, normalizeScope } from '../../../shared/cloudContracts';
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
import type { StateStore, WorkspaceSyncState } from './state';
import type { LogInput } from './syncLog';

export const START_DELAY_MS = 20_000;
export const RECHECK_DELAY_MS = 3_000;
export const REALTIME_DELAY_MS = 5_000;
export const HOUR_MS = 3_600_000;
export const WATCH_INTERVAL_MS = 2_000;
export const MAINTENANCE_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const AUTH_RETRY_MS = 15 * 60_000;
const LOG_CACHE = 500;

/** Trọng số các bước khi tính % cả lần chụp gốc (tải lên thường lâu nhất). */
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
    /** Phạm vi đồng bộ (tài khoản + từ ngày) của workspace này — lưu theo workspace; thiếu = tất cả. */
    scope?(workspaceId: string): CloudScope;
    /** Bảo đảm bucket của máy (tạo một lần) → tên bucket. */
    ensureBucket(): Promise<string>;
    appVersion(): string;
    log(level: 'log' | 'warn' | 'error', msg: string): void;
    notify(urgent?: boolean): void;
    baseLock: Mutex;
    now(): number;
    /** Một workspaceUid chỉ được một engine dùng (DB sao chép giữa hai workspace → không ghi đè bản sao của nhau). */
    claimUid(uid: string, engineId: string): string | null;
    onBaseDone(engine: SyncEngine, manifest: DbManifest, bucket: string): void;
}

class AbortJob extends Error {
    code = 'DBSYNC_ABORTED';
}

// STORAGE_FULL (Google Drive hết dung lượng): người dùng phải dọn / nâng gói → lùi như lỗi quyền, không thử dồn dập
const AUTH_CODES = new Set(['R2_FORBIDDEN', 'TOKEN_INACTIVE', 'INVALID_TOKEN', 'BAD_TOKEN', 'NOT_CONNECTED', 'R2_NOT_ENABLED', 'STORAGE_FULL']);

export function isAuthError(err: any): boolean {
    return AUTH_CODES.has(String(err?.code || '')) || err?.status === 401 || err?.status === 403;
}

/** Câu báo lỗi tiếng Việt cho người dùng. */
export function userMessage(err: any): string {
    const code = String(err?.code || '');
    switch (code) {
        case 'R2_FORBIDDEN':
        case 'TOKEN_INACTIVE':
        case 'INVALID_TOKEN':
        case 'BAD_TOKEN':
            // Lỗi của Google Drive đã có câu riêng; còn lại là token Cloudflare
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

/** Mô tả ngắn phạm vi cho nhật ký (không in id tài khoản). */
export function describeScope(scope: CloudScope | null | undefined): string {
    const s = normalizeScope(scope);
    if (isAllScope(s)) return 'tất cả';
    const parts: string[] = [s.accounts === 'all' ? 'mọi tài khoản' : `${s.accounts.length} tài khoản`];
    if (s.fromTs !== null) {
        // fromTs = 00:00 giờ máy của ngày chọn → in theo ngày giờ máy (UTC sẽ lệch sang hôm trước ở UTC+7).
        const d = new Date(s.fromTs);
        const pad = (n: number) => String(n).padStart(2, '0');
        parts.push(`từ ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    return parts.join(', ');
}

/** Phạm vi gửi sang worker: null = toàn bộ (worker không lọc gì). */
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
        try { await fs.promises.rm(f, { force: true }); } catch { /* bỏ qua */ }
    }
}

/** Chạy fn cho từng phần tử, tối đa `limit` việc song song. */
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
    /** Tiến độ lần chụp gốc đang chạy (null = không chạy). */
    private progress: DbSyncProgress | null = null;
    private uploadSample: { at: number; sent: number } | null = null;
    private uploadLoggedQuarter = 0;

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

    // ─── Vòng đời ─────────────────────────────────────────────────────────────

    start(): void {
        this.stopped = false;
        void this.loadLogCache();
        // Dọn file tạm của lần chụp gốc dở (app tắt giữa chừng) — xếp vào hàng đợi để không đua với chu kỳ đầu tiên.
        this.chain = this.chain.then(() => this.cleanupTmp()).catch(() => undefined);
        this.applyMode(START_DELAY_MS);
    }

    /** Đổi chế độ (hourly ↔ realtime) hoặc khởi động lại lịch. */
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
            this.maintTimer = setInterval(() => { void this.enqueue('maintenance'); }, MAINTENANCE_MS);
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

    /** Dừng hẳn (tắt đồng bộ / xoá workspace / thoát app). Chờ việc đang chạy tối đa timeoutMs. */
    async stop(timeoutMs = 30_000): Promise<void> {
        this.stopped = true;
        this.pause();
        await this.idle(timeoutMs);
    }

    /** Chờ hàng đợi công việc rỗng (tối đa timeoutMs). true = đã rỗng. */
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
     * Sau thao tác thay file DB (pauseFor): kiểm tra lại db_uid / đường dẫn sớm.
     * resetBackoff: vừa kết nối lại Cloudflare → bỏ thời gian lùi do lỗi quyền/mạng.
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

    /** Đồng bộ ngay (nút "Đồng bộ ngay") — bỏ qua thời gian lùi, ném lỗi cho người gọi. */
    syncNow(): Promise<void> {
        this.backoffUntil = 0;
        return this.enqueue('manual', true);
    }

    /** Sự kiện từ worker: _cloud_dirty có dòng (chế độ realtime). */
    onDirty(): void {
        if (this.stopped) return;
        if (this.paused) {
            this.pendingDirty = true;
            return;
        }
        if (this.ctx.mode() !== 'realtime') return;
        this.scheduleAt(this.ctx.now() + REALTIME_DELAY_MS);
    }

    // ─── Trạng thái / nhật ký ─────────────────────────────────────────────────

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
        };
    }

    // ─── Tiến độ chụp gốc ─────────────────────────────────────────────────────

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

    /** Sự kiện từ worker trong lúc chụp gốc (lọc theo phạm vi, nén). */
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
        // Đang chạy tiếp được → bỏ dòng "đang thử lại" sau 30 s.
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
        } catch { /* lần sau */ }
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
            // Một chuỗi lỗi liên tiếp = một dòng (cập nhật giờ kết thúc + lỗi mới nhất), không làm đầy nhật ký.
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

    // ─── Lịch ────────────────────────────────────────────────────────────────

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

    private scheduleAt(ts: number): void {
        if (this.stopped || this.paused || this.ctx.mode() === 'off') return;
        const at = Math.max(ts, this.backoffUntil);
        if (this.timer && this.timerAt <= at) return; // đã có lịch sớm hơn
        if (this.timer) clearTimeout(this.timer);
        this.timerAt = at;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.timerAt = 0;
            void this.enqueue('timer');
        }, Math.max(0, at - this.ctx.now()));
        (this.timer as any)?.unref?.();
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
        try { await this.ctx.ops.call('unwatch', { dbPath: this.dbPath }); } catch { /* worker đã dừng */ }
    }

    private async rearm(): Promise<void> {
        if (!this.watching) return;
        try {
            const ok = await this.ctx.ops.call<boolean>('rearm', { dbPath: this.dbPath });
            if (!ok) {
                // Worker vừa được tạo lại (chết / bị dừng) → mất vòng dò → cài lại.
                this.watching = false;
                await this.watch();
            }
        } catch { /* worker đã dừng — lần sau */ }
    }

    // ─── Chu kỳ đồng bộ ───────────────────────────────────────────────────────

    private enqueue(reason: string, throwErrors = false): Promise<void> {
        // Đã có một chu kỳ đang chờ (chưa chạy) → dùng chung, không xếp thêm.
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

    /** Phạm vi đang cấu hình cho workspace này (không phải phạm vi của bản gốc trên R2). */
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
            // Đổi kho (R2 ↔ Google Drive): manifest đang nhớ là của kho cũ → đọc lại trên kho mới (chưa có → chụp gốc mới)
            const provider = this.ctx.core.storageProvider();
            if ((this.st.provider || 'r2') !== provider) {
                this.st.provider = provider;
                this.st.manifest = null;
                this.ctx.state.save();
            }
            const passphrase = this.passphrase();
            // Một phạm vi cho cả chu kỳ: đổi phạm vi giữa chừng → chu kỳ sau thấy manifest khác phạm vi → chụp gốc mới.
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
                || (t.reinstalled ? 'tracking' : null)
                || (this.st.dbPath && !samePath(this.st.dbPath, this.dbPath) ? 'db-path' : null)
                || (t.dirtySeq < lastPushedId ? 'older-db' : null)
                // Gồm cả phạm vi: manifest ghi phạm vi khác (hoặc thiếu trong khi phạm vi hiện tại bị giới hạn) → gốc mới.
                || rebaseReason(manifest, { now: this.ctx.now(), fingerprint: t.fingerprint, dbUid: t.dbUid, scope });
            if (!rebase && manifest && !(await this.chainPassOk(manifest, passphrase))) rebase = 'passphrase';

            if (!rebase) {
                const stats = await this.ctx.ops.call<DirtyStats>('dirtyStats', { dbPath: this.dbPath });
                if (stats.count > REBASE_DIRTY_ROWS) {
                    rebase = 'bulk';
                } else if (stats.count > 0) {
                    const res = await this.pushSegments(r2, manifest as DbManifest, passphrase, stats.count, scope);
                    pushes += res.pushes;
                    rows += res.rows;
                    bytes += res.bytes;
                    rebase = res.rebase;
                }
            }
            if (rebase) {
                this.checkRunnable();
                kind = 'base';
                this.ctx.log('log', `[CloudDb] ${this.id}: chụp bản gốc mới (${rebase}, phạm vi: ${describeScope(scope)})`);
                const b = await this.makeBase(r2, bucket, passphrase, t, rebase, scope);
                pushes += 1;
                rows += b.rows;
                bytes += b.bytes;
                baseDone = true;
            }

            // Thành công
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
                // Tạm dừng giữa chừng (đổi workspace / xoá / khôi phục): không tính là lỗi, chạy lại khi tiếp tục.
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
        // Hai lần lỗi liên tiếp (hoặc lỗi quyền) → UI hiện cảnh báo.
        if (auth || this.failures === 2) this.ctx.notify(true);
        else this.ctx.notify();
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
        if (mode === 'hourly') this.scheduleAt(now + HOUR_MS);
        else void this.rearm();
    }

    // ─── Đoạn thay đổi ────────────────────────────────────────────────────────

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
                // Cùng phạm vi với bản gốc (đã kiểm ở runCycle): dòng ngoài phạm vi không được gửi nội dung.
                scope: scopeArg(scope),
            });
            if (!packed) break;
            if (packed.rows > 0) {
                // Schema đổi sau bản gốc (vd migration chạy giữa chừng) → đoạn không áp được lên gốc cũ → chụp gốc mới.
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
            // Chỉ đẩy phần đã bẩn lúc bắt đầu chu kỳ; thay đổi mới sẽ có chu kỳ sau (realtime: worker báo lại).
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

    // ─── Bản gốc ─────────────────────────────────────────────────────────────

    private tmpDir(): string {
        return path.join(path.dirname(this.dbPath), '.cloud-sync-tmp');
    }

    private async cleanupTmp(): Promise<void> {
        try { await fs.promises.rm(this.tmpDir(), { recursive: true, force: true }); } catch { /* bỏ qua */ }
    }

    private async makeBase(
        r2: R2Client, bucket: string, passphrase: string, t: TrackingInfo, reason: string, scope: CloudScope = ALL_SCOPE,
    ): Promise<{ rows: number; bytes: number }> {
        return this.ctx.baseLock.run(async () => {
            this.checkRunnable();
            this.runtime = 'snapshotting';
            const at = this.ctx.now();
            // Bước sao chép: worker chép một mạch (ảnh chụp nhất quán) nên main tự đo kích thước file tạm mỗi giây.
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
            let snap: any;
            try {
                // Lọc theo phạm vi làm trong worker, trên bản sao vừa backup (không đụng DB sống).
                snap = await this.ctx.ops.call<any>('snapshot', { dbPath: this.dbPath, tmpDir: this.tmpDir(), stamp: at, scope: scopeArg(scope) });
            } catch (err) {
                this.progress = null;
                this.ctx.notify();
                throw err;
            } finally {
                clearInterval(copyPoll);
            }
            const encPath = `${snap.gzPath}.dplc`;
            try {
                this.checkRunnable();
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
                const passCheck = (await readHead(encPath, 64)).toString('base64');
                const uid = t.workspaceUid as string;
                const key = baseKey(uid, at);
                this.setProgress('upload', 0, enc.bytes);
                this.ctx.log('log', `[CloudDb] ${this.id}: bắt đầu tải bản gốc lên R2 (${mb(enc.bytes)} MB)`);
                // Trong lúc tải bản gốc, lưu media chạy 1 file một lúc (nhường đường truyền — uploadCoordinator).
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
                // Thay đổi đến trước lúc chụp đã nằm trong bản gốc. Chuỗi mới → mốc xác nhận tính lại từ bản gốc
                // (sau khi tắt/bật lại, _cloud_dirty mới đánh số lại từ đầu).
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
                try { this.ctx.onBaseDone(this, m, bucket); } catch { /* bỏ qua */ }
                void this.sweepOld(r2, uid, key);
                const rows = Object.values<number>(snap.rowCounts || {}).reduce((s2, n) => s2 + (Number(n) || 0), 0);
                return { rows, bytes: enc.bytes };
            } finally {
                this.progress = null;
                this.uploadSample = null;
                this.ctx.notify();
                await removeQuietly(snap.gzPath, encPath);
            }
        });
    }

    /**
     * Dọn chuỗi cũ sau khi có gốc mới: mọi object dưới <uid>/db/ cũ hơn bản gốc mới (theo giờ R2), trừ manifest,
     * nhịp tim máy dự phòng và object manifest hiện tại còn tham chiếu. Một lần List mỗi lần chụp gốc.
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
                try { await r2.deleteObject(key); } catch { /* lần dọn sau */ }
            });
            this.ctx.log('log', `[CloudDb] ${this.id}: đã dọn ${victims.length} object của chuỗi cũ`);
        } catch (err: any) {
            this.ctx.log('warn', `[CloudDb] ${this.id}: dọn chuỗi cũ lỗi: ${err?.message || err}`);
        } finally {
            this.sweeping = false;
        }
    }
}
