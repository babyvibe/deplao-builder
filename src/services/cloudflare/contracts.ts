/**
 * Hợp đồng phía main giữa các module Cloudflare (để nhiều người/agent làm song song).
 *
 *   core     (CloudflareApi, CloudflareService, R2Client, cloudCrypto, cloudSettings) — dùng chung
 *   tunnel   src/services/cloudflare/tunnel/index.ts   → export const cloudTunnel: CloudTunnelModule
 *   media    src/services/cloudflare/media/index.ts    → export const cloudMedia: CloudMediaModule
 *   dbsync   src/services/cloudflare/dbsync/index.ts   → export const cloudDb: CloudDbModule
 *   ipc      electron/ipc/cloudflareIpc.ts             → registerCloudflareIpc(): gọi 3 module trên + core
 *
 * Kiểu dùng chung với renderer nằm ở src/shared/cloudContracts.ts.
 * Quy ước lỗi: module ném CloudError (code + message tiếng Việt cho người dùng); IPC bọc thành { success:false }.
 */
import type {
    CloudConnectionStatus, CloudConnectInput, CloudScope, CloudStorageProvider, CloudStorageStatus, CloudUsageReport, CloudZone,
    DbSyncMode, DbSyncStatus, GoogleClientInput, GoogleDriveStatus, MediaSyncOptions, MediaSyncStatus, PublicAddress,
    R2CleanupPreview, R2CleanupProgress, R2CleanupRequest, R2CleanupResult, RemoteDbCopy,
    RestoreProgress, RestoreRequest, SyncLogEntry, TunnelAutoConfig, TunnelConfigView, TunnelHealth,
    TunnelMode, TunnelServiceId,
} from '../../shared/cloudContracts';

export class CloudError extends Error {
    constructor(public code: string, message: string, public status?: number, public retryAfterMs?: number) {
        super(message);
        this.name = 'CloudError';
    }
}

// ─── core: REST API Cloudflare ──────────────────────────────────────────────

export interface CfRequestOptions {
    /** Query string (giá trị undefined bị bỏ). */
    query?: Record<string, string | number | boolean | undefined>;
    /** Header thêm (vd cf-r2-jurisdiction). */
    headers?: Record<string, string>;
    /** Mặc định 20_000 ms. */
    timeoutMs?: number;
    /** Không tính vào ngân sách (chỉ dùng cho verify token lúc kết nối). */
    unbudgeted?: boolean;
}

/**
 * Client REST v4 (https://api.cloudflare.com/client/v4). Token Bearer lấy từ cloudSettings.
 * - Ngân sách: tối đa 100 request / 5 phút cho CẢ app (token bucket). Hết ngân sách → chờ tới khi có, không vượt.
 * - 429 → CloudError('RATE_LIMITED', …, retryAfterMs); 5xx → thử lại tối đa 2 lần (backoff 1s, 3s); 4xx khác → CloudError.
 * - Log: không bao giờ in token.
 * Trả về `result` của envelope {success, errors, result, result_info}.
 */
export interface CloudflareApi {
    request<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts?: CfRequestOptions): Promise<T>;
    /** Gom mọi trang (page/per_page hoặc cursor) — dùng cho list nhỏ (zones, tunnels). */
    requestAll<T = any>(path: string, opts?: CfRequestOptions & { perPage?: number; maxPages?: number }): Promise<T[]>;
    /** Số request còn trong cửa sổ 5 phút (để UI/kiểm thử). */
    budgetRemaining(): number;
    /**
     * GraphQL Analytics (POST /graphql) — tính vào ngân sách như REST. Lỗi HTTP ném CloudError như request();
     * lỗi GraphQL (HTTP 200) trả trong errors (vd token thiếu quyền Account Analytics: Read).
     */
    graphql<T = any>(query: string, variables?: Record<string, unknown>, opts?: CfRequestOptions): Promise<{ data: T | null; errors: Array<{ message: string; [k: string]: unknown }> }>;
}

// ─── core: R2 (S3 API, ký SigV4 tự viết — không dùng AWS SDK) ────────────────

