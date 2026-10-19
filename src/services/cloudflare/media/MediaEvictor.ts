/**
 * MediaEvictor — dọn file media khỏi máy khi đã chắc chắn có bản trên R2.
 *
 * Quy tắc an toàn (mọi đường dọn đều qua evictOne):
 *  0. Chỉ khi người dùng bật "giải phóng ổ đĩa" (evictEnabled; mặc định TẮT = giữ nguyên file trên máy) — kiểm tra ở
 *     đầu mỗi lượt, trước mỗi file và ngay trước khi xoá (tắt giữa chừng → dừng ngay).
 *  1. Chỉ dòng chỉ mục 'uploaded' (đọc lại ngay trước khi xoá). File chưa có trong chỉ mục / pending / missing → giữ.
 *  2. File trên máy phải đúng kích thước + mtime lúc tải lên; khác → tải lên lại, giữ file.
 *  3. HEAD object trên R2: phải có, đúng kích thước (và ETag nếu có) → mới xoá file trên máy; sai → tải lên lại, giữ file.
 *  4. state → 'evicted'. Không bao giờ xoá gì trên R2.
 *
 * Hai đường:
 *  - runSpaceEviction (tuỳ chọn evictEnabled; hằng ngày ~03:00 và sau các lô tải lên lớn): ứng viên = uploaded, cũ hơn
 *    evictKeepDays (theo mtime) và không mở trong evictKeepDays; cũ nhất trước; dừng khi ổ trống ≥ evictMinFreeGb.
 *    Không đọc được dung lượng trống (fs.statfs lỗi) → dọn hết ứng viên (đều cũ, đã xác minh trên R2).
 *  - evictAccountOlderThan (thay "tự xoá media cũ sau N ngày" của từng tài khoản khi đồng bộ media bật VÀ bật giải
 *    phóng ổ đĩa, tài khoản trong phạm vi lưu): các thư mục ngày YYYY-MM-DD cũ hơn N ngày của tài khoản → chỉ dọn file
 *    đã xác minh trên R2; file chưa sao lưu được giữ lại (file trong phạm vi lưu được đưa vào chỉ mục để tải lên trước,
 *    lần dọn sau sẽ dọn). Thư mục được giữ (rỗng cũng không xoá).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MediaSyncOptions } from '../../../shared/cloudContracts';
import type { R2Client } from '../contracts';
import type { ScannedFile } from './CloudMediaIndex';
import {
    absPathFor, isSkippedDirName, isSkippedFileName, MediaScopeFilter, normEtag, objectKeyFor, relInScope, relPathInRoot,
} from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { classifyR2Error, DAY, errorText, freeDiskBytes, GIB, LogFn, noLog, yieldToLoop } from './util';

export interface EvictorFs {
    stat(p: string): Promise<fs.Stats>;
    unlink(p: string): Promise<void>;
    readdir(p: string, opts: { withFileTypes: true }): Promise<fs.Dirent[]>;
    realpath(p: string): Promise<string>;
}

export interface EvictorDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    options(): MediaSyncOptions;
    isBackingOff(): boolean;
    onBusy(retryAfterMs?: number): void;
    /** Có file vừa được đưa vào chỉ mục (đánh thức hàng đợi tải lên). */
    onIndexed?(count: number): void;
    /** Phạm vi lưu đang áp (file chưa có trong chỉ mục chỉ được đưa vào nếu trong phạm vi); null = mọi file. */
    scope?(ctx: MediaContext): MediaScopeFilter | null;
    now?(): number;
    fs?: EvictorFs;
    freeBytes?(dir: string): Promise<number | null>;
    log?: LogFn;
}

export interface EvictResult {
    evicted: number;
    freedBytes: number;
    requeued: number;
    stopped?: 'enough_space' | 'busy' | 'aborted' | 'disabled' | 'no_context';
}

type EvictOutcome = 'evicted' | 'kept' | 'requeued';

const PAGE = 100;
const SPACE_CHECK_EVERY = 25;

