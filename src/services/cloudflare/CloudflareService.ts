/**
 * CloudflareService: the shared core of the "Internet & Cloud" feature (singleton `cloudflare`).
 *
 *  - connect: verifies the token (tokens/verify; a token starting with 'cfat_' is an account token) → lists the domains → tests the permissions
 *    of each feature (tunnel, R2, Worker + D1 for apps, not required) with cheap GETs → saves the token (safeStorage)
 *    + tokenId + tokenKind.
 *  - status(): state remembered in RAM (no network calls). recheck() tests the permissions again.
 *  - api(): shared REST client (budget 100 requests / 5 minutes for the whole app). r2(bucket) / store(bucket): the client of
 *    the SELECTED STORAGE: R2 (S3 per bucket) or Google Drive (folder Deplao/<bucket>, ./gdrive). Media and DB sync only
 *    call through here, so they work with both storages. google: signs in to Google Drive; usage: counts operations + estimates the cost.
 *  - notifyChanged(area): pushes CLOUD_CHANGED_EVENT to every window + listeners in main.
 *
 * The token and the backup password are NEVER logged or returned to the renderer.
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
import { tr } from '../../shared/i18n';

type Area = 'connection' | 'tunnel' | 'media' | 'db';

/** Permission names exactly as on Cloudflare's token creation page (the English Dashboard). */
export const CF_PERMISSION_LABELS = {
    tunnel: 'Account · Cloudflare Tunnel · Edit',
    dns: 'Zone · DNS · Edit',
    zone: 'Zone · Zone · Read',
    r2: 'Account · Workers R2 Storage · Edit',
    /** Optional: only used to show the account-wide R2 usage (Settings → Data sync → Usage & cost). */
    analytics: 'Account · Account Analytics · Read',
    /** Optional: only used by apps (plugins) that have the cloudflare:workers permission: Worker + D1 (workers/WorkersDeployer). */
    workersScripts: WORKERS_PERMISSION_LABELS.workers,
    d1: WORKERS_PERMISSION_LABELS.d1,
} as const;

/**
 * Pre-filled permission group for the token creation link (user token).
 * NOTE: the permission group keys must be checked against
 * https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (not checked automatically, not fetched at build time).
 */
export const TOKEN_TEMPLATE_PERMISSIONS: ReadonlyArray<{ key: string; type: 'read' | 'edit' }> = [
    { key: 'argotunnel', type: 'edit' },
    { key: 'dns', type: 'edit' },
    { key: 'zone', type: 'read' },
    { key: 'workers_r2', type: 'edit' },
    // Account-wide R2 usage (GraphQL Analytics), key per developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template
    { key: 'account_analytics', type: 'read' },
    // Worker + D1 for apps (deplao.cloudflare): keys `workers_scripts`, `d1` per the "Permission reference" table of
    // the account-owned-token-template page above (checked 20/10/2026); display names "Workers Scripts Edit", "D1 Edit".
    { key: 'workers_scripts', type: 'edit' },
    { key: 'd1', type: 'edit' },
];

