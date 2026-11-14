/**
 * Snapshot: the base snapshot of the workspace DB.
 *
 *  1. SQLite backup API to a temp file (copies the pages as they are → keeps rowids; do NOT use VACUUM INTO, because it can renumber
 *     the rowids of tables without an INTEGER PRIMARY KEY, so the later change segments would apply to the wrong rows).
 *  2. On the COPY: read the mark H = largest id in _cloud_dirty, delete all of _cloud_dirty, filter by the sync scope if any
 *     (scope.applyScopeToCopy: accounts + from date, secure_delete), count the rows of each table, switch the journal to DELETE
 *     (the file is self-contained, no -wal).
 *  3. Gzip compression (stream). Encryption + upload are done in main (async).
 *  After the base snapshot is on R2 and the manifest points to it: the live DB deletes the dirty rows with id ≤ H (they are already in the base snapshot).
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { CloudScope } from '../../../shared/cloud/cloudContracts';
import { getMeta } from './DirtyTracker';
import { ScopeApplyReport, applyScopeToCopy, readAccountNames, resolveScope } from './scope';
import { SqlConn, quoteIdent, tableExists, toNumber } from './sqlConn';
import { schemaFingerprint, selectTables } from './tableSelection';

export interface SnapshotInfo {
    highWater: number;
    /** Row count per table AFTER filtering by the scope. */
    rowCounts: Record<string, number>;
    fingerprint: string;
    dbUid: string | null;
    included: string[];
    unsupported: string[];
    /** Accounts still in the copy (id = accounts.zalo_id). */
    accountNames: Array<{ id: string; name: string; channel: string }>;
    /** Result of the scope filter (null = everything, no filtering). */
    scopeReport: ScopeApplyReport | null;
}

/** Call on the copy that was just backed up (NOT the live DB). scope: sync scope (missing / null = everything). */
export function prepareSnapshotCopy(copy: SqlConn, opts: { scope?: Partial<CloudScope> | null } = {}): SnapshotInfo {
    const sel = selectTables(copy);
    const fingerprint = schemaFingerprint(copy, sel);
    let highWater = 0;
    if (tableExists(copy, '_cloud_dirty')) {
        const row = copy.prepare('SELECT coalesce(max(id), 0) AS h FROM _cloud_dirty').get();
        highWater = toNumber(row?.h);
        try {
            const seq = copy.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_cloud_dirty'").get();
            highWater = Math.max(highWater, toNumber(seq?.seq));
        } catch { /* no sqlite_sequence */ }
        copy.exec('DELETE FROM _cloud_dirty');
    }
    const dbUid = getMeta(copy, 'db_uid');
    const scope = resolveScope(opts.scope);
    const scopeReport = scope ? applyScopeToCopy(copy, scope) : null;
    const rowCounts: Record<string, number> = {};
    for (const t of sel.included) {
        rowCounts[t.name] = toNumber(copy.prepare(`SELECT count(*) AS n FROM ${quoteIdent(t.name)}`).get()?.n);
    }
    const accountNames = readAccountNames(copy);
    copy.exec('PRAGMA journal_mode = DELETE');
    return {
        highWater, rowCounts, fingerprint, dbUid, included: sel.included.map(t => t.name), unsupported: sel.unsupported,
        accountNames, scopeReport,
    };
}

/**
 * Stream gzip compression. onProgress(bytes read, total bytes) is called at most 2 times per second + once when done. shouldStop() returning true
 * (the machine is about to sleep / has just woken up while the base snapshot is being taken) → stop at the next block and throw an error.
 */
export async function gzipFile(
    src: string, dst: string, level = 6, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean,
): Promise<number> {
    const total = onProgress ? (await fs.promises.stat(src)).size : 0;
    let done = 0;
    let last = 0;
    const report = (force: boolean) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - last < 500) return;
        last = now;
        try { onProgress(done, total); } catch { /* a failing callback must not break the compression */ }
    };
    const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            if (shouldStop?.()) {
                cb(new Error('Đã dừng nén'));
                return;
            }
            done += chunk.length;
            report(false);
            cb(null, chunk);
        },
    });
    await pipeline(fs.createReadStream(src), counter, zlib.createGzip({ level }), fs.createWriteStream(dst));
    report(true);
    return (await fs.promises.stat(dst)).size;
}

export async function gunzipFile(src: string, dst: string): Promise<number> {
    await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dst));
    return (await fs.promises.stat(dst)).size;
}

export async function removeQuietly(...files: string[]): Promise<void> {
    for (const f of files) {
        if (!f) continue;
        try { await fs.promises.rm(f, { force: true }); } catch { /* ignore */ }
    }
}
