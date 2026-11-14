/**
 * netGuard.ts: outbound HTTP calls that block the private network (anti-SSRF).
 *
 * Used for every request whose URL is supplied from outside (downloading a file from a URL, outbound webhooks).
 *  - The IP is checked AT CONNECT TIME through the agent's `lookup` → cannot be bypassed with
 *    DNS rebinding (a domain that returns a public IP at check time and a private IP at connect time).
 *  - A host given as an IP (http://10.0.0.1, or http://2130706433, which is normalized to 127.0.0.1) is
 *    checked before the connection is opened.
 *  - Redirects are followed MANUALLY, and each step is checked again; going to another origin drops the auth headers.
 *  - Keep-alive agents are kept separate for "blocked" and "private allowed" (sockets are never mixed).
 */
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as net from 'net';
import { tr } from '../../../shared/i18n';

export class BlockedAddressError extends Error {
    readonly code = 'PRIVATE_ADDRESS';
    constructor(readonly host: string) {
        super(`Địa chỉ ${host} thuộc mạng nội bộ — bị chặn`);
        this.name = 'BlockedAddressError';
    }
}

export class GuardTimeoutError extends Error {
    readonly code = 'TIMEOUT';
    constructor(ms: number) {
        super(`Quá thời gian ${Math.round(ms / 1000)}s`);
        this.name = 'GuardTimeoutError';
    }
}

/** Loopback / private / link-local / CGNAT / multicast / unknown IP → true. */
export function isPrivateAddress(ip: string): boolean {
    let v = String(ip || '').trim().toLowerCase();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
    const zone = v.indexOf('%');
    if (zone >= 0) v = v.slice(0, zone);
    if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7);
    if (net.isIPv4(v)) {
        const [a, b] = v.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
            || a >= 224;
    }
    if (net.isIPv6(v)) {
        // Leading "::" = unspecified, loopback, IPv4-compatible/mapped in hex form; fc/fd = ULA; fe8-fef = link/site-local; ff = multicast
        return v.startsWith('::') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe') || v.startsWith('ff');
    }
    return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

/** `lookup` for net.connect: resolves, then rejects if any IP is private. */
export function guardedLookup(hostname: string, options: any, callback?: LookupCallback): void {
    let cb = callback as LookupCallback;
    let opts = options;
    if (typeof options === 'function') {
        cb = options;
        opts = {};
    }
    dns.lookup(hostname, { ...(opts || {}), all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = (addresses as unknown as dns.LookupAddress[]) || [];
        if (list.length === 0) {
            return cb(Object.assign(new Error(tr('Không phân giải được {{hostname}}', { hostname })), { code: 'ENOTFOUND' }));
        }
        if (list.some(a => isPrivateAddress(a.address))) return cb(new BlockedAddressError(hostname));
        if (opts && opts.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    });
}

const agents: Record<string, http.Agent> = {};

function agentFor(isHttps: boolean, allowPrivate: boolean): http.Agent {
    const key = `${isHttps ? 's' : 'p'}${allowPrivate ? 'o' : 'g'}`;
    if (!agents[key]) {
        const opts: any = { keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 30_000 };
        if (!allowPrivate) opts.lookup = guardedLookup;
        agents[key] = isHttps ? new https.Agent(opts) : new http.Agent(opts);
    }
    return agents[key];
}

export interface GuardedRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    /** Total time including redirects and reading the body (default 30 s). */
    timeoutMs?: number;
    /** true = allow private destinations (only when the caller is the machine itself or the user allows it). */
    allowPrivate?: boolean;
    /** 0 = do not follow redirects (return the 3xx as is). Default 5. */
    maxRedirects?: number;
}

