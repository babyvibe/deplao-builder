/**
 * MediaCleanup: tool that cleans files off R2. Runs only when the user clicks it on purpose (deleting a message in the app does NOT delete anything on R2).
 *
 *  1. preview(req): read only, deletes nothing. Scans the cloud_media index of the open workspace (rows 'uploaded' / 'evicted')
 *     page by page on the primary key, and picks the files that match ONE of the enabled criteria:
 *       • orphans     media files of an account (never shared files) that no DB row points to any more.
 *                     Scans EVERY real table (except the R2 index / DB sync tables / FTS), every non-numeric column, in rowid batches of ≤ 500
 *                     rows + yields to the event loop (customer DBs can have millions of messages). Extra references = less cleanup (safe). Files edited
 *                     in the last 24 hours are not considered. If a DatabaseService query returns [] on error → re-check with MAX(rowid),
 *                     a mismatch stops everything (never guess "mồ côi" (orphan) files).
 *       • accounts    every file of these accounts (keys.accountOfRelPath, including Facebook folders by fb_accounts.id).
 *       • olderThan   file time (mtime, clamped to the day folder) < the cutoff.
 *       • outOfScope  outside the current storage scope (account not selected, before "từ ngày" (from date), shared files when they are turned off).
 *     Files that exist only on R2 (cleaned off the machine / machine no longer has them) are skipped unless includeCloudOnly (counted in skippedCloudOnly).
 *     The list is remembered for 15 minutes under a random code (only the latest scan).
 *  2. run(previewId): deletes exactly the list that was reviewed: re-checks each row right before deleting (changed since the scan → skip; a file
 *     that was on the machine at scan time and is gone now → skip, unless deleting files that exist only on R2 has been allowed), DeleteObjects ≤ 1000 keys / call
 *     (without it, deletes object by object, 4 in parallel), R2 busy → back off the whole queue, then retry. Row → 'removed' (the row is not deleted;
 *     it is not uploaded again unless the file changes). deleteLocalOrphans → also deletes the on-machine copy of the orphan files that were deleted
 *     from R2 (only orphan files, only inside the media folder, only the copy that was scanned). Runs in the MediaEvictor queue.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import type { R2CleanupPreview, R2CleanupProgress, R2CleanupRequest, R2CleanupResult } from '../../../shared/cloud/cloudContracts';
import type { R2Client } from '../contracts';
import { CloudError } from '../contracts';
import type { MediaDb } from './CloudMediaIndex';
import {
    absPathFor, accountOfRelPath, collectMediaRefs, MediaScopeFilter, mediaRefKey, mediaTimeOf, objectKeyFor, relInScope,
    relPathInRoot,
} from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { classifyR2Error, DAY, errorText, LogFn, MINUTE, noLog, SECOND, sleep, storeLabelNow, yieldToLoop } from './util';
import { tr } from '../../../shared/i18n';

export const CLEANUP_PREVIEW_TTL_MS = 15 * MINUTE;
/** An orphan file must be older than 24 hours (a file just saved may not have been written to the DB yet). */
export const ORPHAN_MIN_AGE_MS = DAY;
const INDEX_PAGE = 1000;
const REF_PAGE = 500;
const STAT_CHUNK = 200;
const DELETE_BATCH = 1000;
const PER_OBJECT_CONCURRENCY = 4;
const MAX_DELETE_ATTEMPTS = 6;
const MAX_SAMPLES = 20;
const PROGRESS_EVERY_MS = 300;
/**
 * Tables not scanned for references: the R2 index (it holds the rel of EVERY file, so scanning it would leave no orphans) and the
 * DB sync tables. Virtual tables (FTS) and their shadow tables are skipped by table kind.
 */
const SKIP_REF_TABLES = new Set(['cloud_media', '_cloud_dirty', '_cloud_meta', 'cloud_sync_log']);

export interface CleanupFs {
    stat(p: string): Promise<fs.Stats>;
    unlink(p: string): Promise<void>;
    realpath(p: string): Promise<string>;
}

