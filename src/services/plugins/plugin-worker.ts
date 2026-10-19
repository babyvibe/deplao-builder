/**
 * plugin-worker — chạy backend của MỘT plugin trong tiến trình riêng.
 *
 * Electron: utilityProcess.fork (process.parentPort). Test: child_process.fork (process.send).
 * File này đứng một mình: chỉ dùng module có sẵn của Node (được unpack khỏi asar khi đóng gói).
 *
 * Giao thức (mọi message là object có t):
 *   host → worker  { t:'req', id, method, params }   activate | deactivate | node.execute | route.handle
 *                                                   | schedule.run | composer.command | ping
 *   worker → host  { t:'res', id, result } | { t:'res', id, error:{ code, message, status } }
 *   worker → host  { t:'call', id, method, params }  deplao.* (API, storage, log, events…)
 *   host → worker  { t:'ret', id, result } | { t:'ret', id, error }
 *   host → worker  { t:'note', method, params }     event | settings.changed
 *   worker → host  { t:'log', level, message }      console.* và deplao.log.*
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import * as path from 'path';
import { pathToFileURL } from 'url';

type Msg = { t: string; id?: number; method?: string; params?: any; result?: any; error?: any; level?: string; message?: string };

const parentPort: any = (process as any).parentPort;
const send = (msg: Msg): void => {
    try {
        if (parentPort) parentPort.postMessage(msg);
        else if (process.send) process.send(msg);
    } catch { /* host đã đóng */ }
};

const PLUGIN_ID = process.env.DEPLAO_PLUGIN_ID || '';
const PLUGIN_DIR = process.env.DEPLAO_PLUGIN_DIR || '';
const DATA_DIR = process.env.DEPLAO_PLUGIN_DATA_DIR || '';
const ENTRY = process.env.DEPLAO_PLUGIN_ENTRY || '';
const IS_DEV = process.env.DEPLAO_PLUGIN_DEV === '1';

// ── Nhật ký: console.* → host ───────────────────────────────────────────────
function fmt(args: any[]): string {
    return args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ').slice(0, 4000);
}
const log = (level: string, ...args: any[]) => send({ t: 'log', level, message: fmt(args) });
console.log = (...a: any[]) => log('info', ...a);
console.info = (...a: any[]) => log('info', ...a);
console.warn = (...a: any[]) => log('warn', ...a);
console.error = (...a: any[]) => log('error', ...a);
console.debug = (...a: any[]) => { if (IS_DEV) log('debug', ...a); };

// Plugin không được tự thoát tiến trình hay nạp Electron.
(process as any).exit = (code?: number) => { log('warn', `process.exit(${code ?? ''}) bị chặn trong plugin`); };
const Module: any = require('module');
const originalLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
    if (request === 'electron' || request === 'original-fs') throw new Error(`Plugin không được dùng module "${request}"`);
    return originalLoad.call(this, request, ...rest);
};

process.on('uncaughtException', err => log('error', 'uncaughtException:', err));
process.on('unhandledRejection', err => log('error', 'unhandledRejection:', err));

// ── Gọi host ────────────────────────────────────────────────────────────────
let nextCallId = 1;
const calls = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function hostCall(method: string, params?: any): Promise<any> {
    const id = nextCallId++;
    send({ t: 'call', id, method, params: params ?? {} });
    return new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
}

function toError(e: any): Error {
    const err: any = new Error(e?.message || 'Lỗi không rõ');
    err.code = e?.code;
    err.status = e?.status;
    err.details = e?.details;
    return err;
}

// ── SDK deplao.* cho backend ────────────────────────────────────────────────
const eventHandlers = new Map<string, Set<(ev: any) => void>>();
const settingsHandlers = new Set<(s: any) => void>();
let currentSettings: Record<string, any> = {};

function typeMatches(pattern: string, type: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
}

function resubscribe(): Promise<any> {
    const types = Array.from(eventHandlers.keys());
    if (!types.length) return hostCall('events.unsubscribe');
    return hostCall('events.subscribe', { types });
}

