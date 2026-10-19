/**
 * netGuard.ts — gọi HTTP ra ngoài có chặn mạng nội bộ (chống SSRF).
 *
 * Dùng cho mọi request mà URL do bên ngoài cung cấp (tải file từ URL, webhook outbound).
 *  - IP được kiểm tra NGAY LÚC KẾT NỐI qua `lookup` của agent → không lách được bằng
 *    DNS rebinding (tên miền trả IP công khai lúc kiểm tra rồi IP nội bộ lúc kết nối).
 *  - Host là IP (http://10.0.0.1, http://2130706433 — URL đã chuẩn hoá về 127.0.0.1) được
 *    kiểm tra trước khi mở kết nối.
 *  - Redirect đi theo THỦ CÔNG, mỗi bước kiểm tra lại; sang origin khác thì bỏ header xác thực.
 *  - Agent keep-alive tách riêng cho "có chặn" và "cho phép nội bộ" (socket không dùng lẫn).
 */
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as net from 'net';

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

/** IP loopback / nội bộ / link-local / CGNAT / multicast / không xác định → true. */
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
        // "::" đầu = unspecified, loopback, IPv4-compatible/mapped dạng hex; fc/fd = ULA; fe8-fef = link/site-local; ff = multicast
        return v.startsWith('::') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe') || v.startsWith('ff');
    }
    return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

/** `lookup` cho net.connect: phân giải rồi từ chối nếu có bất kỳ IP nội bộ nào. */
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
            return cb(Object.assign(new Error(`Không phân giải được ${hostname}`), { code: 'ENOTFOUND' }));
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
    /** Tổng thời gian kể cả redirect và đọc body (mặc định 30 s). */
    timeoutMs?: number;
    /** true = cho phép đích nội bộ (chỉ khi người gọi là chính máy / người dùng cho phép). */
    allowPrivate?: boolean;
    /** 0 = không đi theo redirect (trả nguyên 3xx). Mặc định 5. */
    maxRedirects?: number;
}

export interface GuardedStream {
    status: number;
    headers: http.IncomingHttpHeaders;
    /** URL cuối cùng sau redirect. */
    url: string;
    stream: http.IncomingMessage;
    /** Gọi khi đọc xong (hoặc bỏ) body để huỷ hẹn giờ. */
    finish: () => void;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const AUTH_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-api-key'];

function hostOf(u: URL): string {
    return u.hostname.replace(/^\[|\]$/g, '');
}

/**
 * Mở request, trả về khi có header phản hồi. Body là stream — người gọi đọc rồi gọi `finish()`.
 * Hết giờ → stream bị huỷ với GuardTimeoutError.
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
                reject(new Error('Chỉ hỗ trợ http/https'));
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
    /** true nếu body dài hơn maxBytes và đã bị cắt. */
    truncated: boolean;
}

/** Như guardedOpen nhưng đọc body vào bộ nhớ, tối đa `maxBytes` (phần thừa bị bỏ, không lỗi). */
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

/** Đóng các socket keep-alive (khi dừng app / test). */
export function destroyGuardAgents(): void {
    for (const key of Object.keys(agents)) {
        try { agents[key].destroy(); } catch { /* ignore */ }
        delete agents[key];
    }
}

/** Chỉ dùng trong test. */
export const _internals = { agentFor };
