/**
 * PluginManager — vòng đời plugin: kiểm tra gói, duyệt quyền, cài, bật/tắt, cập nhật, gỡ.
 *
 * Bố cục trên đĩa (tách theo workspace để không workspace nào ghi đè plugin của workspace khác):
 *   <userData>/plugins/<ws>/<id>/        mã plugin cài từ zip
 *   <userData>/plugins-tmp/<token>/      gói đang chờ duyệt
 *   <userData>/plugin-data/<ws>/<id>/    file riêng của plugin (deplao.storage.dataDir)
 * Thư mục dev chạy tại chỗ, không bao giờ bị xoá.
 *
 * Bản ghi nằm ở bảng `plugins` của workspace đang mở. Phần chạy (sandbox local / client remote)
 * do `createRuntime` tạo — main.ts truyền bản Electron, test truyền bản giả.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { apiDb, apiTablesExist } from '../api/dbSchema';
import { ApiError, Principal } from '../api/types';
import { pluginPrincipal } from '../api/auth/ApiAuth';
import { getApiSettingNumber } from '../api/settings';
import { decryptSecret, encryptSecret } from '../api/auth/secretBox';
import {
    apiScopesOf, describePermissions, MANIFEST_FILE, PermissionInfo, PluginManifest, PluginRuntime, readManifest,
    SettingsSchema, SettingsField,
} from './manifest';
import { extractZip, ZipError } from './zip';
import { compareSemver } from './semver';
import { PluginLogStore, PluginStorage } from './PluginStorage';
import { mimeFor, resolvePluginFile } from './PluginProtocol';

const ICON_MAX_BYTES = 256 * 1024;
const ICON_TYPES = /\.(png|jpe?g|gif|webp|svg)$/i;
const iconCache = new Map<string, string | null>();

/** Biểu tượng plugin (manifest.icon) dạng data URL để hiện ở danh sách — null nếu không có/không hợp lệ. */
export function pluginIconDataUrl(rec: PluginRecord): string | null {
    const rel = rec.manifest?.icon;
    if (!rel || !ICON_TYPES.test(rel)) return null;
    const key = `${rec.id}@${rec.version}@${rec.install_path}`;
    if (iconCache.has(key)) return iconCache.get(key)!;
    let out: string | null = null;
    try {
        const file = resolvePluginFile(rec.install_path, rel);
        if (file && fs.statSync(file).size <= ICON_MAX_BYTES) {
            out = `data:${mimeFor(file).split(';')[0]};base64,${fs.readFileSync(file).toString('base64')}`;
        }
    } catch { /* không có biểu tượng */ }
    if (rec.source_type !== 'dev') iconCache.set(key, out);
    return out;
}

export type PluginStatus = 'enabled' | 'disabled' | 'invalid' | 'disabled_crash';
export type PluginSource = 'zip' | 'dev';

export interface PluginRecord {
    id: string;
    name: string;
    version: string;
    runtime: PluginRuntime;
    source_type: PluginSource;
    install_path: string;
    manifest: PluginManifest;
    granted_permissions: string[];
    account_ids: string[] | null;
    status: PluginStatus;
    status_reason: string | null;
    installed_at: number;
    updated_at: number;
}

export interface RuntimeStats {
    running: boolean;
    pid?: number;
    restarts: number;
    startedAt?: number;
    memoryMb?: number;
    lastError?: string;
    /** Chỉ runtime remote: server plugin và lần gọi gần nhất có thành công không (null = chưa gọi). */
    remote?: { baseUrl: string; connected: boolean | null; lastOkAt?: number; calls: number };
}

/** Phần chạy của plugin đang bật (local: utilityProcess, remote: HTTP có chữ ký). */
export interface PluginRuntimeHandle {
    start(init: { settings: Record<string, any>; prevVersion?: string }): Promise<void>;
    stop(): Promise<void>;
    call(method: string, params: any, timeoutMs?: number): Promise<any>;
    notify(method: string, params: any): void;
    stats(): RuntimeStats;
}

/** Plugin → host (deplao.* phía backend). PluginApiBridge thực hiện. */
export type PluginRequestHandler = (pluginId: string, method: string, params: any, origin: 'ui' | 'backend') => Promise<any>;

