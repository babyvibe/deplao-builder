/**
 * ops — bộ xử lý thao tác SQLite của đồng bộ DB. Chạy trong worker_threads (worker.ts) để main không bao giờ phải chờ
 * SQLite lâu (chụp gốc, gói/áp đoạn, kiểm tra toàn vẹn…). Test gọi thẳng trong tiến trình (DbOpsClient.inProcessOps).
 *
 * Connection theo đường dẫn file được giữ lại giữa các lần gọi; 'close' / 'closeAll' nhả file (đổi thư mục lưu trữ,
 * xoá workspace, thay DB khi khôi phục).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { ackDirty, dirtyStats, dropTracking, ensureTracking, ensureWorkspaceUid, hasDirtyRows, hasTracking } from './DirtyTracker';
import { applyPostRestoreSafety } from './postRestore';
import { isEffectivelyEmpty, prepareRestoreCopy, rebuildFts, verifyRestoredDb } from './restoreDb';
import { applySegment, packSegment } from './Segment';
import { gunzipFile, gzipFile, prepareSnapshotCopy, removeQuietly } from './Snapshot';
import { OpenSqlConn, SqlConn } from './sqlConn';
import { appendLog, readLog, updateLog } from './syncLog';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export type DbOpsEvent =
    | { type: 'dirty'; dbPath: string }
    /** Tiến độ chụp bản gốc trong worker (bước sao chép do main tự đo kích thước file — worker bận chép một mạch). */
    | { type: 'progress'; dbPath: string; phase: 'filter' | 'compress'; done: number; total: number };

export interface OpsHandler {
    handle(op: string, args: any): Promise<any>;
    closeAll(): void;
}

function toBuffer(v: unknown): Buffer {
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return Buffer.from(v);
    throw new Error('Thiếu dữ liệu nhị phân');
}

