/**
 * syncLog — nhật ký đồng bộ trong chính DB workspace (bảng cloud_sync_log, KHÔNG có trigger theo dõi).
 * Giữ tối đa LOG_KEEP dòng mỗi DB. Chế độ realtime gộp mọi lần đẩy trong một giờ vào một dòng 'segments-hour'.
 */
import type { SyncLogEntry } from '../../../shared/cloudContracts';
import { SqlConn, tableExists, toNumber } from './sqlConn';

export const LOG_TABLE = 'cloud_sync_log';
export const LOG_KEEP = 2000;

const CREATE_LOG_SQL = `CREATE TABLE IF NOT EXISTS cloud_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    end_at INTEGER,
    kind TEXT NOT NULL,
    pushes INTEGER NOT NULL DEFAULT 0,
    "rows" INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT 'ok',
    error TEXT
)`;

export type LogInput = Omit<SyncLogEntry, 'id'>;

export function ensureLogTable(conn: SqlConn): void {
    if (!tableExists(conn, LOG_TABLE)) {
        conn.exec(CREATE_LOG_SQL);
        conn.exec('CREATE INDEX IF NOT EXISTS idx_cloud_sync_log_at ON cloud_sync_log(workspace_id, at DESC)');
    }
}

function clampText(v: unknown, max = 500): string | null {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function appendLog(conn: SqlConn, e: LogInput): number {
    ensureLogTable(conn);
    const res = conn.prepare(
        `INSERT INTO cloud_sync_log (workspace_id, at, end_at, kind, pushes, "rows", bytes, duration_ms, result, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        String(e.workspaceId), Math.round(e.at), e.endAt === null || e.endAt === undefined ? null : Math.round(e.endAt), e.kind,
        Math.round(e.pushes || 0), Math.round(e.rows || 0), Math.round(e.bytes || 0), Math.round(e.durationMs || 0),
        e.result, clampText(e.error),
    );
    const id = toNumber(res.lastInsertRowid);
    if (id % 50 === 0) trimLog(conn);
    return id;
}

export function updateLog(conn: SqlConn, id: number, e: LogInput): void {
    ensureLogTable(conn);
    conn.prepare(
        `UPDATE cloud_sync_log SET at = ?, end_at = ?, kind = ?, pushes = ?, "rows" = ?, bytes = ?, duration_ms = ?, result = ?, error = ?
         WHERE id = ?`,
    ).run(
        Math.round(e.at), e.endAt === null || e.endAt === undefined ? null : Math.round(e.endAt), e.kind,
        Math.round(e.pushes || 0), Math.round(e.rows || 0), Math.round(e.bytes || 0), Math.round(e.durationMs || 0),
        e.result, clampText(e.error), id,
    );
}

export function trimLog(conn: SqlConn, keep = LOG_KEEP): void {
    if (!tableExists(conn, LOG_TABLE)) return;
    conn.prepare('DELETE FROM cloud_sync_log WHERE id <= (SELECT max(id) FROM cloud_sync_log) - ?').run(keep);
}

export function rowToEntry(r: any): SyncLogEntry {
    return {
        id: toNumber(r.id),
        workspaceId: String(r.workspace_id),
        at: toNumber(r.at),
        endAt: r.end_at === null || r.end_at === undefined ? null : toNumber(r.end_at),
        kind: r.kind,
        pushes: toNumber(r.pushes),
        rows: toNumber(r.rows),
        bytes: toNumber(r.bytes),
        durationMs: toNumber(r.duration_ms),
        result: r.result,
        error: r.error ?? null,
    };
}

export function readLog(conn: SqlConn, limit = 500): SyncLogEntry[] {
    if (!tableExists(conn, LOG_TABLE)) return [];
    const n = Math.max(1, Math.min(LOG_KEEP, Math.floor(limit)));
    return conn.prepare('SELECT * FROM cloud_sync_log ORDER BY id DESC LIMIT ?').all(n).map(rowToEntry);
}

export function clearLog(conn: SqlConn): void {
    if (tableExists(conn, LOG_TABLE)) conn.exec('DELETE FROM cloud_sync_log');
}
