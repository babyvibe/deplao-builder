/**
 * cloudContracts — hợp đồng chung cho tính năng "Internet & Đám mây" (Cloudflare: tunnel cố định, R2 media,
 * đồng bộ DB). Dùng cho cả main (src/services/cloudflare/**, electron/ipc/cloudflareIpc.ts) và renderer
 * (src/ui/components/settings/cloud/**). Thiết kế: Claude Doc "Deplao × Cloudflare" (tab chính + tab Giao diện).
 *
 * Quy tắc:
 *  - Token Cloudflare và mật khẩu sao lưu KHÔNG BAO GIỜ đi qua IPC về renderer; renderer chỉ thấy trạng thái.
 *  - Mọi thao tác đi qua IPC `cloudflare:*` (một luồng logic), kiểm quyền ở main trước khi gọi service.
 *  - Mặc định tắt hết; tắt là app chạy như cũ.
 */

// ─── Kết nối ─────────────────────────────────────────────────────────────────

export type CloudFeature = 'tunnel' | 'r2';

export interface CloudPermissionCheck {
    feature: CloudFeature;
    ok: boolean;
    /** Lý do khi thiếu, viết cho người dùng (vd "Thiếu quyền Cloudflare Tunnel: Edit"). */
    missing?: string[];
    /** R2 chưa được bật trên tài khoản (lỗi 10042). */
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
    /** Tên tài khoản hiển thị (lấy từ zone.account.name nếu có). */
    accountName: string | null;
    tokenKind: 'account' | 'user' | null;
    /** Ngày hết hạn token (ISO) nếu có. */
    tokenExpiresOn: string | null;
    zones: CloudZone[];
    permissions: CloudPermissionCheck[];
    /** Lần kiểm tra gần nhất (ms). */
    checkedAt: number | null;
    lastError: string | null;
}

export interface CloudConnectInput {
    accountId: string;
    token: string;
}

// ─── Địa chỉ Internet (tunnel) ───────────────────────────────────────────────

/** Cách tạo địa chỉ. 'quick' = Quick Tunnel (tạm), 'cloudflare_manual' = dán token tự tạo (như hiện nay). */
export type TunnelMode = 'quick' | 'ngrok' | 'cloudflare_auto' | 'cloudflare_manual';

/** Ba dịch vụ có địa chỉ Internet. relay = cổng 9900 (nhân viên + API v1 + Socket.IO/SSE). */
export type TunnelServiceId = 'relay' | 'payments' | 'workflow';

/** 'single' = một tên miền cho mọi dịch vụ, chia theo đường dẫn (mặc định); 'split' = mỗi dịch vụ một tên. */
export type AddressLayout = 'single' | 'split';

export interface TunnelAutoConfig {
    zoneId: string;
    zoneName: string;
    /** Tiền tố tên, vd "shop" → shop.tenmien.vn (+ shop-pay, shop-hook khi split). Chỉ a-z, 0-9, '-'. */
    hostPrefix: string;
    layout: AddressLayout;
}

export interface PublicAddress {
    service: TunnelServiceId;
    /**
     * Địa chỉ GỐC (không kèm đường dẫn) mà code hiện có tự nối đường dẫn vào, đúng như tunnelUrl hôm nay:
     * relay → `${url}/api/v1`, payments → `${url}/webhook/<loại>`, workflow → `${url}/api/workflow/webhook/<token>`.
     * Layout 'single': cả ba là https://shop.tenmien.vn. Layout 'split': https://shop-pay… / https://shop-hook….
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
    /** Trạng thái phía Cloudflare: healthy | degraded | down | inactive (đọc tối đa 10 phút/lần). */
    cfStatus: string | null;
    /** /ready của cloudflared trên máy. */
    localReady: boolean;
    connections: number;
    /** Có connector của máy khác đang dùng cùng token. */
    foreignConnectors: number;
    cloudflaredVersion: string | null;
    checkedAt: number | null;
}

export interface TunnelConfigView {
    mode: TunnelMode;
    auto: TunnelAutoConfig | null;
    autoStart: boolean;
    /** Hostname dự kiến theo cấu hình hiện tại (để xem trước khi gõ). */
    preview: Record<TunnelServiceId, string>;
}

