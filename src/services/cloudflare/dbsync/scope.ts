/**
 * scope: sync scope (accounts + from date) on the worker side. Table policy: tableSelection.SCOPED_TABLES.
 *
 *  - Base snapshot: filtered on the COPY that was just backed up (never on the live DB): applyScopeToCopy.
 *    secure_delete = ON (deleted cells/pages are overwritten with 0 → the filtered content is no longer in the bytes of the uploaded file), empty pages that already
 *    existed are overwritten with 0 too; rows are deleted per the policy (child tables before parent tables); the FTS of a filtered table is rebuilt with only the rows still
 *    kept (DROP the old FTS table → the content and the index of the filtered messages are both wiped clean).
 *  - Change segments: RowScope checks each row while packing (reads the live DB in the same read transaction as packSegment).
 *
 * Only import inside the dbsync folder (runs in the worker, see sqlConn.ts). CloudScope is only used as a type.
 */
import type { CloudScope } from '../../../shared/cloud/cloudContracts';
import { SqlConn, SqlStatement, quoteIdent, tableExists, toNumber } from './sqlConn';
import { ResolvedScopePolicy, pickRowidAlias, resolveScopePolicies, tableColumns } from './tableSelection';

/** Scope in the form used inside the worker. */
export interface ResolvedScope {
    /** Account ids to keep (accounts.zalo_id); null = all accounts. */
    accounts: string[] | null;
    /** Only keep history from this point (ms); null = all time. */
    fromTs: number | null;
}

/** A time value smaller than this is in SECONDS (odd data) → multiply by 1000 before comparing with fromTs (ms). */
export const SECONDS_LIMIT = 100_000_000_000;
/** Deleting at least this many rows (and ≥ 1/4 of the table) → drop the table's indexes, then recreate them (scattered deletes through 8 indexes are very slow). */
export const BULK_DELETE_ROWS = 50_000;
export const ACCOUNT_NAMES_MAX = 500;

const KEEP_TABLE = 'temp."_cloud_scope_keep"';

/**
 * The scope sent by main (already normalizeScope'd) → worker form; null = everything (no filtering).
 * An empty account list = keep no account-specific data at all (IPC already blocks it, but it is still understood correctly here).
 */
export function resolveScope(v: Partial<CloudScope> | null | undefined): ResolvedScope | null {
    if (!v || typeof v !== 'object') return null;
    const accounts = Array.isArray(v.accounts)
        ? Array.from(new Set(v.accounts.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())))
        : null;
    const fromTs = typeof v.fromTs === 'number' && Number.isFinite(v.fromTs) && v.fromTs > 0 ? Math.floor(v.fromTs) : null;
    if (!accounts && fromTs === null) return null;
    return { accounts, fromTs };
}

// ─── SQL conditions for "outside the scope" (base snapshot) ────────────────────────────────

function msExpr(c: string): string {
    return `(CASE WHEN ${c} < ${SECONDS_LIMIT} THEN ${c} * 1000 ELSE ${c} END)`;
}

/** Rows older than fromTs (history tables only). Time NULL / 0 / text → unknown → keep. */
function timeOutSql(p: ResolvedScopePolicy, fromTs: number | null): string | null {
    if (!p.time || fromTs === null) return null;
    const c = quoteIdent(p.time);
    return `(typeof(${c}) IN ('integer', 'real') AND ${c} > 0 AND ${msExpr(c)} < ${Math.floor(fromTs)})`;
}

/**
 * Rows that belong to an account that is NOT selected (empty account column → keep). Used in the WHERE of table p itself; the columns of the
 * parent table are in a subquery FROM the parent table (a column name without a prefix → matches the nearest table).
 */
function accountOutSql(p: ResolvedScopePolicy): string {
    const c = quoteIdent(p.column);
    const known = `${c} IS NOT NULL AND ${c} <> ''`;
    const notKept = `${c} NOT IN (SELECT id FROM ${KEEP_TABLE})`;
    if (p.kind === 'account') return `(${known} AND ${notKept})`;
    if (p.kind === 'fbAccount') {
        if (!p.parent || !p.parentKey) return `(${known} AND ${notKept})`;
        const pk = quoteIdent(p.parentKey);
        const keptFb = `SELECT ${pk} FROM ${quoteIdent(p.parent.table)} WHERE ${pk} IS NOT NULL AND NOT ${accountOutSql(p.parent)}`;
        return `(${known} AND ${notKept} AND ${c} NOT IN (${keptFb}))`;
    }
    const parent = p.parent as ResolvedScopePolicy;
    const pk = quoteIdent(p.parentKey as string);
    return `(${known} AND ${c} IN (SELECT ${pk} FROM ${quoteIdent(parent.table)} WHERE ${pk} IS NOT NULL AND ${accountOutSql(parent)}))`;
}

