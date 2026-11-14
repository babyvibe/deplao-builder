/**
 * cloudMedia: stores media on Cloudflare R2 (optional, off by default). Contract: CloudMediaModule (../contracts.ts).
 *
 * Design (agreed with the user):
 *  - Media is still written to the machine first; R2 is the long-term copy. messages.local_paths does NOT change. Deleting a message in the app does NOT delete anything
 *    on R2 (R2 is an archive; only the R2 cleanup tool that the user runs deletes objects).
 *  - One private bucket per machine `deplao-media-<8 characters of machineId>`; key `<workspaceUid>/<path inside media/>` (NFC, '/').
 *    workspaceUid + bucket are stored in the app_settings of the workspace DB, so a DB restored on another machine can still find its media.
 *  - Index `cloud_media` in the DB of the open workspace; an employee workspace (remote) does not upload (the Boss machine handles it).
 *  - Off = no timer, no DB writes, no scan. Does not block the main flow (in batches, yielding to the event loop).
 *  - Never deletes a file on the machine unless its presence on R2 is confirmed (MediaEvictor), and only when the user turns on "giải phóng ổ đĩa"
 *    (free disk space; evictEnabled, off by default: files stay on the machine).
 *  - Storage scope (options.scope: accounts + from date; options.includeShared: files that belong to no account) PER WORKSPACE
 *    (app_settings.cloud_media_scope_choice of the workspace DB; the accounts belong to the workspace); the other options are shared by the whole machine.
 *    Only files in scope are queued; changing the scope → rescan from the start, queued files that are now outside the scope →
 *    excluded; files already on R2 stay and can still be downloaded.
 *  - Cleanup on R2 happens only when the user runs the cleanup tool (cleanupPreview → cleanupRun, MediaCleanup).
 *
 * Connection points:
 *  - FileStorageService: noteFileWritten(absPath) after media is saved; cleanupOldMedia → evictOldAccountMedia(): R2 takes over
 *    "auto-delete old media" only when it is on + free disk space is on + the account is in scope; otherwise cleanup runs as before.
 *  - local-media:// (electron/main.ts) and /api/media/* (MediaHandler): resolveMissingMediaFile(absPath, { waitMs })
 *    before returning a 404.
 *  - electron/main.ts: init() after the DB is ready, shutdown() on exit. IPC cloudflare:media:* → the remaining functions.
 */
import * as fs from 'fs';
import {
    isAllScope, MediaSyncOptions, MediaSyncStatus, normalizeScope, R2CleanupPreview, R2CleanupProgress, R2CleanupRequest,
    R2CleanupResult, scopeIncludesAccount,
} from '../../../shared/cloud/cloudContracts';
import type { CloudflareCore, CloudMediaModule, CloudSettingsData } from '../contracts';
import { CloudError } from '../contracts';
import {
    ALL_MEDIA_SCOPE, CloudMediaIndex, EMPTY_TOTALS, MediaDb, MediaScopeChoice, MediaTotals, SETTING_MEDIA_BUCKET,
} from './CloudMediaIndex';
import { MediaScopeFilter, mediaBucketName } from './keys';
import { MediaCleanup } from './MediaCleanup';
import { MediaContext, MediaContextManager } from './MediaContext';
import { MediaEvictor } from './MediaEvictor';
import { MediaRehydrate } from './MediaRehydrate';
import { MediaScanner } from './MediaScanner';
import { MediaUploader } from './MediaUploader';
import {
    cloneMediaOptions, DEFAULT_MEDIA_OPTIONS, errorText, GIB, LogFn, MINUTE, msUntilLocalTime, noLog, normalizeMediaOptions,
    sameMediaScope, SECOND, unrefTimer, Waker,
} from './util';
import { lastWakeOrStartAt, systemIdleInfo } from '../../../utils/startup/systemIdle';
import { tr } from '../../../shared/i18n';

export interface CloudMediaServiceDeps {
    core(): CloudflareCore;
    /** SQL on the DB of the open workspace; null if the DB is not ready yet. */
    activeDb(): MediaDb | null;
    activeDbPath(): string;
    /** FileStorageService.getBaseDir() */
    mediaRoot(): string;
    /** false when an employee workspace (remote) is open. */
    supportedWorkspace(): boolean;
    now?(): number;
    log?: LogFn;
}

const NOTIFY_MIN_INTERVAL_MS = 2 * SECOND;
const TOTALS_TTL_MS = 5 * SECOND;
/** Account folder aliases (fb_accounts) re-read at most every 10 minutes. */
const ALIAS_TTL_MS = 10 * MINUTE;
/** Storage scope of the workspace (app_settings) re-read at most every 30 seconds (changed via setOptions / workspace switch → read at once). */
const SCOPE_TTL_MS = 30 * SECOND;
/** After every ~2 GB / 2000 uploaded files: check disk cleanup (if on), instead of waiting for 03:00. */
const EVICT_AFTER_BYTES = 2 * GIB;
const EVICT_AFTER_FILES = 2000;

