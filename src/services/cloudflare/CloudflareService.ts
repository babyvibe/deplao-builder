/**
 * CloudflareService — lõi dùng chung của tính năng "Internet & Đám mây" (singleton `cloudflare`).
 *
 *  - connect: kiểm token (tokens/verify; token 'cfat_' là token của tài khoản) → liệt kê tên miền → thử quyền
 *    từng tính năng (tunnel, R2, Worker + D1 cho ứng dụng — không bắt buộc) bằng các GET rẻ → lưu token (safeStorage)
 *    + tokenId + tokenKind.
 *  - status(): trạng thái nhớ trong RAM (không gọi mạng). recheck() thử lại quyền.
 *  - api(): client REST dùng chung (ngân sách 100 request / 5 phút cho cả app). r2(bucket) / store(bucket): client của
 *    KHO ĐANG CHỌN — R2 (S3 theo bucket) hoặc Google Drive (thư mục Deplao/<bucket>, ./gdrive) — media và đồng bộ DB chỉ
 *    gọi qua đây nên chạy được trên cả hai kho. google: đăng nhập Google Drive; usage: đếm thao tác + ước tính chi phí.
 *  - notifyChanged(area): đẩy CLOUD_CHANGED_EVENT tới mọi cửa sổ + listener trong main.
 *
 * Token và mật khẩu sao lưu KHÔNG BAO GIỜ được log hay trả về renderer.
 */
import {
    CloudError, CloudflareApi, CloudflareCore, CloudCrypto, CloudUsageModule, GoogleDriveCore, R2Client,
} from './contracts';
import {
    CLOUD_CHANGED_EVENT,
    CloudChangedPayload, CloudConnectInput, CloudConnectionStatus, CloudPermissionCheck, CloudStorageProvider,
    CloudStorageStatus, CloudZone, isCloudStorageProvider, storageLabel,
} from '../../shared/cloud/cloudContracts';
import { CloudApiError, CloudflareApiClient, FetchLike, RequestBudget, cfErrorCodes, cloudflareBudget } from './CloudflareApi';
import { R2BucketClient, R2Fetch, r2CredentialsFromToken } from './r2/R2Client';
import type { SigV4Credentials } from './r2/sigv4';
import { cloudCrypto } from './crypto/cloudCrypto';
import { CloudSettings, cloudSettings } from './cloudSettings';
import { createGoogleDrive } from './gdrive';
import { createCloudUsage } from './usage';
import { WORKERS_PERMISSION_LABELS } from './workers/validate';
import Logger from '../../utils/Logger';

type Area = 'connection' | 'tunnel' | 'media' | 'db';

/** Tên quyền đúng như trên trang tạo token của Cloudflare (Dashboard tiếng Anh). */
export const CF_PERMISSION_LABELS = {
    tunnel: 'Account · Cloudflare Tunnel · Edit',
    dns: 'Zone · DNS · Edit',
    zone: 'Zone · Zone · Read',
    r2: 'Account · Workers R2 Storage · Edit',
    /** Không bắt buộc: chỉ để xem mức dùng R2 toàn tài khoản (Cài đặt → Đồng bộ dữ liệu → Mức sử dụng & chi phí). */
    analytics: 'Account · Account Analytics · Read',
    /** Không bắt buộc: chỉ ứng dụng (plugin) có quyền cloudflare:workers dùng — Worker + D1 (workers/WorkersDeployer). */
    workersScripts: WORKERS_PERMISSION_LABELS.workers,
    d1: WORKERS_PERMISSION_LABELS.d1,
} as const;

/**
 * Nhóm quyền điền sẵn cho link tạo token (user token).
 * LƯU Ý: khoá nhóm quyền phải được đối chiếu với
 * https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (chưa kiểm tự động — không fetch lúc build).
 */
export const TOKEN_TEMPLATE_PERMISSIONS: ReadonlyArray<{ key: string; type: 'read' | 'edit' }> = [
    { key: 'argotunnel', type: 'edit' },
    { key: 'dns', type: 'edit' },
    { key: 'zone', type: 'read' },
    { key: 'workers_r2', type: 'edit' },
    // Mức dùng R2 toàn tài khoản (GraphQL Analytics) — key theo developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template
    { key: 'account_analytics', type: 'read' },
    // Worker + D1 cho ứng dụng (deplao.cloudflare) — key `workers_scripts`, `d1` theo bảng "Permission reference" của
    // trang account-owned-token-template ở trên (đối chiếu 20/10/2026); tên hiển thị "Workers Scripts Edit", "D1 Edit".
    { key: 'workers_scripts', type: 'edit' },
    { key: 'd1', type: 'edit' },
];

