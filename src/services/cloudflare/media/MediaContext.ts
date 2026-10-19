/**
 * MediaContext — "đang đồng bộ cho workspace nào": DB đang mở + thư mục media + mã workspace + bucket.
 *
 * DatabaseService chỉ có MỘT DB toàn cục, đổi khi chuyển workspace / đổi thư mục lưu trữ / khôi phục DB. Mọi thành phần
 * lấy context trước mỗi lượt việc và kiểm isValid(ctx) ngay trước khi ghi DB (đồng bộ, cùng tick) → không bao giờ ghi
 * kết quả của workspace A vào DB của workspace B. Context chỉ "ổn định" khi thư mục media (FileStorageService.getBaseDir())
 * đúng là <thư mục DB>/media — giữa lúc chuyển workspace hai giá trị lệch nhau trong chốc lát → chờ.
 *
 * Dựng context có GHI DB (tạo bảng, mã workspace) → chỉ gọi khi đồng bộ media đang bật.
 */
import * as crypto from 'crypto';
import * as path from 'path';
import { CloudMediaIndex, MediaDb, SETTING_MEDIA_BUCKET, SETTING_MEDIA_PROVIDER, SETTING_WORKSPACE_UID } from './CloudMediaIndex';
import { LogFn, MINUTE, noLog, SECOND } from './util';

export interface MediaContext {
    /** Tăng mỗi lần dựng lại (đổi workspace / DB). */
    readonly id: number;
    readonly dbPath: string;
    /** path.resolve(FileStorageService.getBaseDir()) */
    readonly mediaRoot: string;
    /** realpath(mediaRoot) — gốc để tính rel_path đúng hoa/thường trên đĩa. */
    readonly realRoot: string;
    /** Tiền tố khoá R2 của workspace (app_settings.cloud_workspace_uid). */
    readonly workspaceUid: string;
    readonly bucket: string;
    readonly index: CloudMediaIndex;
    /** Kho lúc dựng context ('r2' | 'gdrive') — đổi kho → context hết hiệu lực, dựng lại (đối chiếu chỉ mục với kho mới). */
    readonly provider?: string;
}

/** Nguồn context cho các thành phần (test truyền bản giả). */
export interface ContextSource {
    get(): Promise<MediaContext | null>;
    /** Đồng bộ, rẻ — gọi ngay trước mỗi lần ghi DB. */
    isValid(ctx: MediaContext | null): boolean;
    invalidate(): void;
}

export interface ContextDeps {
    activeDb(): MediaDb | null;
    activeDbPath(): string;
    mediaRoot(): string;
    /** false = workspace nhân viên (remote): media ở đó là bản sao từ máy Boss — máy Boss sao lưu, máy này không. */
    supportedWorkspace(): boolean;
    /** Bucket của máy (cloud-settings.json → media.bucket). */
    machineBucket(): string | null;
    /** Kho đang chọn ('r2' | 'gdrive'); thiếu = 'r2'. */
    provider?(): string;
    realpath(p: string): Promise<string>;
    now?(): number;
    log?: LogFn;
}

/** store_mismatch: đã đổi kho nhưng workspace này còn file chỉ nằm trên kho cũ (đã dọn khỏi máy) — chưa chuyển được. */
export type ContextBlock = 'remote_workspace' | 'no_bucket' | 'unstable' | 'no_db' | 'store_mismatch' | null;

const UNSTABLE_GRACE_MS = 2 * MINUTE;
const UID_RECHECK_MS = SECOND;

export function samePath(a: string, b: string): boolean {
    if (!a || !b) return false;
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32' || process.platform === 'darwin' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function newWorkspaceUid(): string {
    return crypto.randomBytes(8).toString('hex');
}

export class MediaContextManager implements ContextSource {
    private ctx: MediaContext | null = null;
    private building: Promise<MediaContext | null> | null = null;
    private seq = 0;
    private unstableSince = 0;
    private uidCheckedAt = 0;
    private warnedUnstable = false;
    /** Lý do không dựng được context (để hiện cho người dùng). */
    blocked: ContextBlock = null;
    /** Với store_mismatch: kho cũ của chỉ mục + số file chỉ còn ở đó. */
    mismatch: { from: string; evicted: number } | null = null;

    constructor(private readonly deps: ContextDeps, private readonly onChange?: (ctx: MediaContext | null) => void) {}

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    current(): MediaContext | null {
        return this.isValid(this.ctx) ? this.ctx : null;
    }

    isValid(ctx: MediaContext | null): boolean {
        if (!ctx || ctx !== this.ctx) return false;
        try {
            if (this.deps.activeDbPath() !== ctx.dbPath) return false;
            if (!samePath(this.deps.mediaRoot(), ctx.mediaRoot)) return false;
            if (!this.deps.supportedWorkspace()) return false;
            if (ctx.provider && this.deps.provider && this.deps.provider() !== ctx.provider) return false;
            // Cùng đường dẫn nhưng nội dung DB đã bị thay (khôi phục bản sao) → mã workspace khác → dựng lại
            const now = this.now();
            if (now - this.uidCheckedAt >= UID_RECHECK_MS) {
                if (ctx.index.getSetting(SETTING_WORKSPACE_UID) !== ctx.workspaceUid) return false;
                this.uidCheckedAt = now;
            }
            return true;
        } catch {
            return false;
        }
    }

