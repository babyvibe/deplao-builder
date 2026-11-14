/**
 * cloudflareIpc: IPC for the "Internet & Cloud" section (Cloudflare: connection, fixed address, R2 media, DB sync).
 *
 * Channel 'cloudflare:*' (matches CloudflareIpc in src/shared/cloud/cloudContracts.ts; the preload exposes window.electronAPI.cloudflare).
 * Also covers storage (R2 / Google Drive: storage:*, google:*) and usage & cost (usage:get).
 * Every handler:
 *  - only runs on the host machine with a local workspace: employee machines / remote workspaces are rejected (same check as
 *    pluginIpc: AppModeManager + api/runtime.isWorkspaceAvailable);
 *  - rejects calls from API v1 / plugins (IpcInvoker's fake event with fromApi): only the machine owner's UI.
 *    The only exception: cloudflare:workers:* (Worker + D1 for apps) is registered in cloudflareWorkersIpc.ts with its own guard:
 *    an app may call it when PluginApiBridge has checked the "cloudflare:workers" permission + prefix and issued a grant;
 *  - returns { success: true, ...data } or { success: false, error, code }. NEVER returns or logs tokens, backup passwords
 *    or input parameters.
 * The tunnel / media / dbsync modules are required at call time (a module load error does not break the other channels).
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import Logger, { sanitizeLogText } from '../../../src/utils/Logger';
import { CloudError } from '../../../src/services/cloudflare/contracts';
import type { CloudDbModule, CloudMediaModule, CloudTunnelModule } from '../../../src/services/cloudflare/contracts';
import { cloudflare, tokenTemplateUrl } from '../../../src/services/cloudflare/CloudflareService';
import {
    automationsPausedAfterRestore, restorePendingRelogin, resumeAutomationsAfterRestore,
} from '../../../src/services/cloudflare/restoreGate';
import { applySyncConfig, readSyncOverview, type SyncFacadeDeps } from '../../../src/services/cloudflare/syncFacade';
import { registerCloudflareWorkersIpc } from './cloudflareWorkersIpc';
import {
    CLOUD_CLEANUP_PROGRESS_EVENT, CLOUD_RESTORE_PROGRESS_EVENT, CLOUD_STORAGE_PROVIDERS, normalizeScope, storageLabel,
} from '../../../src/shared/cloud/cloudContracts';
import type {
    AddressLayout, CloudScope, CloudStorageProvider, DbSyncMode, GoogleClientInput, MediaSyncOptions, R2CleanupProgress, R2CleanupRequest,
    RestoreProgress, RestoreRequest, TunnelAutoConfig, TunnelMode, TunnelServiceId,
} from '../../../src/shared/cloud/cloudContracts';
import { tr, appLocale } from '../../../src/shared/i18n';

// ─── Modules (lazy require, type-checked) ─────────────────────────────────────

function tunnel(): CloudTunnelModule {
    return (require('../../../src/services/cloudflare/tunnel') as typeof import('../../../src/services/cloudflare/tunnel')).cloudTunnel;
}

function media(): CloudMediaModule {
    return (require('../../../src/services/cloudflare/media') as typeof import('../../../src/services/cloudflare/media')).cloudMedia;
}

function db(): CloudDbModule {
    return (require('../../../src/services/cloudflare/dbsync') as typeof import('../../../src/services/cloudflare/dbsync')).cloudDb;
}

/** "Đồng bộ dữ liệu" (Data sync): one shared setup that calls the right DB / media module (syncFacade). */
const syncDeps: SyncFacadeDeps = {
    core: () => cloudflare,
    db: () => db(),
    media: () => media(),
    activeWorkspaceId: () => {
        try {
            return require('../../../src/utils/app/WorkspaceManager').default.getInstance().getActiveWorkspace()?.id ?? null;
        } catch {
            return null;
        }
    },
};

// ─── Permission checks ──────────────────────────────────────────────────────────────

function isEmployeeMachine(): boolean {
    try {
        return require('../../../src/utils/app/AppModeManager').default.getInstance().getMode() === 'employee';
    } catch {
        return false;
    }
}

function guard(e: any): void {
    if (e?.fromApi) throw new CloudError('APP_ONLY', tr('Cài đặt Cloudflare chỉ dùng được trong app trên máy chủ'));
    if (isEmployeeMachine()) throw new CloudError('EMPLOYEE_MACHINE', tr('Máy nhân viên không dùng tính năng Cloudflare — hãy cấu hình trên máy chủ'));
    const { isWorkspaceAvailable } = require('../../../src/services/api/runtime');
    if (!isWorkspaceAvailable()) {
        throw new CloudError('REMOTE_WORKSPACE', tr('Workspace từ xa không cấu hình Cloudflare; hãy mở workspace trên máy này'));
    }
}

