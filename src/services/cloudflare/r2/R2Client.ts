/**
 * R2Client — client S3 cho MỘT bucket R2 (ký SigV4 tự viết trong ./sigv4, fetch toàn cục, không AWS SDK).
 *
 *  - Endpoint https://<accountId>.r2.cloudflarestorage.com, region 'auto', path-style /<bucket>/<key>
 *    (mỗi đoạn của key được URI-encode một lần theo SigV4, giữ '/').
 *  - Khoá S3 suy ra từ API token (tài liệu R2): accessKeyId = id của token (tokens/verify),
 *    secretAccessKey = sha256(token) dạng hex. Không log token / khoá.
 *  - putFile: ≤ 64 MiB → một PUT stream (UNSIGNED-PAYLOAD, có Content-Length); > 64 MiB → multipart
 *    (phần 16 MiB bằng nhau, phần cuối nhỏ hơn; mỗi phần thử lại 3 lần; lỗi → AbortMultipartUpload).
 *  - Lỗi: 429/5xx → CloudError('R2_BUSY', …, retryAfterMs) để hàng đợi phía trên lùi chung; lỗi mạng →
 *    'R2_NETWORK' (cũng có retryAfterMs); 403 NotEntitled/10042 → 'R2_NOT_ENABLED'; 412 (If-None-Match) → 'R2_EXISTS'.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { CloudError, R2Client, R2ObjectInfo, R2OpClass, R2PutOptions } from '../contracts';
import { parseRetryAfterMs } from '../CloudflareApi';
import {
    EMPTY_SHA256, SigV4Credentials, UNSIGNED_PAYLOAD, presignUrl, sha256Hex, signRequest, uriEncode, uriEncodePath,
} from './sigv4';

export const R2_REGION = 'auto';
export const R2_SINGLE_PUT_MAX = 64 * 1024 * 1024;
export const R2_PART_SIZE = 16 * 1024 * 1024;
export const R2_MAX_PARTS = 10_000;
export const R2_PRESIGN_MAX_SEC = 900;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const BUSY_WAIT_429_MS = 30_000;
const BUSY_WAIT_5XX_MS = 10_000;
const NETWORK_WAIT_MS = 15_000;
const PART_BACKOFF_MS = [1000, 3000, 9000];
const MAX_METADATA_BYTES = 8 * 1024;

/** Khoá S3 của R2 suy ra từ API token. */
export function r2CredentialsFromToken(tokenId: string, token: string): SigV4Credentials {
    return { accessKeyId: tokenId, secretAccessKey: createHash('sha256').update(token, 'utf8').digest('hex') };
}

// ─── Kiểu fetch tối thiểu ────────────────────────────────────────────────────

export interface R2FetchResponse {
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    body: any;
}
export type R2Fetch = (url: string, init: any) => Promise<R2FetchResponse>;

export interface R2ClientOptions {
    bucket: string;
    getAccountId: () => string | null;
    getCredentials: () => SigV4Credentials | null;
    fetchImpl?: R2Fetch;
    /** Đổi endpoint (test). Mặc định `${accountId}.r2.cloudflarestorage.com`. */
    endpointHost?: (accountId: string) => string;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    /** Request nhỏ (HEAD/DELETE/List/PUT buffer): tổng thời gian tối đa. Mặc định 30 s. */
    timeoutMs?: number;
    /** Truyền file: huỷ khi không có byte nào trong N ms. Mặc định 60 s. */
    idleTimeoutMs?: number;
    singlePutMax?: number;
    partSize?: number;
    /** Số lần thử lại mỗi phần multipart (mặc định 3). */
    partRetries?: number;
    /** Số phần multipart gửi cùng lúc (mặc định 3, tối đa 8). */
    partConcurrency?: number;
    /** Đếm thao tác theo bảng giá R2 (Class A / B / miễn phí) + byte — gọi sau mỗi request tới được R2. Không ném. */
    onOp?: (op: R2OpClass, bytes: { up?: number; down?: number }) => void;
}

// ─── XML tối giản ────────────────────────────────────────────────────────────

export function xmlUnescape(s: string): string {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, ent: string) => {
        if (ent === 'amp') return '&';
        if (ent === 'lt') return '<';
        if (ent === 'gt') return '>';
        if (ent === 'quot') return '"';
        if (ent === 'apos') return "'";
        const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function xmlTag(xml: string, tag: string): string | null {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
    return m ? xmlUnescape(m[1]) : null;
}

export function xmlBlocks(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) out.push(m[1]);
    return out;
}