export interface CleanupDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    /** Current storage scope (for the "ngoài phạm vi" (outside scope) criterion); null = every file is in scope. */
    scope(ctx: MediaContext): MediaScopeFilter | null;
    /** Account folder aliases (Facebook: fb_accounts.id → facebook_id). */
    aliases(ctx: MediaContext): ReadonlyMap<string, string> | null;
    /** The queue is backing off as a whole because R2 is busy. */
    isBackingOff(): boolean;
    /** ms left in the back-off (0 = not backing off). */
    backoffRemainingMs(): number;
    /** R2 busy while deleting → back off together with the upload queue. */
    onBusy(retryAfterMs?: number): void;
    /** Runs fn in the file cleanup queue (does not overlap with MediaEvictor). */
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
    now?(): number;
    fs?: CleanupFs;
    sleep?(ms: number): Promise<void>;
    log?: LogFn;
}

interface CleanupItem {
    rel: string;
    size: number;
    mtimeMs: number;
    /** Matches the orphans criterion; only these files may have their on-machine copy deleted (deleteLocalOrphans). */
    orphan: boolean;
    /** Still had an on-machine copy at scan time. */
    local: boolean;
}

interface Candidate {
    rel: string;
    size: number;
    mtimeMs: number;
    evicted: boolean;
    accounts: boolean;
    olderThan: boolean;
    outOfScope: boolean;
    orphan: boolean;
}

interface StoredPreview {
    id: string;
    createdAt: number;
    dbPath: string;
    workspaceUid: string;
    bucket: string;
    includeCloudOnly: boolean;
    deleteLocalOrphans: boolean;
    items: CleanupItem[];
}

export interface RefTable {
    name: string;
    /** Column that may hold text (not declared as a numeric type). */
    columns: string[];
    /** Usable rowid name; null = WITHOUT ROWID (paged with OFFSET). */
    rowid: string | null;
    /** MAX(rowid) (or COUNT(*)) for the progress bar. */
    estimate: number;
}

type Report = (phase: R2CleanupProgress['phase'], done: number, total: number, message?: string, force?: boolean) => void;

function quoteIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`;
}

function scanFailed(table: string): CloudError {
    return new CloudError('CLEANUP_SCAN_FAILED', tr('Không đọc được bảng {{table}} để kiểm tra file còn được dùng — chưa dọn gì, hãy thử lại.', { table }));
}

function abortedError(): CloudError {
    return new CloudError('CLEANUP_ABORTED', tr('Đã đổi workspace hoặc tắt lưu media trong lúc dọn {{v1}} — hãy quét lại.', { v1: storeLabelNow() }));
}

function busyError(): CloudError {
    return new CloudError('CLEANUP_BUSY', tr('Đang quét / dọn file trên {{v1}} — chờ lượt này xong rồi thử lại.', { v1: storeLabelNow() }));
}

function expiredError(): CloudError {
    return new CloudError('PREVIEW_EXPIRED', tr('Kết quả quét đã cũ, hãy quét lại'));
}

function reporter(onProgress?: (p: R2CleanupProgress) => void): Report {
    let last = 0;
    return (phase, done, total, message, force = false) => {
        if (!onProgress) return;
        const t = Date.now();
        if (!force && t - last < PROGRESS_EVERY_MS) return;
        last = t;
        const safeTotal = Math.max(0, Math.floor(total) || 0);
        const p: R2CleanupProgress = { phase, done: Math.min(safeTotal, Math.max(0, Math.floor(done) || 0)), total: safeTotal };
        if (message) p.message = message;
        try { onProgress(p); } catch { /* window already closed */ }
    };
}

/**
 * Real tables may hold media paths (columns not declared as numeric). PRAGMA table_list (SQLite ≥ 3.37) already tells
 * virtual / shadow tables / WITHOUT ROWID apart; older versions → read sqlite_master. A read error → throw (no guessing).
 */
export function listReferenceTables(db: MediaDb): RefTable[] {
    let entries: Array<{ name: string; type: string; wr: number }> = [];
    try {
        entries = db.all<{ schema?: unknown; name: unknown; type: unknown; wr?: unknown }>('PRAGMA table_list')
            .filter((t) => !t.schema || t.schema === 'main')
            .map((t) => ({ name: String(t.name), type: String(t.type), wr: Number(t.wr) || 0 }));
    } catch {
        entries = [];
    }
    if (!entries.length) {
        const rows = db.all<{ name: unknown; sql: unknown }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`);
        const virtuals = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(r.sql || ''))).map((r) => String(r.name));
        entries = rows.map((r) => {
            const name = String(r.name);
            const type = virtuals.includes(name) ? 'virtual' : virtuals.some((v) => name.startsWith(`${v}_`)) ? 'shadow' : 'table';
            return { name, type, wr: /\bWITHOUT\s+ROWID\b/i.test(String(r.sql || '')) ? 1 : 0 };
        });
    }
    if (!entries.length) throw scanFailed('sqlite_master');
    const out: RefTable[] = [];
    for (const t of entries) {
        if (t.type !== 'table' || /^sqlite_/i.test(t.name) || SKIP_REF_TABLES.has(t.name)) continue;
        const q = quoteIdent(t.name);
        const info = db.all<{ name: unknown; type: unknown }>(`PRAGMA table_info(${q})`);
        // Every table has a column: empty = read error
        if (!info.length) throw scanFailed(t.name);
        const columns = info.filter((c) => !/INT|REAL|FLOA|DOUB/i.test(String(c.type || ''))).map((c) => String(c.name));
        if (!columns.length) continue;
        const names = new Set(info.map((c) => String(c.name).toLowerCase()));
        const rowid = t.wr ? null : (['rowid', '_rowid_', 'oid'].find((a) => !names.has(a)) ?? null);
        const est = db.get<{ m: unknown }>(rowid ? `SELECT MAX(${rowid}) AS m FROM ${q}` : `SELECT COUNT(*) AS m FROM ${q}`);
        if (!est) throw scanFailed(t.name);
        out.push({ name: t.name, columns, rowid, estimate: Math.max(0, Number(est.m) || 0) });
    }
    return out;
}

export class MediaCleanup {
    private stored: StoredPreview | null = null;
    private busy = false;
    private readonly fs: CleanupFs;
    private readonly log: LogFn;

