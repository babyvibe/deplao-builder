/**
 * readOps — chạy câu SELECT của DatabaseService trên kết nối SQLite CHỈ ĐỌC riêng, trong worker_threads (dbReadWorker.ts):
 * mở hội thoại, tìm tin, danh sách ảnh / file không chặn luồng chính của app khi ổ đĩa chậm (máy vừa thức dậy, RAM đầy).
 * Câu lệnh và tham số do DatabaseService tạo như cũ (DbReadClient.ts); ở đây chỉ chạy.
 *
 * Kết nối giữ theo đường dẫn DB, tự đóng sau IDLE_CLOSE_MS không dùng: không giữ file lâu (đổi workspace, khôi phục,
 * chuyển thư mục cần thay / xoá file; DatabaseService còn gọi closeAll ngay trước những lúc đó).
 *
 * File này và dbReadWorker.ts chỉ import Node — worker chạy được cả khi thư mục được unpack khỏi app.asar.
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
    /** Đóng kết nối không dùng từ IDLE_CLOSE_MS (worker gọi theo nhịp). */
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
        try { entry.conn.close(); } catch { /* đã đóng */ }
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