/** Phân tích ListObjectsV2 (ListBucketResult). */
export function parseListObjectsXml(xml: string): { objects: R2ObjectInfo[]; nextToken: string | null } {
    const objects: R2ObjectInfo[] = xmlBlocks(xml, 'Contents').map(block => ({
        key: xmlTag(block, 'Key') || '',
        size: Number(xmlTag(block, 'Size') || 0) || 0,
        etag: cleanEtag(xmlTag(block, 'ETag')),
        lastModified: Date.parse(xmlTag(block, 'LastModified') || '') || 0,
    })).filter(o => o.key);
    const truncated = (xmlTag(xml, 'IsTruncated') || '').trim().toLowerCase() === 'true';
    const next = xmlTag(xml, 'NextContinuationToken');
    return { objects, nextToken: truncated && next ? next : null };
}

function cleanEtag(v: string | null | undefined): string {
    return String(v || '').trim().replace(/^W\//, '').replace(/^"+|"+$/g, '');
}

/** Số khoá tối đa mỗi request DeleteObjects (giới hạn của S3 / R2). */
export const R2_DELETE_MAX_KEYS = 1000;

/** Thân request DeleteObjects, chế độ Quiet (chỉ trả về khoá lỗi). */
export function deleteObjectsXml(keys: string[]): string {
    return '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>'
        + keys.map(k => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')
        + '</Delete>';
}

/**
 * Phân tích kết quả DeleteObjects: lỗi từng khoá (NoSuchKey = coi như đã xoá). 200 mà thân là <Error> không thuộc
 * <DeleteResult> = lỗi cả request → ném (không coi là đã xoá).
 */
export function parseDeleteObjectsXml(xml: string): Array<{ key: string; code: string; message: string }> {
    const text = String(xml || '');
    if (!/<DeleteResult[\s>/]/.test(text) && /<Error[\s>]/.test(text)) {
        throw mapR2Error(500, xmlTag(text, 'Code') || '', xmlTag(text, 'Message') || '', null);
    }
    return xmlBlocks(text, 'Error')
        .map(b => ({ key: xmlTag(b, 'Key') || '', code: xmlTag(b, 'Code') || '', message: xmlTag(b, 'Message') || '' }))
        .filter(e => e.key && e.code !== 'NoSuchKey');
}

// ─── Lỗi ─────────────────────────────────────────────────────────────────────

/** HTTP status + mã lỗi S3 (<Code>) → CloudError. */
export function mapR2Error(status: number, code: string, message: string, retryAfter: string | null, nowMs: number = Date.now()): CloudError {
    if (status === 429 || status >= 500) {
        const retryAfterMs = parseRetryAfterMs(retryAfter, nowMs) ?? (status === 429 ? BUSY_WAIT_429_MS : BUSY_WAIT_5XX_MS);
        return new CloudError(
            'R2_BUSY',
            status === 429 ? 'R2 đang giới hạn tốc độ, sẽ thử lại sau' : `R2 đang lỗi tạm thời (HTTP ${status}), sẽ thử lại sau`,
            status,
            retryAfterMs,
        );
    }
    if (code === 'NotEntitled' || code === '10042' || /\b10042\b|enable R2/i.test(message)) {
        return new CloudError('R2_NOT_ENABLED', 'Tài khoản Cloudflare chưa bật R2', status);
    }
    if (code === 'RequestTimeTooSkewed') {
        return new CloudError('R2_CLOCK_SKEW', 'Đồng hồ máy lệch nhiều so với giờ chuẩn — hãy chỉnh lại giờ hệ thống', status);
    }
    if (status === 401 || status === 403) {
        return new CloudError('R2_FORBIDDEN', 'Token không có quyền R2 (cần quyền "Account · Workers R2 Storage · Edit")', status);
    }
    if (status === 404 && code === 'NoSuchBucket') return new CloudError('R2_NO_BUCKET', 'Bucket R2 không tồn tại', status);
    if (status === 404 && code === 'NoSuchUpload') return new CloudError('R2_NO_UPLOAD', 'Phiên tải lên nhiều phần đã hết hạn', status);
    if (status === 404) return new CloudError('R2_NOT_FOUND', 'Không có dữ liệu này trên R2', status);
    if (status === 412) return new CloudError('R2_EXISTS', 'Dữ liệu đã có trên R2', status);
    return new CloudError('R2_ERROR', `R2 báo lỗi${code ? ` ${code}` : ''} (HTTP ${status})`, status);
}

function networkError(err: any, timedOut: boolean): CloudError {
    if (err instanceof CloudError) return err;
    if (timedOut) return new CloudError('R2_TIMEOUT', 'R2 phản hồi quá lâu, sẽ thử lại sau', undefined, NETWORK_WAIT_MS);
    const reason = String(err?.cause?.code || err?.code || err?.cause?.message || err?.message || 'lỗi mạng').slice(0, 120);
    return new CloudError('R2_NETWORK', `Không kết nối được R2 (${reason})`, undefined, NETWORK_WAIT_MS);
}

function isRetryable(err: unknown): boolean {
    return err instanceof CloudError && (err.code === 'R2_BUSY' || err.code === 'R2_NETWORK' || err.code === 'R2_TIMEOUT');
}

// ─── Hẹn giờ huỷ ─────────────────────────────────────────────────────────────

/** AbortController + hẹn giờ; touch() gia hạn (dùng làm idle-timeout khi truyền file). */
class Watchdog {
    readonly controller = new AbortController();
    timedOut = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly ms: number) {
        this.touch();
    }

    touch(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timedOut = true;
            this.controller.abort();
        }, this.ms);
    }

    done(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}

