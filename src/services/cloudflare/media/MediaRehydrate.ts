/**
 * MediaRehydrate — đưa file media từ R2 về lại máy.
 *
 *  - resolveMissing(absPath, { waitMs }): gọi từ local-media:// và route media của nhân viên khi file KHÔNG có trên máy.
 *    Chỉ file trong thư mục media của workspace đang mở mà chỉ mục ghi 'uploaded' / 'evicted' ('removed' = đã dọn khỏi
 *    R2 → không tải) → getObjectToFile về đúng đường dẫn gốc (đặt lại mtime gốc), state → 'uploaded', ghi lần mở. Gộp
 *    các yêu cầu trùng file; chờ tối đa waitMs (mặc định 60 s, kẹp 0…120 s) rồi trả null — lượt tải VẪN chạy tiếp ở nền
 *    (giữ trong inflight, không ghi "không có" vì nơi gọi thôi chờ) → lần sau có file ngay hoặc nhập vào cùng lượt tải.
 *    Không bao giờ ném.
 *  - rehydrateAll(): tải lại mọi file đã dọn ('evicted', rồi 'uploaded' mà máy không còn) — nền, 2 file song song,
 *    dừng khi ổ còn dưới 2 GB.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { R2Client } from '../contracts';
import type { MediaRow } from './CloudMediaIndex';
import { absPathFor, isSkippedRelPath, objectKeyFor, relPathInRoot, resolveStoredLocalPath } from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import {
    classifyR2Error, errorText, freeDiskBytes, GIB, LogFn, MINUTE, noLog, SECOND, sleep, storeLabelNow, withTimeout, yieldToLoop,
} from './util';

export const RESOLVE_TIMEOUT_MS = MINUTE;
/** Trần của waitMs do nơi gọi truyền vào. */
export const RESOLVE_MAX_WAIT_MS = 2 * MINUTE;
const NEGATIVE_TTL_MS = MINUTE;          // không có trong chỉ mục / chưa lên R2
const SHORT_NEGATIVE_TTL_MS = 10 * SECOND; // lỗi tạm (R2 bận, mạng)
const NEGATIVE_MAX = 5000;
const BULK_CONCURRENCY = 2;
const BULK_MIN_FREE_BYTES = 2 * GIB;

export interface RehydrateFs {
    stat(p: string): Promise<fs.Stats>;
    mkdir(p: string, opts: { recursive: true }): Promise<unknown>;
    utimes(p: string, atime: Date, mtime: Date): Promise<void>;
    realpath(p: string): Promise<string>;
}

export interface RehydrateDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    /** Hàng đợi đang lùi vì R2 bận → không tải về lúc này. */
    isBackingOff(): boolean;
    /** R2 bận khi tải về → lùi chung với hàng đợi tải lên. */
    onBusy(retryAfterMs?: number): void;
    /** Thông báo cho người dùng (vd ổ đầy khi tải lại toàn bộ). */
    onNotice?(message: string): void;
    onChange?(): void;
    now?(): number;
    fs?: RehydrateFs;
    freeBytes?(dir: string): Promise<number | null>;
    sleep?(ms: number): Promise<void>;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    log?: LogFn;
}

export class MediaRehydrate {
    private readonly inflight = new Map<string, Promise<string | null>>();
    private readonly negative = new Map<string, number>();
    private bulk: Promise<void> | null = null;
    private readonly fs: RehydrateFs;
    private readonly log: LogFn;

