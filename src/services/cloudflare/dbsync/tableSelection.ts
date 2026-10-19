/**
 * tableSelection — bảng nào của DB workspace được theo dõi thay đổi (trigger → _cloud_dirty → đoạn thay đổi).
 *
 * Mặc định: MỌI bảng thường, trừ danh sách dưới đây. Bảng bị loại vẫn nằm trong bản gốc (bản gốc chép nguyên trang),
 * chỉ không có cập nhật theo đoạn → sau khi khôi phục, bảng bị loại mang dữ liệu tại thời điểm chụp gốc.
 *
 * Ghi chú cho người sửa danh sách:
 *  - Đổi danh sách = đổi dấu vân tay schema (fingerprint) → máy tự chụp gốc mới ở lần đồng bộ sau.
 *  - Bảng WITHOUT ROWID không theo dõi được (trigger ghi rowid) → báo "unsupported" trong log, vẫn có trong bản gốc.
 */
import { createHash } from 'crypto';
import { SqlConn, canonicalTableName, quoteLiteral } from './sqlConn';

/** Phiên bản định dạng đồng bộ — tăng khi đổi cách gói/áp đoạn để mọi máy tự chụp gốc mới. */
export const DBSYNC_FORMAT_VERSION = 1;

/** Loại theo tên chính xác (so khớp chữ thường). */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
    // Nhật ký đồng bộ của chính module này (mỗi lần đẩy ghi một dòng → tự kích hoạt đồng bộ vô tận).
    'cloud_sync_log',
    // Public API: hàng đợi sự kiện + lượt gửi webhook — đổi liên tục, chỉ có ý nghĩa trên máy đang chạy.
    'api_events',
    'webhook_deliveries',
    // Cache sticker Zalo (tải lại được từ Zalo bất cứ lúc nào).
    'stickers',
    'sticker_packs',
    'keyword_stickers',
    'recent_stickers',
]);

export type TableExclusionReason = 'internal' | 'module' | 'fts' | 'fb_scan' | 'listed' | 'virtual' | 'view';

/** Lý do loại một bảng theo tên (null = không loại theo tên). */
export function exclusionByName(name: string): TableExclusionReason | null {
    const n = String(name).toLowerCase();
    if (n.startsWith('sqlite_')) return 'internal';                    // sqlite_sequence, sqlite_stat1…
    if (n.startsWith('_cloud_')) return 'module';                      // _cloud_dirty, _cloud_meta
    if (n.endsWith('_fts') || n.includes('_fts_')) return 'fts';       // messages_fts + bảng bóng messages_fts_data…
    if (n.startsWith('fb_scan_')) return 'fb_scan';                    // công cụ quét Facebook: log/cache tạm
    if (EXCLUDED_TABLES.has(n)) return 'listed';
    return null;
}

export type RowidAlias = 'rowid' | '_rowid_' | 'oid';
const ROWID_ALIASES: RowidAlias[] = ['rowid', '_rowid_', 'oid'];

export interface TrackedTable {
    /** Tên đúng như sqlite_master. */
    name: string;
    /** Cột thường (bỏ cột sinh tự động GENERATED — không INSERT được). Thứ tự như khai báo. */
    columns: string[];
    /** Tên dùng để chỉ rowid thật (cái đầu tiên không trùng tên cột nào). */
    rowidAlias: RowidAlias;
}

export interface TableSelection {
    included: TrackedTable[];
    /** Khoá: tên chữ thường. */
    byName: Map<string, TrackedTable>;
    /** Không theo dõi được (WITHOUT ROWID / mọi tên rowid đều trùng cột). */
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
        // SQLite ≥ 3.37: phân biệt sẵn bảng ảo / bảng bóng (FTS) / WITHOUT ROWID.
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
        // hidden: 0 = cột thường, 1 = cột ẩn của bảng ảo, 2/3 = cột GENERATED (VIRTUAL/STORED)
        if (Number(r.hidden) === 0) insertable.push(name);
    }
    return { all, insertable };
}

export function pickRowidAlias(allColumns: string[]): RowidAlias | null {
    const used = new Set(allColumns.map(c => c.toLowerCase()));
    for (const a of ROWID_ALIASES) if (!used.has(a)) return a;
    return null;
}

/** Mô tả một bảng thường (dùng cả khi áp đoạn lên bản sao). null khi không có / không theo dõi được. */
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
 * Dấu vân tay schema: CREATE TABLE (sqlite_master.sql) của các bảng được theo dõi + phiên bản định dạng.
 * Đổi (cập nhật app thêm cột/bảng, đổi tên bảng, đổi danh sách loại trừ) → cài lại trigger + chụp gốc mới.
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

// ─── Phạm vi đồng bộ (tài khoản + từ ngày) ──────────────────────────────────

/**
 * Cách một bảng chỉ ra tài khoản sở hữu dòng:
 *  - 'account'  : cột chứa accounts.zalo_id (id chung của mọi kênh: Zalo uid, Facebook uid, Telegram user/bot id).
 *  - 'fbAccount': cột chứa fb_accounts.id (UUID) → tài khoản = fb_accounts.facebook_id. Không có dòng fb_accounts
 *                 tương ứng → coi chính giá trị là accounts.zalo_id (dữ liệu Facebook kiểu cũ dùng UUID làm id).
 *  - 'parent'   : bảng con không có cột tài khoản — cột chứa khoá dòng cha, theo phạm vi của dòng cha
 *                 (không còn dòng cha → không biết chủ → giữ).
 * Dòng có cột tài khoản NULL / '' (dữ liệu chung của bảng) luôn được giữ.
 */
