/**
 * state — trạng thái cục bộ của đồng bộ DB trên máy này: userData/cloud-dbsync-state.json.
 * Không chứa bí mật (mật khẩu theo dõi nếu có được mã hoá safeStorage trước khi ghi). Ghi gộp + atomic (tmp + rename).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CloudStorageProvider, SyncLogEntry } from '../../../shared/cloud/cloudContracts';
import type { DbManifest } from './Manifest';

export interface WorkspaceSyncState {
    workspaceUid: string | null;
    dbPath: string | null;
    dbUid: string | null;
    fingerprint: string | null;
    /** Mốc id _cloud_dirty đã xác nhận cao nhất — DB có AUTOINCREMENT thấp hơn = file cũ hơn chuỗi đã đẩy. */
    lastAckedId: number;
    manifest: DbManifest | null;
    lastSyncAt: number | null;
    lastChanges: number;
    lastError: string | null;
    /** Đã cài trigger trên DB này (để dọn khi tắt đồng bộ mà lần trước dọn dở). */
    trackingInstalled: boolean;
    /** Kho chứa manifest / bản gốc đang nhớ (thiếu = 'r2' — bản cũ chỉ có R2). Đổi kho → chụp gốc mới trên kho mới. */
    provider?: CloudStorageProvider;
}

export interface FollowState {
    copyId: string;
    bucket: string;
    workspaceUid: string;
    sourceMachine: string;
    baseKey: string | null;
    /** Số đoạn (theo thứ tự trong manifest) đã áp lên bản sao theo dõi. */
    appliedCount: number;
    lastAppliedKey: string | null;
    /** Thời điểm (at) của đoạn/bản gốc mới nhất đã áp. */
    appliedUpTo: number | null;
    lastCheckAt: number | null;
    lastHeartbeatAt: number | null;
    lagMs: number | null;
    /** at của đoạn đầu tiên chưa áp (null = đã theo kịp manifest lúc kiểm tra gần nhất). */
    pendingSince: number | null;
    /** Id âm tăng dần cho dòng nhật ký 'follow' (không trùng id nhật ký trong DB). */
    logSeq: number;
    /** Mật khẩu theo dõi mã hoá safeStorage (base64) khi khác mật khẩu đồng bộ của máy này. */
    passEnc: string | null;
    lastError: string | null;
    log: SyncLogEntry[];
}

export interface DbSyncStateFile {
    version: number;
    workspaces: Record<string, WorkspaceSyncState>;
    follow: FollowState | null;
}

export function emptyWorkspaceState(): WorkspaceSyncState {
    return {
        workspaceUid: null,
        dbPath: null,
        dbUid: null,
        fingerprint: null,
        lastAckedId: 0,
        manifest: null,
        lastSyncAt: null,
        lastChanges: 0,
        lastError: null,
        trackingInstalled: false,
    };
}

export class StateStore {
    private data: DbSyncStateFile | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly filePath: () => string) {}

    private load(): DbSyncStateFile {
        if (this.data) return this.data;
        let parsed: any = null;
        try {
            parsed = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
        } catch { /* chưa có / hỏng → làm lại */ }
        const ws: Record<string, WorkspaceSyncState> = {};
        if (parsed && parsed.workspaces && typeof parsed.workspaces === 'object') {
            for (const [id, v] of Object.entries<any>(parsed.workspaces)) ws[id] = { ...emptyWorkspaceState(), ...(v || {}) };
        }
        this.data = { version: 1, workspaces: ws, follow: parsed?.follow && typeof parsed.follow === 'object' ? parsed.follow : null };
        return this.data;
    }

    workspace(id: string): WorkspaceSyncState {
        const d = this.load();
        if (!d.workspaces[id]) d.workspaces[id] = emptyWorkspaceState();
        return d.workspaces[id];
    }

    hasWorkspace(id: string): boolean {
        return !!this.load().workspaces[id];
    }

    workspaceIds(): string[] {
        return Object.keys(this.load().workspaces);
    }

    removeWorkspace(id: string): void {
        delete this.load().workspaces[id];
        this.save();
    }

    follow(): FollowState | null {
        return this.load().follow;
    }

    setFollow(f: FollowState | null): void {
        this.load().follow = f;
        this.save();
    }

    /** Ghi gộp (500 ms). */
    save(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, 500);
        (this.timer as any)?.unref?.();
    }

    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.data) return;
        const file = this.filePath();
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
            fs.renameSync(tmp, file);
        } catch { /* lần ghi sau thử lại */ }
    }
}
