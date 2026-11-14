/**
 * cloudContracts: shared contracts for the "Internet & Cloud" feature (Cloudflare: fixed tunnel, R2 media, DB sync). Used by both main (src/services/cloudflare/**, electron/ipc/cloud/cloudflareIpc.ts) and the renderer
 * (src/ui/components/settings/cloud/**). Design: Claude Doc "Deplao × Cloudflare" (main tab + UI tab).
 *
 * Rules:
 *  - The Cloudflare token and the backup password NEVER go through IPC to the renderer; the renderer only sees the status.
 *  - All operations go through the `cloudflare:*` IPC (one logic path), with permission checks in main before the service is called.
 *  - Everything is off by default; when it is off, the app runs as before.
 */

// ─── Connection ─────────────────────────────────────────────────────────────────

/**
 * 'workers' = Worker + D1 for apps (plugin permission cloudflare:workers). NOT required: a missing permission is not treated as an error of the connection (no red dot, not stored in lastError). The UI only shows the line "Worker, D1 (cho ứng dụng)" (Worker, D1 for apps).
 */
export type CloudFeature = 'tunnel' | 'r2' | 'workers';

export interface CloudPermissionCheck {
    feature: CloudFeature;
    ok: boolean;
    /** Reason when missing, written for the user (e.g. "Thiếu quyền Cloudflare Tunnel: Edit" (missing the Cloudflare Tunnel: Edit permission)). */
    missing?: string[];
    /** R2 is not enabled on the account (error 10042). */
    r2NotEnabled?: boolean;
}

export interface CloudZone {
    id: string;
    name: string;
    status: string;
}

export interface CloudConnectionStatus {
    connected: boolean;
    accountId: string | null;
    /** Display name of the account (taken from zone.account.name if available). */
    accountName: string | null;
    tokenKind: 'account' | 'user' | null;
    /** Token expiry date (ISO), if any. */
    tokenExpiresOn: string | null;
    zones: CloudZone[];
    permissions: CloudPermissionCheck[];
    /** Last check time (ms). */
    checkedAt: number | null;
    lastError: string | null;
}

export interface CloudConnectInput {
    accountId: string;
    token: string;
}

// ─── Internet address (tunnel) ───────────────────────────────────────────────

/** How the address is created. 'quick' = Quick Tunnel (temporary), 'cloudflare_manual' = paste a self-made token (as today). */
export type TunnelMode = 'quick' | 'ngrok' | 'cloudflare_auto' | 'cloudflare_manual';

/** Three services have an Internet address. relay = port 9900 (employees + API v1 + Socket.IO/SSE). */
export type TunnelServiceId = 'relay' | 'payments' | 'workflow';

/** 'single' = one domain for all services, split by path (default); 'split' = one name per service. */
export type AddressLayout = 'single' | 'split';

export interface TunnelAutoConfig {
    zoneId: string;
    zoneName: string;
    /** Name prefix, e.g. "shop" → shop.tenmien.vn (+ shop-pay, shop-hook when split). Only a-z, 0-9, '-'. */
    hostPrefix: string;
    layout: AddressLayout;
}

export interface PublicAddress {
    service: TunnelServiceId;
    /**
     * The BASE address (without the path) that the existing code appends paths to itself, exactly like tunnelUrl today:
     * relay → `${url}/api/v1`, payments → `${url}/webhook/<type>`, workflow → `${url}/api/workflow/webhook/<token>`.
     * 'single' layout: all three are https://shop.tenmien.vn. 'split' layout: https://shop-pay… / https://shop-hook….
     */
    url: string | null;
    kind: 'fixed' | 'temporary' | null;
    state: 'active' | 'starting' | 'restarting' | 'stopped' | 'error';
    enabled: boolean;
    mode: TunnelMode;
    error?: string | null;
}

export interface TunnelHealth {
    tunnelId: string | null;
    tunnelName: string | null;
    /** Cloudflare-side status: healthy | degraded | down | inactive (read at most once every 10 minutes). */
    cfStatus: string | null;
    /** /ready of cloudflared on this machine. */
    localReady: boolean;
    connections: number;
    /** Another machine's connector is using the same token. */
    foreignConnectors: number;
    cloudflaredVersion: string | null;
    checkedAt: number | null;
}

