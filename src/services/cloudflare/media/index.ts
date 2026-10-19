/**
 * cloudMedia — lưu media lên Cloudflare R2 (tuỳ chọn, mặc định tắt). Hợp đồng: CloudMediaModule (../contracts.ts).
 *
 * Thiết kế (người dùng đã chốt):
 *  - Media vẫn ghi xuống máy trước; R2 là bản lưu dài hạn. messages.local_paths KHÔNG đổi. Xoá tin trong app KHÔNG xoá gì
 *    trên R2 (R2 là kho lưu trữ; chỉ công cụ dọn R2 do người dùng chạy mới xoá object).
 *  - Một bucket riêng tư mỗi máy `deplao-media-<8 ký tự machineId>`; khoá `<workspaceUid>/<đường dẫn trong media/>` (NFC, '/').
 *    workspaceUid + bucket ghi trong app_settings của DB workspace → DB khôi phục ở máy khác vẫn tìm được media.
 *  - Chỉ mục `cloud_media` trong DB của workspace đang mở; workspace nhân viên (remote) không tải lên (máy Boss lo).
 *  - Tắt = không hẹn giờ, không ghi DB, không quét. Không chặn luồng chính (theo lô, nhường vòng lặp).
 *  - Không bao giờ xoá file trên máy khi chưa xác nhận có trên R2 (MediaEvictor), và chỉ khi người dùng bật "giải phóng
 *    ổ đĩa" (evictEnabled — mặc định giữ nguyên file trên máy).
 *  - Phạm vi lưu (options.scope: tài khoản + từ ngày; options.includeShared: file không thuộc tài khoản) THEO WORKSPACE
 *    (app_settings.cloud_media_scope_choice của DB workspace — tài khoản thuộc workspace); các tuỳ chọn khác dùng chung cả
 *    máy. Chỉ file trong phạm vi được đưa vào hàng đợi; đổi phạm vi → quét lại từ đầu, file chờ tải nay ngoài phạm vi →
 *    excluded; file đã lên R2 giữ nguyên và vẫn tải về được.
 *  - Dọn file trên R2 chỉ khi người dùng chạy công cụ dọn (cleanupPreview → cleanupRun, MediaCleanup).
 *
 * Điểm nối:
 *  - FileStorageService: noteFileWritten(absPath) sau khi lưu media; cleanupOldMedia → evictOldAccountMedia(): R2 nhận
 *    việc "tự xoá media cũ" chỉ khi đang bật + bật giải phóng ổ đĩa + tài khoản trong phạm vi; còn lại dọn như trước.
 *  - local-media:// (electron/main.ts) và /api/media/* (MediaHandler): resolveMissingMediaFile(absPath, { waitMs })
 *    trước khi trả 404.
 *  - electron/main.ts: init() sau khi DB sẵn sàng, shutdown() khi thoát. IPC cloudflare:media:* → các hàm còn lại.
 */
import * as fs from 'fs';
import {
    isAllScope, MediaSyncOptions, MediaSyncStatus, normalizeScope, R2CleanupPreview, R2CleanupProgress, R2CleanupRequest,
    R2CleanupResult, scopeIncludesAccount,
} from '../../../shared/cloudContracts';
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

export interface CloudMediaServiceDeps {
    core(): CloudflareCore;
    /** SQL trên DB của workspace đang mở; null nếu DB chưa sẵn sàng. */
    activeDb(): MediaDb | null;
    activeDbPath(): string;
    /** FileStorageService.getBaseDir() */
    mediaRoot(): string;
    /** false khi đang mở workspace nhân viên (remote). */
    supportedWorkspace(): boolean;
    now?(): number;
    log?: LogFn;
}

const NOTIFY_MIN_INTERVAL_MS = 2 * SECOND;
const TOTALS_TTL_MS = 5 * SECOND;
/** Bí danh thư mục tài khoản (fb_accounts) đọc lại tối đa mỗi 10 phút. */
const ALIAS_TTL_MS = 10 * MINUTE;
/** Phạm vi lưu của workspace (app_settings) đọc lại tối đa mỗi 30 giây (đổi qua setOptions / đổi workspace → đọc ngay). */
const SCOPE_TTL_MS = 30 * SECOND;
/** Sau mỗi ~2 GB / 2000 file tải lên: kiểm tra dọn ổ (nếu bật) thay vì đợi 03:00. */
const EVICT_AFTER_BYTES = 2 * GIB;
const EVICT_AFTER_FILES = 2000;

