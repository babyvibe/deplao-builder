/**
 * cloudSettings — cấu hình Cloudflare của MÁY NÀY: userData/cloud-settings.json (không nằm trong DB nên đồng bộ DB
 * không mang lên R2).
 *
 *  - Ghi nguyên tử: file tạm (fsync) rồi rename.
 *  - Bí mật (token Cloudflare, mật khẩu sao lưu, refresh token Google, client secret Google riêng) mã hoá bằng electron
 *    safeStorage (base64). Không có safeStorage
 *    (hoặc Linux chỉ có 'basic_text') → ném CloudError('SAFE_STORAGE_UNAVAILABLE'), KHÔNG lưu dạng thường.
 *  - Bản giải mã chỉ nhớ trong RAM; get() không bao giờ chứa bí mật.
 *  - machineId (uuid) + machineName (os.hostname()) sinh một lần.
 *  - Đường dẫn file / safeStorage / hostname / uuid tiêm được để test.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { CloudError, CloudSettingsData, CloudSettingsStore } from './contracts';
import type { DbSyncMode, MediaSyncOptions, TunnelAutoConfig, TunnelMode, TunnelServiceId } from '../../shared/cloud/cloudContracts';
import { isCloudStorageProvider } from '../../shared/cloud/cloudContracts';
import Logger from '../../utils/Logger';

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
    /** base64 của safeStorage.encryptString(...) */
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

// ─── Chuẩn hoá (giữ trường lạ, sửa trường sai kiểu về mặc định) ─────────────

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
        // Bản cũ chỉ có R2 → thiếu / sai kiểu = 'r2'
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

/** Ngủ đồng bộ ngắn (chỉ dùng khi thử lại rename trên Windows). */
function sleepSync(ms: number): void {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch { /* môi trường không hỗ trợ: bỏ qua */ }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class CloudSettings implements CloudSettingsStore {
    private data: CloudSettingsData | null = null;
    private secrets: Partial<Record<SecretName, string>> = {};
    /** Bản giải mã trong RAM (undefined = chưa đọc). */
    private plain: Partial<Record<SecretName, string | null>> = {};

    constructor(private readonly opts: CloudSettingsOptions = {}) {}

    get(): CloudSettingsData {
        return clone(this.load());
    }

    /** Bản đang giữ (chỉ đọc, KHÔNG sửa) — dùng ở đường nóng trong core để khỏi clone. */
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

    /** Máy này lưu được bí mật không (safeStorage thật, không phải 'basic_text'). */
    secretsAvailable(): boolean {
        return this.usableSafeStorage() !== null;
    }

    /** Ném CloudError('SAFE_STORAGE_UNAVAILABLE') nếu không lưu được bí mật. */
    assertSecretsAvailable(): void {
        if (!this.usableSafeStorage()) throw this.unavailableError();
    }

    /** Đường dẫn file cấu hình (để hiển thị / test). */
    filePath(): string {
        if (this.opts.filePath) return this.opts.filePath();
        const { app } = require('electron');
        return path.join(app.getPath('userData'), CLOUD_SETTINGS_FILE);
    }

    // ── nội bộ ──

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
                if (attempt >= 3) throw new CloudError('SETTINGS_UNREADABLE', `Không đọc được cấu hình Cloudflare (${err?.code || err?.message || err})`);
                sleepSync(50);
            }
        }
        if (text !== null) {
            try {
                raw = JSON.parse(text);
            } catch (err: any) {
                const backup = `${file}.corrupt-${Date.now()}`;
                try { fs.copyFileSync(file, backup); } catch { /* bỏ qua */ }
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
        // machineId/machineName chỉ sinh một lần: ghi ngay khi file chưa có.
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
                    try { fs.unlinkSync(tmp); } catch { /* bỏ qua */ }
                    throw new CloudError('SETTINGS_WRITE_FAILED', `Không ghi được cấu hình Cloudflare (${err?.code || err?.message || err})`);
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
        // Chưa sẵn sàng (trước app ready) → không nhớ kết quả, lần sau đọc lại.
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
        if (typeof value !== 'string') throw new CloudError('BAD_INPUT', 'Giá trị bí mật không hợp lệ');
        const ss = this.usableSafeStorage();
        if (!ss) throw this.unavailableError();
        let encrypted: string;
        try {
            encrypted = ss.encryptString(value).toString('base64');
        } catch (err: any) {
            throw new CloudError('SAFE_STORAGE_UNAVAILABLE', `Không mã hoá được bằng safeStorage (${err?.message || err})`);
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
            // Linux không có keyring: 'basic_text' = khoá cố định, coi như không mã hoá.
            if (typeof ss.getSelectedStorageBackend === 'function' && ss.getSelectedStorageBackend() === 'basic_text') return null;
        } catch {
            return null;
        }
        return ss;
    }

    private unavailableError(): CloudError {
        return new CloudError(
            'SAFE_STORAGE_UNAVAILABLE',
            'Máy này không có kho mã hoá an toàn của hệ điều hành (safeStorage) nên không lưu được token / mật khẩu',
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

/** Store dùng chung của app (đọc file lần đầu khi cần, không chạm đĩa lúc import). */
export const cloudSettings = new CloudSettings();
