/**
 * MediaUploader — hàng đợi tải media lên R2 (đọc từ chỉ mục cloud_media).
 *
 *  - Song song theo tuỳ chọn (mặc định 3, tối đa 16; có giới hạn băng thông hoặc đang tải bản gốc DB → 1),
 *    chỉ 22:00–07:00 nếu bật "chỉ ban đêm".
 *  - Chỉ file đã sửa xong ≥ 10 s; sha256 tính theo luồng; putFile (+ onProgress) → uploaded (tin 2xx + ETag của R2,
 *    không HEAD lại — trước khi xoá bản trên máy, MediaEvictor vẫn HEAD kiểm). File đổi trong lúc tải → để lượt sau.
 *    Nội dung không đổi (chỉ khác mtime) và R2 còn đúng bản → ghi nhận, không tải lại.
 *  - 429 (R2 giới hạn tốc độ) → cả hàng đợi lùi: max(retryAfterMs, 10 s × 2^(n-1)), tối đa 2 phút.
 *    Mất mạng / hết thời gian / 5xx → chỉ file đó thử lại sau vài giây; ≥ 6 lỗi liên tiếp không xen lần thành công nào
 *    mới lùi cả hàng đợi (mạng có vấn đề thật). Token sai / thiếu quyền / mất bucket → dừng, báo lỗi qua onFatal.
 *  - Lỗi riêng một file → thử lại file đó sau (lùi dần), quá 5 lần → "failed" (thử lại hằng ngày / khi bấm Tiếp tục).
 *  - Chốt chặn cuối của phạm vi lưu: dòng chờ tải nay ngoài phạm vi (đổi phạm vi khi đang tải, dòng cũ…) → excluded.
 */
import * as fs from 'fs';
import type { MediaSyncOptions } from '../../../shared/cloudContracts';
import type { R2Client } from '../contracts';
import type { MediaRow } from './CloudMediaIndex';
import { absPathFor, contentTypeFor, MediaScopeFilter, normEtag, objectKeyFor, relInScope } from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { dbBaseUploadActive } from '../uploadCoordinator';
import {
    ByteRateLimiter, classifyR2Error, errorText, LogFn, MINUTE, msUntilNightWindow, noLog, SECOND, sha256File, storeLabelNow,
    Waiter, yieldToLoop,
} from './util';

export const MIN_FILE_AGE_MS = 10 * SECOND;
export const BACKOFF_MIN_MS = 10 * SECOND;
export const BACKOFF_MAX_MS = 2 * MINUTE;
/** Lỗi tạm thời (mạng / 5xx) liên tiếp không xen lần thành công nào → mới tạm dừng cả hàng đợi. */
export const GLOBAL_PAUSE_AFTER_FAILURES = 6;
/** Lỗi tạm thời của một file: thử lại file đó sau 5 s × số lần lỗi liên tiếp (tối đa 1 phút), không chặn file khác. */
export const FILE_RETRY_BASE_MS = 5 * SECOND;
export const MAX_CONCURRENCY = 16;

export interface UploaderDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    options(): MediaSyncOptions;
    waiter: Waiter;
    isPaused(): boolean;
    /** Đang dừng vì lỗi chặn (token/quyền/bucket/mất kết nối) — chờ người dùng / kết nối lại. */
    isBlocked(): boolean;
    onFatal(kind: 'auth' | 'bucket', message: string): void;
    /** Trạng thái đổi (module tự gom thông báo cho renderer). */
    onChange(): void;
    /** Một file vừa lên R2 (bytes = 0 nếu chỉ ghi nhận lại bản đã có). */
    onUploaded(bytes: number): void;
    /** Phạm vi lưu đang áp; null / không có = mọi file. */
    scope?(ctx: MediaContext): MediaScopeFilter | null;
    now?(): number;
    fs?: { stat(p: string): Promise<fs.Stats> };
    hashFile?(p: string): Promise<string>;
    log?: LogFn;
}

class VerifyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VerifyError';
    }
}

