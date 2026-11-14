/**
 * ops: the SQLite operation handler of the DB sync. Runs in worker_threads (worker.ts) so main never has to wait for
 * long SQLite work (base snapshots, packing/applying segments, integrity checks…). Tests call it directly in the process (DbOpsClient.inProcessOps).
 *
 * Connections are kept per file path between calls; 'close' / 'closeAll' release the file (changing the storage folder,
 * deleting a workspace, replacing the DB during a restore).
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
    /** Base snapshot progress inside the worker (the copy step is measured by main itself, since the worker is busy copying in one go). */
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
    /** The base snapshot currently running / already told to stop by main (the machine slept midway), by DB path + temp file mark. */
    const snapshotsRunning = new Set<string>();
    const snapshotsCancelled = new Set<string>();
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
    /** One-off connection (probes another DB without keeping the file). */
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
                // Probe another workspace: its workspace id (not created) + whether the DB is still empty.
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
                const stamp = String(a.stamp || Date.now());
                const runKey = `${keyOf(a.dbPath)}|${stamp}`;
                // Main reports a stop (cancelSnapshot): the copy step in one go cannot be interrupted, the following steps stop right away.
                const stopped = () => snapshotsCancelled.has(runKey);
                const cancelled = () => Object.assign(new Error('Đã dừng chụp bản gốc'), { code: 'DBSYNC_SNAPSHOT_CANCELLED' });
                snapshotsRunning.add(runKey);
                const raw = path.join(tmpDir, `base-${stamp}.db`);
                const gzPath = `${raw}.gz`;
                const sidecars = [`${raw}-journal`, `${raw}-wal`, `${raw}-shm`];
                try {
                    await fs.promises.mkdir(tmpDir, { recursive: true });
                    await removeQuietly(raw, gzPath, ...sidecars);
                    if (stopped()) throw cancelled();
                    await live.backupTo(raw);
                    if (stopped()) throw cancelled();
                    emit({ type: 'progress', dbPath: String(a.dbPath), phase: 'filter', done: 0, total: 0 });
                    // scratch: the worker's own temp file → allows journal_mode = OFF when filtering by scope.
                    const copy = openConn(raw, { mustExist: true, scratch: true });
                    let info;
                    try {
                        info = prepareSnapshotCopy(copy, { scope: a.scope ?? null });
                    } finally {
                        copy.close();
                    }
                    if (stopped()) throw cancelled();
                    const rawBytes = (await fs.promises.stat(raw)).size;
                    const gzBytes = await gzipFile(raw, gzPath, 6, (done, total) => {
                        emit({ type: 'progress', dbPath: String(a.dbPath), phase: 'compress', done, total });
                    }, stopped);
                    await removeQuietly(raw, ...sidecars);
                    return { gzPath, rawBytes, gzBytes, ...info };
                } catch (err) {
                    await removeQuietly(raw, gzPath, ...sidecars);
                    throw stopped() ? cancelled() : err;
                } finally {
                    snapshotsRunning.delete(runKey);
                    snapshotsCancelled.delete(runKey);
                }
            }
            case 'cancelSnapshot': {
                // Only recorded while that snapshot is still running (a late report after it finished is ignored, nothing is left behind).
                const runKey = `${keyOf(a.dbPath)}|${String(a.stamp)}`;
                if (!snapshotsRunning.has(runKey)) return false;
                snapshotsCancelled.add(runKey);
                return true;
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
                    } catch { /* DB busy / just closed → try again next time */ }
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