async function drainBody(res: R2FetchResponse): Promise<void> {
    try { await res.text(); } catch { /* bỏ qua */ }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let i = 0; ; i++) {
        try {
            await fs.promises.rename(from, to);
            return;
        } catch (err: any) {
            if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
            await new Promise(r => setTimeout(r, 100 * (i + 1)));
        }
    }
}

/**
 * Loại thao tác theo bảng giá R2 (developers.cloudflare.com/r2/pricing): Class A = PutObject, UploadPart,
 * Create/CompleteMultipartUpload, ListObjects; Class B = GetObject, HeadObject; miễn phí = DeleteObject,
 * AbortMultipartUpload. DeleteObjects (POST ?delete) không có trong bảng → tính Class A cho chắc (ước tính không thấp).
 */
export function classifyR2Request(req: { method: string; key: string | null; query?: Record<string, unknown> }): R2OpClass {
    const q = req.query || {};
    switch (req.method) {
        case 'HEAD':
            return 'B';
        case 'GET':
            return req.key === null || 'list-type' in q ? 'A' : 'B';
        case 'DELETE':
            return 'free';
        default:
            return 'A';
    }
}

interface R2Request {
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
    /** null = cấp bucket. */
    key: string | null;
    query?: Record<string, string | number | undefined>;
    headers?: Record<string, string | undefined>;
    body?: Buffer | AsyncIterable<Buffer> | null;
    payloadHash?: string;
    /** Bắt buộc khi body là stream. */
    contentLength?: number;
}

/** Tuỳ chọn putFile: tiến độ (byte đã gửi) + báo thử lại từng phần (multipart). */
type PutFileOptions = R2PutOptions & {
    onProgress?: (sentBytes: number, totalBytes: number) => void;
    onRetry?: (info: { part: number | null; attempt: number; maxAttempts: number; error: string }) => void;
};

// ─── Client ──────────────────────────────────────────────────────────────────

export class R2BucketClient implements R2Client {
    readonly bucket: string;
    private readonly timeoutMs: number;
    private readonly idleTimeoutMs: number;
    private readonly singlePutMax: number;
    private readonly partSize: number;
    private readonly partRetries: number;
    private readonly partConcurrency: number;

    constructor(private readonly opts: R2ClientOptions) {
        this.bucket = opts.bucket;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        this.singlePutMax = opts.singlePutMax ?? R2_SINGLE_PUT_MAX;
        this.partSize = opts.partSize ?? R2_PART_SIZE;
        this.partRetries = opts.partRetries ?? 3;
        this.partConcurrency = Math.max(1, Math.min(8, Math.floor(Number(opts.partConcurrency) || 3)));
    }

    // ── API công khai ──

