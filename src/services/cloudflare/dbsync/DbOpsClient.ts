/**
 * DbOpsClient — phía main gọi bộ xử lý SQLite của đồng bộ DB.
 *  - createWorkerOps(): worker_threads (sản phẩm). Worker tạo lười ở lần gọi đầu, tự tạo lại nếu chết; terminate()
 *    khi tắt đồng bộ / thoát app → không còn luồng nào khi tắt.
 *  - createInProcessOps(): gọi thẳng trong tiến trình (test jest với node:sqlite). KHÔNG dùng ở main của app vì
 *    chụp gốc / kiểm tra toàn vẹn là thao tác đồng bộ dài.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DbOpsEvent, createOpsHandler } from './ops';
import type { OpenSqlConn } from './sqlConn';

export interface DbOps {
    call<T = any>(op: string, args?: any): Promise<T>;
    onEvent(cb: (ev: DbOpsEvent) => void): () => void;
    /** Đóng mọi connection + dừng luồng nền (chờ đóng gọn tối đa graceMs). Gọi lại call() sau đó sẽ tạo luồng mới. */
    terminate(graceMs?: number): Promise<void>;
    /** Đang có luồng nền / connection (false = chưa tạo hoặc đã dừng — khỏi tạo worker chỉ để đóng). */
    isActive(): boolean;
    readonly kind: 'worker' | 'inprocess';
}

export function createInProcessOps(openConn: OpenSqlConn): DbOps {
    const listeners = new Set<(ev: DbOpsEvent) => void>();
    let handler = createOpsHandler(openConn, ev => listeners.forEach(l => { try { l(ev); } catch { /* bỏ qua */ } }));
    return {
        kind: 'inprocess',
        call: (op, args) => handler.handle(op, args || {}),
        onEvent: cb => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        terminate: async () => {
            handler.closeAll();
            handler = createOpsHandler(openConn, ev => listeners.forEach(l => { try { l(ev); } catch { /* bỏ qua */ } }));
        },
        isActive: () => true,
    };
}

/** Đường dẫn worker.js (ưu tiên bản unpack khỏi app.asar nếu có). */
export function resolveWorkerPath(dir: string = __dirname): string | null {
    const candidates: string[] = [];
    const p = path.join(dir, 'worker.js');
    if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) candidates.push(p.replace('app.asar', 'app.asar.unpacked'));
    candidates.push(p);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch { /* bỏ qua */ }
    }
    return null;
}

/** better_sqlite3.node thật trên đĩa (worker không cần gói 'bindings' nằm trong app.asar). */
export function resolveNativeBinding(): string | null {
    try {
        const pkg = require.resolve('better-sqlite3/package.json');
        let p = path.join(path.dirname(pkg), 'build', 'Release', 'better_sqlite3.node');
        if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) p = p.replace('app.asar', 'app.asar.unpacked');
        return fs.existsSync(p) ? p : null;
    } catch {
        return null;
    }
}

interface Pending {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    op: string;
}

export class WorkerStartError extends Error {
    code = 'DBSYNC_WORKER';
    constructor(message: string) {
        super(message);
        this.name = 'WorkerStartError';
    }
}

class WorkerOps implements DbOps {
    readonly kind = 'worker' as const;
    private worker: import('worker_threads').Worker | null = null;
    private seq = 0;
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Set<(ev: DbOpsEvent) => void>();

    constructor(private readonly opts: { workerPath?: string | null; nativeBinding?: string | null; log?: (msg: string) => void }) {}

    private spawn(): import('worker_threads').Worker {
        if (this.worker) return this.worker;
        const file = this.opts.workerPath ?? resolveWorkerPath();
        if (!file) throw new WorkerStartError('Không tìm thấy worker đồng bộ DB (worker.js)');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Worker } = require('worker_threads') as typeof import('worker_threads');
        const nativeBinding = this.opts.nativeBinding === undefined ? resolveNativeBinding() : this.opts.nativeBinding;
        const w = new Worker(file, { workerData: { nativeBinding } });
        w.on('message', (m: any) => this.onMessage(m));
        w.on('error', (err: any) => {
            this.opts.log?.(`[CloudDb] worker lỗi: ${err?.message || err}`);
            this.failAll(err);
        });
        w.on('exit', code => {
            if (this.worker === w) this.worker = null;
            if (this.pending.size) this.failAll(new WorkerStartError(`Worker đồng bộ DB đã dừng (mã ${code})`));
        });
        // Không giữ tiến trình sống chỉ vì worker (thoát app không phải chờ).
        w.unref();
        this.worker = w;
        return w;
    }

    private onMessage(m: any): void {
        if (m && m.event) {
            for (const l of this.listeners) { try { l(m.event); } catch { /* bỏ qua */ } }
            return;
        }
        const p = m && typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else {
            const err: any = new Error(m.error?.message || `Thao tác ${p.op} lỗi`);
            if (m.error?.code) err.code = m.error.code;
            p.reject(err);
        }
    }

    private failAll(err: any): void {
        const list = [...this.pending.values()];
        this.pending.clear();
        for (const p of list) p.reject(err instanceof Error ? err : new Error(String(err)));
    }

    call<T = any>(op: string, args?: any): Promise<T> {
        let w: import('worker_threads').Worker;
        try {
            w = this.spawn();
        } catch (err) {
            return Promise.reject(err);
        }
        return new Promise<T>((resolve, reject) => {
            const id = ++this.seq;
            this.pending.set(id, { resolve, reject, op });
            try {
                w.postMessage({ id, op, args: args || {} });
            } catch (err) {
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    onEvent(cb: (ev: DbOpsEvent) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    isActive(): boolean {
        return !!this.worker;
    }

    async terminate(graceMs = 5000): Promise<void> {
        const w = this.worker;
        if (!w) return;
        // Đóng connection gọn (thao tác đang chạy dở trong worker phải xong trước — tối đa graceMs), rồi dừng luồng.
        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, Math.max(0, graceMs));
            this.call('closeAll').then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
        });
        if (this.worker === w) this.worker = null;
        this.failAll(new WorkerStartError('Worker đồng bộ DB đã dừng'));
        try { await w.terminate(); } catch { /* đã dừng */ }
    }
}

export function createWorkerOps(opts: { workerPath?: string | null; nativeBinding?: string | null; log?: (msg: string) => void } = {}): DbOps {
    return new WorkerOps(opts);
}

/** Buffer từ kết quả worker (structured clone biến Buffer thành Uint8Array). */
export function asBuffer(v: unknown): Buffer {
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return Buffer.alloc(0);
}
