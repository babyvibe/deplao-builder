/**
 * restoreDb — thao tác trên FILE bản sao (khôi phục / máy dự phòng): chuẩn bị connection áp đoạn, dựng lại FTS,
 * kiểm tra toàn vẹn + số dòng.
 */
import { dropTracking } from './DirtyTracker';
import { SqlConn, quoteIdent, tableExists, toNumber } from './sqlConn';
import { tableColumns } from './tableSelection';

/**
 * - foreign_keys = OFF: thứ tự cha/con trong một đoạn tuỳ ý, trạng thái cuối mới là nhất quán.
 * - recursive_triggers = ON: dòng bị INSERT OR REPLACE gỡ vẫn chạy trigger DELETE của app (messages_fts_ad…).
 */
export function prepareApplyConnection(conn: SqlConn): void {
    conn.exec('PRAGMA foreign_keys = OFF');
    conn.exec('PRAGMA recursive_triggers = ON');
}

/** Bản sao không cần ghi _cloud_dirty khi áp đoạn: gỡ trigger/bảng theo dõi (bản gốc chụp kèm chúng). */
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
 * FTS5 của app (messages_fts) là bảng FTS thường (tự giữ nội dung), đồng bộ bằng trigger trên messages.
 * - Bảng "<x>_fts" có bảng nguồn "<x>" chứa đủ cột FTS: số dòng lệch → nạp lại toàn bộ từ bảng nguồn theo rowid
 *   (bản gốc từ máy nguồn có thể đã lệch sẵn: INSERT OR REPLACE của app gỡ dòng mà không chạy trigger DELETE).
 * - Còn lại: lệnh 'rebuild' của FTS5 (bảng contentless không hỗ trợ → bỏ qua, ghi cảnh báo).
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
                // Cột khai báo của FTS (bỏ cột ẩn: tên bảng, rank)
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
                            try { conn.exec('ROLLBACK'); } catch { /* đã huỷ */ }
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
    /** Số dòng lúc chụp gốc (manifest.rowCounts). */
    rowCounts?: Record<string, number> | null;
    /** Tổng số bản ghi đã áp theo bảng (upsert + delete) sau bản gốc — sai lệch cho phép. */
    touched?: Record<string, number> | null;
}

export interface VerifyResult {
    integrityOk: boolean;
    integrity: string[];
    counts: Record<string, number>;
    mismatches: Array<{ table: string; expected: number; actual: number; tolerance: number }>;
}

/**
 * PRAGMA integrity_check + so số dòng với manifest. Số dòng trong manifest là lúc chụp gốc (đếm lại mỗi đoạn quá tốn
 * ở chế độ realtime) → bảng không có đoạn nào chạm phải khớp tuyệt đối; bảng có chạm cho phép lệch ≤ số bản ghi đã áp.
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

/** DB "trống" (chưa dùng): không tài khoản, không tin nhắn, không liên hệ — khôi phục đè lên được. */
export function isEffectivelyEmpty(conn: SqlConn): boolean {
    for (const t of ['accounts', 'fb_accounts', 'messages', 'fb_messages', 'contacts', 'workflows', 'crm_campaigns']) {
        if (!tableExists(conn, t)) continue;
        if (conn.prepare(`SELECT 1 AS x FROM ${quoteIdent(t)} LIMIT 1`).get()) return false;
    }
    return true;
}