    async putObject(key: string, body: Buffer | string, opts: R2PutOptions = {}): Promise<{ etag: string }> {
        const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
        const res = await this.call({ method: 'PUT', key: this.checkKey(key), body: buf, headers: this.putHeaders(opts) }, this.timeoutMs);
        return { etag: cleanEtag(res.headers.get('etag')) };
    }

    async putFile(
        key: string,
        filePath: string,
        opts: PutFileOptions = {},
    ): Promise<{ etag: string; size: number }> {
        this.checkKey(key);
        const st = await fs.promises.stat(filePath);
        if (!st.isFile()) throw new CloudError('R2_BAD_FILE', `Không phải file: ${path.basename(filePath)}`);
        const size = st.size;
        if (size <= this.singlePutMax) {
            const etag = await this.putFileSingle(key, filePath, size, opts);
            return { etag, size };
        }
        const etag = await this.putFileMultipart(key, filePath, size, opts);
        return { etag, size };
    }

    async getObject(key: string): Promise<Buffer | null> {
        const wd = new Watchdog(this.idleTimeoutMs);
        try {
            const res = await this.send({ method: 'GET', key: this.checkKey(key) }, wd);
            if (res.status === 404) {
                await this.throwIfNotObject404(res);
                return null;
            }
            if (res.status < 200 || res.status >= 300) throw await this.errorFrom(res, 'GET');
            try {
                return Buffer.from(await res.arrayBuffer());
            } catch (err) {
                throw networkError(err, wd.timedOut);
            }
        } finally {
            wd.done();
        }
    }

    async getObjectToFile(key: string, filePath: string): Promise<{ size: number; etag: string } | null> {
        const wd = new Watchdog(this.idleTimeoutMs);
        try {
            const res = await this.send({ method: 'GET', key: this.checkKey(key) }, wd);
            if (res.status === 404) {
                await this.throwIfNotObject404(res);
                return null;
            }
            if (res.status < 200 || res.status >= 300) throw await this.errorFrom(res, 'GET');
            if (!res.body) throw new CloudError('R2_ERROR', 'R2 trả về nội dung rỗng');

            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const tmp = `${filePath}.r2tmp-${randomBytes(4).toString('hex')}`;
            let size = 0;
            const counter = new Transform({
                transform(chunk: Buffer, _enc, cb) {
                    size += chunk.length;
                    wd.touch();
                    cb(null, chunk);
                },
            });
            try {
                const source = typeof res.body?.getReader === 'function' ? Readable.fromWeb(res.body) : (res.body as Readable);
                await pipeline(source, counter, fs.createWriteStream(tmp));
                const expected = Number(res.headers.get('content-length'));
                if (!res.headers.get('content-encoding') && Number.isFinite(expected) && expected > 0 && expected !== size) {
                    throw new CloudError('R2_NETWORK', 'Tải từ R2 bị đứt giữa chừng', undefined, NETWORK_WAIT_MS);
                }
                await renameWithRetry(tmp, filePath);
            } catch (err) {
                await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
                throw networkError(err, wd.timedOut);
            }
            return { size, etag: cleanEtag(res.headers.get('etag')) };
        } finally {
            wd.done();
        }
    }

    async headObject(key: string): Promise<R2ObjectInfo | null> {
        const k = this.checkKey(key);
        const wd = new Watchdog(this.timeoutMs);
        try {
            const res = await this.send({ method: 'HEAD', key: k }, wd);
            if (res.status === 404) return null;
            if (res.status < 200 || res.status >= 300) throw await this.errorFrom(res, 'HEAD');
            return {
                key: k,
                size: Number(res.headers.get('content-length') || 0) || 0,
                etag: cleanEtag(res.headers.get('etag')),
                lastModified: Date.parse(res.headers.get('last-modified') || '') || 0,
            };
        } finally {
            wd.done();
        }
    }

    async deleteObject(key: string): Promise<void> {
        const wd = new Watchdog(this.timeoutMs);
        try {
            const res = await this.send({ method: 'DELETE', key: this.checkKey(key) }, wd);
            if (res.status === 404) {
                await drainBody(res);
                return;
            }
            if (res.status < 200 || res.status >= 300) throw await this.errorFrom(res, 'DELETE');
            await drainBody(res);
        } finally {
            wd.done();
        }
    }

