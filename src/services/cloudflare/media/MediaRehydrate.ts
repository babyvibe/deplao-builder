/**
 * MediaRehydrate: brings media files back from R2 to the machine.
 *
 *  - resolveMissing(absPath, { waitMs }): called from local-media:// and from the employee media route when the file is NOT on the machine.
 *    Only files inside the open workspace's media folder that the index records as 'uploaded' / 'evicted' ('removed' = cleaned from
 *    R2 → not downloaded) → getObjectToFile to the exact original path (the original mtime is restored), state → 'uploaded', records the access time. Merges
 *    duplicate requests for the same file; waits up to waitMs (default 60 s, clamped to 0…120 s) and then returns null: the download KEEPS RUNNING in the background
 *    (kept in inflight; it does not record "not found" just because the caller stopped waiting) → next time the file is there at once, or it joins the same download.
 *    Never throws.
 *  - rehydrateAll(): re-downloads every cleaned file ('evicted', then 'uploaded' that the machine no longer has): in the background, 2 files in parallel,
 *    stops when the disk has less than 2 GB free.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { R2Client } from '../contracts';
import type { MediaRow } from './CloudMediaIndex';
import { absPathFor, isSkippedRelPath, objectKeyFor, relPathInRoot, resolveStoredLocalPath } from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import {
    classifyR2Error, errorText, freeDiskBytes, GIB, LogFn, MINUTE, noLog, SECOND, sleep, storeLabelNow, withTimeout, yieldToLoop,
} from './util';
import { tr } from '../../../shared/i18n';

export const RESOLVE_TIMEOUT_MS = MINUTE;
/** Upper limit of the waitMs passed in by the caller. */
export const RESOLVE_MAX_WAIT_MS = 2 * MINUTE;
const NEGATIVE_TTL_MS = MINUTE;          // not in the index / not yet on R2
const SHORT_NEGATIVE_TTL_MS = 10 * SECOND; // temporary error (R2 busy, network)
const NEGATIVE_MAX = 5000;
const BULK_CONCURRENCY = 2;
const BULK_MIN_FREE_BYTES = 2 * GIB;

export interface RehydrateFs {
    stat(p: string): Promise<fs.Stats>;
    mkdir(p: string, opts: { recursive: true }): Promise<unknown>;
    utimes(p: string, atime: Date, mtime: Date): Promise<void>;
    realpath(p: string): Promise<string>;
}

export interface RehydrateDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    /** The queue is backing off because R2 is busy → no downloads for now. */
    isBackingOff(): boolean;
    /** R2 busy while downloading → back off together with the upload queue. */
    onBusy(retryAfterMs?: number): void;
    /** Notification for the user (e.g. disk full while re-downloading everything). */
    onNotice?(message: string): void;
    onChange?(): void;
    now?(): number;
    fs?: RehydrateFs;
    freeBytes?(dir: string): Promise<number | null>;
    sleep?(ms: number): Promise<void>;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    log?: LogFn;
}

export class MediaRehydrate {
    private readonly inflight = new Map<string, Promise<string | null>>();
    private readonly negative = new Map<string, number>();
    private bulk: Promise<void> | null = null;
    private readonly fs: RehydrateFs;
    private readonly log: LogFn;

