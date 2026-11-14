/**
 * tableSelection: which tables of the workspace DB are tracked for changes (trigger → _cloud_dirty → changed segments).
 *
 * Default: ALL regular tables except the list below. Excluded tables are still in the base snapshot (the base snapshot copies all pages),
 * they just get no per-segment updates → after a restore, excluded tables hold the data as of the time the base snapshot was taken.
 *
 * Notes for whoever edits the list:
 *  - Changing the list = changing the schema fingerprint → the machine takes a new base snapshot by itself at the next sync.
 *  - WITHOUT ROWID tables cannot be tracked (the trigger writes the rowid) → reported as "unsupported" in the log, but still in the base snapshot.
 */
import { createHash } from 'crypto';
import { SqlConn, canonicalTableName, quoteLiteral } from './sqlConn';

/** Sync format version: bump it when the way segments are packed / applied changes, so every machine takes a new base snapshot. */
export const DBSYNC_FORMAT_VERSION = 1;

/** Excluded by exact name (case-insensitive match). */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
    // This module's own sync log (every push writes one row → would trigger another sync endlessly).
    'cloud_sync_log',
    // Public API: event queue + webhook deliveries; they change constantly and only matter on the machine that is running.
    'api_events',
    'webhook_deliveries',
    // Zalo sticker cache (can be downloaded again from Zalo at any time).
    'stickers',
    'sticker_packs',
    'keyword_stickers',
    'recent_stickers',
]);

export type TableExclusionReason = 'internal' | 'module' | 'fts' | 'fb_scan' | 'listed' | 'virtual' | 'view';

/** Reason a table is excluded by name (null = not excluded by name). */
export function exclusionByName(name: string): TableExclusionReason | null {
    const n = String(name).toLowerCase();
    if (n.startsWith('sqlite_')) return 'internal';                    // sqlite_sequence, sqlite_stat1…
    if (n.startsWith('_cloud_')) return 'module';                      // _cloud_dirty, _cloud_meta
    if (n.endsWith('_fts') || n.includes('_fts_')) return 'fts';       // messages_fts + its shadow tables messages_fts_data…
    if (n.startsWith('fb_scan_')) return 'fb_scan';                    // Facebook scanner tool: temporary log / cache
    if (EXCLUDED_TABLES.has(n)) return 'listed';
    return null;
}

export type RowidAlias = 'rowid' | '_rowid_' | 'oid';
const ROWID_ALIASES: RowidAlias[] = ['rowid', '_rowid_', 'oid'];

export interface TrackedTable {
    /** Name exactly as in sqlite_master. */
    name: string;
    /** Regular columns (GENERATED columns are skipped, since they cannot be INSERTed). In declaration order. */
    columns: string[];
    /** Name used to refer to the real rowid (the first one that does not clash with any column name). */
    rowidAlias: RowidAlias;
}

export interface TableSelection {
    included: TrackedTable[];
    /** Key: the lowercase name. */
    byName: Map<string, TrackedTable>;
    /** Cannot be tracked (WITHOUT ROWID, or every rowid name clashes with a column). */
    unsupported: string[];
    excluded: Array<{ name: string; reason: TableExclusionReason }>;
}

interface ListedTable {
    name: string;
    type: string;           // 'table' | 'virtual' | 'shadow' | 'view'
    withoutRowid: boolean;
}

function listTables(conn: SqlConn): ListedTable[] {
    try {
        // SQLite ≥ 3.37: tells virtual tables / shadow tables (FTS) / WITHOUT ROWID apart already.
        const rows = conn.prepare("SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main'").all();
        return rows.map((r: any) => ({ name: String(r.name), type: String(r.type), withoutRowid: Number(r.wr) === 1 }));
    } catch {
        const rows = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
        return rows.map((r: any) => {
            const sql = String(r.sql || '');
            return {
                name: String(r.name),
                type: /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql) ? 'virtual' : 'table',
                withoutRowid: /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(sql),
            };
        });
    }
}