export interface R2ObjectInfo { key: string; size: number; etag: string; lastModified: number }

export interface R2PutOptions {
    contentType?: string;
    /** 'If-None-Match: *' — chỉ ghi khi chưa có. */
    ifNoneMatch?: '*';
    /** Metadata x-amz-meta-* (≤ 8 KB tổng). */
    metadata?: Record<string, string>;
}

/**
 * Client S3 cho MỘT bucket R2. Endpoint https://<accountId>.r2.cloudflarestorage.com, region 'auto', path-style.
 * Khoá S3 suy ra từ API token: accessKeyId = id của token (tokens/verify), secretAccessKey = sha256(token) dạng hex.
 * putFile tự chuyển multipart khi file > 64 MiB (phần 16 MiB, các phần bằng nhau; mỗi phần thử lại 3 lần).
 * Lỗi 429/5xx → CloudError('R2_BUSY', …, retryAfterMs) để hàng đợi phía trên lùi chung.
 */
export interface R2Client {
    readonly bucket: string;
    putObject(key: string, body: Buffer | string, opts?: R2PutOptions): Promise<{ etag: string }>;
    putFile(key: string, filePath: string, opts?: R2PutOptions & {
        onProgress?: (sentBytes: number, totalBytes: number) => void;
        /** Một phần tải lên lỗi (mạng / R2 bận) và sắp thử lại — để giao diện báo "đang thử lại". */
        onRetry?: (info: { part: number | null; attempt: number; maxAttempts: number; error: string }) => void;
    }): Promise<{ etag: string; size: number }>;
    getObject(key: string): Promise<Buffer | null>;
    /** Ghi vào file tạm rồi rename (không để file dở). null khi không có object. */
    getObjectToFile(key: string, filePath: string): Promise<{ size: number; etag: string } | null>;
    headObject(key: string): Promise<R2ObjectInfo | null>;
    deleteObject(key: string): Promise<void>;
    /**
     * DeleteObjects (POST ?delete, ≤ 1000 khoá / lần): xoá nhiều object một request. Thiếu object = coi như đã xoá.
     * Lỗi từng khoá trả trong errors; lỗi cả request (429/5xx/403…) ném CloudError như các lệnh khác. Tuỳ chọn: bản
     * giả / client cũ không có thì dùng deleteObject từng khoá.
     */
    deleteObjects?(keys: string[]): Promise<{ deleted: string[]; errors: Array<{ key: string; code: string; message: string }> }>;
    /** ListObjectsV2 một trang (≤ 1000). Tránh dùng thường xuyên — List là thao tác Class A. */
    listObjects(prefix: string, opts?: { continuationToken?: string; maxKeys?: number }): Promise<{ objects: R2ObjectInfo[]; nextToken: string | null }>;
    /** URL ký sẵn (GET), hạn tối đa 900 giây. */
    presignGet(key: string, expiresSec?: number): string;
}

// ─── core: mã hoá phía máy ──────────────────────────────────────────────────

/**
 * Định dạng file mã hoá "DPLC1": header 64 byte (magic 'DPLC1', version, salt 16B, scrypt N/r/p, chunkSize) +
 * các khối AES-256-GCM (mỗi khối: nonce 12B = 8B ngẫu nhiên cố định + 4B số thứ tự, ciphertext, tag 16B),
 * khối cuối có cờ "final" trong AAD để chống cắt cụt. Khoá = scrypt(passphrase, salt, N=2^15, r=8, p=1, 32B).
 */
export interface CloudCrypto {
    /** Sinh khoá từ mật khẩu; cache theo salt trong bộ nhớ (không ghi đĩa). */
    deriveKey(passphrase: string, salt: Buffer): Promise<Buffer>;
    encryptFile(srcPath: string, dstPath: string, passphrase: string): Promise<{ bytes: number }>;
    decryptFile(srcPath: string, dstPath: string, passphrase: string): Promise<{ bytes: number }>;
    encryptBuffer(plain: Buffer, passphrase: string): Promise<Buffer>;
    decryptBuffer(cipher: Buffer, passphrase: string): Promise<Buffer>;
    /** Kiểm tra mật khẩu đúng với một file/buffer mã hoá (giải mã khối đầu). */
    verifyPassphrase(cipherHead: Buffer, passphrase: string): Promise<boolean>;
}