export function createOpsHandler(openConn: OpenSqlConn, emit: (ev: DbOpsEvent) => void): OpsHandler {
    const conns = new Map<string, SqlConn>();
    const watches = new Map<string, { timer: ReturnType<typeof setInterval>; armed: boolean }>();

    const keyOf = (p: string) => path.resolve(String(p || ''));
    const conn = (dbPath: string): SqlConn => {
        const k = keyOf(dbPath);
        let c = conns.get(k);
        if (!c) {
            c = openConn(k, { mustExist: true });
            conns.set(k, c);
        }
        return c;
    };
    const close = (dbPath: string) => {
        const k = keyOf(dbPath);
        const c = conns.get(k);
        if (c) {
            conns.delete(k);
            c.close();
        }
    };
    const unwatch = (dbPath: string) => {
        const k = keyOf(dbPath);
        const w = watches.get(k);
        if (w) {
            clearInterval(w.timer);
            watches.delete(k);
        }
    };
    /** Connection dùng một lần (dò DB khác mà không giữ file). */
    const withTemp = <T>(dbPath: string, fn: (c: SqlConn) => T): T | null => {
        if (!dbPath || !fs.existsSync(dbPath)) return null;
        const existing = conns.get(keyOf(dbPath));
        if (existing) return fn(existing);
        const c = openConn(keyOf(dbPath), { mustExist: true });
        try { return fn(c); } finally { c.close(); }
    };
    const closeAll = () => {
        for (const w of watches.values()) clearInterval(w.timer);
        watches.clear();
        for (const c of conns.values()) c.close();
        conns.clear();
    };

    async function handle(op: string, a: any): Promise<any> {
        switch (op) {
            case 'ping':
                return true;
            case 'ensureTracking':
                return ensureTracking(conn(a.dbPath), { createWorkspaceUid: a.createWorkspaceUid !== false });
            case 'dropTracking':
                return withTemp(a.dbPath, c => dropTracking(c)) ?? { triggers: 0, tables: 0 };
            case 'hasTracking':
                return withTemp(a.dbPath, c => hasTracking(c)) ?? false;
            case 'probe':
                // Dò workspace khác: mã workspace (không tạo) + DB còn trống không.
                return withTemp(a.dbPath, c => ({ workspaceUid: ensureWorkspaceUid(c, false), empty: isEffectivelyEmpty(c) }));
            case 'dirtyStats':
                return dirtyStats(conn(a.dbPath));
            case 'pack': {
                const res = packSegment(conn(a.dbPath), { limit: a.limit, maxBytes: a.maxBytes, now: a.now, scope: a.scope ?? null });
                if (!res) return null;
                const { jsonl, ...meta } = res;
                const gz = jsonl.length ? await gzip(jsonl) : Buffer.alloc(0);
                return { ...meta, rawBytes: jsonl.length, gz };
            }
            case 'ack':
                return ackDirty(conn(a.dbPath), Number(a.upToId) || 0);
            case 'snapshot': {
                const live = conn(a.dbPath);
                const tmpDir = String(a.tmpDir);
                await fs.promises.mkdir(tmpDir, { recursive: true });
                const raw = path.join(tmpDir, `base-${String(a.stamp || Date.now())}.db`);
                const gzPath = `${raw}.gz`;
                const sidecars = [`${raw}-journal`, `${raw}-wal`, `${raw}-shm`];
                await removeQuietly(raw, gzPath, ...sidecars);
                try {
                    await live.backupTo(raw);
                    emit({ type: 'progress', dbPath: String(a.dbPath), phase: 'filter', done: 0, total: 0 });
                    // scratch: file tạm của riêng worker — cho phép journal_mode = OFF khi lọc theo phạm vi.
                    const copy = openConn(raw, { mustExist: true, scratch: true });
                    let info;
                    try {
                        info = prepareSnapshotCopy(copy, { scope: a.scope ?? null });
                    } finally {
                        copy.close();
                    }
                    const rawBytes = (await fs.promises.stat(raw)).size;
                    const gzBytes = await gzipFile(raw, gzPath, 6, (done, total) => {
                        emit({ type: 'progress', dbPath: String(a.dbPath), phase: 'compress', done, total });
                    });
                    await removeQuietly(raw, ...sidecars);
                    return { gzPath, rawBytes, gzBytes, ...info };
                } catch (err) {
                    await removeQuietly(raw, gzPath, ...sidecars);
                    throw err;
                }
            }
            case 'appendLog':
                return appendLog(conn(a.dbPath), a.entry);
            case 'updateLog':
                updateLog(conn(a.dbPath), Number(a.id), a.entry);
                return true;
            case 'readLog':
                return withTemp(a.dbPath, c => readLog(c, a.limit || 500)) ?? [];
            case 'watch': {
                unwatch(a.dbPath);
                const dbPath = String(a.dbPath);
                const w = { timer: null as unknown as ReturnType<typeof setInterval>, armed: true };
                w.timer = setInterval(() => {
                    if (!w.armed) return;
                    try {
                        if (hasDirtyRows(conn(dbPath))) {
                            w.armed = false;
                            emit({ type: 'dirty', dbPath });
                        }
                    } catch { /* DB đang bận / vừa đóng — lần sau thử lại */ }
                }, Math.max(500, Number(a.intervalMs) || 2000));
                (w.timer as any)?.unref?.();
                watches.set(keyOf(dbPath), w);
                return true;
            }
            case 'rearm': {
                const w = watches.get(keyOf(a.dbPath));
                if (w) w.armed = true;
                return !!w;
            }
            case 'unwatch':
                unwatch(a.dbPath);
                return true;
            case 'close':
                unwatch(a.dbPath);
                close(a.dbPath);
                return true;
            case 'closeAll':
                closeAll();
                return true;
            case 'gunzipFile':
                return gunzipFile(String(a.src), String(a.dst));
            case 'restorePrepare':
                prepareRestoreCopy(conn(a.dbPath));
                return true;
            case 'applySegment': {
                const text = (await gunzip(toBuffer(a.gz))).toString('utf8');
                return applySegment(conn(a.dbPath), text);
            }
            case 'restoreVerify': {
                const c = conn(a.dbPath);
                const fts = rebuildFts(c);
                const verify = verifyRestoredDb(c, a.expect || {});
                return { fts, verify };
            }
            case 'postRestore':
                return applyPostRestoreSafety(conn(a.dbPath), a.info);
            default:
                throw new Error(`Thao tác không hỗ trợ: ${op}`);
        }
    }

    return { handle, closeAll };
}