    constructor(private readonly deps: RehydrateDeps) {
        this.fs = deps.fs || (fs.promises as unknown as RehydrateFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    reset(): void {
        this.negative.clear();
    }

    get bulkRunning(): boolean {
        return !!this.bulk;
    }

    // ─── On request ──────────────────────────────────────────────────

    /** Wait time: a valid waitMs is clamped to [0, 120 s]; missing → default (60 s, tests change it via deps.timeoutMs). */
    private waitFor(opts?: { waitMs?: number }): number {
        const w = opts ? opts.waitMs : undefined;
        if (typeof w === 'number' && Number.isFinite(w)) return Math.min(RESOLVE_MAX_WAIT_MS, Math.max(0, Math.floor(w)));
        return this.deps.timeoutMs ?? RESOLVE_TIMEOUT_MS;
    }

    async resolveMissing(absPath: string, opts?: { waitMs?: number }): Promise<string | null> {
        try {
            if (!absPath || typeof absPath !== 'string') return null;
            const ctx = await this.deps.ctx.get();
            if (!ctx) return null;
            const rel = await this.relForMissing(ctx, absPath);
            if (!rel || isSkippedRelPath(rel)) return null;
            const key = `${ctx.id}|${rel}`;
            const until = this.negative.get(key);
            if (until !== undefined) {
                if (until > this.now()) return null;
                this.negative.delete(key);
            }
            let job = this.inflight.get(key);
            if (!job) {
                job = this.lookupAndRestore(ctx, rel, key).finally(() => this.inflight.delete(key));
                this.inflight.set(key, job);
            }
            // When the wait times out, only the caller gets null; the download is not cancelled and nothing is recorded as "not found"
            return await withTimeout(job, this.waitFor(opts), null);
        } catch {
            return null;
        }
    }

    private remember(key: string, ttl: number): void {
        if (this.negative.size >= NEGATIVE_MAX) this.negative.clear();
        this.negative.set(key, this.now() + ttl);
    }

    private async lookupAndRestore(ctx: MediaContext, rel: string, key: string): Promise<string | null> {
        try {
            const row = this.findRow(ctx, rel);
            if (!row || (row.state !== 'uploaded' && row.state !== 'evicted')) {
                this.remember(key, NEGATIVE_TTL_MS);
                return null;
            }
            const restored = await this.restore(ctx, row, () => this.deps.ctx.isValid(ctx));
            if (!restored) this.remember(key, SHORT_NEGATIVE_TTL_MS);
            return restored;
        } catch (err) {
            const kind = classifyR2Error(err);
            if (kind === 'busy' || kind === 'network') this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
            this.remember(key, SHORT_NEGATIVE_TTL_MS);
            this.log('warn', `[CloudMedia] Tải từ R2 lỗi (${rel}): ${errorText(err)}`);
            return null;
        }
    }

    /**
     * Any path inside the media folder → rel. If the parent folder is still on the machine, get the correct case via realpath
     * (the index stores names exactly as they are on disk).
     */
    private async relForMissing(ctx: MediaContext, absPath: string): Promise<string | null> {
        let abs = absPath;
        if (!path.isAbsolute(abs)) {
            const resolved = resolveStoredLocalPath(abs, ctx.mediaRoot);
            if (!resolved) return null;
            abs = resolved;
        }
        let rel = relPathInRoot(ctx.mediaRoot, abs) || relPathInRoot(ctx.realRoot, abs);
        if (!rel) return null;
        const slash = rel.lastIndexOf('/');
        if (slash > 0) {
            try {
                const realDir = await this.fs.realpath(absPathFor(ctx.mediaRoot, rel.slice(0, slash)));
                const relDir = relPathInRoot(ctx.realRoot, realDir);
                if (relDir) rel = `${relDir}/${rel.slice(slash + 1)}`;
            } catch { /* parent folder gone → keep as is */ }
        }
        return rel;
    }

    private findRow(ctx: MediaContext, rel: string): MediaRow | undefined {
        let row = ctx.index.findRow([rel, rel.normalize('NFC'), rel.normalize('NFD')]);
        const platform = this.deps.platform || process.platform;
        if (!row && (platform === 'win32' || platform === 'darwin')) row = ctx.index.findRowCaseInsensitive(rel);
        return row;
    }

    /** Downloads one file to its original location. null when it cannot be downloaded (R2 busy, no longer on R2…). May throw an R2 error. */
    private async restore(ctx: MediaContext, row: MediaRow, canWrite: () => boolean): Promise<string | null> {
        const rel = row.rel_path;
        const target = absPathFor(ctx.mediaRoot, rel);
        try {
            const st = await this.fs.stat(target);
            if (st.isFile()) {
                // Already on the machine (another request just finished downloading it / the file was copied back) → only fix the state if it is recorded as 'evicted'
                if (row.state === 'evicted' && canWrite()) ctx.index.markRestored(rel, this.now());
                return target;
            }
        } catch { /* not there yet → download */ }
        if (this.deps.isBackingOff()) return null;
        await this.fs.mkdir(path.dirname(target), { recursive: true });
        const res = await this.deps.r2(ctx.bucket).getObjectToFile(objectKeyFor(ctx.workspaceUid, rel), target);
        if (!res) {
            this.log('warn', `[CloudMedia] Không còn trên R2: ${rel}`);
            if (canWrite()) ctx.index.markMissing(rel, tr('Không còn bản trên {{v1}}', { v1: storeLabelNow() }));
            return null;
        }
        if (Number(row.mtime_ms) > 0) {
            // Keep the original mtime → the next scan does not treat it as a new / changed file (no re-upload)
            try { await this.fs.utimes(target, new Date(), new Date(Number(row.mtime_ms))); } catch { /* ignore */ }
        }
        if (canWrite()) ctx.index.markRestored(rel, this.now());
        this.deps.onChange?.();
        return target;
    }

    // ─── Re-download everything ───────────────────────────────────────────────

    /** Runs in the background (calling it while it runs → shares the run in progress). */
    rehydrateAll(isCurrent: () => boolean): Promise<void> {
        if (!this.bulk) {
            this.bulk = this.runBulk(isCurrent)
                .catch((err) => this.log('warn', `[CloudMedia] Tải lại media lỗi: ${errorText(err)}`))
                .finally(() => { this.bulk = null; });
        }
        return this.bulk;
    }

    private async runBulk(isCurrent: () => boolean): Promise<void> {
        const ctx = await this.deps.ctx.get();
        if (!ctx) return;
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        const freeBytes = this.deps.freeBytes || freeDiskBytes;
        const wait = this.deps.sleep || sleep;
        let restored = 0;
        let sinceSpaceCheck = Number.POSITIVE_INFINITY;
        // 'evicted' = cleaned off the machine; 'uploaded' but the machine no longer has the file (e.g. the DB was restored on a new machine)
        for (const state of ['evicted', 'uploaded'] as const) {
            let before: { mtime: number; rel: string } | undefined;
            for (;;) {
                if (!alive()) return;
                const rows = ctx.index.rowsByStateNewestFirst(state, 50, before);
                if (!rows.length) break;
                const last = rows[rows.length - 1];
                before = { mtime: Number(last.mtime_ms), rel: last.rel_path };
                let todo = rows;
                if (state === 'uploaded') {
                    const present = await Promise.all(rows.map((r) =>
                        this.fs.stat(absPathFor(ctx.mediaRoot, r.rel_path)).then((s) => s.isFile(), () => false)));
                    todo = rows.filter((_, k) => !present[k]);
                }
                for (let i = 0; i < todo.length; i += BULK_CONCURRENCY) {
                    while (this.deps.isBackingOff()) {
                        if (!alive()) return;
                        await wait(5 * SECOND);
                    }
                    if (!alive()) return;
                    if (sinceSpaceCheck >= 20) {
                        sinceSpaceCheck = 0;
                        const free = await freeBytes(ctx.realRoot);
                        if (free !== null && free < BULK_MIN_FREE_BYTES) {
                            this.deps.onNotice?.(tr('Ổ đĩa còn dưới 2 GB — đã dừng tải lại media từ {{v1}}.', { v1: storeLabelNow() }));
                            return;
                        }
                    }
                    const batch = todo.slice(i, i + BULK_CONCURRENCY);
                    sinceSpaceCheck += batch.length;
                    const results = await Promise.all(batch.map(async (row) => {
                        try {
                            return await this.restore(ctx, row, alive);
                        } catch (err) {
                            const kind = classifyR2Error(err);
                            if (kind === 'busy' || kind === 'network') this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
                            else this.log('warn', `[CloudMedia] Tải lại lỗi (${row.rel_path}): ${errorText(err)}`);
                            return null;
                        }
                    }));
                    restored += results.filter(Boolean).length;
                }
                await yieldToLoop();
            }
        }
        if (restored) this.log('log', `[CloudMedia] Đã tải lại ${restored} file từ R2`);
    }
}
