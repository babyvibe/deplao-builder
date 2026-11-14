/**
 * DriveStore: one "bucket" on Google Drive (folder Deplao/<bucket>) that follows the R2Client contract exactly, so the media module and the
 * DB sync can use it unchanged without knowing they run on Drive.
 *
 *  - Key `a/b/c.jpg` = folder a → b (inside the bucket folder) + file `c.jpg`. Reads never create folders (missing =
 *    no object); writes create the missing folders. Two parallel writes into the same folder create it only once (merged by path),
 *    two writes to the same key run one after another.
 *  - In-RAM cache: folder path → id; key → { id, size, md5, modifiedTime } (LRU ~5000). For a folder this store has just
 *    created, it knows exactly which names are in it, so new files need no lookup (saves 100 quota units per file during
 *    a mass first upload).
 *  - Drive allows duplicate names: reads take the newest file (modifiedTime), folders take the earliest-created one (every machine picks the same one).
 *  - putFile ≤ 5 MiB: one multipart request; larger: a resumable session, 8 MiB chunks, each chunk retried 3 times (asks the
 *    server how much it received, then continues). ETag = Drive's md5Checksum (PUT and HEAD return the same value).
 *  - Delete = permanent delete (not to the trash, since the trash still counts against the account quota).
 *  - A remembered id that is gone (the user deleted the folder / file on Drive → 404) → forget the cache, re-check the root folder, retry
 *    once. The bucket folder is re-checked every 10 minutes (if it was moved to the trash, new files must not land there).
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Writable } from 'stream';
import { CloudError, R2Client, R2ObjectInfo, R2PutOptions } from '../contracts';
import {
    ContentSource, DEFAULT_MIME, DriveApi, DriveFileMeta, FOLDER_MIME, NETWORK_WAIT_MS, ResumableState,
    escapeQueryValue, isDriveRetryable, isNotFound,
} from './DriveApi';
import { tr } from '../../../shared/i18n';

export const DRIVE_SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024;
export const DRIVE_CHUNK_SIZE = 8 * 1024 * 1024;
/** Resumable chunks must be a multiple of 256 KiB (except the last chunk). */
export const DRIVE_CHUNK_ALIGN = 256 * 1024;
const CHUNK_BACKOFF_MS = [1000, 3000, 9000];
const FILE_CACHE_MAX = 5000;
const DELETE_CONCURRENCY = 4;
const FOLDER_RECHECK_MS = 10 * 60_000;
const TOMBSTONE_TTL_MS = 10 * 60_000;
const TOMBSTONE_MAX = 20_000;
/** A "fresh" folder keeps at most this many names; beyond that it stops tracking (falls back to looking up each file). */
const FRESH_NAMES_MAX = 20_000;
const FILE_FIELDS = 'id,name,size,md5Checksum,modifiedTime';
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)';
const MAX_APP_PROPERTIES = 30;
/** Drive: each appProperty allows at most 124 UTF-8 bytes for key + value together. */
const MAX_APP_PROPERTY_BYTES = 124;

type PutFileOptions = R2PutOptions & {
    onProgress?: (sentBytes: number, totalBytes: number) => void;
    onRetry?: (info: { part: number | null; attempt: number; maxAttempts: number; error: string }) => void;
};

export interface DriveStoreOptions {
    bucket: string;
    api: DriveApi;
    /** id of the root folder "Deplao" (create=false: do not create; null if it does not exist yet). */
    rootId: (create: boolean) => Promise<string | null>;
    /** A remembered id that is gone → next time, re-check the root folder. */
    invalidateRoot: () => void;
    /** Account / root folder changed → the number goes up → the store forgets its cache by itself. */
    generation?: () => number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Threshold for a single-request upload (multipart); larger ones use resumable. Default 5 MiB. */
    simpleUploadMax?: number;
    /** Resumable chunk size (rounded down to a multiple of 256 KiB). Default 8 MiB. */
    chunkSize?: number;
    /** Retries per chunk (default 3). */
    chunkRetries?: number;
    fileCacheMax?: number;
    /** deleteObjects: number of parallel delete calls (default 4). */
    deleteConcurrency?: number;
}