/** Expected errors (the UI asks the status on an employee machine…), not logged. */
const QUIET_CODES = new Set(['APP_ONLY', 'EMPLOYEE_MACHINE', 'REMOTE_WORKSPACE', 'NOT_CONNECTED', 'BAD_INPUT', 'CANCELLED', 'STORAGE_SWITCH_BLOCKED']);

function fail(channel: string, err: unknown): { success: false; error: string; code: string; retryAfterMs?: number } {
    if (err instanceof CloudError) {
        if (!QUIET_CODES.has(err.code)) Logger.warn(`[cloudflareIpc] ${channel}: ${err.code} — ${sanitizeLogText(err.message, 300)}`);
        const out: { success: false; error: string; code: string; retryAfterMs?: number } = { success: false, error: err.message, code: err.code };
        if (err.retryAfterMs) out.retryAfterMs = err.retryAfterMs;
        return out;
    }
    const message = sanitizeLogText(String((err as any)?.message || err || tr('Lỗi không xác định')), 500);
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

// ─── Input validation ────────────────────────────────────────────────────────────

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
    throw bad(tr('{{label}} không hợp lệ', { label }));
}

function bool(v: unknown, label: string): boolean {
    if (typeof v === 'boolean') return v;
    throw bad(tr('{{label}} không hợp lệ', { label }));
}

function str(v: unknown, label: string, max: number): string {
    if (typeof v !== 'string') throw bad(tr('Thiếu {{label}}', { label }));
    const s = v.trim();
    if (!s) throw bad(tr('Thiếu {{label}}', { label }));
    if (s.length > max) throw bad(tr('{{label}} quá dài', { label }));
    return s;
}

function optStr(v: unknown, label: string, max: number): string | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    return str(v, label, max);
}

function num(v: unknown, label: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(tr('{{label}} không hợp lệ', { label }));
    return v;
}

/** Backup password: kept as is (not trimmed), only the type and length are checked. Never logged. */
function passphraseArg(v: unknown): string {
    if (typeof v !== 'string' || v.length === 0) throw bad(tr('Thiếu mật khẩu sao lưu'));
    if (v.length > 1024) throw bad(tr('Mật khẩu sao lưu quá dài'));
    return v;
}

function optPassphrase(v: unknown): string | undefined {
    return v === undefined || v === null || v === '' ? undefined : passphraseArg(v);
}

function autoConfigArg(v: unknown): TunnelAutoConfig {
    const o = obj(v);
    return {
        zoneId: str(o.zoneId, tr('tên miền'), 64),
        zoneName: str(o.zoneName, tr('tên miền'), 253),
        hostPrefix: str(o.hostPrefix, tr('tiền tố địa chỉ'), 63),
        layout: oneOf(o.layout ?? 'single', LAYOUTS, tr('Kiểu địa chỉ')),
    };
}

function mediaOptionsArg(v: unknown): Partial<MediaSyncOptions> {
    const o = obj(v);
    const out: Partial<MediaSyncOptions> = {};
    if (o.concurrency !== undefined) out.concurrency = num(o.concurrency, tr('Số file tải song song'), 1, 16);
    if (o.nightOnly !== undefined) out.nightOnly = bool(o.nightOnly, tr('Chỉ chạy ban đêm'));
    if (o.bandwidthKbps !== undefined) out.bandwidthKbps = num(o.bandwidthKbps, tr('Giới hạn băng thông'), 0, 10_000_000);
    if (o.evictEnabled !== undefined) out.evictEnabled = bool(o.evictEnabled, tr('Giải phóng ổ đĩa'));
    if (o.evictKeepDays !== undefined) out.evictKeepDays = num(o.evictKeepDays, tr('Số ngày giữ file'), 1, 3650);
    if (o.evictMinFreeGb !== undefined) out.evictMinFreeGb = num(o.evictMinFreeGb, tr('Dung lượng trống tối thiểu'), 0, 100_000);
    if (o.scope !== undefined) out.scope = scopeArg(o.scope);
    if (o.includeShared !== undefined) out.includeShared = bool(o.includeShared, 'File chung');
    return out;
}

/** Google's own OAuth client: null / empty = Deplao's shared client. The secret is not trimmed and not logged. */
function googleClientArg(v: unknown): GoogleClientInput | null {
    if (v === undefined || v === null) return null;
    const o = obj(v);
    const clientId = str(o.clientId, 'Client ID Google', 256);
    let clientSecret: string | null = null;
    if (o.clientSecret !== undefined && o.clientSecret !== null && o.clientSecret !== '') {
        if (typeof o.clientSecret !== 'string' || o.clientSecret.length > 256) throw bad(tr('Client secret Google không hợp lệ'));
        clientSecret = o.clientSecret.trim();
    }
    return { clientId, clientSecret };
}