export class MediaEvictor {
    private chain: Promise<unknown> = Promise.resolve();
    private readonly fs: EvictorFs;
    private readonly log: LogFn;

    constructor(private readonly deps: EvictorDeps) {
        this.fs = deps.fs || (fs.promises as unknown as EvictorFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    /** Các lượt dọn chạy lần lượt (dọn theo dung lượng và dọn theo tài khoản không chồng nhau). */
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.chain.then(fn, fn);
        this.chain = next.catch(() => undefined);
        return next;
    }

    runSpaceEviction(isCurrent: () => boolean): Promise<EvictResult> {
        return this.serial(() => this.spaceEviction(isCurrent));
    }

    evictAccountOlderThan(accountDir: string, olderThanDays: number, isCurrent: () => boolean): Promise<EvictResult> {
        return this.serial(() => this.accountEviction(accountDir, olderThanDays, isCurrent));
    }

    /** Chạy fn khi không có lượt dọn nào khác (công cụ dọn R2 không chồng với dọn file trên máy). */
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        return this.serial(fn);
    }

    /** "Giải phóng ổ đĩa" đang bật (mặc định tắt = không bao giờ xoá file trên máy). */
    private evictAllowed(): boolean {
        try {
            return this.deps.options().evictEnabled === true;
        } catch {
            return false;
        }
    }

    // ─── Một file ──────────────────────────────────────────────────────

    private async statOrNull(p: string): Promise<fs.Stats | null> {
        try { return await this.fs.stat(p); } catch { return null; }
    }

    private async evictOne(ctx: MediaContext, rel: string, alive: () => boolean): Promise<EvictOutcome> {
        const row = ctx.index.getRow(rel);
        if (!row || row.state !== 'uploaded') return 'kept';
        const size = Number(row.size);
        const mtime = Number(row.mtime_ms);
        const abs = absPathFor(ctx.realRoot, rel);
        const st = await this.statOrNull(abs);
        if (st && (!st.isFile() || st.size !== size || Math.floor(st.mtimeMs) !== mtime)) {
            // File trên máy đã khác bản đã tải lên → tải lên lại, không xoá
            if (alive()) ctx.index.requeueUploaded(rel, st.isFile() ? { size: st.size, mtimeMs: Math.floor(st.mtimeMs) } : {});
            return 'requeued';
        }
        const head = await this.deps.r2(ctx.bucket).headObject(objectKeyFor(ctx.workspaceUid, rel));
        const etagMismatch = !!(head && row.etag && head.etag && normEtag(head.etag) !== normEtag(row.etag));
        if (!head || Number(head.size) !== size || etagMismatch) {
            // R2 không có / không khớp → tải lên lại, giữ file trên máy
            if (alive()) ctx.index.requeueUploaded(rel);
            this.log('warn', `[CloudMedia] Bản trên R2 không khớp, giữ file và tải lên lại: ${rel}`);
            return 'requeued';
        }
        if (!alive()) return 'kept';
        // Đọc lại ngay trước khi xoá (bộ tải lên / quét có thể vừa đổi dòng này)
        const again = ctx.index.getRow(rel);
        if (!again || again.state !== 'uploaded' || Number(again.size) !== size || Number(again.mtime_ms) !== mtime) return 'kept';
        if (st) {
            const st2 = await this.statOrNull(abs);
            if (st2) {
                if (!st2.isFile() || st2.size !== size || Math.floor(st2.mtimeMs) !== mtime) return 'kept';
                // Chốt cuối: người dùng vừa tắt "giải phóng ổ đĩa" / đổi workspace → không xoá
                if (!alive() || !this.evictAllowed()) return 'kept';
                await this.fs.unlink(abs);
            }
        }
        if (alive()) ctx.index.markEvicted(rel);
        return 'evicted';
    }

