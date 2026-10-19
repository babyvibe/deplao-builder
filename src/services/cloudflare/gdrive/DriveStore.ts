/**
 * DriveStore — một "bucket" trên Google Drive (thư mục Deplao/<bucket>) theo đúng hợp đồng R2Client để module media /
 * đồng bộ DB dùng nguyên, không biết mình đang chạy trên Drive.
 *
 *  - Khoá `a/b/c.jpg` = thư mục a → b (con của thư mục bucket) + file `c.jpg`. Đọc không bao giờ tạo thư mục (thiếu =
 *    không có object); ghi tạo thư mục còn thiếu — hai lệnh ghi song song cùng thư mục chỉ tạo một (dồn theo đường dẫn),
 *    hai lệnh ghi cùng khoá chạy lần lượt.
 *  - Cache trong RAM: đường dẫn thư mục → id; khoá → { id, size, md5, modifiedTime } (LRU ~5000). Thư mục do chính
 *    store này vừa tạo: biết chắc trong đó có tên nào → file mới không cần tra (đỡ 100 đơn vị quota / file lúc tải lên
 *    lần đầu hàng loạt).
 *  - Drive cho trùng tên: đọc lấy file mới nhất (modifiedTime), thư mục lấy bản tạo sớm nhất (mọi máy chọn cùng một).
 *  - putFile ≤ 5 MiB: một request multipart; lớn hơn: phiên resumable, đoạn 8 MiB, mỗi đoạn thử lại 3 lần (hỏi lại
 *    server đã nhận tới đâu rồi gửi tiếp). ETag = md5Checksum của Drive (PUT và HEAD cùng giá trị).
 *  - Xoá = xoá hẳn (không vào thùng rác — thùng rác vẫn tính dung lượng tài khoản).
 *  - id đã nhớ không còn (người dùng xoá thư mục / file trên Drive → 404) → quên cache, kiểm lại thư mục gốc, làm lại
 *    một lần. Thư mục bucket được kiểm lại 10 phút / lần (bị bỏ vào thùng rác thì file mới không rơi vào thùng rác).
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

export const DRIVE_SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024;
export const DRIVE_CHUNK_SIZE = 8 * 1024 * 1024;
/** Đoạn resumable phải là bội của 256 KiB (trừ đoạn cuối). */
export const DRIVE_CHUNK_ALIGN = 256 * 1024;
const CHUNK_BACKOFF_MS = [1000, 3000, 9000];
const FILE_CACHE_MAX = 5000;
const DELETE_CONCURRENCY = 4;
const FOLDER_RECHECK_MS = 10 * 60_000;
const TOMBSTONE_TTL_MS = 10 * 60_000;
const TOMBSTONE_MAX = 20_000;
/** Thư mục "mới" giữ tối đa bấy nhiêu tên; vượt thì thôi theo dõi (quay về tra từng file). */
const FRESH_NAMES_MAX = 20_000;
const FILE_FIELDS = 'id,name,size,md5Checksum,modifiedTime';
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)';
const MAX_APP_PROPERTIES = 30;
/** Drive: mỗi appProperty tối đa 124 byte UTF-8 cho cả khoá + giá trị. */
const MAX_APP_PROPERTY_BYTES = 124;

type PutFileOptions = R2PutOptions & {
    onProgress?: (sentBytes: number, totalBytes: number) => void;
    onRetry?: (info: { part: number | null; attempt: number; maxAttempts: number; error: string }) => void;
};

export interface DriveStoreOptions {
    bucket: string;
    api: DriveApi;
    /** id thư mục gốc "Deplao" (create=false: không tạo — null nếu chưa có). */
    rootId: (create: boolean) => Promise<string | null>;
    /** Một id đã nhớ không còn → lần sau kiểm lại thư mục gốc. */
    invalidateRoot: () => void;
    /** Đổi tài khoản / thư mục gốc → số tăng → store tự quên cache. */
    generation?: () => number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Ngưỡng tải một request (multipart); lớn hơn dùng resumable. Mặc định 5 MiB. */
    simpleUploadMax?: number;
    /** Cỡ đoạn resumable (làm tròn xuống bội 256 KiB). Mặc định 8 MiB. */
    chunkSize?: number;
    /** Số lần thử lại mỗi đoạn (mặc định 3). */
    chunkRetries?: number;
    fileCacheMax?: number;
    /** deleteObjects: số lệnh xoá song song (mặc định 4). */
    deleteConcurrency?: number;
}

interface CachedFile { id: string; parent: string; size: number; md5: string; modifiedTime: string }
/** cached = lấy từ cache (có thể cũ); false = vừa tra trên Drive. */
interface FoundFile extends CachedFile { cached: boolean }