// ─── Phạm vi dữ liệu (dùng chung cho lưu media và đồng bộ DB) ────────────────

/**
 * Lưu / đồng bộ những gì: tài khoản nào và từ ngày nào. Mặc định tất cả tài khoản, toàn bộ thời gian.
 * - accounts: 'all' = mọi tài khoản (kể cả tài khoản thêm sau); mảng = chỉ các tài khoản này (accounts.zalo_id —
 *   id chung của mọi kênh: Zalo uid, Facebook uid, Telegram id).
 * - fromTs: chỉ dữ liệu từ thời điểm này (ms, thường là 00:00 giờ máy của ngày chọn); null = toàn bộ.
 *   Media: theo thời gian file. DB: chỉ áp cho bảng lịch sử tin (tin nhắn, ghim, link, nhật ký gửi…);
 *   danh bạ / nhóm / cài đặt của tài khoản được chọn luôn đồng bộ đủ.
 */
export interface CloudScope {
    accounts: 'all' | string[];
    fromTs: number | null;
}

export const ALL_SCOPE: CloudScope = { accounts: 'all', fromTs: null };

/** Chuẩn hoá phạm vi từ settings / IPC (sai kiểu → mặc định). Bỏ id rỗng / trùng; tối đa 500 tài khoản. */
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
    concurrency: number;            // 1..16, mặc định 3 (giới hạn thật là đường truyền tải lên của máy)
    nightOnly: boolean;             // chỉ chạy 22:00–07:00
    bandwidthKbps: number;          // 0 = không giới hạn
    /**
     * Sau khi file đã lên R2: false = giữ nguyên file trên máy (mặc định — nhiều khách không muốn xoá);
     * true = xoá bản trên máy của file cũ (vẫn mở được, tự tải lại khi cần).
     */
    evictEnabled: boolean;
    evictKeepDays: number;          // chỉ xoá file không mở trong N ngày (mặc định 30)
    evictMinFreeGb: number;         // dọn tới khi ổ còn trống ít nhất N GB (mặc định 20)
    /** Phạm vi (tài khoản + từ ngày). Thiếu = tất cả. Đổi phạm vi chỉ ảnh hưởng file chưa lên; file đã lên R2 vẫn giữ. */
    scope?: CloudScope;
    /** File không thuộc tài khoản nào (thư viện media, công việc, file tải lên chung, ảnh đại diện). Thiếu = true. */
    includeShared?: boolean;
}

// ─── Dọn file trên R2 (chỉ khi người dùng chủ động chạy; xoá trong app KHÔNG tự xoá trên R2) ──────────

/**
 * Chọn file cần dọn trên R2 (kết hợp OR giữa các tiêu chí đã bật). Chỉ đụng tới media của workspace đang mở.
 * Mặc định KHÔNG xoá file chỉ còn trên R2 (đã dọn khỏi máy) — xoá là mất hẳn — và KHÔNG xoá file trên máy.
 */
export interface R2CleanupRequest {
    /** File của tin đã xoá trong app: không còn tin nhắn / ghim / thư viện… nào trỏ tới (chỉ xét file media của tài khoản). */
    orphans?: boolean;
    /** Toàn bộ file của các tài khoản này (vd tài khoản đã gỡ khỏi app). */
    accounts?: string[];
    /** File cũ hơn thời điểm này (ms). */
    olderThanTs?: number | null;
    /** File ngoài phạm vi lưu media hiện tại (tài khoản không chọn, trước mốc ngày, file chung khi đã tắt). */
    outOfScope?: boolean;
    /** Cho phép xoá cả file chỉ còn trên R2 (đã dọn khỏi máy). Mặc định false. */
    includeCloudOnly?: boolean;
    /** Với file của tin đã xoá: xoá luôn bản trên máy (rác). Mặc định false. */
    deleteLocalOrphans?: boolean;
}

