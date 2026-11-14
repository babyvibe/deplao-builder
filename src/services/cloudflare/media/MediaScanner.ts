/**
 * MediaScanner: puts the media files on disk into the cloud_media index (uploads nothing).
 *
 *  1. Full scan (the first time and every 7 days), resumable after the app is closed (app_settings.cloud_media_scan_cursor):
 *       a. first time: Zalo media expired on the CDN first (messages.media_expired = 1 → local_paths), walked by id range;
 *       b. walks the media folder depth-first, subfolders by name in descending order (newest day first), yields to the event loop between
 *          folders, and writes the index in batches of ≤ 500.
 *  2. noteFileWritten: collects the paths just written and writes the index a few seconds later.
 *  3. Periodic light scan (every 10 minutes): only re-reads folders whose mtime changed (catches files written by paths that do not call the hook: Telegram,
 *     libraries, avatars, employee uploads…).
 *
 * The PERIODIC full scan (a previous run has already finished) only runs when the machine is idle (utils/startup/systemIdle.ts): not right after
 * the machine wakes / unlocks / the app opens, the user has not touched the machine for ≥ 10 minutes, and it is plugged in. If the user comes back midway,
 * it stops at the next folder (the next run continues from the cursor); after 72 hours it runs anyway. The first scan / a scan after a scope change
 * runs right away. The light scan waits 5 minutes after the app opens / the machine wakes.
 *
 * Skips temp / half-written files, empty files, the sticker cache, hidden folders, symlinks / junctions (never leaves the media folder).
 *
 * Storage scope (account / from date / shared files; MediaSyncOptions.scope + includeShared): every path that adds files to the
 * index only accepts files in scope; a folder branch that is certainly outside the scope is skipped as a whole (no read, no stat call).
 * A scope change (different from app_settings.cloud_media_scope) → re-check the index (pending outside scope → excluded, excluded now in scope → pending)
 * and then scan again from the start. Files already on R2 stay as they are (they can still be downloaded).
 */
import * as fs from 'fs';
import * as path from 'path';
import { PRIORITY_EXPIRED, SETTING_MEDIA_SCOPE, SETTING_SCAN_CURSOR, ScannedFile } from './CloudMediaIndex';
import {
    absPathFor, childOrder, dirMayHaveInScope, isAncestorOf, isSkippedDirName, isSkippedFileName, isSkippedRelPath,
    MediaScopeFilter, preOrderCompare, relInScope, relPathInRoot, resolveStoredLocalPath, scopeSignature,
} from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { IDLE_WAIT_LABEL, IdleWaitReason, SystemIdleInfo, idleWaitReason } from '../../../utils/startup/systemIdle';
import { DAY, errorText, HOUR, LogFn, MINUTE, noLog, SECOND, unrefTimer, Waiter, yieldToLoop } from './util';

export interface ScanCursor {
    v: 1;
    phase: 'expired' | 'walk' | 'done';
    /** phase 'expired': processed up to this messages.id. */
    afterId?: number;
    /** phase 'walk': the last folder (rel) whose files have all been processed. */
    dir?: string | null;
    /** The current scan run started at. */
    startedAt?: number;
    /** The latest completed full scan (counted from when that run started). */
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
    /** Media sync is running (turned on, not stopped). */
    isActive(): boolean;
    isPaused(): boolean;
    /** New rows waiting to upload → wakes the upload queue. */
    onIndexed(count: number): void;
    /** Storage scope in effect; null / missing = every file. Read again on every pass / every folder → a scope change takes effect immediately. */
    scope?(ctx: MediaContext): MediaScopeFilter | null;
    fs?: ScannerFs;
    now?(): number;
    log?: LogFn;
    /** Timestamps of app open / machine wake + machine state (utils/startup/systemIdle.ts). Missing (tests) = do not wait for the machine to be idle. */
    idle?(): { wakeAt: number; info: SystemIdleInfo | null };
}

export const RECENT_SCAN_INTERVAL_MS = 10 * MINUTE;
export const RECENT_WINDOW_MS = 3 * DAY;
export const FULL_RESCAN_AFTER_MS = 7 * DAY;
/** Periodic full scan while the machine is busy: waits up to 72 hours after it is due. */
export const FULL_RESCAN_MAX_WAIT_MS = 72 * HOUR;
/** The light scan waits this long after the app opens / the machine wakes / unlocks. */
export const RECENT_SCAN_WAKE_QUIET_MS = 5 * MINUTE;
export const NOTE_FLUSH_DELAY_MS = 3 * SECOND;
const NOTE_BUFFER_MAX = 20_000;
const CURSOR_SAVE_EVERY_MS = 30 * SECOND;
const EXPIRED_ID_STEP = 2000;
const STAT_CHUNK = 500;
/** Re-checks the index on a scope change: each query reads ≤ 500 rows by primary key, yielding to the event loop between pages. */
const RECONCILE_PAGE = 500;

