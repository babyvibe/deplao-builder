/**
 * CloudMediaIndex: the `cloud_media` table in the DB of the open workspace: one row per media file.
 *
 *   rel_path       path inside the media/ folder ('/', exact name on disk): the primary key
 *   size, mtime_ms file size / modified time (ms, rounded down) when indexed or when uploaded
 *   sha256, etag   hash of the uploaded content; the ETag is taken from HEAD after the upload (same form as the HEAD used when evicting a file)
 *   state          pending → uploading → uploaded (→ evicted once removed from the machine) | missing (file vanished before upload)
 *                  | excluded (outside the storage scope: account / from date / shared file; not uploaded, not counted in totals)
 *                  | removed (the user cleaned it from R2 with the cleanup tool: not uploaded again unless the file changes
 *                    size / mtime; not downloaded; not counted in totals)
 *   uploaded_at, last_access_at, attempts, last_error
 *   priority       (added) 1 = Zalo media expired on the CDN (upload first), 0 = normal, -1 = failed too many times ("failed")
 *   next_try_at    (added) when a failed file may be retried (backs off per file)
 *
 * Written in batches of ≤ 500 rows / transaction. Rows are never deleted (R2 is the archive: deleting a message in the app does not delete it on R2;
 * only the R2 cleanup tool, run by the user, deletes objects, and it moves the row to 'removed').
 */
import { ALL_SCOPE, CloudScope, normalizeScope } from '../../../shared/cloud/cloudContracts';
import { HOUR, MINUTE } from './util';

export type MediaState = 'pending' | 'uploading' | 'uploaded' | 'evicted' | 'missing' | 'excluded' | 'removed';

/** SQL access to the DB of the open workspace (DatabaseService in the app; node:sqlite in tests). */
export interface MediaDb {
    exec(sql: string): void;
    /** Returns the number of changed rows. */
    run(sql: string, params?: unknown[]): number;
    all<T = any>(sql: string, params?: unknown[]): T[];
    get<T = any>(sql: string, params?: unknown[]): T | undefined;
    transaction<T>(fn: () => T): T;
}

export interface MediaRow {
    rel_path: string;
    size: number;
    mtime_ms: number;
    sha256: string | null;
    state: MediaState;
    etag: string | null;
    uploaded_at: number | null;
    last_access_at: number | null;
    attempts: number;
    last_error: string | null;
    priority: number;
    next_try_at: number;
}

export interface ScannedFile {
    rel: string;
    size: number;
    /** ms, rounded down (Math.floor(stat.mtimeMs)). */
    mtimeMs: number;
    priority?: number;
}

export interface MediaTotals {
    files: number;
    uploaded: number;
    pending: number;
    failed: number;
    evicted: number;
    bytesTotal: number;
    bytesUploaded: number;
}

export const EMPTY_TOTALS: Readonly<MediaTotals> = Object.freeze({
    files: 0, uploaded: 0, pending: 0, failed: 0, evicted: 0, bytesTotal: 0, bytesUploaded: 0,
});

export const INDEX_BATCH = 500;
export const PRIORITY_EXPIRED = 1;
export const PRIORITY_NORMAL = 0;
export const PRIORITY_PARKED = -1;
export const MAX_FILE_ATTEMPTS = 5;

/** app_settings: workspace id (the R2 key prefix): a DB restored on another machine can still find its media. */
export const SETTING_WORKSPACE_UID = 'cloud_workspace_uid';
/** app_settings: full-scan cursor (JSON; the scan can resume after the app is closed). */
export const SETTING_SCAN_CURSOR = 'cloud_media_scan_cursor';
/** app_settings: bucket holding this workspace's media (kept when the DB is restored on another machine). */
export const SETTING_MEDIA_BUCKET = 'cloud_media_bucket';
/**
 * app_settings: the store that the cloud_media row states refer to ('r2' | 'gdrive'; not set yet = 'r2', since old versions only had R2).
 * Different from the store currently selected → files already on the old store must be uploaded again to the new store (resetForNewStore).
 */
export const SETTING_MEDIA_PROVIDER = 'cloud_media_provider';
/** app_settings: storage scope (keys.scopeSignature) the index follows; different from the current scope → scan again from the start. */
export const SETTING_MEDIA_SCOPE = 'cloud_media_scope';
/**
 * app_settings: the storage scope the user picked for THIS workspace (JSON { scope, includeShared }). Accounts belong to the workspace,
 * so the scope is per workspace (switching workspace does not drop all of its accounts). Not set yet = all, including shared files.
 */