export function tableColumns(conn: SqlConn, table: string): { all: string[]; insertable: string[] } {
    const rows = conn.prepare(`SELECT name, hidden FROM pragma_table_xinfo(${quoteLiteral(table)})`).all();
    const all: string[] = [];
    const insertable: string[] = [];
    for (const r of rows) {
        const name = String(r.name);
        all.push(name);
        // hidden: 0 = regular column, 1 = hidden column of a virtual table, 2/3 = GENERATED column (VIRTUAL/STORED)
        if (Number(r.hidden) === 0) insertable.push(name);
    }
    return { all, insertable };
}

export function pickRowidAlias(allColumns: string[]): RowidAlias | null {
    const used = new Set(allColumns.map(c => c.toLowerCase()));
    for (const a of ROWID_ALIASES) if (!used.has(a)) return a;
    return null;
}

/** Describes one regular table (also used when applying segments to the copy). null when it is missing or cannot be tracked. */
export function describeTable(conn: SqlConn, name: string): TrackedTable | null {
    const cols = tableColumns(conn, name);
    if (!cols.all.length) return null;
    const alias = pickRowidAlias(cols.all);
    if (!alias) return null;
    return { name, columns: cols.insertable, rowidAlias: alias };
}

export function selectTables(conn: SqlConn): TableSelection {
    const included: TrackedTable[] = [];
    const unsupported: string[] = [];
    const excluded: Array<{ name: string; reason: TableExclusionReason }> = [];
    for (const t of listTables(conn)) {
        if (t.type === 'view') continue;
        const byName = exclusionByName(t.name);
        if (byName) { excluded.push({ name: t.name, reason: byName }); continue; }
        if (t.type === 'virtual' || t.type === 'shadow') { excluded.push({ name: t.name, reason: 'virtual' }); continue; }
        if (t.type !== 'table') continue;
        if (t.withoutRowid) { unsupported.push(t.name); continue; }
        const info = describeTable(conn, t.name);
        if (!info) { unsupported.push(t.name); continue; }
        included.push(info);
    }
    included.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    unsupported.sort();
    const byName = new Map<string, TrackedTable>();
    for (const t of included) byName.set(t.name.toLowerCase(), t);
    return { included, byName, unsupported, excluded };
}

/**
 * Schema fingerprint: CREATE TABLE (sqlite_master.sql) of the tracked tables + the format version.
 * Changing it (an app update that adds a column / table, renames a table, or changes the exclusion list) → reinstall the triggers + take a new base snapshot.
 */
export function schemaFingerprint(conn: SqlConn, sel: TableSelection): string {
    const rows = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
    const sqlByName = new Map<string, string>();
    for (const r of rows) sqlByName.set(String(r.name).toLowerCase(), String(r.sql || ''));
    const h = createHash('sha256');
    h.update(`deplao-dbsync-v${DBSYNC_FORMAT_VERSION}\n`);
    for (const t of sel.included) {
        h.update(t.name);
        h.update('\u0000');
        h.update(sqlByName.get(t.name.toLowerCase()) || '');
        h.update('\n');
    }
    return h.digest('hex').slice(0, 24);
}

// ─── Sync scope (accounts + from date) ──────────────────────────────────

/**
 * How a table says which account owns a row:
 *  - 'account'  : a column holding accounts.zalo_id (the shared id of every channel: Zalo uid, Facebook uid, Telegram user/bot id).
 *  - 'fbAccount': a column holding fb_accounts.id (UUID) → account = fb_accounts.facebook_id. If there is no matching fb_accounts row,
 *                 the value itself is treated as accounts.zalo_id (old Facebook data used the UUID as the id).
 *  - 'parent'   : a child table with no account column: a column holding the key of the parent row, scoped by the parent row
 *                 (no parent row left → owner unknown → keep).
 * Rows whose account column is NULL / '' (data shared by the table) are always kept.
 */
