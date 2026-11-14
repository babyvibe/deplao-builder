/**
 * MediaEvictor: removes media files from the machine once a copy is certain to exist on R2.
 *
 * Safety rules (every removal path goes through evictOne):
 *  0. Only when the user turns on "giải phóng ổ đĩa" (free disk space; evictEnabled, default OFF = the files stay on the machine): checked at the
 *     start of each pass, before each file, and right before deleting (turned off midway → stop at once).
 *  1. Only index rows in state 'uploaded' (re-read right before deleting). A file that is not in the index / pending / missing → kept.
 *  2. The file on the machine must match the size + mtime from upload time; if different → upload again, keep the file.
 *  3. HEAD the object on R2: it must exist, with the right size (and the ETag if present) → only then delete the file on the machine; wrong → upload again, keep the file.
 *  4. state → 'evicted'. Never deletes anything on R2.
 *
 * Two paths:
 *  - runSpaceEviction (optional, evictEnabled; daily at ~03:00 and after large upload batches): candidates = uploaded, older than
 *    evictKeepDays (by mtime) and not opened within evictKeepDays; oldest first; stops once free space ≥ evictMinFreeGb.
 *    If free space cannot be read (fs.statfs fails) → clean all candidates (they are all old and verified on R2).
 *  - evictAccountOlderThan (replaces the per-account "tự xoá media cũ sau N ngày" (auto-delete old media after N days) when media sync is on AND
 *    free disk space is on, for accounts in the storage scope): the account's day folders YYYY-MM-DD older than N days → only removes files
 *    verified on R2; files that could not be backed up are kept (files in the storage scope are added to the index so they upload first;
 *    the next cleanup will remove them). Folders are kept (even empty ones are not deleted).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MediaSyncOptions } from '../../../shared/cloud/cloudContracts';
import type { R2Client } from '../contracts';
import type { ScannedFile } from './CloudMediaIndex';
import {
    absPathFor, isSkippedDirName, isSkippedFileName, MediaScopeFilter, normEtag, objectKeyFor, relInScope, relPathInRoot,
} from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { classifyR2Error, DAY, errorText, freeDiskBytes, GIB, LogFn, noLog, yieldToLoop } from './util';

export interface EvictorFs {
    stat(p: string): Promise<fs.Stats>;
    unlink(p: string): Promise<void>;
    readdir(p: string, opts: { withFileTypes: true }): Promise<fs.Dirent[]>;
    realpath(p: string): Promise<string>;
}

export interface EvictorDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    options(): MediaSyncOptions;
    isBackingOff(): boolean;
    onBusy(retryAfterMs?: number): void;
    /** Files were just added to the index (wakes the upload queue). */
    onIndexed?(count: number): void;
    /** Storage scope in effect (a file not yet in the index is only added if it is in scope); null = every file. */
    scope?(ctx: MediaContext): MediaScopeFilter | null;
    now?(): number;
    fs?: EvictorFs;
    freeBytes?(dir: string): Promise<number | null>;
    log?: LogFn;
}

export interface EvictResult {
    evicted: number;
    freedBytes: number;
    requeued: number;
    stopped?: 'enough_space' | 'busy' | 'aborted' | 'disabled' | 'no_context';
}

type EvictOutcome = 'evicted' | 'kept' | 'requeued';

const PAGE = 100;
const SPACE_CHECK_EVERY = 25;

export class MediaEvictor {
    private chain: Promise<unknown> = Promise.resolve();
    private readonly fs: EvictorFs;
    private readonly log: LogFn;

    constructor(private readonly deps: EvictorDeps) {
        this.fs = deps.fs || (fs.promises as unknown as EvictorFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    /** Cleanup runs take turns (space-based cleanup and account-based cleanup never overlap). */
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.chain.then(fn, fn);
        this.chain = next.catch(() => undefined);
        return next;
    }

    runSpaceEviction(isCurrent: () => boolean): Promise<EvictResult> {
        return this.serial(() => this.spaceEviction(isCurrent));
    }

    evictAccountOlderThan(accountDir: string, olderThanDays: number, isCurrent: () => boolean): Promise<EvictResult> {
        return this.serial(() => this.accountEviction(accountDir, olderThanDays, isCurrent));
    }

    /** Runs fn when no other cleanup run is active (the R2 cleanup tool does not overlap with cleaning files on the machine). */
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        return this.serial(fn);
    }

    /** "Giải phóng ổ đĩa" (free disk space) is on (default off = never delete files on the machine). */
    private evictAllowed(): boolean {
        try {
            return this.deps.options().evictEnabled === true;
        } catch {
            return false;
        }
    }

    // ─── One file ──────────────────────────────────────────────────────

    private async statOrNull(p: string): Promise<fs.Stats | null> {
        try { return await this.fs.stat(p); } catch { return null; }
    }

