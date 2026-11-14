/**
 * MediaContext: "which workspace is being synced now": the open DB + the media folder + the workspace id + the bucket.
 *
 * DatabaseService has only ONE global DB, which changes when the workspace is switched / the storage folder is changed / a DB is restored. Every component
 * takes a context before each job and checks isValid(ctx) right before writing to the DB (synchronous, same tick) → a result from
 * workspace A is never written into workspace B's DB. The context is only "stable" when the media folder (FileStorageService.getBaseDir())
 * is exactly <DB folder>/media; during a workspace switch the two values differ for a moment → wait.
 *
 * Building a context that WRITES to the DB (creating tables, the workspace id) → call it only when media sync is turned on.
 */
import * as crypto from 'crypto';
import * as path from 'path';
import { CloudMediaIndex, MediaDb, SETTING_MEDIA_BUCKET, SETTING_MEDIA_PROVIDER, SETTING_WORKSPACE_UID } from './CloudMediaIndex';
import { LogFn, MINUTE, noLog, SECOND } from './util';

export interface MediaContext {
    /** Incremented on every rebuild (workspace / DB changed). */
    readonly id: number;
    readonly dbPath: string;
    /** path.resolve(FileStorageService.getBaseDir()) */
    readonly mediaRoot: string;
    /** realpath(mediaRoot): the root used to compute rel_path with the correct case on disk. */
    readonly realRoot: string;
    /** The workspace's R2 key prefix (app_settings.cloud_workspace_uid). */
    readonly workspaceUid: string;
    readonly bucket: string;
    readonly index: CloudMediaIndex;
    /** Store when the context was built ('r2' | 'gdrive'): changing the store → the context expires and is rebuilt (the index is checked against the new store). */
    readonly provider?: string;
}

/** Context source for the components (tests pass a fake). */
export interface ContextSource {
    get(): Promise<MediaContext | null>;
    /** Synchronous and cheap: call it right before every DB write. */
    isValid(ctx: MediaContext | null): boolean;
    invalidate(): void;
}

export interface ContextDeps {
    activeDb(): MediaDb | null;
    activeDbPath(): string;
    mediaRoot(): string;
    /** false = employee workspace (remote): the media there is a copy from the Boss machine; the Boss machine backs it up, this machine does not. */
    supportedWorkspace(): boolean;
    /** The machine's bucket (cloud-settings.json → media.bucket). */
    machineBucket(): string | null;
    /** Store currently selected ('r2' | 'gdrive'); missing = 'r2'. */
    provider?(): string;
    realpath(p: string): Promise<string>;
    now?(): number;
    log?: LogFn;
}

/** store_mismatch: the store was changed, but this workspace still has files that exist only on the old store (cleaned off the machine): not switched yet. */
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
    /** Reason a context cannot be built (shown to the user). */
    blocked: ContextBlock = null;
    /** For store_mismatch: the index's old store + the number of files that exist only there. */
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
            // Same path but the DB contents were replaced (a backup was restored) → different workspace id → rebuild
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
        try { this.onChange?.(null); } catch { /* ignore */ }
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
                // Switching workspace / storage folder: the DB has changed but the media folder has not yet (or the reverse) → wait.
                // Prolonged mismatch (odd configuration) → trust the current media folder.
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

            // From here up to the await: synchronous → same DB
            const index = new CloudMediaIndex(db);
            index.ensureSchema();
            index.resetUploading();
            let uid = index.getSetting(SETTING_WORKSPACE_UID);
            if (!uid || !/^[A-Za-z0-9_-]{6,64}$/.test(uid)) {
                uid = newWorkspaceUid();
                index.setSetting(SETTING_WORKSPACE_UID, uid);
            }
            // Store changed (R2 ↔ Google Drive) since the last sync → files already on the old store wait to be uploaded to the new store
            const provider = (d.provider ? d.provider() : 'r2') || 'r2';
            const indexedFor = index.getSetting(SETTING_MEDIA_PROVIDER) || 'r2';
            if (indexedFor !== provider) {
                const evicted = index.countEvicted();
                if (evicted > 0) {
                    // Store changed while files still exist only on the old store (e.g. another workspace at the time of the change): not switched yet, otherwise the files would be lost
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
            try { realRoot = path.resolve(await d.realpath(root)); } catch { /* keep root */ }
            // While waiting for realpath, the workspace may have changed → the next pass rebuilds it
            if (d.activeDbPath() !== dbPath || !samePath(d.mediaRoot(), root)) return null;

            const ctx: MediaContext = { id: ++this.seq, dbPath, mediaRoot: root, realRoot, workspaceUid: uid, bucket, index, provider };
            this.ctx = ctx;
            this.uidCheckedAt = this.now();
            this.blocked = null;
            this.mismatch = null;
            try { this.onChange?.(ctx); } catch { /* ignore */ }
            return ctx;
        } catch (err) {
            log('warn', `[CloudMedia] Chưa mở được chỉ mục media: ${(err as Error)?.message || err}`);
            this.blocked = 'no_db';
            return null;
        }
    }
}