export type ScopeAccountRef =
    | { kind: 'account'; column: string }
    | { kind: 'fbAccount'; column: string }
    | { kind: 'parent'; column: string; parent: string; parentKey: string };

export interface ScopedTablePolicy {
    table: string;
    account: ScopeAccountRef;
    /** History table: the time column (ms) used to apply "từ ngày" (from date). Without one = keep all rows of the selected account. */
    time?: string;
}

/** Bump when SCOPED_TABLES changes → machines using a scoped sync take a new base snapshot under the new rules. */
export const SCOPE_POLICY_VERSION = 1;

const own = (table: string, time?: string): ScopedTablePolicy => ({ table, account: { kind: 'account', column: 'owner_zalo_id' }, time });
const byAccount = (table: string, column: string, time?: string): ScopedTablePolicy => ({ table, account: { kind: 'account', column }, time });
const byFbAccount = (table: string, column: string, time?: string): ScopedTablePolicy => ({ table, account: { kind: 'fbAccount', column }, time });
const childOf = (table: string, column: string, parent: string, parentKey = 'id'): ScopedTablePolicy => ({ table, account: { kind: 'parent', column, parent, parentKey } });

/**
 * SCOPE POLICY: every table that holds per-account data, in ONE place (both the base snapshot and the segment changes read from here).
 * A table NOT in the list = shared data (app_settings, workflows, employees, erp_*, integrations, AI assistant, stickers,
 * proxy, plugins, cloud_media…) → always fully synced.
 *
 * !!! Adding a new table with per-account data (a column owner_zalo_id / zalo_id / account_id…) or a child table of a table
 * below → it MUST be added to this list (and SCOPE_POLICY_VERSION bumped). Forgetting it = a scoped copy would still carry the data
 * of unselected accounts up to R2.
 *
 * `time` is only set for message-history tables (messages, pins, links, send logs…, unit ms); contacts / groups / peers / settings of the
 * selected account are always kept in full. Tables / columns missing from the DB (old versions) → that policy row is skipped (treated as shared data).
 * Checked against a real 2.6 GB DB (10/2026): every time column below is in ms.
 */
export const SCOPED_TABLES: ReadonlyArray<ScopedTablePolicy> = [
    // ── Theo owner_zalo_id ──
    own('bank_cards'),
    own('contacts'),
    own('crm_campaign_contacts'),
    own('crm_campaigns'),
    own('crm_contact_tags'),
    own('crm_notes'),
    own('crm_send_log', 'sent_at'),
    own('crm_tags'),
    own('friend_requests'),
    own('friends'),
    own('links', 'timestamp'),
    own('local_label_threads'),
    own('local_pinned_conversations'),
    own('local_quick_messages'),
    own('media_library_folders'),
    own('media_library_items'),
    own('message_drafts'),
    own('messages', 'timestamp'),
    own('page_group_member'),
    own('pinned_messages', 'timestamp'),
    own('starred_messages'),
    own('telegram_channel_pts'),
    own('telegram_channel_recovery_queue'),
    own('telegram_peers'),
    own('telegram_update_state'),
    own('tg_bot_projects'),
    own('uid_aliases'),
    own('zalo_plain_id_map'),
    // ── Theo zalo_id ──
    byAccount('accounts', 'zalo_id'),
    byAccount('ai_account_assistants', 'zalo_id'),
    byAccount('ai_conversations', 'zalo_id'),
    byAccount('employee_account_access', 'zalo_id'),
    byAccount('employee_message_log', 'zalo_id', 'timestamp'),
    // Public API: event queue (payloads contain message content): not tracked per segment, but included in the base snapshot.
    byAccount('api_events', 'account_id', 'created_at'),
    // ── Facebook: fb_accounts.facebook_id = accounts.zalo_id; the other tables point to fb_accounts.id ──
    byAccount('fb_accounts', 'facebook_id'),
    byFbAccount('fb_threads', 'account_id'),
    byFbAccount('fb_messages', 'account_id', 'timestamp'),
    byFbAccount('fb_crm_contacts', 'fb_account_id'),
    byFbAccount('fb_scan_history', 'account_id'),
    byFbAccount('fb_scan_tabs', 'account_id'),
    // ── Child tables with no account column → follow the parent row ──
    childOf('ai_conversation_messages', 'conversation_id', 'ai_conversations'),
    childOf('tg_bot_rules', 'project_id', 'tg_bot_projects'),
    childOf('tg_bot_rule_logs', 'project_id', 'tg_bot_projects'),
    childOf('tg_bot_schedule', 'project_id', 'tg_bot_projects'),
    childOf('fb_scan_tab_data', 'tab_id', 'fb_scan_tabs'),
    childOf('fb_scan_tab_requests', 'tab_id', 'fb_scan_tabs'),
    childOf('webhook_deliveries', 'event_seq', 'api_events', 'seq'),
];