export interface RuntimeContext {
    record: PluginRecord;
    dataDir: string;
    onRequest: (method: string, params: any) => Promise<any>;
    onLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
    /** Hỏng hẳn (crash quá số lần) → manager tắt plugin. */
    onFatal: (reason: string) => void;
    remoteSecret: () => string;
}

export interface PluginManagerDeps {
    userDataDir: () => string;
    appVersion: () => string;
    workspaceKey: () => string;
    createRuntime: (ctx: RuntimeContext) => PluginRuntimeHandle | null;
    /** Đăng ký/huỷ node, trigger, route, lịch, sự kiện khi plugin bật/tắt. */
    onActivated?: (record: PluginRecord) => void;
    onDeactivated?: (record: PluginRecord) => void;
    /** Danh sách/contribution đổi → báo renderer vẽ lại sidebar, palette. */
    onChanged?: () => void;
    logError?: (msg: string) => void;
}

export interface InstallPreview {
    token: string;
    source: PluginSource;
    manifest: PluginManifest;
    permissions: PermissionInfo[];
    readme: string | null;
    hasBackend: boolean;
    existing: { version: string; status: PluginStatus; source: PluginSource } | null;
    newPermissions: string[];
    files?: number;
    bytes?: number;
}

export interface InstallResult {
    record: PluginRecord;
    /** Plugin remote: key + secret chỉ hiện một lần để cấu hình service bên ngoài. */
    remoteCredentials?: { apiKey: string; secret: string; baseUrl: string };
}

interface PendingInstall {
    token: string;
    source: PluginSource;
    dir: string;
    manifest: PluginManifest;
    createdAt: number;
}

interface ActivePlugin {
    record: PluginRecord;
    runtime: PluginRuntimeHandle | null;
    watcher: fs.FSWatcher | null;
}

interface Row {
    id: string; name: string; version: string; runtime: string; source_type: string; install_path: string;
    manifest_json: string; granted_permissions_json: string; account_ids_json: string | null; settings_json: string;
    status: string; status_reason: string | null; installed_at: number; updated_at: number;
}

const PENDING_TTL_MS = 30 * 60_000;
const REMOTE_SECRET_KEY = '__remote_secret';
export const SECRET_MASK = '••••••••';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function toRecord(row: Row): PluginRecord {
    return {
        id: row.id,
        name: row.name,
        version: row.version,
        runtime: row.runtime as PluginRuntime,
        source_type: row.source_type as PluginSource,
        install_path: row.install_path,
        manifest: parseJson<PluginManifest>(row.manifest_json, {} as PluginManifest),
        granted_permissions: parseJson<string[]>(row.granted_permissions_json, []),
        account_ids: parseJson<string[] | null>(row.account_ids_json, null),
        status: row.status as PluginStatus,
        status_reason: row.status_reason,
        installed_at: row.installed_at,
        updated_at: row.updated_at,
    };
}

function readReadme(dir: string): string | null {
    for (const name of ['README.md', 'readme.md', 'README.txt']) {
        const f = path.join(dir, name);
        try {
            if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').slice(0, 20_000);
        } catch { /* ignore */ }
    }
    return null;
}

/** Gốc plugin trong thư mục giải nén: chính nó, hoặc thư mục con duy nhất chứa manifest. */
function findPluginRoot(dir: string): string {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return dir;
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    if (subs.length === 1 && fs.existsSync(path.join(dir, subs[0].name, MANIFEST_FILE))) return path.join(dir, subs[0].name);
    throw new ApiError(400, 'VALIDATION_ERROR', `Gói ứng dụng không có ${MANIFEST_FILE} ở thư mục gốc`);
}