    private async evictOne(ctx: MediaContext, rel: string, alive: () => boolean): Promise<EvictOutcome> {
        const row = ctx.index.getRow(rel);
        if (!row || row.state !== 'uploaded') return 'kept';
        const size = Number(row.size);
        const mtime = Number(row.mtime_ms);
        const abs = absPathFor(ctx.realRoot, rel);
        const st = await this.statOrNull(abs);
        if (st && (!st.isFile() || st.size !== size || Math.floor(st.mtimeMs) !== mtime)) {
            // The file on the machine differs from the uploaded copy → upload again, do not delete
            if (alive()) ctx.index.requeueUploaded(rel, st.isFile() ? { size: st.size, mtimeMs: Math.floor(st.mtimeMs) } : {});
            return 'requeued';
        }
        const head = await this.deps.r2(ctx.bucket).headObject(objectKeyFor(ctx.workspaceUid, rel));
        const etagMismatch = !!(head && row.etag && head.etag && normEtag(head.etag) !== normEtag(row.etag));
        if (!head || Number(head.size) !== size || etagMismatch) {
            // R2 has no copy / it does not match → upload again, keep the file on the machine
            if (alive()) ctx.index.requeueUploaded(rel);
            this.log('warn', `[CloudMedia] Bản trên R2 không khớp, giữ file và tải lên lại: ${rel}`);
            return 'requeued';
        }
        if (!alive()) return 'kept';
        // Re-read right before deleting (the uploader / scanner may have just changed this row)
        const again = ctx.index.getRow(rel);
        if (!again || again.state !== 'uploaded' || Number(again.size) !== size || Number(again.mtime_ms) !== mtime) return 'kept';
        if (st) {
            const st2 = await this.statOrNull(abs);
            if (st2) {
                if (!st2.isFile() || st2.size !== size || Math.floor(st2.mtimeMs) !== mtime) return 'kept';
                // Final check: the user just turned off "giải phóng ổ đĩa" (free disk space) / changed workspace → do not delete
                if (!alive() || !this.evictAllowed()) return 'kept';
                await this.fs.unlink(abs);
            }
        }
        if (alive()) ctx.index.markEvicted(rel);
        return 'evicted';
    }

    private async evictMany(ctx: MediaContext, rels: string[], alive: () => boolean, result: EvictResult,
        sizes: Map<string, number>, afterEach?: () => Promise<boolean>): Promise<boolean> {
        for (const rel of rels) {
            if (!alive()) { result.stopped = 'aborted'; return false; }
            if (!this.evictAllowed()) { result.stopped = 'disabled'; return false; }
            if (this.deps.isBackingOff()) { result.stopped = 'busy'; return false; }
            let outcome: EvictOutcome;
            try {
                outcome = await this.evictOne(ctx, rel, alive);
            } catch (err) {
                const kind = classifyR2Error(err);
                if (kind === 'busy' || kind === 'network') {
                    this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
                    result.stopped = 'busy';
                    return false;
                }
                this.log('warn', `[CloudMedia] Dọn file lỗi (${rel}): ${errorText(err)}`);
                // Token / permission / bucket broken: the following files would fail the same way → stop the cleanup run (delete nothing)
                if (kind === 'auth' || kind === 'bucket') { result.stopped = 'aborted'; return false; }
                continue;
            }
            if (outcome === 'evicted') { result.evicted++; result.freedBytes += sizes.get(rel) || 0; }
            else if (outcome === 'requeued') result.requeued++;
            if (afterEach && !(await afterEach())) return false;
        }
        return true;
    }

    // ─── By disk space ───────────────────────────────────────────────

    private async spaceEviction(isCurrent: () => boolean): Promise<EvictResult> {
        const result: EvictResult = { evicted: 0, freedBytes: 0, requeued: 0 };
        const opts = this.deps.options();
        if (!opts.evictEnabled) { result.stopped = 'disabled'; return result; }
        const ctx = await this.deps.ctx.get();
        if (!ctx) { result.stopped = 'no_context'; return result; }
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        const freeBytes = this.deps.freeBytes || freeDiskBytes;
        const minFree = Math.max(0, opts.evictMinFreeGb) * GIB;
        let free = await freeBytes(ctx.realRoot);
        if (free !== null && free >= minFree) { result.stopped = 'enough_space'; return result; }

        const now = this.now();
        const cutoff = now - Math.max(1, opts.evictKeepDays) * DAY;
        let after: { mtime: number; rel: string } | undefined;
        let sinceCheck = 0;
        const afterEach = async (): Promise<boolean> => {
            if (++sinceCheck < SPACE_CHECK_EVERY) return true;
            sinceCheck = 0;
            free = await freeBytes(ctx.realRoot);
            if (free !== null && free >= minFree) { result.stopped = 'enough_space'; return false; }
            return true;
        };
        for (;;) {
            if (!alive()) { result.stopped = 'aborted'; break; }
            const rows = ctx.index.evictCandidates({ mtimeBefore: cutoff, accessBefore: cutoff, limit: PAGE, after });
            if (!rows.length) break;
            const last = rows[rows.length - 1];
            after = { mtime: Number(last.mtime_ms), rel: last.rel_path };
            const sizes = new Map(rows.map((r) => [r.rel_path, Number(r.size)] as [string, number]));
            if (!(await this.evictMany(ctx, rows.map((r) => r.rel_path), alive, result, sizes, afterEach))) break;
            await yieldToLoop();
        }
        if (result.evicted) {
            this.log('log', `[CloudMedia] Đã dọn ${result.evicted} file (${(result.freedBytes / GIB).toFixed(2)} GB) đã có trên R2`);
        }
        return result;
    }