export type ScopeAccountRef =
    | { kind: 'account'; column: string }
    | { kind: 'fbAccount'; column: string }
    | { kind: 'parent'; column: string; parent: string; parentKey: string };

export interface ScopedTablePolicy {
    table: string;
    account: ScopeAccountRef;
    /** Bảng lịch sử: cột thời gian (ms) để áp "từ ngày". Không có = giữ đủ dòng của tài khoản được chọn. */
    time?: string;
}

/** Tăng khi đổi SCOPED_TABLES → máy đang dùng phạm vi giới hạn tự chụp gốc mới theo quy tắc mới. */
export const SCOPE_POLICY_VERSION = 1;

const own = (table: string, time?: string): ScopedTablePolicy => ({ table, account: { kind: 'account', column: 'owner_zalo_id' }, time });
const byAccount = (table: string, column: string, time?: string): ScopedTablePolicy => ({ table, account: { kind: 'account', column }, time });
const byFbAccount = (table: string, column: string, time?: string): ScopedTablePolicy => ({ table, account: { kind: 'fbAccount', column }, time });
const childOf = (table: string, column: string, parent: string, parentKey = 'id'): ScopedTablePolicy => ({ table, account: { kind: 'parent', column, parent, parentKey } });

/**
 * CHÍNH SÁCH PHẠM VI — mọi bảng có dữ liệu riêng của từng tài khoản, ở MỘT chỗ (bản gốc lẫn đoạn thay đổi đều đọc từ đây).
 * Bảng KHÔNG có trong danh sách = dữ liệu chung (app_settings, workflows, nhân viên, erp_*, tích hợp, trợ lý AI, sticker,
 * proxy, plugin, cloud_media…) → luôn đồng bộ đủ.
 *
 * !!! Thêm bảng mới có dữ liệu theo tài khoản (cột owner_zalo_id / zalo_id / account_id…) hoặc bảng con của một bảng
 * dưới đây → PHẢI thêm vào danh sách này (và tăng SCOPE_POLICY_VERSION). Thiếu = bản sao giới hạn phạm vi vẫn mang dữ liệu
 * của tài khoản không được chọn lên R2.
 *
 * `time` chỉ đặt cho bảng lịch sử tin (tin nhắn, ghim, link, nhật ký gửi…, đơn vị ms); danh bạ / nhóm / peer / cài đặt của
 * tài khoản được chọn luôn giữ đủ. Bảng / cột không có trong DB (bản cũ) → dòng chính sách đó bị bỏ qua (coi như dữ liệu chung).
 * Đối chiếu với DB thật 2.6 GB (10/2026): mọi cột thời gian dưới đây là ms.
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
    // Public API: hàng đợi sự kiện (payload chứa nội dung tin) — không theo dõi theo đoạn nhưng nằm trong bản gốc.
    byAccount('api_events', 'account_id', 'created_at'),
    // ── Facebook: fb_accounts.facebook_id = accounts.zalo_id; bảng còn lại trỏ fb_accounts.id ──
    byAccount('fb_accounts', 'facebook_id'),
    byFbAccount('fb_threads', 'account_id'),
    byFbAccount('fb_messages', 'account_id', 'timestamp'),
    byFbAccount('fb_crm_contacts', 'fb_account_id'),
    byFbAccount('fb_scan_history', 'account_id'),
    byFbAccount('fb_scan_tabs', 'account_id'),
    // ── Bảng con không có cột tài khoản → theo dòng cha ──
    childOf('ai_conversation_messages', 'conversation_id', 'ai_conversations'),
    childOf('tg_bot_rules', 'project_id', 'tg_bot_projects'),
    childOf('tg_bot_rule_logs', 'project_id', 'tg_bot_projects'),
    childOf('tg_bot_schedule', 'project_id', 'tg_bot_projects'),
    childOf('fb_scan_tab_data', 'tab_id', 'fb_scan_tabs'),
    childOf('fb_scan_tab_requests', 'tab_id', 'fb_scan_tabs'),
    childOf('webhook_deliveries', 'event_seq', 'api_events', 'seq'),
];

/** Chính sách đã đối chiếu với schema của MỘT DB (tên bảng / cột đúng như khai báo). */
export interface ResolvedScopePolicy {
    table: string;
    kind: ScopeAccountRef['kind'];
    /** Cột tài khoản ('account' / 'fbAccount') hoặc cột khoá dòng cha ('parent'). */
    column: string;
    time: string | null;
    /** 'parent': chính sách bảng cha; 'fbAccount': chính sách fb_accounts (null = DB không có fb_accounts). */
    parent: ResolvedScopePolicy | null;
    /** Cột khoá của bảng cha mà `column` trỏ tới. */
    parentKey: string | null;
    /** Số bậc tới bảng gốc — xoá bảng sâu nhất trước (bảng con trước bảng cha). */
    depth: number;
}

function findColumn(columns: string[], name: string): string | null {
    const n = name.toLowerCase();
    return columns.find(c => c.toLowerCase() === n) ?? null;
}

/** Chính sách áp được cho DB này. Khoá: tên bảng chữ thường. Bảng / cột thiếu → không có trong kết quả. */
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
                // Không có bảng cha / chính sách cha → không biết chủ dòng → coi như dữ liệu chung.
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