/** Kiểm tra + chuẩn hoá giá trị cài đặt theo schema. Trả lỗi đọc được. */
export function validateSettings(schema: SettingsSchema | undefined, input: Record<string, any>): { ok: true; values: Record<string, any>; errors?: undefined } | { ok: false; errors: string[]; values?: undefined } {
    const props = schema?.properties || {};
    const out: Record<string, any> = {};
    const errors: string[] = [];
    for (const [key, field] of Object.entries(props) as Array<[string, SettingsField]>) {
        let v = input[key];
        if (v === undefined || v === null || v === '') {
            if (schema?.required?.includes(key) && field.default === undefined) errors.push(`${field.title || key}: bắt buộc`);
            if (field.default !== undefined) out[key] = field.default;
            continue;
        }
        if (field.type === 'boolean') {
            v = v === true || v === 'true' || v === 1 || v === '1';
        } else if (field.type === 'number' || field.type === 'integer') {
            const n = Number(v);
            if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) { errors.push(`${field.title || key}: phải là số${field.type === 'integer' ? ' nguyên' : ''}`); continue; }
            if (field.minimum !== undefined && n < field.minimum) { errors.push(`${field.title || key}: tối thiểu ${field.minimum}`); continue; }
            if (field.maximum !== undefined && n > field.maximum) { errors.push(`${field.title || key}: tối đa ${field.maximum}`); continue; }
            v = n;
        } else {
            v = String(v);
            if (v.length > (field.maxLength ?? 10_000)) { errors.push(`${field.title || key}: tối đa ${field.maxLength ?? 10_000} ký tự`); continue; }
        }
        if (field.enum && !field.enum.some(e => e === v || String(e) === String(v))) { errors.push(`${field.title || key}: không nằm trong danh sách cho phép`); continue; }
        out[key] = v;
    }
    return errors.length ? { ok: false, errors } : { ok: true, values: out };
}

class PluginManager {
    private static instance: PluginManager | null = null;
    private deps: PluginManagerDeps;
    private pending = new Map<string, PendingInstall>();
    private active = new Map<string, ActivePlugin>();
    private starting = new Map<string, Promise<PluginRecord>>();
    private requestHandler: PluginRequestHandler | null = null;
    readonly storage: PluginStorage;
    readonly logs: PluginLogStore;

    constructor(deps?: Partial<PluginManagerDeps>) {
        this.deps = {
            userDataDir: () => {
                const { app } = require('electron');
                return app.getPath('userData');
            },
            appVersion: () => require('../api/runtime').appVersion(),
            workspaceKey: () => {
                const ws = require('../api/runtime').activeWorkspace();
                return String(ws?.id || 'default').replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
            },
            createRuntime: () => null,
            ...deps,
        };
        this.storage = new PluginStorage(() => this.dataRoot());
        this.logs = new PluginLogStore();
    }

    static getInstance(): PluginManager {
        if (!PluginManager.instance) PluginManager.instance = new PluginManager();
        return PluginManager.instance;
    }

    /** Test: thay instance. */
    static setInstanceForTests(instance: PluginManager | null): void {
        PluginManager.instance = instance;
    }

    configure(deps: Partial<PluginManagerDeps>): void {
        this.deps = { ...this.deps, ...deps };
    }

    // ─── Đường dẫn ───────────────────────────────────────────────────────

    pluginsRoot(): string {
        return path.join(this.deps.userDataDir(), 'plugins', this.deps.workspaceKey());
    }

    tmpRoot(): string {
        return path.join(this.deps.userDataDir(), 'plugins-tmp');
    }

    dataRoot(): string {
        return path.join(this.deps.userDataDir(), 'plugin-data', this.deps.workspaceKey());
    }

    private log(id: string, level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
        this.logs.append(id, level, msg);
    }

    private changed(): void {
        try { this.deps.onChanged?.(); } catch { /* ignore */ }
    }

    // ─── Đọc ─────────────────────────────────────────────────────────────

    private rows(): Row[] {
        if (!apiTablesExist()) return [];
        return apiDb().query<Row>('SELECT * FROM plugins ORDER BY name COLLATE NOCASE');
    }

    get(id: string): PluginRecord | null {
        if (!apiTablesExist()) return null;
        const row = apiDb().queryOne<Row>('SELECT * FROM plugins WHERE id = ?', [id]);
        return row ? toRecord(row) : null;
    }

    private require(id: string): PluginRecord {
        const rec = this.get(id);
        if (!rec) throw new ApiError(404, 'NOT_FOUND', `Không có ứng dụng ${id}`);
        return rec;
    }