export interface TunnelConfigView {
    mode: TunnelMode;
    auto: TunnelAutoConfig | null;
    autoStart: boolean;
    /** Expected hostname for the current config (to preview while typing). */
    preview: Record<TunnelServiceId, string>;
}

// ─── Data scope (shared by media storage and DB sync) ────────────────────────

/**
 * What to store / sync: which accounts and from which date. Default: all accounts, all of the time.
 * - accounts: 'all' = every account (including accounts added later); array = only these accounts (accounts.zalo_id, the shared id of all channels:
 *   Zalo uid, Facebook uid, Telegram id).
 * - fromTs: only data from this time (ms, usually 00:00 machine time of the chosen day); null = all of it.
 *   Media: by file time. DB: applies only to the message history tables (messages, pins, links, send log…);
 *   contacts / groups / settings of the chosen accounts are always synced in full.
 */
export interface CloudScope {
    accounts: 'all' | string[];
    fromTs: number | null;
}

export const ALL_SCOPE: CloudScope = { accounts: 'all', fromTs: null };

/** Normalize the scope from settings / IPC (wrong type → default). Drops empty / duplicate ids; at most 500 accounts. */
export function normalizeScope(value: unknown): CloudScope {
    const v = (value && typeof value === 'object' ? value : {}) as { accounts?: unknown; fromTs?: unknown };
    let accounts: CloudScope['accounts'] = 'all';
    if (Array.isArray(v.accounts)) {
        const ids = v.accounts.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 200)
            .map(id => id.trim());
        accounts = Array.from(new Set(ids)).slice(0, 500);
    }
    const fromTs = typeof v.fromTs === 'number' && Number.isFinite(v.fromTs) && v.fromTs > 0 ? Math.floor(v.fromTs) : null;
    return { accounts, fromTs };
}

export function scopeIncludesAccount(scope: CloudScope, accountId: string | null | undefined): boolean {
    if (scope.accounts === 'all') return true;
    return !!accountId && scope.accounts.includes(accountId);
}

export function isAllScope(scope: CloudScope): boolean {
    return scope.accounts === 'all' && scope.fromTs === null;
}

export function sameScope(a: CloudScope, b: CloudScope): boolean {
    if (a.fromTs !== b.fromTs) return false;
    if (a.accounts === 'all' || b.accounts === 'all') return a.accounts === b.accounts;
    if (a.accounts.length !== b.accounts.length) return false;
    const set = new Set(a.accounts);
    return b.accounts.every(id => set.has(id));
}

// ─── R2 media ────────────────────────────────────────────────────────────────

export interface MediaSyncOptions {
    concurrency: number;            // 1..16, default 3 (the real limit is the machine's upload bandwidth)
    nightOnly: boolean;             // only runs 22:00-07:00
    bandwidthKbps: number;          // 0 = no limit
    /**
     * After a file has been uploaded to R2: false = keep the file on the machine (default: many customers do not want files deleted);
     * true = delete the local copy of old files (they can still be opened, and are downloaded again when needed).
     */
    evictEnabled: boolean;
    evictKeepDays: number;          // only delete files not opened in N days (default 30)
    evictMinFreeGb: number;         // clean up until at least N GB of disk is free (default 20)
    /** Scope (accounts + from date). Missing = all. Changing the scope only affects files not yet uploaded; files already on R2 are kept. */
    scope?: CloudScope;
    /** Files that belong to no account (media library, tasks, shared uploads, avatars). Missing = true. */
    includeShared?: boolean;
}

// ─── Clean up files on R2 (only when the user starts it; deleting in the app does NOT delete on R2) ──────────

/**
 * Choose the files to clean up on R2 (OR across the enabled criteria). Only touches the media of the open workspace.
 * By default it does NOT delete files that exist only on R2 (already cleaned off the machine), because deleting them is permanent, and it does NOT delete files on the machine.
 */
