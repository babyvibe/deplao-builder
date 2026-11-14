/**
 * Download the `.db.crypt` backup file (URL taken from the syncmsg_info event).
 *
 * Follows the download request of Zalo PC (`handleCustomHeaders` in main-dist/main.js, option `cookies: true`):
 * sends ALL session cookies of the auth domain in the `cookie` header, plus no-cache headers; no
 * `Origin`/`Referer`. The header set below is the one PR #269 captured from Zalo (including the `Sec-Fetch-*` of Electron net).
 *
 * Does not use `fetch` (undici), because it always overrides `sec-fetch-mode: cors` and adds headers on its own → it cannot reproduce
 * the Zalo request. Uses `https.request` to control all the headers, and still goes through the account's proxy.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { tr } from '../../../shared/i18n';

/** Zalo domains: session cookies are only sent to these domains. */
export const ZALO_HOST_RE = /(^|\.)(zalo\.me|zaloapp\.com|zdn\.vn|zadn\.vn)$/i;

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60 * 1000;

export class DownloadAbortedError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}

export interface BackupDownloadOptions {
    url: string;
    userAgent: string;
    /** Session cookie (string `a=b; c=d`), only sent when the host belongs to Zalo. */
    sessionCookie: string;
    /** The account's proxy agent (zca-js ctx.options.agent), if any. */
    agent?: http.Agent;
    destPath: string;
    expectedSize?: number;
    onProgress?: (percent: number) => void;
    shouldAbort?: () => boolean;
    log?: (message: string) => void;
}

export function zaloDownloadHeaders(userAgent: string, cookie: string): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent': userAgent,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US',
        'Cache-Control': 'no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'none',
        Connection: 'keep-alive',
    };
    if (cookie) headers.Cookie = cookie;
    return headers;
}

function get(url: URL, headers: Record<string, string>, agent: http.Agent | undefined, redirectsLeft: number): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'http:' ? http : https;
        const req = lib.request(url, { method: 'GET', headers, agent }, res => {
            const status = res.statusCode || 0;
            const location = res.headers.location;
            if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
                res.resume();
                const next = new URL(location, url);
                const nextHeaders = { ...headers };
                if (!ZALO_HOST_RE.test(next.hostname)) delete nextHeaders.Cookie;
                get(next, nextHeaders, agent, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            resolve(res);
        });
        req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(tr('Máy chủ Zalo không phản hồi khi tải bản sao lưu'))));
        req.on('error', reject);
        req.end();
    });
}

function decoderFor(res: http.IncomingMessage): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
    switch (String(res.headers['content-encoding'] || '').toLowerCase()) {
        case 'gzip':
        case 'x-gzip':
            return zlib.createGunzip();
        case 'deflate':
            return zlib.createInflate();
        case 'br':
            return zlib.createBrotliDecompress();
        default:
            return null;
    }
}

/** Read at most `max` bytes of the error body, for logging / display. */
async function readSnippet(res: http.IncomingMessage, max = 1024): Promise<string> {
    const decoder = decoderFor(res);
    const body: Readable = decoder ? res.pipe(decoder) : res;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for await (const chunk of body) {
            chunks.push(chunk as Buffer);
            size += (chunk as Buffer).length;
            if (size >= max) break;
        }
    } catch { /* error body could not be read */ }
    res.destroy();
    return Buffer.concat(chunks).subarray(0, max).toString('utf8').replace(/\s+/g, ' ').trim();
}

/** Get the server's error message (JSON error_message if present). */
function serverMessage(snippet: string): string {
    try {
        const json = JSON.parse(snippet);
        const msg = json?.error_message || json?.message || json?.error;
        if (msg) return `: ${String(msg).slice(0, 120)}`;
    } catch { /* not JSON */ }
    return '';
}

export async function downloadBackupFile(opts: BackupDownloadOptions): Promise<{ bytes: number }> {
    let url: URL;
    try {
        url = new URL(opts.url);
    } catch {
        throw new Error(tr('Đường dẫn tải bản sao lưu không hợp lệ'));
    }
    if (url.protocol !== 'https:') throw new Error(tr('Đường dẫn tải bản sao lưu không hợp lệ'));

    const zaloHost = ZALO_HOST_RE.test(url.hostname);
    const cookies = zaloHost && opts.sessionCookie ? [opts.sessionCookie, ''] : [''];
    const where = `${url.host}${url.pathname}`;
    if (!zaloHost) opts.log?.(`host tải không thuộc Zalo (${url.host}) → không gửi cookie phiên`);

    let lastStatus = 0;
    let lastDetail = '';
    for (const cookie of cookies) {
        if (opts.shouldAbort?.()) throw new DownloadAbortedError();
        const res = await get(url, zaloDownloadHeaders(opts.userAgent, cookie), opts.agent, MAX_REDIRECTS);
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) return saveResponse(res, opts);

        lastStatus = status;
        lastDetail = await readSnippet(res);
        opts.log?.(`tải ${where} (${cookie ? 'cookie phiên' : 'không cookie'}) → HTTP ${status} `
            + `${res.headers['content-type'] || ''} ${lastDetail.slice(0, 300)}`);
        // Only try another way for 4xx errors (cookie/session); for 5xx/others, stop right away.
        if (status < 400 || status >= 500) break;
    }
    throw new Error(tr('Tải bản sao lưu thất bại (HTTP {{lastStatus}}{{v1}})', { lastStatus, v1: serverMessage(lastDetail) }));
}

async function saveResponse(res: http.IncomingMessage, opts: BackupDownloadOptions): Promise<{ bytes: number }> {
    const decoder = decoderFor(res);
    const expected = Number(opts.expectedSize) || 0;
    const total = expected || (decoder ? 0 : Number(res.headers['content-length']) || 0);
    let received = 0;
    const meter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
            if (opts.shouldAbort?.()) return cb(new DownloadAbortedError());
            received += chunk.length;
            if (total) opts.onProgress?.((received / total) * 100);
            cb(null, chunk);
        },
    });
    const out = fs.createWriteStream(opts.destPath);
    if (decoder) await pipeline(res, decoder, meter, out);
    else await pipeline(res, meter, out);
    if (expected && received !== expected) {
        opts.log?.(`kích thước tải về ${received} khác file_size ${expected}`);
    }
    return { bytes: received };
}