    list(): Array<PluginRecord & { running: boolean; stats: RuntimeStats | null; permissions: PermissionInfo[]; icon: string | null }> {
        return this.rows().map(toRecord).map(rec => {
            const act = this.active.get(rec.id);
            return {
                ...rec,
                running: !!act,
                stats: act?.runtime ? act.runtime.stats() : null,
                permissions: describePermissions(rec.granted_permissions),
                icon: pluginIconDataUrl(rec),
            };
        });
    }

    isActive(id: string): boolean {
        return this.active.has(id);
    }

    activeRecords(): PluginRecord[] {
        return Array.from(this.active.values()).map(a => a.record);
    }

    runtimeFor(id: string): PluginRuntimeHandle | null {
        return this.active.get(id)?.runtime || null;
    }

    /** Principal plugin:<id> với scope đã duyệt — null nếu plugin không bật. */
    principalFor(id: string): Principal | null {
        const act = this.active.get(id);
        if (!act) return null;
        const rec = act.record;
        return pluginPrincipal(rec.id, rec.name, apiScopesOf(rec.granted_permissions), rec.account_ids);
    }

    // ─── Cài đặt ─────────────────────────────────────────────────────────

    private cleanupPending(): void {
        const now = Date.now();
        for (const [token, p] of this.pending) {
            if (now - p.createdAt > PENDING_TTL_MS) this.cancelInstall(token);
        }
    }

    private preview(token: string, source: PluginSource, dir: string, manifest: PluginManifest, stats?: { files: number; bytes: number }): InstallPreview {
        const existing = this.get(manifest.id);
        const newPermissions = existing ? manifest.permissions.filter(p => !existing.granted_permissions.includes(p)) : manifest.permissions;
        return {
            token,
            source,
            manifest,
            permissions: describePermissions(manifest.permissions),
            readme: readReadme(dir),
            hasBackend: manifest.runtime === 'local',
            existing: existing ? { version: existing.version, status: existing.status, source: existing.source_type } : null,
            newPermissions,
            ...(stats || {}),
        };
    }

    /** Giải nén zip vào thư mục tạm và kiểm tra — chưa cài gì. */
    inspectZip(zipPath: string): InstallPreview {
        this.cleanupPending();
        const token = crypto.randomUUID();
        const dir = path.join(this.tmpRoot(), token);
        let stats: { files: number; bytes: number };
        try {
            stats = extractZip(zipPath, dir);
        } catch (err: any) {
            fs.rmSync(dir, { recursive: true, force: true });
            if (err instanceof ZipError) throw new ApiError(400, 'VALIDATION_ERROR', err.message);
            throw err;
        }
        try {
            const root = findPluginRoot(dir);
            const res = readManifest(root, this.deps.appVersion());
            if (!res.ok) throw new ApiError(400, 'VALIDATION_ERROR', `Manifest không hợp lệ:\n${res.errors.join('\n')}`, { errors: res.errors });
            const existing = this.get(res.manifest.id);
            if (existing && existing.source_type === 'zip' && compareSemver(res.manifest.version, existing.version) <= 0) {
                throw new ApiError(409, 'CONFLICT', `Đã cài ${existing.name} ${existing.version}; gói này là ${res.manifest.version} (cần bản mới hơn)`);
            }
            this.pending.set(token, { token, source: 'zip', dir: root, manifest: res.manifest, createdAt: Date.now() });
            return this.preview(token, 'zip', root, res.manifest, stats);
        } catch (err) {
            fs.rmSync(dir, { recursive: true, force: true });
            throw err;
        }
    }

    /** Kiểm tra thư mục dev (chạy tại chỗ, không copy). */
    inspectDevFolder(dirInput: string): InstallPreview {
        this.cleanupPending();
        const dir = path.resolve(String(dirInput || ''));
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ApiError(400, 'VALIDATION_ERROR', 'Thư mục không tồn tại');
        const res = readManifest(dir, this.deps.appVersion());
        if (!res.ok) throw new ApiError(400, 'VALIDATION_ERROR', `Manifest không hợp lệ:\n${res.errors.join('\n')}`, { errors: res.errors });
        const token = crypto.randomUUID();
        this.pending.set(token, { token, source: 'dev', dir, manifest: res.manifest, createdAt: Date.now() });
        return this.preview(token, 'dev', dir, res.manifest);
    }