/** WHERE clause of the delete for one table (null = this table has nothing to filter for this scope). */
export function scopeDeleteWhere(p: ResolvedScopePolicy, scope: ResolvedScope): string | null {
    const parts: string[] = [];
    if (scope.accounts) parts.push(accountOutSql(p));
    const t = timeOutSql(p, scope.fromTs);
    if (t) parts.push(t);
    return parts.length ? parts.join(' OR ') : null;
}

// ─── Filter the base snapshot copy ───────────────────────────────────────────────────

export interface ScopeApplyReport {
    /** Rows removed per table. */
    removed: Record<string, number>;
    /** FTS tables rebuilt. */
    fts: string[];
    /** Empty pages already in the copy that were overwritten with 0. */
    wipedPages: number;
    /** The actual journal_mode while filtering ('off' if the connection allows it). */
    journal: string;
}

function pragmaValue(conn: SqlConn, sql: string): unknown {
    const row = conn.prepare(sql).get();
    return row ? Object.values(row)[0] : undefined;
}

/**
 * Empty pages (freelist) copied from the live DB still hold the old data (the live DB does not turn on secure_delete) → fill them all with
 * zeroblob, then drop it: every empty page becomes 0. Called when secure_delete is already ON (the original pages of the temp table are also written as 0 when dropped).
 */
function wipeFreePages(conn: SqlConn): number {
    const free = toNumber(pragmaValue(conn, 'PRAGMA freelist_count'));
    if (free <= 0) return 0;
    const pageSize = toNumber(pragmaValue(conn, 'PRAGMA page_size')) || 4096;
    conn.exec('BEGIN');
    try {
        conn.exec('CREATE TABLE "_cloud_scope_wipe" (b BLOB)');
        const ins = conn.prepare('INSERT INTO "_cloud_scope_wipe" (b) VALUES (zeroblob(?))');
        // An overflow page holds (page_size − 4) bytes; a few extra pages to be safe (the file only grows by a few zero pages).
        let left = (free + 2) * Math.max(512, pageSize - 4);
        while (left > 0) {
            const n = Math.min(left, 128 * 1024 * 1024);
            ins.run(n);
            left -= n;
        }
        conn.exec('DROP TABLE "_cloud_scope_wipe"');
        conn.exec('COMMIT');
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* cancelled */ }
        throw err;
    }
    return free;
}

function deleteRows(conn: SqlConn, table: string, where: string, bulkRows: number): number {
    const T = quoteIdent(table);
    const n = toNumber(conn.prepare(`SELECT count(*) AS n FROM ${T} WHERE ${where}`).get()?.n);
    if (n === 0) return 0;
    let indexes: Array<{ name: string; sql: string }> = [];
    if (n >= bulkRows) {
        const total = toNumber(conn.prepare(`SELECT count(*) AS n FROM ${T}`).get()?.n);
        if (n * 4 >= total) {
            indexes = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
                .all(table)
                .map((r: any) => ({ name: String(r.name), sql: String(r.sql) }));
        }
    }
    // Declared indexes (not the implicit indexes of UNIQUE/PRIMARY KEY) are dropped and recreated with the exact same statement; the old pages of
    // the index are written as 0 (secure_delete); the new index only has the keys of the rows that are kept.
    for (const ix of indexes) conn.exec(`DROP INDEX ${quoteIdent(ix.name)}`);
    const removed = toNumber(conn.prepare(`DELETE FROM ${T} WHERE ${where}`).run().changes);
    for (const ix of indexes) conn.exec(ix.sql);
    return removed;
}

/**
 * The FTS5 "<table>_fts" of a table that has a policy: keeps only the FTS rows whose rowid is still in the source table (filtered).
 * FTS keeps its own content (like messages_fts): copy the kept rows to a temp table → DROP the FTS table (the shadow tables too: content + old index,
 * written as 0) → recreate it with the exact same statement → reload. External-content FTS: 'rebuild' from the filtered source table.
 */
