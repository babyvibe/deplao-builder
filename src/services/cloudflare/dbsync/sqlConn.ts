/**
 * sqlConn: a thin layer over SQLite for the DB sync module.
 *
 * The sync logic (triggers, packing change segments, base snapshots, restore) is written against this interface so it can run in two places:
 *  - the app's worker_threads: better-sqlite3 (openBetterSqlite);
 *  - jest tests: node:sqlite (the project's better-sqlite3 is built for Electron, so plain Node cannot load it).
 *
 * This file (and every file the worker uses) does NOT import electron / Logger / modules outside the dbsync folder, so the worker can run
 * even when the dbsync folder is unpacked from app.asar.
 */
import * as fs from 'fs';

export interface SqlRunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
}

export interface SqlStatement {
    /** Only for statements that return NO data (INSERT/UPDATE/DELETE/DDL). */
    run(...params: unknown[]): SqlRunResult;
    /** Only for statements that return data (SELECT / reading PRAGMA). undefined when there is no row. */
    get(...params: unknown[]): any;
    all(...params: unknown[]): any[];
}

export interface SqlConn {
    readonly filePath: string;
    exec(sql: string): void;
    /**
     * bigInts: every integer is read back as a BigInt → keeps values > 2^53 exact and tells INTEGER (bigint) apart from REAL
     * (number). Required when packing rows into change segments.
     */
    prepare(sql: string, opts?: { bigInts?: boolean }): SqlStatement;
    /**
     * Copies the pages as they are to a NEW file (keeps rowids; does not use VACUUM INTO, which can renumber rowids).
     * Copies in a single step (one read transaction is held), so it is a consistent snapshot even while another connection is writing.
     */
    backupTo(destPath: string): Promise<void>;
    close(): void;
}

export interface OpenOptions {
    readonly?: boolean;
    /** Does not create the file if it does not exist yet (the workspace's live DB). */
    mustExist?: boolean;
    /** busy_timeout (ms): the worker waits for the app's write lock, without blocking main. Default 15 s. */
    busyTimeoutMs?: number;
    /**
     * The worker's own temp file (base snapshot copy): turns off better-sqlite3's defensive mode so PRAGMA journal_mode = OFF
     * takes effect when filtering by scope (no GB-sized journal file is written). NOT for the live DB.
     */
    scratch?: boolean;
}

export type OpenSqlConn = (filePath: string, opts?: OpenOptions) => SqlConn;

/** Open with better-sqlite3. nativeBinding: the path of better_sqlite3.node (the worker does not need the 'bindings' package inside the asar). */
export function betterSqliteOpener(nativeBinding?: string | null): OpenSqlConn {
    return (filePath: string, opts: OpenOptions = {}): SqlConn => {
        if (opts.mustExist && !fs.existsSync(filePath)) throw new Error(`Không tìm thấy file DB: ${filePath}`);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Database = require('better-sqlite3');
        const options: Record<string, unknown> = {
            readonly: !!opts.readonly,
            fileMustExist: !!opts.mustExist,
            timeout: opts.busyTimeoutMs ?? 15_000,
        };
        if (nativeBinding) options.nativeBinding = nativeBinding;
        const db = new Database(filePath, options);
        if (opts.scratch && typeof db.unsafeMode === 'function') {
            try { db.unsafeMode(true); } catch { /* keep defensive mode, it is just slower */ }
        }
        return {
            filePath,
            exec: (sql: string) => { db.exec(sql); },
            prepare: (sql: string, o?: { bigInts?: boolean }) => {
                const st = db.prepare(sql);
                if (o?.bigInts) st.safeIntegers(true);
                return st as SqlStatement;
            },
            backupTo: async (destPath: string) => {
                // better-sqlite3: the first step copies 0 pages (initialization), then copies the number of pages that progress returns →
                // returns the largest number so the rest is copied in ONE step (one read transaction → a consistent snapshot;
                // WAL does not block writers). It runs in the worker, so it does not block main.
                await db.backup(destPath, { progress: () => 0x7fffffff });
            },
            close: () => {
                try { db.close(); } catch { /* already closed */ }
            },
        };
    };
}

export const openBetterSqlite: OpenSqlConn = betterSqliteOpener(null);

// ─── Shared SQL helpers ────────────────────────────────────────────────

export function quoteIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

export function tableExists(conn: SqlConn, name: string): boolean {
    const row = conn.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(name);
    return !!row;
}

/** Table name exactly as in sqlite_master (case-insensitive match) or null. */
export function canonicalTableName(conn: SqlConn, name: string): string | null {
    const row = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(name);
    return row ? String(row.name) : null;
}

/** BEGIN IMMEDIATE … COMMIT (ROLLBACK on error). Takes the write lock right from the start; busy_timeout handles waiting for the app. */
export function writeTx<T>(conn: SqlConn, fn: () => T): T {
    conn.exec('BEGIN IMMEDIATE');
    try {
        const out = fn();
        conn.exec('COMMIT');
        return out;
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* transaction cancelled */ }
        throw err;
    }
}

/** Read transaction: every SELECT inside fn sees the same snapshot. */
export function readTx<T>(conn: SqlConn, fn: () => T): T {
    conn.exec('BEGIN');
    try {
        const out = fn();
        conn.exec('COMMIT');
        return out;
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* transaction cancelled */ }
        throw err;
    }
}

export function toNumber(v: unknown): number {
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
