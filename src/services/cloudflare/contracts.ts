/**
 * Main-process contract between the Cloudflare modules (so several people/agents can work in parallel).
 *
 *   core     (CloudflareApi, CloudflareService, R2Client, cloudCrypto, cloudSettings): shared
 *   tunnel   src/services/cloudflare/tunnel/index.ts   → export const cloudTunnel: CloudTunnelModule
 *   media    src/services/cloudflare/media/index.ts    → export const cloudMedia: CloudMediaModule
 *   dbsync   src/services/cloudflare/dbsync/index.ts   → export const cloudDb: CloudDbModule
 *   ipc      electron/ipc/cloud/cloudflareIpc.ts             → registerCloudflareIpc(): calls the 3 modules above + core
 *
 * Shared types with the renderer live in src/shared/cloud/cloudContracts.ts.
 * Error convention: modules throw CloudError (code + a user-facing message in Vietnamese); IPC wraps it as { success:false }.
 */
import type {
    CloudConnectionStatus, CloudConnectInput, CloudScope, CloudStorageProvider, CloudStorageStatus, CloudUsageReport, CloudZone,
    DbSyncMode, DbSyncStatus, GoogleClientInput, GoogleDriveStatus, MediaSyncOptions, MediaSyncStatus, PublicAddress,
    R2CleanupPreview, R2CleanupProgress, R2CleanupRequest, R2CleanupResult, RemoteDbCopy,
    RestoreProgress, RestoreRequest, SyncLogEntry, TunnelAutoConfig, TunnelConfigView, TunnelHealth,
    TunnelMode, TunnelServiceId,
} from '../../shared/cloud/cloudContracts';

export class CloudError extends Error {
    constructor(public code: string, message: string, public status?: number, public retryAfterMs?: number) {
        super(message);
        this.name = 'CloudError';
    }
}

// ─── core: REST API Cloudflare ──────────────────────────────────────────────

export interface CfRequestOptions {
    /** Query string (undefined values are dropped). */
    query?: Record<string, string | number | boolean | undefined>;
    /** Extra headers (e.g. cf-r2-jurisdiction). */
    headers?: Record<string, string>;
    /** Default 20_000 ms. */
    timeoutMs?: number;
    /** Not counted against the budget (only used to verify the token when connecting). */
    unbudgeted?: boolean;
    /**
     * The body is a Buffer / prebuilt string, sent as is with this Content-Type instead of JSON (multipart Worker script upload,
     * workers/WorkersDeployer). Missing = the body is sent as JSON, as before.
     */
    contentType?: string;
}

/**
 * REST v4 client (https://api.cloudflare.com/client/v4). The Bearer token comes from cloudSettings.
 * - Budget: at most 100 requests / 5 minutes for the WHOLE app (token bucket). When the budget is used up → wait until one is free, never exceed it.
 * - 429 → CloudError('RATE_LIMITED', …, retryAfterMs); 5xx → retry at most 2 times (backoff 1s, 3s); other 4xx → CloudError.
 * - Logs: never print the token.
 * Returns the `result` of the envelope {success, errors, result, result_info}.
 */
export interface CloudflareApi {
    request<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts?: CfRequestOptions): Promise<T>;
    /** Collect all pages (page/per_page or cursor), used for small lists (zones, tunnels). */
    requestAll<T = any>(path: string, opts?: CfRequestOptions & { perPage?: number; maxPages?: number }): Promise<T[]>;
    /** Requests left in the 5-minute window (for the UI / tests). */
    budgetRemaining(): number;
    /**
     * GraphQL Analytics (POST /graphql): counted against the budget like REST. HTTP errors throw CloudError like request();
     * GraphQL errors (HTTP 200) are returned in errors (e.g. a token missing the Account Analytics: Read permission).
     */
    graphql<T = any>(query: string, variables?: Record<string, unknown>, opts?: CfRequestOptions): Promise<{ data: T | null; errors: Array<{ message: string; [k: string]: unknown }> }>;
}

