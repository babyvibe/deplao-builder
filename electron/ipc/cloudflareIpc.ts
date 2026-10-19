/**
 * cloudflareIpc — IPC cho phần "Internet & Đám mây" (Cloudflare: kết nối, địa chỉ cố định, R2 media, đồng bộ DB).
 *
 * Kênh 'cloudflare:*' (khớp CloudflareIpc trong src/shared/cloudContracts.ts, preload expose window.electronAPI.cloudflare).
 * Gồm cả kho lưu (R2 / Google Drive: storage:*, google:*) và mức sử dụng & chi phí (usage:get).
 * Mọi handler:
 *  - chỉ chạy trên máy chủ với workspace local: máy nhân viên / workspace từ xa bị từ chối (cùng cách kiểm như
 *    pluginIpc: AppModeManager + api/runtime.isWorkspaceAvailable);
 *  - từ chối lời gọi đến từ API v1 / plugin (event giả của IpcInvoker có fromApi) — chỉ giao diện của chủ máy;
 *  - trả { success: true, ...data } hoặc { success: false, error, code }. KHÔNG trả / log token, mật khẩu sao lưu
 *    hay tham số đầu vào.
 * Module tunnel / media / dbsync được require khi gọi (lỗi nạp một module không làm hỏng các kênh khác).
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import Logger, { sanitizeLogText } from '../../src/utils/Logger';
import { CloudError } from '../../src/services/cloudflare/contracts';
import type { CloudDbModule, CloudMediaModule, CloudTunnelModule } from '../../src/services/cloudflare/contracts';
import { cloudflare, tokenTemplateUrl } from '../../src/services/cloudflare/CloudflareService';
import {
    automationsPausedAfterRestore, restorePendingRelogin, resumeAutomationsAfterRestore,
} from '../../src/services/cloudflare/restoreGate';
import { applySyncConfig, readSyncOverview, type SyncFacadeDeps } from '../../src/services/cloudflare/syncFacade';
import {
    CLOUD_CLEANUP_PROGRESS_EVENT, CLOUD_RESTORE_PROGRESS_EVENT, CLOUD_STORAGE_PROVIDERS, normalizeScope, storageLabel,
} from '../../src/shared/cloudContracts';
import type {
    AddressLayout, CloudScope, CloudStorageProvider, DbSyncMode, GoogleClientInput, MediaSyncOptions, R2CleanupProgress, R2CleanupRequest,
    RestoreProgress, RestoreRequest, TunnelAutoConfig, TunnelMode, TunnelServiceId,
} from '../../src/shared/cloudContracts';

// ─── Module (require muộn, có kiểm kiểu) ─────────────────────────────────────

function tunnel(): CloudTunnelModule {
    return (require('../../src/services/cloudflare/tunnel') as typeof import('../../src/services/cloudflare/tunnel')).cloudTunnel;
}

function media(): CloudMediaModule {
    return (require('../../src/services/cloudflare/media') as typeof import('../../src/services/cloudflare/media')).cloudMedia;
}

function db(): CloudDbModule {
    return (require('../../src/services/cloudflare/dbsync') as typeof import('../../src/services/cloudflare/dbsync')).cloudDb;
}

/** "Đồng bộ dữ liệu": một thiết lập chung gọi xuống đúng module DB / media (syncFacade). */
const syncDeps: SyncFacadeDeps = {
    core: () => cloudflare,
    db: () => db(),
    media: () => media(),
    activeWorkspaceId: () => {
        try {
            return require('../../src/utils/WorkspaceManager').default.getInstance().getActiveWorkspace()?.id ?? null;
        } catch {
            return null;
        }
    },
};

// ─── Kiểm quyền ──────────────────────────────────────────────────────────────

function isEmployeeMachine(): boolean {
    try {
        return require('../../src/utils/AppModeManager').default.getInstance().getMode() === 'employee';
    } catch {
        return false;
    }
}

