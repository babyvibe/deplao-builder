/**
 * Segment — đoạn thay đổi: trạng thái CUỐI của các dòng đã chạm (không phải nhật ký thao tác).
 *
 * Định dạng (JSONL, nén gzip rồi mã hoá DPLC1 trước khi lên R2):
 *   {"op":"h","v":1,"fromId":…,"toId":…,"at":…,"fp":"…","rows":…}         — dòng đầu
 *   {"op":"u","t":"bảng","rid":…,"row":{"cột":giá trị,…}}                   — dòng còn tồn tại (upsert)
 *   {"op":"d","t":"bảng","rid":…}                                            — dòng đã xoá
 *   {"op":"s","seq":{"bảng":n,…}}                                            — sqlite_sequence của bảng có chạm
 *
 * Gói: trong MỘT giao dịch đọc, lấy ≤ limit dòng _cloud_dirty theo id tăng dần, đọc trạng thái hiện tại của từng dòng.
 * Áp: xoá trước, rồi INSERT OR REPLACE kèm rowid (giữ đúng rowid; REPLACE gỡ được xung đột UNIQUE tạm thời giữa các
 * dòng trong cùng đoạn). Áp lại một đoạn nhiều lần cho cùng kết quả (idempotent).
 *
 * Phạm vi đồng bộ (tài khoản + từ ngày, xem scope.ts): dòng ngoài phạm vi KHÔNG bao giờ được gửi nội dung — xem chú thích
 * trong packSegment về cách xử lý (bỏ qua hẳn / gửi lệnh xoá) để bản sao một phần không giữ dòng cũ khi rowid bị dùng lại.
 */
import type { CloudScope } from '../../../shared/cloud/cloudContracts';
import { BindValue, EncodedValue, decodeValue, encodeRow, encodeValue, safeInt } from './codec';
import { RowScope, resolveScope } from './scope';
import { SqlConn, SqlStatement, canonicalTableName, quoteIdent, readTx, tableExists } from './sqlConn';
import { TrackedTable, describeTable, schemaFingerprint, selectTables } from './tableSelection';

export const SEGMENT_FORMAT = 1;
export const SEGMENT_ROW_LIMIT = 5000;
/** Trần kích thước JSONL một đoạn (dòng to: tin nhắn kèm JSON dài, BLOB…). Luôn chứa ít nhất một dòng. */
export const SEGMENT_MAX_BYTES = 32 * 1024 * 1024;

export interface SegmentHeader {
    op: 'h';
    v: number;
    fromId: number;
    toId: number;
    at: number;
    fp: string;
    rows: number;
}

export interface UpsertRecord {
    op: 'u';
    t: string;
    rid: EncodedValue;
    row: Record<string, EncodedValue>;
}

export interface DeleteRecord {
    op: 'd';
    t: string;
    rid: EncodedValue;
}

export interface PackedSegment {
    /** JSONL UTF-8 (chưa nén). Rỗng khi mọi dòng bẩn thuộc bảng không còn theo dõi (chỉ cần xác nhận, không đẩy). */
    jsonl: Buffer;
    fromId: number;
    toId: number;
    rows: number;
    upserts: number;
    deletes: number;
    /** Dòng bẩn của bảng không còn theo dõi / dòng ngoài phạm vi bỏ qua hẳn (không gửi gì, vẫn xác nhận). */
    skipped: number;
    /** Dòng ngoài phạm vi: bỏ qua hẳn (bảng AUTOINCREMENT) / gửi thành lệnh xoá (bảng có thể dùng lại rowid). */
    outOfScope: { skipped: number; deletes: number };
    tables: Record<string, number>;
    fingerprint: string;
    at: number;
    /** Còn dòng bẩn id > toId. */
    hasMore: boolean;
}