export interface R2CleanupPreview {
    /** Dùng để chạy đúng danh sách đã xem (hết hạn sau 15 phút). */
    previewId: string;
    scannedAt: number;
    files: number;
    bytes: number;
    /** Trong số trên: file chỉ còn trên R2 (đã dọn khỏi máy) — chỉ có khi includeCloudOnly. */
    cloudOnlyFiles: number;
    cloudOnlyBytes: number;
    /** File chỉ còn trên R2 khớp tiêu chí nhưng bị BỎ QUA vì chưa cho phép (để giao diện nhắc). */
    skippedCloudOnly: number;
    /** File trên máy sẽ bị xoá theo (deleteLocalOrphans). */
    localFiles: number;
    /** Số file theo từng tiêu chí (một file có thể khớp nhiều tiêu chí). */
    byReason: { orphans: number; accounts: number; olderThan: number; outOfScope: number };
    /** Vài đường dẫn ví dụ (tương đối thư mục media). */
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
    /** Thời điểm sẽ thử lại khi đang lùi vì 429/5xx. */
    backoffUntil: number | null;
    options: MediaSyncOptions;
    lastError: string | null;
}

// ─── Đồng bộ DB ──────────────────────────────────────────────────────────────

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
    /** Phạm vi riêng của workspace này (tài khoản thuộc từng workspace nên phạm vi lưu theo workspace). */
    scope?: CloudScope;
    /** Tiến độ lần chụp bản gốc đang chạy (null / thiếu = không chạy). */
    progress?: DbSyncProgress | null;
    /** Mã bản sao trên R2 của workspace này (cùng dạng RemoteDbCopy.workspaceId); null = chưa có. */
    copyId?: string | null;
}

/**
 * Tiến độ chụp bản gốc: sao chép DB → lọc theo phạm vi → nén → mã hoá → tải lên R2.
 * percent: cả lần chụp (ước lượng theo trọng số các bước); done/total: của bước hiện tại (byte; 0/0 = không đo được).
 */
export interface DbSyncProgress {
    phase: 'copy' | 'filter' | 'compress' | 'encrypt' | 'upload';
    percent: number;
    done: number;
    total: number;
    startedAt: number;
    /** Lúc bắt đầu bước hiện tại. */
    phaseStartedAt: number;
    /** Tốc độ tải lên gần đây (byte/s), chỉ bước upload. */
    rate?: number | null;
    /** Lần thử lại gần nhất khi tải lên (mạng chậm / R2 bận). */
    retry?: { part: number | null; attempt: number; maxAttempts: number; error: string; at: number } | null;
}

export interface DbSyncStatus {
    mode: DbSyncMode;
    passphraseSet: boolean;
    bucket: string | null;
    /** Phạm vi đồng bộ (tài khoản + từ ngày). Đổi phạm vi → tạo bản gốc mới theo phạm vi mới. */
    scope: CloudScope;
    workspaces: DbSyncWorkspaceStatus[];
    /** Máy đang theo dõi bản sao (đọc từ manifest trên R2). */
    followers: Array<{ machine: string; lagMs: number | null; seenAt: number }>;
    /** Máy này đang ở chế độ máy dự phòng (theo dõi bản sao của máy khác). */
    following: { workspaceId: string; sourceMachine: string; lagMs: number | null } | null;
}

export interface SyncLogEntry {
    id: number;
    workspaceId: string;
    at: number;            // bắt đầu
    endAt: number | null;  // realtime: dòng gộp theo giờ
    kind: 'base' | 'segment' | 'segments-hour' | 'restore' | 'follow';
    pushes: number;        // số lần đẩy (segments-hour)
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
    /** Phạm vi của bản sao (bản cũ không ghi = tất cả). */
    scope?: CloudScope;
    /** Tên các tài khoản trong bản sao (để hiện khi chọn bản khôi phục), nếu manifest có ghi. */
    accountNames?: Array<{ id: string; name: string; channel: string }>;
}

export interface RestoreRequest {
    workspaceId: string;
    /** Bắt buộc khi máy này chưa lưu mật khẩu (máy mới / máy dự phòng). */
    passphrase?: string;
    /** Dừng ở thời điểm này (trong khoảng từ bản gốc gần nhất); bỏ trống = mới nhất. */
    untilTs?: number;
}

export interface RestoreProgress {
    step: 'download' | 'decrypt' | 'apply' | 'verify' | 'swap' | 'done' | 'error';
    percent: number;
    message?: string;
}

// ─── Đồng bộ dữ liệu: MỘT thiết lập chung cho dữ liệu (DB) + ảnh/file (media) ──────────────