function guard(e: any): void {
    if (e?.fromApi) throw new CloudError('APP_ONLY', 'Cài đặt Cloudflare chỉ dùng được trong app trên máy chủ');
    if (isEmployeeMachine()) throw new CloudError('EMPLOYEE_MACHINE', 'Máy nhân viên không dùng tính năng Cloudflare — hãy cấu hình trên máy chủ');
    const { isWorkspaceAvailable } = require('../../src/services/api/runtime');
    if (!isWorkspaceAvailable()) {
        throw new CloudError('REMOTE_WORKSPACE', 'Workspace từ xa không cấu hình Cloudflare; hãy mở workspace trên máy này');
    }
}

/** Lỗi bình thường (UI hỏi trạng thái trên máy nhân viên…) — không ghi log. */
const QUIET_CODES = new Set(['APP_ONLY', 'EMPLOYEE_MACHINE', 'REMOTE_WORKSPACE', 'NOT_CONNECTED', 'BAD_INPUT', 'CANCELLED', 'STORAGE_SWITCH_BLOCKED']);

function fail(channel: string, err: unknown): { success: false; error: string; code: string; retryAfterMs?: number } {
    if (err instanceof CloudError) {
        if (!QUIET_CODES.has(err.code)) Logger.warn(`[cloudflareIpc] ${channel}: ${err.code} — ${sanitizeLogText(err.message, 300)}`);
        const out: { success: false; error: string; code: string; retryAfterMs?: number } = { success: false, error: err.message, code: err.code };
        if (err.retryAfterMs) out.retryAfterMs = err.retryAfterMs;
        return out;
    }
    const message = sanitizeLogText(String((err as any)?.message || err || 'Lỗi không xác định'), 500);
    Logger.error(`[cloudflareIpc] ${channel}: ${message}`);
    const code = typeof (err as any)?.code === 'string' ? String((err as any).code) : 'INTERNAL';
    return { success: false, error: message, code };
}

type Payload = Record<string, unknown> | void;

function handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: any) => Promise<Payload> | Payload): void {
    ipcMain.handle(channel, async (e: IpcMainInvokeEvent, arg: any) => {
        try {
            guard(e);
            const data = (await fn(e, arg)) as Record<string, unknown> | undefined;
            return { success: true, ...(data ?? {}) };
        } catch (err) {
            return fail(channel, err);
        }
    });
}

// ─── Kiểm đầu vào ────────────────────────────────────────────────────────────

const TUNNEL_MODES: ReadonlyArray<TunnelMode> = ['quick', 'ngrok', 'cloudflare_auto', 'cloudflare_manual'];
const SERVICES: ReadonlyArray<TunnelServiceId> = ['relay', 'payments', 'workflow'];
const DB_MODES: ReadonlyArray<DbSyncMode> = ['off', 'hourly', 'realtime'];
const LAYOUTS: ReadonlyArray<AddressLayout> = ['single', 'split'];

function bad(message: string): CloudError {
    return new CloudError('BAD_INPUT', message);
}

function obj(v: unknown): Record<string, any> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

function oneOf<T extends string>(v: unknown, allowed: ReadonlyArray<T>, label: string): T {
    if (typeof v === 'string' && (allowed as ReadonlyArray<string>).includes(v)) return v as T;
    throw bad(`${label} không hợp lệ`);
}

function bool(v: unknown, label: string): boolean {
    if (typeof v === 'boolean') return v;
    throw bad(`${label} không hợp lệ`);
}

function str(v: unknown, label: string, max: number): string {
    if (typeof v !== 'string') throw bad(`Thiếu ${label}`);
    const s = v.trim();
    if (!s) throw bad(`Thiếu ${label}`);
    if (s.length > max) throw bad(`${label} quá dài`);
    return s;
}

function optStr(v: unknown, label: string, max: number): string | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    return str(v, label, max);
}

