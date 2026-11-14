/**
 * DirtyTracker: records which rows have changed since the last push, using triggers inside the workspace DB itself.
 *
 *   _cloud_dirty(id AUTOINCREMENT, tbl, rid, UNIQUE(tbl, rid))
 *   _cloud_meta(key, value)            : db_uid (random, created once) + fingerprint at the time the triggers were installed
 *   _cloud_t_<table>_{i,u,d}           - AFTER INSERT/UPDATE/DELETE: delete the old row for (table, rowid), then insert it again
 *                                        → touching a row again = a larger new id (the part being pushed does not "swallow" new changes).
 *
 * Triggers run for EVERY connection that writes to the DB (the app has several connections). Uses DELETE + INSERT (not INSERT OR REPLACE)
 * because inside a trigger, the conflict policy of the outer statement (e.g. the app's INSERT OR IGNORE) would replace the policy of the
 * inner one: OR REPLACE could turn into IGNORE and keep the old id.
 * UPDATE changes the rowid itself (rare) → record both the old rowid (so the copy deletes it) and the new rowid.
 *
 *   _cloud_t_<table>_c (BEFORE INSERT, only for tables with a UNIQUE key): the app's INSERT OR REPLACE removes a row with the same key WITHOUT
 *   running the DELETE trigger (recursive_triggers is off) → if the new row is deleted before the next push, the copy keeps the old row forever (a "ghost
 *   row": a deleted workflow, an unpinned message… reappears after a restore). This trigger marks the rows with the same key beforehand.
 *   Skipped for the messages table (the app only does INSERT OR IGNORE and there are many duplicates; marking would only resend unchanged rows).
 *
 * Every trigger is test-compiled (prepare INSERT/UPDATE/DELETE) in the same install transaction: on error → rollback, never
 * leaves a trigger that breaks the app's write statements.
 */
import { randomUUID } from 'crypto';
import { SqlConn, quoteIdent, quoteLiteral, tableExists, toNumber, writeTx } from './sqlConn';
import { TableSelection, TrackedTable, schemaFingerprint, selectTables } from './tableSelection';

export const DIRTY_TABLE = '_cloud_dirty';
export const META_TABLE = '_cloud_meta';
export const TRIGGER_PREFIX = '_cloud_t_';
/** app_settings: the workspace id = the R2 key prefix (the media module shares this key). */
export const WORKSPACE_UID_KEY = 'cloud_workspace_uid';
/** Do not attach the conflict-marking trigger (see the top of the file). */
export const NO_CONFLICT_TRIGGER: ReadonlySet<string> = new Set(['messages']);

const CREATE_DIRTY_SQL =
    'CREATE TABLE IF NOT EXISTS _cloud_dirty (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, rid INTEGER NOT NULL, UNIQUE(tbl, rid))';
const CREATE_META_SQL = 'CREATE TABLE IF NOT EXISTS _cloud_meta (key TEXT PRIMARY KEY, value TEXT)';

export function triggerNames(table: string): [string, string, string] {
    return [`${TRIGGER_PREFIX}${table}_i`, `${TRIGGER_PREFIX}${table}_u`, `${TRIGGER_PREFIX}${table}_d`];
}

export function conflictTriggerName(table: string): string {
    return `${TRIGGER_PREFIX}${table}_c`;
}

export interface UniqueKey {
    columns: Array<{ name: string; coll: string | null }>;
}

/** UNIQUE keys (including a PRIMARY KEY that is not the rowid) only cover normal columns, not a partial index. */
export function uniqueKeys(conn: SqlConn, table: string): UniqueKey[] {
    const out: UniqueKey[] = [];
    const list = conn.prepare(`SELECT name, "unique" AS u, partial FROM pragma_index_list(${quoteLiteral(table)})`).all();
    for (const ix of list) {
        if (Number(ix.u) !== 1 || Number(ix.partial) === 1) continue;
        const cols = conn.prepare(`SELECT cid, name, coll, key FROM pragma_index_xinfo(${quoteLiteral(String(ix.name))})`)
            .all()
            .filter((c: any) => Number(c.key) === 1);
        // Keys based on an expression (cid = -2) / rowid → skip
        if (!cols.length || cols.some((c: any) => Number(c.cid) < 0 || c.name === null || c.name === undefined)) continue;
        out.push({ columns: cols.map((c: any) => ({ name: String(c.name), coll: c.coll ? String(c.coll) : null })) });
    }
    return out;
}

