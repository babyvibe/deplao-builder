/**
 * scope — phạm vi đồng bộ (tài khoản + từ ngày) phía worker. Chính sách bảng: tableSelection.SCOPED_TABLES.
 *
 *  - Bản gốc: lọc trên BẢN SAO vừa backup (không bao giờ trên DB sống) — applyScopeToCopy.
 *    secure_delete = ON (ô/trang bị xoá ghi đè 0 → nội dung đã lọc không còn trong byte file tải lên), trang trống có sẵn
 *    từ trước cũng ghi đè 0; xoá theo chính sách (bảng con trước bảng cha); FTS của bảng bị lọc dựng lại chỉ với dòng còn
 *    giữ (DROP bảng FTS cũ → cả nội dung lẫn chỉ mục của tin đã lọc bị xoá trắng).
 *  - Đoạn thay đổi: RowScope kiểm từng dòng khi gói (đọc DB sống trong cùng giao dịch đọc của packSegment).
 *
 * Chỉ import trong thư mục dbsync (chạy trong worker — xem sqlConn.ts). CloudScope chỉ dùng làm kiểu.
 */
import type { CloudScope } from '../../../shared/cloud/cloudContracts';
import { SqlConn, SqlStatement, quoteIdent, tableExists, toNumber } from './sqlConn';
import { ResolvedScopePolicy, pickRowidAlias, resolveScopePolicies, tableColumns } from './tableSelection';

/** Phạm vi dạng dùng trong worker. */
export interface ResolvedScope {
    /** id tài khoản được giữ (accounts.zalo_id); null = mọi tài khoản. */
    accounts: string[] | null;
    /** Chỉ giữ lịch sử từ mốc này (ms); null = toàn bộ thời gian. */
    fromTs: number | null;
}

/** Giá trị thời gian nhỏ hơn mốc này là GIÂY (dữ liệu lạ) — nhân 1000 trước khi so với fromTs (ms). */
export const SECONDS_LIMIT = 100_000_000_000;
/** Xoá ≥ ngần này dòng (và ≥ 1/4 bảng) → gỡ chỉ mục của bảng rồi tạo lại (xoá rải rác qua 8 chỉ mục rất chậm). */
export const BULK_DELETE_ROWS = 50_000;
export const ACCOUNT_NAMES_MAX = 500;

const KEEP_TABLE = 'temp."_cloud_scope_keep"';

/**
 * Phạm vi do main gửi (đã normalizeScope) → dạng worker; null = toàn bộ (không lọc gì).
 * Danh sách tài khoản rỗng = không giữ dữ liệu riêng của tài khoản nào (IPC đã chặn, ở đây vẫn hiểu đúng nghĩa).
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

// ─── Điều kiện SQL "ngoài phạm vi" (bản gốc) ────────────────────────────────

function msExpr(c: string): string {
    return `(CASE WHEN ${c} < ${SECONDS_LIMIT} THEN ${c} * 1000 ELSE ${c} END)`;
}

/** Dòng cũ hơn fromTs (chỉ bảng lịch sử). Thời gian NULL / 0 / dạng chữ → không rõ → giữ. */
function timeOutSql(p: ResolvedScopePolicy, fromTs: number | null): string | null {
    if (!p.time || fromTs === null) return null;
    const c = quoteIdent(p.time);
    return `(typeof(${c}) IN ('integer', 'real') AND ${c} > 0 AND ${msExpr(c)} < ${Math.floor(fromTs)})`;
}

/**
 * Dòng thuộc tài khoản KHÔNG được chọn (cột tài khoản rỗng → giữ). Dùng trong WHERE của chính bảng p; cột của bảng
 * cha nằm trong truy vấn con FROM bảng cha (tên cột không đầu tố → khớp bảng gần nhất).
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

/** WHERE của lệnh xoá cho một bảng (null = bảng này không có gì để lọc với phạm vi này). */
export function scopeDeleteWhere(p: ResolvedScopePolicy, scope: ResolvedScope): string | null {
    const parts: string[] = [];
    if (scope.accounts) parts.push(accountOutSql(p));
    const t = timeOutSql(p, scope.fromTs);
    if (t) parts.push(t);
    return parts.length ? parts.join(' OR ') : null;
}