type Fatal = { kind: 'auth' | 'bucket' | 'connection'; message: string };

function ensureMediaSettings(d: CloudSettingsData): CloudSettingsData['media'] {
    if (!d.media || typeof d.media !== 'object') d.media = { enabled: false, bucket: null, options: machineOptions(DEFAULT_MEDIA_OPTIONS) };
    return d.media;
}

/** Options shared by the whole machine (cloud-settings.json); the storage scope belongs to each workspace, it is not written here. */
function machineOptions(o: MediaSyncOptions): MediaSyncOptions {
    const { scope: _scope, includeShared: _shared, ...rest } = o;
    return rest;
}

function describeScope(c: MediaScopeChoice): string {
    const accounts = c.scope.accounts === 'all' ? 'tất cả tài khoản' : `${c.scope.accounts.length} tài khoản`;
    const from = c.scope.fromTs ? `từ ${new Date(c.scope.fromTs).toISOString().slice(0, 10)}` : 'toàn bộ thời gian';
    return `${accounts}, ${from}, ${c.includeShared ? tr('có') : tr('không')} file chung`;
}

export class CloudMediaService implements CloudMediaModule {
    private initDone = false;
    private enabled = false;
    private started = false;
    private gen = 0;
    private paused = false;
    private fatal: Fatal | null = null;
    private notice: string | null = null;
    private opts: MediaSyncOptions = { ...DEFAULT_MEDIA_OPTIONS };
    private readonly uploadWaker = new Waker();
    private readonly scanWaker = new Waker();
    private readonly ctxMgr: MediaContextManager;
    private readonly scanner: MediaScanner;
    private readonly uploader: MediaUploader;
    private readonly rehydrator: MediaRehydrate;
    private readonly evictor: MediaEvictor;
    private readonly cleanup: MediaCleanup;
    private aliasCache: { ctxId: number; at: number; map: ReadonlyMap<string, string> } | null = null;
    /** Storage scope of the open workspace (by DB path). */
    private scopeCache: { dbPath: string; at: number; choice: MediaScopeChoice } | null = null;
    private dailyTimer: ReturnType<typeof setTimeout> | null = null;
    private evictKickTimer: ReturnType<typeof setTimeout> | null = null;
    private notifyTimer: ReturnType<typeof setTimeout> | null = null;
    private lastNotifyAt = 0;
    private sinceEvict = { bytes: 0, files: 0 };
    private totalsCache: { at: number; key: string; totals: MediaTotals } | null = null;
    private unsubscribe: (() => void) | null = null;
    private readonly accountJobs = new Set<string>();
    private readonly log: LogFn;