export interface R2CleanupRequest {
    /** Files of messages deleted in the app: no message / pin / library item … points to them any more (only checks the account's media files). */
    orphans?: boolean;
    /** All files of these accounts (e.g. accounts removed from the app). */
    accounts?: string[];
    /** Files older than this time (ms). */
    olderThanTs?: number | null;
    /** Files outside the current media storage scope (account not selected, before the date mark, shared files when off). */
    outOfScope?: boolean;
    /** Allow deleting files that exist only on R2 too (already cleaned off the machine). Default false. */
    includeCloudOnly?: boolean;
    /** For files of deleted messages: also delete the local copy (junk). Default false. */
    deleteLocalOrphans?: boolean;
}

export interface R2CleanupPreview {
    /** Used to run exactly the list that was previewed (expires after 15 minutes). */
    previewId: string;
    scannedAt: number;
    files: number;
    bytes: number;
    /** Of the above: files that exist only on R2 (already cleaned off the machine). Only present with includeCloudOnly. */
    cloudOnlyFiles: number;
    cloudOnlyBytes: number;
    /** Files that exist only on R2 and match the criteria, but are SKIPPED because they are not allowed yet (so the UI can remind the user). */
    skippedCloudOnly: number;
    /** Files on the machine that will be deleted along with them (deleteLocalOrphans). */
    localFiles: number;
    /** Number of files per criterion (one file can match several criteria). */
    byReason: { orphans: number; accounts: number; olderThan: number; outOfScope: number };
    /** A few example paths (relative to the media folder). */
    samples: string[];
}

export interface R2CleanupResult {
    deleted: number;
    bytes: number;
    failed: number;
    localDeleted: number;
}

export interface R2CleanupProgress {
    phase: 'scan' | 'delete' | 'done' | 'error';
    done: number;
    total: number;
    message?: string;
}

export interface MediaSyncStatus {
    enabled: boolean;
    bucket: string | null;
    running: boolean;
    paused: boolean;
    totals: { files: number; uploaded: number; pending: number; failed: number; evicted: number; bytesTotal: number; bytesUploaded: number };
    /** When it will retry while backing off because of 429/5xx. */
    backoffUntil: number | null;
    options: MediaSyncOptions;
    lastError: string | null;
}

// ─── DB sync ──────────────────────────────────────────────────────────────────

export type DbSyncMode = 'off' | 'hourly' | 'realtime';

export interface DbSyncWorkspaceStatus {
    workspaceId: string;
    name: string;
    lastSyncAt: number | null;
    lastChanges: number;
    baseAt: number | null;
    segments: number;
    bytes: number;
    state: 'idle' | 'syncing' | 'snapshotting' | 'paused' | 'error';
    lastError: string | null;
    /** Scope of this workspace only (accounts belong to each workspace, so the scope is stored per workspace). */
    scope?: CloudScope;
    /** Progress of the running base snapshot (null / missing = not running). */
    progress?: DbSyncProgress | null;
    /** A new base snapshot waiting for an idle machine: just woke up / on battery / someone is using it (null = not waiting). */
    baseWaiting?: 'wake' | 'battery' | 'active' | null;
    /** The copy ID on R2 for this workspace (same shape as RemoteDbCopy.workspaceId); null = none yet. */
    copyId?: string | null;
}

/**
 * Base snapshot progress: copy DB → filter by scope → compress → encrypt → upload to R2.
 * percent: the whole snapshot (estimated by weighting the steps); done/total: of the current step (bytes; 0/0 = cannot be measured).
 */
export interface DbSyncProgress {
    phase: 'copy' | 'filter' | 'compress' | 'encrypt' | 'upload';
    percent: number;
    done: number;
    total: number;
    startedAt: number;
    /** When the current step started. */
    phaseStartedAt: number;
    /** Recent upload speed (bytes/s), upload step only. */
    rate?: number | null;
    /** Most recent retry during upload (slow network / R2 busy). */
    retry?: { part: number | null; attempt: number; maxAttempts: number; error: string; at: number } | null;
}

export interface DbSyncStatus {
    mode: DbSyncMode;
    passphraseSet: boolean;
    bucket: string | null;
    /** Sync scope (accounts + from date). Changing the scope → creates a new base snapshot for the new scope. */
    scope: CloudScope;
    workspaces: DbSyncWorkspaceStatus[];
    /** The machine that is following the copy (read from the manifest on R2). */
    followers: Array<{ machine: string; lagMs: number | null; seenAt: number }>;
    /** This machine is in standby mode (following another machine's copy). */
    following: { workspaceId: string; sourceMachine: string; lagMs: number | null } | null;
}

