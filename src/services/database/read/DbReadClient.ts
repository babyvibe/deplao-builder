/**
 * DbReadClient — main gửi câu SELECT nặng của DatabaseService (mở hội thoại, tìm tin, danh sách ảnh / file, danh sách
 * hội thoại) sang luồng đọc (dbReadWorker.ts) thay vì chạy better-sqlite3 đồng bộ trên luồng chính. Ổ đĩa chậm (máy vừa
 * thức dậy, RAM đầy) thì mỗi lần đọc có thể mất vài giây: trước đây là vài giây cả app đứng, nay chỉ lệnh đó chờ.
 *
 * Kết quả không bao giờ khác đường cũ: chưa bật (test), không tạo được worker, worker lỗi / chết / quá hạn, câu lệnh lỗi
 * trong worker (vd hàm SQL chỉ đăng ký trên kết nối chính) → run() trả null và DatabaseService chạy câu đó trên luồng
 * chính như trước. Worker không dùng từ IDLE_TERMINATE_MS thì dừng (đỡ RAM), lần đọc sau tạo lại.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ReadRequest } from './readOps';

export const READ_TIMEOUT_MS = 30_000;
export const IDLE_TERMINATE_MS = 10 * 60_000;
/** Worker chết ngoài ý muốn từng này lần thì thôi (đọc trên luồng chính tới khi mở lại app). */
const MAX_CRASHES = 3;

export type ReadExecutor = (req: ReadRequest) => unknown | Promise<unknown>;

type Worker = import('worker_threads').Worker;

interface Pending {
    resolve: (v: { value: unknown } | null) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Đường dẫn dbReadWorker.js cạnh file này (ưu tiên bản unpack khỏi app.asar — worker_threads không đọc được asar). */
function resolveWorkerPath(dir: string = __dirname): string | null {
    const p = path.join(dir, 'dbReadWorker.js');
    const candidates = p.includes('app.asar') && !p.includes('app.asar.unpacked') ? [p.replace('app.asar', 'app.asar.unpacked'), p] : [p];
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch { /* bỏ qua */ }
    }
    return null;
}

/** better_sqlite3.node thật trên đĩa (worker không cần gói 'bindings' nằm trong app.asar) — như dbsync/DbOpsClient. */
function resolveNativeBinding(): string | null {
    try {
        const pkg = require.resolve('better-sqlite3/package.json');
        let p = path.join(path.dirname(pkg), 'build', 'Release', 'better_sqlite3.node');
        if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) p = p.replace('app.asar', 'app.asar.unpacked');
        return fs.existsSync(p) ? p : null;
    } catch {
        return null;
    }
}