// ─── core: cấu hình máy (KHÔNG nằm trong DB → đồng bộ DB không mang lên R2) ─────

/**
 * File userData/cloud-settings.json. Trường bí mật mã hoá bằng safeStorage (bắt buộc; không có safeStorage → lỗi,
 * không lưu dạng thường). Ghi atomically (file tạm + rename).
 */
export interface CloudSettingsData {
    accountId: string | null;
    tokenKind: 'account' | 'user' | null;
    /** id của token (accessKeyId của R2) — không bí mật. */
    tokenId: string | null;
    machineId: string;               // uuid sinh lần đầu
    machineName: string;             // os.hostname()
    tunnel: { mode: TunnelMode; auto: TunnelAutoConfig | null; autoStart: boolean; tunnelId: string | null; tunnelName: string | null; dnsRecordIds: Record<string, string>; enabled: Record<TunnelServiceId, boolean> };
    media: { enabled: boolean; bucket: string | null; options: MediaSyncOptions };
    /**
     * scopes: phạm vi đồng bộ DB theo workspace local (khoá = id workspace — tài khoản thuộc từng workspace); thiếu = tất cả
     * (đọc qua normalizeScope).
     */
    db: { mode: DbSyncMode; bucket: string | null; following: { workspaceId: string; sourceMachine: string } | null; scopes?: Record<string, CloudScope> };
    /** "Đồng bộ dữ liệu": ghi nhớ "kèm ảnh/file" khi đồng bộ đang tắt (thiếu = true). */
    sync?: { includeMedia?: boolean };
    /** Kho lưu cho media + bản sao DB (thiếu = 'r2' — bản cũ chỉ có R2). */
    storage?: { provider: CloudStorageProvider };
    /** Google Drive: tài khoản đã đăng nhập (không bí mật) + thư mục gốc "Deplao" + client OAuth riêng nếu có. */
    google?: GoogleSettingsData;
}

export interface GoogleSettingsData {
    email: string | null;
    displayName: string | null;
    /** id thư mục "Deplao" trong My Drive (do app tạo, quyền drive.file). */
    rootFolderId: string | null;
    /** client_id của client OAuth riêng người dùng nhập; null = client chung của Deplao. */
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
    /** client_secret của client OAuth riêng (safeStorage; client Desktop của Google có thể không có). */
    getGoogleClientSecret(): string | null;
    setGoogleClientSecret(secret: string | null): void;
}

// ─── core: Google Drive (kho thay cho R2) ────────────────────────────────────

/**
 * Google Drive làm kho: OAuth "Desktop app" (PKCE, chuyển hướng về http://127.0.0.1:<cổng ngẫu nhiên>), quyền
 * drive.file (app chỉ thấy file do chính nó tạo). "Bucket" = thư mục con của thư mục "Deplao" trong My Drive; khoá
 * `a/b/c.jpg` = thư mục a → b → file c.jpg. Client trả về theo kiểu R2Client để module media / đồng bộ DB dùng nguyên.
 */
export interface GoogleDriveCore {
    /** Trạng thái nhớ trong RAM (không gọi mạng). */
    status(): GoogleDriveStatus;
    isConnected(): boolean;
    /** Mở trình duyệt đăng nhập; trả về khi xong / huỷ / quá 5 phút. client null = client chung của Deplao. */
    connect(client?: GoogleClientInput | null): Promise<GoogleDriveStatus>;
    cancelConnect(): void;
    /** Thu hồi token (best effort) + xoá trên máy. Không xoá file trên Drive. */
    disconnect(): Promise<void>;
    /** Đọc lại email + dung lượng (about.get). */
    refresh(): Promise<GoogleDriveStatus>;
    /** Client theo "bucket" (thư mục Deplao/<bucket>), cache theo tên. */
    store(bucket: string): R2Client;
    /** Tạo thư mục Deplao/<name> nếu chưa có. */
    ensureBucket(name: string): Promise<void>;
    /** Tên các thư mục con của Deplao bắt đầu bằng prefix. */
    listBuckets(prefix: string): Promise<string[]>;
}