interface CachedFile { id: string; parent: string; size: number; md5: string; modifiedTime: string }
/** cached = taken from the cache (may be stale); false = just looked up on Drive. */
interface FoundFile extends CachedFile { cached: boolean }

interface ListCursor {
    v: 1;
    /** prefix of the first call (a page token only works with that exact prefix) */
    p: string;
    /** folders still to list (BFS): id + key prefix; f = name filter applied at the top level */
    q: Array<{ id: string; path: string; f?: string }>;
    /** Drive pageToken for q[0] */
    t: string | null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function checkKey(key: string): string {
    const k = String(key ?? '');
    if (!k || Buffer.byteLength(k, 'utf8') > 1024 || k.startsWith('/') || k.endsWith('/') || k.includes('//')) {
        throw new CloudError('R2_BAD_KEY', tr('Tên object không hợp lệ'));
    }
    return k;
}

function splitKey(key: string): { dir: string; name: string } {
    const i = key.lastIndexOf('/');
    return i < 0 ? { dir: '', name: key } : { dir: key.slice(0, i), name: key.slice(i + 1) };
}

function parentDir(dir: string): string {
    const i = dir.lastIndexOf('/');
    return i < 0 ? '' : dir.slice(0, i);
}

function baseName(dir: string): string {
    return dir.slice(dir.lastIndexOf('/') + 1);
}

function timeOf(v: string | undefined | null): number {
    return Date.parse(v || '') || 0;
}

function toInfo(key: string, f: DriveFileMeta): R2ObjectInfo {
    return { key, size: Number(f.size) || 0, etag: f.md5Checksum || '', lastModified: timeOf(f.modifiedTime) };
}

function errText(err: unknown): string {
    return String((err as Error)?.message || err || tr('Lỗi không xác định')).slice(0, 300);
}

/** Truncates a string by UTF-8 bytes (never splits a character in two). */
function truncateUtf8(s: string, maxBytes: number): string {
    if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    let out = '';
    let used = 0;
    for (const ch of s) {
        const b = Buffer.byteLength(ch, 'utf8');
        if (used + b > maxBytes) break;
        out += ch;
        used += b;
    }
    return out;
}

/** R2-style metadata → Drive appProperties (≤ 30 entries, key + value ≤ 124 bytes; anything that does not fit is truncated / dropped). */
export function toAppProperties(metadata: Record<string, string> | undefined | null): Record<string, string> {
    const out: Record<string, string> = {};
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(metadata || {})) {
        if (count >= MAX_APP_PROPERTIES) break;
        const key = String(rawKey || '');
        const keyBytes = Buffer.byteLength(key, 'utf8');
        if (!key || keyBytes >= MAX_APP_PROPERTY_BYTES) continue;
        out[key] = truncateUtf8(String(rawValue ?? ''), MAX_APP_PROPERTY_BYTES - keyBytes);
        count++;
    }
    return out;
}

function bufferSource(buf: Buffer): ContentSource {
    return { size: buf.length, open: (start, end) => buf.subarray(start, end) };
}

/** Reads [start, end) of the file in 256 KiB blocks (the whole file is not loaded into RAM). */
function fileSource(filePath: string, size: number): ContentSource {
    return {
        size,
        open: (start, end) => ({
            [Symbol.asyncIterator]: async function* () {
                if (end <= start) return;
                const stream = fs.createReadStream(filePath, { start, end: end - 1, highWaterMark: 256 * 1024 });
                try {
                    for await (const chunk of stream) yield chunk as Buffer;
                } finally {
                    stream.destroy();
                }
            },
        }),
    };
}

/** Collects the downloaded content into RAM (getObject). */
class BufferSink extends Writable {
    private readonly chunks: Buffer[] = [];

    _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
    }

    result(): Buffer {
        return Buffer.concat(this.chunks);
    }
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