export interface SyncLogEntry {
    id: number;
    workspaceId: string;
    at: number;            // start
    endAt: number | null;  // realtime: rows merged per hour
    kind: 'base' | 'segment' | 'segments-hour' | 'restore' | 'follow';
    pushes: number;        // number of pushes (segments-hour)
    rows: number;
    bytes: number;
    durationMs: number;
    result: 'ok' | 'retried' | 'error';
    error?: string | null;
}

export interface RemoteDbCopy {
    workspaceId: string;
    name: string;
    machine: string;
    appVersion: string;
    schemaFingerprint: string;
    lastSyncAt: number;
    baseAt: number;
    bytes: number;
    /** Scope of the copy (old copies that did not record it = all). */
    scope?: CloudScope;
    /** Names of the accounts in the copy (shown when choosing a restore point), if the manifest records them. */
    accountNames?: Array<{ id: string; name: string; channel: string }>;
}

export interface RestoreRequest {
    workspaceId: string;
    /** Required when this machine has not saved the password yet (new machine / standby machine). */
    passphrase?: string;
    /** Stop at this time (within the range from the latest base snapshot); leave empty = latest. */
    untilTs?: number;
}

export interface RestoreProgress {
    step: 'download' | 'decrypt' | 'apply' | 'verify' | 'swap' | 'done' | 'error';
    percent: number;
    message?: string;
}

// ─── Data sync: ONE shared setting for the data (DB) + images/files (media) ──────────────

/**
 * The user only picks: accounts, from date, mode, and whether to include images/files. It applies to the data and the images/files of the open
 * workspace at the same time. Main calls the matching functions of the DB / media modules (scope first, then turn media on, and the DB mode last).
 */
export interface SyncConfig {
    /** Off / Hourly / Realtime: the data push rhythm (DB). Images & files run continuously when sync is on and images are included. */
    mode: DbSyncMode;
    /** Accounts + from date: applied to BOTH data and images/files. */
    scope: CloudScope;
    /** Include images, videos, files (default on). */
    includeMedia: boolean;
    /** Include shared files that belong to no account (media library, tasks, uploads). Default on. */
    includeShared: boolean;
}

export interface SyncOverview {
    config: SyncConfig;
    db: DbSyncStatus;
    media: MediaSyncStatus;
}

// ─── Storage: Cloudflare R2 or Google Drive (Google One) ─────────────────────

/**
 * Where images/files and the data copies are stored (data sync). ONE storage is used at a time. The Internet address (tunnel) is always
 * Cloudflare, regardless of the storage. 'gdrive' = the Google Drive of the Google account (capacity depends on the Google One plan).
 */
export type CloudStorageProvider = 'r2' | 'gdrive';

export const CLOUD_STORAGE_PROVIDERS: ReadonlyArray<CloudStorageProvider> = ['r2', 'gdrive'];

export function isCloudStorageProvider(v: unknown): v is CloudStorageProvider {
    return v === 'r2' || v === 'gdrive';
}

/** Storage name shown in sentences ("lên R2" (to R2), "lên Google Drive" (to Google Drive)). */
export function storageLabel(provider: CloudStorageProvider | null | undefined): string {
    return provider === 'gdrive' ? 'Google Drive' : 'R2';
}

/** Google account storage (Drive API about.storageQuota), shared by Gmail, Drive and Photos. */
export interface GoogleDriveQuota {
    /** Total capacity (bytes); null = unlimited (some Workspace accounts). */
    limit: number | null;
    /** Used across the whole account (Gmail + Drive + Photos). */
    usage: number;
    usageInDrive: number;
    usageInDriveTrash: number;
}

export interface GoogleDriveStatus {
    connected: boolean;
    email: string | null;
    displayName: string | null;
    /** Using an OAuth client the user created (their own Google Cloud quota). */
    customClient: boolean;
    /** The app build has Deplao's shared OAuth client (if not, a separate client must be entered). */
    builtinClient: boolean;
    /** client_id in use (not a secret), to show / edit. */
    clientId: string | null;
    quota: GoogleDriveQuota | null;
    /** Last storage read (ms). */
    checkedAt: number | null;
    lastError: string | null;
    /** Waiting for the user to sign in in the browser. */
    connecting: boolean;
}

