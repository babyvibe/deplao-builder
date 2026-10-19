/**
 * MediaScanner — đưa file media trên đĩa vào chỉ mục cloud_media (không tải gì lên).
 *
 *  1. Quét toàn bộ (lần đầu và mỗi 7 ngày), tiếp tục được sau khi tắt app (app_settings.cloud_media_scan_cursor):
 *       a. lần đầu: ưu tiên media Zalo đã hết hạn trên CDN (messages.media_expired = 1 → local_paths), đi theo khoảng id;
 *       b. duyệt thư mục media sâu trước, thư mục con theo tên giảm dần (ngày mới nhất trước), nhường vòng lặp giữa
 *          các thư mục, ghi chỉ mục theo lô ≤ 500.
 *  2. noteFileWritten: gom đường dẫn vừa ghi, ghi chỉ mục sau vài giây.
 *  3. Quét nhẹ định kỳ (10 phút): chỉ đọc lại thư mục có mtime đổi (bắt file do đường ghi không gọi hook — Telegram,
 *     thư viện, avatar, file nhân viên tải lên…).
 *
 * Bỏ qua file tạm / đang ghi dở, file rỗng, cache sticker, thư mục ẩn, symlink/junction (không thoát khỏi thư mục media).
 *
 * Phạm vi lưu (tài khoản / từ ngày / file dùng chung — MediaSyncOptions.scope + includeShared): mọi đường đưa file vào
 * chỉ mục chỉ nhận file trong phạm vi; nhánh thư mục chắc chắn ngoài phạm vi bị bỏ qua cả nhánh (không đọc, không stat).
 * Đổi phạm vi (khác app_settings.cloud_media_scope) → rà lại chỉ mục (pending ngoài phạm vi → excluded, excluded nay
 * trong phạm vi → pending) rồi quét lại từ đầu. File đã lên R2 giữ nguyên (vẫn tải về được).
 */
import * as fs from 'fs';
import * as path from 'path';
import { PRIORITY_EXPIRED, SETTING_MEDIA_SCOPE, SETTING_SCAN_CURSOR, ScannedFile } from './CloudMediaIndex';
import {
    absPathFor, childOrder, dirMayHaveInScope, isAncestorOf, isSkippedDirName, isSkippedFileName, isSkippedRelPath,
    MediaScopeFilter, preOrderCompare, relInScope, relPathInRoot, resolveStoredLocalPath, scopeSignature,
} from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { DAY, errorText, HOUR, LogFn, MINUTE, noLog, SECOND, unrefTimer, Waiter, yieldToLoop } from './util';

export interface ScanCursor {
    v: 1;
    phase: 'expired' | 'walk' | 'done';
    /** phase 'expired': đã xử lý tới messages.id này. */
    afterId?: number;
    /** phase 'walk': thư mục (rel) cuối cùng đã xử lý xong file của nó. */
    dir?: string | null;
    /** Lượt quét hiện tại bắt đầu lúc. */
    startedAt?: number;
    /** Lượt quét toàn bộ gần nhất đã xong (tính theo lúc bắt đầu lượt đó). */
    doneAt?: number;
}

export interface ScannerFs {
    readdir(p: string, opts: { withFileTypes: true }): Promise<fs.Dirent[]>;
    stat(p: string): Promise<fs.Stats>;
    realpath(p: string): Promise<string>;
}

export interface ScannerDeps {
    ctx: ContextSource;
    waiter: Waiter;
    /** Đồng bộ media đang chạy (đã bật, chưa dừng). */
    isActive(): boolean;
    isPaused(): boolean;
    /** Có dòng chờ tải mới → đánh thức hàng đợi tải lên. */
    onIndexed(count: number): void;
    /** Phạm vi lưu đang áp; null / không có = mọi file. Gọi lại mỗi lượt / mỗi thư mục → đổi phạm vi có hiệu lực ngay. */
    scope?(ctx: MediaContext): MediaScopeFilter | null;
    fs?: ScannerFs;
    now?(): number;
    log?: LogFn;
}