    // ─── By account (replaces cleanupOldMedia when sync is on) ─────────

    private async accountEviction(accountDir: string, olderThanDays: number, isCurrent: () => boolean): Promise<EvictResult> {
        const result: EvictResult = { evicted: 0, freedBytes: 0, requeued: 0 };
        const name = String(accountDir || '');
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || !(olderThanDays > 0)) return result;
        // Keep files on the machine (default): never delete. The "tự xoá media cũ" (auto-delete old media) setting then runs as before in FileStorageService
        if (!this.evictAllowed()) { result.stopped = 'disabled'; return result; }
        const ctx = await this.deps.ctx.get();
        if (!ctx) { result.stopped = 'no_context'; return result; }
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        let filter: MediaScopeFilter | null = null;
        try { filter = this.deps.scope ? this.deps.scope(ctx) : null; } catch { filter = null; }

        // The folder name with the correct case on disk (the rel in the index keeps the exact name)
        let accountRel: string | null = null;
        try { accountRel = relPathInRoot(ctx.realRoot, await this.fs.realpath(path.join(ctx.realRoot, name))); } catch { accountRel = null; }
        if (!accountRel || accountRel.includes('/')) return result;

        const now = this.now();
        const cutoff = now - olderThanDays * DAY;
        let entries: fs.Dirent[];
        try { entries = await this.fs.readdir(absPathFor(ctx.realRoot, accountRel), { withFileTypes: true }); } catch { return result; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            // Same rule as the old cleanupOldMedia: only YYYY-MM-DD day folders older than N days
            const dirDate = new Date(`${entry.name}T00:00:00`);
            if (isNaN(dirDate.getTime()) || dirDate.getTime() >= cutoff) continue;
            const files = await this.listFiles(ctx, `${accountRel}/${entry.name}`, alive);
            for (let i = 0; i < files.length; i += 200) {
                if (!alive()) { result.stopped = 'aborted'; return result; }
                const chunk = files.slice(i, i + 200);
                const rows = ctx.index.getRows(chunk.map((f) => f.rel));
                // File not in the index: do NOT delete it → add it to the upload queue (only files in the storage scope)
                const unknown = chunk.filter((f) => !rows.has(f.rel) && relInScope(f.rel, f.mtimeMs, filter));
                if (unknown.length && alive()) {
                    const r = ctx.index.upsertScanned(unknown);
                    if (r.inserted + r.requeued > 0) this.deps.onIndexed?.(r.inserted + r.requeued);
                }
                const candidates = chunk.filter((f) => {
                    const row = rows.get(f.rel);
                    return !!row && row.state === 'uploaded' && (row.last_access_at == null || Number(row.last_access_at) < cutoff);
                });
                const sizes = new Map(candidates.map((f) => [f.rel, f.size] as [string, number]));
                if (!(await this.evictMany(ctx, candidates.map((f) => f.rel), alive, result, sizes))) return result;
                await yieldToLoop();
            }
        }
        if (result.evicted) {
            this.log('log', `[CloudMedia] Tự dọn media cũ (${name}): ${result.evicted} file đã có trên R2, ${(result.freedBytes / GIB).toFixed(2)} GB`);
        }
        return result;
    }

    /** Every file (recursive, does not follow symlinks) under the rel folder. */
    private async listFiles(ctx: MediaContext, dirRel: string, alive: () => boolean): Promise<ScannedFile[]> {
        const out: ScannedFile[] = [];
        const stack = [dirRel];
        while (stack.length) {
            if (!alive()) return out;
            const rel = stack.pop() as string;
            let entries: fs.Dirent[];
            try { entries = await this.fs.readdir(absPathFor(ctx.realRoot, rel), { withFileTypes: true }); } catch { continue; }
            const names: string[] = [];
            for (const e of entries) {
                if (e.isDirectory()) { if (!isSkippedDirName(e.name)) stack.push(`${rel}/${e.name}`); }
                else if (e.isFile() && !isSkippedFileName(e.name)) names.push(e.name);
            }
            const stats = await Promise.all(names.map((n) => this.statOrNull(absPathFor(ctx.realRoot, `${rel}/${n}`))));
            names.forEach((n, k) => {
                const st = stats[k];
                if (st && st.isFile() && st.size > 0) out.push({ rel: `${rel}/${n}`, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
            });
            await yieldToLoop();
        }
        return out;
    }
}
