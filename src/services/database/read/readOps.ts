/**
 * readOps: runs DatabaseService's SELECT statements on its own READ-ONLY SQLite connection, inside worker_threads (dbReadWorker.ts):
 * opening a conversation, searching messages, photo / file lists do not block the app's main thread when the disk is slow (the machine just woke up, RAM full).
 * The statements and parameters are built by DatabaseService as before (DbReadClient.ts); this file only runs them.
 *
 * A connection is kept per DB path and closed automatically after IDLE_CLOSE_MS unused: it does not hold the file for long (switching workspace, restoring,
 * moving the folder needs to replace / delete the file; DatabaseService also calls closeAll right before those moments).
 *
 * This file and dbReadWorker.ts import only Node: the worker runs even when the folder is unpacked from app.asar.
 */
import * as path from 'path';

export interface ReadConn {
    all(sql: string, params: unknown[]): unknown[];
    get(sql: string, params: unknown[]): unknown;
    close(): void;
}

export type OpenReadConn = (dbPath: string) => ReadConn;

export interface ReadRequest {
    op: 'all' | 'get';
    dbPath: string;
    sql: string;
    params: unknown[];
}

export const IDLE_CLOSE_MS = 10_000;

export interface ReadOps {
    run(req: ReadRequest): unknown;
    closeAll(): void;
    /** Close a connection that has not been used for IDLE_CLOSE_MS (the worker calls this on a timer). */
    sweep(): void;
    openCount(): number;
}

export function createReadOps(open: OpenReadConn, opts: { idleCloseMs?: number; now?: () => number } = {}): ReadOps {
    const idleMs = opts.idleCloseMs ?? IDLE_CLOSE_MS;
    const now = opts.now ?? (() => Date.now());
    const conns = new Map<string, { conn: ReadConn; usedAt: number }>();
    const keyOf = (p: string) => {
        const resolved = path.resolve(String(p || ''));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const closeOne = (key: string) => {
        const entry = conns.get(key);
        if (!entry) return;
        conns.delete(key);
        try { entry.conn.close(); } catch { /* closed */ }
    };
    return {
        run(req: ReadRequest): unknown {
            const key = keyOf(req.dbPath);
            let entry = conns.get(key);
            if (!entry) {
                entry = { conn: open(path.resolve(String(req.dbPath))), usedAt: now() };
                conns.set(key, entry);
            }
            entry.usedAt = now();
            const params = Array.isArray(req.params) ? req.params : [];
            return req.op === 'get' ? entry.conn.get(req.sql, params) : entry.conn.all(req.sql, params);
        },
        closeAll(): void {
            for (const key of [...conns.keys()]) closeOne(key);
        },
        sweep(): void {
            const t = now();
            for (const [key, entry] of [...conns]) if (t - entry.usedAt >= idleMs) closeOne(key);
        },
        openCount: () => conns.size,
    };
}