/**
 * Người dùng chỉ chọn: tài khoản, từ ngày, chế độ, có kèm ảnh/file không — áp cùng lúc cho dữ liệu và ảnh/file của
 * workspace đang mở. Main gọi đúng các hàm của module DB / media (phạm vi trước, rồi bật media, cuối cùng chế độ DB).
 */
export interface SyncConfig {
    /** Tắt / Theo giờ / Realtime — nhịp đẩy dữ liệu (DB). Ảnh & file chạy liên tục khi đồng bộ bật và kèm ảnh. */
    mode: DbSyncMode;
    /** Tài khoản + từ ngày — áp cho CẢ dữ liệu lẫn ảnh/file. */
    scope: CloudScope;
    /** Kèm ảnh, video, file (mặc định bật). */
    includeMedia: boolean;
    /** Kèm file chung không thuộc tài khoản nào (thư viện media, công việc, file tải lên). Mặc định bật. */
    includeShared: boolean;
}

export interface SyncOverview {
    config: SyncConfig;
    db: DbSyncStatus;
    media: MediaSyncStatus;
}

// ─── Kho lưu: Cloudflare R2 hoặc Google Drive (Google One) ─────────────────────

/**
 * Nơi đặt ảnh/file + bản sao dữ liệu (đồng bộ dữ liệu). Mỗi lúc dùng MỘT kho; Địa chỉ Internet (tunnel) luôn là
 * Cloudflare, không phụ thuộc kho. 'gdrive' = Google Drive của tài khoản Google (dung lượng theo gói Google One).
 */
export type CloudStorageProvider = 'r2' | 'gdrive';

export const CLOUD_STORAGE_PROVIDERS: ReadonlyArray<CloudStorageProvider> = ['r2', 'gdrive'];

export function isCloudStorageProvider(v: unknown): v is CloudStorageProvider {
    return v === 'r2' || v === 'gdrive';
}

/** Tên kho để hiện trong câu chữ ("lên R2", "lên Google Drive"). */
export function storageLabel(provider: CloudStorageProvider | null | undefined): string {
    return provider === 'gdrive' ? 'Google Drive' : 'R2';
}

/** Dung lượng tài khoản Google (Drive API about.storageQuota) — dùng chung Gmail, Drive, Photos. */
export interface GoogleDriveQuota {
    /** Tổng dung lượng (byte); null = không giới hạn (một số tài khoản Workspace). */
    limit: number | null;
    /** Đã dùng toàn tài khoản (Gmail + Drive + Photos). */
    usage: number;
    usageInDrive: number;
    usageInDriveTrash: number;
}

export interface GoogleDriveStatus {
    connected: boolean;
    email: string | null;
    displayName: string | null;
    /** Đang dùng client OAuth do người dùng tự tạo (hạn mức Google Cloud riêng của họ). */
    customClient: boolean;
    /** Bản app có sẵn client OAuth chung của Deplao (không có → phải nhập client riêng). */
    builtinClient: boolean;
    /** client_id đang dùng (không bí mật) — để hiện / sửa. */
    clientId: string | null;
    quota: GoogleDriveQuota | null;
    /** Lần đọc dung lượng gần nhất (ms). */
    checkedAt: number | null;
    lastError: string | null;
    /** Đang chờ người dùng đăng nhập trên trình duyệt. */
    connecting: boolean;
}

export interface CloudStorageStatus {
    provider: CloudStorageProvider;
    /** Kho đang chọn dùng được ngay (R2: Cloudflare đã kết nối + đủ quyền R2; Google: đã đăng nhập). */
    ready: boolean;
    /** Lý do chưa dùng được (câu cho người dùng); null khi ready. */
    notReadyReason: string | null;
    google: GoogleDriveStatus;
}

/** Client OAuth "Desktop app" người dùng tự tạo trên Google Cloud (Drive API + quyền drive.file). */
export interface GoogleClientInput {
    clientId: string;
    /** Client Desktop của Google có thể bỏ trống (PKCE); có thì gửi kèm. */
    clientSecret?: string | null;
}

// ─── Mức sử dụng & chi phí (Cài đặt → Đồng bộ dữ liệu) ───────────────────────

