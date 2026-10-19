/**
 * DirtyTracker — ghi nhận dòng nào đã đổi kể từ lần đẩy trước, bằng trigger trong chính DB workspace.
 *
 *   _cloud_dirty(id AUTOINCREMENT, tbl, rid, UNIQUE(tbl, rid))
 *   _cloud_meta(key, value)            — db_uid (ngẫu nhiên, tạo một lần) + fingerprint lúc cài trigger
 *   _cloud_t_<bảng>_{i,u,d}            — AFTER INSERT/UPDATE/DELETE: xoá dòng cũ của (bảng, rowid) rồi chèn lại
 *                                        → chạm lại một dòng = id mới lớn hơn (đoạn đang đẩy không "nuốt" mất thay đổi mới).
 *
 * Trigger chạy cho MỌI connection ghi vào DB (app có nhiều connection). Dùng DELETE + INSERT (không INSERT OR REPLACE)
 * vì trong trigger, chính sách xung đột của câu lệnh ngoài (vd INSERT OR IGNORE của app) sẽ thay chính sách của câu
 * bên trong — OR REPLACE có thể bị biến thành IGNORE và giữ id cũ.
 * UPDATE đổi chính rowid (hiếm) → ghi cả rowid cũ (để bản sao xoá nó) lẫn rowid mới.
 *
 *   _cloud_t_<bảng>_c (BEFORE INSERT, chỉ bảng có khoá UNIQUE): INSERT OR REPLACE của app gỡ dòng trùng khoá mà KHÔNG
 *   chạy trigger DELETE (recursive_triggers tắt) → nếu dòng mới bị xoá trước lần đẩy, bản sao giữ mãi dòng cũ ("dòng
 *   ma": workflow đã xoá, tin đã bỏ ghim… hiện lại sau khi khôi phục). Trigger này đánh dấu trước các dòng trùng khoá.
 *   Bỏ qua bảng messages (app chỉ INSERT OR IGNORE, rất nhiều bản trùng — đánh dấu chỉ làm gửi lại dòng không đổi).
 *
 * Mọi trigger được biên dịch thử (prepare INSERT/UPDATE/DELETE) trong cùng giao dịch cài đặt — lỗi → huỷ, không bao giờ
 * để lại trigger làm hỏng lệnh ghi của app.
 */
import { randomUUID } from 'crypto';
import { SqlConn, quoteIdent, quoteLiteral, tableExists, toNumber, writeTx } from './sqlConn';
import { TableSelection, TrackedTable, schemaFingerprint, selectTables } from './tableSelection';

export const DIRTY_TABLE = '_cloud_dirty';
export const META_TABLE = '_cloud_meta';
export const TRIGGER_PREFIX = '_cloud_t_';
/** app_settings: mã workspace = tiền tố khoá R2 (module media dùng chung khoá này). */
export const WORKSPACE_UID_KEY = 'cloud_workspace_uid';
/** Không gắn trigger đánh dấu xung đột (xem đầu file). */
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

/** Khoá UNIQUE (kể cả PRIMARY KEY không phải rowid) chỉ gồm cột thường, không phải index một phần. */
export function uniqueKeys(conn: SqlConn, table: string): UniqueKey[] {
    const out: UniqueKey[] = [];
    const list = conn.prepare(`SELECT name, "unique" AS u, partial FROM pragma_index_list(${quoteLiteral(table)})`).all();
    for (const ix of list) {
        if (Number(ix.u) !== 1 || Number(ix.partial) === 1) continue;
        const cols = conn.prepare(`SELECT cid, name, coll, key FROM pragma_index_xinfo(${quoteLiteral(String(ix.name))})`)
            .all()
            .filter((c: any) => Number(c.key) === 1);
        // Khoá theo biểu thức (cid = -2) / rowid → bỏ qua
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
            // Dòng khác (rowid khác dòng sắp chèn) trùng khoá → sẽ bị REPLACE gỡ âm thầm → đánh dấu trước.
            const match = `FROM ${T} WHERE ${cond} AND ${r} IS NOT NEW.${r}`;
            parts.push(`DELETE FROM _cloud_dirty WHERE tbl = ${L} AND rid IN (SELECT ${r} ${match});`);
            parts.push(`INSERT INTO _cloud_dirty (tbl, rid) SELECT ${L}, ${r} ${match};`);
        }
        out.push(`CREATE TRIGGER ${quoteIdent(conflictTriggerName(t.name))} BEFORE INSERT ON ${T} BEGIN ${parts.join(' ')} END`);
    }
    return out;
}

/** Biên dịch thử lệnh ghi của bảng (biên dịch luôn chương trình trigger) — trigger lỗi thì ném ngay, chưa COMMIT. */
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

/** Giá trị AUTOINCREMENT hiện tại của _cloud_dirty (id lớn nhất từng cấp, kể cả dòng đã xoá). */
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
    /** app_settings.cloud_workspace_uid (null: DB không có bảng app_settings). */
    workspaceUid: string | null;
    included: string[];
    unsupported: string[];
    /** Lần đầu cài trên DB này (chưa có _cloud_dirty). */
    created: boolean;
    /** Có bảng được theo dõi mà trước đó thiếu trigger → thay đổi cũ có thể đã lọt → cần chụp gốc mới. */
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

/** Đọc (tạo nếu create và chưa có) app_settings.cloud_workspace_uid — INSERT OR IGNORE, dùng chung với module media. */
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
 * Bảo đảm bảng/trigger theo dõi khớp schema hiện tại. Chỉ lấy khoá ghi khi thật sự cần (lần đầu, sau migration,
 * bảng mới, đổi tên bảng) — gọi được ở mỗi nhịp đồng bộ.
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
            // Đọc lại trong giao dịch ghi: schema có thể vừa đổi giữa hai lần đọc.
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
                // Lệnh ghi của app phải còn biên dịch được với trigger mới; không → ROLLBACK (writeTx) + ném lỗi.
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

/** Gỡ hết trigger + bảng theo dõi (tắt đồng bộ / bản sao khôi phục). Bảng cloud_sync_log giữ nguyên. */
export function dropTracking(conn: SqlConn): { triggers: number; tables: number } {
    const triggers = listTrackingTriggers(conn);
    const tables = [DIRTY_TABLE, META_TABLE].filter(t => tableExists(conn, t));
    if (!triggers.length && !tables.length) return { triggers: 0, tables: 0 };
    writeTx(conn, () => {
        // Trigger trước, bảng sau, cùng một giao dịch — trigger còn mà _cloud_dirty mất sẽ làm mọi lệnh ghi của app lỗi.
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

/** Rẻ (một lần dò chỉ mục) — vòng theo dõi realtime gọi mỗi 2 s. */
export function hasDirtyRows(conn: SqlConn): boolean {
    try {
        return !!conn.prepare('SELECT 1 AS x FROM _cloud_dirty LIMIT 1').get();
    } catch {
        return false;
    }
}

/** Xoá các dòng đã đẩy (id ≤ upToId). Dòng bị chạm lại trong lúc đẩy đã có id mới > upToId nên còn nguyên. */
export function ackDirty(conn: SqlConn, upToId: number): number {
    if (!(upToId > 0) || !tableExists(conn, DIRTY_TABLE)) return 0;
    return toNumber(conn.prepare('DELETE FROM _cloud_dirty WHERE id <= ?').run(upToId).changes);
}