    /**
     * DeleteObjects (POST /<bucket>?delete): ≤ 1000 khoá một request, Quiet, kèm Content-MD5 (S3 bắt buộc).
     * deleted = các khoá không có trong danh sách lỗi; lỗi cả request ném CloudError (R2_BUSY khi 429/5xx…).
     */
    async deleteObjects(keys: string[]): Promise<{ deleted: string[]; errors: Array<{ key: string; code: string; message: string }> }> {
        const list = Array.from(new Set((keys || []).map(k => this.checkKey(k))));
        if (!list.length) return { deleted: [], errors: [] };
        if (list.length > R2_DELETE_MAX_KEYS) throw new CloudError('R2_BAD_REQUEST', `Xoá tối đa ${R2_DELETE_MAX_KEYS} object mỗi lần`);
        const body = Buffer.from(deleteObjectsXml(list), 'utf8');
        const res = await this.call({
            method: 'POST',
            key: null,
            query: { delete: '' },
            body,
            headers: {
                'content-type': 'application/xml',
                'content-md5': createHash('md5').update(body).digest('base64'),
            },
        }, Math.max(this.timeoutMs, 60_000), true);
        const errors = parseDeleteObjectsXml(await res.text());
        const failed = new Set(errors.map(e => e.key));
        return { deleted: list.filter(k => !failed.has(k)), errors };
    }

    async listObjects(prefix: string, opts: { continuationToken?: string; maxKeys?: number } = {}): Promise<{ objects: R2ObjectInfo[]; nextToken: string | null }> {
        const maxKeys = Math.min(1000, Math.max(1, Math.floor(opts.maxKeys ?? 1000)));
        const res = await this.call({
            method: 'GET',
            key: null,
            query: {
                'list-type': '2',
                prefix: prefix || undefined,
                'max-keys': maxKeys,
                'continuation-token': opts.continuationToken || undefined,
            },
        }, this.timeoutMs, true);
        const xml = await res.text();
        return parseListObjectsXml(xml);
    }

    presignGet(key: string, expiresSec: number = R2_PRESIGN_MAX_SEC): string {
        const k = this.checkKey(key);
        const { accountId, creds } = this.requireAuth();
        const expires = Math.min(R2_PRESIGN_MAX_SEC, Math.max(1, Math.floor(Number(expiresSec) || R2_PRESIGN_MAX_SEC)));
        return presignUrl({
            method: 'GET',
            host: this.host(accountId),
            path: this.objectPath(k),
            region: R2_REGION,
            service: 's3',
            date: this.now(),
            expiresSec: expires,
        }, creds);
    }

    // ── Tải lên ──

    private async putFileSingle(key: string, filePath: string, size: number, opts: R2PutOptions & { onProgress?: (s: number, t: number) => void }): Promise<string> {
        const wd = new Watchdog(this.idleTimeoutMs);
        try {
            const body = this.fileSlice(filePath, 0, size, wd, sent => opts.onProgress?.(sent, size));
            const res = await this.send({
                method: 'PUT',
                key,
                body,
                contentLength: size,
                payloadHash: UNSIGNED_PAYLOAD,
                headers: this.putHeaders(opts),
            }, wd);
            if (res.status < 200 || res.status >= 300) throw await this.errorFrom(res, 'PUT');
            await drainBody(res);
            if (size === 0) opts.onProgress?.(0, 0);
            return cleanEtag(res.headers.get('etag'));
        } finally {
            wd.done();
        }
    }