interface ListCursor {
    v: 1;
    /** prefix của lần gọi đầu (mã trang chỉ dùng được với đúng prefix đó) */
    p: string;
    /** thư mục còn phải liệt kê (BFS): id + tiền tố khoá; f = lọc tên ở tầng đầu */
    q: Array<{ id: string; path: string; f?: string }>;
    /** pageToken của Drive cho q[0] */
    t: string | null;
}

// ─── Tiện ích ────────────────────────────────────────────────────────────────

function checkKey(key: string): string {
    const k = String(key ?? '');
    if (!k || Buffer.byteLength(k, 'utf8') > 1024 || k.startsWith('/') || k.endsWith('/') || k.includes('//')) {
        throw new CloudError('R2_BAD_KEY', 'Tên object không hợp lệ');
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
    return String((err as Error)?.message || err || 'Lỗi không xác định').slice(0, 300);
}

/** Cắt chuỗi theo byte UTF-8 (không cắt đôi ký tự). */
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

/** metadata kiểu R2 → appProperties của Drive (≤ 30 mục, khoá + giá trị ≤ 124 byte; không vừa thì cắt / bỏ). */
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

/** Đọc [start, end) của file theo khối 256 KiB (không nạp cả file vào RAM). */
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

/** Gom nội dung tải về vào RAM (getObject). */
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
    } catch { /* rơi xuống lỗi */ }
    throw new CloudError('R2_BAD_REQUEST', 'Mã trang danh sách không hợp lệ');
}

