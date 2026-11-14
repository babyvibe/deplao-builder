/**
 * restoreDb: operations on the COPY FILE (restore / standby machine): prepares the connection that applies segments, rebuilds FTS,
 * checks integrity + row counts.
 */
import { dropTracking } from './DirtyTracker';
import { SqlConn, quoteIdent, tableExists, toNumber } from './sqlConn';
import { tableColumns } from './tableSelection';

/**
 * - foreign_keys = OFF: the parent/child order within a segment is arbitrary; only the final state has to be consistent.
 * - recursive_triggers = ON: a row removed by INSERT OR REPLACE still runs the app's DELETE trigger (messages_fts_ad…).
 */
export function prepareApplyConnection(conn: SqlConn): void {
    conn.exec('PRAGMA foreign_keys = OFF');
    conn.exec('PRAGMA recursive_triggers = ON');
}

/** The copy does not need to write _cloud_dirty when applying segments: remove the trigger/tracking tables (the base snapshot captured them too). */
export function prepareRestoreCopy(conn: SqlConn): void {
    dropTracking(conn);
    prepareApplyConnection(conn);
}

export interface FtsRebuildReport {
    rebuilt: string[];
    repopulated: string[];
    warnings: string[];
}

/**
 * The app's FTS5 (messages_fts) is a normal FTS table (it keeps its own content), synced by triggers on messages.
 * - A table "<x>_fts" whose source table "<x>" has all the FTS columns: row count mismatch → reload everything from the source table by rowid
 *   (the base snapshot from the source machine may already be out of sync: the app's INSERT OR REPLACE removes rows without running the DELETE trigger).
 * - Otherwise: the FTS5 'rebuild' command (contentless tables do not support it → skipped, a warning is logged).
 */
export function rebuildFts(conn: SqlConn): FtsRebuildReport {
    const report: FtsRebuildReport = { rebuilt: [], repopulated: [], warnings: [] };
    const vtabs = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all();
    for (const v of vtabs) {
        const name = String(v.name);
        if (!/USING\s+fts5/i.test(String(v.sql || ''))) continue;
        const ft = quoteIdent(name);
        try {
            const sourceName = name.toLowerCase().endsWith('_fts') ? name.slice(0, -4) : '';
            if (sourceName && tableExists(conn, sourceName) && !/content\s*=/i.test(String(v.sql || ''))) {
                // The declared FTS columns (skip the hidden columns: table name, rank)
                const ftsCols = tableColumns(conn, name).insertable;
                const srcCols = new Set(tableColumns(conn, sourceName).all.map(c => c.toLowerCase()));
                if (ftsCols.length && ftsCols.every(c => srcCols.has(c.toLowerCase()))) {
                    const nFts = toNumber(conn.prepare(`SELECT count(*) AS n FROM ${ft}`).get()?.n);
                    const nSrc = toNumber(conn.prepare(`SELECT count(*) AS n FROM ${quoteIdent(sourceName)}`).get()?.n);
                    if (nFts !== nSrc) {
                        const cols = ftsCols.map(quoteIdent).join(', ');
                        conn.exec('BEGIN');
                        try {
                            conn.exec(`DELETE FROM ${ft}`);
                            conn.exec(`INSERT INTO ${ft} (rowid, ${cols}) SELECT rowid, ${cols} FROM ${quoteIdent(sourceName)}`);
                            conn.exec('COMMIT');
                        } catch (err) {
                            try { conn.exec('ROLLBACK'); } catch { /* cancelled */ }
                            throw err;
                        }
                        report.repopulated.push(name);
                        continue;
                    }
                }
            }
            conn.exec(`INSERT INTO ${ft} (${ft}) VALUES ('rebuild')`);
            report.rebuilt.push(name);
        } catch (err: any) {
            report.warnings.push(`${name}: ${err?.message || err}`);
        }
    }
    return report;
}

export interface VerifyExpectation {
    /** Row counts when the base snapshot was taken (manifest.rowCounts). */
    rowCounts?: Record<string, number> | null;
    /** Total records applied per table (upsert + delete) since the base snapshot: the allowed deviation. */
    touched?: Record<string, number> | null;
}

export interface VerifyResult {
    integrityOk: boolean;
    integrity: string[];
    counts: Record<string, number>;
    mismatches: Array<{ table: string; expected: number; actual: number; tolerance: number }>;
}

/**
 * PRAGMA integrity_check + compare row counts with the manifest. The manifest's row counts are from the time of the base snapshot (recounting after every segment is too costly
 * in realtime mode) → a table that no segment touched must match exactly; a touched table may differ by ≤ the number of records applied.
 */
export function verifyRestoredDb(conn: SqlConn, expect: VerifyExpectation = {}): VerifyResult {
    const integrity = conn.prepare('PRAGMA integrity_check').all().map((r: any) => String(Object.values(r)[0]));
    const integrityOk = integrity.length === 1 && integrity[0] === 'ok';
    const counts: Record<string, number> = {};
    const mismatches: VerifyResult['mismatches'] = [];
    for (const [table, expected] of Object.entries(expect.rowCounts || {})) {
        if (!tableExists(conn, table)) {
            mismatches.push({ table, expected, actual: -1, tolerance: 0 });
            continue;
        }
        const actual = toNumber(conn.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get()?.n);
        counts[table] = actual;
        const tolerance = Math.max(0, toNumber(expect.touched?.[table]));
        if (Math.abs(actual - expected) > tolerance) mismatches.push({ table, expected, actual, tolerance });
    }
    return { integrityOk, integrity: integrity.slice(0, 10), counts, mismatches };
}

/** A DB that is "trống" (empty, not used yet): no accounts, no messages, no contacts → the restore can overwrite it. */
export function isEffectivelyEmpty(conn: SqlConn): boolean {
    for (const t of ['accounts', 'fb_accounts', 'messages', 'fb_messages', 'contacts', 'workflows', 'crm_campaigns']) {
        if (!tableExists(conn, t)) continue;
        if (conn.prepare(`SELECT 1 AS x FROM ${quoteIdent(t)} LIMIT 1`).get()) return false;
    }
    return true;
}