    private async putFileMultipart(key: string, filePath: string, size: number, opts: PutFileOptions): Promise<string> {
        if (opts.ifNoneMatch === '*') {
            // Không tải 64+ MiB vô ích: kiểm tra trước (HEAD rẻ), CompleteMultipartUpload vẫn gửi If-None-Match.
            if (await this.headObject(key)) throw new CloudError('R2_EXISTS', 'Dữ liệu đã có trên R2', 412);
        }
        let partSize = this.partSize;
        while (Math.ceil(size / partSize) > R2_MAX_PARTS) partSize *= 2;
        const partCount = Math.ceil(size / partSize);

        const uploadId = await this.createMultipart(key, opts);
        const parts: Array<{ partNumber: number; etag: string }> = [];
        // Gửi tối đa partConcurrency phần cùng lúc (đường truyền có độ trễ cao lên nhanh hơn hẳn gửi tuần tự).
        // Tiến độ = tổng byte đã gửi của mọi phần (phần gửi lại thì đếm lại từ 0).
        const sentByPart = new Map<number, number>();
        const report = () => {
            if (!opts.onProgress) return;
            let sent = 0;
            for (const v of sentByPart.values()) sent += v;
            try { opts.onProgress(Math.min(sent, size), size); } catch { /* callback lỗi không làm hỏng tải lên */ }
        };
        try {
            let next = 1;
            let failed: unknown = null;
            const lanes = Array.from({ length: Math.max(1, Math.min(this.partConcurrency, partCount)) }, async () => {
                while (!failed && next <= partCount) {
                    const n = next++;
                    const start = (n - 1) * partSize;
                    const end = Math.min(size, start + partSize);
                    try {
                        const etag = await this.uploadPartWithRetry(
                            key, uploadId, n, filePath, start, end, sentInPart => { sentByPart.set(n, sentInPart); report(); }, opts.onRetry,
                        );
                        sentByPart.set(n, end - start);
                        parts.push({ partNumber: n, etag });
                    } catch (err) {
                        if (!failed) failed = err;
                    }
                }
            });
            await Promise.all(lanes);
            if (failed) throw failed;
            parts.sort((a, b) => a.partNumber - b.partNumber);
            report();
            return await this.completeMultipart(key, uploadId, parts, opts);
        } catch (err) {
            await this.abortMultipart(key, uploadId).catch(() => undefined);
            throw err;
        }
    }

    private async createMultipart(key: string, opts: R2PutOptions): Promise<string> {
        const headers = this.putHeaders(opts);
        delete headers['if-none-match'];
        const res = await this.call({ method: 'POST', key, query: { uploads: '' }, headers }, this.timeoutMs, true);
        const xml = await res.text();
        const uploadId = xmlTag(xml, 'UploadId');
        if (!uploadId) throw new CloudError('R2_ERROR', 'R2 không trả về mã phiên tải lên nhiều phần');
        return uploadId;
    }

    private async uploadPartWithRetry(
        key: string, uploadId: string, partNumber: number, filePath: string, start: number, end: number,
        onSent: (sentInPart: number) => void,
        onRetry?: PutFileOptions['onRetry'],
    ): Promise<string> {
        let lastErr: unknown = null;
        for (let attempt = 0; attempt <= this.partRetries; attempt++) {
            try {
                return await this.uploadPart(key, uploadId, partNumber, filePath, start, end, onSent);
            } catch (err) {
                lastErr = err;
                if (!isRetryable(err) || attempt >= this.partRetries) throw err;
                try {
                    onRetry?.({
                        part: partNumber,
                        attempt: attempt + 1,
                        maxAttempts: this.partRetries,
                        error: String((err as Error)?.message || err),
                    });
                } catch { /* callback lỗi không làm hỏng tải lên */ }
                const hinted = err instanceof CloudError && err.retryAfterMs ? Math.min(err.retryAfterMs, 30_000) : 0;
                await this.sleep(Math.max(hinted, PART_BACKOFF_MS[Math.min(attempt, PART_BACKOFF_MS.length - 1)]));
            }
        }
        throw lastErr;
    }

    private async uploadPart(
        key: string, uploadId: string, partNumber: number, filePath: string, start: number, end: number,
        onSent: (sentInPart: number) => void,
    ): Promise<string> {
        const wd = new Watchdog(this.idleTimeoutMs);
        try {
            const res = await this.send({
                method: 'PUT',
                key,
                query: { partNumber, uploadId },
                body: this.fileSlice(filePath, start, end, wd, onSent),
                contentLength: end - start,
                payloadHash: UNSIGNED_PAYLOAD,
            }, wd);
            if (res.status < 200 || res.status >= 300) throw await this.errorFrom(res, 'UploadPart');
            await drainBody(res);
            const etag = res.headers.get('etag');
            if (!etag) throw new CloudError('R2_ERROR', 'R2 không trả về ETag của phần tải lên');
            return cleanEtag(etag);
        } finally {
            wd.done();
        }
    }

