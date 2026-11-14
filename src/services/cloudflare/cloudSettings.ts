/**
 * cloudSettings: Cloudflare settings of THIS MACHINE: userData/cloud-settings.json (not in the DB, so DB sync
 * does not carry it up to R2).
 *
 *  - Atomic write: temp file (fsync) then rename.
 *  - Secrets (Cloudflare token, backup password, Google refresh token, the separate Google client secret) are encrypted with electron
 *    safeStorage (base64). Without safeStorage
 *    (or on Linux with only 'basic_text') → throws CloudError('SAFE_STORAGE_UNAVAILABLE'), NEVER saves in plain text.
 *  - The decrypted copy is only kept in RAM; get() never contains a secret.
 *  - machineId (uuid) + machineName (os.hostname()) are generated once.
 *  - The file path / safeStorage / hostname / uuid can be injected for tests.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { CloudError, CloudSettingsData, CloudSettingsStore } from './contracts';
import type { DbSyncMode, MediaSyncOptions, TunnelAutoConfig, TunnelMode, TunnelServiceId } from '../../shared/cloud/cloudContracts';
import { isCloudStorageProvider } from '../../shared/cloud/cloudContracts';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

export const CLOUD_SETTINGS_FILE = 'cloud-settings.json';

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(encrypted: Buffer): string;
    getSelectedStorageBackend?: () => string;
}

export interface CloudSettingsOptions {
    filePath?: () => string;
    safeStorage?: () => SafeStorageLike | null;
    hostname?: () => string;
    uuid?: () => string;
}

type SecretName = 'token' | 'passphrase' | 'googleRefreshToken' | 'googleClientSecret';
const SECRET_NAMES: ReadonlyArray<SecretName> = ['token', 'passphrase', 'googleRefreshToken', 'googleClientSecret'];
const SECRET_LABELS: Record<SecretName, string> = {
    token: 'token Cloudflare',
    passphrase: 'mật khẩu sao lưu',
    googleRefreshToken: 'phiên đăng nhập Google',
    googleClientSecret: 'client secret Google',
};

interface SettingsFile {
    version: 1;
    settings: CloudSettingsData;
    /** base64 of safeStorage.encryptString(...) */
    secrets: Partial<Record<SecretName, string>>;
}

export const DEFAULT_MEDIA_OPTIONS: Readonly<MediaSyncOptions> = Object.freeze({
    concurrency: 3,
    nightOnly: false,
    bandwidthKbps: 0,
    evictEnabled: false,
    evictKeepDays: 30,
    evictMinFreeGb: 20,
});

const TUNNEL_MODES: TunnelMode[] = ['quick', 'ngrok', 'cloudflare_auto', 'cloudflare_manual'];
const DB_MODES: DbSyncMode[] = ['off', 'hourly', 'realtime'];
const SERVICES: TunnelServiceId[] = ['relay', 'payments', 'workflow'];

export function defaultCloudSettings(machineId: string, machineName: string): CloudSettingsData {
    return {
        accountId: null,
        tokenKind: null,
        tokenId: null,
        machineId,
        machineName,
        tunnel: {
            mode: 'quick',
            auto: null,
            autoStart: true,
            tunnelId: null,
            tunnelName: null,
            dnsRecordIds: {},
            enabled: { relay: true, payments: true, workflow: true },
        },
        media: { enabled: false, bucket: null, options: { ...DEFAULT_MEDIA_OPTIONS } },
        db: { mode: 'off', bucket: null, following: null },
        storage: { provider: 'r2' },
        google: { email: null, displayName: null, rootFolderId: null, customClientId: null, connectedAt: null },
    };
}

// ─── Normalize (keeps unknown fields, resets wrongly typed fields to defaults) ─────────────

function isObj(v: unknown): v is Record<string, any> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

function boolOr(v: unknown, d: boolean): boolean {
    return typeof v === 'boolean' ? v : d;
}