    cancelInstall(token: string): void {
        const p = this.pending.get(token);
        if (!p) return;
        this.pending.delete(token);
        if (p.source === 'zip') fs.rmSync(path.join(this.tmpRoot(), token), { recursive: true, force: true });
    }

    /** Người dùng đã duyệt quyền → cài (hoặc cập nhật). */
    async confirmInstall(token: string, opts: { accountIds?: string[] | null; enable?: boolean } = {}): Promise<InstallResult> {
        const p = this.pending.get(token);
        if (!p) throw new ApiError(404, 'NOT_FOUND', 'Phiên cài đặt đã hết hạn, hãy chọn lại gói ứng dụng');
        this.pending.delete(token);
        const m = p.manifest;
        const existing = this.get(m.id);
        const wasEnabled = existing?.status === 'enabled';
        if (existing && this.active.has(m.id)) await this.deactivate(m.id);

        let installPath = p.dir;
        if (p.source === 'zip') {
            const root = this.pluginsRoot();
            fs.mkdirSync(root, { recursive: true });
            const finalDir = path.join(root, m.id);
            const backup = `${finalDir}.bak-${Date.now()}`;
            const hadOld = fs.existsSync(finalDir);
            try {
                if (hadOld) fs.renameSync(finalDir, backup);
                fs.renameSync(p.dir, finalDir);
            } catch (err: any) {
                if (hadOld && !fs.existsSync(finalDir) && fs.existsSync(backup)) fs.renameSync(backup, finalDir);
                fs.rmSync(path.join(this.tmpRoot(), token), { recursive: true, force: true });
                if (wasEnabled) await this.enable(m.id).catch(() => undefined);
                throw new ApiError(500, 'INTERNAL_ERROR', `Không chép được ứng dụng vào thư mục cài: ${err?.message || err}`);
            }
            if (hadOld) fs.rmSync(backup, { recursive: true, force: true });
            fs.rmSync(path.join(this.tmpRoot(), token), { recursive: true, force: true });
            installPath = finalDir;
        }

        // Chuyển từ bản zip sang thư mục dev → dọn mã zip cũ.
        if (p.source === 'dev' && existing?.source_type === 'zip') {
            const root = path.resolve(this.pluginsRoot());
            const old = path.resolve(existing.install_path);
            if (old.startsWith(root + path.sep)) fs.rmSync(old, { recursive: true, force: true });
        }

        const now = Date.now();
        const accountIds = opts.accountIds === undefined
            ? (Array.isArray(m.accounts) ? m.accounts : null)
            : (opts.accountIds && opts.accountIds.length ? opts.accountIds.map(String) : null);
        const prevSettings = existing ? this.rawSettings(m.id) : {};
        let remoteCredentials: InstallResult['remoteCredentials'];
        if (m.runtime === 'remote') {
            const secret = prevSettings[REMOTE_SECRET_KEY] ? decryptSecret(prevSettings[REMOTE_SECRET_KEY]) : '';
            const newSecret = secret || `rps_${crypto.randomBytes(24).toString('base64url')}`;
            prevSettings[REMOTE_SECRET_KEY] = encryptSecret(newSecret);
            const keys = require('../api/auth/ApiKeyService').default.getInstance();
            keys.revokeByPlugin(m.id);
            const scopes = apiScopesOf(m.permissions);
            // Plugin remote không xin scope API nào (chỉ node/route) → không cần key gọi ngược.
            const created = scopes.length
                ? keys.create({
                    name: `Plugin ${m.name}`,
                    scopes,
                    accountIds,
                    pluginId: m.id,
                    createdBy: 'plugin-install',
                    note: `Tự tạo khi cài ứng dụng ${m.id}`,
                })
                : null;
            remoteCredentials = { apiKey: created?.key || '', secret: newSecret, baseUrl: m.remote!.baseUrl };
        }

        const db = apiDb();
        db.run(
            `INSERT INTO plugins (id, name, version, runtime, source_type, install_path, manifest_json, granted_permissions_json, account_ids_json, settings_json, status, status_reason, installed_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, runtime=excluded.runtime, source_type=excluded.source_type,
               install_path=excluded.install_path, manifest_json=excluded.manifest_json, granted_permissions_json=excluded.granted_permissions_json,
               account_ids_json=excluded.account_ids_json, settings_json=excluded.settings_json, status=excluded.status, status_reason=excluded.status_reason,
               updated_at=excluded.updated_at`,
            [m.id, m.name, m.version, m.runtime, p.source, installPath, JSON.stringify(m), JSON.stringify(m.permissions),
                accountIds ? JSON.stringify(accountIds) : null, JSON.stringify(prevSettings), 'disabled', null, existing?.installed_at || now, now],
        );
        this.log(m.id, 'info', existing ? `Cập nhật ${existing.version} → ${m.version}` : `Cài ${m.version} (${p.source})`);

        let record = this.require(m.id);
        if (opts.enable ?? (wasEnabled || !existing)) {
            try {
                record = await this.enable(m.id, existing && existing.version !== m.version ? existing.version : undefined);
            } catch (err: any) {
                this.log(m.id, 'error', `Không bật được sau khi cài: ${err?.message || err}`);
                record = this.require(m.id);
            }
        }
        this.changed();
        return { record, remoteCredentials };
    }