export const RECENT_SCAN_INTERVAL_MS = 10 * MINUTE;
export const RECENT_WINDOW_MS = 3 * DAY;
export const FULL_RESCAN_AFTER_MS = 7 * DAY;
export const NOTE_FLUSH_DELAY_MS = 3 * SECOND;
const NOTE_BUFFER_MAX = 20_000;
const CURSOR_SAVE_EVERY_MS = 30 * SECOND;
const EXPIRED_ID_STEP = 2000;
const STAT_CHUNK = 500;
/** Rà lại chỉ mục khi đổi phạm vi: mỗi truy vấn đọc ≤ 500 dòng theo khoá chính, nhường vòng lặp giữa các trang. */
const RECONCILE_PAGE = 500;

export class MediaScanner {
    private readonly fs: ScannerFs;
    private readonly log: LogFn;
    private notes = new Set<string>();
    private noteTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing = false;
    /** rel thư mục → mtime lần đọc trước + thư mục con (quét nhẹ chỉ đọc lại thư mục đã đổi). */
    private dirCache = new Map<string, { mtimeMs: number; subdirs: string[] }>();
    private dirCacheCtx = 0;
    private lastRecentAt = 0;
    /** Tăng mỗi lần người dùng đổi phạm vi: lượt quét đang chạy dừng lại, vòng lặp áp phạm vi mới rồi quét lại từ đầu. */
    private scopeGen = 0;

