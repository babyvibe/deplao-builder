/**
 * DriveApi: minimal HTTP layer over Google Drive REST v3 (global fetch, no Google SDK).
 *
 *  - Bearer token obtained via getToken() (GoogleDriveService keeps the access token in RAM and refreshes it). 401 → refresh the token
 *    once, then resend exactly once (the request body is rebuilt from scratch).
 *  - Deadlines like R2Client: small requests max 30 s; data transfers abort when no bytes arrive for 60 s.
 *  - Errors → CloudError with the codes the upper layers (media / DB sync) already understand (mapDriveError): busy / rate limit → 'R2_BUSY'
 *    (+ retryAfterMs), out of space → 'STORAGE_FULL', refused → 'R2_FORBIDDEN', 404 → 'R2_NOT_FOUND', no network →
 *    'R2_NETWORK', timed out → 'R2_TIMEOUT'. GET / DELETE retry themselves 2 times (after 1 s, then 3 s) when busy / no network; uploads do not
 *    (creating a file twice = a duplicate file): DriveStore retries each chunk of a resumable session on its own.
 *  - Quota counting: every request that reaches Google → record(units, { up, down }) per GDRIVE_LIMITS (5 / 50 / 100 / 200).
 *  - Logs nothing at this layer (upload session URLs contain upload_id, headers contain the token).
 */
import { randomBytes } from 'crypto';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { CloudError } from '../contracts';
import { GDRIVE_LIMITS } from '../../../shared/cloud/cloudContracts';
import { tr } from '../../../shared/i18n';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DEFAULT_MIME = 'application/octet-stream';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const BUSY_WAIT_RATE_MS = 30_000;
const BUSY_WAIT_5XX_MS = 10_000;
export const NETWORK_WAIT_MS = 15_000;
/** GET / DELETE: retried inside this layer after 1 s, then 3 s. */
const IDEMPOTENT_BACKOFF_MS = [1000, 3000];

export const MSG_BUSY = tr('Google Drive đang giới hạn tốc độ / bận — tự thử lại sau.');
export const MSG_STORAGE_FULL = tr('Google Drive đã hết dung lượng — dọn bớt hoặc nâng gói Google One rồi bấm Tiếp tục.');
export const MSG_FORBIDDEN = tr('Google Drive từ chối truy cập — đăng nhập lại Google Drive.');
export const MSG_NETWORK = tr('Mạng chậm hoặc mất kết nối tới Google Drive.');
export const MSG_TIMEOUT = tr('Google Drive phản hồi quá lâu — tự thử lại sau.');
export const MSG_NOT_FOUND = tr('Không có dữ liệu này trên Google Drive');

// ─── Types ────────────────────────────────────────────────────────────────────

/** The part of the response that is used (real fetch / a fake when testing). */
export interface DriveFetchResponse {
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    /** Web ReadableStream (real fetch) or Node Readable (fake); null = read via arrayBuffer(). */
    body: any;
}
export type DriveFetch = (url: string, init: any) => Promise<DriveFetchResponse>;

/** Drive file metadata (only the fields Deplao asks for; Drive returns int64 numbers as strings). */
export interface DriveFileMeta {
    id: string;
    name?: string;
    mimeType?: string;
    size?: string;
    md5Checksum?: string;
    modifiedTime?: string;
    createdTime?: string;
    trashed?: boolean;
    parents?: string[];
}

/** Upload content, readable again from the start (resent after a 401, or one chunk of a resumable session retried). */
export interface ContentSource {
    readonly size: number;
    /** Bytes [start, end): a Buffer (content in RAM) or a file read stream. */
    open(start: number, end: number): Buffer | AsyncIterable<Buffer>;
}

/**
 * State of a resumable session: file ≠ null = done (file metadata); otherwise next = the next byte the server needs.
 * (Not a union discriminated by a boolean flag: tsconfig strict:false does not narrow types by that flag.)
 */
export interface ResumableState {
    next: number;
    file: DriveFileMeta | null;
}