// ─── core: R2 (S3 API, self-written SigV4 signing, no AWS SDK) ────────────────

export interface R2ObjectInfo { key: string; size: number; etag: string; lastModified: number }

export interface R2PutOptions {
    contentType?: string;
    /** 'If-None-Match: *' → only write when the object does not exist yet. */
    ifNoneMatch?: '*';
    /** x-amz-meta-* metadata (≤ 8 KB in total). */
    metadata?: Record<string, string>;
}

/**
 * S3 client for ONE R2 bucket. Endpoint https://<accountId>.r2.cloudflarestorage.com, region 'auto', path-style.
 * The S3 keys are derived from the API token: accessKeyId = the token's id (tokens/verify), secretAccessKey = sha256(token) in hex.
 * putFile switches to multipart automatically when the file is > 64 MiB (16 MiB parts, equal sizes; each part is retried 3 times).
 * 429/5xx errors → CloudError('R2_BUSY', …, retryAfterMs) so the queue above backs off together.
 */
export interface R2Client {
    readonly bucket: string;
    putObject(key: string, body: Buffer | string, opts?: R2PutOptions): Promise<{ etag: string }>;
    putFile(key: string, filePath: string, opts?: R2PutOptions & {
        onProgress?: (sentBytes: number, totalBytes: number) => void;
        /** An upload part failed (network / R2 busy) and will be retried soon, so the UI can show "retrying". */
        onRetry?: (info: { part: number | null; attempt: number; maxAttempts: number; error: string }) => void;
    }): Promise<{ etag: string; size: number }>;
    getObject(key: string): Promise<Buffer | null>;
    /** Write to a temp file then rename (no half-written file is left). null when there is no object. */
    getObjectToFile(key: string, filePath: string): Promise<{ size: number; etag: string } | null>;
    headObject(key: string): Promise<R2ObjectInfo | null>;
    deleteObject(key: string): Promise<void>;
    /**
     * DeleteObjects (POST ?delete, ≤ 1000 keys per call): deletes many objects in one request. A missing object counts as already deleted.
     * Per-key errors are returned in errors; errors for the whole request (429/5xx/403…) throw CloudError like the other commands. Optional: if a fake
     * or an old client does not have it, use deleteObject for each key.
     */
    deleteObjects?(keys: string[]): Promise<{ deleted: string[]; errors: Array<{ key: string; code: string; message: string }> }>;
    /** ListObjectsV2, one page (≤ 1000). Avoid using it often: List is a Class A operation. */
    listObjects(prefix: string, opts?: { continuationToken?: string; maxKeys?: number }): Promise<{ objects: R2ObjectInfo[]; nextToken: string | null }>;
    /** Presigned URL (GET), valid for at most 900 seconds. */
    presignGet(key: string, expiresSec?: number): string;
}

// ─── core: on-machine encryption ──────────────────────────────────────────────────

/**
 * Encrypted file format "DPLC1": 64-byte header (magic 'DPLC1', version, 16-byte salt, scrypt N/r/p, chunkSize) +
 * AES-256-GCM blocks (each block: 12-byte nonce = 8 fixed random bytes + 4-byte block number, ciphertext, 16-byte tag),
 * the last block has a "final" flag in the AAD to prevent truncation. Key = scrypt(passphrase, salt, N=2^15, r=8, p=1, 32B).
 */
export interface CloudCrypto {
    /** Derive the key from the password; cached by salt in memory (never written to disk). */
    deriveKey(passphrase: string, salt: Buffer): Promise<Buffer>;
    encryptFile(srcPath: string, dstPath: string, passphrase: string): Promise<{ bytes: number }>;
    decryptFile(srcPath: string, dstPath: string, passphrase: string): Promise<{ bytes: number }>;
    encryptBuffer(plain: Buffer, passphrase: string): Promise<Buffer>;
    decryptBuffer(cipher: Buffer, passphrase: string): Promise<Buffer>;
    /** Check whether the password is correct for an encrypted file/buffer (decrypts the first block). */
    verifyPassphrase(cipherHead: Buffer, passphrase: string): Promise<boolean>;
}

