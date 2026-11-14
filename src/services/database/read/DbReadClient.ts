/**
 * DbReadClient: main sends the heavy SELECT statements of DatabaseService (opening a conversation, searching messages, photo / file lists, conversation
 * lists) to the read thread (dbReadWorker.ts) instead of running better-sqlite3 synchronously on the main thread. On a slow disk (the machine just
 * woke up, RAM full) each read can take several seconds: before, the whole app froze for those seconds; now only that command waits.
 *
 * The result is never different from the old path: not enabled (tests), the worker could not be created, the worker errored / died / timed out, a statement failed
 * in the worker (e.g. a SQL function that is only registered on the main connection) → run() returns null and DatabaseService runs that statement on the main
 * thread as before. A worker that is not used for IDLE_TERMINATE_MS is stopped (saves RAM); the next read creates it again.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ReadRequest } from './readOps';

export const READ_TIMEOUT_MS = 30_000;
export const IDLE_TERMINATE_MS = 10 * 60_000;
/** If the worker dies unexpectedly this many times, stop (reads run on the main thread until the app is reopened). */
const MAX_CRASHES = 3;

export type ReadExecutor = (req: ReadRequest) => unknown | Promise<unknown>;

type Worker = import('worker_threads').Worker;

interface Pending {
    resolve: (v: { value: unknown } | null) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Path of dbReadWorker.js next to this file (prefers the copy unpacked from app.asar: worker_threads cannot read asar). */
function resolveWorkerPath(dir: string = __dirname): string | null {
    const p = path.join(dir, 'dbReadWorker.js');
    const candidates = p.includes('app.asar') && !p.includes('app.asar.unpacked') ? [p.replace('app.asar', 'app.asar.unpacked'), p] : [p];
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
}

/** The real better_sqlite3.node on disk (the worker does not need the 'bindings' package inside app.asar), as in dbsync/DbOpsClient. */
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

/** Structured clone turns a Buffer into a Uint8Array: returns the Buffer as better-sqlite3 does on the main thread. */
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

    /** main.ts (after app ready): heavy reads go through the worker. */
    enable(opts: { log?: (msg: string) => void } = {}): void {
        this.enabled = true;
        if (opts.log) this.log = opts.log;
    }

    /** Test: run the read statement in-process (e.g. readOps + node:sqlite); null = use the default. */
    setExecutor(fn: ReadExecutor | null, closeAll?: () => void): void {
        this.executor = fn;
        this.executorCloseAll = fn ? closeAll || null : null;
    }

    /** null = cannot run off the main thread (the caller reads as before). */
    async run(req: ReadRequest): Promise<{ value: unknown } | null> {
        // Binary parameters: the main thread handles them (structured clone changes the Buffer type)
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
     * Closes every connection of the worker and WAITS for it (at most timeoutMs), DatabaseService calls this right before closing / replacing / moving
     * the DB file (Windows does not allow replacing an open file). Read commands sent before it finish first.
     */
    closeAllSync(timeoutMs = 2000): void {
        if (this.executor) {
            try { this.executorCloseAll?.(); } catch { /* ignore */ }
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
            // This thread must not use Atomics.wait: wait while busy, at most timeoutMs
            while (Atomics.load(flag, 0) === 0 && Date.now() < deadline) { /* wait */ }
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
            // Do not keep the process alive just for the worker (exiting the app does not have to wait)
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

    /** Without IDLE_TERMINATE_MS → stop the worker (saves RAM); the next read creates it again. */
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