    constructor(private readonly deps: CleanupDeps) {
        this.fs = deps.fs || (fs.promises as unknown as CleanupFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private sleep(ms: number): Promise<void> {
        return this.deps.sleep ? this.deps.sleep(ms) : sleep(ms);
    }

    /** Stop media storage: drop the scanned list. */
    reset(): void {
        this.stored = null;
    }

    get running(): boolean {
        return this.busy;
    }

    // ─── Step 1: scan ──────────────────────────────────────────────────

    async preview(req: R2CleanupRequest, isCurrent: () => boolean, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupPreview> {
        const r = (req && typeof req === 'object' ? req : {}) as R2CleanupRequest;
        const accounts = new Set((Array.isArray(r.accounts) ? r.accounts : []).map((a) => String(a ?? '').trim()).filter(Boolean));
        const olderThanTs = typeof r.olderThanTs === 'number' && Number.isFinite(r.olderThanTs) && r.olderThanTs > 0 ? r.olderThanTs : null;
        const wantOrphans = r.orphans === true;
        const wantOutOfScope = r.outOfScope === true;
        const includeCloudOnly = r.includeCloudOnly === true;
        const deleteLocalOrphans = r.deleteLocalOrphans === true;
        if (!wantOrphans && !accounts.size && olderThanTs === null && !wantOutOfScope) {
            throw new CloudError('BAD_INPUT', tr('Chọn ít nhất một tiêu chí dọn.'));
        }
        if (this.busy) throw busyError();
        this.busy = true;
        const report = reporter(onProgress);
        try {
            const ctx = await this.deps.ctx.get();
            if (!ctx) throw new CloudError('MEDIA_UNAVAILABLE', tr('Chưa mở được chỉ mục media của workspace này — thử lại sau ít phút.'));
            const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
            if (!alive()) throw abortedError();
            const startedAt = this.now();
            const aliases = this.deps.aliases(ctx);
            const filter = wantOutOfScope ? this.deps.scope(ctx) : null;
            const orphanBefore = startedAt - ORPHAN_MIN_AGE_MS;
            const tables = wantOrphans ? listReferenceTables(ctx.index.db) : [];
            const indexTotal = ctx.index.rowCountEstimate();
            const total = indexTotal + tables.reduce((s, t) => s + t.estimate, 0);
            let done = 0;
            report('scan', 0, total, undefined, true);

            // 1. Index: files already on R2 that match the criteria + orphan candidates (account files edited more than 24 hours ago)
            const matched = new Map<string, Candidate>();
            const orphanCandidates: Candidate[] = [];
            const candidateKeys = new Set<string>();
            let after = '';
            for (;;) {
                if (!alive()) throw abortedError();
                const rows = ctx.index.pageByRel(after, INDEX_PAGE);
                if (!rows.length) break;
                after = rows[rows.length - 1].rel_path;
                for (const row of rows) {
                    if (row.state !== 'uploaded' && row.state !== 'evicted') continue;
                    const rel = row.rel_path;
                    const mtimeMs = Number(row.mtime_ms) || 0;
                    const account = accountOfRelPath(rel, aliases);
                    const c: Candidate = {
                        rel,
                        size: Number(row.size) || 0,
                        mtimeMs,
                        evicted: row.state === 'evicted',
                        accounts: account !== null && accounts.has(account),
                        olderThan: olderThanTs !== null && mediaTimeOf(rel, mtimeMs) < olderThanTs,
                        outOfScope: !!filter && !relInScope(rel, mtimeMs, filter),
                        orphan: false,
                    };
                    if (c.accounts || c.olderThan || c.outOfScope) matched.set(rel, c);
                    if (wantOrphans && account !== null && mtimeMs < orphanBefore) {
                        orphanCandidates.push(c);
                        candidateKeys.add(mediaRefKey(rel));
                    }
                }
                done += rows.length;
                report('scan', done, total);
                await yieldToLoop();
            }
            done = Math.max(done, indexTotal);

            // 2. Orphans: no DB row points to them (scan all tables, or stop early once every candidate has a reference)
            if (orphanCandidates.length) {
                const found = new Set<string>();
                for (const t of tables) {
                    const base = done;
                    const complete = await this.scanTable(ctx.index.db, t, candidateKeys, found, alive,
                        (pos) => report('scan', base + Math.min(pos, t.estimate), total));
                    done = base + t.estimate;
                    if (complete) break;
                }
                for (const c of orphanCandidates) {
                    if (found.has(mediaRefKey(c.rel))) continue;
                    c.orphan = true;
                    matched.set(c.rel, c);
                }
            }

            // 3. Files that exist only on R2 (cleaned off the machine / machine has no copy): skipped unless allowed
            const list = Array.from(matched.values()).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
            const items: CleanupItem[] = [];
            const byReason = { orphans: 0, accounts: 0, olderThan: 0, outOfScope: 0 };
            let bytes = 0;
            let cloudOnlyFiles = 0;
            let cloudOnlyBytes = 0;
            let skippedCloudOnly = 0;
            let localOrphans = 0;
            for (let i = 0; i < list.length; i += STAT_CHUNK) {
                if (!alive()) throw abortedError();
                const chunk = list.slice(i, i + STAT_CHUNK);
                const present = await Promise.all(chunk.map((c) => (c.evicted ? Promise.resolve(false) : this.isLocalFile(ctx, c.rel))));
                chunk.forEach((c, k) => {
                    const local = present[k];
                    if (!local && !includeCloudOnly) { skippedCloudOnly++; return; }
                    items.push({ rel: c.rel, size: c.size, mtimeMs: c.mtimeMs, orphan: c.orphan, local });
                    bytes += c.size;
                    if (!local) { cloudOnlyFiles++; cloudOnlyBytes += c.size; }
                    if (c.orphan) { byReason.orphans++; if (local) localOrphans++; }
                    if (c.accounts) byReason.accounts++;
                    if (c.olderThan) byReason.olderThan++;
                    if (c.outOfScope) byReason.outOfScope++;
                });
                await yieldToLoop();
            }
            if (!alive()) throw abortedError();

            // 4. Remember the list (only the latest scan, 15 minutes)
            const createdAt = this.now();
            const id = randomBytes(12).toString('hex');
            this.stored = {
                id, createdAt, dbPath: ctx.dbPath, workspaceUid: ctx.workspaceUid, bucket: ctx.bucket,
                includeCloudOnly, deleteLocalOrphans, items,
            };
            report('done', total, total, undefined, true);
            this.log('log', `[CloudMedia] Quét dọn R2: ${items.length} file (${(bytes / 1024 / 1024).toFixed(1)} MB), `
                + `bỏ qua ${skippedCloudOnly} file chỉ còn trên R2`);
            return {
                previewId: id,
                scannedAt: createdAt,
                files: items.length,
                bytes,
                cloudOnlyFiles,
                cloudOnlyBytes,
                skippedCloudOnly,
                localFiles: deleteLocalOrphans ? localOrphans : 0,
                byReason,
                samples: items.slice(0, MAX_SAMPLES).map((it) => it.rel),
            };
        } catch (err) {
            report('error', 0, 0, errorText(err), true);
            throw err;
        } finally {
            this.busy = false;
        }
    }

    private async isLocalFile(ctx: MediaContext, rel: string): Promise<boolean> {
        try {
            return (await this.fs.stat(absPathFor(ctx.realRoot, rel))).isFile();
        } catch {
            return false;
        }
    }

    /**
     * Scans one table in batches (rowid ascending, ≤ 500 rows / query, yields to the event loop between batches), recording the references found.
     * true = every candidate already has a reference (no need to scan further). An empty page while MAX(rowid) is still larger = query error → retry
     * once, then throw.
     */
    private async scanTable(db: MediaDb, t: RefTable, candidates: Set<string>, found: Set<string>, alive: () => boolean,
        onPosition: (pos: number) => void): Promise<boolean> {
        const cols = t.columns.map(quoteIdent).join(', ');
        const q = quoteIdent(t.name);
        const scanRows = (rows: Array<Record<string, unknown>>) => {
            for (const row of rows) {
                for (const c of t.columns) {
                    const v = row[c];
                    if (typeof v === 'string') collectMediaRefs(v, candidates, found);
                }
            }
        };
        let retried = false;
        if (t.rowid) {
            let last = Number.MIN_SAFE_INTEGER;
            for (;;) {
                if (!alive()) throw abortedError();
                const rows = db.all<Record<string, unknown>>(
                    `SELECT ${t.rowid} AS "__cleanup_rowid", ${cols} FROM ${q} WHERE ${t.rowid} > ? ORDER BY ${t.rowid} LIMIT ${REF_PAGE}`,
                    [last],
                );
                if (!rows.length) {
                    const max = db.get<{ m: unknown }>(`SELECT MAX(${t.rowid}) AS m FROM ${q}`);
                    if (!max) throw scanFailed(t.name);
                    const m = max.m === null || max.m === undefined ? null : Number(max.m);
                    if (m !== null && m > last) {
                        if (retried) throw scanFailed(t.name);
                        retried = true;
                        continue;
                    }
                    return false;
                }
                retried = false;
                scanRows(rows);
                last = Number(rows[rows.length - 1].__cleanup_rowid);
                onPosition(last);
                if (found.size >= candidates.size) return true;
                await yieldToLoop();
            }
        }
        let offset = 0;
        for (;;) {
            if (!alive()) throw abortedError();
            const rows = db.all<Record<string, unknown>>(`SELECT ${cols} FROM ${q} LIMIT ${REF_PAGE} OFFSET ?`, [offset]);
            if (!rows.length) {
                const count = db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${q}`);
                if (!count) throw scanFailed(t.name);
                if (Number(count.n) > offset) {
                    if (retried) throw scanFailed(t.name);
                    retried = true;
                    continue;
                }
                return false;
            }
            retried = false;
            scanRows(rows);
            offset += rows.length;
            onPosition(offset);
            if (found.size >= candidates.size) return true;
            await yieldToLoop();
        }
    }

    // ─── Step 2: delete ───────────────────────────────────────────────────

    async run(previewId: string, isCurrent: () => boolean, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupResult> {
        const p = this.stored;
        const now = this.now();
        if (!p || !previewId || p.id !== previewId || now - p.createdAt > CLEANUP_PREVIEW_TTL_MS || now < p.createdAt - MINUTE) {
            throw expiredError();
        }
        if (this.busy) throw busyError();
        this.busy = true;
        const report = reporter(onProgress);
        try {
            const ctx = await this.deps.ctx.get();
            if (!ctx || ctx.dbPath !== p.dbPath || ctx.workspaceUid !== p.workspaceUid || ctx.bucket !== p.bucket) throw expiredError();
            // Single use: running it again requires a new scan
            this.stored = null;
            return await this.deps.exclusive(() => this.deleteAll(ctx, p, isCurrent, report));
        } catch (err) {
            report('error', 0, 0, errorText(err), true);
            throw err;
        } finally {
            this.busy = false;
        }
    }

    private async deleteAll(ctx: MediaContext, p: StoredPreview, isCurrent: () => boolean, report: Report): Promise<R2CleanupResult> {
        const result: R2CleanupResult = { deleted: 0, bytes: 0, failed: 0, localDeleted: 0 };
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        const r2 = this.deps.r2(ctx.bucket);
        const total = p.items.length;
        let processed = 0;
        let skipped = 0;
        let stopError: unknown = null;
        report('delete', 0, total, undefined, true);
        for (let i = 0; i < total && !stopError; i += DELETE_BATCH) {
            if (!alive()) { stopError = abortedError(); break; }
            const batch = p.items.slice(i, i + DELETE_BATCH);
            // Re-check right before deleting: the row is still on R2 and matches the scanned copy; a file that had an on-machine copy at scan time and has lost it since
            // (cleaned off the machine since then) → its R2 copy becomes the only copy → delete only if the user allowed deleting that whole category
            const stats = await Promise.all(batch.map((b) => (b.local ? this.statOrNull(absPathFor(ctx.realRoot, b.rel)) : Promise.resolve(null))));
            if (!alive()) { stopError = abortedError(); break; }
            const rows = ctx.index.getRows(batch.map((b) => b.rel));
            const ready: CleanupItem[] = [];
            batch.forEach((b, k) => {
                const row = rows.get(b.rel);
                const same = !!row && (row.state === 'uploaded' || row.state === 'evicted')
                    && Number(row.size) === b.size && Number(row.mtime_ms) === b.mtimeMs;
                const st = stats[k];
                const stillLocal = !!st && st.isFile() && st.size === b.size && Math.floor(st.mtimeMs) === b.mtimeMs;
                if (!same || (b.local && !stillLocal && !p.includeCloudOnly)) { skipped++; return; }
                ready.push(b);
            });
            const keys = ready.map((b) => objectKeyFor(ctx.workspaceUid, b.rel));
            const out = await this.deleteKeys(r2, keys, alive);
            const removed = ready.filter((_, k) => out.deleted.has(keys[k]));
            // Workspace changed midway: do not write into another workspace's DB (the next HEAD / download will notice the missing row and fix it)
            if (removed.length && this.deps.ctx.isValid(ctx)) ctx.index.markRemoved(removed.map((b) => b.rel));
            result.deleted += removed.length;
            for (const b of removed) result.bytes += b.size;
            if (out.error) stopError = out.error;
            if (p.deleteLocalOrphans) {
                for (const b of removed) {
                    if (b.orphan && b.local && (await this.removeLocal(ctx, b, alive))) result.localDeleted++;
                }
            }
            processed += batch.length;
            report('delete', processed, total);
            await yieldToLoop();
        }
        result.failed = Math.max(0, total - result.deleted);
        const mb = (result.bytes / 1024 / 1024).toFixed(1);
        if (stopError) {
            this.log('warn', `[CloudMedia] Dọn R2 dừng: ${errorText(stopError)} — đã xoá ${result.deleted} file (${mb} MB), còn ${result.failed} file`);
            // Nothing deleted yet → report the error straight to the user (e.g. token missing permission); partly deleted → return the result
            if (!result.deleted) throw stopError;
            report('error', processed, total, errorText(stopError), true);
        } else {
            report('done', total, total, undefined, true);
        }
        this.log('log', `[CloudMedia] Dọn R2: đã xoá ${result.deleted} file (${mb} MB), không xoá ${result.failed} file `
            + `(${skipped} đã đổi từ lúc quét), xoá trên máy ${result.localDeleted} file`);
        return result;
    }

    private async statOrNull(p: string): Promise<fs.Stats | null> {
        try { return await this.fs.stat(p); } catch { return null; }
    }

    /** Deletes the on-machine copy of an orphan file: only inside the media folder (does not follow junctions out of it), and only the copy that was scanned. */
    private async removeLocal(ctx: MediaContext, b: CleanupItem, alive: () => boolean): Promise<boolean> {
        try {
            const real = await this.fs.realpath(absPathFor(ctx.realRoot, b.rel));
            if (relPathInRoot(ctx.realRoot, real) !== b.rel) return false;
            const st = await this.fs.stat(real);
            if (!st.isFile() || st.size !== b.size || Math.floor(st.mtimeMs) !== b.mtimeMs) return false;
            if (!alive()) return false;
            await this.fs.unlink(real);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Deletes the keys on R2: one DeleteObjects call (≤ 1000 keys); without it, object by object (4 in parallel). R2 busy / no network →
     * back off the whole queue, then retry the rest (up to 6 times); any other error (token, bucket…) → stop and return the error.
     */
    private async deleteKeys(r2: R2Client, keys: string[], alive: () => boolean): Promise<{ deleted: Set<string>; error: unknown }> {
        const deleted = new Set<string>();
        let attempts = 0;
        while (deleted.size < keys.length) {
            while (this.deps.isBackingOff()) {
                if (!alive()) return { deleted, error: abortedError() };
                await this.sleep(Math.min(5 * SECOND, Math.max(SECOND, this.deps.backoffRemainingMs())));
            }
            if (!alive()) return { deleted, error: abortedError() };
            const todo = keys.filter((k) => !deleted.has(k));
            try {
                if (typeof r2.deleteObjects === 'function') {
                    const res = await r2.deleteObjects(todo);
                    for (const k of res.deleted) deleted.add(k);
                    if (res.errors.length) {
                        this.log('warn', `[CloudMedia] Dọn R2: ${res.errors.length} file không xoá được (${res.errors[0].code || 'lỗi'})`);
                    }
                    return { deleted, error: null };
                }
                for (let i = 0; i < todo.length; i += PER_OBJECT_CONCURRENCY) {
                    if (!alive()) return { deleted, error: abortedError() };
                    const group = todo.slice(i, i + PER_OBJECT_CONCURRENCY);
                    const settled = await Promise.allSettled(group.map((k) => r2.deleteObject(k)));
                    let firstError: unknown = null;
                    settled.forEach((s, j) => {
                        if (s.status === 'fulfilled') deleted.add(group[j]);
                        else if (firstError === null) firstError = s.reason ?? new Error(tr('Xoá trên R2 lỗi'));
                    });
                    if (firstError !== null) throw firstError;
                }
                return { deleted, error: null };
            } catch (err) {
                const kind = classifyR2Error(err);
                if ((kind === 'busy' || kind === 'network') && ++attempts < MAX_DELETE_ATTEMPTS) {
                    this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
                    if (!this.deps.isBackingOff()) await this.sleep(5 * SECOND);
                    continue;
                }
                return { deleted, error: err };
            }
        }
        return { deleted, error: null };
    }
}