export interface GuardedStream {
    status: number;
    headers: http.IncomingHttpHeaders;
    /** Final URL after redirects. */
    url: string;
    stream: http.IncomingMessage;
    /** Called when the body is done being read (or dropped), to cancel the timer. */
    finish: () => void;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const AUTH_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-api-key'];

function hostOf(u: URL): string {
    return u.hostname.replace(/^\[|\]$/g, '');
}

/**
 * Open the request and return once the response headers arrive. The body is a stream: the caller reads it, then calls `finish()`.
 * On timeout → the stream is aborted with GuardTimeoutError.
 */
export function guardedOpen(rawUrl: string, opts: GuardedRequestOptions = {}): Promise<GuardedStream> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const maxRedirects = opts.maxRedirects ?? 5;
    const allowPrivate = !!opts.allowPrivate;
    let current: { destroy: (err?: Error) => void } | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        current?.destroy(new GuardTimeoutError(timeoutMs));
    }, timeoutMs);
    const finish = () => clearTimeout(timer);

    const openOnce = (u: URL, method: string, headers: Record<string, string>, body?: string | Buffer) =>
        new Promise<http.IncomingMessage>((resolve, reject) => {
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                reject(new Error(tr('Chỉ hỗ trợ http/https')));
                return;
            }
            const host = hostOf(u);
            if (!allowPrivate && (net.isIP(host) ? isPrivateAddress(host) : host === 'localhost' || host.endsWith('.localhost'))) {
                reject(new BlockedAddressError(host));
                return;
            }
            if (timedOut) {
                reject(new GuardTimeoutError(timeoutMs));
                return;
            }
            const isHttps = u.protocol === 'https:';
            const finalHeaders: Record<string, string> = { ...headers };
            if (body !== undefined && finalHeaders['Content-Length'] === undefined) {
                finalHeaders['Content-Length'] = String(Buffer.byteLength(body));
            }
            const req = (isHttps ? https : http).request(u, { method, headers: finalHeaders, agent: agentFor(isHttps, allowPrivate) }, res => {
                current = res;
                resolve(res);
            });
            current = req;
            req.on('error', err => reject(timedOut ? new GuardTimeoutError(timeoutMs) : err));
            if (body !== undefined) req.end(body);
            else req.end();
        });

    const run = async (): Promise<GuardedStream> => {
        let url = new URL(rawUrl);
        let method = (opts.method || 'GET').toUpperCase();
        let headers = { ...(opts.headers || {}) };
        let body = opts.body;
        for (let hop = 0; ; hop++) {
            const res = await openOnce(url, method, headers, body);
            const status = res.statusCode || 0;
            const location = res.headers.location;
            if (REDIRECT_CODES.has(status) && location && hop < maxRedirects) {
                res.resume();
                const next = new URL(location, url);
                if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
                    method = 'GET';
                    body = undefined;
                    headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)));
                }
                if (next.origin !== url.origin) {
                    headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !AUTH_HEADERS.includes(k.toLowerCase())));
                }
                url = next;
                continue;
            }
            return { status, headers: res.headers, url: url.toString(), stream: res, finish };
        }
    };

    return run().catch(err => {
        finish();
        throw err;
    });
}

export interface GuardedBufferResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    url: string;
    body: Buffer;
    /** true if the body was longer than maxBytes and was cut. */
    truncated: boolean;
}

/** Like guardedOpen, but reads the body into memory, up to `maxBytes` (extra bytes are dropped, no error). */
export async function guardedRequest(rawUrl: string, opts: GuardedRequestOptions & { maxBytes?: number } = {}): Promise<GuardedBufferResponse> {
    const maxBytes = opts.maxBytes ?? 64 * 1024;
    const r = await guardedOpen(rawUrl, opts);
    try {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        await new Promise<void>((resolve, reject) => {
            r.stream.on('data', (chunk: Buffer) => {
                if (truncated) return;
                const room = maxBytes - size;
                if (chunk.length > room) {
                    if (room > 0) chunks.push(chunk.subarray(0, room));
                    size = maxBytes;
                    truncated = true;
                    r.stream.destroy();
                    resolve();
                    return;
                }
                chunks.push(chunk);
                size += chunk.length;
            });
            r.stream.on('end', () => resolve());
            r.stream.on('close', () => resolve());
            r.stream.on('error', err => (truncated ? resolve() : reject(err)));
        });
        return { status: r.status, headers: r.headers, url: r.url, body: Buffer.concat(chunks), truncated };
    } finally {
        r.finish();
    }
}

/** Close the keep-alive sockets (when the app stops / in tests). */
export function destroyGuardAgents(): void {
    for (const key of Object.keys(agents)) {
        try { agents[key].destroy(); } catch { /* ignore */ }
        delete agents[key];
    }
}

/** Test only. */
export const _internals = { agentFor };