export interface DriveApiOptions {
    /** Access token; force = refresh it (after a 401), rejected = the token Google has just refused. */
    getToken: (opts?: { force?: boolean; rejected?: string }) => Promise<string>;
    fetchImpl?: DriveFetch;
    /** Counts quota after every request that reaches Google. Must not throw. */
    record?: (units: number, bytes: { up?: number; down?: number }) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Small requests: maximum total time (default 30 s). */
    timeoutMs?: number;
    /** Data transfer: abort when no bytes arrive within N ms (default 60 s). */
    idleTimeoutMs?: number;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** String value inside the Drive q query: `\` → `\\`, `'` → `\'`. */
export function escapeQueryValue(value: string): string {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Query string encoded like %20 (drops undefined / null / '' values). */
export function queryString(params: Record<string, string | number | undefined | null>): string {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
}

/** Retry-After: seconds or an HTTP date → ms. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
    if (!value) return null;
    const v = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(v)) return Math.max(0, Math.round(parseFloat(v) * 1000));
    const at = Date.parse(v);
    return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export function isDriveRetryable(err: unknown): boolean {
    return err instanceof CloudError && (err.code === 'R2_BUSY' || err.code === 'R2_NETWORK' || err.code === 'R2_TIMEOUT');
}

export function isNotFound(err: unknown): boolean {
    return err instanceof CloudError && err.code === 'R2_NOT_FOUND';
}

function safeMime(mime: string | null | undefined): string {
    const m = String(mime || '').trim();
    return m && m.length <= 200 && !/[\r\n]/.test(m) ? m : DEFAULT_MIME;
}

function unrefTimer(timer: unknown): void {
    try { (timer as { unref?: () => void })?.unref?.(); } catch { /* ignore */ }
}

// ─── Errors ─────────────────────────────────────────────────────────────────────

/** Error reason in Google's JSON body ({ error: { errors[].reason, details[].reason, status, message } }). */
function driveErrorInfo(text: string): { reasons: string[]; first: string; message: string } {
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    const e = j && typeof j === 'object' && j.error && typeof j.error === 'object' ? j.error : null;
    const reasons: string[] = [];
    let first = '';
    const add = (r: unknown) => {
        if (typeof r !== 'string' || !r) return;
        if (!first) first = r.replace(/[^\w.-]/g, '').slice(0, 60);
        // 'RATE_LIMIT_EXCEEDED' (ErrorInfo) and 'rateLimitExceeded' (errors[]) are compared in the same form
        reasons.push(r.toLowerCase().replace(/[^a-z]/g, ''));
    };
    if (e) {
        for (const x of Array.isArray(e.errors) ? e.errors : []) add(x?.reason);
        for (const x of Array.isArray(e.details) ? e.details : []) add(x?.reason);
        add(e.status);
    }
    return { reasons, first, message: e && typeof e.message === 'string' ? e.message : '' };
}

/**
 * HTTP status + error body of Drive → CloudError. The codes keep the R2_* names because the upper layers (classifyR2Error, SyncEngine,
 * Restore.RETRYABLE) already react correctly to these codes: R2_BUSY / R2_NETWORK / R2_TIMEOUT = back off the whole queue, then retry;
 * status 401/403 = stop the queue + notify the user; R2_NOT_FOUND = an error for one object only.
 */
export function mapDriveError(status: number, bodyText: string, retryAfter: string | null, nowMs: number = Date.now()): CloudError {
    const { reasons, first, message } = driveErrorInfo(bodyText);
    const has = (...names: string[]) => names.some(n => reasons.includes(n));
    const storageFull = has('storagequotaexceeded') || (has('quotaexceeded') && /storage/i.test(message));
    if (storageFull && status >= 400 && status < 500) return new CloudError('STORAGE_FULL', MSG_STORAGE_FULL, 403);
    const rateLimited = has('ratelimitexceeded', 'userratelimitexceeded', 'sharingratelimitexceeded', 'dailylimitexceeded', 'quotaexceeded', 'backenderror');
    if (status === 429 || status >= 500 || (status === 403 && rateLimited)) {
        const fallback = status >= 500 ? BUSY_WAIT_5XX_MS : BUSY_WAIT_RATE_MS;
        return new CloudError('R2_BUSY', MSG_BUSY, status, parseRetryAfter(retryAfter, nowMs) ?? fallback);
    }
    if (status === 401 || status === 403) return new CloudError('R2_FORBIDDEN', MSG_FORBIDDEN, status);
    if (status === 404) return new CloudError('R2_NOT_FOUND', MSG_NOT_FOUND, 404);
    if (status === 408) return new CloudError('R2_TIMEOUT', MSG_TIMEOUT, 408, NETWORK_WAIT_MS);
    return new CloudError('R2_ERROR', tr('Google Drive báo lỗi{{v1}} (HTTP {{status}})', { v1: first ? ` ${first}` : '', status }), status);
}