    constructor(private readonly deps: RehydrateDeps) {
        this.fs = deps.fs || (fs.promises as unknown as RehydrateFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    reset(): void {
        this.negative.clear();
    }

    get bulkRunning(): boolean {
        return !!this.bulk;
    }

    // ─── Theo yêu cầu ──────────────────────────────────────────────────

    /** Thời gian chờ: waitMs hợp lệ → kẹp [0, 120 s]; không có → mặc định (60 s, test đổi qua deps.timeoutMs). */
    private waitFor(opts?: { waitMs?: number }): number {
        const w = opts ? opts.waitMs : undefined;
        if (typeof w === 'number' && Number.isFinite(w)) return Math.min(RESOLVE_MAX_WAIT_MS, Math.max(0, Math.floor(w)));
        return this.deps.timeoutMs ?? RESOLVE_TIMEOUT_MS;
    }

    async resolveMissing(absPath: string, opts?: { waitMs?: number }): Promise<string | null> {
        try {
            if (!absPath || typeof absPath !== 'string') return null;
            const ctx = await this.deps.ctx.get();
            if (!ctx) return null;
            const rel = await this.relForMissing(ctx, absPath);
            if (!rel || isSkippedRelPath(rel)) return null;
            const key = `${ctx.id}|${rel}`;
            const until = this.negative.get(key);
            if (until !== undefined) {
                if (until > this.now()) return null;
                this.negative.delete(key);
            }
            let job = this.inflight.get(key);
            if (!job) {
                job = this.lookupAndRestore(ctx, rel, key).finally(() => this.inflight.delete(key));
                this.inflight.set(key, job);
            }
            // Hết thời gian chờ chỉ trả null cho nơi gọi; lượt tải không bị huỷ, không ghi vào bộ nhớ "không có"
            return await withTimeout(job, this.waitFor(opts), null);
        } catch {
            return null;
        }
    }

    private remember(key: string, ttl: number): void {
        if (this.negative.size >= NEGATIVE_MAX) this.negative.clear();
        this.negative.set(key, this.now() + ttl);
    }

    private async lookupAndRestore(ctx: MediaContext, rel: string, key: string): Promise<string | null> {
        try {
            const row = this.findRow(ctx, rel);
            if (!row || (row.state !== 'uploaded' && row.state !== 'evicted')) {
                this.remember(key, NEGATIVE_TTL_MS);
                return null;
            }
            const restored = await this.restore(ctx, row, () => this.deps.ctx.isValid(ctx));
            if (!restored) this.remember(key, SHORT_NEGATIVE_TTL_MS);
            return restored;
        } catch (err) {
            const kind = classifyR2Error(err);
            if (kind === 'busy' || kind === 'network') this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
            this.remember(key, SHORT_NEGATIVE_TTL_MS);
            this.log('warn', `[CloudMedia] Tải từ R2 lỗi (${rel}): ${errorText(err)}`);
            return null;
        }
    }

    /**
     * Đường dẫn bất kỳ trong thư mục media → rel. Thư mục cha còn trên máy → lấy đúng hoa/thường qua realpath
     * (chỉ mục lưu tên đúng như trên đĩa).
     */
    private async relForMissing(ctx: MediaContext, absPath: string): Promise<string | null> {
        let abs = absPath;
        if (!path.isAbsolute(abs)) {
            const resolved = resolveStoredLocalPath(abs, ctx.mediaRoot);
            if (!resolved) return null;
            abs = resolved;
        }
        let rel = relPathInRoot(ctx.mediaRoot, abs) || relPathInRoot(ctx.realRoot, abs);
        if (!rel) return null;
        const slash = rel.lastIndexOf('/');
        if (slash > 0) {
            try {
                const realDir = await this.fs.realpath(absPathFor(ctx.mediaRoot, rel.slice(0, slash)));
                const relDir = relPathInRoot(ctx.realRoot, realDir);
                if (relDir) rel = `${relDir}/${rel.slice(slash + 1)}`;
            } catch { /* thư mục cha không còn → giữ nguyên */ }
        }
        return rel;
    }

    private findRow(ctx: MediaContext, rel: string): MediaRow | undefined {
        let row = ctx.index.findRow([rel, rel.normalize('NFC'), rel.normalize('NFD')]);
        const platform = this.deps.platform || process.platform;
        if (!row && (platform === 'win32' || platform === 'darwin')) row = ctx.index.findRowCaseInsensitive(rel);
        return row;
    }

    /** Tải một file về đúng chỗ cũ. null khi không tải được (R2 bận, không còn trên R2…). Có thể ném lỗi R2. */
    private async restore(ctx: MediaContext, row: MediaRow, canWrite: () => boolean): Promise<string | null> {
        const rel = row.rel_path;
        const target = absPathFor(ctx.mediaRoot, rel);
        try {
            const st = await this.fs.stat(target);
            if (st.isFile()) {
                // Đã có trên máy (yêu cầu khác vừa tải xong / file được chép lại) — chỉ sửa trạng thái nếu đang ghi 'evicted'
                if (row.state === 'evicted' && canWrite()) ctx.index.markRestored(rel, this.now());
                return target;
            }
        } catch { /* chưa có → tải */ }
        if (this.deps.isBackingOff()) return null;
        await this.fs.mkdir(path.dirname(target), { recursive: true });
        const res = await this.deps.r2(ctx.bucket).getObjectToFile(objectKeyFor(ctx.workspaceUid, rel), target);
        if (!res) {
            this.log('warn', `[CloudMedia] Không còn trên R2: ${rel}`);
            if (canWrite()) ctx.index.markMissing(rel, `Không còn bản trên ${storeLabelNow()}`);
            return null;
        }
        if (Number(row.mtime_ms) > 0) {
            // Giữ mtime gốc → lượt quét sau không coi là file mới / đã đổi (không tải lên lại)
            try { await this.fs.utimes(target, new Date(), new Date(Number(row.mtime_ms))); } catch { /* bỏ qua */ }
        }
        if (canWrite()) ctx.index.markRestored(rel, this.now());
        this.deps.onChange?.();
        return target;
    }

    // ─── Tải lại toàn bộ ───────────────────────────────────────────────

    /** Chạy nền (gọi lại khi đang chạy → dùng chung lượt đang chạy). */
    rehydrateAll(isCurrent: () => boolean): Promise<void> {
        if (!this.bulk) {
            this.bulk = this.runBulk(isCurrent)
                .catch((err) => this.log('warn', `[CloudMedia] Tải lại media lỗi: ${errorText(err)}`))
                .finally(() => { this.bulk = null; });
        }
        return this.bulk;
    }

    private async runBulk(isCurrent: () => boolean): Promise<void> {
        const ctx = await this.deps.ctx.get();
        if (!ctx) return;
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        const freeBytes = this.deps.freeBytes || freeDiskBytes;
        const wait = this.deps.sleep || sleep;
        let restored = 0;
        let sinceSpaceCheck = Number.POSITIVE_INFINITY;
        // 'evicted' = đã dọn khỏi máy; 'uploaded' mà máy không còn file (vd DB khôi phục sang máy mới)
        for (const state of ['evicted', 'uploaded'] as const) {
            let before: { mtime: number; rel: string } | undefined;
            for (;;) {
                if (!alive()) return;
                const rows = ctx.index.rowsByStateNewestFirst(state, 50, before);
                if (!rows.length) break;
                const last = rows[rows.length - 1];
                before = { mtime: Number(last.mtime_ms), rel: last.rel_path };
                let todo = rows;
                if (state === 'uploaded') {
                    const present = await Promise.all(rows.map((r) =>
                        this.fs.stat(absPathFor(ctx.mediaRoot, r.rel_path)).then((s) => s.isFile(), () => false)));
                    todo = rows.filter((_, k) => !present[k]);
                }
                for (let i = 0; i < todo.length; i += BULK_CONCURRENCY) {
                    while (this.deps.isBackingOff()) {
                        if (!alive()) return;
                        await wait(5 * SECOND);
                    }
                    if (!alive()) return;
                    if (sinceSpaceCheck >= 20) {
                        sinceSpaceCheck = 0;
                        const free = await freeBytes(ctx.realRoot);
                        if (free !== null && free < BULK_MIN_FREE_BYTES) {
                            this.deps.onNotice?.(`Ổ đĩa còn dưới 2 GB — đã dừng tải lại media từ ${storeLabelNow()}.`);
                            return;
                        }
                    }
                    const batch = todo.slice(i, i + BULK_CONCURRENCY);
                    sinceSpaceCheck += batch.length;
                    const results = await Promise.all(batch.map(async (row) => {
                        try {
                            return await this.restore(ctx, row, alive);
                        } catch (err) {
                            const kind = classifyR2Error(err);
                            if (kind === 'busy' || kind === 'network') this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
                            else this.log('warn', `[CloudMedia] Tải lại lỗi (${row.rel_path}): ${errorText(err)}`);
                            return null;
                        }
                    }));
                    restored += results.filter(Boolean).length;
                }
                await yieldToLoop();
            }
        }
        if (restored) this.log('log', `[CloudMedia] Đã tải lại ${restored} file từ R2`);
    }
}