export const SETTING_MEDIA_SCOPE_CHOICE = 'cloud_media_scope_choice';

/** Media storage scope of one workspace. */
export interface MediaScopeChoice {
    scope: CloudScope;
    includeShared: boolean;
}

export const ALL_MEDIA_SCOPE: Readonly<MediaScopeChoice> = Object.freeze({ scope: ALL_SCOPE, includeShared: true });

const ROW_COLUMNS = 'rel_path, size, mtime_ms, sha256, state, etag, uploaded_at, last_access_at, attempts, last_error, priority, next_try_at';

function marks(n: number): string {
    return new Array(n).fill('?').join(', ');
}

function num(v: unknown): number {
    return Number(v) || 0;
}

/** Retry back-off per file: 1, 4, 16, 64 minutes… up to 6 hours. */
export function fileRetryDelayMs(attempts: number): number {
    return Math.min(6 * HOUR, MINUTE * Math.pow(4, Math.max(0, attempts - 1)));
}

export class CloudMediaIndex {
    constructor(readonly db: MediaDb) {}

    // ─── Schema / settings ─────────────────────────────────────────────

    /**
     * Change the store (R2 ↔ Google Drive): files already on the old store → wait to be uploaded to the new store. Files the user cleaned from the old store
     * ('removed') stay as they are (not re-queued automatically); files that exist only on the old store ('evicted') cannot be switched: call
     * countEvicted() first, otherwise the store is not changed for this workspace. Returns the number of rows changed.
     */
    resetForNewStore(): number {
        return this.db.run(
            `UPDATE cloud_media SET state = 'pending', etag = NULL, uploaded_at = NULL, attempts = 0, last_error = NULL,
                priority = CASE WHEN priority < 0 THEN 0 ELSE priority END, next_try_at = 0
             WHERE state IN ('uploaded', 'uploading')`,
        );
    }

    /** Number of files that exist only on the store (removed from the machine). */
    countEvicted(): number {
        return num(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cloud_media WHERE state = 'evicted'`)?.n);
    }

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cloud_media (
                rel_path TEXT PRIMARY KEY,
                size INTEGER NOT NULL DEFAULT 0,
                mtime_ms INTEGER NOT NULL DEFAULT 0,
                sha256 TEXT,
                state TEXT NOT NULL DEFAULT 'pending',
                etag TEXT,
                uploaded_at INTEGER,
                last_access_at INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                next_try_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_cloud_media_state ON cloud_media(state, priority, mtime_ms);
            CREATE INDEX IF NOT EXISTS idx_cloud_media_state_mtime ON cloud_media(state, mtime_ms, size);
        `);
    }