    // ─── Bật / tắt ───────────────────────────────────────────────────────

    private setStatus(id: string, status: PluginStatus, reason: string | null): void {
        apiDb().run('UPDATE plugins SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', [status, reason, Date.now(), id]);
    }

    enable(id: string, prevVersion?: string): Promise<PluginRecord> {
        const inflight = this.starting.get(id);
        if (inflight) return inflight;
        const job = this.doEnable(id, prevVersion).finally(() => this.starting.delete(id));
        this.starting.set(id, job);
        return job;
    }

    private async doEnable(id: string, prevVersion?: string): Promise<PluginRecord> {
        const rec = this.require(id);
        if (this.active.has(id)) return rec;

        // Đọc lại manifest trên đĩa (dev sửa file, zip bị xoá tay…).
        const res = fs.existsSync(rec.install_path) ? readManifest(rec.install_path, this.deps.appVersion()) : { ok: false as const, errors: ['Thư mục ứng dụng không còn trên máy'] };
        if (!res.ok) {
            this.setStatus(id, 'invalid', res.errors.join('; ').slice(0, 1000));
            this.changed();
            throw new ApiError(400, 'VALIDATION_ERROR', `Ứng dụng không hợp lệ: ${res.errors[0]}`);
        }
        if (res.manifest.id !== id) {
            this.setStatus(id, 'invalid', `id trong manifest đã đổi thành ${res.manifest.id}`);
            throw new ApiError(400, 'VALIDATION_ERROR', 'id trong manifest đã đổi; cài lại ứng dụng');
        }
        const added = res.manifest.permissions.filter(p => !rec.granted_permissions.includes(p));
        if (added.length) {
            this.setStatus(id, 'disabled', `Bản mới xin thêm quyền: ${added.join(', ')} — cài lại để duyệt`);
            this.changed();
            throw new ApiError(403, 'FORBIDDEN_SCOPE', `Ứng dụng xin thêm quyền chưa duyệt: ${added.join(', ')}`);
        }
        if (rec.source_type === 'dev') {
            apiDb().run('UPDATE plugins SET manifest_json = ?, version = ?, name = ? WHERE id = ?', [JSON.stringify(res.manifest), res.manifest.version, res.manifest.name, id]);
        }
        const record: PluginRecord = { ...rec, manifest: res.manifest, version: res.manifest.version, name: res.manifest.name };

        const max = getApiSettingNumber('plugins_max_enabled') || 10;
        if (this.active.size >= max) throw new ApiError(409, 'CONFLICT', `Đã bật tối đa ${max} ứng dụng (đổi ở Công cụ → Ứng dụng, API & Webhook → Giới hạn chung)`);

        const runtime = this.deps.createRuntime({
            record,
            dataDir: this.storage.dataDir(id),
            onRequest: (method, params) => (this.requestHandler
                ? this.requestHandler(id, method, params, 'backend')
                : Promise.reject(new ApiError(503, 'NOT_IMPLEMENTED', 'Cầu API plugin chưa sẵn sàng'))),
            onLog: (level, message) => this.log(id, level, message),
            onFatal: reason => { void this.disable(id, { status: 'disabled_crash', reason }); },
            remoteSecret: () => decryptSecret(this.rawSettings(id)[REMOTE_SECRET_KEY] || ''),
        });
        const act: ActivePlugin = { record, runtime, watcher: null };
        this.active.set(id, act);
        try {
            if (runtime) await runtime.start({ settings: this.settingsFor(id), prevVersion });
            this.deps.onActivated?.(record);
        } catch (err: any) {
            this.active.delete(id);
            await runtime?.stop().catch(() => undefined);
            const reason = `Không khởi động được: ${err?.message || err}`;
            this.setStatus(id, 'disabled', reason.slice(0, 1000));
            this.log(id, 'error', reason);
            this.changed();
            throw new ApiError(502, 'UPSTREAM_ERROR', reason);
        }
        if (record.source_type === 'dev') act.watcher = this.watchDev(record);
        this.setStatus(id, 'enabled', null);
        this.log(id, 'info', `Đã bật ${record.version}`);
        this.changed();
        return this.require(id);
    }