    private async evictMany(ctx: MediaContext, rels: string[], alive: () => boolean, result: EvictResult,
        sizes: Map<string, number>, afterEach?: () => Promise<boolean>): Promise<boolean> {
        for (const rel of rels) {
            if (!alive()) { result.stopped = 'aborted'; return false; }
            if (!this.evictAllowed()) { result.stopped = 'disabled'; return false; }
            if (this.deps.isBackingOff()) { result.stopped = 'busy'; return false; }
            let outcome: EvictOutcome;
            try {
                outcome = await this.evictOne(ctx, rel, alive);
            } catch (err) {
                const kind = classifyR2Error(err);
                if (kind === 'busy' || kind === 'network') {
                    this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
                    result.stopped = 'busy';
                    return false;
                }
                this.log('warn', `[CloudMedia] Dọn file lỗi (${rel}): ${errorText(err)}`);
                // Token / quyền / bucket hỏng: các file sau cũng lỗi y hệt → dừng lượt dọn (không xoá gì)
                if (kind === 'auth' || kind === 'bucket') { result.stopped = 'aborted'; return false; }
                continue;
            }
            if (outcome === 'evicted') { result.evicted++; result.freedBytes += sizes.get(rel) || 0; }
            else if (outcome === 'requeued') result.requeued++;
            if (afterEach && !(await afterEach())) return false;
        }
        return true;
    }

    // ─── Theo dung lượng ───────────────────────────────────────────────

    private async spaceEviction(isCurrent: () => boolean): Promise<EvictResult> {
        const result: EvictResult = { evicted: 0, freedBytes: 0, requeued: 0 };
        const opts = this.deps.options();
        if (!opts.evictEnabled) { result.stopped = 'disabled'; return result; }
        const ctx = await this.deps.ctx.get();
        if (!ctx) { result.stopped = 'no_context'; return result; }
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        const freeBytes = this.deps.freeBytes || freeDiskBytes;
        const minFree = Math.max(0, opts.evictMinFreeGb) * GIB;
        let free = await freeBytes(ctx.realRoot);
        if (free !== null && free >= minFree) { result.stopped = 'enough_space'; return result; }

        const now = this.now();
        const cutoff = now - Math.max(1, opts.evictKeepDays) * DAY;
        let after: { mtime: number; rel: string } | undefined;
        let sinceCheck = 0;
        const afterEach = async (): Promise<boolean> => {
            if (++sinceCheck < SPACE_CHECK_EVERY) return true;
            sinceCheck = 0;
            free = await freeBytes(ctx.realRoot);
            if (free !== null && free >= minFree) { result.stopped = 'enough_space'; return false; }
            return true;
        };
        for (;;) {
            if (!alive()) { result.stopped = 'aborted'; break; }
            const rows = ctx.index.evictCandidates({ mtimeBefore: cutoff, accessBefore: cutoff, limit: PAGE, after });
            if (!rows.length) break;
            const last = rows[rows.length - 1];
            after = { mtime: Number(last.mtime_ms), rel: last.rel_path };
            const sizes = new Map(rows.map((r) => [r.rel_path, Number(r.size)] as [string, number]));
            if (!(await this.evictMany(ctx, rows.map((r) => r.rel_path), alive, result, sizes, afterEach))) break;
            await yieldToLoop();
        }
        if (result.evicted) {
            this.log('log', `[CloudMedia] Đã dọn ${result.evicted} file (${(result.freedBytes / GIB).toFixed(2)} GB) đã có trên R2`);
        }
        return result;
    }

    // ─── Theo tài khoản (thay cleanupOldMedia khi đồng bộ bật) ─────────

    private async accountEviction(accountDir: string, olderThanDays: number, isCurrent: () => boolean): Promise<EvictResult> {
        const result: EvictResult = { evicted: 0, freedBytes: 0, requeued: 0 };
        const name = String(accountDir || '');
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || !(olderThanDays > 0)) return result;
        // Giữ file trên máy (mặc định): không bao giờ xoá — "tự xoá media cũ" khi đó chạy như trước ở FileStorageService
        if (!this.evictAllowed()) { result.stopped = 'disabled'; return result; }
        const ctx = await this.deps.ctx.get();
        if (!ctx) { result.stopped = 'no_context'; return result; }
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        let filter: MediaScopeFilter | null = null;
        try { filter = this.deps.scope ? this.deps.scope(ctx) : null; } catch { filter = null; }