/** Link trang tạo API token của Cloudflare, điền sẵn quyền cần cho Deplao. */
export function tokenTemplateUrl(): string {
    const keys = encodeURIComponent(JSON.stringify(TOKEN_TEMPLATE_PERMISSIONS));
    return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=*&zoneId=all&name=Deplao`;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const LOCATION_HINT_RE = /^[a-z]{2,8}$/;

/** Tên bucket R2: 3–63 ký tự a-z, 0-9, '-', không bắt đầu / kết thúc bằng '-'. */
export function isValidBucketName(name: string): boolean {
    return BUCKET_RE.test(name);
}

function missingPermission(label: string): string {
    return `Thiếu quyền "${label}"`;
}

function errMessage(err: unknown): string {
    if (err instanceof CloudError) return err.message;
    return String((err as any)?.message || err || 'Lỗi không xác định');
}

/** Lỗi do token/quyền (khác lỗi mạng, khác R2 chưa bật). */
function isPermissionError(err: unknown): boolean {
    if (!(err instanceof CloudError)) return false;
    if (err.code === 'R2_NOT_ENABLED') return false;
    if (err.code === 'FORBIDDEN' || err.code === 'INVALID_TOKEN') return true;
    return err.status === 401 || err.status === 403;
}

function isR2NotEnabled(err: unknown): boolean {
    return (err instanceof CloudError && err.code === 'R2_NOT_ENABLED') || cfErrorCodes(err).includes(10042);
}

function isNotFound(err: unknown): boolean {
    return err instanceof CloudError && (err.status === 404 || err.code === 'R2_NO_BUCKET' || cfErrorCodes(err).includes(10006));
}

function isConflict(err: unknown): boolean {
    return err instanceof CloudError && (err.status === 409 || cfErrorCodes(err).includes(10004));
}

/** Lỗi tạm thời (mạng, 5xx, 429): không kết luận được gì về token. */
function isTransient(err: unknown): boolean {
    return err instanceof CloudError && ['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'CF_UNAVAILABLE', 'BAD_RESPONSE'].includes(err.code);
}

function toZone(z: any): CloudZone {
    return { id: String(z?.id || ''), name: String(z?.name || ''), status: String(z?.status || '') };
}

function emptyStatus(): CloudConnectionStatus {
    return {
        connected: false,
        accountId: null,
        accountName: null,
        tokenKind: null,
        tokenExpiresOn: null,
        zones: [],
        permissions: [],
        checkedAt: null,
        lastError: null,
    };
}

interface VerifiedToken { id: string; kind: 'account' | 'user'; expiresOn: string | null }
interface ProbeResult { zones: CloudZone[]; accountName: string | null; permissions: CloudPermissionCheck[]; lastError: string | null }

export interface CloudflareServiceDeps {
    settings?: CloudSettings;
    crypto?: CloudCrypto;
    fetchImpl?: FetchLike;
    r2Fetch?: R2Fetch;
    budget?: RequestBudget;
    /** Gửi sự kiện tới renderer (mặc định: mọi BrowserWindow). */
    broadcast?: (channel: string, payload: CloudChangedPayload) => void;
    /** Thay module Google Drive / bộ đếm mức sử dụng (test). */
    google?: (core: CloudflareService) => GoogleDriveCore;
    usage?: (core: CloudflareService) => CloudUsageModule;
}

export class CloudflareService implements CloudflareCore {
    readonly settings: CloudSettings;
    readonly crypto: CloudCrypto;
    readonly usage: CloudUsageModule;
    readonly google: GoogleDriveCore;
    private readonly client: CloudflareApiClient;
    private readonly budget: RequestBudget;
    private cached: CloudConnectionStatus | null = null;
    private readonly r2Clients = new Map<string, R2Client>();
    private readonly listeners = new Set<(area: Area) => void>();
    private recheckInFlight: Promise<CloudConnectionStatus> | null = null;
    private connecting = false;
    private credsCache: { tokenId: string; token: string; creds: SigV4Credentials } | null = null;

    constructor(private readonly deps: CloudflareServiceDeps = {}) {
        this.settings = deps.settings ?? cloudSettings;
        this.crypto = deps.crypto ?? cloudCrypto;
        this.budget = deps.budget ?? cloudflareBudget;
        this.client = new CloudflareApiClient({ getToken: () => this.settings.getToken(), fetchImpl: deps.fetchImpl, budget: this.budget });
        this.usage = deps.usage ? deps.usage(this) : createCloudUsage({ core: () => this, localStoredBytes: () => localStoredBytes() });
        this.google = deps.google
            ? deps.google(this)
            : createGoogleDrive({ settings: this.settings, usage: this.usage, notify: () => this.notifyChanged('connection') });
    }

    // ── Trạng thái ──

    status(): CloudConnectionStatus {
        try {
            const s = this.settings.peek();
            const connected = !!(s.accountId && s.tokenId && this.settings.getToken());
            if (!connected) {
                const hadSecret = !!(s.accountId && s.tokenId);
                return {
                    ...emptyStatus(),
                    accountId: s.accountId,
                    lastError: hadSecret ? 'Không đọc được token đã lưu trên máy này — hãy kết nối lại' : null,
                };
            }
            const c = this.cached;
            return {
                connected: true,
                accountId: s.accountId,
                accountName: c?.accountName ?? null,
                tokenKind: s.tokenKind,
                tokenExpiresOn: c?.tokenExpiresOn ?? null,
                zones: (c?.zones ?? []).map(z => ({ ...z })),
                permissions: (c?.permissions ?? []).map(p => (p.missing ? { ...p, missing: [...p.missing] } : { ...p })),
                checkedAt: c?.checkedAt ?? null,
                lastError: c?.lastError ?? null,
            };
        } catch (err) {
            return { ...emptyStatus(), lastError: errMessage(err) };
        }
    }

    async connect(input: CloudConnectInput): Promise<CloudConnectionStatus> {
        const accountId = String(input?.accountId ?? '').trim().toLowerCase();
        const token = String(input?.token ?? '').trim().replace(/^Bearer\s+/i, '');
        if (!ACCOUNT_ID_RE.test(accountId)) {
            throw new CloudError('BAD_ACCOUNT_ID', 'Account ID không hợp lệ (32 ký tự 0-9, a-f — xem ở trang tổng quan tài khoản Cloudflare)');
        }
        if (token.length < 20 || token.length > 512 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
            throw new CloudError('BAD_TOKEN', 'Token Cloudflare không hợp lệ (dán đúng chuỗi token vừa tạo)');
        }
        // Không lưu được bí mật thì dừng trước khi gọi mạng.
        this.settings.assertSecretsAvailable();
        if (this.connecting) throw new CloudError('BUSY', 'Đang kết nối Cloudflare, chờ một chút');
        this.connecting = true;
        let verified: VerifiedToken;
        let probe: ProbeResult;
        try {
            const probeClient = new CloudflareApiClient({ getToken: () => token, fetchImpl: this.deps.fetchImpl, budget: this.budget });
            verified = await this.verifyToken(probeClient, accountId, token, null, true);
            probe = await this.probe(probeClient, accountId);
        } finally {
            this.connecting = false;
        }

        this.settings.setToken(token);
        this.settings.update(d => {
            d.accountId = accountId;
            d.tokenKind = verified.kind;
            d.tokenId = verified.id;
        });
        this.r2Clients.clear();
        this.credsCache = null;
        this.cached = {
            connected: true,
            accountId,
            accountName: probe.accountName,
            tokenKind: verified.kind,
            tokenExpiresOn: verified.expiresOn,
            zones: probe.zones,
            permissions: probe.permissions,
            checkedAt: Date.now(),
            lastError: probe.lastError,
        };
        Logger.log(`[Cloudflare] Đã kết nối tài khoản ${accountId.slice(0, 6)}… (${verified.kind} token, ${probe.zones.length} tên miền)`);
        this.notifyChanged('connection');
        return this.status();
    }

    async disconnect(): Promise<void> {
        this.settings.setToken(null);
        this.settings.update(d => {
            d.tokenId = null;
            d.tokenKind = null;
        });
        this.cached = null;
        this.r2Clients.clear();
        this.credsCache = null;
        Logger.log('[Cloudflare] Đã ngắt kết nối (xoá token trên máy)');
        this.notifyChanged('connection');
    }

    recheck(): Promise<CloudConnectionStatus> {
        if (this.recheckInFlight) return this.recheckInFlight;
        const run = (async (): Promise<CloudConnectionStatus> => {
            const s = this.settings.get();
            const token = this.settings.getToken();
            if (!s.accountId || !s.tokenId || !token) {
                this.cached = null;
                return this.status();
            }
            const prev = this.cached;
            let expiresOn = prev?.tokenExpiresOn ?? null;
            let verifyError: string | null = null;
            try {
                const v = await this.verifyToken(this.client, s.accountId, token, s.tokenKind, false);
                expiresOn = v.expiresOn;
                if (v.id !== s.tokenId || v.kind !== s.tokenKind) {
                    this.settings.update(d => {
                        d.tokenId = v.id;
                        d.tokenKind = v.kind;
                    });
                    this.credsCache = null;
                }
            } catch (err) {
                verifyError = errMessage(err);
            }
            const probe = verifyError ? null : await this.probe(this.client, s.accountId);
            this.cached = {
                connected: true,
                accountId: s.accountId,
                accountName: probe?.accountName ?? prev?.accountName ?? null,
                tokenKind: this.settings.peek().tokenKind,
                tokenExpiresOn: expiresOn,
                zones: probe?.zones ?? prev?.zones ?? [],
                permissions: probe?.permissions ?? prev?.permissions ?? [],
                checkedAt: Date.now(),
                lastError: verifyError ?? probe?.lastError ?? null,
            };
            this.notifyChanged('connection');
            return this.status();
        })();
        this.recheckInFlight = run.finally(() => {
            this.recheckInFlight = null;
        });
        return this.recheckInFlight;
    }

    async listZones(): Promise<CloudZone[]> {
        const api = this.api();
        const accountId = this.settings.peek().accountId as string;
        const raw = await api.requestAll<any>('/zones', { query: { 'account.id': accountId, status: 'active' }, perPage: 50, maxPages: 10 });
        const zones = raw.map(toZone).filter(z => z.id && z.name);
        if (this.cached) this.cached = { ...this.cached, zones };
        return zones;
    }

    api(): CloudflareApi {
        const s = this.settings.peek();
        if (!s.accountId || !this.settings.getToken()) throw new CloudError('NOT_CONNECTED', 'Chưa kết nối Cloudflare');
        return this.client;
    }

    r2(bucket: string): R2Client {
        return this.store(bucket);
    }

    store(bucket: string): R2Client {
        const name = String(bucket ?? '').trim();
        if (!isValidBucketName(name)) throw new CloudError('BAD_BUCKET', 'Tên bucket không hợp lệ (3–63 ký tự a-z, 0-9, -)');
        if (this.storageProvider() === 'gdrive') return this.google.store(name);
        let client = this.r2Clients.get(name);
        if (!client) {
            client = new R2BucketClient({
                bucket: name,
                getAccountId: () => this.settings.peek().accountId,
                getCredentials: () => this.r2Credentials(),
                fetchImpl: this.deps.r2Fetch,
                onOp: (op, bytes) => this.usage.recordR2(op, bytes),
            });
            this.r2Clients.set(name, client);
        }
        return client;
    }

    // ── Kho lưu (R2 / Google Drive) ──

    storageProvider(): CloudStorageProvider {
        try {
            const p = this.settings.peek().storage?.provider;
            return isCloudStorageProvider(p) ? p : 'r2';
        } catch {
            return 'r2';
        }
    }

    storageReady(): { ready: boolean; reason: string | null } {
        if (this.storageProvider() === 'gdrive') {
            return this.google.isConnected()
                ? { ready: true, reason: null }
                : { ready: false, reason: 'Chưa đăng nhập Google Drive — đăng nhập Google ở phần Kho lưu.' };
        }
        const c = this.status();
        if (!c.connected) return { ready: false, reason: 'Chưa kết nối Cloudflare — kết nối Cloudflare ở đầu trang (hoặc chọn kho Google Drive).' };
        const p = c.permissions.find(x => x.feature === 'r2');
        if (p?.r2NotEnabled) return { ready: false, reason: 'Tài khoản Cloudflare chưa bật R2 (Cloudflare → R2 Object Storage).' };
        if (p && !p.ok) return { ready: false, reason: `Token Cloudflare thiếu quyền R2${p.missing?.length ? ` (${p.missing.join(', ')})` : ''}.` };
        return { ready: true, reason: null };
    }

    storageStatus(): CloudStorageStatus {
        const provider = this.storageProvider();
        const ready = this.storageReady();
        return { provider, ready: ready.ready, notReadyReason: ready.reason, google: this.google.status() };
    }

    async setStorageProvider(provider: CloudStorageProvider, guard?: () => string | null): Promise<CloudStorageStatus> {
        if (!isCloudStorageProvider(provider)) throw new CloudError('BAD_INPUT', 'Kho lưu không hợp lệ');
        const prev = this.storageProvider();
        if (prev === provider) return this.storageStatus();
        const blocked = guard ? guard() : null;
        if (blocked) throw new CloudError('STORAGE_SWITCH_BLOCKED', blocked);
        this.settings.update(d => { d.storage = { ...(d.storage || {}), provider }; });
        Logger.log(`[Cloudflare] Đổi kho lưu: ${storageLabel(prev)} → ${storageLabel(provider)}`);
        this.notifyChanged('connection');
        this.notifyChanged('media');
        this.notifyChanged('db');
        return this.storageStatus();
    }

    async listBuckets(prefix: string): Promise<string[]> {
        const pre = String(prefix ?? '');
        if (this.storageProvider() === 'gdrive') return this.google.listBuckets(pre);
        const accountId = this.settings.peek().accountId as string;
        const res: any = await this.api().request('GET', `/accounts/${accountId}/r2/buckets`, undefined, {
            query: { name_contains: pre || undefined, per_page: 1000 },
        });
        const list: any[] = Array.isArray(res?.buckets) ? res.buckets : Array.isArray(res) ? res : [];
        return list.map(b => String(b?.name || '')).filter(n => n.startsWith(pre) && isValidBucketName(n));
    }

    async ensureBucket(name: string, opts: { locationHint?: string } = {}): Promise<void> {
        const bucket = String(name ?? '').trim();
        if (!isValidBucketName(bucket)) throw new CloudError('BAD_BUCKET', 'Tên bucket không hợp lệ (3–63 ký tự a-z, 0-9, -)');
        if (this.storageProvider() === 'gdrive') {
            await this.google.ensureBucket(bucket);
            return;
        }
        const locationHint = opts.locationHint && LOCATION_HINT_RE.test(opts.locationHint) ? opts.locationHint : 'apac';
        const api = this.api();
        const accountId = this.settings.peek().accountId as string;
        try {
            await api.request('GET', `/accounts/${accountId}/r2/buckets/${bucket}`);
            return;
        } catch (err) {
            if (isR2NotEnabled(err)) throw new CloudError('R2_NOT_ENABLED', 'Tài khoản Cloudflare chưa bật R2', (err as CloudError).status);
            if (!isNotFound(err)) throw err;
        }
        try {
            await api.request('POST', `/accounts/${accountId}/r2/buckets`, { name: bucket, locationHint });
            Logger.log(`[Cloudflare] Đã tạo bucket R2 ${bucket} (${locationHint})`);
        } catch (err) {
            if (isR2NotEnabled(err)) throw new CloudError('R2_NOT_ENABLED', 'Tài khoản Cloudflare chưa bật R2', (err as CloudError).status);
            if (isConflict(err)) return; // vừa được tạo song song / đã có
            throw err;
        }
    }

    // ── Sự kiện ──

    notifyChanged(area: Area): void {
        const payload: CloudChangedPayload = { area, at: Date.now() };
        try {
            if (this.deps.broadcast) {
                this.deps.broadcast(CLOUD_CHANGED_EVENT, payload);
            } else {
                const { BrowserWindow } = require('electron');
                const windows: any[] = BrowserWindow?.getAllWindows?.() || [];
                for (const win of windows) {
                    try {
                        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CLOUD_CHANGED_EVENT, payload);
                    } catch { /* cửa sổ đang đóng */ }
                }
            }
        } catch { /* test / chưa có electron */ }
        for (const cb of Array.from(this.listeners)) {
            try {
                cb(area);
            } catch (err) {
                Logger.warn(`[Cloudflare] listener onChanged lỗi: ${errMessage(err)}`);
            }
        }
    }

    onChanged(cb: (area: Area) => void): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    // ── nội bộ ──

    private r2Credentials(): SigV4Credentials | null {
        const s = this.settings.peek();
        const token = this.settings.getToken();
        if (!s.tokenId || !token) return null;
        const c = this.credsCache;
        if (c && c.tokenId === s.tokenId && c.token === token) return c.creds;
        const creds = r2CredentialsFromToken(s.tokenId, token);
        this.credsCache = { tokenId: s.tokenId, token, creds };
        return creds;
    }

    /**
     * Kiểm token: token 'cfat_' (của tài khoản) → /accounts/{id}/tokens/verify; còn lại thử /user/tokens/verify rồi
     * tới /accounts/{id}/tokens/verify. knownKind (khi recheck) → chỉ thử đúng loại đó.
     */
    private async verifyToken(
        client: CloudflareApiClient, accountId: string, token: string, knownKind: 'account' | 'user' | null, unbudgeted: boolean,
    ): Promise<VerifiedToken> {
        const order: Array<'user' | 'account'> = knownKind
            ? [knownKind]
            : token.startsWith('cfat_') ? ['account'] : ['user', 'account'];
        let lastErr: unknown = null;
        for (const kind of order) {
            const p = kind === 'user' ? '/user/tokens/verify' : `/accounts/${accountId}/tokens/verify`;
            try {
                const r = await client.request<any>('GET', p, undefined, { unbudgeted });
                if (!r || !r.id) throw new CloudError('INVALID_TOKEN', 'Cloudflare không trả về mã của token');
                if (r.status && r.status !== 'active') {
                    throw new CloudError('TOKEN_INACTIVE', r.status === 'expired' ? 'Token Cloudflare đã hết hạn' : 'Token Cloudflare đang bị tắt');
                }
                return { id: String(r.id), kind, expiresOn: typeof r.expires_on === 'string' ? r.expires_on : null };
            } catch (err) {
                if (isTransient(err) || (err instanceof CloudError && err.code === 'TOKEN_INACTIVE')) throw err;
                lastErr = err;
            }
        }
        const status = lastErr instanceof CloudError ? lastErr.status : undefined;
        throw new CloudError(
            'INVALID_TOKEN',
            'Token Cloudflare không hợp lệ, đã hết hạn hoặc không thuộc Account ID này',
            status,
        );
    }

    /** Liệt kê tên miền + thử quyền từng tính năng bằng các GET rẻ (không tạo gì trên Cloudflare). */
    private async probe(client: CloudflareApiClient, accountId: string): Promise<ProbeResult> {
        const [zonesRes, tunnelRes, r2Res, scriptsRes, d1Res] = await Promise.allSettled([
            client.requestAll<any>('/zones', { query: { 'account.id': accountId, status: 'active' }, perPage: 50, maxPages: 10 }),
            client.request('GET', `/accounts/${accountId}/cfd_tunnel`, undefined, { query: { per_page: 1 } }),
            client.request('GET', `/accounts/${accountId}/r2/buckets`, undefined, { query: { per_page: 1 } }),
            client.request('GET', `/accounts/${accountId}/workers/scripts`, undefined, { query: { per_page: 1 } }),
            client.request('GET', `/accounts/${accountId}/d1/database`, undefined, { query: { per_page: 1 } }),
        ]);
        const transient: string[] = [];

        let zones: CloudZone[] = [];
        let accountName: string | null = null;
        const tunnelMissing: string[] = [];
        const tunnelUncheckedReasons: string[] = [];
        const tunnelTransient = (err: unknown) => {
            const msg = errMessage(err);
            transient.push(msg);
            tunnelUncheckedReasons.push(msg);
        };
        if (zonesRes.status === 'fulfilled') {
            zones = zonesRes.value.map(toZone).filter(z => z.id && z.name);
            const withAccount = zonesRes.value.find((z: any) => z?.account?.name);
            accountName = withAccount ? String(withAccount.account.name) : null;
        } else if (isPermissionError(zonesRes.reason)) {
            tunnelMissing.push(missingPermission(CF_PERMISSION_LABELS.zone));
        } else {
            tunnelTransient(zonesRes.reason);
        }

        if (tunnelRes.status === 'rejected') {
            if (isPermissionError(tunnelRes.reason)) tunnelMissing.push(missingPermission(CF_PERMISSION_LABELS.tunnel));
            else tunnelTransient(tunnelRes.reason);
        }

        if (zonesRes.status === 'fulfilled') {
            if (zones.length === 0) {
                tunnelMissing.push('Chưa có tên miền nào đang hoạt động trong tài khoản (hoặc token chưa được cấp quyền cho tên miền nào)');
            } else {
                try {
                    await client.request('GET', `/zones/${zones[0].id}/dns_records`, undefined, { query: { per_page: 1 } });
                } catch (err) {
                    if (isPermissionError(err)) tunnelMissing.push(missingPermission(CF_PERMISSION_LABELS.dns));
                    else tunnelTransient(err);
                }
            }
        }

        const tunnel: CloudPermissionCheck = tunnelMissing.length
            ? { feature: 'tunnel', ok: false, missing: tunnelMissing }
            : tunnelUncheckedReasons.length
                ? { feature: 'tunnel', ok: false, missing: [`Chưa kiểm tra được: ${tunnelUncheckedReasons[0]}`] }
                : { feature: 'tunnel', ok: true };

        let r2: CloudPermissionCheck;
        if (r2Res.status === 'fulfilled') {
            r2 = { feature: 'r2', ok: true };
        } else if (isR2NotEnabled(r2Res.reason)) {
            r2 = { feature: 'r2', ok: false, r2NotEnabled: true, missing: ['Tài khoản Cloudflare chưa bật R2 (mở Cloudflare Dashboard → R2 để bật)'] };
        } else if (isPermissionError(r2Res.reason)) {
            r2 = { feature: 'r2', ok: false, missing: [missingPermission(CF_PERMISSION_LABELS.r2)] };
        } else {
            const msg = errMessage(r2Res.reason);
            transient.push(msg);
            r2 = { feature: 'r2', ok: false, missing: [`Chưa kiểm tra được: ${msg}`] };
        }

        return { zones, accountName, permissions: [tunnel, r2, workersCheck(scriptsRes, d1Res)], lastError: transient[0] ?? null };
    }
}

/**
 * Worker + D1 (cho ứng dụng, quyền cloudflare:workers): KHÔNG bắt buộc — thiếu quyền không là lỗi của kết nối, lỗi tạm
 * thời của hai GET này cũng không thành lastError (giao diện chỉ hiện một dòng thông tin, không chấm đỏ).
 * GET chỉ chứng minh quyền đọc; thiếu Edit thì lời gọi ghi của ứng dụng báo CF_PERMISSION.
 */
function workersCheck(scripts: PromiseSettledResult<unknown>, d1: PromiseSettledResult<unknown>): CloudPermissionCheck {
    const missing: string[] = [];
    const unchecked: string[] = [];
    const probes: Array<[PromiseSettledResult<unknown>, string]> = [[scripts, CF_PERMISSION_LABELS.workersScripts], [d1, CF_PERMISSION_LABELS.d1]];
    for (const [res, label] of probes) {
        if (res.status === 'fulfilled') continue;
        if (isPermissionError(res.reason)) missing.push(missingPermission(label));
        else unchecked.push(errMessage(res.reason));
    }
    if (missing.length) return { feature: 'workers', ok: false, missing };
    if (unchecked.length) return { feature: 'workers', ok: false, missing: [`Chưa kiểm tra được: ${unchecked[0]}`] };
    return { feature: 'workers', ok: true };
}

/**
 * Dung lượng Deplao đã đẩy lên kho (ảnh/file đã lên + bản sao DB) theo trạng thái cục bộ — để ước tính khi không có số
 * liệu toàn tài khoản. Đọc module lúc gọi (require muộn, tránh vòng import). Không ném.
 */
function localStoredBytes(): number {
    let total = 0;
    try {
        const { cloudMedia } = require('./media') as typeof import('./media');
        total += Number(cloudMedia.status()?.totals?.bytesUploaded) || 0;
    } catch { /* module chưa nạp */ }
    try {
        const { cloudDb } = require('./dbsync') as typeof import('./dbsync');
        for (const w of cloudDb.status()?.workspaces || []) total += Number(w.bytes) || 0;
    } catch { /* module chưa nạp */ }
    return total;
}

/** Lõi Cloudflare dùng chung (main process). */
export const cloudflare: CloudflareCore = new CloudflareService();

export { CloudApiError };