type Fatal = { kind: 'auth' | 'bucket' | 'connection'; message: string };

function ensureMediaSettings(d: CloudSettingsData): CloudSettingsData['media'] {
    if (!d.media || typeof d.media !== 'object') d.media = { enabled: false, bucket: null, options: machineOptions(DEFAULT_MEDIA_OPTIONS) };
    return d.media;
}

/** Tuỳ chọn dùng chung cả máy (cloud-settings.json) — phạm vi lưu thuộc từng workspace, không ghi ở đây. */
function machineOptions(o: MediaSyncOptions): MediaSyncOptions {
    const { scope: _scope, includeShared: _shared, ...rest } = o;
    return rest;
}

function describeScope(c: MediaScopeChoice): string {
    const accounts = c.scope.accounts === 'all' ? 'tất cả tài khoản' : `${c.scope.accounts.length} tài khoản`;
    const from = c.scope.fromTs ? `từ ${new Date(c.scope.fromTs).toISOString().slice(0, 10)}` : 'toàn bộ thời gian';
    return `${accounts}, ${from}, ${c.includeShared ? 'có' : 'không'} file chung`;
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
    /** Phạm vi lưu của workspace đang mở (theo đường dẫn DB). */
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

    /** Kho đang chọn ('r2' mặc định — core giả trong test không có hàm này). */
    private providerNow(): string {
        try {
            const core = this.deps.core() as Partial<CloudflareCore>;
            return typeof core.storageProvider === 'function' ? core.storageProvider() : 'r2';
        } catch {
            return 'r2';
        }
    }

    /** Kho đang chọn dùng được không (core giả trong test: theo status().connected). */
    private storageReadyNow(): { ready: boolean; reason: string | null } {
        try {
            const core = this.deps.core() as Partial<CloudflareCore>;
            if (typeof core.storageReady === 'function') return core.storageReady();
            const conn = core.status?.();
            return conn?.connected ? { ready: true, reason: null } : { ready: false, reason: 'Mất kết nối Cloudflare' };
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
            // Tuỳ chọn của máy + phạm vi lưu của workspace đang mở
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
            if (!ready.ready) throw new CloudError('NOT_CONNECTED', ready.reason || 'Chưa đăng nhập Google Drive — đăng nhập Google trước khi bật lưu ảnh, file.');
        } else {
            const conn = core.status();
            if (!conn || !conn.connected) {
                throw new CloudError('NOT_CONNECTED', 'Chưa kết nối Cloudflare — kết nối tài khoản trước khi bật lưu media lên R2.');
            }
            const r2Check = (conn.permissions || []).find((p) => p.feature === 'r2');
            if (r2Check && !r2Check.ok) {
                throw r2Check.r2NotEnabled
                    ? new CloudError('R2_NOT_ENABLED', 'R2 chưa được bật trên tài khoản Cloudflare — bật R2 trong trang quản trị Cloudflare rồi thử lại.')
                    : new CloudError('R2_PERMISSION', `Token Cloudflare thiếu quyền R2${r2Check.missing && r2Check.missing.length ? ` (${r2Check.missing.join(', ')})` : ''}.`);
            }
        }
        const settings = core.settings.get();
        // Bucket: đã có trong cấu hình máy → bucket mà DB workspace này đã dùng (DB khôi phục) → tạo theo machineId
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
            // "Tiếp tục" = thử lại cả các file đã lỗi quá số lần
            try {
                const ctx = this.ctxMgr.current();
                if (ctx) ctx.index.unparkFailed();
            } catch { /* lượt sau */ }
        }
        this.uploadWaker.wake();
        this.scanWaker.wake();
        this.notify(true);
    }

    /**
     * scope / includeShared: phạm vi của workspace đang mở (ghi vào app_settings của DB workspace — tài khoản thuộc
     * workspace). Các tuỳ chọn khác (song song, ban đêm, băng thông, giải phóng ổ đĩa) dùng chung cả máy (cloud-settings).
     */
    async setOptions(partial: Partial<MediaSyncOptions>): Promise<MediaSyncStatus> {
        // Trước init(): this.opts còn là mặc định → gộp vào tuỳ chọn đã lưu, không ghi đè bằng mặc định
        const base = this.initDone ? this.opts : normalizeMediaOptions(this.settingsMedia()?.options);
        // Trường không gửi / undefined giữ giá trị cũ (không vô tình đặt lại phạm vi về "tất cả")
        const patch: Partial<MediaSyncOptions> = {};
        if (partial && typeof partial === 'object') {
            for (const [k, v] of Object.entries(partial)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
        }
        const { scope: scopePatch, includeShared: sharedPatch, ...machinePatch } = patch;

        // 1. Phạm vi của workspace (ghi trước: lỗi thì không đổi gì). Gửi lại đúng phạm vi đang có (giao diện gửi cả bộ
        //    tuỳ chọn) → không ghi gì, kể cả ở workspace nhân viên.
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

        // 2. Tuỳ chọn của máy
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
            // Phạm vi mới: lượt quét đang chạy dừng, rà lại chỉ mục rồi quét lại từ đầu (file đã lên R2 giữ nguyên)
            if (scopeChanged) {
                this.scanner.scopeChanged();
                this.scanWaker.wake();
            }
            this.uploadWaker.wake();
        }
        this.notify(true);
        return this.status();
    }

    /** Bắt đầu tải lại (nền) mọi file đã dọn khỏi máy; trả về ngay — tiến độ xem qua status().totals.evicted. */
    async rehydrateAll(): Promise<void> {
        if (!this.started) throw new CloudError('MEDIA_DISABLED', `Bật lưu media lên ${this.storeName()} trước khi tải lại các file đã dọn.`);
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
        try { this.scanner.note(absPath); } catch { /* không bao giờ ảnh hưởng nơi lưu file */ }
    }

    /**
     * waitMs: chờ tối đa bấy nhiêu (kẹp 0…120 s, mặc định 60 s) rồi trả null — việc tải vẫn chạy tiếp ở nền, lần mở sau
     * có file ngay (hoặc nhập vào cùng lượt tải).
     */
    async resolveMissingMediaFile(absPath: string, opts?: { waitMs?: number }): Promise<string | null> {
        if (!this.started || this.fatal || !absPath) return null;
        try {
            return await this.rehydrator.resolveMissing(absPath, opts);
        } catch {
            return null;
        }
    }

    /** Dọn R2 bước 1: quét (theo lô, không chặn luồng chính), nhớ danh sách 15 phút. Không xoá gì. */
    async cleanupPreview(req: R2CleanupRequest, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupPreview> {
        this.assertCleanupReady();
        const gen = this.gen;
        return this.cleanup.preview(req, () => this.isGen(gen), onProgress);
    }

    /** Dọn R2 bước 2: xoá đúng danh sách đã xem; dòng chỉ mục → 'removed' (không tự tải lên lại). */
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
        if (!this.started) throw new CloudError('MEDIA_DISABLED', `Bật lưu media lên ${this.storeName()} trước khi dọn file trên ${this.storeName()}.`);
        if (this.fatal) throw new CloudError('MEDIA_BLOCKED', this.fatal.message);
    }

    async shutdown(): Promise<void> {
        this.stop();
    }

    // ─── Ngoài hợp đồng: thay "tự xoá media cũ" của từng tài khoản ─────

    /**
     * R2 có nhận việc "tự xoá media cũ sau N ngày" của tài khoản này không: chỉ khi lưu media lên R2 đang bật, người
     * dùng bật "giải phóng ổ đĩa" (evictEnabled) và tài khoản trong phạm vi lưu. Còn lại (tắt R2, giữ file trên máy — mặc
     * định, tài khoản ngoài phạm vi, workspace nhân viên) → cài đặt cũ chạy y như trước khi có R2.
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
        // Tài khoản ngoài phạm vi lưu của workspace: R2 không giữ file của nó → cài đặt cũ chạy như trước
        return scopeIncludesAccount(this.workspaceScope().scope, String(accountDir || ''));
    }

    /**
     * Gọi từ FileStorageService.cleanupOldMedia. true = R2 đã nhận việc (handlesAccountCleanup; chạy nền, chỉ dọn file đã
     * xác minh trên R2) → nơi gọi KHÔNG được xoá thư mục như cũ. false → nơi gọi dọn như trước.
     */
    evictOldAccountMedia(accountDir: string, olderThanDays: number): boolean {
        if (!this.handlesAccountCleanup(accountDir)) return false;
        // Đã bật nhưng chưa khởi động xong: lần này bỏ qua (không xoá file chưa sao lưu)
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

    // ─── Nội bộ ────────────────────────────────────────────────────────

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
        try { this.unsubscribe?.(); } catch { /* bỏ qua */ }
        this.unsubscribe = null;
        this.scanner.reset();
        this.rehydrator.reset();
        this.cleanup.reset();
        this.ctxMgr.invalidate();
        this.totalsCache = null;
        this.aliasCache = null;
        this.scopeCache = null;
        this.sinceEvict = { bytes: 0, files: 0 };
        // Đánh thức để các vòng lặp thấy đã dừng và thoát ngay
        this.uploadWaker.wake();
        this.scanWaker.wake();
    }

    private onContextChanged(): void {
        this.totalsCache = null;
        this.aliasCache = null;
        // Đổi workspace / DB bị thay: đọc lại phạm vi của workspace mới (lượt quét sau áp phạm vi đó)
        this.scopeCache = null;
        this.rehydrator.reset();
    }

    // ─── Phạm vi lưu theo workspace ────────────────────────────────────

    /** Phạm vi lưu đang áp cho context này; null = không giới hạn (tất cả tài khoản, toàn bộ thời gian, có file chung). */
    private scopeFilter(ctx: MediaContext): MediaScopeFilter | null {
        const choice = this.scopeChoiceOf(ctx.dbPath, () => ctx.index);
        if (choice.includeShared && isAllScope(choice.scope)) return null;
        // Bí danh thư mục chỉ cần khi chọn một số tài khoản
        const aliases = choice.scope.accounts !== 'all' ? this.aliasesFor(ctx) : null;
        return { scope: choice.scope, includeShared: choice.includeShared, aliases };
    }

    /** Phạm vi đã chọn của workspace có DB dbPath (app_settings; nhớ ≤ 30 s). Đọc lỗi → tất cả. */
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

    /** Phạm vi lưu của workspace đang mở (workspace nhân viên / chưa có DB → tất cả). */
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

    /** Nơi ghi phạm vi: DB của workspace đang mở (không phải workspace nhân viên). */
    private scopeTarget(): { dbPath: string; index: CloudMediaIndex } {
        let supported = true;
        try { supported = this.deps.supportedWorkspace(); } catch { supported = true; }
        if (!supported) {
            throw new CloudError('REMOTE_WORKSPACE', 'Đang mở workspace nhân viên — media do máy Boss lưu lên R2, không đặt phạm vi ở máy này.');
        }
        const dbPath = this.deps.activeDbPath();
        const db = dbPath ? this.deps.activeDb() : null;
        if (!dbPath || !db) throw new CloudError('NO_DB', 'Chưa mở được dữ liệu của workspace — thử lại sau ít giây.');
        return { dbPath, index: new CloudMediaIndex(db) };
    }

    /** Tuỳ chọn của máy + phạm vi lưu của workspace đang mở (bản sao, không dùng chung mảng tài khoản). */
    private withWorkspaceScope(o: MediaSyncOptions): MediaSyncOptions {
        const choice = this.workspaceScope();
        return cloneMediaOptions({ ...o, scope: choice.scope, includeShared: choice.includeShared });
    }

    /** Thư mục Facebook đặt theo fb_accounts.id → facebook_id (đọc DB tối đa mỗi 10 phút / context). */
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
                        ? { kind: 'connection', message: `${(ready.reason || 'Mất đăng nhập Google Drive').replace(/[.\s]+$/, '')} — lưu ảnh, file lên Google Drive tạm dừng.` }
                        : { kind: 'connection', message: 'Mất kết nối Cloudflare — lưu media lên R2 tạm dừng.' };
                }
            } else if (this.fatal) {
                // Kết nối lại / token mới → thử lại
                this.fatal = null;
                this.uploader.clearBackoff();
                this.uploadWaker.wake();
                this.scanWaker.wake();
            }
            this.notify(true);
        } catch { /* bỏ qua */ }
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

    /** Mỗi ngày ~03:00 (+ ngẫu nhiên ≤ 10 phút): thử lại file lỗi, dọn ổ nếu bật. Chỉ hẹn khi đang chạy. */
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
        } catch { /* lần sau */ }
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
        try { this.deps.core().notifyChanged('media'); } catch { /* core chưa sẵn sàng */ }
    }

    private lastError(): string | null {
        if (this.fatal) return this.fatal.message;
        if (this.notice) return this.notice;
        if (this.uploader.transientError) return this.uploader.transientError;
        if (this.started) {
            if (this.ctxMgr.blocked === 'remote_workspace') return `Đang mở workspace nhân viên — media do máy Boss lưu lên ${this.storeName()}, máy này không tải lên.`;
            if (this.ctxMgr.blocked === 'no_bucket') return `Chưa có nơi lưu media trên ${this.storeName()} — tắt rồi bật lại đồng bộ ảnh, file.`;
            if (this.ctxMgr.blocked === 'store_mismatch') {
                const m = this.ctxMgr.mismatch;
                const from = m?.from === 'gdrive' ? 'Google Drive' : 'R2';
                return `Workspace này còn ${m?.evicted ?? 0} file chỉ nằm trên ${from} (đã dọn khỏi máy) — chọn lại kho ${from}, tải hết về máy (Nâng cao → Tải lại toàn bộ file đã dọn) rồi mới đổi kho.`;
            }
        }
        return null;
    }

    /** Bucket mà DB workspace đang mở đã dùng (chỉ đọc). */
    private pinnedBucket(): string | null {
        try {
            if (!this.deps.supportedWorkspace()) return null;
            const db = this.deps.activeDb();
            return db ? new CloudMediaIndex(db).getSetting(SETTING_MEDIA_BUCKET) : null;
        } catch {
            return null;
        }
    }

    /** Tổng hợp từ chỉ mục (chỉ đọc; cache ≤ 5 s). Đọc được cả khi đang tắt (nếu bảng có). */
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