    private async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, opts: R2PutOptions): Promise<string> {
        const xmlBody = Buffer.from(
            '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            + parts.map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${xmlEscape(p.etag)}"</ETag></Part>`).join('')
            + '</CompleteMultipartUpload>',
            'utf8',
        );
        const res = await this.call({
            method: 'POST',
            key,
            query: { uploadId },
            body: xmlBody,
            headers: {
                'content-type': 'application/xml',
                'if-none-match': opts.ifNoneMatch === '*' ? '*' : undefined,
            },
        }, Math.max(this.timeoutMs, 120_000), true);
        const xml = await res.text();
        // S3 có thể trả 200 kèm <Error> cho CompleteMultipartUpload.
        if (/<Error[\s>]/.test(xml)) {
            throw mapR2Error(500, xmlTag(xml, 'Code') || '', xmlTag(xml, 'Message') || '', null);
        }
        return cleanEtag(xmlTag(xml, 'ETag') || res.headers.get('etag'));
    }

    private async abortMultipart(key: string, uploadId: string): Promise<void> {
        const wd = new Watchdog(this.timeoutMs);
        try {
            const res = await this.send({ method: 'DELETE', key, query: { uploadId } }, wd);
            await drainBody(res);
        } finally {
            wd.done();
        }
    }

    /** Đọc [start, end) của file theo khối 256 KiB; mỗi khối gia hạn watchdog và báo tiến độ. */
    private fileSlice(filePath: string, start: number, end: number, wd: Watchdog, onSent?: (sent: number) => void): AsyncIterable<Buffer> {
        return {
            [Symbol.asyncIterator]: async function* () {
                if (end <= start) return;
                const stream = fs.createReadStream(filePath, { start, end: end - 1, highWaterMark: 256 * 1024 });
                let sent = 0;
                try {
                    for await (const chunk of stream) {
                        const buf = chunk as Buffer;
                        sent += buf.length;
                        wd.touch();
                        yield buf;
                        try { onSent?.(sent); } catch { /* callback lỗi không làm hỏng tải lên */ }
                    }
                } finally {
                    stream.destroy();
                }
            },
        };
    }

    // ── Gửi request ──

    /** send + kiểm tra 2xx (lỗi → CloudError). keepBody=false thì đọc bỏ body. */
    private async call(req: R2Request, timeoutMs: number, keepBody = false): Promise<R2FetchResponse> {
        const wd = new Watchdog(timeoutMs);
        try {
            const res = await this.send(req, wd);
            if (res.status < 200 || res.status >= 300) throw await this.errorFrom(res, req.method);
            if (!keepBody) {
                await drainBody(res);
                return res;
            }
            // Đọc body ngay trong thời hạn (text() một lần) rồi trả về bản đã đọc.
            let text: string;
            try {
                text = await res.text();
            } catch (err) {
                throw networkError(err, wd.timedOut);
            }
            return {
                status: res.status,
                headers: res.headers,
                text: async () => text,
                arrayBuffer: async () => {
                    const b = Buffer.from(text, 'utf8');
                    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
                },
                body: null,
            };
        } finally {
            wd.done();
        }
    }

    private async send(req: R2Request, wd: Watchdog): Promise<R2FetchResponse> {
        const { accountId, creds } = this.requireAuth();
        const host = this.host(accountId);
        const urlPath = this.objectPath(req.key);
        const body = req.body ?? null;
        const isBuffer = Buffer.isBuffer(body);
        const payloadHash = req.payloadHash ?? (isBuffer ? sha256Hex(body as Buffer) : body ? UNSIGNED_PAYLOAD : EMPTY_SHA256);

        const headersToSign: Record<string, string> = { 'x-amz-content-sha256': payloadHash };
        for (const [k, v] of Object.entries(req.headers || {})) {
            if (v !== undefined && v !== null) headersToSign[k.toLowerCase()] = String(v);
        }
        const signed = signRequest({
            method: req.method,
            host,
            path: urlPath,
            query: req.query,
            headers: headersToSign,
            payloadHash,
            region: R2_REGION,
            service: 's3',
            date: this.now(),
        }, creds);

        const url = `https://${host}${urlPath}${signed.canonicalQuery ? `?${signed.canonicalQuery}` : ''}`;
        const headers: Record<string, string> = { ...signed.headers };
        const init: any = { method: req.method, headers, signal: wd.controller.signal };
        if (body) {
            init.body = body;
            if (!isBuffer) {
                if (req.contentLength === undefined) throw new CloudError('R2_ERROR', 'Thiếu độ dài nội dung khi tải lên R2');
                headers['content-length'] = String(req.contentLength);
                init.duplex = 'half';
            }
        }
        const fetchImpl: R2Fetch = this.opts.fetchImpl ?? ((u, i) => (globalThis as any).fetch(u, i));
        let res: R2FetchResponse;
        try {
            res = await fetchImpl(url, init);
        } catch (err) {
            throw networkError(err, wd.timedOut);
        }
        this.recordOp(req, res, isBuffer ? (body as Buffer).length : body ? req.contentLength || 0 : 0);
        return res;
    }

    /** Báo thao tác cho bộ đếm mức sử dụng (request đã tới R2, kể cả trả lỗi). */
    private recordOp(req: R2Request, res: R2FetchResponse, sentBytes: number): void {
        if (!this.opts.onOp) return;
        try {
            const op = classifyR2Request(req);
            const ok = res.status >= 200 && res.status < 300;
            const down = req.method === 'GET' && req.key !== null && ok ? Number(res.headers.get('content-length')) || 0 : 0;
            this.opts.onOp(op, { up: sentBytes || undefined, down: down || undefined });
        } catch { /* bộ đếm lỗi không làm hỏng request */ }
    }

    private async errorFrom(res: R2FetchResponse, op: string): Promise<CloudError> {
        let text = '';
        if (op !== 'HEAD') {
            try { text = await res.text(); } catch { /* bỏ qua */ }
        }
        const err = mapR2Error(res.status, xmlTag(text, 'Code') || '', xmlTag(text, 'Message') || '', res.headers.get('retry-after'), this.now().getTime());
        return err;
    }

    /** 404 của GET: NoSuchBucket là lỗi thật, NoSuchKey = không có object. */
    private async throwIfNotObject404(res: R2FetchResponse): Promise<void> {
        let text = '';
        try { text = await res.text(); } catch { /* bỏ qua */ }
        if (xmlTag(text, 'Code') === 'NoSuchBucket') throw mapR2Error(404, 'NoSuchBucket', '', null);
    }

    private requireAuth(): { accountId: string; creds: SigV4Credentials } {
        const accountId = this.opts.getAccountId();
        const creds = this.opts.getCredentials();
        if (!accountId || !creds || !creds.accessKeyId || !creds.secretAccessKey) {
            throw new CloudError('NOT_CONNECTED', 'Chưa kết nối Cloudflare (thiếu token cho R2)');
        }
        return { accountId, creds };
    }

    private host(accountId: string): string {
        return this.opts.endpointHost ? this.opts.endpointHost(accountId) : `${accountId}.r2.cloudflarestorage.com`;
    }

    private objectPath(key: string | null): string {
        const base = `/${uriEncode(this.bucket)}`;
        return key === null ? base : `${base}/${uriEncodePath(key)}`;
    }

    private checkKey(key: string): string {
        const k = String(key ?? '');
        if (!k || Buffer.byteLength(k, 'utf8') > 1024) throw new CloudError('R2_BAD_KEY', 'Tên object R2 không hợp lệ');
        return k;
    }

    private putHeaders(opts: R2PutOptions): Record<string, string | undefined> {
        const headers: Record<string, string | undefined> = {};
        if (opts.contentType) headers['content-type'] = opts.contentType;
        if (opts.ifNoneMatch === '*') headers['if-none-match'] = '*';
        let metaBytes = 0;
        for (const [rawName, rawValue] of Object.entries(opts.metadata || {})) {
            const name = rawName.toLowerCase();
            if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new CloudError('R2_BAD_METADATA', `Tên metadata không hợp lệ: ${rawName}`);
            const value = String(rawValue ?? '');
            // Header HTTP chỉ nhận ASCII in được: giá trị khác ASCII được mã hoá kiểu URL.
            const safe = /^[\x20-\x7e]*$/.test(value) ? value : encodeURIComponent(value);
            metaBytes += name.length + safe.length;
            headers[`x-amz-meta-${name}`] = safe;
        }
        if (metaBytes > MAX_METADATA_BYTES) throw new CloudError('R2_BAD_METADATA', 'Metadata R2 vượt 8 KB');
        return headers;
    }

    private now(): Date {
        return this.opts.now ? this.opts.now() : new Date();
    }

    private sleep(ms: number): Promise<void> {
        if (this.opts.sleep) return this.opts.sleep(ms);
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