function rebuildScopedFts(conn: SqlConn, policies: Map<string, ResolvedScopePolicy>): string[] {
    const done: string[] = [];
    const vtabs = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all();
    for (const v of vtabs) {
        const name = String(v.name);
        const sql = String(v.sql || '');
        if (!/USING\s+fts5/i.test(sql) || !name.toLowerCase().endsWith('_fts')) continue;
        const src = policies.get(name.slice(0, -4).toLowerCase());
        if (!src) continue;
        const ft = quoteIdent(name);
        if (/content\s*=/i.test(sql)) {
            try {
                conn.exec(`INSERT INTO ${ft} (${ft}) VALUES ('rebuild')`);
                done.push(name);
            } catch { /* contentless: cannot be rebuilt, skip it */ }
            continue;
        }
        const cols = tableColumns(conn, name).insertable;
        const srcRowid = pickRowidAlias(tableColumns(conn, src.table).all);
        if (!cols.length || !srcRowid) continue;
        const kept = `SELECT ${srcRowid} FROM ${quoteIdent(src.table)}`;
        // No FTS row points to a removed message → no rebuild needed (when the FTS is large and the scope only removes a few messages, this is the costliest part).
        if (!conn.prepare(`SELECT 1 AS x FROM ${ft} WHERE rowid NOT IN (${kept}) LIMIT 1`).get()) continue;
        const list = cols.map(quoteIdent).join(', ');
        conn.exec('DROP TABLE IF EXISTS temp."_cloud_scope_fts"');
        conn.exec(`CREATE TEMP TABLE "_cloud_scope_fts" AS SELECT rowid AS "_cloud_rid", ${list} FROM ${ft} WHERE rowid IN (${kept})`);
        conn.exec(`DROP TABLE ${ft}`);
        conn.exec(sql);
        conn.exec(`INSERT INTO ${ft} (rowid, ${list}) SELECT "_cloud_rid", ${list} FROM temp."_cloud_scope_fts" ORDER BY "_cloud_rid"`);
        conn.exec('DROP TABLE temp."_cloud_scope_fts"');
        done.push(name);
    }
    return done;
}

/**
 * Filters the COPY of the base snapshot by scope (called in the worker, on the temp file, NOT the live DB). If the file breaks midway then
 * the whole copy is discarded (the 'snapshot' op deletes the file on error), so no transaction log is needed.
 *
 * Triggers are removed during filtering and then recreated exactly as they were: no FTS trigger runs per row (slow, and it leaves traces in the index)
 * and nothing is written to _cloud_dirty for millions of removed rows. foreign_keys = OFF: only the policy decides what is deleted
 * (no cascade into shared tables, no foreign-key error when a parent row is deleted).
 */