/** Policy checked against the schema of ONE DB (table / column names exactly as declared). */
export interface ResolvedScopePolicy {
    table: string;
    kind: ScopeAccountRef['kind'];
    /** Account column ('account' / 'fbAccount') or parent-key column ('parent'). */
    column: string;
    time: string | null;
    /** 'parent': the parent table's policy; 'fbAccount': the fb_accounts policy (null = the DB has no fb_accounts). */
    parent: ResolvedScopePolicy | null;
    /** Key column of the parent table that `column` points to. */
    parentKey: string | null;
    /** Number of levels up to the root table; delete the deepest table first (child tables before parent tables). */
    depth: number;
}

function findColumn(columns: string[], name: string): string | null {
    const n = name.toLowerCase();
    return columns.find(c => c.toLowerCase() === n) ?? null;
}

/** Policies that apply to this DB. Key: lowercase table name. Tables / columns that are missing are left out of the result. */
export function resolveScopePolicies(conn: SqlConn): Map<string, ResolvedScopePolicy> {
    const byName = new Map(SCOPED_TABLES.map(p => [p.table.toLowerCase(), p] as const));
    const done = new Map<string, ResolvedScopePolicy | null>();
    const resolve = (name: string, stack: Set<string>): ResolvedScopePolicy | null => {
        const key = name.toLowerCase();
        if (done.has(key)) return done.get(key) ?? null;
        const p = byName.get(key);
        const actual = p && !stack.has(key) ? canonicalTableName(conn, p.table) : null;
        if (!p || !actual) {
            done.set(key, null);
            return null;
        }
        stack.add(key);
        let out: ResolvedScopePolicy | null = null;
        const cols = tableColumns(conn, actual).all;
        const column = findColumn(cols, p.account.column);
        const time = p.time ? findColumn(cols, p.time) : null;
        if (column) {
            const ref = p.account;
            if (ref.kind === 'account') {
                out = { table: actual, kind: 'account', column, time, parent: null, parentKey: null, depth: 0 };
            } else if (ref.kind === 'fbAccount') {
                const fb = resolve('fb_accounts', stack);
                const fbKey = fb ? findColumn(tableColumns(conn, fb.table).all, 'id') : null;
                out = fb && fbKey
                    ? { table: actual, kind: 'fbAccount', column, time, parent: fb, parentKey: fbKey, depth: fb.depth + 1 }
                    : { table: actual, kind: 'fbAccount', column, time, parent: null, parentKey: null, depth: 0 };
            } else {
                const par = resolve(ref.parent, stack);
                const pk = par ? findColumn(tableColumns(conn, par.table).all, ref.parentKey) : null;
                // No parent table / parent policy → owner unknown → treated as shared data.
                if (par && pk) out = { table: actual, kind: 'parent', column, time, parent: par, parentKey: pk, depth: par.depth + 1 };
            }
        }
        stack.delete(key);
        done.set(key, out);
        return out;
    };
    const result = new Map<string, ResolvedScopePolicy>();
    for (const p of SCOPED_TABLES) {
        const r = resolve(p.table, new Set());
        if (r) result.set(p.table.toLowerCase(), r);
    }
    return result;
}