/** Lỗi riêng của một khoá khi xoá nhiều (còn lại — bận / mạng / quyền — là lỗi cả lệnh, ném ra). */
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
    /** đường dẫn thư mục trong bucket ('' = thư mục bucket) → id */
    private readonly folders = new Map<string, { id: string; checkedAt: number }>();
    /** đang tra / tạo thư mục (một việc cho mỗi đường dẫn) */
    private readonly folderJobs = new Map<string, { create: boolean; promise: Promise<string | null> }>();
    /** khoá → file (LRU theo thứ tự chèn của Map) */
    private readonly files = new Map<string, CachedFile>();
    /** id thư mục do store này tạo → tên (file / thư mục con) có thể đã có trong đó; ngoài danh sách = chắc chắn chưa có */
    private readonly fresh = new Map<string, Set<string>>();
    /** khoá vừa xoá (ms) — xoá lại trong 10 phút khỏi phải tra (thử lại deleteObjects sau khi bận) */
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

    // ── API công khai (R2Client) ──

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
        if (!st.isFile()) throw new CloudError('R2_BAD_FILE', `Không phải file: ${path.basename(filePath)}`);
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
            // id đã nhớ: get theo id (5 đơn vị) thay vì tra theo tên (100) — luôn đọc số mới (máy khác có thể vừa ghi đè)
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
     * Xoá nhiều khoá: từng file (Drive không có lệnh xoá hàng loạt), 4 lệnh song song. Thiếu file = coi như đã xoá.
     * Bận / mất mạng / bị từ chối → dừng nhận khoá mới, chờ các lệnh đang chạy rồi ném (như lỗi cả request của R2);
     * khoá vừa xoá được nhớ 10 phút nên lần thử lại không tốn lượt tra.
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
     * Một trang danh sách (≤ maxKeys). prefix 'a/b/' = mọi file dưới thư mục a/b (đệ quy); 'a/b/x' = trong a/b chỉ lấy
     * tên bắt đầu bằng 'x' (file, hoặc thư mục → lấy hết bên trong). Mã trang = trạng thái duyệt (base64 JSON).
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
                page = { files: [], nextPageToken: null }; // thư mục vừa bị xoá giữa hai trang
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
        throw new CloudError('UNSUPPORTED', 'Google Drive không có liên kết tải ký sẵn');
    }

    /** Tạo thư mục Deplao/<bucket> nếu chưa có (ensureBucket). */
    async ensureBucketFolder(): Promise<string> {
        this.sync();
        return this.retryStale(async () => {
            const id = await this.folderId('', true);
            if (!id) throw new CloudError('R2_ERROR', 'Không tạo được thư mục trên Google Drive');
            return id;
        });
    }

    // ── Tải lên ──

    private async upload(key: string, source: ContentSource, opts: R2PutOptions, cb: Pick<PutFileOptions, 'onProgress' | 'onRetry'>): Promise<DriveFileMeta> {
        const { dir, name } = splitKey(key);
        const gen = this.cacheGen;
        const folderId = await this.folderId(dir, true);
        if (!folderId) throw new CloudError('R2_ERROR', 'Không tạo được thư mục trên Google Drive');
        const existing = await this.findFile(key, folderId, name);
        if (existing && opts.ifNoneMatch === '*') throw new CloudError('R2_EXISTS', 'Đã có file này trên Google Drive', 412);

        const size = source.size;
        const mimeType = opts.contentType || DEFAULT_MIME;
        const props = toAppProperties(opts.metadata);
        const hasProps = Object.keys(props).length > 0;
        const metadata: Record<string, unknown> = existing
            ? { mimeType, ...(hasProps ? { appProperties: props } : {}) }
            : { name, parents: [folderId], mimeType, ...(hasProps ? { appProperties: props } : {}) };
        const progress = (sent: number) => {
            if (!cb.onProgress) return;
            try { cb.onProgress(Math.max(0, Math.min(sent, size)), size); } catch { /* callback lỗi không làm hỏng tải lên */ }
        };
        this.tombstones.delete(key);
        // Ghi tên trước khi tạo: request lỗi mà Drive vẫn tạo xong → lần sau phải tra, không tạo trùng
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

    /** Phiên resumable: đoạn chunkSize, mỗi đoạn thử lại chunkRetries lần, hỏi lại server đã nhận tới đâu trước khi gửi lại. */
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
                // Server báo đã đủ byte nhưng chưa trả file (hiếm) → hỏi lại để lấy kết quả
                state = await this.api.queryUpload(session, total);
                if (state.file) return state.file;
                throw new CloudError('R2_ERROR', 'Google Drive chưa hoàn tất file vừa tải lên');
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
                    } catch { /* callback lỗi không làm hỏng tải lên */ }
                    const hinted = err instanceof CloudError && err.retryAfterMs ? Math.min(err.retryAfterMs, 30_000) : 0;
                    await this.sleep(Math.max(hinted, CHUNK_BACKOFF_MS[Math.min(attempt, CHUNK_BACKOFF_MS.length - 1)]));
                    // Server có thể đã nhận một phần / cả đoạn vừa lỗi → hỏi lại rồi gửi tiếp từ đó
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
                // Server không giữ thêm byte nào (hiếm): không lặp vô hạn
                if (++stalls > this.chunkRetries) {
                    throw new CloudError('R2_BUSY', 'Google Drive chưa nhận dữ liệu tải lên — tự thử lại sau.', 503, NETWORK_WAIT_MS);
                }
            } else {
                stalls = 0;
            }
            offset = Math.max(0, Math.min(total, state.next));
            progress(offset);
        }
    }

    // ── Đọc / xoá ──

    /** Tìm file rồi đọc; id trong cache đã mất (404) → tra lại theo tên một lần. null = không có. */
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
            throw new CloudError('R2_NETWORK', 'Tải từ Google Drive bị đứt giữa chừng', undefined, NETWORK_WAIT_MS);
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
                // Tra theo tên: xoá hết các bản trùng tên (R2: xoá xong thì HEAD phải không còn)
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

    // ── Thư mục ──

    /** id thư mục theo đường dẫn trong bucket ('' = thư mục bucket); create=false không tạo (null nếu thiếu). */
    private async folderId(dir: string, create: boolean): Promise<string | null> {
        const hit = this.folders.get(dir);
        if (hit) {
            if (dir !== '' || this.now() - hit.checkedAt < FOLDER_RECHECK_MS) return hit.id;
            const gen = this.cacheGen;
            if (await this.folderAlive(hit.id)) {
                hit.checkedAt = this.now();
                return hit.id;
            }
            // Thư mục bucket (hoặc "Deplao") đã bị xoá / bỏ vào thùng rác trên Drive → quên mọi id, kiểm lại thư mục gốc
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
            return this.folderId(dir, create); // việc đang chạy chỉ tra (không tạo) và không thấy → giờ tạo
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

    /** File theo khoá: cache (có thể cũ) → không cần tra nếu thư mục do mình tạo và chưa từng ghi tên này → tra theo tên. */
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

    /** Các file đúng tên trong thư mục, mới nhất trước. */
    private async queryFiles(folderId: string, name: string): Promise<DriveFileMeta[]> {
        const res = await this.api.listFiles({
            q: `name = '${escapeQueryValue(name)}' and '${escapeQueryValue(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
            fields: `files(${FILE_FIELDS})`,
            orderBy: 'modifiedTime desc',
            pageSize: 100,
        });
        // So tên chính xác ở máy (phòng Drive so khớp không phân biệt hoa / thường)
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

    /** Kết quả liệt kê: chỉ nhớ khi chưa có hoặc mới hơn bản đang nhớ (trùng tên → bản mới nhất thắng). */
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

    /** id đã nhớ không còn (404) → quên hết, kiểm lại thư mục gốc, làm lại đúng một lần. */
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

    /** Ghi / xoá cùng một khoá chạy lần lượt (không tạo hai file trùng tên, If-None-Match đúng nghĩa). */
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

    /** Đổi tài khoản / thư mục gốc (GoogleDriveService tăng số thế hệ) → quên cache. */
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