function encodeCursor(c: ListCursor): string {
    return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(token: string, prefix: string): ListCursor {
    try {
        const c = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
        const ok = c && c.v === 1 && c.p === prefix && Array.isArray(c.q)
            && c.q.every((x: any) => x && typeof x.id === 'string' && typeof x.path === 'string' && (x.f === undefined || typeof x.f === 'string'))
            && (c.t === null || typeof c.t === 'string');
        if (ok) return c as ListCursor;
    } catch { /* falls through to the error */ }
    throw new CloudError('R2_BAD_REQUEST', tr('Mã trang danh sách không hợp lệ'));
}

/** Error for one key when deleting many (any other error, such as busy / network / permission, fails the whole call and is thrown). */
function isPerKeyError(err: unknown): boolean {
    return !(err instanceof CloudError) || err.code === 'R2_ERROR';
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class DriveStore implements R2Client {
    readonly bucket: string;
    private readonly api: DriveApi;
    private readonly simpleMax: number;
    private readonly chunkSize: number;
    private readonly chunkRetries: number;
    private readonly fileCacheMax: number;
    private readonly deleteConcurrency: number;
    /** folder path inside the bucket ('' = the bucket folder) → id */
    private readonly folders = new Map<string, { id: string; checkedAt: number }>();
    /** folder lookup / creation in progress (one job per path) */
    private readonly folderJobs = new Map<string, { create: boolean; promise: Promise<string | null> }>();
    /** key → file (LRU by the Map's insertion order) */
    private readonly files = new Map<string, CachedFile>();
    /** id of a folder this store created → names (files / subfolders) that may already be in it; not in the list = definitely not there yet */
    private readonly fresh = new Map<string, Set<string>>();
    /** key just deleted (ms): deleting it again within 10 minutes needs no lookup (a deleteObjects retry after busy) */
    private readonly tombstones = new Map<string, number>();
    private readonly keyLocks = new Map<string, Promise<void>>();
    private cacheGen = 0;
    private seenGen: number;

    constructor(private readonly opts: DriveStoreOptions) {
        this.bucket = opts.bucket;
        this.api = opts.api;
        this.simpleMax = Math.max(0, opts.simpleUploadMax ?? DRIVE_SIMPLE_UPLOAD_MAX);
        const chunk = Math.floor((opts.chunkSize ?? DRIVE_CHUNK_SIZE) / DRIVE_CHUNK_ALIGN) * DRIVE_CHUNK_ALIGN;
        this.chunkSize = Math.max(DRIVE_CHUNK_ALIGN, chunk);
        this.chunkRetries = Math.max(0, Math.floor(opts.chunkRetries ?? 3));
        this.fileCacheMax = Math.max(1, Math.floor(opts.fileCacheMax ?? FILE_CACHE_MAX));
        this.deleteConcurrency = Math.max(1, Math.min(16, Math.floor(opts.deleteConcurrency ?? DELETE_CONCURRENCY)));
        this.seenGen = opts.generation ? opts.generation() : 0;
    }

    // ── Public API (R2Client) ──

    async putObject(key: string, body: Buffer | string, opts: R2PutOptions = {}): Promise<{ etag: string }> {
        this.sync();
        const k = checkKey(key);
        const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.isBuffer(body) ? body : Buffer.from(body as any);
        const meta = await this.withKeyLock(k, () => this.retryStale(() => this.upload(k, bufferSource(buf), opts, {})));
        return { etag: meta.md5Checksum || '' };
    }

    async putFile(key: string, filePath: string, opts: PutFileOptions = {}): Promise<{ etag: string; size: number }> {
        this.sync();
        const k = checkKey(key);
        const st = await fs.promises.stat(filePath);
        if (!st.isFile()) throw new CloudError('R2_BAD_FILE', tr('Không phải file: {{v1}}', { v1: path.basename(filePath) }));
        const size = st.size;
        const meta = await this.withKeyLock(k, () => this.retryStale(() => this.upload(k, fileSource(filePath, size), opts, opts)));
        const sent = meta.size !== undefined && meta.size !== null && meta.size !== '' ? Number(meta.size) : NaN;
        return { etag: meta.md5Checksum || '', size: Number.isFinite(sent) ? sent : size };
    }

    async getObject(key: string): Promise<Buffer | null> {
        this.sync();
        const k = checkKey(key);
        return this.readObject(k, async found => {
            const holder: { sink?: BufferSink } = {};
            const r = await this.api.download(found.id, () => (holder.sink = new BufferSink()));
            this.verifySize(r, found);
            return holder.sink ? holder.sink.result() : Buffer.alloc(0);
        });
    }

    async getObjectToFile(key: string, filePath: string): Promise<{ size: number; etag: string } | null> {
        this.sync();
        const k = checkKey(key);
        return this.readObject(k, async found => {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const tmp = `${filePath}.gdtmp-${randomBytes(4).toString('hex')}`;
            try {
                const r = await this.api.download(found.id, () => fs.createWriteStream(tmp));
                this.verifySize(r, found);
                await renameWithRetry(tmp, filePath);
                return { size: r.bytes, etag: found.md5 };
            } catch (err) {
                await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
                throw err;
            }
        });
    }

    async headObject(key: string): Promise<R2ObjectInfo | null> {
        this.sync();
        const k = checkKey(key);
        const { dir, name } = splitKey(k);
        const folderId = await this.folderId(dir, false);
        if (!folderId) return null;
        const gen = this.cacheGen;
        const cached = this.cacheGet(k);
        if (cached && cached.parent === folderId) {
            // remembered id: get by id (5 units) instead of looking up by name (100): always reads the latest value (another machine may have just overwritten it)
            try {
                const f = await this.api.getFile(cached.id, `${FILE_FIELDS},trashed`);
                if (f && !f.trashed && f.name === name) {
                    if (gen === this.cacheGen) this.remember(k, folderId, f);
                    return toInfo(k, f);
                }
            } catch (err) {
                if (!isNotFound(err)) throw err;
            }
            this.forget(k);
        }
        const found = await this.findFile(k, folderId, name);
        return found ? { key: k, size: found.size, etag: found.md5, lastModified: timeOf(found.modifiedTime) } : null;
    }

    async deleteObject(key: string): Promise<void> {
        this.sync();
        const k = checkKey(key);
        await this.withKeyLock(k, () => this.deleteOne(k));
    }

    /**
     * Deletes many keys: file by file (Drive has no bulk delete), 4 calls in parallel. A missing file = treated as already deleted.
     * Busy / no network / refused → stop taking new keys, wait for the running calls, then throw (like a whole-request error of R2);
     * a just-deleted key is remembered for 10 minutes, so a retry costs no lookup.
     */
    async deleteObjects(keys: string[]): Promise<{ deleted: string[]; errors: Array<{ key: string; code: string; message: string }> }> {
        this.sync();
        const list = Array.from(new Set((keys || []).map(k => checkKey(k))));
        if (!list.length) return { deleted: [], errors: [] };
        const done = new Set<string>();
        const errors: Array<{ key: string; code: string; message: string }> = [];
        let fatal: unknown = null;
        let next = 0;
        const lanes = Array.from({ length: Math.min(this.deleteConcurrency, list.length) }, async () => {
            while (fatal === null && next < list.length) {
                const key = list[next++];
                try {
                    await this.deleteObject(key);
                    done.add(key);
                } catch (err) {
                    if (isPerKeyError(err)) {
                        errors.push({ key, code: String((err as CloudError)?.code || 'ERROR'), message: errText(err) });
                    } else if (fatal === null) {
                        fatal = err;
                    }
                }
            }
        });
        await Promise.all(lanes);
        if (fatal !== null) throw fatal;
        return { deleted: list.filter(k => done.has(k)), errors };
    }

    /**
     * One page of the listing (≤ maxKeys). prefix 'a/b/' = every file under folder a/b (recursive); 'a/b/x' = inside a/b, only names
     * starting with 'x' (a file, or a folder → take everything inside it). The page token = the traversal state (base64 JSON).
     */
    async listObjects(prefix: string, opts: { continuationToken?: string; maxKeys?: number } = {}): Promise<{ objects: R2ObjectInfo[]; nextToken: string | null }> {
        this.sync();
        const pre = String(prefix ?? '');
        const maxKeys = Math.min(1000, Math.max(1, Math.floor(Number(opts.maxKeys ?? 1000)) || 1000));
        let cur: ListCursor;
        if (opts.continuationToken) {
            cur = decodeCursor(opts.continuationToken, pre);
        } else {
            if (pre.startsWith('/') || pre.includes('//')) return { objects: [], nextToken: null };
            const slash = pre.lastIndexOf('/');
            const dir = slash < 0 ? '' : pre.slice(0, slash);
            const rest = slash < 0 ? pre : pre.slice(slash + 1);
            const folderId = await this.folderId(dir, false);
            if (!folderId) return { objects: [], nextToken: null };
            cur = { v: 1, p: pre, q: [{ id: folderId, path: dir ? `${dir}/` : '', ...(rest ? { f: rest } : {}) }], t: null };
        }
        const objects: R2ObjectInfo[] = [];
        const gen = this.cacheGen;
        while (cur.q.length && objects.length < maxKeys) {
            const head = cur.q[0];
            let page: { files: DriveFileMeta[]; nextPageToken: string | null };
            try {
                page = await this.api.listFiles({
                    q: `'${escapeQueryValue(head.id)}' in parents and trashed = false`,
                    fields: LIST_FIELDS,
                    orderBy: 'name',
                    pageSize: Math.min(1000, maxKeys - objects.length),
                    pageToken: cur.t,
                });
            } catch (err) {
                if (!isNotFound(err)) throw err;
                page = { files: [], nextPageToken: null }; // folder deleted between two pages
            }
            for (const f of page.files) {
                const name = String(f.name || '');
                if (!name || (head.f && !name.startsWith(head.f))) continue;
                if (f.mimeType === FOLDER_MIME) {
                    cur.q.push({ id: f.id, path: `${head.path}${name}/` });
                    continue;
                }
                const key = `${head.path}${name}`;
                objects.push(toInfo(key, f));
                if (gen === this.cacheGen) this.rememberListed(key, head.id, f);
            }
            if (page.nextPageToken) {
                cur.t = page.nextPageToken;
            } else {
                cur.q.shift();
                cur.t = null;
            }
        }
        return { objects, nextToken: cur.q.length ? encodeCursor(cur) : null };
    }

    presignGet(_key: string, _expiresSec?: number): string {
        throw new CloudError('UNSUPPORTED', tr('Google Drive không có liên kết tải ký sẵn'));
    }

    /** Creates the folder Deplao/<bucket> if it does not exist yet (ensureBucket). */
    async ensureBucketFolder(): Promise<string> {
        this.sync();
        return this.retryStale(async () => {
            const id = await this.folderId('', true);
            if (!id) throw new CloudError('R2_ERROR', tr('Không tạo được thư mục trên Google Drive'));
            return id;
        });
    }

    // ── Upload ──

    private async upload(key: string, source: ContentSource, opts: R2PutOptions, cb: Pick<PutFileOptions, 'onProgress' | 'onRetry'>): Promise<DriveFileMeta> {
        const { dir, name } = splitKey(key);
        const gen = this.cacheGen;
        const folderId = await this.folderId(dir, true);
        if (!folderId) throw new CloudError('R2_ERROR', tr('Không tạo được thư mục trên Google Drive'));
        const existing = await this.findFile(key, folderId, name);
        if (existing && opts.ifNoneMatch === '*') throw new CloudError('R2_EXISTS', tr('Đã có file này trên Google Drive'), 412);

        const size = source.size;
        const mimeType = opts.contentType || DEFAULT_MIME;
        const props = toAppProperties(opts.metadata);
        const hasProps = Object.keys(props).length > 0;
        const metadata: Record<string, unknown> = existing
            ? { mimeType, ...(hasProps ? { appProperties: props } : {}) }
            : { name, parents: [folderId], mimeType, ...(hasProps ? { appProperties: props } : {}) };
        const progress = (sent: number) => {
            if (!cb.onProgress) return;
            try { cb.onProgress(Math.max(0, Math.min(sent, size)), size); } catch { /* a failing callback does not break the upload */ }
        };
        this.tombstones.delete(key);
        // Record the name before creating: if the request fails but Drive still created the file → next time look it up, do not create a duplicate
        if (!existing) this.noteName(folderId, name);

        let meta: DriveFileMeta;
        if (size <= this.simpleMax) {
            meta = existing && !hasProps
                ? await this.api.uploadMedia({ fileId: existing.id, mimeType, content: source, fields: FILE_FIELDS, onProgress: progress })
                : await this.api.uploadMultipart({ fileId: existing ? existing.id : null, metadata, mimeType, content: source, fields: FILE_FIELDS, onProgress: progress });
        } else {
            meta = await this.uploadResumable(existing ? existing.id : null, metadata, mimeType, source, progress, cb.onRetry);
        }
        progress(size);
        if (gen === this.cacheGen) this.remember(key, folderId, meta);
        return meta;
    }

    /** Resumable session: chunkSize per chunk, each chunk retried chunkRetries times, asking the server how far it got before resending. */
    private async uploadResumable(
        fileId: string | null, metadata: Record<string, unknown>, mimeType: string, source: ContentSource,
        progress: (sent: number) => void, onRetry?: PutFileOptions['onRetry'],
    ): Promise<DriveFileMeta> {
        const total = source.size;
        const session = await this.api.startResumable({ fileId, metadata, mimeType, size: total, fields: FILE_FIELDS });
        let offset = 0;
        let chunkNo = 0;
        let stalls = 0;
        for (;;) {
            let state: ResumableState | null = null;
            if (offset >= total) {
                // Server reports all bytes received but has not returned the file (rare) → ask again to get the result
                state = await this.api.queryUpload(session, total);
                if (state.file) return state.file;
                throw new CloudError('R2_ERROR', tr('Google Drive chưa hoàn tất file vừa tải lên'));
            }
            chunkNo++;
            const start = offset;
            const end = Math.min(total, start + this.chunkSize);
            for (let attempt = 0; ; attempt++) {
                try {
                    state = await this.api.uploadChunk(session, { start, end, total, content: source, onProgress: sent => progress(start + sent) });
                    break;
                } catch (err) {
                    if (!isDriveRetryable(err) || attempt >= this.chunkRetries) throw err;
                    try {
                        onRetry?.({ part: chunkNo, attempt: attempt + 1, maxAttempts: this.chunkRetries, error: errText(err) });
                    } catch { /* a failing callback does not break the upload */ }
                    const hinted = err instanceof CloudError && err.retryAfterMs ? Math.min(err.retryAfterMs, 30_000) : 0;
                    await this.sleep(Math.max(hinted, CHUNK_BACKOFF_MS[Math.min(attempt, CHUNK_BACKOFF_MS.length - 1)]));
                    // Server may have received part or all of the chunk that just failed → ask again, then continue from there
                    try {
                        const st = await this.api.queryUpload(session, total);
                        if (st.file || st.next !== start) {
                            state = st;
                            break;
                        }
                    } catch (qerr) {
                        if (!isDriveRetryable(qerr)) throw qerr;
                    }
                }
            }
            if (state.file) return state.file;
            if (state.next <= start) {
                // Server holds no more bytes (rare): do not loop forever
                if (++stalls > this.chunkRetries) {
                    throw new CloudError('R2_BUSY', tr('Google Drive chưa nhận dữ liệu tải lên — tự thử lại sau.'), 503, NETWORK_WAIT_MS);
                }
            } else {
                stalls = 0;
            }
            offset = Math.max(0, Math.min(total, state.next));
            progress(offset);
        }
    }

    // ── Read / delete ──

    /** Find the file then read it; if the cached id is gone (404) → look it up by name once more. null = not found. */
    private async readObject<T>(key: string, read: (found: FoundFile) => Promise<T>): Promise<T | null> {
        const { dir, name } = splitKey(key);
        const folderId = await this.folderId(dir, false);
        if (!folderId) return null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const found = await this.findFile(key, folderId, name);
            if (!found) return null;
            try {
                return await read(found);
            } catch (err) {
                if (!isNotFound(err)) throw err;
                this.forget(key);
                if (!found.cached) return null;
            }
        }
        return null;
    }

    private verifySize(r: { bytes: number; contentLength: number | null; encoded: boolean }, found: FoundFile): void {
        const expected = !r.encoded && r.contentLength !== null ? r.contentLength : !found.cached ? found.size : null;
        if (expected !== null && expected !== r.bytes) {
            throw new CloudError('R2_NETWORK', tr('Tải từ Google Drive bị đứt giữa chừng'), undefined, NETWORK_WAIT_MS);
        }
    }

    private async deleteOne(key: string): Promise<void> {
        if (this.recentlyDeleted(key)) return;
        const { dir, name } = splitKey(key);
        const folderId = await this.folderId(dir, false);
        if (!folderId) {
            this.forget(key);
            return;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const cached = attempt === 0 ? this.cacheGet(key) : null;
            let ids: string[];
            if (cached && cached.parent === folderId) {
                ids = [cached.id];
            } else {
                const freshNames = this.fresh.get(folderId);
                // Look up by name: delete all the duplicate-named copies (R2: after deleting, HEAD must return nothing)
                ids = freshNames && !freshNames.has(name) ? [] : (await this.queryFiles(folderId, name)).map(f => f.id);
            }
            let stale = false;
            for (const id of ids) {
                try {
                    await this.api.deleteFile(id);
                } catch (err) {
                    if (!isNotFound(err)) throw err;
                    if (cached) stale = true;
                }
            }
            this.forget(key);
            if (!stale) break;
        }
        this.markDeleted(key);
    }

    // ── Folders ──

    /** folder id by path inside the bucket ('' = the bucket folder); create=false does not create (null if missing). */
    private async folderId(dir: string, create: boolean): Promise<string | null> {
        const hit = this.folders.get(dir);
        if (hit) {
            if (dir !== '' || this.now() - hit.checkedAt < FOLDER_RECHECK_MS) return hit.id;
            const gen = this.cacheGen;
            if (await this.folderAlive(hit.id)) {
                hit.checkedAt = this.now();
                return hit.id;
            }
            // The bucket folder (or "Deplao") was deleted / moved to the trash on Drive → forget all ids, re-check the root folder
            if (gen === this.cacheGen) {
                this.resetCaches();
                this.opts.invalidateRoot();
            }
            return this.folderId(dir, create);
        }
        const job = this.folderJobs.get(dir);
        if (job) {
            const id = await job.promise;
            if (id || job.create || !create) return id;
            return this.folderId(dir, create); // a job that was only looking (not creating) found nothing → now create it
        }
        const promise: Promise<string | null> = this.resolveFolder(dir, create).finally(() => {
            const cur = this.folderJobs.get(dir);
            if (cur && cur.promise === promise) this.folderJobs.delete(dir);
        });
        this.folderJobs.set(dir, { create, promise });
        return promise;
    }

    private async resolveFolder(dir: string, create: boolean): Promise<string | null> {
        const gen = this.cacheGen;
        const parentId = dir === '' ? await this.opts.rootId(create) : await this.folderId(parentDir(dir), create);
        if (!parentId) return null;
        const name = dir === '' ? this.bucket : baseName(dir);
        let id = await this.findFolder(parentId, name);
        if (!id) {
            if (!create) return null;
            this.noteName(parentId, name);
            const created = await this.api.createFolder(name, parentId);
            id = created.id;
            if (gen === this.cacheGen) this.fresh.set(id, new Set());
        }
        if (gen === this.cacheGen) this.folders.set(dir, { id, checkedAt: this.now() });
        return id;
    }

    private async findFolder(parentId: string, name: string): Promise<string | null> {
        const freshNames = this.fresh.get(parentId);
        if (freshNames && !freshNames.has(name)) return null;
        const res = await this.api.listFiles({
            q: `name = '${escapeQueryValue(name)}' and '${escapeQueryValue(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
            fields: 'files(id,name,createdTime)',
            orderBy: 'createdTime',
            pageSize: 10,
        });
        const hit = res.files
            .filter(f => f.name === name)
            .sort((a, b) => timeOf(a.createdTime) - timeOf(b.createdTime))[0];
        return hit ? hit.id : null;
    }

    private async folderAlive(id: string): Promise<boolean> {
        try {
            const f = await this.api.getFile(id, 'id,trashed');
            return !!f && !f.trashed;
        } catch (err) {
            if (isNotFound(err)) return false;
            throw err;
        }
    }

    // ── File ──

    /** File by key: cache (may be stale) → no lookup needed if this store created the folder and never wrote this name; otherwise look it up by name. */
    private async findFile(key: string, folderId: string, name: string): Promise<FoundFile | null> {
        const hit = this.cacheGet(key);
        if (hit && hit.parent === folderId) return { ...hit, cached: true };
        const freshNames = this.fresh.get(folderId);
        if (freshNames && !freshNames.has(name)) return null;
        const gen = this.cacheGen;
        const top = (await this.queryFiles(folderId, name))[0];
        if (!top) {
            this.forget(key);
            return null;
        }
        const entry = gen === this.cacheGen ? this.remember(key, folderId, top) : this.entryOf(folderId, top);
        return { ...entry, cached: false };
    }

    /** Files with the exact name in the folder, newest first. */
    private async queryFiles(folderId: string, name: string): Promise<DriveFileMeta[]> {
        const res = await this.api.listFiles({
            q: `name = '${escapeQueryValue(name)}' and '${escapeQueryValue(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
            fields: `files(${FILE_FIELDS})`,
            orderBy: 'modifiedTime desc',
            pageSize: 100,
        });
        // Compare names exactly on this machine (guards against Drive matching case-insensitively)
        return res.files
            .filter(f => f.name === name)
            .sort((a, b) => timeOf(b.modifiedTime) - timeOf(a.modifiedTime));
    }

    private entryOf(parent: string, f: DriveFileMeta): CachedFile {
        return { id: f.id, parent, size: Number(f.size) || 0, md5: f.md5Checksum || '', modifiedTime: f.modifiedTime || '' };
    }

    private cacheGet(key: string): CachedFile | null {
        const v = this.files.get(key);
        if (!v) return null;
        this.files.delete(key);
        this.files.set(key, v);
        return v;
    }

    private remember(key: string, parent: string, f: DriveFileMeta): CachedFile {
        const entry = this.entryOf(parent, f);
        this.files.delete(key);
        this.files.set(key, entry);
        while (this.files.size > this.fileCacheMax) {
            const oldest = this.files.keys().next().value;
            if (oldest === undefined) break;
            this.files.delete(oldest);
        }
        return entry;
    }

    /** Listing result: only remembered if nothing is stored yet or it is newer than the stored copy (for duplicate names, the newest wins). */
    private rememberListed(key: string, parent: string, f: DriveFileMeta): void {
        const cur = this.files.get(key);
        if (cur && cur.parent === parent && cur.id !== f.id && timeOf(cur.modifiedTime) > timeOf(f.modifiedTime)) return;
        this.remember(key, parent, f);
    }

    private forget(key: string): void {
        this.files.delete(key);
    }

    private noteName(folderId: string, name: string): void {
        const names = this.fresh.get(folderId);
        if (!names) return;
        names.add(name);
        if (names.size > FRESH_NAMES_MAX) this.fresh.delete(folderId);
    }

    private markDeleted(key: string): void {
        this.tombstones.delete(key);
        this.tombstones.set(key, this.now());
        while (this.tombstones.size > TOMBSTONE_MAX) {
            const oldest = this.tombstones.keys().next().value;
            if (oldest === undefined) break;
            this.tombstones.delete(oldest);
        }
    }

    private recentlyDeleted(key: string): boolean {
        const at = this.tombstones.get(key);
        if (at === undefined) return false;
        if (this.now() - at >= TOMBSTONE_TTL_MS) {
            this.tombstones.delete(key);
            return false;
        }
        return !this.files.has(key);
    }

    // ── Chung ──

    /** Remembered id no longer exists (404) → forget everything, re-check the root folder, redo it exactly once. */
    private async retryStale<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (err) {
            if (!isNotFound(err)) throw err;
            this.resetCaches();
            this.opts.invalidateRoot();
            return fn();
        }
    }

    /** Writes / deletes on the same key run one after another (no two files with the same name; If-None-Match works as intended). */
    private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.keyLocks.get(key);
        let release!: () => void;
        const mine = new Promise<void>(resolve => { release = resolve; });
        const chained = prev ? prev.then(() => mine) : mine;
        this.keyLocks.set(key, chained);
        try {
            if (prev) await prev;
            return await fn();
        } finally {
            release();
            if (this.keyLocks.get(key) === chained) this.keyLocks.delete(key);
        }
    }

    /** Account / root folder changed (GoogleDriveService bumps the generation number) → forget the cache. */
    private sync(): void {
        const g = this.opts.generation ? this.opts.generation() : 0;
        if (g !== this.seenGen) {
            this.seenGen = g;
            this.resetCaches();
        }
    }

    private resetCaches(): void {
        this.cacheGen++;
        this.folders.clear();
        this.folderJobs.clear();
        this.files.clear();
        this.fresh.clear();
        this.tombstones.clear();
    }

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    private sleep(ms: number): Promise<void> {
        if (this.opts.sleep) return this.opts.sleep(ms);
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    }
}