/** Network / timeout error → CloudError (a CloudError is kept as is). */
export function driveNetworkError(err: unknown, timedOut: boolean): CloudError {
    if (err instanceof CloudError) return err;
    if (timedOut) return new CloudError('R2_TIMEOUT', MSG_TIMEOUT, undefined, NETWORK_WAIT_MS);
    return new CloudError('R2_NETWORK', MSG_NETWORK, undefined, NETWORK_WAIT_MS);
}

/** Local file write error (disk full, no permission…): not a network error, kept as is so the upper layer reports it correctly. */
const LOCAL_FS_CODES = new Set([
    'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'ENOENT', 'EMFILE', 'ENFILE', 'EEXIST', 'EBUSY', 'ENAMETOOLONG',
]);
function isLocalFsError(err: unknown): boolean {
    const code = (err as { code?: unknown })?.code;
    return typeof code === 'string' && LOCAL_FS_CODES.has(code);
}

// ─── Abort timer ─────────────────────────────────────────────────────────────

/** AbortController + timer; touch() extends it (idle timeout during data transfer). */
export class Watchdog {
    readonly controller = new AbortController();
    timedOut = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private finished = false;

    constructor(private readonly ms: number) {
        this.touch();
    }

    touch(): void {
        if (this.finished) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timedOut = true;
            this.controller.abort();
        }, this.ms);
        unrefTimer(this.timer);
    }

    done(): void {
        this.finished = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}

/** Wraps the stream body: each chunk extends the watchdog and reports the bytes sent so far. */
function trackUpload(source: AsyncIterable<Buffer>, wd: Watchdog, onSent?: (sent: number) => void): AsyncIterable<Buffer> {
    return {
        [Symbol.asyncIterator]: async function* () {
            let sent = 0;
            for await (const chunk of source) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                sent += buf.length;
                wd.touch();
                yield buf;
                try { onSent?.(sent); } catch { /* a failing callback does not break the upload */ }
            }
        },
    };
}

/** Joins Buffers + streams into one stream (multipart body: metadata part + file content + trailer). */
function concatParts(parts: Array<Buffer | AsyncIterable<Buffer>>): AsyncIterable<Buffer> {
    return {
        [Symbol.asyncIterator]: async function* () {
            for (const part of parts) {
                if (Buffer.isBuffer(part)) {
                    if (part.length) yield part;
                    continue;
                }
                for await (const chunk of part) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            }
        },
    };
}

async function toReadable(res: DriveFetchResponse): Promise<Readable> {
    const body = res.body;
    if (body && typeof body.getReader === 'function') return Readable.fromWeb(body);
    if (body && typeof body.pipe === 'function') return body as Readable;
    return Readable.from([Buffer.from(await res.arrayBuffer())]);
}

function parseJson(text: string, status: number): any {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new CloudError('R2_ERROR', tr('Google Drive trả về dữ liệu không đọc được'), status);
    }
}

/** Upload session URL returned by Google: only send the token to https://*.googleapis.com. */
function isGoogleUploadUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && (u.hostname === 'googleapis.com' || u.hostname.endsWith('.googleapis.com'));
    } catch {
        return false;
    }
}

// ─── Client ──────────────────────────────────────────────────────────────────

interface DriveRequest {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    /** Builds the request body (called again when resending after a 401 / retry). */
    body?: (() => Buffer | AsyncIterable<Buffer>) | null;
    /** Required when the body is a stream. */
    contentLength?: number;
    units: number;
    /** Content bytes sent up (for counting). */
    upBytes?: number;
    /** GET / DELETE: retried inside this layer when busy / no network. */
    idempotent?: boolean;
    /** Data transfer: the deadline is an idle timeout (extended per chunk) instead of a 30 s total. */
    transfer?: boolean;
    onSent?: (sent: number) => void;
    /** Status codes treated as success (default 2xx). */
    accept?: (status: number) => boolean;
}

interface DriveReply {
    status: number;
    headers: { get(name: string): string | null };
    text: string;
}

const acceptResumable = (s: number) => s === 308 || (s >= 200 && s < 300);

export class DriveApi {
    private readonly timeoutMs: number;
    private readonly idleTimeoutMs: number;

    constructor(private readonly opts: DriveApiOptions) {
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    }

