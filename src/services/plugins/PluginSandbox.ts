/**
 * PluginSandbox — chạy backend plugin local trong tiến trình riêng, RPC hai chiều, timeout,
 * tự khởi động lại khi crash (2 s, 10 s, 60 s; lần 4 → tắt plugin), ping 30 s để đo RAM.
 *
 * Electron dùng utilityProcess (forkElectron); test và môi trường không có Electron dùng
 * child_process.fork (forkNode). Môi trường của tiến trình con chỉ gồm vài biến cần thiết,
 * không thừa hưởng biến môi trường của app.
 */
import * as path from 'path';
import * as fs from 'fs';
import type { PluginRuntimeHandle, RuntimeContext, RuntimeStats } from './PluginManager';

export interface ChildLike {
    readonly pid?: number;
    send(msg: any): void;
    onMessage(cb: (msg: any) => void): void;
    onExit(cb: (code: number | null) => void): void;
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
    kill(): void;
}

export type ForkFn = (workerPath: string, opts: { env: Record<string, string>; execArgv: string[]; serviceName: string }) => ChildLike;

export const TIMEOUTS = {
    activate: 15_000,
    deactivate: 5_000,
    node: 60_000,
    route: 30_000,
    schedule: 120_000,
    command: 30_000,
    ping: 10_000,
    default: 30_000,
};

const RESTART_DELAYS = [2_000, 10_000, 60_000];
const STABLE_RESET_MS = 10 * 60_000;
const PING_EVERY_MS = 30_000;

/** Biến môi trường tối thiểu cho tiến trình plugin (không lộ biến môi trường của app). */
export function pluginEnv(extra: Record<string, string>): Record<string, string> {
    const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS'];
    const env: Record<string, string> = {};
    for (const k of keep) {
        if (process.env[k] !== undefined) env[k] = String(process.env[k]);
    }
    return { ...env, NODE_ENV: 'production', ...extra };
}

/** Đường dẫn worker (đã unpack khỏi asar khi đóng gói). */
export function defaultWorkerPath(): string {
    const p = path.join(__dirname, 'plugin-worker.js');
    if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
        const unpacked = p.replace('app.asar', 'app.asar.unpacked');
        if (fs.existsSync(unpacked)) return unpacked;
    }
    return p;
}