/**
 * Conditions for switching storage: sync (data + images) is off, the machine is not a standby machine, and no file exists only in the old storage
 * (already removed from the machine) in the open workspace. Another workspace that still has such files stops the switch when it is opened (MediaContext).
 * Returns the blocking reason (the sentence shown to the user) or null.
 */
function storageSwitchBlocker(): string | null {
    const label = storageLabel(cloudflare.storageProvider());
    try {
        const dbStatus = db().status();
        if (dbStatus.following) return tr('Máy này đang làm máy dự phòng — tắt theo dõi trước khi đổi kho lưu.');
        if (dbStatus.mode !== 'off') return tr('Tắt đồng bộ trước khi đổi kho lưu.');
    } catch { /* module not loaded yet: nothing is running */ }
    try {
        const mediaStatus = media().status();
        if (mediaStatus.enabled) return tr('Tắt đồng bộ ảnh, file trước khi đổi kho lưu.');
        const evicted = Number(mediaStatus.totals?.evicted) || 0;
        if (evicted > 0) {
            return tr('Còn {{v1}} file chỉ nằm trên {{label}} (đã dọn khỏi máy). Bật lại đồng bộ, vào Nâng cao → Tải lại toàn bộ file đã dọn, chờ tải xong rồi tắt đồng bộ và đổi kho.', { v1: evicted.toLocaleString(appLocale()), label });
        }
    } catch { /* module not loaded yet */ }
    return null;
}

/** Scope (accounts + from date): an empty account selection is an error (if nothing syncs, turn sync off entirely). */
function scopeArg(v: unknown): CloudScope {
    const o = obj(v);
    if (o.accounts !== 'all' && !Array.isArray(o.accounts)) throw bad(tr('Phạm vi tài khoản không hợp lệ'));
    if (o.fromTs !== undefined && o.fromTs !== null) num(o.fromTs, tr('Ngày bắt đầu'), 1, 8.64e15);
    const scope = normalizeScope(o);
    if (Array.isArray(scope.accounts) && scope.accounts.length === 0) throw bad(tr('Chọn ít nhất một tài khoản'));
    return scope;
}

/** R2 cleanup criteria: at least one criterion must be enabled; the account list / date cutoff must have the right type. */
function cleanupArg(v: unknown): R2CleanupRequest {
    const o = obj(v);
    const req: R2CleanupRequest = {};
    if (o.orphans !== undefined) req.orphans = bool(o.orphans, tr('File của tin đã xoá'));
    if (o.outOfScope !== undefined) req.outOfScope = bool(o.outOfScope, tr('File ngoài phạm vi'));
    if (o.includeCloudOnly !== undefined) req.includeCloudOnly = bool(o.includeCloudOnly, tr('File chỉ còn trên R2'));
    if (o.deleteLocalOrphans !== undefined) req.deleteLocalOrphans = bool(o.deleteLocalOrphans, tr('Xoá file trên máy'));
    if (o.olderThanTs !== undefined && o.olderThanTs !== null) req.olderThanTs = num(o.olderThanTs, tr('Mốc ngày'), 1, 8.64e15);
    if (o.accounts !== undefined && o.accounts !== null) {
        if (!Array.isArray(o.accounts)) throw bad(tr('Danh sách tài khoản không hợp lệ'));
        const scope = normalizeScope({ accounts: o.accounts });
        req.accounts = Array.isArray(scope.accounts) ? scope.accounts : [];
    }
    if (!req.orphans && !req.outOfScope && !req.olderThanTs && !(req.accounts && req.accounts.length)) {
        throw bad(tr('Chọn ít nhất một loại file cần dọn'));
    }
    return req;
}

function restoreArg(v: unknown): RestoreRequest {
    const o = obj(v);
    const req: RestoreRequest = { workspaceId: str(o.workspaceId, 'workspace', 200) };
    const passphrase = optPassphrase(o.passphrase);
    if (passphrase !== undefined) req.passphrase = passphrase;
    if (o.untilTs !== undefined && o.untilTs !== null) req.untilTs = num(o.untilTs, tr('Thời điểm khôi phục'), 0, 8.64e15);
    return req;
}

function followArg(v: unknown): { workspaceId: string; on: boolean; passphrase?: string } {
    const o = obj(v);
    const req: { workspaceId: string; on: boolean; passphrase?: string } = {
        workspaceId: str(o.workspaceId, 'workspace', 200),
        on: bool(o.on, tr('Bật/tắt máy dự phòng')),
    };
    const passphrase = optPassphrase(o.passphrase);
    if (passphrase !== undefined) req.passphrase = passphrase;
    return req;
}