    /** Variant that uses a fixed token (at sign-in, before the refresh token is saved): a 401 cannot be refreshed. */
    withToken(token: string): DriveApi {
        return new DriveApi({ ...this.opts, getToken: async () => token });
    }

    // ── Metadata ──

    async about(fields: string): Promise<any> {
        const r = await this.run({ method: 'GET', url: `${DRIVE_API}/about?${queryString({ fields })}`, units: GDRIVE_LIMITS.unitsRead, idempotent: true });
        return parseJson(r.text, r.status);
    }

    async getFile(id: string, fields: string): Promise<DriveFileMeta> {
        const r = await this.run({
            method: 'GET',
            url: `${DRIVE_API}/files/${encodeURIComponent(id)}?${queryString({ fields })}`,
            units: GDRIVE_LIMITS.unitsRead,
            idempotent: true,
        });
        return this.fileFrom(r);
    }

    async listFiles(p: { q: string; fields: string; orderBy?: string; pageSize?: number; pageToken?: string | null }): Promise<{ files: DriveFileMeta[]; nextPageToken: string | null }> {
        const r = await this.run({
            method: 'GET',
            url: `${DRIVE_API}/files?${queryString({
                q: p.q,
                fields: p.fields,
                orderBy: p.orderBy,
                pageSize: p.pageSize,
                pageToken: p.pageToken,
                spaces: 'drive',
            })}`,
            units: GDRIVE_LIMITS.unitsList,
            idempotent: true,
        });
        const data = parseJson(r.text, r.status);
        return {
            files: Array.isArray(data?.files) ? data.files.filter((f: any) => f && typeof f.id === 'string' && f.id) : [],
            nextPageToken: typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null,
        };
    }