export function authErrorMessage(err: unknown): string {
    const e = (err || {}) as { code?: unknown; message?: unknown };
    const code = String(e.code || '');
    const message = String(e.message || '').trim();
    const store = storeLabelNow();
    if (code === 'NOT_CONNECTED') {
        return store === 'R2'
            ? 'Chưa kết nối Cloudflare — kết nối lại rồi bấm Tiếp tục để lưu media lên R2.'
            : `${(message || 'Chưa đăng nhập Google Drive').replace(/[.\s]+$/, '')} — đăng nhập lại rồi bấm Tiếp tục.`;
    }
    // CloudError của client R2 / Google Drive đã có câu tiếng Việt (thiếu quyền, chưa bật R2, lệch giờ máy, Drive đầy…)
    if (message && (/^R2_/.test(code) || code === 'STORAGE_FULL')) return `${message} — sửa xong bấm Tiếp tục.`;
    return store === 'R2'
        ? 'Cloudflare từ chối ghi vào R2 — kiểm tra token (cần quyền R2: Edit) rồi bấm Tiếp tục.'
        : `${store} từ chối ghi — đăng nhập lại rồi bấm Tiếp tục.`;
}

export function bucketErrorMessage(bucket: string): string {
    const store = storeLabelNow();
    return store === 'R2'
        ? `Không tìm thấy bucket R2 "${bucket}" — tắt rồi bật lại lưu media lên R2 để tạo lại.`
        : `Không tìm thấy thư mục "${bucket}" trên ${store} — tắt rồi bật lại đồng bộ ảnh, file để tạo lại.`;
}

export class MediaUploader {
    /** Đang lùi tới thời điểm này (0 = không). Dùng chung cho tải về khi R2 bận. */
    backoffUntil = 0;
    /** Lỗi tạm thời gần nhất (mất mạng) — xoá khi tải thành công. */
    transientError: string | null = null;
    private busyStreak = 0;
    /** Lỗi tạm thời liên tiếp (mọi file) kể từ lần tải thành công gần nhất. */
    private transientStreak = 0;
    private inflight = 0;
    private readonly limiter: ByteRateLimiter;
    private readonly fs: { stat(p: string): Promise<fs.Stats> };
    private readonly hash: (p: string) => Promise<string>;
    private readonly log: LogFn;

