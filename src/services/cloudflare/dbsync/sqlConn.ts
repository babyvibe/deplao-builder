/**
 * sqlConn — lớp mỏng trên SQLite cho module đồng bộ DB.
 *
 * Logic đồng bộ (trigger, gói đoạn thay đổi, chụp gốc, khôi phục) viết trên interface này để chạy được ở hai nơi:
 *  - worker_threads của app: better-sqlite3 (openBetterSqlite);
 *  - test jest: node:sqlite (better-sqlite3 của dự án build cho Electron nên Node thường không nạp được).
 *
 * File này (và mọi file worker dùng) KHÔNG import electron / Logger / module ngoài thư mục dbsync — worker chạy được
 * cả khi thư mục dbsync được unpack khỏi app.asar.
 */
import * as fs from 'fs';

export interface SqlRunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
}

export interface SqlStatement {
    /** Chỉ dùng cho câu KHÔNG trả dữ liệu (INSERT/UPDATE/DELETE/DDL). */
    run(...params: unknown[]): SqlRunResult;
    /** Chỉ dùng cho câu trả dữ liệu (SELECT/PRAGMA đọc). undefined khi không có dòng. */
    get(...params: unknown[]): any;
    all(...params: unknown[]): any[];
}

export interface SqlConn {
    readonly filePath: string;
    exec(sql: string): void;
    /**
     * bigInts: mọi số nguyên đọc ra dạng BigInt — giữ đúng giá trị > 2^53 và phân biệt INTEGER (bigint) với REAL
     * (number). Bắt buộc khi gói dòng vào đoạn thay đổi.
     */
    prepare(sql: string, opts?: { bigInts?: boolean }): SqlStatement;
    /**
     * Sao chép nguyên trang sang file MỚI (giữ rowid — không dùng VACUUM INTO vì có thể đánh số lại rowid).
     * Chép trong một bước duy nhất (giữ một giao dịch đọc) nên là ảnh chụp nhất quán dù connection khác đang ghi.
     */
    backupTo(destPath: string): Promise<void>;
    close(): void;
}

export interface OpenOptions {
    readonly?: boolean;
    /** Không tạo file khi chưa có (DB sống của workspace). */
    mustExist?: boolean;
    /** busy_timeout (ms) — worker chờ khoá ghi của app, không chặn main. Mặc định 15 s. */
    busyTimeoutMs?: number;
    /**
     * File tạm của riêng worker (bản sao chụp gốc): tắt chế độ defensive của better-sqlite3 để PRAGMA journal_mode = OFF
     * có hiệu lực khi lọc theo phạm vi (không ghi file journal cỡ GB). KHÔNG dùng cho DB sống.
     */
    scratch?: boolean;
}

export type OpenSqlConn = (filePath: string, opts?: OpenOptions) => SqlConn;

/** Mở bằng better-sqlite3. nativeBinding: đường dẫn better_sqlite3.node (worker không cần gói 'bindings' trong asar). */
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
            try { db.unsafeMode(true); } catch { /* giữ defensive — chỉ chậm hơn */ }
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
                // better-sqlite3: bước đầu chép 0 trang (khởi tạo), sau đó chép số trang mà progress trả về →
                // trả số lớn nhất để phần còn lại chép trong MỘT bước (một giao dịch đọc → ảnh chụp nhất quán;
                // WAL không chặn người ghi). Chạy trong worker nên không chặn main.
                await db.backup(destPath, { progress: () => 0x7fffffff });
            },
            close: () => {
                try { db.close(); } catch { /* đã đóng */ }
            },
        };
    };
}

export const openBetterSqlite: OpenSqlConn = betterSqliteOpener(null);

// ─── Tiện ích SQL dùng chung ────────────────────────────────────────────────

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

/** Tên bảng đúng như trong sqlite_master (so khớp không phân biệt hoa thường) hoặc null. */
export function canonicalTableName(conn: SqlConn, name: string): string | null {
    const row = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(name);
    return row ? String(row.name) : null;
}

/** BEGIN IMMEDIATE … COMMIT (ROLLBACK khi lỗi). Lấy khoá ghi ngay từ đầu — busy_timeout lo việc chờ app. */
export function writeTx<T>(conn: SqlConn, fn: () => T): T {
    conn.exec('BEGIN IMMEDIATE');
    try {
        const out = fn();
        conn.exec('COMMIT');
        return out;
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* giao dịch đã huỷ */ }
        throw err;
    }
}

/** Giao dịch đọc: mọi SELECT trong fn thấy cùng một ảnh chụp. */
export function readTx<T>(conn: SqlConn, fn: () => T): T {
    conn.exec('BEGIN');
    try {
        const out = fn();
        conn.exec('COMMIT');
        return out;
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* giao dịch đã huỷ */ }
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