function intIn(v: unknown, min: number, max: number, d: number): number {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeAuto(v: unknown): TunnelAutoConfig | null {
    if (!isObj(v)) return null;
    const zoneId = strOrNull(v.zoneId);
    const zoneName = strOrNull(v.zoneName);
    const hostPrefix = strOrNull(v.hostPrefix);
    if (!zoneId || !zoneName || !hostPrefix) return null;
    return { ...v, zoneId, zoneName, hostPrefix, layout: v.layout === 'split' ? 'split' : 'single' } as TunnelAutoConfig;
}

export function normalizeMediaOptions(v: unknown, base: MediaSyncOptions = DEFAULT_MEDIA_OPTIONS): MediaSyncOptions {
    const o = isObj(v) ? v : {};
    return {
        concurrency: intIn(o.concurrency, 1, 16, base.concurrency),
        nightOnly: boolOr(o.nightOnly, base.nightOnly),
        bandwidthKbps: intIn(o.bandwidthKbps, 0, 10_000_000, base.bandwidthKbps),
        evictEnabled: boolOr(o.evictEnabled, base.evictEnabled),
        evictKeepDays: intIn(o.evictKeepDays, 1, 3650, base.evictKeepDays),
        evictMinFreeGb: intIn(o.evictMinFreeGb, 0, 100_000, base.evictMinFreeGb),
    };
}

export function normalizeCloudSettings(raw: unknown, defaults: CloudSettingsData): CloudSettingsData {
    const r = isObj(raw) ? raw : {};
    const t = isObj(r.tunnel) ? r.tunnel : {};
    const m = isObj(r.media) ? r.media : {};
    const d = isObj(r.db) ? r.db : {};
    const sy = isObj(r.sync) ? r.sync : {};
    const st = isObj(r.storage) ? r.storage : {};
    const g = isObj(r.google) ? r.google : {};
    const enabledRaw = isObj(t.enabled) ? t.enabled : {};
    const enabled = {} as Record<TunnelServiceId, boolean>;
    for (const s of SERVICES) enabled[s] = boolOr(enabledRaw[s], defaults.tunnel.enabled[s]);
    const dnsRecordIds: Record<string, string> = {};
    if (isObj(t.dnsRecordIds)) {
        for (const [k, v] of Object.entries(t.dnsRecordIds)) if (typeof v === 'string' && v) dnsRecordIds[k] = v;
    }
    const following = isObj(d.following) && strOrNull(d.following.workspaceId) && strOrNull(d.following.sourceMachine)
        ? { ...d.following, workspaceId: String(d.following.workspaceId), sourceMachine: String(d.following.sourceMachine) }
        : null;
    return {
        ...r,
        accountId: strOrNull(r.accountId),
        tokenKind: r.tokenKind === 'account' || r.tokenKind === 'user' ? r.tokenKind : null,
        tokenId: strOrNull(r.tokenId),
        machineId: strOrNull(r.machineId) || defaults.machineId,
        machineName: strOrNull(r.machineName) || defaults.machineName,
        tunnel: {
            ...t,
            mode: TUNNEL_MODES.includes(t.mode) ? t.mode : defaults.tunnel.mode,
            auto: normalizeAuto(t.auto),
            autoStart: boolOr(t.autoStart, defaults.tunnel.autoStart),
            tunnelId: strOrNull(t.tunnelId),
            tunnelName: strOrNull(t.tunnelName),
            dnsRecordIds,
            enabled,
        },
        media: {
            ...m,
            enabled: boolOr(m.enabled, defaults.media.enabled),
            bucket: strOrNull(m.bucket),
            options: normalizeMediaOptions(m.options, defaults.media.options),
        },
        db: {
            ...d,
            mode: DB_MODES.includes(d.mode) ? d.mode : defaults.db.mode,
            bucket: strOrNull(d.bucket),
            following,
        },
        sync: { ...sy, includeMedia: boolOr(sy.includeMedia, true) },
        // Old versions had only R2 → missing / wrong type = 'r2'
        storage: { ...st, provider: isCloudStorageProvider(st.provider) ? st.provider : 'r2' },
        google: {
            ...g,
            email: strOrNull(g.email),
            displayName: strOrNull(g.displayName),
            rootFolderId: strOrNull(g.rootFolderId),
            customClientId: strOrNull(g.customClientId),
            connectedAt: typeof g.connectedAt === 'number' && Number.isFinite(g.connectedAt) ? g.connectedAt : null,
        },
    } as CloudSettingsData;
}

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

/** Short synchronous sleep (only used when retrying a rename on Windows). */
function sleepSync(ms: number): void {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch { /* environment does not support it: ignore */ }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class CloudSettings implements CloudSettingsStore {
    private data: CloudSettingsData | null = null;
    private secrets: Partial<Record<SecretName, string>> = {};
    /** Decrypted copy in RAM (undefined = not read yet). */
    private plain: Partial<Record<SecretName, string | null>> = {};

    constructor(private readonly opts: CloudSettingsOptions = {}) {}

    get(): CloudSettingsData {
        return clone(this.load());
    }

    /** The held copy (read-only, DO NOT modify), used on the hot path in core to avoid cloning. */
    peek(): Readonly<CloudSettingsData> {
        return this.load();
    }

    update(patch: (draft: CloudSettingsData) => void): CloudSettingsData {
        const current = this.load();
        const draft = clone(current);
        patch(draft);
        const next = normalizeCloudSettings(draft, current);
        this.persist(next, this.secrets);
        this.data = next;
        return clone(next);
    }

    getToken(): string | null {
        return this.readSecret('token');
    }

    setToken(token: string | null): void {
        this.writeSecret('token', token);
    }

    getPassphrase(): string | null {
        return this.readSecret('passphrase');
    }

    setPassphrase(passphrase: string | null): void {
        this.writeSecret('passphrase', passphrase);
    }

    getGoogleRefreshToken(): string | null {
        return this.readSecret('googleRefreshToken');
    }

    setGoogleRefreshToken(token: string | null): void {
        this.writeSecret('googleRefreshToken', token);
    }

    getGoogleClientSecret(): string | null {
        return this.readSecret('googleClientSecret');
    }

    setGoogleClientSecret(secret: string | null): void {
        this.writeSecret('googleClientSecret', secret);
    }

    /** Whether this machine can store secrets (real safeStorage, not 'basic_text'). */
    secretsAvailable(): boolean {
        return this.usableSafeStorage() !== null;
    }

    /** Throws CloudError('SAFE_STORAGE_UNAVAILABLE') if secrets cannot be stored. */
    assertSecretsAvailable(): void {
        if (!this.usableSafeStorage()) throw this.unavailableError();
    }

    /** Path of the config file (for display / tests). */
    filePath(): string {
        if (this.opts.filePath) return this.opts.filePath();
        const { app } = require('electron');
        return path.join(app.getPath('userData'), CLOUD_SETTINGS_FILE);
    }

    // ── internal ──

    private load(): CloudSettingsData {
        if (this.data) return this.data;
        const file = this.filePath();
        let raw: any = null;
        let text: string | null = null;
        for (let attempt = 0; ; attempt++) {
            try {
                text = fs.readFileSync(file, 'utf8');
                break;
            } catch (err: any) {
                if (err?.code === 'ENOENT') break;
                if (attempt >= 3) throw new CloudError('SETTINGS_UNREADABLE', tr('Không đọc được cấu hình Cloudflare ({{v1}})', { v1: err?.code || err?.message || err }));
                sleepSync(50);
            }
        }
        if (text !== null) {
            try {
                raw = JSON.parse(text);
            } catch (err: any) {
                const backup = `${file}.corrupt-${Date.now()}`;
                try { fs.copyFileSync(file, backup); } catch { /* ignore */ }
                Logger.warn(`[cloudSettings] ${path.basename(file)} hỏng (${err?.message}); đã sao lưu sang ${path.basename(backup)} và dùng mặc định`);
                raw = null;
            }
        }
        const defaults = defaultCloudSettings(this.newUuid(), this.hostname());
        const settings = normalizeCloudSettings(isObj(raw) ? raw.settings : null, defaults);
        const secrets: Partial<Record<SecretName, string>> = {};
        if (isObj(raw) && isObj(raw.secrets)) {
            for (const name of SECRET_NAMES) {
                const v = raw.secrets[name];
                if (typeof v === 'string' && v) secrets[name] = v;
            }
        }
        this.secrets = secrets;
        this.data = settings;
        // machineId/machineName are generated only once: written right away when the file does not exist yet.
        const rawSettings = isObj(raw) && isObj(raw.settings) ? raw.settings : null;
        if (!rawSettings || !strOrNull(rawSettings.machineId) || !strOrNull(rawSettings.machineName)) {
            try {
                this.persist(settings, secrets);
            } catch (err: any) {
                Logger.warn(`[cloudSettings] chưa ghi được ${path.basename(file)}: ${err?.message || err}`);
            }
        }
        return settings;
    }

    private persist(settings: CloudSettingsData, secrets: Partial<Record<SecretName, string>>): void {
        const file = this.filePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const body: SettingsFile = { version: 1, settings, secrets };
        const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(body, null, 2), 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        for (let attempt = 0; ; attempt++) {
            try {
                fs.renameSync(tmp, file);
                return;
            } catch (err: any) {
                if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
                    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                    throw new CloudError('SETTINGS_WRITE_FAILED', tr('Không ghi được cấu hình Cloudflare ({{v1}})', { v1: err?.code || err?.message || err }));
                }
                sleepSync(30 * (attempt + 1));
            }
        }
    }

    private readSecret(name: SecretName): string | null {
        this.load();
        const cached = this.plain[name];
        if (cached !== undefined) return cached;
        const enc = this.secrets[name];
        if (!enc) {
            this.plain[name] = null;
            return null;
        }
        const ss = this.usableSafeStorage();
        // Not ready yet (before app ready) → do not remember the result, read again next time.
        if (!ss) return null;
        try {
            const value = ss.decryptString(Buffer.from(enc, 'base64'));
            this.plain[name] = value || null;
            return value || null;
        } catch {
            Logger.warn(`[cloudSettings] không giải mã được ${SECRET_LABELS[name]} đã lưu (đổi tài khoản Windows?) — cần nhập lại`);
            this.plain[name] = null;
            return null;
        }
    }

    private writeSecret(name: SecretName, value: string | null): void {
        const settings = this.load();
        const nextSecrets = { ...this.secrets };
        if (value === null || value === undefined || value === '') {
            delete nextSecrets[name];
            this.persist(settings, nextSecrets);
            this.secrets = nextSecrets;
            this.plain[name] = null;
            return;
        }
        if (typeof value !== 'string') throw new CloudError('BAD_INPUT', tr('Giá trị bí mật không hợp lệ'));
        const ss = this.usableSafeStorage();
        if (!ss) throw this.unavailableError();
        let encrypted: string;
        try {
            encrypted = ss.encryptString(value).toString('base64');
        } catch (err: any) {
            throw new CloudError('SAFE_STORAGE_UNAVAILABLE', tr('Không mã hoá được bằng safeStorage ({{v1}})', { v1: err?.message || err }));
        }
        nextSecrets[name] = encrypted;
        this.persist(settings, nextSecrets);
        this.secrets = nextSecrets;
        this.plain[name] = value;
    }

    private usableSafeStorage(): SafeStorageLike | null {
        let ss: SafeStorageLike | null = null;
        try {
            ss = this.opts.safeStorage ? this.opts.safeStorage() : (require('electron').safeStorage as SafeStorageLike) || null;
        } catch {
            ss = null;
        }
        if (!ss || typeof ss.isEncryptionAvailable !== 'function') return null;
        try {
            if (!ss.isEncryptionAvailable()) return null;
            // Linux without a keyring: 'basic_text' = a fixed key, treated as not encrypted.
            if (typeof ss.getSelectedStorageBackend === 'function' && ss.getSelectedStorageBackend() === 'basic_text') return null;
        } catch {
            return null;
        }
        return ss;
    }

    private unavailableError(): CloudError {
        return new CloudError(
            'SAFE_STORAGE_UNAVAILABLE',
            tr('Máy này không có kho mã hoá an toàn của hệ điều hành (safeStorage) nên không lưu được token / mật khẩu'),
        );
    }

    private hostname(): string {
        try {
            return (this.opts.hostname ? this.opts.hostname() : os.hostname()) || 'may-tinh';
        } catch {
            return 'may-tinh';
        }
    }

    private newUuid(): string {
        return this.opts.uuid ? this.opts.uuid() : randomUUID();
    }
}

/** The app's shared store (reads the file the first time it is needed, does not touch the disk at import). */
export const cloudSettings = new CloudSettings();