    constructor(private readonly deps: CloudMediaServiceDeps) {
        this.log = deps.log || noLog;
        const r2 = (bucket: string) => this.deps.core().r2(bucket);
        const options = () => this.opts;
        const now = () => this.now();
        const scope = (ctx: MediaContext) => this.scopeFilter(ctx);
        this.ctxMgr = new MediaContextManager({
            activeDb: () => deps.activeDb(),
            activeDbPath: () => deps.activeDbPath(),
            mediaRoot: () => deps.mediaRoot(),
            supportedWorkspace: () => deps.supportedWorkspace(),
            machineBucket: () => this.settingsMedia()?.bucket || null,
            provider: () => this.providerNow(),
            realpath: (p) => fs.promises.realpath(p),
            now,
            log: this.log,
        }, () => this.onContextChanged());
        this.uploader = new MediaUploader({
            ctx: this.ctxMgr,
            r2,
            options,
            waiter: this.uploadWaker,
            isPaused: () => this.paused,
            isBlocked: () => !!this.fatal,
            onFatal: (kind, message) => this.onFatal(kind, message),
            onChange: () => this.notify(),
            onUploaded: (bytes) => this.onUploaded(bytes),
            scope,
            now,
            log: this.log,
        });
        this.scanner = new MediaScanner({
            ctx: this.ctxMgr,
            waiter: this.scanWaker,
            isActive: () => this.started,
            isPaused: () => this.paused,
            onIndexed: () => { this.uploadWaker.wake(); this.notify(); },
            scope,
            now,
            log: this.log,
            // The periodic full scan runs only when the machine is idle; the light scan waits after the machine wakes (MediaScanner.fullScanWait)
            idle: () => ({ wakeAt: lastWakeOrStartAt(), info: systemIdleInfo() }),
        });
        this.rehydrator = new MediaRehydrate({
            ctx: this.ctxMgr,
            r2,
            isBackingOff: () => this.uploader.isBackingOff(),
            onBusy: (ms) => this.uploader.noteBusy(ms),
            onNotice: (message) => { this.notice = message; this.notify(true); },
            onChange: () => this.notify(),
            now,
            log: this.log,
        });
        this.evictor = new MediaEvictor({
            ctx: this.ctxMgr,
            r2,
            options,
            isBackingOff: () => this.uploader.isBackingOff(),
            onBusy: (ms) => this.uploader.noteBusy(ms),
            onIndexed: () => this.uploadWaker.wake(),
            scope,
            now,
            log: this.log,
        });
        this.cleanup = new MediaCleanup({
            ctx: this.ctxMgr,
            r2,
            scope,
            aliases: (ctx) => this.aliasesFor(ctx),
            isBackingOff: () => this.uploader.isBackingOff(),
            backoffRemainingMs: () => Math.max(0, this.uploader.backoffUntil - this.now()),
            onBusy: (ms) => this.uploader.noteBusy(ms),
            exclusive: (fn) => this.evictor.runExclusive(fn),
            now,
            log: this.log,
        });
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private isGen(gen: number): boolean {
        return this.started && this.gen === gen;
    }

    /** Selected store ('r2' by default; a fake core in tests does not have this function). */
    private providerNow(): string {
        try {
            const core = this.deps.core() as Partial<CloudflareCore>;
            return typeof core.storageProvider === 'function' ? core.storageProvider() : 'r2';
        } catch {
            return 'r2';
        }
    }

    /** Whether the selected store is usable (fake core in tests: based on status().connected). */
    private storageReadyNow(): { ready: boolean; reason: string | null } {
        try {
            const core = this.deps.core() as Partial<CloudflareCore>;
            if (typeof core.storageReady === 'function') return core.storageReady();
            const conn = core.status?.();
            return conn?.connected ? { ready: true, reason: null } : { ready: false, reason: tr('Mất kết nối Cloudflare') };
        } catch {
            return { ready: false, reason: null };
        }
    }

    private storeName(): string {
        return this.providerNow() === 'gdrive' ? 'Google Drive' : 'R2';
    }

    private settingsMedia(): CloudSettingsData['media'] | null {
        try {
            return this.deps.core().settings.get()?.media || null;
        } catch {
            return null;
        }
    }

    // ─── CloudMediaModule ──────────────────────────────────────────────

    async init(): Promise<void> {
        if (this.initDone) return;
        this.initDone = true;
        try {
            const media = this.settingsMedia();
            this.opts = normalizeMediaOptions(media?.options);
            if (media?.enabled) {
                this.enabled = true;
                this.start();
            }
        } catch (err) {
            this.log('warn', `[CloudMedia] Khởi động lỗi: ${errorText(err)}`);
        }
    }

    status(): MediaSyncStatus {
        const now = this.now();
        const media = this.initDone ? null : this.settingsMedia();
        let bucket: string | null = null;
        try { bucket = this.ctxMgr.current()?.bucket || this.settingsMedia()?.bucket || null; } catch { bucket = null; }
        return {
            enabled: this.initDone ? this.enabled : !!media?.enabled,
            bucket,
            running: this.started && !this.fatal,
            paused: this.paused,
            totals: this.totals(),
            backoffUntil: this.uploader.backoffUntil > now ? this.uploader.backoffUntil : null,
            // Machine options + the storage scope of the open workspace
            options: this.withWorkspaceScope(this.initDone ? this.opts : normalizeMediaOptions(media?.options)),
            lastError: this.lastError(),
        };
    }

    async setEnabled(on: boolean): Promise<MediaSyncStatus> {
        const core = this.deps.core();
        if (!on) {
            this.stop();
            this.enabled = false;
            this.initDone = true;
            this.fatal = null;
            this.notice = null;
            this.paused = false;
            this.uploader.clearBackoff();
            core.settings.update((d) => { ensureMediaSettings(d).enabled = false; });
            this.log('log', '[CloudMedia] Đã tắt lưu media lên R2 (không xoá gì trên R2 / trên máy)');
            this.notify(true);
            return this.status();
        }
        if (this.providerNow() === 'gdrive') {
            const ready = this.storageReadyNow();
            if (!ready.ready) throw new CloudError('NOT_CONNECTED', ready.reason || tr('Chưa đăng nhập Google Drive — đăng nhập Google trước khi bật lưu ảnh, file.'));
        } else {
            const conn = core.status();
            if (!conn || !conn.connected) {
                throw new CloudError('NOT_CONNECTED', tr('Chưa kết nối Cloudflare — kết nối tài khoản trước khi bật lưu media lên R2.'));
            }
            const r2Check = (conn.permissions || []).find((p) => p.feature === 'r2');
            if (r2Check && !r2Check.ok) {
                throw r2Check.r2NotEnabled
                    ? new CloudError('R2_NOT_ENABLED', tr('R2 chưa được bật trên tài khoản Cloudflare — bật R2 trong trang quản trị Cloudflare rồi thử lại.'))
                    : new CloudError('R2_PERMISSION', tr('Token Cloudflare thiếu quyền R2{{v1}}.', { v1: r2Check.missing && r2Check.missing.length ? ` (${r2Check.missing.join(', ')})` : '' }));
            }
        }
        const settings = core.settings.get();
        // Bucket: if it is already in the machine config → the bucket this workspace DB already uses (restored DB) → otherwise create one from machineId
        const bucket = settings.media?.bucket || this.pinnedBucket() || mediaBucketName(settings.machineId);
        await core.ensureBucket(bucket);
        const opts = normalizeMediaOptions(settings.media?.options);
        core.settings.update((d) => {
            const m = ensureMediaSettings(d);
            m.enabled = true;
            m.bucket = bucket;
            m.options = machineOptions(opts);
        });
        this.opts = opts;
        this.enabled = true;
        this.initDone = true;
        this.fatal = null;
        this.notice = null;
        this.paused = false;
        this.uploader.clearBackoff();
        this.stop();
        this.start();
        this.notify(true);
        return this.status();
    }

    pause(): void {
        if (this.paused) return;
        this.paused = true;
        this.log('log', '[CloudMedia] Tạm dừng lưu media lên R2');
        this.notify(true);
    }

    resume(): void {
        this.paused = false;
        this.fatal = null;
        this.notice = null;
        this.uploader.clearBackoff();
        if (this.enabled && !this.started) this.start();
        if (this.started) {
            // "Tiếp tục" (Resume) = also retry the files that failed too many times
            try {
                const ctx = this.ctxMgr.current();
                if (ctx) ctx.index.unparkFailed();
            } catch { /* next time */ }
        }
        this.uploadWaker.wake();
        this.scanWaker.wake();
        this.notify(true);
    }

    /**
     * scope / includeShared: the scope of the open workspace (written to the app_settings of the workspace DB; accounts belong to the
     * workspace). The other options (parallel, night, bandwidth, free disk space) are shared by the whole machine (cloud-settings).
     */
    async setOptions(partial: Partial<MediaSyncOptions>): Promise<MediaSyncStatus> {
        // Before init(): this.opts is still the default → merge into the saved options, do not overwrite them with the defaults
        const base = this.initDone ? this.opts : normalizeMediaOptions(this.settingsMedia()?.options);
        // A field not sent / undefined keeps its old value (does not accidentally reset the scope to "tất cả" (all))
        const patch: Partial<MediaSyncOptions> = {};
        if (partial && typeof partial === 'object') {
            for (const [k, v] of Object.entries(partial)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
        }
        const { scope: scopePatch, includeShared: sharedPatch, ...machinePatch } = patch;

        // 1. The workspace scope (written first: on error nothing changes). Send back the scope currently in place (the UI sends the whole set
        //    of options) → nothing is written, including in an employee workspace.
        let scopeChanged = false;
        if (scopePatch !== undefined || sharedPatch !== undefined) {
            const current = this.workspaceScope();
            const nextChoice: MediaScopeChoice = {
                scope: scopePatch !== undefined ? normalizeScope(scopePatch) : current.scope,
                includeShared: typeof sharedPatch === 'boolean' ? sharedPatch : current.includeShared,
            };
            if (!sameMediaScope(current, nextChoice)) {
                const target = this.scopeTarget();
                target.index.writeScopeChoice(nextChoice);
                this.scopeCache = { dbPath: target.dbPath, at: this.now(), choice: nextChoice };
                scopeChanged = true;
                this.log('log', `[CloudMedia] Đổi phạm vi lưu media của workspace: ${describeScope(nextChoice)}`);
            }
        }

        // 2. Machine options
        const next = normalizeMediaOptions({ ...base, ...machinePatch });
        this.deps.core().settings.update((d) => { ensureMediaSettings(d).options = machineOptions(next); });
        const evictTurnedOn = next.evictEnabled && !base.evictEnabled;
        this.opts = next;
        if (scopeChanged) {
            this.aliasCache = null;
            this.totalsCache = null;
        }
        if (this.started) {
            if (evictTurnedOn) this.kickEvict(MINUTE);
            // New scope: the running scan stops, the index is re-checked and scanned again from the start (files already on R2 are kept)
            if (scopeChanged) {
                this.scanner.scopeChanged();
                this.scanWaker.wake();
            }
            this.uploadWaker.wake();
        }
        this.notify(true);
        return this.status();
    }

    /** Starts re-downloading (in the background) every file cleaned off the machine; returns at once: progress is shown via status().totals.evicted. */
    async rehydrateAll(): Promise<void> {
        if (!this.started) throw new CloudError('MEDIA_DISABLED', tr('Bật lưu media lên {{v1}} trước khi tải lại các file đã dọn.', { v1: this.storeName() }));
        if (this.fatal) throw new CloudError('MEDIA_BLOCKED', this.fatal.message);
        const gen = this.gen;
        this.notice = null;
        void this.rehydrator.rehydrateAll(() => this.isGen(gen)).then(() => {
            this.totalsCache = null;
            if (this.isGen(gen)) this.notify(true);
        });
    }

    noteFileWritten(absPath: string): void {
        if (!this.started || !absPath) return;
        try { this.scanner.note(absPath); } catch { /* never affects where files are stored */ }
    }

    /**
     * waitMs: waits up to this long (clamped to 0…120 s, default 60 s), then returns null: the download keeps running in the background, so the next
     * time the file is there at once (or it joins the same download).
     */
    async resolveMissingMediaFile(absPath: string, opts?: { waitMs?: number }): Promise<string | null> {
        if (!this.started || this.fatal || !absPath) return null;
        try {
            return await this.rehydrator.resolveMissing(absPath, opts);
        } catch {
            return null;
        }
    }

    /** R2 cleanup step 1: scan (in batches, does not block the main thread), remember the list for 15 minutes. Deletes nothing. */
    async cleanupPreview(req: R2CleanupRequest, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupPreview> {
        this.assertCleanupReady();
        const gen = this.gen;
        return this.cleanup.preview(req, () => this.isGen(gen), onProgress);
    }

    /** R2 cleanup step 2: delete exactly the list that was reviewed; index rows → 'removed' (not uploaded again automatically). */
    async cleanupRun(previewId: string, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupResult> {
        this.assertCleanupReady();
        const gen = this.gen;
        try {
            return await this.cleanup.run(previewId, () => this.isGen(gen), onProgress);
        } finally {
            this.totalsCache = null;
            this.notify(true);
        }
    }

    private assertCleanupReady(): void {
        if (!this.started) throw new CloudError('MEDIA_DISABLED', tr('Bật lưu media lên {{v1}} trước khi dọn file trên {{v1}}.', { v1: this.storeName() }));
        if (this.fatal) throw new CloudError('MEDIA_BLOCKED', this.fatal.message);
    }

    async shutdown(): Promise<void> {
        this.stop();
    }

    // ─── Outside the contract: replaces the per-account "tự xoá media cũ" (auto-delete old media) ─────

    /**
     * Whether R2 takes over the "tự xoá media cũ sau N ngày" (auto-delete old media after N days) of this account: only when media storage on R2 is on, the user
     * turns on "giải phóng ổ đĩa" (free disk space; evictEnabled) and the account is in the storage scope. Otherwise (R2 off, files kept on the machine (the default),
     * account outside the scope, employee workspace) → the old setting runs exactly as before R2 existed.
     */
    handlesAccountCleanup(accountDir: string): boolean {
        let on = this.started;
        let opts = this.opts;
        if (!this.initDone) {
            const media = this.settingsMedia();
            on = on || !!media?.enabled;
            opts = normalizeMediaOptions(media?.options);
        }
        if (!on || !opts.evictEnabled) return false;
        try {
            if (!this.deps.supportedWorkspace()) return false;
        } catch {
            return false;
        }
        // Account outside the workspace's storage scope: R2 does not keep its files → the old setting runs as before
        return scopeIncludesAccount(this.workspaceScope().scope, String(accountDir || ''));
    }

    /**
     * Called from FileStorageService.cleanupOldMedia. true = R2 has taken the job (handlesAccountCleanup; runs in the background, only cleans files
     * verified on R2) → the caller must NOT delete the folder as before. false → the caller cleans as before.
     */
    evictOldAccountMedia(accountDir: string, olderThanDays: number): boolean {
        if (!this.handlesAccountCleanup(accountDir)) return false;
        // Turned on but not fully started yet: skip this time (do not delete files that are not backed up)
        if (!this.started) return true;
        const name = String(accountDir || '');
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || !(olderThanDays > 0)) return true;
        if (this.accountJobs.has(name)) return true;
        try {
            this.accountJobs.add(name);
            const gen = this.gen;
            void this.evictor.evictAccountOlderThan(name, olderThanDays, () => this.isGen(gen))
                .then((r) => {
                    if (r.evicted && this.isGen(gen)) { this.totalsCache = null; this.notify(); }
                })
                .catch((err) => this.log('warn', `[CloudMedia] Tự dọn media cũ (${name}) lỗi: ${errorText(err)}`))
                .finally(() => this.accountJobs.delete(name));
        } catch (err) {
            this.accountJobs.delete(name);
            this.log('warn', `[CloudMedia] Tự dọn media cũ (${name}) lỗi: ${errorText(err)}`);
        }
        return true;
    }

    // ─── Internal ────────────────────────────────────────────────────────

    private start(): void {
        if (this.started) return;
        this.started = true;
        const gen = ++this.gen;
        const isCurrent = () => this.isGen(gen);
        void this.uploader.run(isCurrent).catch((err) => this.log('error', `[CloudMedia] Hàng đợi tải lên dừng: ${errorText(err)}`));
        void this.scanner.run(isCurrent).catch((err) => this.log('error', `[CloudMedia] Quét media dừng: ${errorText(err)}`));
        this.scheduleDaily();
        try {
            this.unsubscribe = this.deps.core().onChanged((area) => {
                if (area === 'connection' && this.isGen(gen)) this.onConnectionChanged();
            });
        } catch {
            this.unsubscribe = null;
        }
        this.log('log', '[CloudMedia] Bắt đầu lưu media lên R2');
    }

    private stop(): void {
        if (!this.started) return;
        this.started = false;
        this.gen++;
        for (const t of [this.dailyTimer, this.evictKickTimer, this.notifyTimer]) if (t) clearTimeout(t);
        this.dailyTimer = null;
        this.evictKickTimer = null;
        this.notifyTimer = null;
        try { this.unsubscribe?.(); } catch { /* ignore */ }
        this.unsubscribe = null;
        this.scanner.reset();
        this.rehydrator.reset();
        this.cleanup.reset();
        this.ctxMgr.invalidate();
        this.totalsCache = null;
        this.aliasCache = null;
        this.scopeCache = null;
        this.sinceEvict = { bytes: 0, files: 0 };
        // Wake the loops so they see it has stopped and exit at once
        this.uploadWaker.wake();
        this.scanWaker.wake();
    }

    private onContextChanged(): void {
        this.totalsCache = null;
        this.aliasCache = null;
        // Workspace / DB replaced: read the new workspace's scope again (the scan after this applies that scope)
        this.scopeCache = null;
        this.rehydrator.reset();
    }

    // ─── Storage scope per workspace ────────────────────────────────────

    /** Storage scope in effect for this context; null = no limit (all accounts, all time, including shared files). */
    private scopeFilter(ctx: MediaContext): MediaScopeFilter | null {
        const choice = this.scopeChoiceOf(ctx.dbPath, () => ctx.index);
        if (choice.includeShared && isAllScope(choice.scope)) return null;
        // Folder aliases are only needed when some accounts are selected
        const aliases = choice.scope.accounts !== 'all' ? this.aliasesFor(ctx) : null;
        return { scope: choice.scope, includeShared: choice.includeShared, aliases };
    }

    /** Selected scope of the workspace whose DB is dbPath (app_settings; remembered ≤ 30 s). A read error → all. */
    private scopeChoiceOf(dbPath: string, index: () => CloudMediaIndex | null): MediaScopeChoice {
        if (!dbPath) return ALL_MEDIA_SCOPE;
        const now = this.now();
        const cached = this.scopeCache;
        if (cached && cached.dbPath === dbPath && now - cached.at >= 0 && now - cached.at < SCOPE_TTL_MS) return cached.choice;
        let choice: MediaScopeChoice = ALL_MEDIA_SCOPE;
        try {
            const idx = index();
            if (idx) choice = idx.readScopeChoice();
        } catch {
            choice = ALL_MEDIA_SCOPE;
        }
        this.scopeCache = { dbPath, at: now, choice };
        return choice;
    }

    /** Storage scope of the open workspace (employee workspace / no DB yet → all). */
    private workspaceScope(): MediaScopeChoice {
        try {
            if (!this.deps.supportedWorkspace()) return ALL_MEDIA_SCOPE;
            const dbPath = this.deps.activeDbPath();
            return this.scopeChoiceOf(dbPath, () => {
                const db = this.deps.activeDb();
                return db ? new CloudMediaIndex(db) : null;
            });
        } catch {
            return ALL_MEDIA_SCOPE;
        }
    }

    /** Where the scope is written: the DB of the open workspace (not an employee workspace). */
    private scopeTarget(): { dbPath: string; index: CloudMediaIndex } {
        let supported = true;
        try { supported = this.deps.supportedWorkspace(); } catch { supported = true; }
        if (!supported) {
            throw new CloudError('REMOTE_WORKSPACE', tr('Đang mở workspace nhân viên — media do máy Boss lưu lên R2, không đặt phạm vi ở máy này.'));
        }
        const dbPath = this.deps.activeDbPath();
        const db = dbPath ? this.deps.activeDb() : null;
        if (!dbPath || !db) throw new CloudError('NO_DB', tr('Chưa mở được dữ liệu của workspace — thử lại sau ít giây.'));
        return { dbPath, index: new CloudMediaIndex(db) };
    }

    /** Machine options + the storage scope of the open workspace (a copy; does not share the accounts array). */
    private withWorkspaceScope(o: MediaSyncOptions): MediaSyncOptions {
        const choice = this.workspaceScope();
        return cloneMediaOptions({ ...o, scope: choice.scope, includeShared: choice.includeShared });
    }

    /** Facebook folders named by fb_accounts.id → facebook_id (reads the DB at most every 10 minutes / context). */
    private aliasesFor(ctx: MediaContext): ReadonlyMap<string, string> {
        const now = this.now();
        const cached = this.aliasCache;
        if (cached && cached.ctxId === ctx.id && now - cached.at >= 0 && now - cached.at < ALIAS_TTL_MS) return cached.map;
        let map: ReadonlyMap<string, string>;
        try {
            map = ctx.index.accountFolderAliases();
        } catch {
            map = new Map();
        }
        this.aliasCache = { ctxId: ctx.id, at: now, map };
        return map;
    }

    private onConnectionChanged(): void {
        try {
            const ready = this.storageReadyNow();
            if (!ready.ready) {
                if (!this.fatal) {
                    this.fatal = this.providerNow() === 'gdrive'
                        ? { kind: 'connection', message: tr('{{v1}} — lưu ảnh, file lên Google Drive tạm dừng.', { v1: (ready.reason || 'Mất đăng nhập Google Drive').replace(/[.\s]+$/, '') }) }
                        : { kind: 'connection', message: tr('Mất kết nối Cloudflare — lưu media lên R2 tạm dừng.') };
                }
            } else if (this.fatal) {
                // Reconnected / new token → retry
                this.fatal = null;
                this.uploader.clearBackoff();
                this.uploadWaker.wake();
                this.scanWaker.wake();
            }
            this.notify(true);
        } catch { /* ignore */ }
    }

    private onFatal(kind: 'auth' | 'bucket', message: string): void {
        if (this.fatal && this.fatal.kind === kind) return;
        this.fatal = { kind, message };
        this.log('warn', `[CloudMedia] Tạm dừng lưu media lên ${this.storeName()}: ${message}`);
        this.notify(true);
    }

    private onUploaded(bytes: number): void {
        this.sinceEvict.bytes += Math.max(0, bytes);
        this.sinceEvict.files++;
        if (!this.opts.evictEnabled) return;
        if (this.sinceEvict.bytes >= EVICT_AFTER_BYTES || this.sinceEvict.files >= EVICT_AFTER_FILES) {
            this.sinceEvict = { bytes: 0, files: 0 };
            this.kickEvict(MINUTE);
        }
    }

    private kickEvict(delay: number): void {
        if (!this.started || this.evictKickTimer) return;
        const gen = this.gen;
        this.evictKickTimer = setTimeout(() => {
            this.evictKickTimer = null;
            if (this.isGen(gen)) void this.runSpaceEviction(gen);
        }, delay);
        unrefTimer(this.evictKickTimer);
    }

    private async runSpaceEviction(gen: number): Promise<void> {
        try {
            const r = await this.evictor.runSpaceEviction(() => this.isGen(gen));
            if (r.evicted && this.isGen(gen)) { this.totalsCache = null; this.notify(); }
        } catch (err) {
            this.log('warn', `[CloudMedia] Dọn ổ lỗi: ${errorText(err)}`);
        }
    }

    /** Daily at ~03:00 (+ a random ≤ 10 minutes): retry failed files, clean the disk if on. Only scheduled while running. */
    private scheduleDaily(): void {
        if (this.dailyTimer) { clearTimeout(this.dailyTimer); this.dailyTimer = null; }
        if (!this.started) return;
        const gen = this.gen;
        const delay = msUntilLocalTime(this.now(), 3, 0) + Math.floor(Math.random() * 10 * MINUTE);
        this.dailyTimer = setTimeout(() => {
            this.dailyTimer = null;
            if (!this.isGen(gen)) return;
            void this.daily(gen);
            this.scheduleDaily();
        }, delay);
        unrefTimer(this.dailyTimer);
    }

    private async daily(gen: number): Promise<void> {
        try {
            const ctx = await this.ctxMgr.get();
            if (ctx && this.isGen(gen) && this.ctxMgr.isValid(ctx) && ctx.index.unparkFailed() > 0) this.uploadWaker.wake();
        } catch { /* next time */ }
        if (this.opts.evictEnabled && this.isGen(gen)) await this.runSpaceEviction(gen);
    }

    private notify(immediate = false): void {
        if (immediate) {
            this.totalsCache = null;
            if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
            this.emitChanged();
            return;
        }
        if (this.notifyTimer || !this.started) return;
        const wait = Math.max(0, NOTIFY_MIN_INTERVAL_MS - (Date.now() - this.lastNotifyAt));
        this.notifyTimer = setTimeout(() => {
            this.notifyTimer = null;
            this.emitChanged();
        }, wait);
        unrefTimer(this.notifyTimer);
    }

    private emitChanged(): void {
        this.lastNotifyAt = Date.now();
        try { this.deps.core().notifyChanged('media'); } catch { /* core not ready yet */ }
    }

    private lastError(): string | null {
        if (this.fatal) return this.fatal.message;
        if (this.notice) return this.notice;
        if (this.uploader.transientError) return this.uploader.transientError;
        if (this.started) {
            if (this.ctxMgr.blocked === 'remote_workspace') return tr('Đang mở workspace nhân viên — media do máy Boss lưu lên {{v1}}, máy này không tải lên.', { v1: this.storeName() });
            if (this.ctxMgr.blocked === 'no_bucket') return tr('Chưa có nơi lưu media trên {{v1}} — tắt rồi bật lại đồng bộ ảnh, file.', { v1: this.storeName() });
            if (this.ctxMgr.blocked === 'store_mismatch') {
                const m = this.ctxMgr.mismatch;
                const from = m?.from === 'gdrive' ? 'Google Drive' : 'R2';
                return tr('Workspace này còn {{v1}} file chỉ nằm trên {{from}} (đã dọn khỏi máy) — chọn lại kho {{from}}, tải hết về máy (Nâng cao → Tải lại toàn bộ file đã dọn) rồi mới đổi kho.', { v1: m?.evicted ?? 0, from });
            }
        }
        return null;
    }

    /** The bucket the open workspace's DB already uses (read only). */
    private pinnedBucket(): string | null {
        try {
            if (!this.deps.supportedWorkspace()) return null;
            const db = this.deps.activeDb();
            return db ? new CloudMediaIndex(db).getSetting(SETTING_MEDIA_BUCKET) : null;
        } catch {
            return null;
        }
    }

    /** Totals from the index (read only; cache ≤ 5 s). Can be read even when off (if the table exists). */
    private totals(): MediaTotals {
        try {
            const dbPath = this.deps.activeDbPath();
            if (!dbPath || !this.deps.supportedWorkspace()) return { ...EMPTY_TOTALS };
            const now = this.now();
            const cached = this.totalsCache;
            if (cached && cached.key === dbPath && now - cached.at >= 0 && now - cached.at < TOTALS_TTL_MS) return { ...cached.totals };
            const db = this.deps.activeDb();
            if (!db) return { ...EMPTY_TOTALS };
            const index = new CloudMediaIndex(db);
            const totals = index.tableExists() ? index.totals() : { ...EMPTY_TOTALS };
            this.totalsCache = { at: now, key: dbPath, totals };
            return { ...totals };
        } catch {
            return { ...EMPTY_TOTALS };
        }
    }
}

// ─── Real connection (lazy require: loading this module does not pull Electron / DB / the Cloudflare core in) ───

function dbService(): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../database/DatabaseService').default.getInstance();
}

function toMediaDb(svc: any): MediaDb {
    return {
        exec: (sql) => svc.exec(sql),
        run: (sql, params) => svc.runChanges(sql, (params || []) as any[]),
        all: (sql, params) => svc.query(sql, (params || []) as any[]),
        get: (sql, params) => svc.queryOne(sql, (params || []) as any[]),
        transaction: (fn) => svc.transaction(fn),
    };
}

export function createDefaultDeps(): CloudMediaServiceDeps {
    return {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        core: () => require('../CloudflareService').cloudflare as CloudflareCore,
        activeDb: () => {
            try {
                const svc = dbService();
                return svc.getDbPath() ? toMediaDb(svc) : null;
            } catch {
                return null;
            }
        },
        activeDbPath: () => {
            try { return String(dbService().getDbPath() || ''); } catch { return ''; }
        },
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        mediaRoot: () => require('../../file/FileStorageService').default.getBaseDir(),
        supportedWorkspace: () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                return require('../../../utils/app/WorkspaceManager').default.getInstance().getActiveWorkspace()?.type !== 'remote';
            } catch {
                return true;
            }
        },
        log: (level, message) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const logger = require('../../../utils/Logger').default;
                (logger[level] || logger.log).call(logger, message);
            } catch { /* ignore */ }
        },
    };
}

export const cloudMedia = new CloudMediaService(createDefaultDeps());

/**
 * FileStorageService.cleanupOldMedia: true = media sync to R2 is on and has taken the job (only cleans files already on R2, runs in the
 * background) → the caller does not delete the folder as before. false = off → cleans as before.
 */
export function evictOldAccountMedia(accountDir: string, olderThanDays: number): boolean {
    try {
        return cloudMedia.evictOldAccountMedia(accountDir, olderThanDays);
    } catch {
        return false;
    }
}

/**
 * Whether media saved on R2 takes over the "tự xoá media cũ" (auto-delete old media) of this account (on + free disk space on + account in scope), so the account
 * settings screen reports what will really happen. false → the old setting runs as before R2 existed.
 */
export function handlesAccountMediaCleanup(accountDir: string): boolean {
    try {
        return cloudMedia.handlesAccountCleanup(accountDir);
    } catch {
        return false;
    }
}

export default cloudMedia;