    constructor(private readonly deps: UploaderDeps) {
        this.limiter = new ByteRateLimiter(0, () => this.now());
        this.fs = deps.fs || (fs.promises as unknown as { stat(p: string): Promise<fs.Stats> });
        this.hash = deps.hashFile || sha256File;
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    get activeUploads(): number {
        return this.inflight;
    }

    private scopeFilter(ctx: MediaContext): MediaScopeFilter | null {
        try {
            return this.deps.scope ? this.deps.scope(ctx) : null;
        } catch {
            return null;
        }
    }

    isBackingOff(): boolean {
        return this.backoffUntil > this.now();
    }

    clearBackoff(): void {
        this.backoffUntil = 0;
        this.busyStreak = 0;
        this.transientStreak = 0;
        this.transientError = null;
    }

    /** R2 bận khi tải về (resolveMissing…) → cả hàng đợi lùi chung. */
    noteBusy(retryAfterMs?: number): void {
        this.enterBackoff(retryAfterMs, null);
    }

    private enterBackoff(retryAfterMs: number | undefined, message: string | null): void {
        const now = this.now();
        if (message) this.transientError = message;
        // Đang lùi rồi: các lượt đang chạy dở cùng lỗi không làm tăng mũ thêm
        if (this.backoffUntil > now) return;
        this.busyStreak++;
        const exp = BACKOFF_MIN_MS * Math.pow(2, this.busyStreak - 1);
        const wait = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, Number(retryAfterMs) || 0, exp));
        this.backoffUntil = now + wait;
        this.log('warn', `[CloudMedia] ${message || 'R2 bận'} — tạm dừng tải lên ${Math.round(wait / 1000)} s`);
        this.deps.onChange();
    }

    private onSuccess(bytes: number): void {
        this.busyStreak = 0;
        this.transientStreak = 0;
        this.transientError = null;
        if (this.backoffUntil && this.backoffUntil <= this.now()) this.backoffUntil = 0;
        this.deps.onUploaded(bytes);
        this.deps.onChange();
    }

    /** ms phải chờ trước khi được nhận việc mới (0 = được chạy). */
    private gateDelay(): number {
        if (this.deps.isPaused() || this.deps.isBlocked()) return MINUTE; // chờ Tiếp tục / kết nối lại (được đánh thức)
        const now = this.now();
        if (this.backoffUntil > now) return this.backoffUntil - now;
        if (this.deps.options().nightOnly) {
            const ms = msUntilNightWindow(now);
            if (ms > 0) return ms;
        }
        return 0;
    }

    async run(isCurrent: () => boolean): Promise<void> {
        while (isCurrent()) {
            try {
                const gate = this.gateDelay();
                if (gate > 0) { await this.deps.waiter.wait(Math.min(gate, MINUTE)); continue; }
                const opts = this.deps.options();
                this.limiter.setKbps(opts.bandwidthKbps);
                // Giới hạn băng thông, hoặc đang tải bản gốc DB (file lớn cần lên trọn) → 1 file một lúc để nhường đường truyền.
                const maxConcurrent = opts.bandwidthKbps > 0 || dbBaseUploadActive()
                    ? 1
                    : Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(opts.concurrency) || 3)));
                if (this.inflight >= maxConcurrent) { await this.deps.waiter.wait(5 * SECOND); continue; }
                const throttle = this.limiter.waitMs();
                if (throttle > 0) { await this.deps.waiter.wait(Math.min(throttle, MINUTE)); continue; }
                const ctx = await this.deps.ctx.get();
                if (!isCurrent()) break;
                if (!ctx) { await this.deps.waiter.wait(15 * SECOND); continue; }
                const now = this.now();
                let picked = ctx.index.pickPending(maxConcurrent - this.inflight, now, now - MIN_FILE_AGE_MS);
                if (!this.deps.ctx.isValid(ctx) || !isCurrent()) continue;
                const filter = picked.length ? this.scopeFilter(ctx) : null;
                if (filter) {
                    const out = picked.filter((r) => !relInScope(r.rel_path, Number(r.mtime_ms) || 0, filter));
                    if (out.length) {
                        // Ngoài phạm vi lưu: không tải, không tính là chờ; lấy lượt khác ngay
                        ctx.index.markExcluded(out.map((r) => r.rel_path));
                        picked = picked.filter((r) => !out.includes(r));
                        if (!picked.length) { this.deps.onChange(); await yieldToLoop(); continue; }
                    }
                }
                const rows = picked.length ? ctx.index.claim(picked) : [];
                if (!rows.length) { await this.deps.waiter.wait(this.inflight ? 5 * SECOND : 30 * SECOND); continue; }
                for (const row of rows) {
                    this.inflight++;
                    void this.uploadOne(ctx, row, isCurrent)
                        .catch((err) => this.log('warn', `[CloudMedia] Lỗi tải lên ngoài dự kiến: ${errorText(err)}`))
                        .finally(() => {
                            this.inflight--;
                            this.deps.waiter.wake();
                        });
                }
            } catch (err) {
                this.log('warn', `[CloudMedia] Hàng đợi tải lên lỗi: ${errorText(err)}`);
                this.deps.ctx.invalidate();
                await this.deps.waiter.wait(15 * SECOND);
            }
        }
    }

    private async uploadOne(ctx: MediaContext, row: MediaRow, isCurrent: () => boolean): Promise<void> {
        const rel = row.rel_path;
        // Ghi DB chỉ khi vẫn đúng workspace và module còn chạy (tắt / đổi workspace → dòng 'uploading' được trả lại lần sau)
        const canWrite = () => isCurrent() && this.deps.ctx.isValid(ctx);
        let key: string;
        try {
            key = objectKeyFor(ctx.workspaceUid, rel);
        } catch {
            if (canWrite()) ctx.index.markMissing(rel, 'Đường dẫn file không hợp lệ');
            return;
        }
        const abs = absPathFor(ctx.realRoot, rel);

        let st: fs.Stats;
        try {
            st = await this.fs.stat(abs);
        } catch (err) {
            if (!canWrite()) return;
            const code = String((err as { code?: unknown })?.code || '');
            if (code === 'ENOENT' || code === 'ENOTDIR') ctx.index.markMissing(rel, 'File không còn trên máy');
            else ctx.index.markFailed(rel, errorText(err), this.now(), row.attempts);
            return;
        }
        if (!st.isFile() || st.size <= 0) {
            if (canWrite()) ctx.index.markMissing(rel, 'Không phải file hoặc file rỗng');
            return;
        }
        const size = st.size;
        const mtimeMs = Math.floor(st.mtimeMs);
        if (this.now() - st.mtimeMs < MIN_FILE_AGE_MS) {
            // Đang / vừa ghi → đợi đủ 10 s
            if (canWrite()) ctx.index.release(rel, { size, mtimeMs, nextTryAt: mtimeMs + MIN_FILE_AGE_MS + SECOND });
            return;
        }

        try {
            const r2 = this.deps.r2(ctx.bucket);
            const sha256 = await this.hash(abs);
            if (!canWrite()) return;

            // Chỉ đổi mtime, nội dung như bản đã tải → kiểm R2 rồi ghi nhận, không tải lại
            if (row.sha256 && row.sha256 === sha256 && Number(row.size) === size && row.etag) {
                const head = await r2.headObject(key);
                if (head && Number(head.size) === size && normEtag(head.etag) === normEtag(row.etag)) {
                    if (!canWrite()) return;
                    ctx.index.markUploaded(rel, { size, mtimeMs, sha256, etag: head.etag || row.etag, uploadedAt: this.now() });
                    this.onSuccess(0);
                    return;
                }
            }

            let sent = 0;
            const res = await r2.putFile(key, abs, {
                contentType: contentTypeFor(rel),
                metadata: { sha256, mtime: String(mtimeMs) },
                onProgress: (sentBytes: number) => {
                    const delta = Number(sentBytes) - sent;
                    if (delta > 0) {
                        sent = Number(sentBytes);
                        this.limiter.consume(delta);
                    }
                },
            });
            if (sent < size) this.limiter.consume(size - sent);
            if (!res?.etag) throw new VerifyError(`${storeLabelNow()} không trả về mã kiểm tra (ETag) của bản vừa tải lên`);
            if (Number(res.size) !== size) {
                throw new VerifyError(`Kích thước đã gửi không khớp (${res.size} ≠ ${size})`);
            }
            const after = await this.fs.stat(abs).catch((): null => null);
            if (!canWrite()) return;
            if (!after || after.size !== size || Math.floor(after.mtimeMs) !== mtimeMs) {
                // File đổi / bị xoá trong lúc tải → lượt sau tải bản mới (hoặc đánh dấu missing)
                ctx.index.release(rel, after ? { size: after.size, mtimeMs: Math.floor(after.mtimeMs) } : {});
                return;
            }
            // ETag của PUT / CompleteMultipartUpload cùng giá trị với HEAD (normEtag so sánh khi dọn file khỏi máy)
            ctx.index.markUploaded(rel, { size, mtimeMs, sha256, etag: res.etag, uploadedAt: this.now() });
            this.onSuccess(size);
        } catch (err) {
            this.onUploadError(ctx, row, err, canWrite);
        }
    }

    private onUploadError(ctx: MediaContext, row: MediaRow, err: unknown, canWrite: () => boolean): void {
        const rel = row.rel_path;
        const kind = err instanceof VerifyError ? 'other' : classifyR2Error(err);
        const e = (err || {}) as { status?: unknown; code?: unknown; retryAfterMs?: number };
        // Google Drive báo giới hạn tốc độ bằng 403 (client trả R2_BUSY kèm status 403) — cũng là giới hạn thật
        if (kind === 'busy' && (Number(e.status) === 429 || e.code === 'RATE_LIMITED' || (e.code === 'R2_BUSY' && Number(e.status) === 403))) {
            // Kho giới hạn tốc độ thật: cả hàng đợi chờ đúng thời gian kho yêu cầu (tối thiểu 10 s).
            this.enterBackoff(e.retryAfterMs, storeLabelNow() === 'R2' ? 'Cloudflare R2 đang giới hạn tốc độ tải lên.' : 'Google Drive đang giới hạn tốc độ tải lên.');
            if (canWrite()) ctx.index.release(rel);
            return;
        }
        if (kind === 'busy' || kind === 'network') {
            // Lỗi tạm thời (mạng chậm / hết thời gian / R2 5xx): chỉ file này thử lại sau vài giây, file khác chạy tiếp.
            // Không tính vào 5 lần lỗi của file (không phải lỗi của file). Nhiều lỗi liên tiếp → mạng có vấn đề thật → lùi chung.
            this.transientStreak++;
            const wait = Math.min(MINUTE, FILE_RETRY_BASE_MS * Math.min(12, this.transientStreak));
            if (canWrite()) ctx.index.release(rel, { nextTryAt: this.now() + wait });
            if (this.transientStreak >= GLOBAL_PAUSE_AFTER_FAILURES) {
                this.enterBackoff(e.retryAfterMs, kind === 'network'
                    ? `Mạng chậm hoặc mất kết nối tới ${storeLabelNow()}.`
                    : `${storeLabelNow()} trả lỗi tạm thời liên tục.`);
            }
            return;
        }
        if (kind === 'auth' || kind === 'bucket') {
            if (canWrite()) ctx.index.release(rel);
            this.deps.onFatal(kind, kind === 'auth' ? authErrorMessage(err) : bucketErrorMessage(ctx.bucket));
            return;
        }
        if (canWrite()) ctx.index.markFailed(rel, errorText(err), this.now(), row.attempts);
        this.log('warn', `[CloudMedia] Tải lên lỗi (${rel}): ${errorText(err)}`);
    }
}