export interface CloudStorageStatus {
    provider: CloudStorageProvider;
    /** The selected storage can be used right away (R2: Cloudflare connected + enough R2 permissions; Google: signed in). */
    ready: boolean;
    /** Reason it cannot be used yet (a sentence for the user); null when ready. */
    notReadyReason: string | null;
    google: GoogleDriveStatus;
}

/** OAuth client "Desktop app" that the user creates on Google Cloud (Drive API + drive.file permission). */
export interface GoogleClientInput {
    clientId: string;
    /** The Google Desktop client may be left empty (PKCE); if present, it is sent along. */
    clientSecret?: string | null;
}

// ─── Usage & cost (Settings → Data sync) ───────────────────────

/**
 * Price table used for estimates (USD). R2: developers.cloudflare.com/r2/pricing (Standard storage, read 10/2026).
 * Google Drive API: free under the quota. Google has announced that usage above its daily threshold will be charged from late 2026 (no price yet), so
 * only the % of the threshold is shown, with no cost estimate.
 */
export const R2_PRICING = Object.freeze({
    freeStorageGbMonth: 10,
    freeClassA: 1_000_000,
    freeClassB: 10_000_000,
    storageUsdPerGbMonth: 0.015,
    classAUsdPerMillion: 4.5,
    classBUsdPerMillion: 0.36,
});

/** Drive API quota (developers.google.com/workspace/drive/api/guides/limits, applies from 1/5/2026). */
export const GDRIVE_LIMITS = Object.freeze({
    unitsPerMinutePerProject: 1_000_000,
    unitsPerMinutePerUser: 325_000,
    /** Daily charging threshold for the whole project (OAuth client). */
    unitsPerDayPerProject: 400_000_000,
    /** Downloads per day for the whole project before charging. */
    egressBytesPerDayPerProject: 1024 ** 4,
    /** Uploads per day for one account. */
    uploadBytesPerDayPerUser: 750 * 1024 ** 3,
    unitsRead: 5,
    unitsList: 100,
    unitsDownload: 200,
    unitsEdit: 50,
    unitsOther: 5,
});

export type CloudUsageMeterId =
    /** R2: average monthly storage (GB-month), 10 free. */
    | 'r2Storage'
    /** R2: write operations (Class A) per month, 1 million free. */
    | 'r2ClassA'
    /** R2: read operations (Class B) per month, 10 million free. */
    | 'r2ClassB'
    /** R2: bytes downloaded in the month (free, for information only). */
    | 'r2Egress'
    /** Google: used / total storage of the Google account. */
    | 'gdriveStorage'
    /** Google: Drive API quota units today (day in Pacific time), threshold 400 million / project. */
    | 'gdriveUnitsDay'
    /** Google: bytes downloaded today, threshold 1 TB / project. */
    | 'gdriveEgressDay'
    /** Google: bytes uploaded today, limit 750 GB / account. */
    | 'gdriveUploadDay';

export interface CloudUsageMeter {
    id: CloudUsageMeterId;
    /** Unit of used / limit / projected: 'bytes' | 'gbMonth' | 'ops' | 'units'. */
    unit: 'bytes' | 'gbMonth' | 'ops' | 'units';
    used: number;
    /** Free part / threshold (same unit); null = unlimited / unknown. */
    limit: number | null;
    /** Projected end-of-period (month for R2, day for Google) at the current rate; null = not calculated. */
    projected: number | null;
    /** Estimated cost of this item alone (USD): up to now / the whole period. */
    costSoFar: number;
    costProjected: number;
    /** 'account' = whole-account figures; 'local' = Deplao on this machine only. */
    source: 'account' | 'local';
}

export interface CloudUsageReport {
    provider: CloudStorageProvider;
    generatedAt: number;
    /** Billing period / quota: R2 = calendar month (UTC); Google = day in Pacific time. */
    period: { kind: 'month' | 'day'; startTs: number; endTs: number };
    /** Whether whole-account figures are available (R2: Cloudflare Analytics; Google: account storage). */
    accountData: boolean;
    /** Why whole-account figures are missing (e.g. the token lacks the Account Analytics: Read permission), null when complete. */
    accountNote: string | null;
    meters: CloudUsageMeter[];
    /** Total estimated cost (USD) for the period: up to now and the whole period. Google: always 0 (below the threshold nothing is charged). */
    cost: { soFar: number; projected: number };
    /** Google: using Deplao's shared client (the project threshold is shared by all Deplao users). */
    sharedProject?: boolean;
}