function num(v: unknown, label: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${label} không hợp lệ`);
    return v;
}

/** Mật khẩu sao lưu: giữ nguyên (không trim), chỉ kiểm kiểu/độ dài. Không bao giờ log. */
function passphraseArg(v: unknown): string {
    if (typeof v !== 'string' || v.length === 0) throw bad('Thiếu mật khẩu sao lưu');
    if (v.length > 1024) throw bad('Mật khẩu sao lưu quá dài');
    return v;
}

function optPassphrase(v: unknown): string | undefined {
    return v === undefined || v === null || v === '' ? undefined : passphraseArg(v);
}

function autoConfigArg(v: unknown): TunnelAutoConfig {
    const o = obj(v);
    return {
        zoneId: str(o.zoneId, 'tên miền', 64),
        zoneName: str(o.zoneName, 'tên miền', 253),
        hostPrefix: str(o.hostPrefix, 'tiền tố địa chỉ', 63),
        layout: oneOf(o.layout ?? 'single', LAYOUTS, 'Kiểu địa chỉ'),
    };
}

function mediaOptionsArg(v: unknown): Partial<MediaSyncOptions> {
    const o = obj(v);
    const out: Partial<MediaSyncOptions> = {};
    if (o.concurrency !== undefined) out.concurrency = num(o.concurrency, 'Số file tải song song', 1, 16);
    if (o.nightOnly !== undefined) out.nightOnly = bool(o.nightOnly, 'Chỉ chạy ban đêm');
    if (o.bandwidthKbps !== undefined) out.bandwidthKbps = num(o.bandwidthKbps, 'Giới hạn băng thông', 0, 10_000_000);
    if (o.evictEnabled !== undefined) out.evictEnabled = bool(o.evictEnabled, 'Giải phóng ổ đĩa');
    if (o.evictKeepDays !== undefined) out.evictKeepDays = num(o.evictKeepDays, 'Số ngày giữ file', 1, 3650);
    if (o.evictMinFreeGb !== undefined) out.evictMinFreeGb = num(o.evictMinFreeGb, 'Dung lượng trống tối thiểu', 0, 100_000);
    if (o.scope !== undefined) out.scope = scopeArg(o.scope);
    if (o.includeShared !== undefined) out.includeShared = bool(o.includeShared, 'File chung');
    return out;
}

/** Client OAuth riêng của Google: null / bỏ trống = client chung của Deplao. Secret không trim, không log. */
function googleClientArg(v: unknown): GoogleClientInput | null {
    if (v === undefined || v === null) return null;
    const o = obj(v);
    const clientId = str(o.clientId, 'Client ID Google', 256);
    let clientSecret: string | null = null;
    if (o.clientSecret !== undefined && o.clientSecret !== null && o.clientSecret !== '') {
        if (typeof o.clientSecret !== 'string' || o.clientSecret.length > 256) throw bad('Client secret Google không hợp lệ');
        clientSecret = o.clientSecret.trim();
    }
    return { clientId, clientSecret };
}

/**
 * Điều kiện đổi kho: đồng bộ (dữ liệu + ảnh) đang tắt, máy không làm máy dự phòng, không còn file chỉ nằm trên kho cũ
 * (đã dọn khỏi máy) ở workspace đang mở. Workspace khác còn file như vậy sẽ tự dừng đổi kho khi mở (MediaContext).
 * Trả lý do chặn (câu cho người dùng) hoặc null.
 */
function storageSwitchBlocker(): string | null {
    const label = storageLabel(cloudflare.storageProvider());
    try {
        const dbStatus = db().status();
        if (dbStatus.following) return 'Máy này đang làm máy dự phòng — tắt theo dõi trước khi đổi kho lưu.';
        if (dbStatus.mode !== 'off') return 'Tắt đồng bộ trước khi đổi kho lưu.';
    } catch { /* module chưa nạp: không có gì đang chạy */ }
    try {
        const mediaStatus = media().status();
        if (mediaStatus.enabled) return 'Tắt đồng bộ ảnh, file trước khi đổi kho lưu.';
        const evicted = Number(mediaStatus.totals?.evicted) || 0;
        if (evicted > 0) {
            return `Còn ${evicted.toLocaleString('vi-VN')} file chỉ nằm trên ${label} (đã dọn khỏi máy). Bật lại đồng bộ, vào `
                + 'Nâng cao → Tải lại toàn bộ file đã dọn, chờ tải xong rồi tắt đồng bộ và đổi kho.';
        }
    } catch { /* module chưa nạp */ }
    return null;
}

/** Phạm vi (tài khoản + từ ngày): chọn tài khoản mà danh sách rỗng là lỗi (không đồng bộ gì thì tắt hẳn). */
function scopeArg(v: unknown): CloudScope {
    const o = obj(v);
    if (o.accounts !== 'all' && !Array.isArray(o.accounts)) throw bad('Phạm vi tài khoản không hợp lệ');
    if (o.fromTs !== undefined && o.fromTs !== null) num(o.fromTs, 'Ngày bắt đầu', 1, 8.64e15);
    const scope = normalizeScope(o);
    if (Array.isArray(scope.accounts) && scope.accounts.length === 0) throw bad('Chọn ít nhất một tài khoản');
    return scope;
}

/** Tiêu chí dọn R2: phải bật ít nhất một tiêu chí; danh sách tài khoản / mốc ngày đúng kiểu. */
function cleanupArg(v: unknown): R2CleanupRequest {
    const o = obj(v);
    const req: R2CleanupRequest = {};
    if (o.orphans !== undefined) req.orphans = bool(o.orphans, 'File của tin đã xoá');
    if (o.outOfScope !== undefined) req.outOfScope = bool(o.outOfScope, 'File ngoài phạm vi');
    if (o.includeCloudOnly !== undefined) req.includeCloudOnly = bool(o.includeCloudOnly, 'File chỉ còn trên R2');
    if (o.deleteLocalOrphans !== undefined) req.deleteLocalOrphans = bool(o.deleteLocalOrphans, 'Xoá file trên máy');
    if (o.olderThanTs !== undefined && o.olderThanTs !== null) req.olderThanTs = num(o.olderThanTs, 'Mốc ngày', 1, 8.64e15);
    if (o.accounts !== undefined && o.accounts !== null) {
        if (!Array.isArray(o.accounts)) throw bad('Danh sách tài khoản không hợp lệ');
        const scope = normalizeScope({ accounts: o.accounts });
        req.accounts = Array.isArray(scope.accounts) ? scope.accounts : [];
    }
    if (!req.orphans && !req.outOfScope && !req.olderThanTs && !(req.accounts && req.accounts.length)) {
        throw bad('Chọn ít nhất một loại file cần dọn');
    }
    return req;
}

function restoreArg(v: unknown): RestoreRequest {
    const o = obj(v);
    const req: RestoreRequest = { workspaceId: str(o.workspaceId, 'workspace', 200) };
    const passphrase = optPassphrase(o.passphrase);
    if (passphrase !== undefined) req.passphrase = passphrase;
    if (o.untilTs !== undefined && o.untilTs !== null) req.untilTs = num(o.untilTs, 'Thời điểm khôi phục', 0, 8.64e15);
    return req;
}

function followArg(v: unknown): { workspaceId: string; on: boolean; passphrase?: string } {
    const o = obj(v);
    const req: { workspaceId: string; on: boolean; passphrase?: string } = {
        workspaceId: str(o.workspaceId, 'workspace', 200),
        on: bool(o.on, 'Bật/tắt máy dự phòng'),
    };
    const passphrase = optPassphrase(o.passphrase);
    if (passphrase !== undefined) req.passphrase = passphrase;
    return req;
}

// ─── Đăng ký ─────────────────────────────────────────────────────────────────

export function registerCloudflareIpc(): void {
    // ── Kết nối ──
    handle('cloudflare:status', () => {
        const connection = cloudflare.status();
        // Lần đầu mở trang sau khi khởi động: làm mới quyền / tên miền ở nền, kết quả về qua CLOUD_CHANGED_EVENT.
        if (connection.connected && connection.checkedAt === null) {
            cloudflare.recheck().catch(err => Logger.warn(`[cloudflareIpc] recheck nền: ${sanitizeLogText(String(err?.message || err), 300)}`));
        }
        return { connection };
    });

    handle('cloudflare:connect', async (_e, arg) => {
        const o = obj(arg);
        const connection = await cloudflare.connect({ accountId: str(o.accountId, 'Account ID', 64), token: str(o.token, 'token Cloudflare', 512) });
        return { connection };
    });

    handle('cloudflare:disconnect', async () => {
        await cloudflare.disconnect();
    });

    handle('cloudflare:recheck', async () => ({ connection: await cloudflare.recheck() }));

    handle('cloudflare:tokenTemplateUrl', () => ({ url: tokenTemplateUrl() }));

    // ── Kho lưu (R2 / Google Drive) ──
    handle('cloudflare:storage:status', () => ({ storage: cloudflare.storageStatus() }));

    handle('cloudflare:storage:setProvider', async (_e, arg) => {
        const provider = oneOf(obj(arg).provider, CLOUD_STORAGE_PROVIDERS as ReadonlyArray<CloudStorageProvider>, 'Kho lưu');
        return { storage: await cloudflare.setStorageProvider(provider, storageSwitchBlocker) };
    });

    // ── Google Drive (đăng nhập Google trên trình duyệt của máy) ──
    handle('cloudflare:google:connect', async (_e, arg) => {
        await cloudflare.google.connect(googleClientArg(obj(arg).client));
        return { storage: cloudflare.storageStatus() };
    });

    handle('cloudflare:google:cancelConnect', () => {
        cloudflare.google.cancelConnect();
    });

    handle('cloudflare:google:disconnect', async () => {
        await cloudflare.google.disconnect();
        return { storage: cloudflare.storageStatus() };
    });

    handle('cloudflare:google:refresh', async () => {
        await cloudflare.google.refresh();
        return { storage: cloudflare.storageStatus() };
    });

    // ── Mức sử dụng & chi phí ──
    handle('cloudflare:usage:get', async (_e, arg) => {
        const o = obj(arg);
        const refresh = o.refresh === undefined ? false : bool(o.refresh, 'Đọc lại');
        return { report: await cloudflare.usage.report({ refresh }) };
    });

    // ── Địa chỉ Internet (tunnel) ──
    handle('cloudflare:tunnel:getConfig', () => ({ config: tunnel().getConfig() }));

    handle('cloudflare:tunnel:setMode', async (_e, arg) => ({
        config: await tunnel().setMode(oneOf(obj(arg).mode, TUNNEL_MODES, 'Cách tạo địa chỉ')),
    }));

    handle('cloudflare:tunnel:configureAuto', async (_e, arg) => {
        const res = await tunnel().configureAuto(autoConfigArg(arg));
        return { config: res.config, addresses: res.addresses };
    });

    handle('cloudflare:tunnel:setAutoStart', async (_e, arg) => {
        await tunnel().setAutoStart(bool(obj(arg).on, 'Tự bật khi mở app'));
    });

    handle('cloudflare:tunnel:setServiceEnabled', async (_e, arg) => {
        const o = obj(arg);
        const addresses = await tunnel().setServiceEnabled(oneOf(o.service, SERVICES, 'Dịch vụ'), bool(o.enabled, 'Bật/tắt dịch vụ'));
        return { addresses };
    });

    handle('cloudflare:tunnel:addresses', () => ({ addresses: tunnel().addresses() }));

    handle('cloudflare:tunnel:health', async (_e, arg) => ({ health: await tunnel().health({ refresh: obj(arg).refresh === true }) }));

    handle('cloudflare:tunnel:moveHere', async () => ({ addresses: await tunnel().moveHere() }));

    handle('cloudflare:tunnel:disconnectForeign', async () => {
        await tunnel().disconnectForeign();
    });

    handle('cloudflare:tunnel:teardown', async () => {
        await tunnel().teardown();
    });

    // ── R2 media ──
    handle('cloudflare:media:status', () => ({ status: media().status() }));

    handle('cloudflare:media:setEnabled', async (_e, arg) => ({
        status: await media().setEnabled(bool(obj(arg).on, 'Bật/tắt sao lưu media')),
    }));

    handle('cloudflare:media:pause', () => {
        media().pause();
    });

    handle('cloudflare:media:resume', () => {
        media().resume();
    });

    handle('cloudflare:media:setOptions', async (_e, arg) => ({ status: await media().setOptions(mediaOptionsArg(arg)) }));

    handle('cloudflare:media:cleanupPreview', async (e, arg) => {
        const req = cleanupArg(arg);
        const sender = e.sender;
        const onProgress = (p: R2CleanupProgress) => {
            try {
                if (!sender.isDestroyed()) sender.send(CLOUD_CLEANUP_PROGRESS_EVENT, p);
            } catch { /* cửa sổ đã đóng */ }
        };
        return { preview: await media().cleanupPreview(req, onProgress) };
    });

    handle('cloudflare:media:cleanupRun', async (e, arg) => {
        const previewId = str(obj(arg).previewId, 'mã lần quét', 100);
        const sender = e.sender;
        const onProgress = (p: R2CleanupProgress) => {
            try {
                if (!sender.isDestroyed()) sender.send(CLOUD_CLEANUP_PROGRESS_EVENT, p);
            } catch { /* cửa sổ đã đóng */ }
        };
        return { result: await media().cleanupRun(previewId, onProgress) };
    });

    handle('cloudflare:media:rehydrateAll', async () => {
        await media().rehydrateAll();
    });

    // ── Đồng bộ dữ liệu (một thiết lập chung: tài khoản + từ ngày + chế độ + kèm ảnh/file) ──
    handle('cloudflare:sync:get', () => ({ overview: readSyncOverview(syncDeps) }));

    handle('cloudflare:sync:apply', async (_e, arg) => {
        const o = obj(arg);
        return applySyncConfig(syncDeps, {
            mode: oneOf(o.mode, DB_MODES, 'Chế độ đồng bộ'),
            scope: scopeArg(o.scope),
            includeMedia: bool(o.includeMedia, 'Kèm ảnh, video, file'),
            includeShared: bool(o.includeShared ?? true, 'File chung'),
        });
    });

    // ── Đồng bộ DB ──
    handle('cloudflare:db:status', () => ({ status: db().status() }));

    handle('cloudflare:db:setMode', async (_e, arg) => ({
        status: await db().setMode(oneOf(obj(arg).mode, DB_MODES, 'Chế độ đồng bộ')),
    }));

    handle('cloudflare:db:setScope', async (_e, arg) => ({ status: await db().setScope(scopeArg(arg)) }));

    handle('cloudflare:db:setPassphrase', async (_e, arg) => {
        await db().setPassphrase(passphraseArg(obj(arg).passphrase));
    });

    handle('cloudflare:db:syncNow', async () => {
        await db().syncNow();
    });

    handle('cloudflare:db:log', (_e, arg) => {
        const o = obj(arg);
        const opts: { workspaceId?: string; limit?: number } = {};
        const workspaceId = optStr(o.workspaceId, 'workspace', 200);
        if (workspaceId) opts.workspaceId = workspaceId;
        if (o.limit !== undefined && o.limit !== null) opts.limit = Math.floor(num(o.limit, 'Số dòng', 1, 5000));
        return { entries: db().log(opts) };
    });

    handle('cloudflare:db:listRemote', async () => ({ copies: await db().listRemote() }));

    handle('cloudflare:db:deleteRemote', async (_e, arg) => {
        await db().deleteRemote(str(obj(arg).workspaceId, 'workspace', 300));
    });

    handle('cloudflare:db:restore', async (e, arg) => {
        const req = restoreArg(arg);
        const sender = e.sender;
        const onProgress = (p: RestoreProgress) => {
            try {
                if (!sender.isDestroyed()) sender.send(CLOUD_RESTORE_PROGRESS_EVENT, p);
            } catch { /* cửa sổ đã đóng */ }
        };
        const res = await db().restore(req, onProgress);
        return { restoredWorkspaceId: res.restoredWorkspaceId };
    });

    handle('cloudflare:db:follow', async (_e, arg) => ({ status: await db().follow(followArg(arg)) }));

    handle('cloudflare:db:restoreState', () => ({
        pausedAutomations: automationsPausedAfterRestore(),
        pendingRelogin: restorePendingRelogin(),
    }));

    handle('cloudflare:db:resumeAutomations', () => {
        resumeAutomationsAfterRestore();
        cloudflare.notifyChanged('db');
    });
}