// ─── core: machine settings (NOT in the DB → DB sync does not carry them up to R2) ─────

/**
 * The userData/cloud-settings.json file. Secret fields are encrypted with safeStorage (required; without safeStorage → error,
 * never saved in plain text). Written atomically (temp file + rename).
 */
export interface CloudSettingsData {
    accountId: string | null;
    tokenKind: 'account' | 'user' | null;
    /** Token id (the R2 accessKeyId), not a secret. */
    tokenId: string | null;
    machineId: string;               // uuid generated the first time
    machineName: string;             // os.hostname()
    tunnel: { mode: TunnelMode; auto: TunnelAutoConfig | null; autoStart: boolean; tunnelId: string | null; tunnelName: string | null; dnsRecordIds: Record<string, string>; enabled: Record<TunnelServiceId, boolean> };
    media: { enabled: boolean; bucket: string | null; options: MediaSyncOptions };
    /**
     * scopes: DB sync scope per local workspace (key = workspace id, since accounts belong to each workspace); missing = all
     * (read through normalizeScope).
     */
    db: { mode: DbSyncMode; bucket: string | null; following: { workspaceId: string; sourceMachine: string } | null; scopes?: Record<string, CloudScope> };
    /** "Đồng bộ dữ liệu" (Data sync): remembers "kèm ảnh/file" (with photos/files) while sync is off (missing = true). */
    sync?: { includeMedia?: boolean };
    /** Storage for media + DB copies (missing = 'r2': older versions only had R2). */
    storage?: { provider: CloudStorageProvider };
    /** Google Drive: signed-in account (not a secret) + the root folder "Deplao" + a separate OAuth client if any. */
    google?: GoogleSettingsData;
}

export interface GoogleSettingsData {
    email: string | null;
    displayName: string | null;
    /** id of the "Deplao" folder in My Drive (created by the app, drive.file permission). */
    rootFolderId: string | null;
    /** client_id of the separate OAuth client the user enters; null = Deplao's shared client. */
    customClientId: string | null;
    connectedAt: number | null;
}

export interface CloudSettingsStore {
    get(): CloudSettingsData;
    update(patch: (draft: CloudSettingsData) => void): CloudSettingsData;
    getToken(): string | null;
    setToken(token: string | null): void;
    getPassphrase(): string | null;
    setPassphrase(passphrase: string | null): void;
    /** Refresh token Google (safeStorage). */
    getGoogleRefreshToken(): string | null;
    setGoogleRefreshToken(token: string | null): void;
    /** client_secret of the separate OAuth client (safeStorage; Google Desktop clients may not have one). */
    getGoogleClientSecret(): string | null;
    setGoogleClientSecret(secret: string | null): void;
}

// ─── core: Google Drive (kho thay cho R2) ────────────────────────────────────

/**
 * Google Drive as storage: OAuth "Desktop app" (PKCE, redirects to http://127.0.0.1:<random port>), with the
 * drive.file permission (the app only sees files it created itself). "Bucket" = a subfolder of the "Deplao" folder in My Drive; the key
 * `a/b/c.jpg` = folder a → b → file c.jpg. The client returns the R2Client shape so the media / DB sync modules can use it unchanged.
 */
export interface GoogleDriveCore {
    /** State remembered in RAM (no network calls). */
    status(): GoogleDriveStatus;
    isConnected(): boolean;
    /** Open the sign-in browser; returns when done / cancelled / after 5 minutes. client null = Deplao's shared client. */
    connect(client?: GoogleClientInput | null): Promise<GoogleDriveStatus>;
    cancelConnect(): void;
    /** Revoke the token (best effort) + delete it on the machine. Does not delete files on Drive. */
    disconnect(): Promise<void>;
    /** Re-read the email + storage quota (about.get). */
    refresh(): Promise<GoogleDriveStatus>;
    /** Client for a "bucket" (folder Deplao/<bucket>), cached by name. */
    store(bucket: string): R2Client;
    /** Create the folder Deplao/<name> if it does not exist yet. */
    ensureBucket(name: string): Promise<void>;
    /** Names of the Deplao subfolders that start with the prefix. */
    listBuckets(prefix: string): Promise<string[]>;
}

