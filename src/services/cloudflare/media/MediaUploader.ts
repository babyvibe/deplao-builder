/**
 * MediaUploader: upload queue for media to R2 (reads from the cloud_media index).
 *
 *  - Parallel by option (default 3, max 16; with a bandwidth limit, or while a DB base snapshot is uploading → 1), and only from 22:00 to 07:00 when "chỉ ban đêm" (night only) is on.
 *  - Only files last modified ≥ 10 s ago; sha256 computed as a stream; putFile (+ onProgress) → uploaded (2xx from R2 + the ETag of R2,
 *    no HEAD again: before the copy on the machine is deleted, MediaEvictor still checks with HEAD). A file that changes during the upload → left for the next run.
 *    Content unchanged (only the mtime differs) and R2 still has the right copy → record it, do not upload again.
 *  - 429 (R2 rate limit) → the whole queue backs off: max(retryAfterMs, 10 s × 2^(n-1)), up to 2 minutes.
 *    Network loss / timeout / 5xx → only that file retries after a few seconds; ≥ 6 errors in a row with no success in between
 *    back off the whole queue (the network really has a problem). Wrong token / missing permission / bucket gone → stop, report the error via onFatal.
 *  - An error for a single file → retry that file later (backing off gradually); more than 5 times → "failed" (retried daily / when the user clicks Continue).
 *  - Last check of the storage scope: a waiting row that is now outside the scope (scope changed during the upload, an old row…) → excluded.
 */
import * as fs from 'fs';
import type { MediaSyncOptions } from '../../../shared/cloud/cloudContracts';
import type { R2Client } from '../contracts';
import type { MediaRow } from './CloudMediaIndex';
import { absPathFor, contentTypeFor, MediaScopeFilter, normEtag, objectKeyFor, relInScope } from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { dbBaseUploadActive } from '../uploadCoordinator';
import {
    ByteRateLimiter, classifyR2Error, errorText, LogFn, MINUTE, msUntilNightWindow, noLog, SECOND, sha256File, storeLabelNow,
    Waiter, yieldToLoop,
} from './util';
import { tr } from '../../../shared/i18n';

export const MIN_FILE_AGE_MS = 10 * SECOND;
export const BACKOFF_MIN_MS = 10 * SECOND;
export const BACKOFF_MAX_MS = 2 * MINUTE;
/** Temporary errors (network / 5xx) in a row with no success in between → only then pause the whole queue. */
export const GLOBAL_PAUSE_AFTER_FAILURES = 6;
/** Temporary error for one file: retry that file after 5 s × the number of errors in a row (max 1 minute), without blocking other files. */
export const FILE_RETRY_BASE_MS = 5 * SECOND;
export const MAX_CONCURRENCY = 16;

export interface UploaderDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    options(): MediaSyncOptions;
    waiter: Waiter;
    isPaused(): boolean;
    /** Stopped by a blocking error (token / permission / bucket / lost connection): waiting for the user / reconnect. */
    isBlocked(): boolean;
    onFatal(kind: 'auth' | 'bucket', message: string): void;
    /** State changed (the module batches the notifications for the renderer itself). */
    onChange(): void;
    /** A file just uploaded to R2 (bytes = 0 if it only records a copy that already exists). */
    onUploaded(bytes: number): void;
    /** Storage scope in effect; null / missing = every file. */
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
            ? tr('Chưa kết nối Cloudflare — kết nối lại rồi bấm Tiếp tục để lưu media lên R2.')
            : tr('{{v1}} — đăng nhập lại rồi bấm Tiếp tục.', { v1: (message || 'Chưa đăng nhập Google Drive').replace(/[.\s]+$/, '') });
    }
    // CloudErrors from the R2 / Google Drive clients already carry a Vietnamese message (missing permission, R2 not enabled, machine clock skew, Drive full…)
    if (message && (/^R2_/.test(code) || code === 'STORAGE_FULL')) return tr('{{message}} — sửa xong bấm Tiếp tục.', { message });
    return store === 'R2'
        ? tr('Cloudflare từ chối ghi vào R2 — kiểm tra token (cần quyền R2: Edit) rồi bấm Tiếp tục.')
        : tr('{{store}} từ chối ghi — đăng nhập lại rồi bấm Tiếp tục.', { store });
}

export function bucketErrorMessage(bucket: string): string {
    const store = storeLabelNow();
    return store === 'R2'
        ? tr('Không tìm thấy bucket R2 "{{bucket}}" — tắt rồi bật lại lưu media lên R2 để tạo lại.', { bucket })
        : tr('Không tìm thấy thư mục "{{bucket}}" trên {{store}} — tắt rồi bật lại đồng bộ ảnh, file để tạo lại.', { bucket, store });
}

export class MediaUploader {
    /** Backing off until this time (0 = not backing off). Shared with downloads when R2 is busy. */
    backoffUntil = 0;
    /** Most recent temporary error (lost network), cleared on a successful upload. */
    transientError: string | null = null;
    private busyStreak = 0;
    /** Temporary errors in a row (all files) since the last successful upload. */
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