/**
 * Bảng giá dùng để ước tính (USD). R2: developers.cloudflare.com/r2/pricing (Standard storage, đọc 10/2026).
 * Google Drive API: miễn phí dưới hạn mức; vượt ngưỡng ngày Google báo sẽ tính phí từ cuối 2026 (chưa có giá) →
 * chỉ hiện % ngưỡng, không ước tính tiền.
 */
export const R2_PRICING = Object.freeze({
    freeStorageGbMonth: 10,
    freeClassA: 1_000_000,
    freeClassB: 10_000_000,
    storageUsdPerGbMonth: 0.015,
    classAUsdPerMillion: 4.5,
    classBUsdPerMillion: 0.36,
});

/** Hạn mức Drive API (developers.google.com/workspace/drive/api/guides/limits, áp từ 1/5/2026). */
export const GDRIVE_LIMITS = Object.freeze({
    unitsPerMinutePerProject: 1_000_000,
    unitsPerMinutePerUser: 325_000,
    /** Ngưỡng tính phí mỗi ngày cho cả project (client OAuth). */
    unitsPerDayPerProject: 400_000_000,
    /** Tải xuống mỗi ngày cho cả project trước khi tính phí. */
    egressBytesPerDayPerProject: 1024 ** 4,
    /** Tải lên mỗi ngày của một tài khoản. */
    uploadBytesPerDayPerUser: 750 * 1024 ** 3,
    unitsRead: 5,
    unitsList: 100,
    unitsDownload: 200,
    unitsEdit: 50,
    unitsOther: 5,
});

export type CloudUsageMeterId =
    /** R2: dung lượng trung bình tháng (GB-tháng), phần miễn phí 10. */
    | 'r2Storage'
    /** R2: thao tác ghi (Class A) trong tháng, miễn phí 1 triệu. */
    | 'r2ClassA'
    /** R2: thao tác đọc (Class B) trong tháng, miễn phí 10 triệu. */
    | 'r2ClassB'
    /** R2: byte tải xuống trong tháng (miễn phí, chỉ để biết). */
    | 'r2Egress'
    /** Google: dung lượng đã dùng / tổng của tài khoản Google. */
    | 'gdriveStorage'
    /** Google: đơn vị quota Drive API hôm nay (ngày theo giờ Thái Bình Dương), ngưỡng 400 triệu / project. */
    | 'gdriveUnitsDay'
    /** Google: byte tải xuống hôm nay, ngưỡng 1 TB / project. */
    | 'gdriveEgressDay'
    /** Google: byte tải lên hôm nay, giới hạn 750 GB / tài khoản. */
    | 'gdriveUploadDay';

export interface CloudUsageMeter {
    id: CloudUsageMeterId;
    /** Đơn vị của used/limit/projected: 'bytes' | 'gbMonth' | 'ops' | 'units'. */
    unit: 'bytes' | 'gbMonth' | 'ops' | 'units';
    used: number;
    /** Phần miễn phí / ngưỡng (cùng đơn vị); null = không giới hạn / không biết. */
    limit: number | null;
    /** Dự kiến cuối kỳ (tháng với R2, ngày với Google) theo nhịp hiện tại; null = không tính. */
    projected: number | null;
    /** Phí ước tính của riêng mục này (USD): đến hiện tại / cả kỳ. */
    costSoFar: number;
    costProjected: number;
    /** 'account' = số liệu toàn tài khoản; 'local' = chỉ Deplao trên máy này. */
    source: 'account' | 'local';
}

export interface CloudUsageReport {
    provider: CloudStorageProvider;
    generatedAt: number;
    /** Kỳ tính tiền / hạn mức: R2 = tháng dương lịch (UTC); Google = ngày theo giờ Thái Bình Dương. */
    period: { kind: 'month' | 'day'; startTs: number; endTs: number };
    /** Có số liệu toàn tài khoản không (R2: Cloudflare Analytics; Google: dung lượng tài khoản). */
    accountData: boolean;
    /** Vì sao thiếu số liệu toàn tài khoản (vd token thiếu quyền Account Analytics: Read) — null khi đủ. */
    accountNote: string | null;
    meters: CloudUsageMeter[];
    /** Tổng phí ước tính (USD) của kỳ: đến hiện tại và cả kỳ. Google: luôn 0 (dưới ngưỡng không tính phí). */
    cost: { soFar: number; projected: number };
    /** Google: đang dùng client chung của Deplao (ngưỡng project chia cho mọi người dùng Deplao). */
    sharedProject?: boolean;
}