export function packSegment(
    conn: SqlConn,
    opts: { limit?: number; maxBytes?: number; now?: number; scope?: Partial<CloudScope> | null } = {},
): PackedSegment | null {
    const limit = Math.max(1, Math.floor(opts.limit ?? SEGMENT_ROW_LIMIT));
    const maxBytes = Math.max(1024, Math.floor(opts.maxBytes ?? SEGMENT_MAX_BYTES));
    const at = opts.now ?? Date.now();
    const scope = resolveScope(opts.scope);
    if (!tableExists(conn, '_cloud_dirty')) return null;
    return readTx(conn, () => {
        const dirty = conn.prepare('SELECT id, tbl, rid FROM _cloud_dirty ORDER BY id LIMIT ?', { bigInts: true }).all(limit);
        if (!dirty.length) return null;
        const sel = selectTables(conn);
        const fingerprint = schemaFingerprint(conn, sel);
        const rowScope = scope ? new RowScope(conn, scope) : null;
        const stmts = new Map<string, SqlStatement>();
        const stmtFor = (t: TrackedTable): SqlStatement => {
            let st = stmts.get(t.name);
            if (!st) {
                const cols = t.columns.map(quoteIdent).join(', ');
                st = conn.prepare(`SELECT ${cols} FROM ${quoteIdent(t.name)} WHERE ${t.rowidAlias} = ?`, { bigInts: true });
                stmts.set(t.name, st);
            }
            return st;
        };

        const lines: string[] = [];
        const tables: Record<string, number> = {};
        const outOfScope = { skipped: 0, deletes: 0 };
        let bytes = 0;
        let upserts = 0;
        let deletes = 0;
        let skipped = 0;
        const fromId = safeInt(dirty[0].id);
        let toId = fromId - 1;
        for (const d of dirty) {
            const id = safeInt(d.id);
            const info = sel.byName.get(String(d.tbl).toLowerCase());
            if (!info) {
                // Bảng đã bị loại / bị xoá / WITHOUT ROWID: không có gì để đẩy, chỉ xác nhận.
                skipped++;
                toId = id;
                continue;
            }
            let row = stmtFor(info).get(d.rid);
            let scopeDelete = false;
            if (row && rowScope && !rowScope.inScope(info.name, row)) {
                // Dòng ngoài phạm vi (tài khoản không được chọn / cũ hơn "từ ngày"): KHÔNG gửi nội dung.
                //  - Bảng AUTOINCREMENT: rowid không bao giờ được cấp lại → bản sao chưa từng có dòng nào ở rowid này
                //    (bản gốc đã lọc, đoạn trước cũng không gửi) → bỏ qua hẳn, không tốn đoạn cho hoạt động của tài khoản
                //    bị loại. (Ngoại lệ lý thuyết: app tự đổi cột tài khoản/thời gian của dòng cũ cho nó ra khỏi phạm vi —
                //    bản gốc kế tiếp, ≤ 30 h, dọn lại.)
                //  - Bảng khác: rowid có thể được dùng lại. Một mục _cloud_dirty gộp mọi lần chạm vào (bảng, rowid): dòng X
                //    trong phạm vi bị xoá rồi dòng Y ngoài phạm vi được chèn vào CÙNG rowid trước lần gói → ở đây chỉ thấy Y.
                //    Bỏ qua thì bản sao giữ mãi X ("dòng ma") → gửi LỆNH XOÁ rowid này thay cho upsert.
                // Lệnh xoá luôn vô hại với bản sao một phần: trạng thái hiện tại của rowid ở máy nguồn là "không có / ngoài
                // phạm vi" nên đúng ra bản sao không được có gì ở rowid đó; rowid bản sao chưa từng có thì DELETE không làm gì.
                if (rowScope.neverReusesRowids(info.name)) {
                    skipped++;
                    outOfScope.skipped++;
                    toId = id;
                    continue;
                }
                row = undefined;
                scopeDelete = true;
            }
            const line = row
                ? JSON.stringify({ op: 'u', t: info.name, rid: encodeValue(d.rid), row: encodeRow(row, info.columns) })
                : JSON.stringify({ op: 'd', t: info.name, rid: encodeValue(d.rid) });
            const len = Buffer.byteLength(line, 'utf8') + 1;
            if (lines.length > 0 && bytes + len > maxBytes) break;
            lines.push(line);
            bytes += len;
            if (row) upserts++;
            else deletes++;
            if (scopeDelete) outOfScope.deletes++;
            tables[info.name] = (tables[info.name] || 0) + 1;
            toId = id;
        }

        const rows = upserts + deletes;
        const hasMore = !!conn.prepare('SELECT 1 AS x FROM _cloud_dirty WHERE id > ? LIMIT 1').get(toId);
        if (rows === 0) {
            return { jsonl: Buffer.alloc(0), fromId, toId, rows: 0, upserts: 0, deletes: 0, skipped, outOfScope, tables, fingerprint, at, hasMore };
        }

        // sqlite_sequence của các bảng có chạm: bản sao không cấp lại rowid đã dùng rồi xoá ở máy nguồn.
        const seq: Record<string, EncodedValue> = {};
        try {
            for (const r of conn.prepare('SELECT name, seq FROM sqlite_sequence', { bigInts: true }).all()) {
                const name = String(r.name);
                if (tables[name] !== undefined) seq[name] = encodeValue(r.seq);
            }
        } catch { /* DB không có bảng AUTOINCREMENT */ }

        const header: SegmentHeader = { op: 'h', v: SEGMENT_FORMAT, fromId, toId, at, fp: fingerprint, rows };
        const parts = [JSON.stringify(header), ...lines];
        if (Object.keys(seq).length) parts.push(JSON.stringify({ op: 's', seq }));
        const jsonl = Buffer.from(parts.join('\n') + '\n', 'utf8');
        return { jsonl, fromId, toId, rows, upserts, deletes, skipped, outOfScope, tables, fingerprint, at, hasMore };
    });
}