// ─── IPC (the renderer sees it through window.electronAPI.cloudflare) ──────────────

export type CloudResult<T = {}> = Promise<{ success: boolean; error?: string; code?: string } & Partial<T>>;

export interface CloudflareIpc {
    status: () => CloudResult<{ connection: CloudConnectionStatus }>;
    connect: (input: CloudConnectInput) => CloudResult<{ connection: CloudConnectionStatus }>;
    disconnect: () => CloudResult;
    recheck: () => CloudResult<{ connection: CloudConnectionStatus }>;
    /** Cloudflare link with the permissions pre-filled to create a token. */
    tokenTemplateUrl: () => CloudResult<{ url: string }>;

    tunnel: {
        getConfig: () => CloudResult<{ config: TunnelConfigView }>;
        setMode: (mode: TunnelMode) => CloudResult<{ config: TunnelConfigView }>;
        configureAuto: (input: TunnelAutoConfig) => CloudResult<{ config: TunnelConfigView; addresses: PublicAddress[] }>;
        setAutoStart: (on: boolean) => CloudResult;
        setServiceEnabled: (service: TunnelServiceId, enabled: boolean) => CloudResult<{ addresses: PublicAddress[] }>;
        addresses: () => CloudResult<{ addresses: PublicAddress[] }>;
        /** refresh = read again from Cloudflare right away (the "Kiểm tra lại" (check again) button, spaced ≥ 30 s); by default uses the cached copy if it is ≤ 10 minutes old. */
        health: (opts?: { refresh?: boolean }) => CloudResult<{ health: TunnelHealth }>;
        /** Point the fixed address to this machine (create a new tunnel, fix DNS). */
        moveHere: () => CloudResult<{ addresses: PublicAddress[] }>;
        disconnectForeign: () => CloudResult;
        teardown: () => CloudResult;
    };

    media: {
        status: () => CloudResult<{ status: MediaSyncStatus }>;
        setEnabled: (on: boolean) => CloudResult<{ status: MediaSyncStatus }>;
        pause: () => CloudResult;
        resume: () => CloudResult;
        setOptions: (opts: Partial<MediaSyncOptions>) => CloudResult<{ status: MediaSyncStatus }>;
        /** Re-download all cleaned-up files to the machine. */
        rehydrateAll: () => CloudResult;
        /** R2 cleanup step 1: scan and count (deletes nothing). Progress through CLOUD_CLEANUP_PROGRESS_EVENT. */
        cleanupPreview: (req: R2CleanupRequest) => CloudResult<{ preview: R2CleanupPreview }>;
        /** R2 cleanup step 2: delete exactly the list of previewId (the user has reviewed and confirmed it). */
        cleanupRun: (previewId: string) => CloudResult<{ result: R2CleanupResult }>;
    };

    /** Storage (R2 / Google Drive): choose the storage, and the status of the selected storage. */
    storage: {
        status: () => CloudResult<{ storage: CloudStorageStatus }>;
        /**
         * Switch storage. Refused (code STORAGE_SWITCH_BLOCKED) when sync is on, the machine is acting as standby, or files still exist only on the old storage
         * (cleaned off the machine): download them to the machine first.
         */
        setProvider: (provider: CloudStorageProvider) => CloudResult<{ storage: CloudStorageStatus }>;
    };

    /** Google Drive (Google One): sign in to Google in the machine's browser (OAuth, drive.file permission). */
    google: {
        /**
         * Opens the Google sign-in in the browser. Returns when the user agrees (up to 5 minutes) or cancels.
         * client: the user's own OAuth client; leave empty = Deplao's shared client (if the app build includes one).
         */
        connect: (client?: GoogleClientInput | null) => CloudResult<{ storage: CloudStorageStatus }>;
        cancelConnect: () => CloudResult;
        /** Revoke the permission and delete the token on the machine. Files already on Google Drive are kept. */
        disconnect: () => CloudResult<{ storage: CloudStorageStatus }>;
        /** Re-read the Google account storage. */
        refresh: () => CloudResult<{ storage: CloudStorageStatus }>;
    };