// ─── core: đếm thao tác + ước tính chi phí ───────────────────────────────────

/** Loại thao tác R2 theo bảng giá: A = ghi / liệt kê, B = đọc / kiểm tra, free = xoá / huỷ multipart. */
export type R2OpClass = 'A' | 'B' | 'free';

/** Ghi nhận thao tác (client R2 / Google Drive gọi sau mỗi request). Rẻ, không ném. */
export interface CloudUsageRecorder {
    recordR2(op: R2OpClass, bytes?: { up?: number; down?: number }): void;
    /** units: đơn vị quota Drive API của request (5 / 50 / 100 / 200). */
    recordGoogle(units: number, bytes?: { up?: number; down?: number }): void;
}

export interface CloudUsageModule extends CloudUsageRecorder {
    /** Báo cáo của kho đang chọn. refresh = đọc lại số liệu toàn tài khoản ngay (giãn ≥ 60 s). */
    report(opts?: { refresh?: boolean }): Promise<CloudUsageReport>;
    /** Ghi bộ đếm xuống đĩa ngay (lúc thoát app). */
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
    api(): CloudflareApi;                       // ném CloudError('NOT_CONNECTED') nếu chưa kết nối
    /**
     * Client của KHO ĐANG CHỌN cho một bucket (tên giữ là r2 vì lịch sử): R2 → bucket R2; Google Drive → thư mục
     * Deplao/<bucket>. Media / đồng bộ DB chỉ gọi qua đây nên chạy nguyên trên cả hai kho.
     */
    r2(bucket: string): R2Client;
    /** Như r2(bucket) — tên mới, rõ nghĩa. */
    store(bucket: string): R2Client;
    /** Tạo bucket (R2) / thư mục (Google Drive) nếu chưa có (name: 3–63 ký tự a-z0-9-), locationHint 'apac' mặc định (R2). */
    ensureBucket(name: string, opts?: { locationHint?: string }): Promise<void>;
    /** Bucket (R2) / thư mục (Drive) của kho đang chọn có tên bắt đầu bằng prefix. */
    listBuckets(prefix: string): Promise<string[]>;
    /** Kho đang chọn ('r2' mặc định). */
    storageProvider(): CloudStorageProvider;
    /** Kho đang chọn dùng được ngay không (không gọi mạng) + lý do cho người dùng. */
    storageReady(): { ready: boolean; reason: string | null };
    storageStatus(): CloudStorageStatus;
    /** Đổi kho (kiểm tra điều kiện qua guard trước — ném CloudError('STORAGE_SWITCH_BLOCKED') kèm lý do). */
    setStorageProvider(provider: CloudStorageProvider, guard?: () => string | null): Promise<CloudStorageStatus>;
    google: GoogleDriveCore;
    usage: CloudUsageModule;
    crypto: CloudCrypto;
    /** Báo renderer (kênh CLOUD_CHANGED_EVENT). */
    notifyChanged(area: 'connection' | 'tunnel' | 'media' | 'db'): void;
    /** Đăng ký nghe thay đổi trong main (module khác dùng). */
    onChanged(cb: (area: 'connection' | 'tunnel' | 'media' | 'db') => void): () => void;
}

// ─── module tunnel ──────────────────────────────────────────────────────────