// ─── Lọc bản sao chụp gốc ───────────────────────────────────────────────────

export interface ScopeApplyReport {
    /** Số dòng đã bỏ theo bảng. */
    removed: Record<string, number>;
    /** Bảng FTS đã dựng lại. */
    fts: string[];
    /** Trang trống có sẵn trong bản sao đã ghi đè 0. */
    wipedPages: number;
    /** journal_mode thực tế lúc lọc ('off' nếu connection cho phép). */
    journal: string;
}

function pragmaValue(conn: SqlConn, sql: string): unknown {
    const row = conn.prepare(sql).get();
    return row ? Object.values(row)[0] : undefined;
}

/**
 * Trang trống (freelist) chép từ DB sống còn nguyên dữ liệu cũ (DB sống không bật secure_delete) → chiếm hết bằng
 * zeroblob rồi bỏ: mọi trang trống thành 0. Gọi khi secure_delete đã ON (trang gốc của bảng tạm cũng được ghi 0 khi bỏ).
 */
function wipeFreePages(conn: SqlConn): number {
    const free = toNumber(pragmaValue(conn, 'PRAGMA freelist_count'));
    if (free <= 0) return 0;
    const pageSize = toNumber(pragmaValue(conn, 'PRAGMA page_size')) || 4096;
    conn.exec('BEGIN');
    try {
        conn.exec('CREATE TABLE "_cloud_scope_wipe" (b BLOB)');
        const ins = conn.prepare('INSERT INTO "_cloud_scope_wipe" (b) VALUES (zeroblob(?))');
        // Trang tràn chứa (page_size − 4) byte; dư vài trang cho chắc (file chỉ dài thêm vài trang 0).
        let left = (free + 2) * Math.max(512, pageSize - 4);
        while (left > 0) {
            const n = Math.min(left, 128 * 1024 * 1024);
            ins.run(n);
            left -= n;
        }
        conn.exec('DROP TABLE "_cloud_scope_wipe"');
        conn.exec('COMMIT');
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* đã huỷ */ }
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
    // Chỉ mục khai báo (không phải chỉ mục ngầm của UNIQUE/PRIMARY KEY) gỡ rồi tạo lại bằng đúng câu lệnh cũ — trang cũ của
    // chỉ mục được ghi 0 (secure_delete), chỉ mục mới chỉ có khoá của dòng còn giữ.
    for (const ix of indexes) conn.exec(`DROP INDEX ${quoteIdent(ix.name)}`);
    const removed = toNumber(conn.prepare(`DELETE FROM ${T} WHERE ${where}`).run().changes);
    for (const ix of indexes) conn.exec(ix.sql);
    return removed;
}

/**
 * FTS5 "<bảng>_fts" của bảng có chính sách: chỉ giữ dòng FTS có rowid còn trong bảng nguồn (đã lọc).
 * FTS tự giữ nội dung (như messages_fts): chép dòng giữ lại ra bảng tạm → DROP bảng FTS (cả bảng bóng: nội dung + chỉ mục
 * cũ, ghi 0) → tạo lại bằng đúng câu lệnh cũ → nạp lại. FTS nội dung ngoài: 'rebuild' từ bảng nguồn đã lọc.
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
            } catch { /* contentless: không dựng lại được — bỏ qua */ }
            continue;
        }
        const cols = tableColumns(conn, name).insertable;
        const srcRowid = pickRowidAlias(tableColumns(conn, src.table).all);
        if (!cols.length || !srcRowid) continue;
        const kept = `SELECT ${srcRowid} FROM ${quoteIdent(src.table)}`;
        // Không dòng FTS nào trỏ tới tin đã bỏ → khỏi dựng lại (FTS lớn mà phạm vi chỉ bỏ ít tin thì đây là phần tốn nhất).
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
 * Lọc BẢN SAO chụp gốc theo phạm vi (gọi trong worker, trên file tạm — KHÔNG phải DB sống). File hỏng giữa chừng thì
 * cả bản sao bị bỏ (ops 'snapshot' xoá file khi lỗi) nên không cần nhật ký giao dịch.
 *
 * Trigger bị gỡ trong lúc lọc rồi tạo lại y nguyên: không chạy trigger FTS từng dòng (chậm, để lại dấu trong chỉ mục)
 * và không ghi _cloud_dirty cho hàng triệu dòng bị bỏ. foreign_keys = OFF: chỉ chính sách quyết định xoá gì
 * (không xoá dây chuyền sang bảng chung, không lỗi khoá ngoại khi xoá dòng cha).
 */