// ─── core: operation counting + cost estimate ───────────────────────────────────

/** R2 operation class per the price list: A = write / list, B = read / check, free = delete / abort multipart. */
export type R2OpClass = 'A' | 'B' | 'free';

/** Record an operation (the R2 / Google Drive client calls this after each request). Cheap, never throws. */
export interface CloudUsageRecorder {
    recordR2(op: R2OpClass, bytes?: { up?: number; down?: number }): void;
    /** units: Drive API quota units for the request (5 / 50 / 100 / 200). */
    recordGoogle(units: number, bytes?: { up?: number; down?: number }): void;
}

export interface CloudUsageModule extends CloudUsageRecorder {
    /** Report for the selected storage. refresh = re-read the account-wide figures right now (at least 60 s apart). */
    report(opts?: { refresh?: boolean }): Promise<CloudUsageReport>;
    /** Write the counters to disk right away (when the app quits). */
    flush(): void;
}

// ─── core: service gom ──────────────────────────────────────────────────────

export interface CloudflareCore {
    settings: CloudSettingsStore;
    status(): CloudConnectionStatus;
    connect(input: CloudConnectInput): Promise<CloudConnectionStatus>;
    disconnect(): Promise<void>;
    recheck(): Promise<CloudConnectionStatus>;
    listZones(): Promise<CloudZone[]>;
    api(): CloudflareApi;                       // throws CloudError('NOT_CONNECTED') if not connected yet
    /**
     * Client of the SELECTED STORAGE for a bucket (the name stays r2 for history): R2 → R2 bucket; Google Drive → folder
     * Deplao/<bucket>. Media / DB sync only call through here, so they run unchanged on both storages.
     */
    r2(bucket: string): R2Client;
    /** Same as r2(bucket), with a new, clearer name. */
    store(bucket: string): R2Client;
    /** Create the bucket (R2) / folder (Google Drive) if it does not exist yet (name: 3-63 characters a-z0-9-), locationHint 'apac' by default (R2). */
    ensureBucket(name: string, opts?: { locationHint?: string }): Promise<void>;
    /** Buckets (R2) / folders (Drive) of the selected storage whose name starts with the prefix. */
    listBuckets(prefix: string): Promise<string[]>;
    /** Selected storage ('r2' by default). */
    storageProvider(): CloudStorageProvider;
    /** Whether the selected storage can be used right now (no network call) + the reason, for the user. */
    storageReady(): { ready: boolean; reason: string | null };
    storageStatus(): CloudStorageStatus;
    /** Switch storage (checks the conditions via the guard first → throws CloudError('STORAGE_SWITCH_BLOCKED') with the reason). */
    setStorageProvider(provider: CloudStorageProvider, guard?: () => string | null): Promise<CloudStorageStatus>;
    google: GoogleDriveCore;
    usage: CloudUsageModule;
    crypto: CloudCrypto;
    /** Notify the renderer (CLOUD_CHANGED_EVENT channel). */
    notifyChanged(area: 'connection' | 'tunnel' | 'media' | 'db'): void;
    /** Subscribe to changes in main (used by other modules). */
    onChanged(cb: (area: 'connection' | 'tunnel' | 'media' | 'db') => void): () => void;
}

// ─── module tunnel ──────────────────────────────────────────────────────────