/** Structured clone biến Buffer thành Uint8Array: trả lại Buffer như better-sqlite3 trên luồng chính. */
function withBuffers(value: unknown): unknown {
    const fix = (row: unknown) => {
        if (!row || typeof row !== 'object') return;
        const r = row as Record<string, unknown>;
        for (const k of Object.keys(r)) {
            const v = r[k];
            if (v instanceof Uint8Array && !Buffer.isBuffer(v)) r[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        }
    };
    if (Array.isArray(value)) value.forEach(fix);
    else fix(value);
    return value;
}

export class DbReadClient {
    private enabled = false;
    private disabled = false;
    private crashes = 0;
    private executor: ReadExecutor | null = null;
    private executorCloseAll: (() => void) | null = null;
    private worker: Worker | null = null;
    private stopping: Worker | null = null;
    private seq = 0;
    private readonly pending = new Map<number, Pending>();
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private log: (msg: string) => void = () => undefined;

    /** main.ts (sau app ready): đọc nặng chạy qua worker. */
    enable(opts: { log?: (msg: string) => void } = {}): void {
        this.enabled = true;
        if (opts.log) this.log = opts.log;
    }

    /** Test: chạy câu đọc trong tiến trình (vd readOps + node:sqlite); null = về mặc định. */
    setExecutor(fn: ReadExecutor | null, closeAll?: () => void): void {
        this.executor = fn;
        this.executorCloseAll = fn ? closeAll || null : null;
    }

    /** null = không chạy được ngoài luồng chính (nơi gọi đọc như cũ). */
    async run(req: ReadRequest): Promise<{ value: unknown } | null> {
        // Tham số nhị phân: để luồng chính lo (structured clone đổi kiểu Buffer)
        if (req.params.some(p => p instanceof Uint8Array)) return null;
        if (this.executor) {
            try {
                return { value: withBuffers(await this.executor(req)) };
            } catch {
                return null;
            }
        }
        if (!this.enabled || this.disabled) return null;
        const w = this.spawn();
        if (!w) return null;
        this.touch();
        return new Promise(resolve => {
            const id = ++this.seq;
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) resolve(null);
            }, READ_TIMEOUT_MS);
            (timer as any).unref?.();
            this.pending.set(id, { resolve, timer });
            try {
                w.postMessage({ id, op: req.op, dbPath: req.dbPath, sql: req.sql, params: req.params });
            } catch {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve(null);
            }
        });
    }

    /**
     * Đóng mọi kết nối của worker và CHỜ xong (tối đa timeoutMs) — DatabaseService gọi ngay trước khi đóng / thay / chuyển
     * file DB (Windows không cho thay file đang mở). Lệnh đọc gửi trước đó chạy xong trước.
     */
    closeAllSync(timeoutMs = 2000): void {
        if (this.executor) {
            try { this.executorCloseAll?.(); } catch { /* bỏ qua */ }
            return;
        }
        const w = this.worker;
        if (!w) return;
        const shared = new SharedArrayBuffer(4);
        const flag = new Int32Array(shared);
        try {
            w.postMessage({ id: ++this.seq, op: 'closeAll', flag: shared });
        } catch {
            return;
        }
        const deadline = Date.now() + timeoutMs;
        try {
            Atomics.wait(flag, 0, 0, timeoutMs);
        } catch {
            // Luồng này không được Atomics.wait: chờ bận, tối đa timeoutMs
            while (Atomics.load(flag, 0) === 0 && Date.now() < deadline) { /* chờ */ }
        }
    }

    private spawn(): Worker | null {
        if (this.worker) return this.worker;
        const file = resolveWorkerPath();
        if (!file) {
            this.disabled = true;
            this.log('[DbRead] Không tìm thấy dbReadWorker.js: đọc trên luồng chính như cũ');
            return null;
        }
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Worker } = require('worker_threads') as typeof import('worker_threads');
            const w = new Worker(file, { workerData: { nativeBinding: resolveNativeBinding() } });
            w.on('message', (m: any) => this.onMessage(m));
            w.on('error', (err: any) => this.log(`[DbRead] Worker lỗi: ${err?.message || err}`));
            w.on('exit', code => {
                if (this.worker === w) this.worker = null;
                this.failPending();
                if (this.stopping === w) {
                    this.stopping = null;
                    return;
                }
                this.crashes++;
                if (this.crashes >= MAX_CRASHES) {
                    this.disabled = true;
                    this.log(`[DbRead] Worker dừng ${this.crashes} lần (mã ${code}): đọc trên luồng chính như cũ`);
                }
            });
            // Không giữ tiến trình sống chỉ vì worker (thoát app không phải chờ)
            w.unref();
            this.worker = w;
            return w;
        } catch (err: any) {
            this.disabled = true;
            this.log(`[DbRead] Không tạo được worker (${err?.message || err}): đọc trên luồng chính như cũ`);
            return null;
        }
    }

    private onMessage(m: any): void {
        const p = m && typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m.ok ? { value: withBuffers(m.result) } : null);
        if (!this.pending.size) this.touch();
    }

    private failPending(): void {
        const list = [...this.pending.values()];
        this.pending.clear();
        for (const p of list) {
            clearTimeout(p.timer);
            p.resolve(null);
        }
    }

    /** Không dùng IDLE_TERMINATE_MS → dừng worker (đỡ RAM); lần đọc sau tạo lại. */
    private touch(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            const w = this.worker;
            if (!w || this.pending.size) return;
            this.worker = null;
            this.stopping = w;
            void w.terminate().catch(() => undefined);
        }, IDLE_TERMINATE_MS);
        (this.idleTimer as any).unref?.();
    }
}

export const dbReads = new DbReadClient();
