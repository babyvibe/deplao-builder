/**
 * Tải file sao lưu `.db.crypt` (URL lấy từ sự kiện syncmsg_info).
 *
 * Bám theo request tải của Zalo PC (`handleCustomHeaders` trong main-dist/main.js, option `cookies: true`):
 * gửi TOÀN BỘ cookie phiên của domain xác thực trong header `cookie`, kèm header chống cache; không có
 * `Origin`/`Referer`. Bộ header bên dưới là bộ PR #269 bắt được từ Zalo (gồm `Sec-Fetch-*` của Electron net).
 *
 * Không dùng `fetch` (undici) vì nó luôn ghi đè `sec-fetch-mode: cors` và tự thêm header → không tái tạo
 * được request của Zalo. Dùng `https.request` để kiểm soát toàn bộ header, vẫn đi qua proxy của tài khoản.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

/** Domain của Zalo — chỉ gửi cookie phiên tới các domain này. */
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
    /** Cookie phiên (chuỗi `a=b; c=d`) — chỉ gửi khi host thuộc Zalo. */
    sessionCookie: string;
    /** Agent proxy của tài khoản (ctx.options.agent của zca-js), nếu có. */
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
        req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('Máy chủ Zalo không phản hồi khi tải bản sao lưu')));
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

/** Đọc tối đa `max` byte nội dung lỗi để ghi log/hiển thị. */
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
    } catch { /* nội dung lỗi không đọc được */ }
    res.destroy();
    return Buffer.concat(chunks).subarray(0, max).toString('utf8').replace(/\s+/g, ' ').trim();
}

/** Lấy thông báo lỗi của server (JSON error_message nếu có). */
function serverMessage(snippet: string): string {
    try {
        const json = JSON.parse(snippet);
        const msg = json?.error_message || json?.message || json?.error;
        if (msg) return `: ${String(msg).slice(0, 120)}`;
    } catch { /* không phải JSON */ }
    return '';
}

export async function downloadBackupFile(opts: BackupDownloadOptions): Promise<{ bytes: number }> {
    let url: URL;
    try {
        url = new URL(opts.url);
    } catch {
        throw new Error('Đường dẫn tải bản sao lưu không hợp lệ');
    }
    if (url.protocol !== 'https:') throw new Error('Đường dẫn tải bản sao lưu không hợp lệ');

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
        // Chỉ thử cách khác với lỗi 4xx (cookie/phiên); 5xx/khác thì dừng luôn.
        if (status < 400 || status >= 500) break;
    }
    throw new Error(`Tải bản sao lưu thất bại (HTTP ${lastStatus}${serverMessage(lastDetail)})`);
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