// ─── Registration ─────────────────────────────────────────────────────────────────

export function registerCloudflareIpc(): void {
    // ── Connection ──
    handle('cloudflare:status', () => {
        const connection = cloudflare.status();
        // First time the page opens after startup: refresh permissions / domain in the background; the result comes back via CLOUD_CHANGED_EVENT.
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

    // ── Storage (R2 / Google Drive) ──
    handle('cloudflare:storage:status', () => ({ storage: cloudflare.storageStatus() }));

    handle('cloudflare:storage:setProvider', async (_e, arg) => {
        const provider = oneOf(obj(arg).provider, CLOUD_STORAGE_PROVIDERS as ReadonlyArray<CloudStorageProvider>, tr('Kho lưu'));
        return { storage: await cloudflare.setStorageProvider(provider, storageSwitchBlocker) };
    });

    // ── Google Drive (Google sign-in in the machine's browser) ──
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

    // ── Usage & cost ──
    handle('cloudflare:usage:get', async (_e, arg) => {
        const o = obj(arg);
        const refresh = o.refresh === undefined ? false : bool(o.refresh, tr('Đọc lại'));
        return { report: await cloudflare.usage.report({ refresh }) };
    });

    // ── Internet address (tunnel) ──
    handle('cloudflare:tunnel:getConfig', () => ({ config: tunnel().getConfig() }));

    handle('cloudflare:tunnel:setMode', async (_e, arg) => ({
        config: await tunnel().setMode(oneOf(obj(arg).mode, TUNNEL_MODES, tr('Cách tạo địa chỉ'))),
    }));

    handle('cloudflare:tunnel:configureAuto', async (_e, arg) => {
        const res = await tunnel().configureAuto(autoConfigArg(arg));
        return { config: res.config, addresses: res.addresses };
    });

    handle('cloudflare:tunnel:setAutoStart', async (_e, arg) => {
        await tunnel().setAutoStart(bool(obj(arg).on, tr('Tự bật khi mở app')));
    });

    handle('cloudflare:tunnel:setServiceEnabled', async (_e, arg) => {
        const o = obj(arg);
        const addresses = await tunnel().setServiceEnabled(oneOf(o.service, SERVICES, tr('Dịch vụ')), bool(o.enabled, tr('Bật/tắt dịch vụ')));
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
        status: await media().setEnabled(bool(obj(arg).on, tr('Bật/tắt sao lưu media'))),
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
            } catch { /* window closed */ }
        };
        return { preview: await media().cleanupPreview(req, onProgress) };
    });

    handle('cloudflare:media:cleanupRun', async (e, arg) => {
        const previewId = str(obj(arg).previewId, tr('mã lần quét'), 100);
        const sender = e.sender;
        const onProgress = (p: R2CleanupProgress) => {
            try {
                if (!sender.isDestroyed()) sender.send(CLOUD_CLEANUP_PROGRESS_EVENT, p);
            } catch { /* window closed */ }
        };
        return { result: await media().cleanupRun(previewId, onProgress) };
    });

    handle('cloudflare:media:rehydrateAll', async () => {
        await media().rehydrateAll();
    });

    // ── Data sync (one shared setting: accounts + from date + mode + images/files included) ──
    handle('cloudflare:sync:get', () => ({ overview: readSyncOverview(syncDeps) }));

    handle('cloudflare:sync:apply', async (_e, arg) => {
        const o = obj(arg);
        return applySyncConfig(syncDeps, {
            mode: oneOf(o.mode, DB_MODES, tr('Chế độ đồng bộ')),
            scope: scopeArg(o.scope),
            includeMedia: bool(o.includeMedia, tr('Kèm ảnh, video, file')),
            includeShared: bool(o.includeShared ?? true, 'File chung'),
        });
    });

    // ── DB sync ──
    handle('cloudflare:db:status', () => ({ status: db().status() }));

    handle('cloudflare:db:setMode', async (_e, arg) => ({
        status: await db().setMode(oneOf(obj(arg).mode, DB_MODES, tr('Chế độ đồng bộ'))),
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
        if (o.limit !== undefined && o.limit !== null) opts.limit = Math.floor(num(o.limit, tr('Số dòng'), 1, 5000));
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
            } catch { /* window closed */ }
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

    // ── Worker + D1 for apps (cloudflare:workers:*) - own guard: the app holds a PluginApiBridge grant ──
    registerCloudflareWorkersIpc();
}