export function applyScopeToCopy(conn: SqlConn, scope: ResolvedScope | null, opts: { bulkDeleteRows?: number } = {}): ScopeApplyReport {
    const report: ScopeApplyReport = { removed: {}, fts: [], wipedPages: 0, journal: '' };
    if (!scope) return report;
    const bulkRows = Math.max(1, Math.floor(opts.bulkDeleteRows ?? BULK_DELETE_ROWS));
    conn.exec('PRAGMA journal_mode = DELETE'); // out of WAL (the backup of a WAL DB): merge -wal into the file
    // OFF is skipped when the connection is in defensive mode (keeps 'delete', which is still correct, just uses more space for the journal file).
    report.journal = String(pragmaValue(conn, 'PRAGMA journal_mode = OFF') ?? '').toLowerCase();
    conn.exec('PRAGMA synchronous = OFF');
    conn.exec('PRAGMA foreign_keys = OFF');
    conn.exec('PRAGMA temp_store = FILE');
    conn.exec('PRAGMA cache_size = -65536');
    conn.exec('PRAGMA secure_delete = ON');
    report.wipedPages = wipeFreePages(conn);

    const policies = resolveScopePolicies(conn);
    const ordered = [...policies.values()].sort((a, b) => b.depth - a.depth || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
    const triggers = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY rowid")
        .all()
        .map((r: any) => ({ name: String(r.name), sql: String(r.sql) }));
    conn.exec('BEGIN');
    try {
        for (const t of triggers) conn.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(t.name)}`);
        if (scope.accounts) {
            conn.exec('CREATE TEMP TABLE IF NOT EXISTS "_cloud_scope_keep" (id TEXT NOT NULL PRIMARY KEY) WITHOUT ROWID');
            conn.exec(`DELETE FROM ${KEEP_TABLE}`);
            const ins = conn.prepare(`INSERT OR IGNORE INTO ${KEEP_TABLE} (id) VALUES (?)`);
            for (const id of scope.accounts) ins.run(id);
        }
        // Child tables before parent tables: the child's condition reads the parent row (not deleted yet) to find its owner.
        for (const p of ordered) {
            const where = scopeDeleteWhere(p, scope);
            if (!where) continue;
            const n = deleteRows(conn, p.table, where, bulkRows);
            if (n > 0) report.removed[p.table] = n;
        }
        report.fts = rebuildScopedFts(conn, policies);
        for (const t of triggers) conn.exec(t.sql);
        if (scope.accounts) conn.exec(`DROP TABLE IF EXISTS ${KEEP_TABLE}`);
        conn.exec('COMMIT');
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* cancelled / journal OFF */ }
        throw err;
    }
    return report;
}

/** Accounts in the DB (after filtering): written to the manifest so the restore screen shows the names. */
export function readAccountNames(conn: SqlConn): Array<{ id: string; name: string; channel: string }> {
    if (!tableExists(conn, 'accounts')) return [];
    const cols = new Set(tableColumns(conn, 'accounts').all.map(c => c.toLowerCase()));
    if (!cols.has('zalo_id')) return [];
    const name = cols.has('full_name') ? 'full_name' : "''";
    const channel = cols.has('channel') ? 'channel' : "''";
    return conn.prepare(`SELECT zalo_id AS id, ${name} AS name, ${channel} AS channel FROM accounts `
        + `WHERE zalo_id IS NOT NULL AND zalo_id <> '' ORDER BY zalo_id LIMIT ${ACCOUNT_NAMES_MAX}`)
        .all()
        .map((r: any) => ({
            id: String(r.id),
            name: String(r.name ?? '').slice(0, 200),
            channel: String(r.channel || 'zalo').slice(0, 40),
        }));
}

// ─── Per-row filter when packing change segments ────────────────────────────────────

/** Account column value → id string; null = empty (shared data → keep). A BLOB is never a selected id. */
function idOf(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v === '' ? null : v;
    if (typeof v === 'bigint' || typeof v === 'number') return String(v);
    return '\u0000blob';
}

function isBefore(v: unknown, fromTs: number): boolean {
    let n: number;
    if (typeof v === 'bigint') n = Number(v);
    else if (typeof v === 'number') n = v;
    else return false;
    if (!(n > 0)) return false;
    return (n < SECONDS_LIMIT ? n * 1000 : n) < fromTs;
}

/**
 * Checks a row against the scope while packing a segment (same rules as scopeDeleteWhere). Parent rows / fb_accounts are read from the live DB in the
 * same read transaction, and the result is remembered for one pack.
 */
export class RowScope {
    private readonly keep: Set<string> | null;
    private readonly fromTs: number | null;
    private readonly policies: Map<string, ResolvedScopePolicy>;
    private readonly noReuse = new Set<string>();
    private readonly stmts = new Map<string, SqlStatement>();
    private readonly cache = new Map<string, boolean>();

    constructor(private readonly conn: SqlConn, scope: ResolvedScope) {
        this.keep = scope.accounts ? new Set(scope.accounts) : null;
        this.fromTs = scope.fromTs;
        this.policies = resolveScopePolicies(conn);
        try {
            for (const r of conn.prepare('SELECT name FROM sqlite_sequence').all()) this.noReuse.add(String(r.name).toLowerCase());
        } catch { /* no AUTOINCREMENT table */ }
    }

    /** Is the row (read in bigInts mode, column names as declared) in scope? A table with no policy → always in scope. */
    inScope(table: string, row: Record<string, unknown>): boolean {
        const p = this.policies.get(table.toLowerCase());
        if (!p) return true;
        if (this.keep && !this.accountIn(p, row[p.column])) return false;
        if (p.time && this.fromTs !== null && isBefore(row[p.time], this.fromTs)) return false;
        return true;
    }

    /**
     * AUTOINCREMENT table (listed in sqlite_sequence): a rowid is never issued again → a row outside the scope has never
     * been in the copy, so it can be skipped entirely. Other tables: a rowid can be reused → a delete command must be sent (see Segment.packSegment).
     */
    neverReusesRowids(table: string): boolean {
        return this.noReuse.has(table.toLowerCase());
    }

    /** value = the value of column `p.column` in the row. */
    private accountIn(p: ResolvedScopePolicy, value: unknown): boolean {
        const keep = this.keep;
        if (!keep) return true;
        const id = idOf(value);
        if (id === null) return true;
        if (p.kind === 'account') return keep.has(id);
        if (p.kind === 'fbAccount') {
            if (keep.has(id)) return true; // Old-style Facebook: the column holds the account id directly
            if (!p.parent || !p.parentKey) return false;
        }
        const parent = p.parent as ResolvedScopePolicy;
        const cacheKey = `${p.table}\u0000${id}`;
        const hit = this.cache.get(cacheKey);
        if (hit !== undefined) return hit;
        const found = this.lookup(parent, p.parentKey as string, value);
        // fbAccount: no matching fb_accounts row → an unknown id, cannot be selected. parent: no parent row left → owner unknown → keep.
        const res = found === undefined ? p.kind === 'parent' : this.accountIn(parent, found);
        this.cache.set(cacheKey, res);
        return res;
    }

    /** The account/key column values of the parent row; undefined = no parent row. */
    private lookup(parent: ResolvedScopePolicy, key: string, value: unknown): unknown {
        const sql = `SELECT ${quoteIdent(parent.column)} AS v FROM ${quoteIdent(parent.table)} WHERE ${quoteIdent(key)} = ? LIMIT 1`;
        let st = this.stmts.get(sql);
        if (!st) {
            st = this.conn.prepare(sql, { bigInts: true });
            this.stmts.set(sql, st);
        }
        const row = st.get(value as any);
        return row ? (row.v ?? null) : undefined;
    }
}
