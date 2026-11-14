/**
 * Segment: a change segment, i.e. the FINAL state of the rows that were touched (not an operation log).
 *
 * Format (JSONL, gzip-compressed then encrypted with DPLC1 before going to R2):
 *   {"op":"h","v":1,"fromId":…,"toId":…,"at":…,"fp":"…","rows":…}         (first line)
 *   {"op":"u","t":"table","rid":…,"row":{"column":value,…}}                   (row still exists, upsert)
 *   {"op":"d","t":"table","rid":…}                                            (row was deleted)
 *   {"op":"s","seq":{"table":n,…}}                                            (sqlite_sequence of the tables that were touched)
 *
 * Packing: in ONE read transaction, take ≤ limit _cloud_dirty rows in increasing id order, then read the current state of each row.
 * Applying: delete first, then INSERT OR REPLACE with the rowid (keeps the exact rowid; REPLACE clears the temporary UNIQUE conflicts between
 * rows in the same segment). Applying a segment several times gives the same result (idempotent).
 *
 * Sync scope (accounts + from date, see scope.ts): rows outside the scope are NEVER sent with content. See the comment
 * in packSegment for how they are handled (skipped entirely / sent as a delete command), so a partial copy does not keep old rows when a rowid is reused.
 */
import type { CloudScope } from '../../../shared/cloud/cloudContracts';
import { BindValue, EncodedValue, decodeValue, encodeRow, encodeValue, safeInt } from './codec';
import { RowScope, resolveScope } from './scope';
import { SqlConn, SqlStatement, canonicalTableName, quoteIdent, readTx, tableExists } from './sqlConn';
import { TrackedTable, describeTable, schemaFingerprint, selectTables } from './tableSelection';

export const SEGMENT_FORMAT = 1;
export const SEGMENT_ROW_LIMIT = 5000;
/** Size cap of the JSONL in one segment (big rows: messages with long JSON, BLOBs…). It always holds at least one row. */
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
    /** UTF-8 JSONL (not compressed). Empty when all dirty rows belong to tables that are no longer tracked (only needs confirmation, nothing is pushed). */
    jsonl: Buffer;
    fromId: number;
    toId: number;
    rows: number;
    upserts: number;
    deletes: number;
    /** Dirty rows of a table that is no longer tracked / rows outside the scope are skipped entirely (nothing is sent, but they are still confirmed). */
    skipped: number;
    /** Row outside the scope: skipped entirely (AUTOINCREMENT table) / sent as a delete command (the table may reuse rowids). */
    outOfScope: { skipped: number; deletes: number };
    tables: Record<string, number>;
    fingerprint: string;
    at: number;
    /** There are still dirty rows with id > toId. */
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
                // The table was dropped / deleted / WITHOUT ROWID: nothing to push, only confirm.
                skipped++;
                toId = id;
                continue;
            }
            let row = stmtFor(info).get(d.rid);
            let scopeDelete = false;
            if (row && rowScope && !rowScope.inScope(info.name, row)) {
                // Row outside the scope (account not selected / older than "từ ngày" (from date)): do NOT send content.
                //  - AUTOINCREMENT table: a rowid is never issued again → the copy has never had a row at this rowid
                //    (the base snapshot was filtered and earlier segments did not send it either) → skip entirely, so account activity does not use up segments
                //    removed. (Theoretical exception: the app itself changes the account/time column of an old row to move it out of the scope:
                //    next base snapshot, ≤ 30 h, cleaned up again.)
                //  - Other tables: a rowid can be reused. One _cloud_dirty entry merges every touch of (table, rowid): row X
                //    in scope is deleted, then row Y outside the scope is inserted with the SAME rowid before the pack → here only Y is seen.
                //    Skipping it would keep X in the copy forever ("ghost row") → send a DELETE for this rowid instead of an upsert.
                // A delete command is always harmless for a partial copy: the current state of this rowid on the source machine is "absent / outside
                // scope" so the copy should have nothing at that rowid; a rowid the copy never had makes DELETE do nothing.
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

        // sqlite_sequence of the tables that were touched: the copy does not reissue a rowid that was used and then deleted on the source machine.
        const seq: Record<string, EncodedValue> = {};
        try {
            for (const r of conn.prepare('SELECT name, seq FROM sqlite_sequence', { bigInts: true }).all()) {
                const name = String(r.name);
                if (tables[name] !== undefined) seq[name] = encodeValue(r.seq);
            }
        } catch { /* the DB has no AUTOINCREMENT table */ }

        const header: SegmentHeader = { op: 'h', v: SEGMENT_FORMAT, fromId, toId, at, fp: fingerprint, rows };
        const parts = [JSON.stringify(header), ...lines];
        if (Object.keys(seq).length) parts.push(JSON.stringify({ op: 's', seq }));
        const jsonl = Buffer.from(parts.join('\n') + '\n', 'utf8');
        return { jsonl, fromId, toId, rows, upserts, deletes, skipped, outOfScope, tables, fingerprint, at, hasMore };
    });
}

// ─── Read / apply segment ──────────────────────────────────────────────────────────

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
 * Apply a segment to the copy (restore / standby machine) in one transaction.
 * The connection should set PRAGMA foreign_keys = OFF (the parent/child order within the segment is arbitrary) and recursive_triggers = ON
 * (a row removed by REPLACE still runs the app's DELETE trigger, e.g. to keep messages_fts in sync): see restoreDb.prepareApplyConnection.
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
        try { conn.exec('ROLLBACK'); } catch { /* cancelled */ }
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