    /** Dừng phần chạy + huỷ đăng ký (không đổi trạng thái trong DB). */
    private async deactivate(id: string): Promise<void> {
        const act = this.active.get(id);
        if (!act) return;
        this.active.delete(id);
        try { act.watcher?.close(); } catch { /* ignore */ }
        try { this.deps.onDeactivated?.(act.record); } catch (err: any) { this.deps.logError?.(`[Plugins] onDeactivated ${id}: ${err?.message || err}`); }
        if (act.runtime) {
            await act.runtime.stop().catch(err => this.log(id, 'warn', `Dừng không sạch: ${err?.message || err}`));
        }
    }

    async disable(id: string, opts: { status?: PluginStatus; reason?: string } = {}): Promise<PluginRecord> {
        this.require(id);
        await this.deactivate(id);
        this.setStatus(id, opts.status || 'disabled', opts.reason || null);
        this.log(id, opts.status === 'disabled_crash' ? 'error' : 'info', opts.reason ? `Đã tắt: ${opts.reason}` : 'Đã tắt');
        this.changed();
        return this.require(id);
    }

    async reload(id: string): Promise<PluginRecord> {
        await this.deactivate(id);
        return this.enable(id);
    }

    async uninstall(id: string, opts: { deleteData?: boolean } = {}): Promise<void> {
        const rec = this.require(id);
        await this.deactivate(id);
        if (rec.source_type === 'zip') {
            const root = path.resolve(this.pluginsRoot());
            const target = path.resolve(rec.install_path);
            if (target.startsWith(root + path.sep)) fs.rmSync(target, { recursive: true, force: true });
        }
        apiDb().run('DELETE FROM plugins WHERE id = ?', [id]);
        try { require('../api/auth/ApiKeyService').default.getInstance().revokeByPlugin(id); } catch { /* ignore */ }
        try { require('../api/ApiPlatform').default.getInstance().getWebhooks().removeByOwner(`plugin:${id}`); } catch { /* ignore */ }
        if (opts.deleteData) {
            this.storage.clear(id);
            this.storage.removeDataDir(id);
            this.logs.clear(id);
        } else {
            this.log(id, 'info', 'Đã gỡ ứng dụng (giữ dữ liệu)');
        }
        this.changed();
    }

    /** Khởi động plugin đang bật (mở app, đổi workspace). Không tạo bảng nếu chưa dùng plugin. */
    async startEnabled(): Promise<void> {
        for (const row of this.rows()) {
            if (row.status !== 'enabled' || this.active.has(row.id)) continue;
            try {
                await this.enable(row.id);
            } catch (err: any) {
                this.deps.logError?.(`[Plugins] start ${row.id}: ${err?.message || err}`);
            }
        }
    }