    invalidate(): void {
        if (!this.ctx) return;
        this.ctx = null;
        try { this.onChange?.(null); } catch { /* bỏ qua */ }
    }

    async get(): Promise<MediaContext | null> {
        const cur = this.current();
        if (cur) return cur;
        if (this.ctx) this.invalidate();
        if (!this.building) this.building = this.build().finally(() => { this.building = null; });
        return this.building;
    }

    private async build(): Promise<MediaContext | null> {
        const d = this.deps;
        const log = d.log || noLog;
        try {
            if (!d.supportedWorkspace()) { this.blocked = 'remote_workspace'; return null; }
            const dbPath = d.activeDbPath();
            if (!dbPath) { this.blocked = 'no_db'; return null; }
            const root = path.resolve(d.mediaRoot());
            const expected = path.join(path.dirname(dbPath), 'media');
            if (!samePath(root, expected)) {
                // Đang chuyển workspace / thư mục lưu trữ: DB đã đổi mà thư mục media chưa (hoặc ngược lại) → đợi.
                // Lệch kéo dài (cấu hình lạ) → tin thư mục media hiện tại.
                const now = this.now();
                if (!this.unstableSince) this.unstableSince = now;
                if (now - this.unstableSince < UNSTABLE_GRACE_MS) { this.blocked = 'unstable'; return null; }
                if (!this.warnedUnstable) {
                    this.warnedUnstable = true;
                    log('warn', `[CloudMedia] Thư mục media (${root}) không nằm cạnh DB (${dbPath}) — dùng thư mục media hiện tại`);
                }
            } else {
                this.unstableSince = 0;
            }
            const db = d.activeDb();
            if (!db) { this.blocked = 'no_db'; return null; }

            // Từ đây tới trước await: đồng bộ → cùng một DB
            const index = new CloudMediaIndex(db);
            index.ensureSchema();
            index.resetUploading();
            let uid = index.getSetting(SETTING_WORKSPACE_UID);
            if (!uid || !/^[A-Za-z0-9_-]{6,64}$/.test(uid)) {
                uid = newWorkspaceUid();
                index.setSetting(SETTING_WORKSPACE_UID, uid);
            }
            // Kho đã đổi (R2 ↔ Google Drive) từ lần đồng bộ trước → file đã lên kho cũ chờ tải lên kho mới
            const provider = (d.provider ? d.provider() : 'r2') || 'r2';
            const indexedFor = index.getSetting(SETTING_MEDIA_PROVIDER) || 'r2';
            if (indexedFor !== provider) {
                const evicted = index.countEvicted();
                if (evicted > 0) {
                    // Đổi kho lúc còn file chỉ nằm trên kho cũ (vd workspace khác lúc đổi kho): chưa chuyển — mất dấu file
                    this.mismatch = { from: indexedFor, evicted };
                    this.blocked = 'store_mismatch';
                    return null;
                }
                const n = index.resetForNewStore();
                index.setSetting(SETTING_MEDIA_PROVIDER, provider);
                log('log', `[CloudMedia] Đổi kho ${indexedFor} → ${provider}: ${n} file chờ tải lên kho mới`);
            } else if (!index.getSetting(SETTING_MEDIA_PROVIDER)) {
                index.setSetting(SETTING_MEDIA_PROVIDER, provider);
            }
            let bucket = index.getSetting(SETTING_MEDIA_BUCKET);
            if (!bucket) {
                bucket = d.machineBucket();
                if (!bucket) { this.blocked = 'no_bucket'; return null; }
                index.setSetting(SETTING_MEDIA_BUCKET, bucket);
            }

            let realRoot = root;
            try { realRoot = path.resolve(await d.realpath(root)); } catch { /* giữ root */ }
            // Trong lúc chờ realpath, workspace có thể đã đổi → lượt sau dựng lại
            if (d.activeDbPath() !== dbPath || !samePath(d.mediaRoot(), root)) return null;

            const ctx: MediaContext = { id: ++this.seq, dbPath, mediaRoot: root, realRoot, workspaceUid: uid, bucket, index, provider };
            this.ctx = ctx;
            this.uidCheckedAt = this.now();
            this.blocked = null;
            this.mismatch = null;
            try { this.onChange?.(ctx); } catch { /* bỏ qua */ }
            return ctx;
        } catch (err) {
            log('warn', `[CloudMedia] Chưa mở được chỉ mục media: ${(err as Error)?.message || err}`);
            this.blocked = 'no_db';
            return null;
        }
    }
}