    /** R2 busy while downloading (resolveMissing…) → the whole queue backs off. */
    noteBusy(retryAfterMs?: number): void {
        this.enterBackoff(retryAfterMs, null);
    }

    private enterBackoff(retryAfterMs: number | undefined, message: string | null): void {
        const now = this.now();
        if (message) this.transientError = message;
        // Already backing off: runs still in progress that hit the same error do not raise the exponent again
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

    /** ms to wait before taking new work (0 = may run now). */
    private gateDelay(): number {
        if (this.deps.isPaused() || this.deps.isBlocked()) return MINUTE; // waiting for Resume / reconnect (woken up)
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
                // Bandwidth limit, or a DB base snapshot is uploading (a large file that must go up in full) → 1 file at a time to leave the link free.
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
                        // Outside the storage scope: do not upload, do not count as waiting; take the next item right away
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
        // Write to the DB only if the workspace is still the same and the module is still running (turned off / workspace changed → the 'uploading' row is returned next time)
        const canWrite = () => isCurrent() && this.deps.ctx.isValid(ctx);
        let key: string;
        try {
            key = objectKeyFor(ctx.workspaceUid, rel);
        } catch {
            if (canWrite()) ctx.index.markMissing(rel, tr('Đường dẫn file không hợp lệ'));
            return;
        }
        const abs = absPathFor(ctx.realRoot, rel);

        let st: fs.Stats;
        try {
            st = await this.fs.stat(abs);
        } catch (err) {
            if (!canWrite()) return;
            const code = String((err as { code?: unknown })?.code || '');
            if (code === 'ENOENT' || code === 'ENOTDIR') ctx.index.markMissing(rel, tr('File không còn trên máy'));
            else ctx.index.markFailed(rel, errorText(err), this.now(), row.attempts);
            return;
        }
        if (!st.isFile() || st.size <= 0) {
            if (canWrite()) ctx.index.markMissing(rel, tr('Không phải file hoặc file rỗng'));
            return;
        }
        const size = st.size;
        const mtimeMs = Math.floor(st.mtimeMs);
        if (this.now() - st.mtimeMs < MIN_FILE_AGE_MS) {
            // Still being written / just written → wait a full 10 s
            if (canWrite()) ctx.index.release(rel, { size, mtimeMs, nextTryAt: mtimeMs + MIN_FILE_AGE_MS + SECOND });
            return;
        }

        try {
            const r2 = this.deps.r2(ctx.bucket);
            const sha256 = await this.hash(abs);
            if (!canWrite()) return;

            // Only the mtime changed, content the same as the uploaded copy → check R2, then record it, no re-upload
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
            if (!res?.etag) throw new VerifyError(tr('{{v1}} không trả về mã kiểm tra (ETag) của bản vừa tải lên', { v1: storeLabelNow() }));
            if (Number(res.size) !== size) {
                throw new VerifyError(tr('Kích thước đã gửi không khớp ({{count}} ≠ {{size}})', { count: res.size, size }));
            }
            const after = await this.fs.stat(abs).catch((): null => null);
            if (!canWrite()) return;
            if (!after || after.size !== size || Math.floor(after.mtimeMs) !== mtimeMs) {
                // File changed / deleted during the upload → the next run uploads the new version (or marks it missing)
                ctx.index.release(rel, after ? { size: after.size, mtimeMs: Math.floor(after.mtimeMs) } : {});
                return;
            }
            // The ETag of PUT / CompleteMultipartUpload has the same value as HEAD (normEtag is compared when cleaning a file off the machine)
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
        // Google Drive signals rate limiting with a 403 (the client returns R2_BUSY with status 403): this is a real limit too
        if (kind === 'busy' && (Number(e.status) === 429 || e.code === 'RATE_LIMITED' || (e.code === 'R2_BUSY' && Number(e.status) === 403))) {
            // The store's real rate limit: the whole queue waits exactly as long as the store asks (at least 10 s).
            this.enterBackoff(e.retryAfterMs, storeLabelNow() === 'R2' ? tr('Cloudflare R2 đang giới hạn tốc độ tải lên.') : tr('Google Drive đang giới hạn tốc độ tải lên.'));
            if (canWrite()) ctx.index.release(rel);
            return;
        }
        if (kind === 'busy' || kind === 'network') {
            // Temporary error (slow network / timeout / R2 5xx): only this file retries after a few seconds, other files keep running.
            // Not counted toward the file's 5 errors (it is not the file's fault). Many errors in a row → the network really has a problem → back off as a whole.
            this.transientStreak++;
            const wait = Math.min(MINUTE, FILE_RETRY_BASE_MS * Math.min(12, this.transientStreak));
            if (canWrite()) ctx.index.release(rel, { nextTryAt: this.now() + wait });
            if (this.transientStreak >= GLOBAL_PAUSE_AFTER_FAILURES) {
                this.enterBackoff(e.retryAfterMs, kind === 'network'
                    ? tr('Mạng chậm hoặc mất kết nối tới {{v1}}.', { v1: storeLabelNow() })
                    : tr('{{v1}} trả lỗi tạm thời liên tục.', { v1: storeLabelNow() }));
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