    tableExists(): boolean {
        return !!this.db.get(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'cloud_media'`);
    }

    getSetting(key: string): string | null {
        const row = this.db.get<{ value: unknown }>('SELECT value FROM app_settings WHERE key = ?', [key]);
        return row && typeof row.value === 'string' ? row.value : null;
    }

    setSetting(key: string, value: string): void {
        this.db.run(
            `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, value],
        );
    }

    /** Storage scope the user picked for this workspace (read only; not picked / corrupt → all, including shared files). */
    readScopeChoice(): MediaScopeChoice {
        try {
            const raw = this.getSetting(SETTING_MEDIA_SCOPE_CHOICE);
            if (!raw) return { scope: { ...ALL_SCOPE }, includeShared: true };
            const v = JSON.parse(raw) as { scope?: unknown; includeShared?: unknown };
            return {
                scope: normalizeScope(v && typeof v === 'object' ? v.scope : null),
                includeShared: !(v && typeof v === 'object' && v.includeShared === false),
            };
        } catch {
            return { scope: { ...ALL_SCOPE }, includeShared: true };
        }
    }

    writeScopeChoice(choice: MediaScopeChoice): void {
        const scope = normalizeScope(choice.scope);
        this.setSetting(SETTING_MEDIA_SCOPE_CHOICE, JSON.stringify({ v: 1, scope, includeShared: choice.includeShared !== false }));
    }

    // ─── Indexing ───────────────────────────────────────────────────

    /**
     * Add / update files seen on disk (≤ 500 rows per transaction). The caller only passes files INSIDE the storage scope:
     *  - not yet indexed → pending;  missing → pending;  excluded (the scope now includes this file) → pending;
     *  - uploaded but size/mtime changed → pending (re-uploaded under the same key); evicted but the file is back on the machine → uploaded (or pending if different);
     *  - removed (cleaned from R2): kept as is, unless size/mtime changed (a new file with the same name) → pending;
     *  - pending: update size/mtime, raise priority; a file that failed too many times and has changed → retry; uploading: left to the uploader to handle.
     */
    upsertScanned(files: ScannedFile[]): { inserted: number; requeued: number } {
        let inserted = 0;
        let requeued = 0;
        for (let i = 0; i < files.length; i += INDEX_BATCH) {
            const unique = new Map<string, ScannedFile>();
            for (const f of files.slice(i, i + INDEX_BATCH)) if (f && f.rel) unique.set(f.rel, f);
            const batch = Array.from(unique.values());
            if (!batch.length) continue;
            this.db.transaction(() => {
                const existing = new Map<string, MediaRow>();
                for (const row of this.db.all<MediaRow>(
                    `SELECT rel_path, size, mtime_ms, state, priority FROM cloud_media WHERE rel_path IN (${marks(batch.length)})`,
                    batch.map((f) => f.rel),
                )) existing.set(row.rel_path, row);

                const fresh: ScannedFile[] = [];
                for (const f of batch) {
                    const r = existing.get(f.rel);
                    const priority = Math.max(PRIORITY_NORMAL, num(f.priority));
                    if (!r) { fresh.push(f); continue; }
                    const changed = num(r.size) !== f.size || num(r.mtime_ms) !== f.mtimeMs;
                    if (r.state === 'missing' || r.state === 'excluded'
                        || (changed && (r.state === 'uploaded' || r.state === 'evicted' || r.state === 'removed'))) {
                        requeued += this.db.run(
                            `UPDATE cloud_media SET state = 'pending', size = ?, mtime_ms = ?, attempts = 0, last_error = NULL,
                                    next_try_at = 0, priority = ? WHERE rel_path = ?`,
                            [f.size, f.mtimeMs, priority, f.rel],
                        );
                    } else if (r.state === 'evicted') {
                        // The evicted file is back on the machine, the same copy that was uploaded
                        this.db.run(`UPDATE cloud_media SET state = 'uploaded' WHERE rel_path = ? AND state = 'evicted'`, [f.rel]);
                    } else if (r.state === 'pending') {
                        // A file that failed too many times (priority < 0) is only retried when its content changes
                        const parked = num(r.priority) < 0;
                        if (changed || (!parked && priority > num(r.priority))) {
                            this.db.run(
                                `UPDATE cloud_media SET size = ?, mtime_ms = ?, priority = ?,
                                        attempts = CASE WHEN ? THEN 0 ELSE attempts END,
                                        next_try_at = CASE WHEN ? THEN 0 ELSE next_try_at END
                                 WHERE rel_path = ? AND state = 'pending'`,
                                [f.size, f.mtimeMs, Math.max(priority, num(r.priority), PRIORITY_NORMAL),
                                    parked ? 1 : 0, changed ? 1 : 0, f.rel],
                            );
                            if (parked) requeued++;
                        }
                    }
                }
                for (let j = 0; j < fresh.length; j += 100) {
                    const chunk = fresh.slice(j, j + 100);
                    inserted += this.db.run(
                        `INSERT OR IGNORE INTO cloud_media (rel_path, size, mtime_ms, state, priority, attempts, next_try_at)
                         VALUES ${chunk.map(() => `(?, ?, ?, 'pending', ?, 0, 0)`).join(', ')}`,
                        chunk.flatMap((f) => [f.rel, f.size, f.mtimeMs, Math.max(PRIORITY_NORMAL, num(f.priority))]),
                    );
                }
            });
        }
        return { inserted, requeued };
    }

    /** rels not yet in the index (looked up in batches of 500). */
    filterUnknown(rels: string[]): string[] {
        const out: string[] = [];
        for (let i = 0; i < rels.length; i += INDEX_BATCH) {
            const batch = rels.slice(i, i + INDEX_BATCH);
            if (!batch.length) continue;
            const known = new Set(this.db.all<{ rel_path: string }>(
                `SELECT rel_path FROM cloud_media WHERE rel_path IN (${marks(batch.length)})`, batch,
            ).map((r) => r.rel_path));
            for (const rel of batch) if (!known.has(rel)) out.push(rel);
        }
        return out;
    }

    // ─── Upload queue ──────────────────────────────────────────────

    /** Files waiting to upload: higher priority first, newest first; only files last modified ≥ 10 s ago (mtime ≤ maxMtime). */
    pickPending(limit: number, now: number, maxMtime: number): MediaRow[] {
        if (!(limit > 0)) return [];
        return this.db.all<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media
             WHERE state = 'pending' AND priority >= 0 AND mtime_ms <= ? AND next_try_at <= ?
             ORDER BY priority DESC, mtime_ms DESC LIMIT ?`,
            [maxMtime, now, Math.floor(limit)],
        );
    }

    /** pending → uploading (one transaction); returns the rows it got. */
    claim(rows: MediaRow[]): MediaRow[] {
        if (!rows.length) return [];
        return this.db.transaction(() => rows.filter((r) =>
            this.db.run(`UPDATE cloud_media SET state = 'uploading' WHERE rel_path = ? AND state = 'pending'`, [r.rel_path]) > 0));
    }

    markUploaded(rel: string, v: { size: number; mtimeMs: number; sha256: string | null; etag: string | null; uploadedAt: number }): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'uploaded', size = ?, mtime_ms = ?, sha256 = ?, etag = ?, uploaded_at = ?,
                    attempts = 0, last_error = NULL, priority = 0, next_try_at = 0
             WHERE rel_path = ?`,
            [v.size, v.mtimeMs, v.sha256 ?? null, v.etag ?? null, v.uploadedAt, rel],
        );
    }

    /** uploading → pending, not counted as an error (R2 busy, workspace changed, file still being written / just changed…). */
    release(rel: string, patch: { size?: number; mtimeMs?: number; nextTryAt?: number } = {}): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'pending', size = COALESCE(?, size), mtime_ms = COALESCE(?, mtime_ms),
                    next_try_at = COALESCE(?, next_try_at)
             WHERE rel_path = ? AND state IN ('uploading', 'pending')`,
            [patch.size ?? null, patch.mtimeMs ?? null, patch.nextTryAt ?? null, rel],
        );
    }

    /** Error for this file alone: retry later (back off gradually); after MAX_FILE_ATTEMPTS times → priority -1 ("failed", retried daily). */
    markFailed(rel: string, error: string, now: number, prevAttempts: number): void {
        const attempts = num(prevAttempts) + 1;
        this.db.run(
            `UPDATE cloud_media SET state = 'pending', attempts = ?, last_error = ?, next_try_at = ?,
                    priority = CASE WHEN ? THEN ${PRIORITY_PARKED} ELSE priority END
             WHERE rel_path = ? AND state IN ('uploading', 'pending')`,
            [attempts, String(error || '').slice(0, 300), now + fileRetryDelayMs(attempts), attempts >= MAX_FILE_ATTEMPTS ? 1 : 0, rel],
        );
    }

    markMissing(rel: string, reason: string): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'missing', last_error = ?, next_try_at = 0
             WHERE rel_path = ? AND state NOT IN ('missing', 'removed')`,
            [String(reason || '').slice(0, 300), rel],
        );
    }

    /** uploaded → pending (the file on the machine changed, or the copy on R2 does not match): upload again, keep the file on the machine. */
    requeueUploaded(rel: string, patch: { size?: number; mtimeMs?: number } = {}): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'pending', size = COALESCE(?, size), mtime_ms = COALESCE(?, mtime_ms),
                    attempts = 0, last_error = NULL, next_try_at = 0, priority = 0
             WHERE rel_path = ? AND state = 'uploaded'`,
            [patch.size ?? null, patch.mtimeMs ?? null, rel],
        );
    }

    markEvicted(rel: string): void {
        this.db.run(`UPDATE cloud_media SET state = 'evicted' WHERE rel_path = ? AND state = 'uploaded'`, [rel]);
    }

    /** Downloaded from R2 (or back on the machine): uploaded + record the access time. */
    markRestored(rel: string, now: number): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'uploaded', last_access_at = ? WHERE rel_path = ? AND state IN ('evicted', 'uploaded')`,
            [now, rel],
        );
    }

    /** Leftover 'uploading' rows (app closed midway / workspace changed) → pending. */
    resetUploading(): number {
        return this.db.run(`UPDATE cloud_media SET state = 'pending' WHERE state = 'uploading'`);
    }

    /** Files that failed too many times → start over (daily / when the user clicks Continue). */
    unparkFailed(): number {
        return this.db.run(
            `UPDATE cloud_media SET priority = 0, attempts = 0, next_try_at = 0 WHERE state = 'pending' AND priority < 0`,
        );
    }

    // ─── Storage scope ───────────────────────────────────────────────────

    /** pending → excluded (outside the scope: not uploaded). Rows being uploaded / already on R2 do not change. ≤ 500 rows / transaction. */
    markExcluded(rels: string[]): number {
        return this.updateInBatches(rels, (batch) => this.db.run(
            `UPDATE cloud_media SET state = 'excluded' WHERE state = 'pending' AND rel_path IN (${marks(batch.length)})`, batch,
        ));
    }

    /** excluded → pending (the scope now includes this file again): start over. ≤ 500 rows / transaction. */
    includeExcluded(rels: string[]): number {
        return this.updateInBatches(rels, (batch) => this.db.run(
            `UPDATE cloud_media SET state = 'pending', attempts = 0, last_error = NULL, next_try_at = 0,
                    priority = MAX(priority, ${PRIORITY_NORMAL})
             WHERE state = 'excluded' AND rel_path IN (${marks(batch.length)})`, batch,
        ));
    }

    /**
     * One page of rows by rel_path (the primary key; each query reads ≤ limit rows, never scans the whole table): used to re-check the index when
     * the scope changes, and to scan files that need cleaning on R2.
     */
    pageByRel(afterRel: string, limit: number): Array<Pick<MediaRow, 'rel_path' | 'state' | 'size' | 'mtime_ms'>> {
        return this.db.all<Pick<MediaRow, 'rel_path' | 'state' | 'size' | 'mtime_ms'>>(
            'SELECT rel_path, state, size, mtime_ms FROM cloud_media WHERE rel_path > ? ORDER BY rel_path LIMIT ?',
            [afterRel || '', Math.max(1, Math.floor(limit))],
        );
    }

    /** Estimate of the row count (MAX(rowid), does not count the whole table), for the progress bar. */
    rowCountEstimate(): number {
        return num(this.db.get<{ m: unknown }>('SELECT MAX(rowid) AS m FROM cloud_media')?.m);
    }

    /** uploaded / evicted → removed (object deleted from R2 by the cleanup tool). ≤ 500 rows / transaction. */
    markRemoved(rels: string[]): number {
        return this.updateInBatches(rels, (batch) => this.db.run(
            `UPDATE cloud_media SET state = 'removed', last_error = NULL
             WHERE state IN ('uploaded', 'evicted') AND rel_path IN (${marks(batch.length)})`, batch,
        ));
    }

    private updateInBatches(rels: string[], fn: (batch: string[]) => number): number {
        let changed = 0;
        const list = Array.from(new Set(rels.filter(Boolean)));
        for (let i = 0; i < list.length; i += INDEX_BATCH) {
            const batch = list.slice(i, i + INDEX_BATCH);
            changed += this.db.transaction(() => fn(batch));
        }
        return changed;
    }

    /**
     * Media folders named by the internal Facebook id (fb_accounts.id: FacebookService stores by this id until the
     * facebook_id is known) → accounts.zalo_id (= facebook_id). No fb_accounts table → empty. Read only.
     */
    accountFolderAliases(): Map<string, string> {
        const out = new Map<string, string>();
        try {
            const rows = this.db.all<{ id: unknown; facebook_id: unknown }>(
                `SELECT id, facebook_id FROM fb_accounts WHERE facebook_id IS NOT NULL AND facebook_id != ''`,
            );
            for (const r of rows) {
                const id = String(r.id ?? '').trim();
                const fbId = String(r.facebook_id ?? '').trim();
                if (!id || !fbId || id === fbId) continue;
                out.set(id, fbId);
                if (!out.has(id.toLowerCase())) out.set(id.toLowerCase(), fbId);
            }
        } catch { /* the DB has no fb_accounts table yet */ }
        return out;
    }

    // ─── Lookup ───────────────────────────────────────────────────────

    getRow(rel: string): MediaRow | undefined {
        return this.db.get<MediaRow>(`SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path = ?`, [rel]);
    }

    /** First row matching one of the variants (NFC/NFD…). */
    findRow(variants: string[]): MediaRow | undefined {
        const list = Array.from(new Set(variants.filter(Boolean)));
        if (!list.length) return undefined;
        return this.db.get<MediaRow>(`SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path IN (${marks(list.length)}) LIMIT 1`, list);
    }

    /** Case-insensitive (ASCII), limited to the parent folder of rel (a primary-key range → never scans the whole table). */
    findRowCaseInsensitive(rel: string): MediaRow | undefined {
        const slash = rel.lastIndexOf('/');
        if (slash <= 0) return undefined;
        const dir = rel.slice(0, slash);
        return this.db.get<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path >= ? AND rel_path < ? AND lower(rel_path) = lower(?) LIMIT 1`,
            [`${dir}/`, `${dir}0`, rel],
        );
    }

    getRows(rels: string[]): Map<string, MediaRow> {
        const out = new Map<string, MediaRow>();
        for (let i = 0; i < rels.length; i += INDEX_BATCH) {
            const batch = rels.slice(i, i + INDEX_BATCH);
            if (!batch.length) continue;
            for (const row of this.db.all<MediaRow>(
                `SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path IN (${marks(batch.length)})`, batch,
            )) out.set(row.rel_path, row);
        }
        return out;
    }

    /** Candidates to clean off the machine: uploaded, older than mtimeBefore, not opened since accessBefore; oldest first (paged by cursor). */
    evictCandidates(o: { mtimeBefore: number; accessBefore: number; limit: number; after?: { mtime: number; rel: string } }): MediaRow[] {
        const after = o.after || { mtime: -1, rel: '' };
        return this.db.all<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media
             WHERE state = 'uploaded' AND mtime_ms < ? AND (last_access_at IS NULL OR last_access_at < ?)
               AND (mtime_ms > ? OR (mtime_ms = ? AND rel_path > ?))
             ORDER BY mtime_ms ASC, rel_path ASC LIMIT ?`,
            [o.mtimeBefore, o.accessBefore, after.mtime, after.mtime, after.rel, Math.floor(o.limit)],
        );
    }

    /** Rows by state, newest first (paged by cursor), used when re-uploading everything. */
    rowsByStateNewestFirst(state: MediaState, limit: number, before?: { mtime: number; rel: string }): MediaRow[] {
        const b = before || { mtime: Number.MAX_SAFE_INTEGER, rel: '' };
        return this.db.all<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media
             WHERE state = ? AND (mtime_ms < ? OR (mtime_ms = ? AND rel_path < ?))
             ORDER BY mtime_ms DESC, rel_path DESC LIMIT ?`,
            [state, b.mtime, b.mtime, b.rel, Math.floor(limit)],
        );
    }

    /**
     * Totals for the state (reads a covering index, cheap). uploaded includes evicted (both are already on R2);
     * pending includes uploading; failed = pending that failed too many times; missing, excluded (outside the storage scope) and removed (cleaned
     * from R2) are not counted: total = files in scope + files that are on R2.
     */
    totals(): MediaTotals {
        const t: MediaTotals = { ...EMPTY_TOTALS };
        const rows = this.db.all<{ state: string; n: unknown; bytes: unknown }>(
            'SELECT state, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM cloud_media GROUP BY state',
        );
        for (const r of rows) {
            if (r.state === 'missing' || r.state === 'excluded' || r.state === 'removed') continue;
            const n = num(r.n);
            const bytes = num(r.bytes);
            t.files += n;
            t.bytesTotal += bytes;
            if (r.state === 'uploaded' || r.state === 'evicted') { t.uploaded += n; t.bytesUploaded += bytes; }
            if (r.state === 'evicted') t.evicted += n;
            if (r.state === 'pending' || r.state === 'uploading') t.pending += n;
        }
        t.failed = num(this.db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM cloud_media WHERE state = 'pending' AND priority < 0`)?.n);
        t.pending = Math.max(0, t.pending - t.failed);
        return t;
    }

    // ─── Zalo media expired on the CDN (back up first) ──────────────────

    maxMessageId(): number {
        return num(this.db.get<{ m: unknown }>('SELECT MAX(id) AS m FROM messages')?.m);
    }

    /** local_paths values (strings) of messages with media_expired = 1 in the id range (afterId, toId]. */
    expiredLocalPaths(afterId: number, toId: number): string[] {
        const rows = this.db.all<{ local_paths: unknown }>(
            `SELECT local_paths FROM messages
             WHERE id > ? AND id <= ? AND media_expired = 1
               AND local_paths IS NOT NULL AND local_paths NOT IN ('', '{}', 'null', '[]')`,
            [afterId, toId],
        );
        const out: string[] = [];
        const collect = (v: unknown, depth: number) => {
            if (typeof v === 'string') { if (v) out.push(v); return; }
            if (depth > 2 || !v || typeof v !== 'object') return;
            for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) collect(x, depth + 1);
        };
        for (const r of rows) {
            if (typeof r.local_paths !== 'string') continue;
            try { collect(JSON.parse(r.local_paths), 0); } catch { /* broken JSON → ignore */ }
        }
        return out;
    }
}