/** Link to Cloudflare's API token creation page, with the permissions Deplao needs pre-filled. */
export function tokenTemplateUrl(): string {
    const keys = encodeURIComponent(JSON.stringify(TOKEN_TEMPLATE_PERMISSIONS));
    return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=*&zoneId=all&name=Deplao`;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const LOCATION_HINT_RE = /^[a-z]{2,8}$/;

/** R2 bucket name: 3-63 characters a-z, 0-9, '-', must not start or end with '-'. */
export function isValidBucketName(name: string): boolean {
    return BUCKET_RE.test(name);
}

function missingPermission(label: string): string {
    return tr('Thiếu quyền "{{label}}"', { label });
}

function errMessage(err: unknown): string {
    if (err instanceof CloudError) return err.message;
    return String((err as any)?.message || err || tr('Lỗi không xác định'));
}

/** Error caused by the token/permissions (not a network error, not R2 not enabled). */
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

/** Temporary error (network, 5xx, 429): nothing can be concluded about the token. */
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
    /** Send an event to the renderer (default: every BrowserWindow). */
    broadcast?: (channel: string, payload: CloudChangedPayload) => void;
    /** Replace the Google Drive module / usage counter (tests). */
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

    // ── Status ──

    status(): CloudConnectionStatus {
        try {
            const s = this.settings.peek();
            const connected = !!(s.accountId && s.tokenId && this.settings.getToken());
            if (!connected) {
                const hadSecret = !!(s.accountId && s.tokenId);
                return {
                    ...emptyStatus(),
                    accountId: s.accountId,
                    lastError: hadSecret ? tr('Không đọc được token đã lưu trên máy này — hãy kết nối lại') : null,
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
            throw new CloudError('BAD_ACCOUNT_ID', tr('Account ID không hợp lệ (32 ký tự 0-9, a-f — xem ở trang tổng quan tài khoản Cloudflare)'));
        }
        if (token.length < 20 || token.length > 512 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
            throw new CloudError('BAD_TOKEN', tr('Token Cloudflare không hợp lệ (dán đúng chuỗi token vừa tạo)'));
        }
        // If the secret cannot be saved, stop before making any network call.
        this.settings.assertSecretsAvailable();
        if (this.connecting) throw new CloudError('BUSY', tr('Đang kết nối Cloudflare, chờ một chút'));
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
        if (!s.accountId || !this.settings.getToken()) throw new CloudError('NOT_CONNECTED', tr('Chưa kết nối Cloudflare'));
        return this.client;
    }

    r2(bucket: string): R2Client {
        return this.store(bucket);
    }

    store(bucket: string): R2Client {
        const name = String(bucket ?? '').trim();
        if (!isValidBucketName(name)) throw new CloudError('BAD_BUCKET', tr('Tên bucket không hợp lệ (3–63 ký tự a-z, 0-9, -)'));
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

    // ── Storage (R2 / Google Drive) ──

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
                : { ready: false, reason: tr('Chưa đăng nhập Google Drive — đăng nhập Google ở phần Kho lưu.') };
        }
        const c = this.status();
        if (!c.connected) return { ready: false, reason: tr('Chưa kết nối Cloudflare — kết nối Cloudflare ở đầu trang (hoặc chọn kho Google Drive).') };
        const p = c.permissions.find(x => x.feature === 'r2');
        if (p?.r2NotEnabled) return { ready: false, reason: tr('Tài khoản Cloudflare chưa bật R2 (Cloudflare → R2 Object Storage).') };
        if (p && !p.ok) return { ready: false, reason: tr('Token Cloudflare thiếu quyền R2{{v1}}.', { v1: p.missing?.length ? ` (${p.missing.join(', ')})` : '' }) };
        return { ready: true, reason: null };
    }

    storageStatus(): CloudStorageStatus {
        const provider = this.storageProvider();
        const ready = this.storageReady();
        return { provider, ready: ready.ready, notReadyReason: ready.reason, google: this.google.status() };
    }

    async setStorageProvider(provider: CloudStorageProvider, guard?: () => string | null): Promise<CloudStorageStatus> {
        if (!isCloudStorageProvider(provider)) throw new CloudError('BAD_INPUT', tr('Kho lưu không hợp lệ'));
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
        if (!isValidBucketName(bucket)) throw new CloudError('BAD_BUCKET', tr('Tên bucket không hợp lệ (3–63 ký tự a-z, 0-9, -)'));
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
            if (isR2NotEnabled(err)) throw new CloudError('R2_NOT_ENABLED', tr('Tài khoản Cloudflare chưa bật R2'), (err as CloudError).status);
            if (!isNotFound(err)) throw err;
        }
        try {
            await api.request('POST', `/accounts/${accountId}/r2/buckets`, { name: bucket, locationHint });
            Logger.log(`[Cloudflare] Đã tạo bucket R2 ${bucket} (${locationHint})`);
        } catch (err) {
            if (isR2NotEnabled(err)) throw new CloudError('R2_NOT_ENABLED', tr('Tài khoản Cloudflare chưa bật R2'), (err as CloudError).status);
            if (isConflict(err)) return; // just created in parallel / already exists
            throw err;
        }
    }

    // ── Events ──

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
                    } catch { /* window is closing */ }
                }
            }
        } catch { /* test / Electron not available yet */ }
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

    // ── internal ──

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
     * Verify the token: token 'cfat_' (account token) → /accounts/{id}/tokens/verify; otherwise try /user/tokens/verify, then
     * /accounts/{id}/tokens/verify. knownKind (when rechecking) → only try that same kind.
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
                if (!r || !r.id) throw new CloudError('INVALID_TOKEN', tr('Cloudflare không trả về mã của token'));
                if (r.status && r.status !== 'active') {
                    throw new CloudError('TOKEN_INACTIVE', r.status === 'expired' ? tr('Token Cloudflare đã hết hạn') : tr('Token Cloudflare đang bị tắt'));
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
            tr('Token Cloudflare không hợp lệ, đã hết hạn hoặc không thuộc Account ID này'),
            status,
        );
    }

    /** List the domains + test each feature's permissions with cheap GETs (creates nothing on Cloudflare). */
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
                tunnelMissing.push(tr('Chưa có tên miền nào đang hoạt động trong tài khoản (hoặc token chưa được cấp quyền cho tên miền nào)'));
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
                ? { feature: 'tunnel', ok: false, missing: [tr('Chưa kiểm tra được: {{v1}}', { v1: tunnelUncheckedReasons[0] })] }
                : { feature: 'tunnel', ok: true };

        let r2: CloudPermissionCheck;
        if (r2Res.status === 'fulfilled') {
            r2 = { feature: 'r2', ok: true };
        } else if (isR2NotEnabled(r2Res.reason)) {
            r2 = { feature: 'r2', ok: false, r2NotEnabled: true, missing: [tr('Tài khoản Cloudflare chưa bật R2 (mở Cloudflare Dashboard → R2 để bật)')] };
        } else if (isPermissionError(r2Res.reason)) {
            r2 = { feature: 'r2', ok: false, missing: [missingPermission(CF_PERMISSION_LABELS.r2)] };
        } else {
            const msg = errMessage(r2Res.reason);
            transient.push(msg);
            r2 = { feature: 'r2', ok: false, missing: [tr('Chưa kiểm tra được: {{msg}}', { msg })] };
        }

        return { zones, accountName, permissions: [tunnel, r2, workersCheck(scriptsRes, d1Res)], lastError: transient[0] ?? null };
    }
}

/**
 * Worker + D1 (for apps, cloudflare:workers permission): NOT required. A missing permission is not a connection error, and a temporary
 * error of these two GETs does not become lastError either (the UI only shows an info line, not a red mark).
 * A GET only proves read permission; without Edit, the app's write call reports CF_PERMISSION.
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
    if (unchecked.length) return { feature: 'workers', ok: false, missing: [tr('Chưa kiểm tra được: {{v1}}', { v1: unchecked[0] })] };
    return { feature: 'workers', ok: true };
}

/**
 * Storage used by Deplao that it has uploaded (photos/files already uploaded + DB copies), based on the local state, to estimate when there are no
 * account-wide figures. Reads the module at call time (late require, avoids circular imports). Never throws.
 */
function localStoredBytes(): number {
    let total = 0;
    try {
        const { cloudMedia } = require('./media') as typeof import('./media');
        total += Number(cloudMedia.status()?.totals?.bytesUploaded) || 0;
    } catch { /* module not loaded yet */ }
    try {
        const { cloudDb } = require('./dbsync') as typeof import('./dbsync');
        for (const w of cloudDb.status()?.workspaces || []) total += Number(w.bytes) || 0;
    } catch { /* module not loaded yet */ }
    return total;
}

/** Shared Cloudflare core (main process). */
export const cloudflare: CloudflareCore = new CloudflareService();

export { CloudApiError };