/** Hàm API trả data; danh sách có phân trang gắn thêm .pagination. */
async function api(method: string, params?: any): Promise<any> {
    const res = await hostCall(method, params);
    const data = res?.data;
    if (res && res.pagination && data && typeof data === 'object') {
        try { Object.defineProperty(data, 'pagination', { value: res.pagination, enumerable: false }); } catch { /* ignore */ }
    }
    return data;
}

const SPECIAL: Record<string, any> = {
    call: (operationId: string, params?: any) => api(operationId, params),
    api: {
        call: (operationId: string, params?: any) => api(operationId, params),
        request: (method: string, p: string, opts: { query?: any; body?: any } = {}) => api('api.request', { method, path: p, ...opts }),
    },
    storage: {
        get: (key: string) => hostCall('storage.get', { key }),
        set: (key: string, value: any) => hostCall('storage.set', { key, value }),
        delete: (key: string) => hostCall('storage.delete', { key }),
        list: (prefix = '', limit = 100) => hostCall('storage.list', { prefix, limit }),
        dataDir: () => DATA_DIR,
    },
    settings: {
        get: () => Promise.resolve({ ...currentSettings }),
        onChange: (cb: (s: any) => void) => { settingsHandlers.add(cb); return () => settingsHandlers.delete(cb); },
    },
    log: {
        debug: (...a: any[]) => hostCall('log.debug', { message: fmt(a) }),
        info: (...a: any[]) => hostCall('log.info', { message: fmt(a) }),
        warn: (...a: any[]) => hostCall('log.warn', { message: fmt(a) }),
        error: (...a: any[]) => hostCall('log.error', { message: fmt(a) }),
    },
    events: {
        on: (type: string, handler: (ev: any) => void) => {
            const set = eventHandlers.get(type) || new Set();
            set.add(handler);
            eventHandlers.set(type, set);
            void resubscribe().catch(err => log('error', 'events.on:', err?.message || err));
            return () => {
                set.delete(handler);
                if (!set.size) eventHandlers.delete(type);
                void resubscribe().catch(() => undefined);
            };
        },
        emit: (name: string, data?: any) => hostCall('events.emit', { name, data }),
    },
    workflow: {
        trigger: (type: string, payload?: any) => hostCall('workflow.trigger', { type, payload }),
    },
    http: {
        fetch: (url: string, init: any = {}) => hostCall('http.fetch', { url, init }),
    },
    media: {
        upload: (name: string, data: Buffer | string, mime = '') => hostCall('media.upload', {
            name, mime, dataBase64: Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(String(data)).toString('base64'),
        }),
    },
    system: {
        info: () => hostCall('system.info'),
    },
};

/** deplao.<nhóm>.<operationId>(params): nhóm chỉ để dễ đọc, tên hàm là operationId của API v1. */
const deplao: any = new Proxy(SPECIAL, {
    get(target, ns: string) {
        if (typeof ns !== 'string') return undefined;
        if (ns in target) return target[ns];
        return new Proxy({}, {
            get(_t, fn: string) {
                if (typeof fn !== 'string' || fn === 'then') return undefined;
                return (params?: any) => api(fn, params);
            },
        });
    },
});

// ── Backend của plugin ─────────────────────────────────────────────────────
let backend: any = null;

async function loadBackend(): Promise<any> {
    if (backend) return backend;
    const entry = path.resolve(PLUGIN_DIR, ENTRY);
    if (!entry.startsWith(path.resolve(PLUGIN_DIR) + path.sep)) throw new Error('backend.entry nằm ngoài thư mục plugin');
    let mod: any;
    if (entry.endsWith('.mjs')) mod = await import(pathToFileURL(entry).href);
    else mod = require(entry);
    backend = mod && mod.default && typeof mod.default === 'object' ? mod.default : mod;
    return backend;
}

function ctxFor(extra: Record<string, any> = {}) {
    return { deplao, pluginId: PLUGIN_ID, dataDir: DATA_DIR, dev: IS_DEV, settings: { ...currentSettings }, ...extra };
}