        // Tên thư mục đúng hoa/thường trên đĩa (rel trong chỉ mục giữ đúng tên)
        let accountRel: string | null = null;
        try { accountRel = relPathInRoot(ctx.realRoot, await this.fs.realpath(path.join(ctx.realRoot, name))); } catch { accountRel = null; }
        if (!accountRel || accountRel.includes('/')) return result;

        const now = this.now();
        const cutoff = now - olderThanDays * DAY;
        let entries: fs.Dirent[];
        try { entries = await this.fs.readdir(absPathFor(ctx.realRoot, accountRel), { withFileTypes: true }); } catch { return result; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            // Cùng quy tắc với cleanupOldMedia cũ: chỉ thư mục ngày YYYY-MM-DD cũ hơn N ngày
            const dirDate = new Date(`${entry.name}T00:00:00`);
            if (isNaN(dirDate.getTime()) || dirDate.getTime() >= cutoff) continue;
            const files = await this.listFiles(ctx, `${accountRel}/${entry.name}`, alive);
            for (let i = 0; i < files.length; i += 200) {
                if (!alive()) { result.stopped = 'aborted'; return result; }
                const chunk = files.slice(i, i + 200);
                const rows = ctx.index.getRows(chunk.map((f) => f.rel));
                // File chưa có trong chỉ mục: KHÔNG xoá — đưa vào hàng đợi tải lên (chỉ file trong phạm vi lưu)
                const unknown = chunk.filter((f) => !rows.has(f.rel) && relInScope(f.rel, f.mtimeMs, filter));
                if (unknown.length && alive()) {
                    const r = ctx.index.upsertScanned(unknown);
                    if (r.inserted + r.requeued > 0) this.deps.onIndexed?.(r.inserted + r.requeued);
                }
                const candidates = chunk.filter((f) => {
                    const row = rows.get(f.rel);
                    return !!row && row.state === 'uploaded' && (row.last_access_at == null || Number(row.last_access_at) < cutoff);
                });
                const sizes = new Map(candidates.map((f) => [f.rel, f.size] as [string, number]));
                if (!(await this.evictMany(ctx, candidates.map((f) => f.rel), alive, result, sizes))) return result;
                await yieldToLoop();
            }
        }
        if (result.evicted) {
            this.log('log', `[CloudMedia] Tự dọn media cũ (${name}): ${result.evicted} file đã có trên R2, ${(result.freedBytes / GIB).toFixed(2)} GB`);
        }
        return result;
    }

    /** Mọi file (đệ quy, không theo symlink) dưới thư mục rel. */
    private async listFiles(ctx: MediaContext, dirRel: string, alive: () => boolean): Promise<ScannedFile[]> {
        const out: ScannedFile[] = [];
        const stack = [dirRel];
        while (stack.length) {
            if (!alive()) return out;
            const rel = stack.pop() as string;
            let entries: fs.Dirent[];
            try { entries = await this.fs.readdir(absPathFor(ctx.realRoot, rel), { withFileTypes: true }); } catch { continue; }
            const names: string[] = [];
            for (const e of entries) {
                if (e.isDirectory()) { if (!isSkippedDirName(e.name)) stack.push(`${rel}/${e.name}`); }
                else if (e.isFile() && !isSkippedFileName(e.name)) names.push(e.name);
            }
            const stats = await Promise.all(names.map((n) => this.statOrNull(absPathFor(ctx.realRoot, `${rel}/${n}`))));
            names.forEach((n, k) => {
                const st = stats[k];
                if (st && st.isFile() && st.size > 0) out.push({ rel: `${rel}/${n}`, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
            });
            await yieldToLoop();
        }
        return out;
    }
}