// ─── Kết nối thật (require lười: nạp module này không kéo Electron / DB / Cloudflare core vào) ───

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
                return require('../../../utils/WorkspaceManager').default.getInstance().getActiveWorkspace()?.type !== 'remote';
            } catch {
                return true;
            }
        },
        log: (level, message) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const logger = require('../../../utils/Logger').default;
                (logger[level] || logger.log).call(logger, message);
            } catch { /* bỏ qua */ }
        },
    };
}

export const cloudMedia = new CloudMediaService(createDefaultDeps());

/**
 * FileStorageService.cleanupOldMedia: true = đồng bộ media R2 đang bật và đã nhận việc (chỉ dọn file đã có trên R2, chạy
 * nền) → nơi gọi không xoá thư mục như cũ. false = tắt → dọn như trước.
 */
export function evictOldAccountMedia(accountDir: string, olderThanDays: number): boolean {
    try {
        return cloudMedia.evictOldAccountMedia(accountDir, olderThanDays);
    } catch {
        return false;
    }
}

/**
 * Lưu media R2 có nhận việc "tự xoá media cũ" của tài khoản này không (đang bật + bật giải phóng ổ đĩa + tài khoản trong
 * phạm vi) — để màn cài đặt tài khoản báo đúng điều sẽ xảy ra. false → cài đặt cũ chạy như trước khi có R2.
 */
export function handlesAccountMediaCleanup(accountDir: string): boolean {
    try {
        return cloudMedia.handlesAccountCleanup(accountDir);
    } catch {
        return false;
    }
}

export default cloudMedia;