    async stopAll(): Promise<void> {
        const ids = Array.from(this.active.keys());
        await Promise.all(ids.map(id => this.deactivate(id)));
        this.logs.flush();
        if (ids.length) this.changed();
    }

    private watchDev(rec: PluginRecord): fs.FSWatcher | null {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const watcher = fs.watch(rec.install_path, { recursive: true }, (_event, file) => {
                const name = String(file || '').replace(/\\/g, '/');
                if (!name || name.startsWith('node_modules/') || name.startsWith('.git/') || name.startsWith('ui/')) return;
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    if (!this.active.has(rec.id)) return;
                    this.log(rec.id, 'info', `Dev: ${name} thay đổi → tải lại`);
                    this.reload(rec.id).catch(err => this.log(rec.id, 'error', `Tải lại lỗi: ${err?.message || err}`));
                }, 500);
            });
            watcher.on('error', () => { /* thư mục bị xoá */ });
            return watcher;
        } catch {
            return null;
        }
    }

    // ─── Cài đặt của plugin ──────────────────────────────────────────────

    private rawSettings(id: string): Record<string, any> {
        const row = apiTablesExist() ? apiDb().queryOne<{ settings_json: string }>('SELECT settings_json FROM plugins WHERE id = ?', [id]) : null;
        return parseJson<Record<string, any>>(row?.settings_json, {});
    }

    /** Giá trị thật (đã giải mã secret) cho chính plugin. */
    settingsFor(id: string): Record<string, any> {
        const rec = this.get(id);
        const props = rec?.manifest.contributes?.settings?.schema?.properties || {};
        const raw = this.rawSettings(id);
        const out: Record<string, any> = {};
        for (const [key, field] of Object.entries(props)) {
            if (raw[key] === undefined) {
                if (field.default !== undefined) out[key] = field.default;
                continue;
            }
            out[key] = field['x-secret'] ? decryptSecret(String(raw[key])) : raw[key];
        }
        return out;
    }

    /** Cho form trong UI: secret chỉ báo đã đặt hay chưa. */
    getSettings(id: string): { schema: SettingsSchema | null; values: Record<string, any> } {
        const rec = this.require(id);
        const schema = rec.manifest.contributes?.settings?.schema || null;
        const values = this.settingsFor(id);
        for (const [key, field] of Object.entries(schema?.properties || {})) {
            if (field['x-secret']) values[key] = values[key] ? SECRET_MASK : '';
        }
        return { schema, values };
    }

    async setSettings(id: string, input: Record<string, any>): Promise<Record<string, any>> {
        const rec = this.require(id);
        const schema = rec.manifest.contributes?.settings?.schema;
        const current = this.settingsFor(id);
        const merged: Record<string, any> = { ...input };
        for (const [key, field] of Object.entries(schema?.properties || {})) {
            if (field['x-secret'] && (input[key] === SECRET_MASK || input[key] === undefined)) merged[key] = current[key];
        }
        const res = validateSettings(schema, merged);
        if (!res.ok) throw new ApiError(400, 'VALIDATION_ERROR', res.errors.join('; '), { errors: res.errors });
        const raw = this.rawSettings(id);
        const next: Record<string, any> = {};
        if (raw[REMOTE_SECRET_KEY]) next[REMOTE_SECRET_KEY] = raw[REMOTE_SECRET_KEY];
        for (const [key, value] of Object.entries(res.values)) {
            next[key] = schema?.properties[key]?.['x-secret'] && value !== '' ? encryptSecret(String(value)) : value;
        }
        apiDb().run('UPDATE plugins SET settings_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(next), Date.now(), id]);
        const runtime = this.runtimeFor(id);
        if (runtime) {
            try { runtime.notify('settings.changed', this.settingsFor(id)); } catch { /* ignore */ }
        }
        this.changed();
        return this.getSettings(id).values;
    }

    /** Gắn cầu plugin → host (PluginApiBridge) dùng cho mọi runtime. */
    setRequestHandler(handler: PluginRequestHandler | null): void {
        this.requestHandler = handler;
    }
}

export default PluginManager;
export { PluginManager };