export interface CloudTunnelModule {
    /** Called when the app starts (after the DB/relay are ready): turns itself back on if autoStart. Never throws. */
    init(): Promise<void>;
    getConfig(): TunnelConfigView;
    setMode(mode: TunnelMode): Promise<TunnelConfigView>;
    /** Provision/update: tunnel + ingress + DNS per the layout; runs cloudflared if a service is turned on. */
    configureAuto(input: TunnelAutoConfig): Promise<{ config: TunnelConfigView; addresses: PublicAddress[] }>;
    setAutoStart(on: boolean): Promise<void>;
    setServiceEnabled(service: TunnelServiceId, enabled: boolean): Promise<PublicAddress[]>;
    addresses(): PublicAddress[];
    /** The current public address of a service (used in integrationIpc / WebhookGatewayService / relay). */
    addressOf(service: TunnelServiceId): PublicAddress;
    /** refresh: re-read from Cloudflare right away (the "Kiểm tra lại" (Check again) button); by default uses the remembered copy if it is at most 10 minutes old. */
    health(opts?: { refresh?: boolean }): Promise<TunnelHealth>;
    moveHere(): Promise<PublicAddress[]>;
    disconnectForeign(): Promise<void>;
    teardown(): Promise<void>;
    /** Stop the process when the app quits (deletes nothing on Cloudflare). */
    shutdown(): Promise<void>;
}

// ─── module media ───────────────────────────────────────────────────────────

export interface CloudMediaModule {
    init(): Promise<void>;
    status(): MediaSyncStatus;
    setEnabled(on: boolean): Promise<MediaSyncStatus>;
    pause(): void;
    resume(): void;
    setOptions(opts: Partial<MediaSyncOptions>): Promise<MediaSyncStatus>;
    rehydrateAll(): Promise<void>;
    /**
     * Called from the media saving code (FileStorageService…) after a file has been written to the workspace's media/ folder.
     * Cheap: it only adds to a buffer and writes to the DB in batches. Never throws.
     */
    noteFileWritten(absPath: string): void;
    /**
     * Called from local-media:// and the employee media route when the file is NOT on the machine.
     * Returns the path of the file downloaded from R2, or null if it is not on R2 / R2 is off. Never throws.
     * waitMs: wait at most this long, then return null (default 60 s); the download STILL continues in the background, so the file is ready on the next open.
     * local-media waits briefly when the UI still has the channel's CDN link to show in the meantime (the image appears right away), and waits longer when R2 is the only source.
     */
    resolveMissingMediaFile(absPath: string, opts?: { waitMs?: number }): Promise<string | null>;
    /** R2 cleanup step 1: scan (in batches, does not block main), count, remember the list for 15 minutes. Deletes nothing. */
    cleanupPreview(req: R2CleanupRequest, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupPreview>;
    /** R2 cleanup step 2: delete exactly the list that was reviewed; cloud_media rows change to 'removed' (not uploaded again automatically). */
    cleanupRun(previewId: string, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupResult>;
    shutdown(): Promise<void>;
}

// ─── DB sync module ──────────────────────────────────────────────────────

export interface CloudDbModule {
    init(): Promise<void>;
    status(): DbSyncStatus;
    setMode(mode: DbSyncMode): Promise<DbSyncStatus>;
    /** Change the scope (accounts + from date); a different scope from the old one → take a new base snapshot for the new scope. */
    setScope(scope: CloudScope): Promise<DbSyncStatus>;
    setPassphrase(passphrase: string): Promise<void>;
    syncNow(): Promise<void>;
    log(opts?: { workspaceId?: string; limit?: number }): SyncLogEntry[];
    listRemote(): Promise<RemoteDbCopy[]>;
    /** Permanently delete the DB copy on R2 (base + segments + manifest + entries in db-index); refuses a copy that this machine is syncing. */
    deleteRemote(workspaceId: string): Promise<void>;
    restore(req: RestoreRequest, onProgress?: (p: RestoreProgress) => void): Promise<{ restoredWorkspaceId: string }>;
    follow(req: { workspaceId: string; on: boolean; passphrase?: string }): Promise<DbSyncStatus>;
    /**
     * Pause sync around an operation that replaces the DB file (changing the storage folder, switching workspace, restoring a broken DB,
     * deleting a workspace). After fn finishes: check the DB id, and take a new base snapshot if the DB changed.
     */
    pauseFor<T>(reason: string, fn: () => Promise<T> | T): Promise<T>;
    shutdown(): Promise<void>;
}