export interface CloudTunnelModule {
    /** Gọi lúc app khởi động (sau khi DB/relay sẵn sàng): tự bật lại nếu autoStart. Không ném. */
    init(): Promise<void>;
    getConfig(): TunnelConfigView;
    setMode(mode: TunnelMode): Promise<TunnelConfigView>;
    /** Cấp phát/cập nhật: tunnel + ingress + DNS theo layout; chạy cloudflared nếu có dịch vụ bật. */
    configureAuto(input: TunnelAutoConfig): Promise<{ config: TunnelConfigView; addresses: PublicAddress[] }>;
    setAutoStart(on: boolean): Promise<void>;
    setServiceEnabled(service: TunnelServiceId, enabled: boolean): Promise<PublicAddress[]>;
    addresses(): PublicAddress[];
    /** Địa chỉ công khai hiện tại của một dịch vụ (dùng ở integrationIpc / WebhookGatewayService / relay). */
    addressOf(service: TunnelServiceId): PublicAddress;
    /** refresh: đọc lại phía Cloudflare ngay (nút "Kiểm tra lại"); mặc định dùng bản nhớ ≤ 10 phút. */
    health(opts?: { refresh?: boolean }): Promise<TunnelHealth>;
    moveHere(): Promise<PublicAddress[]>;
    disconnectForeign(): Promise<void>;
    teardown(): Promise<void>;
    /** Dừng tiến trình khi thoát app (không xoá gì trên Cloudflare). */
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
     * Gọi từ chỗ lưu media (FileStorageService…) sau khi ghi xong một file trong thư mục media/ của workspace.
     * Rẻ: chỉ đưa vào bộ đệm, ghi DB theo lô. Không ném.
     */
    noteFileWritten(absPath: string): void;
    /**
     * Gọi từ local-media:// và route media của nhân viên khi file KHÔNG có trên máy.
     * Trả đường dẫn đã tải về từ R2, hoặc null nếu không có trên R2 / R2 tắt. Không ném.
     * waitMs: chờ tối đa bấy nhiêu rồi trả null (mặc định 60 s); việc tải VẪN chạy tiếp ở nền, lần mở sau có file ngay.
     * local-media dùng chờ ngắn khi giao diện còn link CDN của kênh để hiện thay (ảnh ra ngay), chờ dài khi R2 là nguồn duy nhất.
     */
    resolveMissingMediaFile(absPath: string, opts?: { waitMs?: number }): Promise<string | null>;
    /** Dọn R2 bước 1: quét (theo lô, không chặn main), đếm, nhớ danh sách 15 phút. Không xoá gì. */
    cleanupPreview(req: R2CleanupRequest, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupPreview>;
    /** Dọn R2 bước 2: xoá đúng danh sách đã xem; dòng cloud_media chuyển 'removed' (không tự tải lên lại). */
    cleanupRun(previewId: string, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupResult>;
    shutdown(): Promise<void>;
}

// ─── module đồng bộ DB ──────────────────────────────────────────────────────

export interface CloudDbModule {
    init(): Promise<void>;
    status(): DbSyncStatus;
    setMode(mode: DbSyncMode): Promise<DbSyncStatus>;
    /** Đổi phạm vi (tài khoản + từ ngày); khác phạm vi cũ → chụp bản gốc mới theo phạm vi mới. */
    setScope(scope: CloudScope): Promise<DbSyncStatus>;
    setPassphrase(passphrase: string): Promise<void>;
    syncNow(): Promise<void>;
    log(opts?: { workspaceId?: string; limit?: number }): SyncLogEntry[];
    listRemote(): Promise<RemoteDbCopy[]>;
    /** Xoá hẳn bản sao DB trên R2 (base + đoạn + manifest + mục trong db-index); từ chối bản đang đồng bộ của máy này. */
    deleteRemote(workspaceId: string): Promise<void>;
    restore(req: RestoreRequest, onProgress?: (p: RestoreProgress) => void): Promise<{ restoredWorkspaceId: string }>;
    follow(req: { workspaceId: string; on: boolean; passphrase?: string }): Promise<DbSyncStatus>;
    /**
     * Tạm dừng đồng bộ quanh thao tác thay file DB (đổi thư mục lưu trữ, chuyển workspace, khôi phục DB hỏng,
     * xoá workspace). Sau khi fn xong: kiểm tra mã DB, chụp gốc mới nếu DB đã đổi.
     */
    pauseFor<T>(reason: string, fn: () => Promise<T> | T): Promise<T>;
    shutdown(): Promise<void>;
}
