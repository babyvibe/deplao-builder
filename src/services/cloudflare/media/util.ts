/**
 * Tiện ích dùng chung cho module R2 media: tuỳ chọn mặc định, chờ/đánh thức, phân loại lỗi R2, băm sha256 theo luồng,
 * dung lượng ổ trống, khung giờ đêm, giới hạn băng thông. Không phụ thuộc Electron / DB (test được độc lập).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ALL_SCOPE, CloudScope, MediaSyncOptions, normalizeScope, sameScope } from '../../../shared/cloud/cloudContracts';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const GIB = 1024 * 1024 * 1024;

export type LogFn = (level: 'log' | 'warn' | 'error', message: string) => void;
export const noLog: LogFn = () => { /* im lặng */ };

// ─── Tuỳ chọn ────────────────────────────────────────────────────────────────

export const DEFAULT_MEDIA_OPTIONS: MediaSyncOptions = {
    concurrency: 3,
    nightOnly: false,
    bandwidthKbps: 0,
    evictEnabled: false,
    evictKeepDays: 30,
    evictMinFreeGb: 20,
    scope: { ...ALL_SCOPE },
    includeShared: true,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Chuẩn hoá tuỳ chọn (giá trị lạ → mặc định, kẹp trong khoảng hợp lệ). */
export function normalizeMediaOptions(input?: Partial<MediaSyncOptions> | null): MediaSyncOptions {
    const o: Partial<MediaSyncOptions> = input && typeof input === 'object' ? input : {};
    const minFree = Number(o.evictMinFreeGb);
    return {
        concurrency: clampInt(o.concurrency, DEFAULT_MEDIA_OPTIONS.concurrency, 1, 16),
        nightOnly: typeof o.nightOnly === 'boolean' ? o.nightOnly : DEFAULT_MEDIA_OPTIONS.nightOnly,
        bandwidthKbps: clampInt(o.bandwidthKbps, DEFAULT_MEDIA_OPTIONS.bandwidthKbps, 0, 10_000_000),
        evictEnabled: o.evictEnabled === true,
        evictKeepDays: clampInt(o.evictKeepDays, DEFAULT_MEDIA_OPTIONS.evictKeepDays, 1, 3650),
        evictMinFreeGb: Number.isFinite(minFree)
            ? Math.min(100_000, Math.max(0, Math.round(minFree * 10) / 10))
            : DEFAULT_MEDIA_OPTIONS.evictMinFreeGb,
        // Thiếu / sai kiểu → tất cả tài khoản, toàn bộ thời gian, có file dùng chung (như trước khi có phạm vi)
        scope: normalizeScope(o.scope),
        includeShared: typeof o.includeShared === 'boolean' ? o.includeShared : true,
    };
}

/** Phạm vi lưu (thiếu = tất cả). */
export function mediaScopeOf(o: Partial<MediaSyncOptions> | null | undefined): CloudScope {
    return o && o.scope ? o.scope : ALL_SCOPE;
}

/** Có lưu file không thuộc tài khoản nào không (thiếu = có). */
export function includeSharedOf(o: Partial<MediaSyncOptions> | null | undefined): boolean {
    return !o || o.includeShared !== false;
}

/** Hai bộ tuỳ chọn cùng phạm vi lưu (tài khoản, từ ngày, file dùng chung). */
export function sameMediaScope(a: Partial<MediaSyncOptions> | null | undefined, b: Partial<MediaSyncOptions> | null | undefined): boolean {
    return includeSharedOf(a) === includeSharedOf(b) && sameScope(mediaScopeOf(a), mediaScopeOf(b));
}

/** Bản sao sâu (mảng tài khoản không dùng chung tham chiếu với bản đang giữ). */
export function cloneMediaOptions(o: MediaSyncOptions): MediaSyncOptions {
    const scope = mediaScopeOf(o);
    return {
        ...o,
        scope: { accounts: scope.accounts === 'all' ? 'all' : [...scope.accounts], fromTs: scope.fromTs },
        includeShared: includeSharedOf(o),
    };
}

// ─── Hẹn giờ ─────────────────────────────────────────────────────────────────

export function unrefTimer(timer: unknown): void {
    try { (timer as { unref?: () => void })?.unref?.(); } catch { /* bỏ qua */ }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => unrefTimer(setTimeout(resolve, Math.max(0, ms))));
}

/** Nhường vòng lặp sự kiện (giữa các thư mục / lô) để không chặn luồng chính. */
export function yieldToLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

export interface Waiter {
    /** Chờ tối đa ms, hoặc tới khi wake(). */
    wait(ms: number): Promise<void>;
    wake(): void;
}

/** Chờ có thể đánh thức sớm (tiếp tục, đổi tuỳ chọn, có file mới, một lượt tải xong…). */
export class Waker implements Waiter {
    private readonly waiters = new Set<() => void>();

    wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const done = () => {
                if (timer) clearTimeout(timer);
                this.waiters.delete(done);
                resolve();
            };
            this.waiters.add(done);
            timer = setTimeout(done, Math.max(0, ms));
            unrefTimer(timer);
        });
    }

    wake(): void {
        for (const done of Array.from(this.waiters)) done();
    }
}

/** Promise với hạn chót: hết hạn → trả fallback (promise gốc vẫn chạy tiếp, không bị huỷ). */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
        unrefTimer(timer);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(fallback); },
        );
    });
}

/** Khung giờ đêm 22:00–07:00 (giờ máy). 0 = đang trong khung; > 0 = số ms tới 22:00 hôm nay. */
export function msUntilNightWindow(now: number): number {
    const d = new Date(now);
    const h = d.getHours();
    if (h >= 22 || h < 7) return 0;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 22, 0, 0, 0).getTime();
    return Math.max(SECOND, start - now);
}