export interface TriggerPlan {
    table: TrackedTable;
    keys: UniqueKey[];
}

export function planTriggers(conn: SqlConn, sel: TableSelection): TriggerPlan[] {
    return sel.included.map(t => ({
        table: t,
        keys: NO_CONFLICT_TRIGGER.has(t.name.toLowerCase()) ? [] : uniqueKeys(conn, t.name),
    }));
}

export function plannedTriggerNames(plan: TriggerPlan): string[] {
    const names: string[] = triggerNames(plan.table.name);
    if (plan.keys.length) names.push(conflictTriggerName(plan.table.name));
    return names;
}

export function triggerStatements(t: TrackedTable, keys: UniqueKey[] = []): string[] {
    const T = quoteIdent(t.name);
    const L = quoteLiteral(t.name);
    const r = t.rowidAlias;
    const [ni, nu, nd] = triggerNames(t.name).map(quoteIdent);
    const mark = (ref: string) =>
        `DELETE FROM _cloud_dirty WHERE tbl = ${L} AND rid = ${ref}; INSERT INTO _cloud_dirty (tbl, rid) VALUES (${L}, ${ref});`;
    const out = [
        `CREATE TRIGGER ${ni} AFTER INSERT ON ${T} BEGIN ${mark(`NEW.${r}`)} END`,
        `CREATE TRIGGER ${nu} AFTER UPDATE ON ${T} BEGIN `
            + `DELETE FROM _cloud_dirty WHERE tbl = ${L} AND rid = OLD.${r} AND OLD.${r} IS NOT NEW.${r}; `
            + `INSERT INTO _cloud_dirty (tbl, rid) SELECT ${L}, OLD.${r} WHERE OLD.${r} IS NOT NEW.${r}; `
            + `${mark(`NEW.${r}`)} END`,
        `CREATE TRIGGER ${nd} AFTER DELETE ON ${T} BEGIN ${mark(`OLD.${r}`)} END`,
    ];
    if (keys.length) {
        const parts: string[] = [];
        for (const k of keys) {
            const cond = k.columns
                .map(c => {
                    const coll = c.coll && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.coll) && c.coll.toUpperCase() !== 'BINARY' ? ` COLLATE ${c.coll}` : '';
                    return `${quoteIdent(c.name)} = NEW.${quoteIdent(c.name)}${coll}`;
                })
                .join(' AND ');
            // Another row (a different rowid from the row about to be inserted) with the same key → REPLACE would silently remove it → mark it first.
            const match = `FROM ${T} WHERE ${cond} AND ${r} IS NOT NEW.${r}`;
            parts.push(`DELETE FROM _cloud_dirty WHERE tbl = ${L} AND rid IN (SELECT ${r} ${match});`);
            parts.push(`INSERT INTO _cloud_dirty (tbl, rid) SELECT ${L}, ${r} ${match};`);
        }
        out.push(`CREATE TRIGGER ${quoteIdent(conflictTriggerName(t.name))} BEFORE INSERT ON ${T} BEGIN ${parts.join(' ')} END`);
    }
    return out;
}

/** Test-compile the table's write statements (this also compiles the trigger program); if a trigger fails, throw right away, before COMMIT. */
function compileCheck(conn: SqlConn, t: TrackedTable): void {
    const T = quoteIdent(t.name);
    conn.prepare(`INSERT INTO ${T} DEFAULT VALUES`);
    if (t.columns.length) {
        const c = quoteIdent(t.columns[0]);
        conn.prepare(`UPDATE ${T} SET ${c} = ${c} WHERE 0`);
    }
    conn.prepare(`DELETE FROM ${T} WHERE 0`);
}