// ─── IPC (renderer thấy qua window.electronAPI.cloudflare) ──────────────────

export type CloudResult<T = {}> = Promise<{ success: boolean; error?: string; code?: string } & Partial<T>>;

export interface CloudflareIpc {
    status: () => CloudResult<{ connection: CloudConnectionStatus }>;
    connect: (input: CloudConnectInput) => CloudResult<{ connection: CloudConnectionStatus }>;
    disconnect: () => CloudResult;
    recheck: () => CloudResult<{ connection: CloudConnectionStatus }>;
    /** Link Cloudflare điền sẵn quyền để tạo token. */
    tokenTemplateUrl: () => CloudResult<{ url: string }>;

    tunnel: {
        getConfig: () => CloudResult<{ config: TunnelConfigView }>;
        setMode: (mode: TunnelMode) => CloudResult<{ config: TunnelConfigView }>;
        configureAuto: (input: TunnelAutoConfig) => CloudResult<{ config: TunnelConfigView; addresses: PublicAddress[] }>;
        setAutoStart: (on: boolean) => CloudResult;
        setServiceEnabled: (service: TunnelServiceId, enabled: boolean) => CloudResult<{ addresses: PublicAddress[] }>;
        addresses: () => CloudResult<{ addresses: PublicAddress[] }>;
        /** refresh = đọc lại phía Cloudflare ngay (nút "Kiểm tra lại", giãn ≥ 30 s); mặc định dùng bản nhớ ≤ 10 phút. */
        health: (opts?: { refresh?: boolean }) => CloudResult<{ health: TunnelHealth }>;
        /** Trỏ địa chỉ cố định sang máy này (tạo tunnel mới, sửa DNS). */
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
        /** Tải lại toàn bộ file đã dọn về máy. */
        rehydrateAll: () => CloudResult;
        /** Dọn R2 bước 1: quét và đếm (không xoá gì). Tiến độ qua CLOUD_CLEANUP_PROGRESS_EVENT. */
        cleanupPreview: (req: R2CleanupRequest) => CloudResult<{ preview: R2CleanupPreview }>;
        /** Dọn R2 bước 2: xoá đúng danh sách của previewId (người dùng đã xem và xác nhận). */
        cleanupRun: (previewId: string) => CloudResult<{ result: R2CleanupResult }>;
    };

    /** Kho lưu (R2 / Google Drive) — chọn kho, trạng thái kho đang chọn. */
    storage: {
        status: () => CloudResult<{ storage: CloudStorageStatus }>;
        /**
         * Đổi kho. Từ chối (code STORAGE_SWITCH_BLOCKED) khi đồng bộ đang bật, máy đang làm máy dự phòng, hoặc còn file
         * chỉ nằm trên kho cũ (đã dọn khỏi máy) — tải về máy trước.
         */
        setProvider: (provider: CloudStorageProvider) => CloudResult<{ storage: CloudStorageStatus }>;
    };

    /** Google Drive (Google One): đăng nhập Google trên trình duyệt của máy (OAuth, quyền drive.file). */
    google: {
        /**
         * Mở trình duyệt đăng nhập Google; trả về khi người dùng đồng ý (tối đa 5 phút) hoặc huỷ.
         * client: client OAuth riêng của người dùng; bỏ trống = client chung của Deplao (nếu bản app có).
         */
        connect: (client?: GoogleClientInput | null) => CloudResult<{ storage: CloudStorageStatus }>;
        cancelConnect: () => CloudResult;
        /** Thu hồi quyền + xoá token trên máy. File đã lên Google Drive giữ nguyên. */
        disconnect: () => CloudResult<{ storage: CloudStorageStatus }>;
        /** Đọc lại dung lượng tài khoản Google. */
        refresh: () => CloudResult<{ storage: CloudStorageStatus }>;
    };

    /** Mức sử dụng & chi phí của kho đang chọn. */
    usage: {
        /** refresh = đọc lại số liệu toàn tài khoản ngay (giãn ≥ 60 s); mặc định dùng bản nhớ ≤ 10 phút. */
        get: (opts?: { refresh?: boolean }) => CloudResult<{ report: CloudUsageReport }>;
    };