export const forkNode: ForkFn = (workerPath, o) => {
    const cp = require('child_process');
    const child = cp.fork(workerPath, [], { env: o.env, execArgv: o.execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    return {
        get pid() { return child.pid; },
        send: (m: any) => { if (child.connected) child.send(m); },
        onMessage: cb => child.on('message', cb),
        onExit: cb => child.on('exit', (code: number | null) => cb(code)),
        stdout: child.stdout,
        stderr: child.stderr,
        kill: () => { try { child.kill(); } catch { /* đã thoát */ } },
    };
};

export const forkElectron: ForkFn = (workerPath, o) => {
    const { utilityProcess } = require('electron');
    const child = utilityProcess.fork(workerPath, [], { serviceName: o.serviceName, execArgv: o.execArgv, env: o.env, stdio: 'pipe' });
    return {
        get pid() { return child.pid; },
        send: (m: any) => { try { child.postMessage(m); } catch { /* đã thoát */ } },
        onMessage: cb => child.on('message', cb),
        onExit: cb => child.on('exit', (code: number) => cb(code)),
        stdout: child.stdout,
        stderr: child.stderr,
        kill: () => { try { child.kill(); } catch { /* đã thoát */ } },
    };
};

interface Pending {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
}

export class PluginSandbox implements PluginRuntimeHandle {
    private child: ChildLike | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private stopping = false;
    private crashes = 0;
    private restarts = 0;
    private startedAt = 0;
    private memoryMb: number | undefined;
    private lastError: string | undefined;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private pingFailures = 0;
    private init: { settings: Record<string, any>; prevVersion?: string } = { settings: {} };
    private readyWaiter: ((ok: boolean) => void) | null = null;

    constructor(
        private readonly ctx: RuntimeContext,
        private readonly opts: { fork?: ForkFn; workerPath?: string; restartDelays?: number[]; pingEveryMs?: number; execArgv?: string[] } = {},
    ) {}

    private spawn(): Promise<void> {
        const rec = this.ctx.record;
        const fork = this.opts.fork || forkElectron;
        const child = fork(this.opts.workerPath || defaultWorkerPath(), {
            serviceName: `deplao-plugin:${rec.id}`,
            execArgv: this.opts.execArgv || ['--max-old-space-size=256'],
            env: pluginEnv({
                DEPLAO_PLUGIN_ID: rec.id,
                DEPLAO_PLUGIN_DIR: rec.install_path,
                DEPLAO_PLUGIN_ENTRY: rec.manifest.backend?.entry || '',
                DEPLAO_PLUGIN_DATA_DIR: this.ctx.dataDir,
                DEPLAO_PLUGIN_DEV: rec.source_type === 'dev' ? '1' : '0',
            }),
        });
        this.child = child;
        this.startedAt = Date.now();
        const pipe = (stream: NodeJS.ReadableStream | null | undefined, level: 'info' | 'error') => {
            if (!stream) return;
            let buf = '';
            stream.on('data', (chunk: any) => {
                buf += String(chunk);
                const lines = buf.split(/\r?\n/);
                buf = lines.pop() || '';
                for (const line of lines) if (line.trim()) this.ctx.onLog(level, line.slice(0, 4000));
                if (buf.length > 8000) { this.ctx.onLog(level, buf.slice(0, 4000)); buf = ''; }
            });
        };
        pipe(child.stdout, 'info');
        pipe(child.stderr, 'error');
        child.onMessage(msg => this.onMessage(child, msg));
        child.onExit(code => this.onExit(child, code));
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.readyWaiter = null;
                reject(new Error('Tiến trình của ứng dụng không phản hồi khi khởi động'));
            }, TIMEOUTS.activate);
            this.readyWaiter = ok => {
                clearTimeout(timer);
                this.readyWaiter = null;
                if (ok) resolve();
                else reject(new Error(this.lastError || 'Tiến trình của ứng dụng thoát khi khởi động'));
            };
        });
    }

    private onMessage(child: ChildLike, msg: any): void {
        if (child !== this.child || !msg || typeof msg !== 'object') return;
        switch (msg.t) {
            case 'ready':
                this.readyWaiter?.(true);
                return;
            case 'res': {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                clearTimeout(p.timer);
                if (msg.error) {
                    const err: any = new Error(msg.error.message || 'Lỗi ứng dụng');
                    err.code = msg.error.code;
                    err.status = msg.error.status;
                    p.reject(err);
                } else {
                    p.resolve(msg.result);
                }
                return;
            }
            case 'call': {
                const id = msg.id;
                Promise.resolve()
                    .then(() => this.ctx.onRequest(String(msg.method), msg.params))
                    .then(result => child.send({ t: 'ret', id, result }))
                    .catch((err: any) => child.send({ t: 'ret', id, error: { code: err?.code || 'INTERNAL_ERROR', message: err?.message || String(err), status: err?.status, details: err?.details } }));
                return;
            }
            case 'log':
                this.ctx.onLog((['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'info') as any, String(msg.message || ''));
                return;
        }
    }

    private failAll(reason: string): void {
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(reason));
            this.pending.delete(id);
        }
    }

    private onExit(child: ChildLike, code: number | null): void {
        if (child !== this.child) return;
        this.child = null;
        this.stopPing();
        this.failAll(`Tiến trình của ứng dụng đã thoát (code ${code ?? '?'})`);
        if (this.readyWaiter) {
            // Chết khi đang khởi động: boot() sẽ reject, nơi gọi boot() quyết định thử lại.
            this.lastError = `Tiến trình của ứng dụng thoát khi khởi động (code ${code ?? '?'})`;
            this.readyWaiter(false);
            return;
        }
        this.scheduleRestart(`Crash (code ${code ?? '?'})`);
    }

    /** Điểm duy nhất hẹn khởi động lại (chốt bằng restartTimer → không bao giờ chạy 2 tiến trình). */
    private scheduleRestart(reason: string): void {
        if (this.stopping || this.restartTimer) return;
        if (this.startedAt && Date.now() - this.startedAt > STABLE_RESET_MS) this.crashes = 0;
        this.crashes++;
        this.lastError = reason;
        this.ctx.onLog('error', `${reason} — lần ${this.crashes}`);
        const delays = this.opts.restartDelays || RESTART_DELAYS;
        if (this.crashes > delays.length) {
            this.ctx.onFatal(`Ứng dụng lỗi ${this.crashes} lần liên tiếp: ${reason}`);
            return;
        }
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.stopping) return;
            this.restarts++;
            this.boot().catch(err => {
                const c = this.child;
                if (c) {
                    this.child = null; // exit của tiến trình cũ sẽ bị bỏ qua trong onExit
                    c.kill();
                }
                this.scheduleRestart(`Khởi động lại thất bại: ${err?.message || err}`);
            });
        }, delays[this.crashes - 1]);
    }

    private async boot(): Promise<void> {
        await this.spawn();
        await this.call('activate', this.init, TIMEOUTS.activate);
        this.startPing();
    }

    private startPing(): void {
        this.stopPing();
        const every = this.opts.pingEveryMs ?? PING_EVERY_MS;
        if (every <= 0) return;
        this.pingTimer = setInterval(() => {
            this.call('ping', {}, TIMEOUTS.ping)
                .then((r: any) => {
                    this.pingFailures = 0;
                    if (r?.rss) this.memoryMb = Math.round(r.rss / 1024 / 1024);
                })
                .catch(() => {
                    this.pingFailures++;
                    if (this.pingFailures >= 3 && this.child) {
                        this.ctx.onLog('error', 'Ứng dụng không phản hồi 3 lần ping → khởi động lại');
                        this.pingFailures = 0;
                        this.child.kill();
                    }
                });
        }, every);
        if (typeof (this.pingTimer as any).unref === 'function') (this.pingTimer as any).unref();
    }

    private stopPing(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
    }

    async start(init: { settings: Record<string, any>; prevVersion?: string }): Promise<void> {
        this.stopping = false;
        this.init = { settings: init.settings, prevVersion: init.prevVersion };
        try {
            await this.boot();
        } catch (err) {
            this.stopping = true;
            if (this.restartTimer) clearTimeout(this.restartTimer);
            this.restartTimer = null;
            const c = this.child;
            this.child = null;
            c?.kill();
            throw err;
        } finally {
            // prevVersion chỉ dùng cho lần bật đầu tiên sau cập nhật.
            this.init = { settings: init.settings };
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.stopPing();
        const child = this.child;
        if (!child) return;
        try {
            await this.call('deactivate', {}, TIMEOUTS.deactivate);
        } catch { /* hết giờ hoặc lỗi → vẫn kill */ }
        const exited = new Promise<void>(resolve => {
            const t = setTimeout(resolve, 2_000);
            child.onExit(() => { clearTimeout(t); resolve(); });
        });
        child.kill();
        await exited;
        if (this.child === child) this.child = null;
        this.failAll('Ứng dụng đã tắt');
    }

    call(method: string, params: any, timeoutMs = TIMEOUTS.default): Promise<any> {
        const child = this.child;
        if (!child) return Promise.reject(new Error('Ứng dụng không chạy'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(Object.assign(new Error(`Ứng dụng không trả lời "${method}" sau ${Math.round(timeoutMs / 1000)} giây`), { code: 'TIMEOUT', status: 504 }));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
            child.send({ t: 'req', id, method, params });
        });
    }

    notify(method: string, params: any): void {
        this.child?.send({ t: 'note', method, params });
    }

    stats(): RuntimeStats {
        return {
            running: !!this.child,
            pid: this.child?.pid,
            restarts: this.restarts,
            startedAt: this.startedAt || undefined,
            memoryMb: this.memoryMb,
            lastError: this.lastError,
        };
    }
}