export function applyScopeToCopy(conn: SqlConn, scope: ResolvedScope | null, opts: { bulkDeleteRows?: number } = {}): ScopeApplyReport {
    const report: ScopeApplyReport = { removed: {}, fts: [], wipedPages: 0, journal: '' };
    if (!scope) return report;
    const bulkRows = Math.max(1, Math.floor(opts.bulkDeleteRows ?? BULK_DELETE_ROWS));
    conn.exec('PRAGMA journal_mode = DELETE'); // ra khỏi WAL (bản backup của DB WAL) — gộp -wal vào file
    // OFF bị bỏ qua khi connection ở chế độ defensive (giữ 'delete' — vẫn đúng, chỉ tốn chỗ cho file journal).
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
        // Bảng con trước bảng cha: điều kiện của bảng con đọc dòng cha (chưa bị xoá) để biết chủ.
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
        try { conn.exec('ROLLBACK'); } catch { /* đã huỷ / journal OFF */ }
        throw err;
    }
    return report;
}

/** Tài khoản có trong DB (sau khi lọc) — ghi vào manifest để màn khôi phục hiện tên. */
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

// ─── Lọc từng dòng khi gói đoạn thay đổi ────────────────────────────────────

/** Giá trị cột tài khoản → chuỗi id; null = rỗng (dữ liệu chung → giữ). BLOB không bao giờ là id được chọn. */
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
 * Kiểm dòng theo phạm vi khi gói đoạn (cùng quy tắc với scopeDeleteWhere). Dòng cha / fb_accounts đọc từ DB sống trong
 * cùng giao dịch đọc, nhớ kết quả trong một lần gói.
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
        } catch { /* không có bảng AUTOINCREMENT */ }
    }

    /** Dòng (đọc ở chế độ bigInts, tên cột như khai báo) thuộc phạm vi? Bảng không có chính sách → luôn thuộc. */
    inScope(table: string, row: Record<string, unknown>): boolean {
        const p = this.policies.get(table.toLowerCase());
        if (!p) return true;
        if (this.keep && !this.accountIn(p, row[p.column])) return false;
        if (p.time && this.fromTs !== null && isBefore(row[p.time], this.fromTs)) return false;
        return true;
    }

    /**
     * Bảng AUTOINCREMENT (có trong sqlite_sequence): rowid không bao giờ được cấp lại → dòng ngoài phạm vi chưa từng có
     * trong bản sao, bỏ qua hẳn được. Bảng khác: rowid có thể được dùng lại → phải gửi lệnh xoá (xem Segment.packSegment).
     */
    neverReusesRowids(table: string): boolean {
        return this.noReuse.has(table.toLowerCase());
    }

    /** value = giá trị cột `p.column` của dòng. */
    private accountIn(p: ResolvedScopePolicy, value: unknown): boolean {
        const keep = this.keep;
        if (!keep) return true;
        const id = idOf(value);
        if (id === null) return true;
        if (p.kind === 'account') return keep.has(id);
        if (p.kind === 'fbAccount') {
            if (keep.has(id)) return true; // Facebook kiểu cũ: cột chứa thẳng id tài khoản
            if (!p.parent || !p.parentKey) return false;
        }
        const parent = p.parent as ResolvedScopePolicy;
        const cacheKey = `${p.table}\u0000${id}`;
        const hit = this.cache.get(cacheKey);
        if (hit !== undefined) return hit;
        const found = this.lookup(parent, p.parentKey as string, value);
        // fbAccount: không có fb_accounts tương ứng → id lạ, không được chọn. parent: không còn dòng cha → không biết chủ → giữ.
        const res = found === undefined ? p.kind === 'parent' : this.accountIn(parent, found);
        this.cache.set(cacheKey, res);
        return res;
    }

    /** Giá trị cột tài khoản/khoá của dòng cha; undefined = không có dòng cha. */
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