/** ms tới lần kế tiếp đồng hồ máy chỉ hour:minute (luôn > 0). */
export function msUntilLocalTime(now: number, hour: number, minute = 0): number {
    const d = new Date(now);
    let target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
    if (target <= now) target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, minute, 0, 0).getTime();
    return Math.max(SECOND, target - now);
}

// ─── Giới hạn băng thông ─────────────────────────────────────────────────────

/**
 * Token bucket theo byte. kbps = kilobit/giây (0 = không giới hạn). putFile của R2Client tự đọc file (không nhận
 * stream), nên không chặn được giữa chừng: byte gửi đi (onProgress) được trừ vào quỹ, quỹ âm = "nợ" → lượt tải sau
 * phải chờ trả hết nợ. Tốc độ trung bình đúng giới hạn; từng file vẫn có thể chạy nhanh hơn trong lúc gửi.
 */
export class ByteRateLimiter {
    private tokens = 0;
    private last: number;
    private kbps: number;

    constructor(kbps: number, private readonly now: () => number = Date.now) {
        this.kbps = Math.max(0, Number(kbps) || 0);
        this.last = now();
    }

    setKbps(kbps: number): void {
        const next = Math.max(0, Number(kbps) || 0);
        if (next === this.kbps) return;
        this.refill();
        this.kbps = next;
        if (!next) this.tokens = 0;
    }

    /** byte / giây */
    private get rate(): number {
        return (this.kbps * 1000) / 8;
    }

    private refill(): void {
        const t = this.now();
        const dt = Math.max(0, t - this.last) / 1000;
        this.last = t;
        if (!this.kbps) return;
        // Dồn tối đa 1 giây quỹ khi rảnh, tránh bùng nổ sau thời gian nghỉ dài
        this.tokens = Math.min(this.rate, this.tokens + dt * this.rate);
    }

    consume(bytes: number): void {
        if (!this.kbps || !(bytes > 0)) return;
        this.refill();
        this.tokens -= bytes;
    }

    /** ms phải chờ trước khi bắt đầu lượt tải tiếp theo (0 = được tải ngay). */
    waitMs(): number {
        if (!this.kbps) return 0;
        this.refill();
        return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
    }
}

// ─── Kho lưu ─────────────────────────────────────────────────────────────────

/** Tên kho đang chọn cho câu báo ("R2" / "Google Drive") — xem ../storeLabel. */
export { storeLabelNow } from '../storeLabel';

// ─── Lỗi R2 ──────────────────────────────────────────────────────────────────

/**
 * busy    — 429 / 5xx (CloudError 'R2_BUSY'): cả hàng đợi lùi chung.
 * network — mất mạng / hết thời gian: cả hàng đợi lùi chung.
 * auth    — token sai / thiếu quyền / chưa kết nối: dừng hàng đợi, báo người dùng.
 * bucket  — bucket không còn: dừng hàng đợi, báo người dùng.
 * other   — lỗi riêng của một file (đọc file, kích thước không khớp…): thử lại file đó sau.
 */
export type R2ErrorKind = 'busy' | 'network' | 'auth' | 'bucket' | 'other';

const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|EPIPE|ERR_SOCKET_[A-Z_]+|UND_ERR_[A-Z_]+|ERR_STREAM_PREMATURE_CLOSE)$/;

export function classifyR2Error(err: unknown): R2ErrorKind {
    const e = (err || {}) as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
    const code = String(e.code ?? '');
    const status = Number(e.status ?? e.statusCode ?? 0) || 0;
    const message = String(e.message ?? '');
    if (code === 'R2_BUSY' || code === 'RATE_LIMITED' || status === 429 || status >= 500) return 'busy';
    // R2_NOT_ENABLED / R2_CLOCK_SKEW: người dùng phải xử lý (bật R2, chỉnh giờ máy) → dừng như lỗi quyền
    if (code === 'NOT_CONNECTED' || code === 'R2_NOT_ENABLED' || code === 'R2_CLOCK_SKEW' || status === 401 || status === 403
        || /AUTH|FORBIDDEN|PERMISSION|DENIED|UNAUTHORI[SZ]ED|INVALID_?TOKEN|TOKEN_|SIGNATURE|CREDENTIAL|ACCESS_?KEY/i.test(code)) return 'auth';
    // Chỉ "bucket không còn" mới dừng cả hàng đợi; 404 khác (R2_NO_UPLOAD, R2_NOT_FOUND) là lỗi riêng một file
    if (code === 'R2_NO_BUCKET' || /NO_?SUCH_?BUCKET|BUCKET_?NOT_?FOUND/i.test(code) || /NoSuchBucket/i.test(message)) return 'bucket';
    if (NETWORK_CODES.test(code) || /NETWORK|TIMEOUT|TIMED_?OUT/i.test(code) || /socket hang up|network|timed? ?out/i.test(message)) return 'network';
    return 'other';
}

export function errorText(err: unknown): string {
    const msg = (err as { message?: unknown })?.message ?? err ?? 'Lỗi không xác định';
    return String(msg).slice(0, 300);
}

// ─── File / ổ đĩa ────────────────────────────────────────────────────────────

/** sha256 (hex) đọc theo luồng 1 MiB — không nạp cả file vào RAM. */
export function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** Dung lượng còn trống (byte) của ổ chứa dir; null nếu không đọc được (fs.statfs không có / lỗi). */
export async function freeDiskBytes(dir: string): Promise<number | null> {
    try {
        const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> }).statfs;
        if (typeof statfs !== 'function') return null;
        const s = await statfs(dir);
        const free = Number(s.bavail) * Number(s.bsize);
        return Number.isFinite(free) && free >= 0 ? free : null;
    } catch {
        return null;
    }
}