// ─── Đọc / áp đoạn ──────────────────────────────────────────────────────────

export interface ParsedSegment {
    header: SegmentHeader;
    upserts: UpsertRecord[];
    deletes: DeleteRecord[];
    seq: Record<string, EncodedValue> | null;
}

export function parseSegment(text: string): ParsedSegment {
    let header: SegmentHeader | null = null;
    const upserts: UpsertRecord[] = [];
    const deletes: DeleteRecord[] = [];
    let seq: Record<string, EncodedValue> | null = null;
    for (const raw of text.split('\n')) {
        if (!raw) continue;
        const rec = JSON.parse(raw);
        switch (rec?.op) {
            case 'h': header = rec; break;
            case 'u': upserts.push(rec); break;
            case 'd': deletes.push(rec); break;
            case 's': seq = rec.seq || null; break;
            default: throw new Error('Đoạn thay đổi có dòng không hợp lệ');
        }
    }
    if (!header) throw new Error('Đoạn thay đổi thiếu phần đầu');
    if (header.v !== SEGMENT_FORMAT) throw new Error(`Đoạn thay đổi định dạng v${header.v} — hãy cập nhật Deplao`);
    return { header, upserts, deletes, seq };
}

export interface ApplyStats {
    fromId: number;
    toId: number;
    at: number;
    upserts: number;
    deletes: number;
    tables: Record<string, number>;
}

/**
 * Áp một đoạn lên bản sao (khôi phục / máy dự phòng) trong một giao dịch.
 * Connection nên đặt PRAGMA foreign_keys = OFF (thứ tự cha/con trong đoạn tuỳ ý) và recursive_triggers = ON
 * (dòng bị REPLACE gỡ vẫn chạy trigger DELETE của app, vd giữ messages_fts khớp) — xem restoreDb.prepareApplyConnection.
 */
export function applySegment(conn: SqlConn, text: string): ApplyStats {
    const seg = parseSegment(text);
    const targets = new Map<string, (TrackedTable & { columnSet: Set<string> }) | null>();
    const target = (t: string) => {
        const key = String(t).toLowerCase();
        if (!targets.has(key)) {
            const name = canonicalTableName(conn, t);
            const info = name ? describeTable(conn, name) : null;
            targets.set(key, info ? { ...info, columnSet: new Set(info.columns.map(c => c.toLowerCase())) } : null);
        }
        const info = targets.get(key);
        if (!info) throw new Error(`Bản sao thiếu bảng "${t}" (schema không khớp bản gốc)`);
        return info;
    };
    const stmts = new Map<string, SqlStatement>();
    const prepared = (sql: string) => {
        let st = stmts.get(sql);
        if (!st) {
            st = conn.prepare(sql);
            stmts.set(sql, st);
        }
        return st;
    };
    const tables: Record<string, number> = {};

    conn.exec('BEGIN');
    try {
        for (const d of seg.deletes) {
            const tt = target(d.t);
            prepared(`DELETE FROM ${quoteIdent(tt.name)} WHERE ${tt.rowidAlias} = ?`).run(decodeValue(d.rid));
            tables[tt.name] = (tables[tt.name] || 0) + 1;
        }
        for (const u of seg.upserts) {
            const tt = target(u.t);
            const cols = Object.keys(u.row || {});
            for (const c of cols) {
                if (!tt.columnSet.has(c.toLowerCase())) throw new Error(`Bản sao thiếu cột "${c}" của bảng "${tt.name}"`);
            }
            const placeholders = new Array(cols.length + 1).fill('?').join(', ');
            const sql = `INSERT OR REPLACE INTO ${quoteIdent(tt.name)} (${tt.rowidAlias}${cols.length ? ', ' : ''}${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
            const params: BindValue[] = [decodeValue(u.rid)];
            for (const c of cols) params.push(decodeValue(u.row[c]));
            prepared(sql).run(...params);
            tables[tt.name] = (tables[tt.name] || 0) + 1;
        }
        if (seg.seq) applySequences(conn, seg.seq);
        conn.exec('COMMIT');
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* đã huỷ */ }
        throw err;
    }
    return {
        fromId: seg.header.fromId,
        toId: seg.header.toId,
        at: seg.header.at,
        upserts: seg.upserts.length,
        deletes: seg.deletes.length,
        tables,
    };
}

function applySequences(conn: SqlConn, seq: Record<string, EncodedValue>): void {
    if (!tableExists(conn, 'sqlite_sequence')) return;
    const read = conn.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?', { bigInts: true });
    for (const [name, enc] of Object.entries(seq)) {
        const want = decodeValue(enc);
        if (typeof want !== 'bigint') continue;
        const canonical = canonicalTableName(conn, name);
        if (!canonical) continue;
        const cur = read.get(canonical);
        if (!cur) {
            conn.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(canonical, want);
        } else if (BigInt(cur.seq) < want) {
            conn.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(want, canonical);
        }
    }
}