export class MediaScanner {
    private readonly fs: ScannerFs;
    private readonly log: LogFn;
    private notes = new Set<string>();
    private noteTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing = false;
    /** folder rel → mtime at the previous read + subfolders (the light scan only re-reads folders that changed). */
    private dirCache = new Map<string, { mtimeMs: number; subdirs: string[] }>();
    private dirCacheCtx = 0;
    private lastRecentAt = 0;
    /** Incremented every time the user changes the scope: the scan run in progress stops, and the loop applies the new scope and scans again from the start. */
    private scopeGen = 0;
    /** The reason a periodic full scan is waiting for an idle machine has been logged (not logged repeatedly). */
    private fullWaitLogged: IdleWaitReason | null = null;

    constructor(private readonly deps: ScannerDeps) {
        this.fs = deps.fs || (fs.promises as unknown as ScannerFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    /** Stop / change workspace: drop the buffers and the folder memory. */
    reset(): void {
        this.notes.clear();
        if (this.noteTimer) clearTimeout(this.noteTimer);
        this.noteTimer = null;
        this.dirCache.clear();
        this.dirCacheCtx = 0;
        this.lastRecentAt = 0;
    }

    /** The user changes the storage scope: stop the scan run in progress; the loop re-checks the index and scans again from the start. */
    scopeChanged(): void {
        this.scopeGen++;
        this.dirCache.clear();
        this.lastRecentAt = 0;
    }

    // ─── Storage scope ───────────────────────────────────────────────────

    private filterFor(ctx: MediaContext): MediaScopeFilter | null {
        try {
            return this.deps.scope ? this.deps.scope(ctx) : null;
        } catch {
            return null;
        }
    }

    /** Keep only files in the storage scope. */
    private keepInScope(ctx: MediaContext, files: ScannedFile[]): ScannedFile[] {
        const filter = this.filterFor(ctx);
        return filter ? files.filter((f) => relInScope(f.rel, f.mtimeMs, filter)) : files;
    }

    /** false = the whole folder branch is outside the scope (no read, no stat call). */
    private dirAllowed(ctx: MediaContext, segs: string[]): boolean {
        return !segs.length || dirMayHaveInScope(segs, this.filterFor(ctx));
    }

    /**
     * The current scope differs from the scope the index follows (app_settings) → reset the scan cursor to the start, re-check the index
     * page by page (pending outside scope → excluded; excluded now in scope → pending), and only then write the new scope.
     * Stopped midway (turned off, workspace changed, scope changed again) → false, the next run starts over (every step can be redone).
     * Scope never written = the index follows "tất cả" (all), as in the version before scopes existed.
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
        // Buffer overflow: skip it; the periodic light scan will catch these files
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

    /** Any path → rel with the correct case on disk (realpath) + size; null if it is not a valid media file. */
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

    // ─── Loop ──────────────────────────────────────────────────────────

    async run(isCurrent: () => boolean): Promise<void> {
        while (isCurrent()) {
            try {
                if (this.deps.isPaused()) { await this.deps.waiter.wait(MINUTE); continue; }
                const ctx = await this.deps.ctx.get();
                if (!isCurrent()) break;
                if (!ctx) { await this.deps.waiter.wait(15 * SECOND); continue; }
                // Scope changed midway → the run in progress stops; the next pass applies the new scope at once (no waiting)
                const gen = this.scopeGen;
                const current = () => isCurrent() && this.scopeGen === gen;
                if (!(await this.applyScope(ctx, current))) {
                    if (this.scopeGen === gen) await this.deps.waiter.wait(5 * SECOND);
                    continue;
                }
                const cursor = this.readCursor(ctx);
                const needFull = cursor.phase !== 'done' || !cursor.doneAt || this.now() - cursor.doneAt >= FULL_RESCAN_AFTER_MS;
                const fullWait = needFull ? this.fullScanWait(cursor) : null;
                if (needFull && !fullWait && !(await this.fullScan(ctx, cursor, current))) {
                    if (this.scopeGen === gen) await this.deps.waiter.wait(5 * SECOND);
                    continue;
                }
                const recentQuietUntil = this.recentScanQuietUntil();
                if (this.now() - this.lastRecentAt >= RECENT_SCAN_INTERVAL_MS && this.now() >= recentQuietUntil) {
                    await this.recentScan(ctx, current);
                }
                if (this.scopeGen !== gen) continue;
                const nextRecentAt = Math.max(this.lastRecentAt + RECENT_SCAN_INTERVAL_MS, recentQuietUntil);
                await this.deps.waiter.wait(Math.max(5 * SECOND, nextRecentAt - this.now()));
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

    /**
     * Whether a periodic full scan (a cursor with doneAt = a run has finished) must wait for an idle machine; the first run / a run after a scope change
     * (no doneAt) runs right away. Writes one log line each time the reason changes.
     */
    private fullScanWait(cursor: ScanCursor): IdleWaitReason | null {
        if (!this.deps.idle || !cursor.doneAt) return null;
        let wait: IdleWaitReason | null = null;
        try {
            const state = this.deps.idle();
            wait = idleWaitReason({
                now: this.now(),
                wakeAt: state.wakeAt,
                dueSince: cursor.doneAt + FULL_RESCAN_AFTER_MS,
                maxWaitMs: FULL_RESCAN_MAX_WAIT_MS,
                info: state.info,
            });
        } catch {
            wait = null;
        }
        if (wait && wait !== this.fullWaitLogged) this.log('log', `[CloudMedia] Quét toàn bộ định kỳ chờ máy rảnh (${IDLE_WAIT_LABEL[wait]})`);
        this.fullWaitLogged = wait;
        return wait;
    }

    /** The light scan does not run before this time (app open / machine wake + RECENT_SCAN_WAKE_QUIET_MS); 0 = do not wait. */
    private recentScanQuietUntil(): number {
        if (!this.deps.idle) return 0;
        try {
            const state = this.deps.idle();
            return state.info ? state.wakeAt + RECENT_SCAN_WAKE_QUIET_MS : 0;
        } catch {
            return 0;
        }
    }

    readCursor(ctx: MediaContext): ScanCursor {
        try {
            const raw = ctx.index.getSetting(SETTING_SCAN_CURSOR);
            if (raw) {
                const c = JSON.parse(raw);
                if (c && c.v === 1 && (c.phase === 'expired' || c.phase === 'walk' || c.phase === 'done')) return c as ScanCursor;
            }
        } catch { /* corrupt → scan again from the start */ }
        return { v: 1, phase: 'expired', afterId: 0 };
    }

    private saveCursor(ctx: MediaContext, cursor: ScanCursor): void {
        if (!this.deps.isActive() || !this.deps.ctx.isValid(ctx)) return;
        try { ctx.index.setSetting(SETTING_SCAN_CURSOR, JSON.stringify(cursor)); } catch { /* next time */ }
    }

    // ─── Full scan ──────────────────────────────────────────────────

    /** true = finished; false = stopped midway (paused, turned off, workspace changed): the next run continues from the cursor. */
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
            if (!this.alive(ctx, isCurrent) || this.deps.isPaused() || this.fullScanWait(cursor)) { save(); return false; }
            if (this.now() - this.lastRecentAt >= RECENT_SCAN_INTERVAL_MS) {
                await this.recentScan(ctx, isCurrent);
                if (!this.alive(ctx, isCurrent)) { save(); return false; }
            }
            const segs = stack.pop() as string[];
            // A branch outside the storage scope (account not selected, day folder before "từ ngày" (from date), shared files turned off): skip the whole branch
            if (!this.dirAllowed(ctx, segs)) continue;
            let processFiles = true;
            if (after) {
                const cmp = preOrderCompare(segs, after);
                // The whole branch is before the cursor → already done
                if (cmp < 0 && !isAncestorOf(segs, after)) continue;
                // Ancestors of the cursor / the cursor itself: files already done, only continue into subfolders
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
            // Symlink / junction: do not follow (does not leave the media folder, does not loop forever)
            if (e.isDirectory()) { if (!isSkippedDirName(e.name)) subdirs.push(e.name); }
            else if (e.isFile() && !isSkippedFileName(e.name)) files.push(e.name);
        }
        subdirs.sort(childOrder);
        return { files, subdirs };
    }

    /** stat in batches of 500, then write the index; onlyUnknown: only files not yet in the index (light scan). */
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

    // ─── Periodic light scan ──────────────────────────────────────────────

    /**
     * stat every folder (cheap), re-read only the folders whose mtime changed since last time. First time in the session: only folders changed within
     * the last 3 days, or after the latest full scan (older folders were already recorded by that full scan).
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