    /** Creates a folder (parentId 'root' = My Drive). */
    async createFolder(name: string, parentId: string): Promise<DriveFileMeta> {
        const body = Buffer.from(JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }), 'utf8');
        const r = await this.run({
            method: 'POST',
            url: `${DRIVE_API}/files?${queryString({ fields: 'id,name' })}`,
            headers: { 'content-type': 'application/json; charset=UTF-8' },
            body: () => body,
            units: GDRIVE_LIMITS.unitsEdit,
        });
        return this.fileFrom(r);
    }

    /** Deletes permanently (bypasses the trash). 404 throws R2_NOT_FOUND; the caller treats it as already deleted. */
    async deleteFile(id: string): Promise<void> {
        await this.run({ method: 'DELETE', url: `${DRIVE_API}/files/${encodeURIComponent(id)}`, units: GDRIVE_LIMITS.unitsEdit, idempotent: true });
    }

    // ── Upload ──

    /** Creates (fileId null) / updates a file with its metadata in one request (uploadType=multipart). */
    async uploadMultipart(p: {
        fileId?: string | null; metadata: Record<string, unknown>; mimeType: string; content: ContentSource; fields: string;
        onProgress?: (sent: number) => void;
    }): Promise<DriveFileMeta> {
        const boundary = `deplao_${randomBytes(16).toString('hex')}`;
        const head = Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(p.metadata)}\r\n`
            + `--${boundary}\r\nContent-Type: ${safeMime(p.mimeType)}\r\n\r\n`,
            'utf8',
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const size = p.content.size;
        const query = queryString({ uploadType: 'multipart', fields: p.fields });
        const r = await this.run({
            method: p.fileId ? 'PATCH' : 'POST',
            url: p.fileId ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(p.fileId)}?${query}` : `${DRIVE_UPLOAD_API}/files?${query}`,
            headers: { 'content-type': `multipart/related; boundary=${boundary}` },
            body: () => {
                const c = p.content.open(0, size);
                return Buffer.isBuffer(c) ? Buffer.concat([head, c, tail]) : concatParts([head, c, tail]);
            },
            contentLength: head.length + size + tail.length,
            units: GDRIVE_LIMITS.unitsEdit,
            upBytes: size,
            transfer: true,
            onSent: sent => p.onProgress?.(Math.max(0, Math.min(size, sent - head.length))),
        });
        return this.fileFrom(r);
    }

    /** Replaces the content of an existing file (uploadType=media, keeps the same id). */
    async uploadMedia(p: { fileId: string; mimeType: string; content: ContentSource; fields: string; onProgress?: (sent: number) => void }): Promise<DriveFileMeta> {
        const size = p.content.size;
        const r = await this.run({
            method: 'PATCH',
            url: `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(p.fileId)}?${queryString({ uploadType: 'media', fields: p.fields })}`,
            headers: { 'content-type': safeMime(p.mimeType) },
            body: () => p.content.open(0, size),
            contentLength: size,
            units: GDRIVE_LIMITS.unitsEdit,
            upBytes: size,
            transfer: true,
            onSent: p.onProgress,
        });
        return this.fileFrom(r);
    }

    /** Opens a resumable upload session (uploadType=resumable) → session URL (Location header). */
    async startResumable(p: { fileId?: string | null; metadata: Record<string, unknown>; mimeType: string; size: number; fields: string }): Promise<string> {
        const body = Buffer.from(JSON.stringify(p.metadata), 'utf8');
        const query = queryString({ uploadType: 'resumable', fields: p.fields });
        const r = await this.run({
            method: p.fileId ? 'PATCH' : 'POST',
            url: p.fileId ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(p.fileId)}?${query}` : `${DRIVE_UPLOAD_API}/files?${query}`,
            headers: {
                'content-type': 'application/json; charset=UTF-8',
                'x-upload-content-type': safeMime(p.mimeType),
                'x-upload-content-length': String(p.size),
            },
            body: () => body,
            units: GDRIVE_LIMITS.unitsEdit,
        });
        const location = r.headers.get('location');
        if (!location || !isGoogleUploadUrl(location)) throw new CloudError('R2_ERROR', tr('Google Drive không trả về địa chỉ phiên tải lên'), r.status);
        return location;
    }

    /** Sends the chunk [start, end) of the session: 308 → not finished (next), 200/201 → finished (file = metadata). */
    async uploadChunk(sessionUrl: string, p: { start: number; end: number; total: number; content: ContentSource; onProgress?: (sentInChunk: number) => void }): Promise<ResumableState> {
        const len = p.end - p.start;
        const r = await this.run({
            method: 'PUT',
            url: sessionUrl,
            headers: { 'content-range': `bytes ${p.start}-${p.end - 1}/${p.total}` },
            body: () => p.content.open(p.start, p.end),
            contentLength: len,
            units: GDRIVE_LIMITS.unitsEdit,
            upBytes: len,
            transfer: true,
            onSent: p.onProgress,
            accept: acceptResumable,
        });
        return this.resumableState(r);
    }

    /** Asks how far the session has received (Content-Range: bytes * /total, empty body). */
    async queryUpload(sessionUrl: string, total: number): Promise<ResumableState> {
        const r = await this.run({
            method: 'PUT',
            url: sessionUrl,
            headers: { 'content-range': `bytes */${total}` },
            body: () => Buffer.alloc(0),
            units: GDRIVE_LIMITS.unitsEdit,
            accept: acceptResumable,
        });
        return this.resumableState(r);
    }

    // ── Download ──

    /**
     * Downloads the content (alt=media) into a sink (sink() is called only once a 2xx response exists; a retry creates a new sink).
     * bytes = bytes written; contentLength / encoded let the caller check the data is complete. 404 → R2_NOT_FOUND.
     */
    async download(id: string, sink: () => Writable): Promise<{ bytes: number; contentLength: number | null; encoded: boolean }> {
        const url = `${DRIVE_API}/files/${encodeURIComponent(id)}?${queryString({ alt: 'media' })}`;
        const units = GDRIVE_LIMITS.unitsDownload;
        let rejected: string | null = null;
        let busyRetries = 0;
        for (;;) {
            const token = await this.opts.getToken(rejected !== null ? { force: true, rejected } : undefined);
            const wd = new Watchdog(this.idleTimeoutMs);
            let streaming = false;
            try {
                const res = await this.send({ method: 'GET', url, units }, token, wd);
                if (res.status < 200 || res.status >= 300) {
                    let text = '';
                    try { text = await res.text(); } catch { /* ignore */ }
                    this.record(units, {});
                    if (res.status === 401 && rejected === null) {
                        rejected = token;
                        continue;
                    }
                    throw mapDriveError(res.status, text, res.headers.get('retry-after'), this.now());
                }
                streaming = true;
                let bytes = 0;
                const counter = new Transform({
                    transform(chunk: Buffer, _enc, cb) {
                        bytes += chunk.length;
                        wd.touch();
                        cb(null, chunk);
                    },
                });
                try {
                    const source = await toReadable(res);
                    await pipeline(source, counter, sink());
                } catch (err) {
                    throw isLocalFsError(err) ? err : driveNetworkError(err, wd.timedOut);
                } finally {
                    this.record(units, { down: bytes });
                }
                const cl = res.headers.get('content-length');
                const n = cl === null || cl === '' ? NaN : Number(cl);
                return { bytes, contentLength: Number.isFinite(n) && n >= 0 ? n : null, encoded: !!res.headers.get('content-encoding') };
            } catch (err) {
                if (!streaming && isDriveRetryable(err) && busyRetries < IDEMPOTENT_BACKOFF_MS.length) {
                    await this.sleep(IDEMPOTENT_BACKOFF_MS[busyRetries++]);
                    continue;
                }
                throw err;
            } finally {
                wd.done();
            }
        }
    }

    // ── Send request ──

    private async run(req: DriveRequest): Promise<DriveReply> {
        let rejected: string | null = null;
        let busyRetries = 0;
        for (;;) {
            const token = await this.opts.getToken(rejected !== null ? { force: true, rejected } : undefined);
            const wd = new Watchdog(req.transfer ? this.idleTimeoutMs : this.timeoutMs);
            try {
                const res = await this.send(req, token, wd);
                let text = '';
                try {
                    text = await res.text();
                } catch (err) {
                    this.record(req.units, { up: req.upBytes });
                    throw driveNetworkError(err, wd.timedOut);
                }
                this.record(req.units, { up: req.upBytes });
                if (res.status === 401 && rejected === null) {
                    // Token expired / revoked midway → refresh once, then resend
                    rejected = token;
                    continue;
                }
                const ok = req.accept ? req.accept(res.status) : res.status >= 200 && res.status < 300;
                if (!ok) throw mapDriveError(res.status, text, res.headers.get('retry-after'), this.now());
                return { status: res.status, headers: res.headers, text };
            } catch (err) {
                if (req.idempotent && isDriveRetryable(err) && busyRetries < IDEMPOTENT_BACKOFF_MS.length) {
                    await this.sleep(IDEMPOTENT_BACKOFF_MS[busyRetries++]);
                    continue;
                }
                throw err;
            } finally {
                wd.done();
            }
        }
    }

    private async send(req: DriveRequest, token: string, wd: Watchdog): Promise<DriveFetchResponse> {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers || {})) {
            if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
        }
        headers.authorization = `Bearer ${token}`;
        const init: any = { method: req.method, headers, signal: wd.controller.signal };
        if (req.body) {
            const body = req.body();
            if (Buffer.isBuffer(body)) {
                init.body = body;
            } else {
                if (req.contentLength === undefined) throw new CloudError('R2_ERROR', tr('Thiếu độ dài nội dung khi tải lên Google Drive'));
                init.body = trackUpload(body, wd, req.onSent);
                headers['content-length'] = String(req.contentLength);
                init.duplex = 'half';
            }
        }
        const fetchImpl: DriveFetch = this.opts.fetchImpl ?? ((u, i) => (globalThis as any).fetch(u, i));
        try {
            return await fetchImpl(req.url, init);
        } catch (err) {
            throw driveNetworkError(err, wd.timedOut);
        }
    }

    private fileFrom(r: DriveReply): DriveFileMeta {
        const data = parseJson(r.text, r.status);
        if (!data || typeof data.id !== 'string' || !data.id) throw new CloudError('R2_ERROR', tr('Google Drive không trả về mã file'), r.status);
        return data as DriveFileMeta;
    }

    private resumableState(r: DriveReply): ResumableState {
        if (r.status === 308) {
            // Range: bytes=0-N = the server already holds the first N+1 bytes; no Range = it holds no bytes yet
            const m = /bytes=(\d+)-(\d+)/.exec(r.headers.get('range') || '');
            return { next: m ? Number(m[2]) + 1 : 0, file: null };
        }
        const file = this.fileFrom(r);
        return { next: Number(file.size) || 0, file };
    }

    private record(units: number, bytes: { up?: number; down?: number }): void {
        if (!this.opts.record) return;
        try {
            const up = Number(bytes.up) > 0 ? Number(bytes.up) : undefined;
            const down = Number(bytes.down) > 0 ? Number(bytes.down) : undefined;
            this.opts.record(units, { up, down });
        } catch { /* a failing counter does not break the request */ }
    }

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    private sleep(ms: number): Promise<void> {
        if (this.opts.sleep) return this.opts.sleep(ms);
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    }
}