    /** Usage & cost of the selected storage. */
    usage: {
        /** refresh = re-read the whole-account figures right away (spaced ≥ 60 s); by default uses the cached copy if it is ≤ 10 minutes old. */
        get: (opts?: { refresh?: boolean }) => CloudResult<{ report: CloudUsageReport }>;
    };

    /** Data sync: one shared setting (the main screen uses this; db.* / media.* are for advanced settings). */
    sync: {
        get: () => CloudResult<{ overview: SyncOverview }>;
        /**
         * Save in one go. Turning sync on for the first time needs a backup password (call db.setPassphrase first; missing → code PASSPHRASE_REQUIRED).
         * rebase = a copy already exists on R2 and the scope changed → a new base snapshot will be created for the new scope.
         */
        apply: (config: SyncConfig) => CloudResult<{ overview: SyncOverview; rebase: boolean }>;
    };

    db: {
        status: () => CloudResult<{ status: DbSyncStatus }>;
        setMode: (mode: DbSyncMode) => CloudResult<{ status: DbSyncStatus }>;
        /** Set / change the backup password (required before turning sync on). Stored encrypted with safeStorage on the machine. */
        setPassphrase: (passphrase: string) => CloudResult;
        syncNow: () => CloudResult;
        log: (opts?: { workspaceId?: string; limit?: number }) => CloudResult<{ entries: SyncLogEntry[] }>;
        listRemote: () => CloudResult<{ copies: RemoteDbCopy[] }>;
        /**
         * Permanently delete one DB copy on R2 (a workspace / old machine that is no longer used). If it is the copy of the workspace that is syncing on this
         * machine, main refuses (turn sync off first).
         */
        deleteRemote: (workspaceId: string) => CloudResult;
        restore: (req: RestoreRequest) => CloudResult<{ restoredWorkspaceId: string }>;
        /** Change the sync scope (accounts + from date). A different scope → creates a new base snapshot, and the old copy on R2 is replaced. */
        setScope: (scope: CloudScope) => CloudResult<{ status: DbSyncStatus }>;
        /** Turn standby mode on / off for another machine's workspace. */
        follow: (req: { workspaceId: string; on: boolean; passphrase?: string }) => CloudResult<{ status: DbSyncStatus }>;
        /**
         * After a restore: is the open workspace paused for automations, and are there channels that must sign in again
         * (app_settings flags 'cloud_restore_paused_automations' / 'cloud_restore_pending_relogin').
         */
        restoreState: () => CloudResult<{ pausedAutomations: boolean; pendingRelogin: boolean }>;
        /** Step 6 of the restore wizard: the user confirms the old machine is off → turn the campaigns, workflows and app schedules back on. */
        resumeAutomations: () => CloudResult;
    };
}

/** Channel pushed from main → renderer when the status changes (payload: { area }). */
export const CLOUD_CHANGED_EVENT = 'cloudflare:changed';
export type CloudChangedPayload = { area: 'connection' | 'tunnel' | 'media' | 'db'; at: number };
export const CLOUD_RESTORE_PROGRESS_EVENT = 'cloudflare:restoreProgress';
/** R2 file cleanup progress (payload: R2CleanupProgress). */
export const CLOUD_CLEANUP_PROGRESS_EVENT = 'cloudflare:cleanupProgress';

/** Path prefix for the 'single' layout (cloudflared passes the full path through to the origin server). */
export const SINGLE_HOST_PATH_RULES: ReadonlyArray<{ service: TunnelServiceId; path: string | null; port: number }> = [
    { service: 'payments', path: '^/webhook/', port: 9888 },
    { service: 'workflow', path: '^/api/workflow/webhook/', port: 9889 },
    { service: 'relay', path: null, port: 9900 },
];

/** Host name for the 'split' layout. */
export function splitHostname(prefix: string, service: TunnelServiceId, zoneName: string): string {
    const suffix = service === 'relay' ? '' : service === 'payments' ? '-pay' : '-hook';
    return `${prefix}${suffix}.${zoneName}`;
}