async function handle(method: string, params: any): Promise<any> {
    switch (method) {
        case 'ping':
            return { rss: process.memoryUsage().rss, uptime: process.uptime() };
        case 'activate': {
            currentSettings = params?.settings || {};
            const b = await loadBackend();
            if (typeof b?.activate === 'function') await b.activate(ctxFor());
            if (params?.prevVersion && typeof b?.onUpgrade === 'function') await b.onUpgrade(params.prevVersion, ctxFor());
            return { ok: true, nodes: Object.keys(b?.nodes || {}), routes: Object.keys(b?.routes || {}), handlers: Object.keys(b?.handlers || {}) };
        }
        case 'deactivate': {
            if (backend && typeof backend.deactivate === 'function') await backend.deactivate(ctxFor());
            return { ok: true };
        }
        case 'node.execute': {
            const b = await loadBackend();
            const fn = b?.nodes?.[params?.type];
            if (typeof fn !== 'function') throw Object.assign(new Error(`Backend không có nodes["${params?.type}"]`), { code: 'PLUGIN_NODE_MISSING' });
            return (await fn(params?.cfg || {}, params?.run || {}, ctxFor())) ?? {};
        }
        case 'route.handle': {
            const b = await loadBackend();
            const key = `${params?.method} ${params?.path}`;
            const fn = b?.routes?.[key];
            if (typeof fn !== 'function') return { status: 404, body: { error: `Backend không có routes["${key}"]` } };
            const out = await fn(params?.req || {}, ctxFor());
            if (out && typeof out === 'object' && 'status' in out) return out;
            return { status: 200, body: out ?? null };
        }
        case 'schedule.run': {
            const b = await loadBackend();
            const fn = b?.handlers?.[params?.handler];
            if (typeof fn !== 'function') throw new Error(`Backend không có handlers["${params?.handler}"]`);
            await fn(ctxFor({ scheduleId: params?.id }));
            return { ok: true };
        }
        case 'composer.command': {
            const b = await loadBackend();
            const fn = b?.commands?.[params?.id];
            if (typeof fn !== 'function') throw new Error(`Backend không có commands["${params?.id}"]`);
            return (await fn(params?.context || {}, ctxFor())) ?? null;
        }
        default:
            throw new Error(`Phương thức không hỗ trợ: ${method}`);
    }
}

function onNote(method: string, params: any): void {
    if (method === 'event') {
        for (const [pattern, set] of eventHandlers) {
            if (!typeMatches(pattern, String(params?.type || ''))) continue;
            for (const h of set) {
                try { Promise.resolve(h(params)).catch(err => log('error', 'event handler:', err)); } catch (err) { log('error', 'event handler:', err); }
            }
        }
    } else if (method === 'settings.changed') {
        currentSettings = params || {};
        for (const h of settingsHandlers) {
            try { h({ ...currentSettings }); } catch (err) { log('error', 'settings.onChange:', err); }
        }
        if (backend && typeof backend.onSettingsChanged === 'function') {
            Promise.resolve(backend.onSettingsChanged({ ...currentSettings }, ctxFor())).catch((err: any) => log('error', 'onSettingsChanged:', err));
        }
    }
}

function onMessage(raw: any): void {
    const msg: Msg = raw && typeof raw === 'object' && 'data' in raw && parentPort ? raw.data : raw;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'req' && typeof msg.id === 'number') {
        const id = msg.id;
        handle(String(msg.method), msg.params)
            .then(result => send({ t: 'res', id, result }))
            .catch((err: any) => send({ t: 'res', id, error: { code: err?.code || 'PLUGIN_ERROR', message: err?.message || String(err), status: err?.status } }));
    } else if (msg.t === 'ret' && typeof msg.id === 'number') {
        const call = calls.get(msg.id);
        if (!call) return;
        calls.delete(msg.id);
        if (msg.error) call.reject(toError(msg.error));
        else call.resolve(msg.result);
    } else if (msg.t === 'note') {
        onNote(String(msg.method), msg.params);
    }
}

if (parentPort) parentPort.on('message', onMessage);
else process.on('message', onMessage);

send({ t: 'ready' });