    constructor(private readonly deps: ScannerDeps) {
        this.fs = deps.fs || (fs.promises as unknown as ScannerFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    /** Dừng / đổi workspace: bỏ bộ đệm và bộ nhớ thư mục. */
    reset(): void {
        this.notes.clear();
        if (this.noteTimer) clearTimeout(this.noteTimer);
        this.noteTimer = null;
        this.dirCache.clear();
        this.dirCacheCtx = 0;
        this.lastRecentAt = 0;
    }

    /** Người dùng đổi phạm vi lưu: dừng lượt quét đang chạy; vòng lặp rà lại chỉ mục và quét lại từ đầu. */
    scopeChanged(): void {
        this.scopeGen++;
        this.dirCache.clear();
        this.lastRecentAt = 0;
    }

    // ─── Phạm vi lưu ───────────────────────────────────────────────────

    private filterFor(ctx: MediaContext): MediaScopeFilter | null {
        try {
            return this.deps.scope ? this.deps.scope(ctx) : null;
        } catch {
            return null;
        }
    }

    /** Chỉ giữ file trong phạm vi lưu. */
    private keepInScope(ctx: MediaContext, files: ScannedFile[]): ScannedFile[] {
        const filter = this.filterFor(ctx);
        return filter ? files.filter((f) => relInScope(f.rel, f.mtimeMs, filter)) : files;
    }

    /** false = cả nhánh thư mục ngoài phạm vi (không đọc, không stat). */
    private dirAllowed(ctx: MediaContext, segs: string[]): boolean {
        return !segs.length || dirMayHaveInScope(segs, this.filterFor(ctx));
    }

    /**
     * Phạm vi hiện tại khác phạm vi chỉ mục đang theo (app_settings) → đặt lại con trỏ quét về đầu, rà chỉ mục theo
     * trang (pending ngoài phạm vi → excluded; excluded nay trong phạm vi → pending), xong mới ghi phạm vi mới.
     * Dừng giữa chừng (tắt, đổi workspace, đổi phạm vi lần nữa) → false, lượt sau làm lại (mọi bước đều làm lại được).
     * Chưa từng ghi phạm vi = chỉ mục theo "tất cả" (bản trước khi có phạm vi).
     */
    async applyScope(ctx: MediaContext, isCurrent: () => boolean): Promise<boolean> {
        const filter = this.filterFor(ctx);
        const signature = scopeSignature(filter);
        const stored = ctx.index.getSetting(SETTING_MEDIA_SCOPE) || scopeSignature(null);
        if (stored === signature) return true;
        if (!this.alive(ctx, isCurrent)) return false;
        this.log('log', '[CloudMedia] Đổi phạm vi lưu media — rà lại chỉ mục và quét lại từ đầu');
        this.dirCache.clear();
        this.saveCursor(ctx, { v: 1, phase: 'expired', afterId: 0 });
        let after = '';
        let excluded = 0;
        let included = 0;
        for (;;) {
            if (!this.alive(ctx, isCurrent)) return false;
            const rows = ctx.index.pageByRel(after, RECONCILE_PAGE);
            if (!rows.length) break;
            after = rows[rows.length - 1].rel_path;
            const out: string[] = [];
            const back: string[] = [];
            for (const r of rows) {
                if (r.state !== 'pending' && r.state !== 'excluded') continue;
                const inScope = relInScope(r.rel_path, Number(r.mtime_ms) || 0, filter);
                if (r.state === 'pending' && !inScope) out.push(r.rel_path);
                else if (r.state === 'excluded' && inScope) back.push(r.rel_path);
            }
            if (out.length) excluded += ctx.index.markExcluded(out);
            if (back.length) included += ctx.index.includeExcluded(back);
            await yieldToLoop();
        }
        if (!this.alive(ctx, isCurrent)) return false;
        ctx.index.setSetting(SETTING_MEDIA_SCOPE, signature);
        if (included > 0) this.deps.onIndexed(included);
        this.log('log', `[CloudMedia] Phạm vi lưu mới: ${excluded} file chờ tải nay ngoài phạm vi, ${included} file được đưa lại vào hàng đợi`);
        return true;
    }

    // ─── noteFileWritten ───────────────────────────────────────────────

    note(absPath: string): void {
        if (!absPath || typeof absPath !== 'string') return;
        // Tràn bộ đệm: bỏ qua — lượt quét nhẹ định kỳ sẽ bắt các file này
        if (this.notes.size >= NOTE_BUFFER_MAX) return;
        this.notes.add(absPath);
        this.scheduleFlush(NOTE_FLUSH_DELAY_MS);
    }

    private scheduleFlush(delay: number): void {
        if (this.noteTimer) return;
        this.noteTimer = setTimeout(() => {
            this.noteTimer = null;
            void this.flushNotes();
        }, delay);
        unrefTimer(this.noteTimer);
    }

    async flushNotes(): Promise<void> {
        if (!this.deps.isActive()) { this.notes.clear(); return; }
        if (!this.notes.size) return;
        if (this.flushing) { this.scheduleFlush(NOTE_FLUSH_DELAY_MS); return; }
        this.flushing = true;
        try {
            const ctx = await this.deps.ctx.get();
            if (!this.deps.isActive()) { this.notes.clear(); return; }
            if (!ctx) { this.scheduleFlush(15 * SECOND); return; }
            const paths = Array.from(this.notes);
            this.notes.clear();
            let files: ScannedFile[] = [];
            for (let i = 0; i < paths.length; i += 100) {
                const found = await Promise.all(paths.slice(i, i + 100).map((p) => this.describe(ctx, p)));
                for (const f of found) if (f) files.push(f);
            }
            files = this.keepInScope(ctx, files);
            if (files.length && this.deps.isActive() && this.deps.ctx.isValid(ctx)) {
                const r = ctx.index.upsertScanned(files);
                if (r.inserted + r.requeued > 0) this.deps.onIndexed(r.inserted + r.requeued);
            }
        } catch (err) {
            this.log('warn', `[CloudMedia] Ghi chỉ mục file mới lỗi: ${errorText(err)}`);
        } finally {
            this.flushing = false;
        }
    }

    /** Đường dẫn bất kỳ → rel đúng hoa/thường trên đĩa (realpath) + kích thước; null nếu không phải file media hợp lệ. */
    private async describe(ctx: MediaContext, p: string): Promise<ScannedFile | null> {
        let abs = p;
        if (!path.isAbsolute(abs)) {
            const resolved = resolveStoredLocalPath(abs, ctx.mediaRoot);
            if (!resolved) return null;
            abs = resolved;
        }
        try {
            const real = await this.fs.realpath(abs);
            const rel = relPathInRoot(ctx.realRoot, real);
            if (!rel || isSkippedRelPath(rel)) return null;
            const st = await this.fs.stat(real);
            if (!st.isFile() || st.size <= 0) return null;
            return { rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
        } catch {
            return null;
        }
    }

    // ─── Vòng lặp ──────────────────────────────────────────────────────

    async run(isCurrent: () => boolean): Promise<void> {
        while (isCurrent()) {
            try {
                if (this.deps.isPaused()) { await this.deps.waiter.wait(MINUTE); continue; }
                const ctx = await this.deps.ctx.get();
                if (!isCurrent()) break;
                if (!ctx) { await this.deps.waiter.wait(15 * SECOND); continue; }
                // Đổi phạm vi giữa chừng → lượt đang chạy dừng, vòng sau áp phạm vi mới ngay (không chờ)
                const gen = this.scopeGen;
                const current = () => isCurrent() && this.scopeGen === gen;
                if (!(await this.applyScope(ctx, current))) {
                    if (this.scopeGen === gen) await this.deps.waiter.wait(5 * SECOND);
                    continue;
                }
                const cursor = this.readCursor(ctx);
                const needFull = cursor.phase !== 'done' || !cursor.doneAt || this.now() - cursor.doneAt >= FULL_RESCAN_AFTER_MS;
                if (needFull && !(await this.fullScan(ctx, cursor, current))) {
                    if (this.scopeGen === gen) await this.deps.waiter.wait(5 * SECOND);
                    continue;
                }
                if (this.now() - this.lastRecentAt >= RECENT_SCAN_INTERVAL_MS) await this.recentScan(ctx, current);
                if (this.scopeGen !== gen) continue;
                await this.deps.waiter.wait(Math.max(5 * SECOND, RECENT_SCAN_INTERVAL_MS - (this.now() - this.lastRecentAt)));
            } catch (err) {
                this.log('warn', `[CloudMedia] Quét media lỗi: ${errorText(err)}`);
                this.deps.ctx.invalidate();
                await this.deps.waiter.wait(MINUTE);
            }
        }
    }

    private alive(ctx: MediaContext, isCurrent: () => boolean): boolean {
        return isCurrent() && this.deps.ctx.isValid(ctx);
    }

    readCursor(ctx: MediaContext): ScanCursor {
        try {
            const raw = ctx.index.getSetting(SETTING_SCAN_CURSOR);
            if (raw) {
                const c = JSON.parse(raw);
                if (c && c.v === 1 && (c.phase === 'expired' || c.phase === 'walk' || c.phase === 'done')) return c as ScanCursor;
            }
        } catch { /* hỏng → quét lại từ đầu */ }
        return { v: 1, phase: 'expired', afterId: 0 };
    }

    private saveCursor(ctx: MediaContext, cursor: ScanCursor): void {
        if (!this.deps.isActive() || !this.deps.ctx.isValid(ctx)) return;
        try { ctx.index.setSetting(SETTING_SCAN_CURSOR, JSON.stringify(cursor)); } catch { /* lần sau */ }
    }

    // ─── Quét toàn bộ ──────────────────────────────────────────────────

    /** true = xong; false = dừng giữa chừng (tạm dừng, tắt, đổi workspace) — lần sau đi tiếp từ con trỏ. */
    async fullScan(ctx: MediaContext, start: ScanCursor, isCurrent: () => boolean): Promise<boolean> {
        let cursor: ScanCursor = start.phase === 'done'
            ? { v: 1, phase: 'walk', dir: null, startedAt: this.now(), doneAt: start.doneAt }
            : { ...start, startedAt: start.startedAt || this.now() };
        if (cursor.phase === 'expired') {
            if (!(await this.expiredPass(ctx, cursor, isCurrent))) return false;
            cursor = { v: 1, phase: 'walk', dir: null, startedAt: cursor.startedAt, doneAt: cursor.doneAt };
            this.saveCursor(ctx, cursor);
        }
        if (!(await this.walk(ctx, cursor, isCurrent))) return false;
        this.saveCursor(ctx, { v: 1, phase: 'done', doneAt: cursor.startedAt });
        this.log('log', '[CloudMedia] Đã quét xong thư mục media');
        return true;
    }

    private async expiredPass(ctx: MediaContext, cursor: ScanCursor, isCurrent: () => boolean): Promise<boolean> {
        let maxId = 0;
        try { maxId = ctx.index.maxMessageId(); } catch { return true; }
        let from = Math.max(0, Number(cursor.afterId) || 0);
        let lastSave = this.now();
        while (from < maxId) {
            if (!this.alive(ctx, isCurrent) || this.deps.isPaused()) {
                this.saveCursor(ctx, { ...cursor, phase: 'expired', afterId: from });
                return false;
            }
            const to = Math.min(maxId, from + EXPIRED_ID_STEP);
            let values: string[] = [];
            try { values = ctx.index.expiredLocalPaths(from, to); } catch { values = []; }
            if (values.length) {
                const abs = new Set<string>();
                for (const v of values) {
                    const p = resolveStoredLocalPath(v, ctx.mediaRoot);
                    if (p) abs.add(p);
                }
                const found = await Promise.all(Array.from(abs).map((p) => this.describe(ctx, p)));
                const files = this.keepInScope(ctx, found.filter((f): f is ScannedFile => !!f))
                    .map((f) => ({ ...f, priority: PRIORITY_EXPIRED }));
                if (!this.alive(ctx, isCurrent)) continue;
                if (files.length) {
                    const r = ctx.index.upsertScanned(files);
                    if (r.inserted + r.requeued > 0) this.deps.onIndexed(r.inserted + r.requeued);
                }
            }
            from = to;
            if (this.now() - lastSave >= CURSOR_SAVE_EVERY_MS) {
                this.saveCursor(ctx, { ...cursor, phase: 'expired', afterId: from });
                lastSave = this.now();
            }
            await yieldToLoop();
        }
        return true;
    }

    private async walk(ctx: MediaContext, cursor: ScanCursor, isCurrent: () => boolean): Promise<boolean> {
        const after = cursor.dir ? cursor.dir.split('/') : null;
        const stack: string[][] = [[]];
        let lastSave = this.now();
        let lastDone: string[] | null = null;
        const save = () => {
            if (lastDone) this.saveCursor(ctx, { ...cursor, phase: 'walk', dir: lastDone.join('/') });
            lastSave = this.now();
        };
        while (stack.length) {
            if (!this.alive(ctx, isCurrent) || this.deps.isPaused()) { save(); return false; }
            if (this.now() - this.lastRecentAt >= RECENT_SCAN_INTERVAL_MS) {
                await this.recentScan(ctx, isCurrent);
                if (!this.alive(ctx, isCurrent)) { save(); return false; }
            }
            const segs = stack.pop() as string[];
            // Nhánh ngoài phạm vi lưu (tài khoản không chọn, thư mục ngày trước "từ ngày", file chung đã tắt): bỏ cả nhánh
            if (!this.dirAllowed(ctx, segs)) continue;
            let processFiles = true;
            if (after) {
                const cmp = preOrderCompare(segs, after);
                // Cả nhánh nằm trước con trỏ → đã xong
                if (cmp < 0 && !isAncestorOf(segs, after)) continue;
                // Tổ tiên của con trỏ / chính con trỏ: file đã xong, chỉ đi tiếp vào thư mục con
                if (cmp <= 0) processFiles = false;
            }
            const listing = await this.list(ctx, segs);
            if (!listing) continue;
            if (processFiles && listing.files.length) {
                if (!(await this.indexNames(ctx, segs, listing.files, isCurrent, false))) { save(); return false; }
            }
            for (let i = listing.subdirs.length - 1; i >= 0; i--) stack.push(segs.concat(listing.subdirs[i]));
            if (processFiles) lastDone = segs;
            if (this.now() - lastSave >= CURSOR_SAVE_EVERY_MS) save();
            await yieldToLoop();
        }
        return true;
    }

    private async list(ctx: MediaContext, segs: string[]): Promise<{ files: string[]; subdirs: string[] } | null> {
        let entries: fs.Dirent[];
        try {
            entries = await this.fs.readdir(segs.length ? absPathFor(ctx.realRoot, segs.join('/')) : ctx.realRoot, { withFileTypes: true });
        } catch {
            return null;
        }
        const files: string[] = [];
        const subdirs: string[] = [];
        for (const e of entries) {
            // Symlink / junction: không đi theo (không thoát khỏi thư mục media, không lặp vô hạn)
            if (e.isDirectory()) { if (!isSkippedDirName(e.name)) subdirs.push(e.name); }
            else if (e.isFile() && !isSkippedFileName(e.name)) files.push(e.name);
        }
        subdirs.sort(childOrder);
        return { files, subdirs };
    }

    /** stat theo lô 500 rồi ghi chỉ mục; onlyUnknown: chỉ file chưa có trong chỉ mục (quét nhẹ). */
    private async indexNames(ctx: MediaContext, segs: string[], names: string[], isCurrent: () => boolean, onlyUnknown: boolean): Promise<boolean> {
        const base = segs.length ? absPathFor(ctx.realRoot, segs.join('/')) : ctx.realRoot;
        const prefix = segs.length ? `${segs.join('/')}/` : '';
        for (let i = 0; i < names.length; i += STAT_CHUNK) {
            if (!this.alive(ctx, isCurrent)) return false;
            let chunk = names.slice(i, i + STAT_CHUNK);
            if (onlyUnknown) {
                const unknown = new Set(ctx.index.filterUnknown(chunk.map((n) => prefix + n)));
                chunk = chunk.filter((n) => unknown.has(prefix + n));
                if (!chunk.length) { await yieldToLoop(); continue; }
            }
            const stats = await Promise.all(chunk.map((n) => this.fs.stat(path.join(base, n)).catch(() => null)));
            let files: ScannedFile[] = [];
            chunk.forEach((n, k) => {
                const st = stats[k];
                if (st && st.isFile() && st.size > 0) files.push({ rel: prefix + n, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
            });
            if (!this.alive(ctx, isCurrent)) return false;
            files = this.keepInScope(ctx, files);
            if (files.length) {
                const r = ctx.index.upsertScanned(files);
                if (r.inserted + r.requeued > 0) this.deps.onIndexed(r.inserted + r.requeued);
            }
            await yieldToLoop();
        }
        return true;
    }

    // ─── Quét nhẹ định kỳ ──────────────────────────────────────────────

    /**
     * stat mọi thư mục (rẻ), chỉ đọc lại thư mục có mtime đổi so với lần trước. Lần đầu trong phiên: chỉ thư mục đổi trong
     * 3 ngày qua hoặc sau lượt quét toàn bộ gần nhất (thư mục cũ hơn đã được lượt quét toàn bộ ghi nhận).
     */
    async recentScan(ctx: MediaContext, isCurrent: () => boolean): Promise<void> {
        if (this.dirCacheCtx !== ctx.id) { this.dirCache.clear(); this.dirCacheCtx = ctx.id; }
        const startedAt = this.now();
        const cursor = this.readCursor(ctx);
        const floor = Math.min(startedAt - RECENT_WINDOW_MS, cursor.doneAt ? cursor.doneAt - HOUR : Number.POSITIVE_INFINITY);
        const stack: string[][] = [[]];
        while (stack.length) {
            if (!this.alive(ctx, isCurrent) || this.deps.isPaused()) return;
            const segs = stack.pop() as string[];
            if (!this.dirAllowed(ctx, segs)) continue;
            const key = segs.join('/');
            let st: fs.Stats;
            try {
                st = await this.fs.stat(segs.length ? absPathFor(ctx.realRoot, key) : ctx.realRoot);
            } catch {
                this.dirCache.delete(key);
                continue;
            }
            const cached = this.dirCache.get(key);
            let subdirs: string[];
            if (cached && cached.mtimeMs === st.mtimeMs) {
                subdirs = cached.subdirs;
            } else {
                const listing = await this.list(ctx, segs);
                if (!listing) continue;
                subdirs = listing.subdirs;
                const readFiles = cached ? true : st.mtimeMs >= floor;
                if (readFiles && listing.files.length && !(await this.indexNames(ctx, segs, listing.files, isCurrent, true))) return;
                this.dirCache.set(key, { mtimeMs: st.mtimeMs, subdirs });
            }
            for (let i = subdirs.length - 1; i >= 0; i--) stack.push(segs.concat(subdirs[i]));
            await yieldToLoop();
        }
        this.lastRecentAt = startedAt;
    }
}
