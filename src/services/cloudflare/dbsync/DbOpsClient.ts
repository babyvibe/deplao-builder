/**
 * DbOpsClient: the main-process side that calls the DB sync's SQLite handler.
 *  - createWorkerOps(): worker_threads (production). The worker is created lazily on the first call and recreated if it dies; terminate()
 *    when sync is turned off / the app quits → no threads are left running after shutdown.
 *  - createInProcessOps(): calls directly in the process (jest tests with node:sqlite). NOT used in the app's main process, because
 *    taking the base snapshot / integrity checks are long synchronous operations.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DbOpsEvent, createOpsHandler } from './ops';
import type { OpenSqlConn } from './sqlConn';

export interface DbOps {
    call<T = any>(op: string, args?: any): Promise<T>;
    onEvent(cb: (ev: DbOpsEvent) => void): () => void;
    /** Close all connections + stop the background thread (waits for a clean close, at most graceMs). Calling call() afterwards creates a new thread. */
    terminate(graceMs?: number): Promise<void>;
    /** Whether a background thread / connection exists (false = not created yet or already stopped; no need to create a worker just to close it). */
    isActive(): boolean;
    readonly kind: 'worker' | 'inprocess';
}

export function createInProcessOps(openConn: OpenSqlConn): DbOps {
    const listeners = new Set<(ev: DbOpsEvent) => void>();
    let handler = createOpsHandler(openConn, ev => listeners.forEach(l => { try { l(ev); } catch { /* ignore */ } }));
    return {
        kind: 'inprocess',
        call: (op, args) => handler.handle(op, args || {}),
        onEvent: cb => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        terminate: async () => {
            handler.closeAll();
            handler = createOpsHandler(openConn, ev => listeners.forEach(l => { try { l(ev); } catch { /* ignore */ } }));
        },
        isActive: () => true,
    };
}

/** Path to worker.js (prefers the copy unpacked from app.asar, if there is one). */
export function resolveWorkerPath(dir: string = __dirname): string | null {
    const candidates: string[] = [];
    const p = path.join(dir, 'worker.js');
    if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) candidates.push(p.replace('app.asar', 'app.asar.unpacked'));
    candidates.push(p);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
}

/** The real better_sqlite3.node on disk (the worker does not need the 'bindings' package inside app.asar). */
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
        // Do not keep the process alive just for the worker (quitting the app does not have to wait).
        w.unref();
        this.worker = w;
        return w;
    }

    private onMessage(m: any): void {
        if (m && m.event) {
            for (const l of this.listeners) { try { l(m.event); } catch { /* ignore */ } }
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
        // Close connections cleanly (an operation half-done in the worker must finish first, at most graceMs), then stop the thread.
        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, Math.max(0, graceMs));
            this.call('closeAll').then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
        });
        if (this.worker === w) this.worker = null;
        this.failAll(new WorkerStartError('Worker đồng bộ DB đã dừng'));
        try { await w.terminate(); } catch { /* already stopped */ }
    }
}

export function createWorkerOps(opts: { workerPath?: string | null; nativeBinding?: string | null; log?: (msg: string) => void } = {}): DbOps {
    return new WorkerOps(opts);
}

/** Buffer from a worker result (structured clone turns a Buffer into a Uint8Array). */
export function asBuffer(v: unknown): Buffer {
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return Buffer.alloc(0);
}