export function listTrackingTriggers(conn: SqlConn): string[] {
    return conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, 9) = '_cloud_t_'")
        .all()
        .map((r: any) => String(r.name));
}

export function getMeta(conn: SqlConn, key: string): string | null {
    if (!tableExists(conn, META_TABLE)) return null;
    const row = conn.prepare('SELECT value FROM _cloud_meta WHERE key = ?').get(key);
    return row && row.value !== null && row.value !== undefined ? String(row.value) : null;
}

function setMeta(conn: SqlConn, key: string, value: string): void {
    conn.prepare('INSERT INTO _cloud_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Current AUTOINCREMENT value of _cloud_dirty (the largest id ever issued, including deleted rows). */
export function dirtySeq(conn: SqlConn): number {
    try {
        const row = conn.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_cloud_dirty'").get();
        return row ? toNumber(row.seq) : 0;
    } catch {
        return 0;
    }
}

export interface TrackingInfo {
    dbUid: string;
    fingerprint: string;
    /** app_settings.cloud_workspace_uid (null: the DB has no app_settings table). */
    workspaceUid: string | null;
    included: string[];
    unsupported: string[];
    /** First install on this DB (no _cloud_dirty yet). */
    created: boolean;
    /** A tracked table was missing its triggers before → older changes may have slipped through → a new base snapshot is needed. */
    reinstalled: boolean;
    dirtySeq: number;
}

interface TrackingState {
    hasDirty: boolean;
    existingTriggers: string[];
    missingTriggers: number;
    triggersOk: boolean;
    dbUid: string | null;
    needsWrite: boolean;
}

function readTrackingState(conn: SqlConn, plans: TriggerPlan[], fingerprint: string): TrackingState {
    const hasDirty = tableExists(conn, DIRTY_TABLE);
    const hasMeta = tableExists(conn, META_TABLE);
    const existingTriggers = listTrackingTriggers(conn);
    const expected = new Set<string>();
    for (const p of plans) for (const n of plannedTriggerNames(p)) expected.add(n);
    const existing = new Set(existingTriggers);
    let missingTriggers = 0;
    for (const n of expected) if (!existing.has(n)) missingTriggers++;
    const extra = existingTriggers.filter(n => !expected.has(n)).length;
    const metaFp = hasMeta ? getMeta(conn, 'fingerprint') : null;
    const dbUid = hasMeta ? getMeta(conn, 'db_uid') : null;
    const triggersOk = hasDirty && missingTriggers === 0 && extra === 0 && metaFp === fingerprint;
    return {
        hasDirty,
        existingTriggers,
        missingTriggers,
        triggersOk,
        dbUid,
        needsWrite: !hasDirty || !hasMeta || !triggersOk || !dbUid,
    };
}

/** Read app_settings.cloud_workspace_uid (created if create is set and it does not exist yet) with INSERT OR IGNORE; shared with the media module. */
export function ensureWorkspaceUid(conn: SqlConn, create: boolean): string | null {
    if (!tableExists(conn, 'app_settings')) return null;
    const read = (): string | null => {
        const row = conn.prepare('SELECT value FROM app_settings WHERE key = ?').get(WORKSPACE_UID_KEY);
        const v = row && row.value !== null && row.value !== undefined ? String(row.value).trim() : '';
        return v || null;
    };
    const current = read();
    if (current || !create) return current;
    const uid = randomUUID();
    conn.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(WORKSPACE_UID_KEY, uid);
    conn.prepare("UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = ? AND trim(coalesce(value, '')) = ''")
        .run(uid, WORKSPACE_UID_KEY);
    return read();
}

/**
 * Makes sure the tracking table / triggers match the current schema. Only takes the write lock when really needed (first time, after a migration,
 * a new table, a renamed table). Can be called on every sync tick.
 */
export function ensureTracking(conn: SqlConn, opts: { createWorkspaceUid?: boolean } = {}): TrackingInfo {
    let sel = selectTables(conn);
    let fingerprint = schemaFingerprint(conn, sel);
    let plans = planTriggers(conn, sel);
    let state = readTrackingState(conn, plans, fingerprint);
    let created = false;
    let reinstalled = false;
    if (state.needsWrite) {
        writeTx(conn, () => {
            // Read again inside the write transaction: the schema may have changed between the two reads.
            sel = selectTables(conn);
            fingerprint = schemaFingerprint(conn, sel);
            plans = planTriggers(conn, sel);
            state = readTrackingState(conn, plans, fingerprint);
            created = !state.hasDirty;
            conn.exec(CREATE_DIRTY_SQL);
            conn.exec(CREATE_META_SQL);
            if (!state.triggersOk) {
                for (const name of state.existingTriggers) conn.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
                for (const p of plans) for (const sql of triggerStatements(p.table, p.keys)) conn.exec(sql);
                // The app's write statements must still compile with the new triggers; if not → ROLLBACK (writeTx) + throw an error.
                for (const p of plans) compileCheck(conn, p.table);
                reinstalled = state.missingTriggers > 0;
            }
            if (!state.dbUid) setMeta(conn, 'db_uid', randomUUID());
            setMeta(conn, 'fingerprint', fingerprint);
        });
    }
    const dbUid = getMeta(conn, 'db_uid') as string;
    const workspaceUid = ensureWorkspaceUid(conn, opts.createWorkspaceUid !== false);
    return {
        dbUid,
        fingerprint,
        workspaceUid,
        included: sel.included.map(t => t.name),
        unsupported: sel.unsupported,
        created,
        reinstalled: reinstalled || created,
        dirtySeq: dirtySeq(conn),
    };
}

/** Remove all triggers + tracking tables (sync turned off / restored copy). The cloud_sync_log table is kept. */
export function dropTracking(conn: SqlConn): { triggers: number; tables: number } {
    const triggers = listTrackingTriggers(conn);
    const tables = [DIRTY_TABLE, META_TABLE].filter(t => tableExists(conn, t));
    if (!triggers.length && !tables.length) return { triggers: 0, tables: 0 };
    writeTx(conn, () => {
        // Triggers first, then the table, in the same transaction: if a trigger remains but _cloud_dirty is gone, every write of the app fails.
        for (const name of listTrackingTriggers(conn)) conn.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
        conn.exec('DROP TABLE IF EXISTS _cloud_dirty');
        conn.exec('DROP TABLE IF EXISTS _cloud_meta');
    });
    return { triggers: triggers.length, tables: tables.length };
}

export function hasTracking(conn: SqlConn): boolean {
    return listTrackingTriggers(conn).length > 0 || tableExists(conn, DIRTY_TABLE);
}

export interface DirtyStats {
    count: number;
    minId: number;
    maxId: number;
}

export function dirtyStats(conn: SqlConn): DirtyStats {
    if (!tableExists(conn, DIRTY_TABLE)) return { count: 0, minId: 0, maxId: 0 };
    const row = conn.prepare('SELECT count(*) AS n, coalesce(min(id), 0) AS lo, coalesce(max(id), 0) AS hi FROM _cloud_dirty').get();
    return { count: toNumber(row?.n), minId: toNumber(row?.lo), maxId: toNumber(row?.hi) };
}

/** Cheap (one index probe); the realtime watch loop calls it every 2 s. */
export function hasDirtyRows(conn: SqlConn): boolean {
    try {
        return !!conn.prepare('SELECT 1 AS x FROM _cloud_dirty LIMIT 1').get();
    } catch {
        return false;
    }
}

/** Delete the pushed rows (id ≤ upToId). A row touched again during the push already has a new id > upToId, so it stays. */
export function ackDirty(conn: SqlConn, upToId: number): number {
    if (!(upToId > 0) || !tableExists(conn, DIRTY_TABLE)) return 0;
    return toNumber(conn.prepare('DELETE FROM _cloud_dirty WHERE id <= ?').run(upToId).changes);
}
