/**
 * state: local state of the DB sync on this machine: userData/cloud-dbsync-state.json.
 * Contains no secrets (the tracking password, if any, is encrypted with safeStorage before it is written). Writes are batched and atomic (tmp + rename).
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
    /** Highest _cloud_dirty id confirmed so far. A DB whose AUTOINCREMENT is lower means the file is older than the chain already pushed. */
    lastAckedId: number;
    manifest: DbManifest | null;
    lastSyncAt: number | null;
    lastChanges: number;
    lastError: string | null;
    /** Triggers are installed on this DB (so they can be removed when sync is turned off, if the last cleanup was left unfinished). */
    trackingInstalled: boolean;
    /** Store that holds the remembered manifest / base snapshot (missing = 'r2', since old versions only had R2). Changing the store → take a new base snapshot on the new store. */
    provider?: CloudStorageProvider;
    /** When a base snapshot must start but is still waiting for the machine to be idle (0 / missing = do not wait). The maximum wait is counted across app launches. */
    baseDueSince?: number;
    /** Required base snapshot currently deferred until the machine is idle (e.g. 'tracking': the next cycle shows no sign of change, so it must be remembered). */
    pendingBase?: string | null;
}

export interface FollowState {
    copyId: string;
    bucket: string;
    workspaceUid: string;
    sourceMachine: string;
    baseKey: string | null;
    /** Number of segments (in manifest order) already applied to the tracked copy. */
    appliedCount: number;
    lastAppliedKey: string | null;
    /** Time (at) of the latest applied segment / base snapshot. */
    appliedUpTo: number | null;
    lastCheckAt: number | null;
    lastHeartbeatAt: number | null;
    lagMs: number | null;
    /** at of the first segment not yet applied (null = caught up with the manifest at the last check). */
    pendingSince: number | null;
    /** Increasing negative ids for 'follow' log rows (they do not collide with log ids in the DB). */
    logSeq: number;
    /** Tracking password encrypted with safeStorage (base64) when it differs from this machine's sync password. */
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
        } catch { /* missing / corrupt → recreate */ }
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

    /** Batched write (500 ms). */
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
        } catch { /* retry on the next write */ }
    }
}