    /** Đồng bộ dữ liệu — một thiết lập chung (màn hình chính dùng cái này; db.* / media.* cho phần nâng cao). */
    sync: {
        get: () => CloudResult<{ overview: SyncOverview }>;
        /**
         * Lưu một lần. Bật đồng bộ lần đầu cần mật khẩu sao lưu (db.setPassphrase trước; thiếu → code PASSPHRASE_REQUIRED).
         * rebase = đã có bản trên R2 và phạm vi đổi → sẽ tạo bản gốc mới theo phạm vi mới.
         */
        apply: (config: SyncConfig) => CloudResult<{ overview: SyncOverview; rebase: boolean }>;
    };

    db: {
        status: () => CloudResult<{ status: DbSyncStatus }>;
        setMode: (mode: DbSyncMode) => CloudResult<{ status: DbSyncStatus }>;
        /** Đặt/đổi mật khẩu sao lưu (bắt buộc trước khi bật). Lưu mã hoá safeStorage trên máy. */
        setPassphrase: (passphrase: string) => CloudResult;
        syncNow: () => CloudResult;
        log: (opts?: { workspaceId?: string; limit?: number }) => CloudResult<{ entries: SyncLogEntry[] }>;
        listRemote: () => CloudResult<{ copies: RemoteDbCopy[] }>;
        /**
         * Xoá hẳn một bản sao DB trên R2 (workspace / máy cũ không dùng nữa). Bản của chính workspace đang đồng bộ trên máy
         * này thì main từ chối (tắt đồng bộ trước).
         */
        deleteRemote: (workspaceId: string) => CloudResult;
        restore: (req: RestoreRequest) => CloudResult<{ restoredWorkspaceId: string }>;
        /** Đổi phạm vi đồng bộ (tài khoản + từ ngày). Khác phạm vi cũ → tạo bản gốc mới, bản cũ trên R2 bị thay. */
        setScope: (scope: CloudScope) => CloudResult<{ status: DbSyncStatus }>;
        /** Bật/tắt chế độ máy dự phòng cho workspace của máy khác. */
        follow: (req: { workspaceId: string; on: boolean; passphrase?: string }) => CloudResult<{ status: DbSyncStatus }>;
        /**
         * Sau khôi phục: workspace đang mở có đang tạm dừng tự động hoá / còn kênh phải đăng nhập lại không
         * (cờ app_settings 'cloud_restore_paused_automations' / 'cloud_restore_pending_relogin').
         */
        restoreState: () => CloudResult<{ pausedAutomations: boolean; pendingRelogin: boolean }>;
        /** Bước 6 của trình khôi phục: người dùng xác nhận máy cũ đã tắt → bật lại chiến dịch, workflow, lịch ứng dụng. */
        resumeAutomations: () => CloudResult;
    };
}

/** Kênh đẩy từ main → renderer khi trạng thái thay đổi (payload: { area }). */
export const CLOUD_CHANGED_EVENT = 'cloudflare:changed';
export type CloudChangedPayload = { area: 'connection' | 'tunnel' | 'media' | 'db'; at: number };
export const CLOUD_RESTORE_PROGRESS_EVENT = 'cloudflare:restoreProgress';
/** Tiến độ dọn file trên R2 (payload: R2CleanupProgress). */
export const CLOUD_CLEANUP_PROGRESS_EVENT = 'cloudflare:cleanupProgress';

/** Tiền tố đường dẫn khi layout 'single' (cloudflared chuyển nguyên đường dẫn tới server gốc). */
export const SINGLE_HOST_PATH_RULES: ReadonlyArray<{ service: TunnelServiceId; path: string | null; port: number }> = [
    { service: 'payments', path: '^/webhook/', port: 9888 },
    { service: 'workflow', path: '^/api/workflow/webhook/', port: 9889 },
    { service: 'relay', path: null, port: 9900 },
];

/** Tên host khi layout 'split'. */
export function splitHostname(prefix: string, service: TunnelServiceId, zoneName: string): string {
    const suffix = service === 'relay' ? '' : service === 'payments' ? '-pay' : '-hook';
    return `${prefix}${suffix}.${zoneName}`;
}
