/**
 * GoogleDriveService — Google Drive làm kho lưu (thay R2) cho ảnh/file + bản sao DB.
 *
 *  - Đăng nhập: OAuth "Desktop app" (PKCE + loopback 127.0.0.1, quyền drive.file) trên trình duyệt của máy. Client chung
 *    của Deplao (googleOAuthClient) hoặc client riêng người dùng nhập (client_id lưu thường, secret qua safeStorage).
 *    Mỗi lúc một lượt đăng nhập (connecting hiện trên giao diện, huỷ được).
 *  - Refresh token lưu bằng safeStorage (cloudSettings); access token chỉ nhớ trong RAM, làm mới trước hạn 60 s, một
 *    lượt làm mới cho cả app. invalid_grant = phiên chết → xoá refresh token, ghi lastError, báo giao diện.
 *  - Thư mục gốc "Deplao" trong My Drive: id lưu settings.google.rootFolderId, kiểm lại một lần mỗi phiên (mất / trong
 *    thùng rác → tìm lại theo tên, bản tạo sớm nhất; không có → tạo). "Bucket" = thư mục con Deplao/<bucket>; client
 *    kiểu R2Client = DriveStore (cache theo tên bucket, quên khi đăng nhập / ngắt kết nối).
 *  - status() không gọi mạng; refresh() đọc lại email + dung lượng (about.get).
 *  - Không đụng Electron / mạng / đĩa lúc khởi tạo (CloudflareService tạo trong constructor, kể cả khi test).
 */
import {
    CloudError, CloudSettingsData, CloudSettingsStore, CloudUsageRecorder, GoogleDriveCore, GoogleSettingsData, R2Client,
} from '../contracts';
import type { GoogleClientInput, GoogleDriveQuota, GoogleDriveStatus } from '../../../shared/cloud/cloudContracts';
import Logger from '../../../utils/Logger';
import { DriveApi, DriveApiOptions, DriveFetch, DriveFetchResponse, FOLDER_MIME, escapeQueryValue, isNotFound } from './DriveApi';
import { DriveStore, DriveStoreOptions } from './DriveStore';
import { BUILTIN_GOOGLE_CLIENT } from './googleOAuthClient';
import {
    LOGIN_TIMEOUT_MS, LoopbackLogin, MSG_CANCELLED, MSG_SESSION_EXPIRED, OAuthClient, buildAuthorizeUrl, createOAuthState,
    createPkcePair, exchangeAuthCode, refreshAccessToken, revokeToken, startLoopbackLogin,
} from './googleOAuth';

export const ROOT_FOLDER_NAME = 'Deplao';
/** Làm mới access token trước khi hết hạn bấy nhiêu ms. */
const TOKEN_SKEW_MS = 60_000;
const ABOUT_FIELDS = 'user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)';
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;

export const MSG_NOT_CONNECTED = 'Chưa đăng nhập Google Drive — đăng nhập Google ở phần Kho lưu.';
export const MSG_CLIENT_REQUIRED = 'Bản app này chưa có sẵn client Google của Deplao — nhập client OAuth riêng (mục Nâng cao) rồi đăng nhập.';
export const MSG_BAD_CLIENT_ID = 'Client ID Google không hợp lệ (dạng …apps.googleusercontent.com)';

export interface GoogleDriveDeps {
    settings: CloudSettingsStore & { peek?(): Readonly<CloudSettingsData>; assertSecretsAvailable?(): void };
    /** Gọi recordGoogle(units, { up, down }) sau mỗi request Drive tới được Google. */
    usage: CloudUsageRecorder;
    /** Trạng thái đổi → core báo giao diện. */
    notify: () => void;
    /** Mặc định require('electron').shell.openExternal (require muộn). */
    openExternal?: (url: string) => Promise<void>;
    /** Mặc định globalThis.fetch; tải xuống cần body (web stream) như R2Client. */
    fetchImpl?: (url: string, init: any) => Promise<DriveFetchResponse>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Mặc định Logger. */
    log?: (level: 'log' | 'warn', msg: string) => void;
    /** Thay client OAuth chung (test). Mặc định BUILTIN_GOOGLE_CLIENT. */
    builtinClient?: { clientId: string; clientSecret?: string | null } | null;
    /** Hạn chờ đăng nhập trên trình duyệt (mặc định 5 phút). */
    loginTimeoutMs?: number;
    /** Tuỳ chọn DriveStore (test: đoạn resumable nhỏ, ngưỡng multipart nhỏ). */
    storeOptions?: Partial<Pick<DriveStoreOptions, 'simpleUploadMax' | 'chunkSize' | 'chunkRetries' | 'fileCacheMax' | 'deleteConcurrency'>>;
    /** Tuỳ chọn hạn chót DriveApi (test). */
    apiOptions?: Partial<Pick<DriveApiOptions, 'timeoutMs' | 'idleTimeoutMs'>>;
}

type ClientChoice = { client: OAuthClient; kind: 'custom' | 'builtin' | 'saved' };

function defaultLog(level: 'log' | 'warn', msg: string): void {
    try {
        if (level === 'warn') Logger.warn(msg);
        else Logger.log(msg);
    } catch { /* log lỗi không làm hỏng việc chính */ }
}

function errMessage(err: unknown): string {
    if (err instanceof CloudError) return err.message;
    return String((err as Error)?.message || err || 'Lỗi không xác định');
}

/** 'nguyenvana@gmail.com' → 'ng***@gmail.com' (log không lộ địa chỉ đầy đủ). */
function maskEmail(email: string | null): string {
    if (!email) return '(không rõ email)';
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

function draftGoogle(d: CloudSettingsData): GoogleSettingsData {
    if (!d.google || typeof d.google !== 'object') {
        d.google = { email: null, displayName: null, rootFolderId: null, customClientId: null, connectedAt: null };
    }
    return d.google;
}

function strOrNull(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}

/** about.storageQuota (số int64 dạng chuỗi) → số; thiếu limit = không giới hạn (null). */
export function parseQuota(q: any): GoogleDriveQuota | null {
    if (!q || typeof q !== 'object') return null;
    const num = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const rawLimit = q.limit;
    const limitNum = rawLimit === undefined || rawLimit === null || rawLimit === '' ? NaN : Number(rawLimit);
    return {
        limit: Number.isFinite(limitNum) && limitNum >= 0 ? limitNum : null,
        usage: num(q.usage),
        usageInDrive: num(q.usageInDrive),
        usageInDriveTrash: num(q.usageInDriveTrash),
    };
}

export class GoogleDriveService implements GoogleDriveCore {
    readonly api: DriveApi;
    private readonly settings: GoogleDriveDeps['settings'];
    private readonly fetchImpl: DriveFetch;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly logFn: (level: 'log' | 'warn', msg: string) => void;
    private readonly builtin: { clientId: string; clientSecret: string | null };
    private readonly stores = new Map<string, DriveStore>();
    /** Tăng khi đăng nhập / ngắt kết nối / thư mục gốc đổi → mọi DriveStore quên cache. */
    private generation = 0;
    private access: { token: string; expiresAt: number; refreshToken: string } | null = null;
    private refreshing: Promise<string> | null = null;
    private quota: GoogleDriveQuota | null = null;
    private checkedAt: number | null = null;
    private lastError: string | null = null;
    private connecting = false;
    private cancelRequested = false;
    private abortLogin: (() => void) | null = null;
    /** id thư mục "Deplao" đã kiểm trong phiên này. */
    private rootVerified: string | null = null;
    private rootJob: { create: boolean; promise: Promise<string | null> } | null = null;

    constructor(private readonly deps: GoogleDriveDeps) {
        this.settings = deps.settings;
        this.fetchImpl = deps.fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init));
        this.now = deps.now ?? (() => Date.now());
        this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms))));
        this.logFn = deps.log ?? defaultLog;
        const b = deps.builtinClient === undefined ? BUILTIN_GOOGLE_CLIENT : deps.builtinClient;
        this.builtin = {
            clientId: String(b?.clientId || '').trim(),
            clientSecret: String(b?.clientSecret || '').trim() || null,
        };
        this.api = new DriveApi({
            getToken: o => this.accessToken(o),
            fetchImpl: this.fetchImpl,
            record: (units, bytes) => this.recordUsage(units, bytes),
            sleep: this.sleep,
            now: this.now,
            ...(deps.apiOptions || {}),
        });
    }

    // ── Trạng thái (không gọi mạng) ──

    status(): GoogleDriveStatus {
        let g: GoogleSettingsData = { email: null, displayName: null, rootFolderId: null, customClientId: null, connectedAt: null };
        let connected = false;
        let lastError = this.lastError;
        try {
            g = this.googleSettings();
            connected = !!this.settings.getGoogleRefreshToken();
        } catch (err) {
            lastError = lastError ?? errMessage(err);
        }
        const custom = g.customClientId || null;
        return {
            connected,
            email: g.email,
            displayName: g.displayName,
            customClient: !!custom,
            builtinClient: !!this.builtin.clientId,
            clientId: custom || this.builtin.clientId || null,
            quota: this.quota ? { ...this.quota } : null,
            checkedAt: this.checkedAt,
            lastError,
            connecting: this.connecting,
        };
    }

    isConnected(): boolean {
        try {
            return !!this.settings.getGoogleRefreshToken();
        } catch {
            return false;
        }
    }

    // ── Đăng nhập / ngắt kết nối ──

    async connect(client?: GoogleClientInput | null): Promise<GoogleDriveStatus> {
        if (this.connecting) throw new CloudError('BUSY', 'Đang chờ đăng nhập Google trên trình duyệt — hoàn tất hoặc bấm Huỷ trước.');
        const choice = this.pickClient(client);
        // Không lưu được refresh token thì dừng trước khi mở trình duyệt
        this.settings.assertSecretsAvailable?.();
        this.connecting = true;
        this.cancelRequested = false;
        this.lastError = null;
        this.safeNotify();
        let login: LoopbackLogin | null = null;
        try {
            const pkce = createPkcePair();
            const state = createOAuthState();
            login = await startLoopbackLogin({ state, timeoutMs: this.deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS });
            const current = login;
            this.abortLogin = () => current.cancel();
            this.throwIfCancelled();
            const url = buildAuthorizeUrl({ clientId: choice.client.clientId, redirectUri: login.redirectUri, codeChallenge: pkce.challenge, state });
            try {
                await this.openExternal(url);
            } catch {
                throw new CloudError('GOOGLE_BROWSER', 'Không mở được trình duyệt để đăng nhập Google — kiểm tra trình duyệt mặc định của máy.');
            }
            const { code } = await login.result;
            this.throwIfCancelled();
            const tokens = await exchangeAuthCode(this.fetchImpl, choice.client, { code, codeVerifier: pkce.verifier, redirectUri: login.redirectUri }, this.now);
            this.throwIfCancelled();
            // Refresh token chưa lưu → đọc email / dung lượng bằng access token vừa nhận
            const about = await this.api.withToken(tokens.accessToken).about(ABOUT_FIELDS);
            this.throwIfCancelled();
            this.saveLogin(choice, tokens, about);
            try {
                await this.rootId(true);
            } catch (err) {
                this.log('warn', `[GoogleDrive] Chưa tạo được thư mục "${ROOT_FOLDER_NAME}" (sẽ thử lại khi lưu file): ${errMessage(err)}`);
            }
        } catch (err) {
            if (!(err instanceof CloudError && err.code === 'CANCELLED')) this.lastError = errMessage(err);
            throw err;
        } finally {
            this.connecting = false;
            this.abortLogin = null;
            login?.cancel(); // đóng máy chủ loopback nếu còn mở (đã xong thì không làm gì)
            this.safeNotify();
        }
        return this.status();
    }

    cancelConnect(): void {
        if (!this.connecting) return;
        this.cancelRequested = true;
        try { this.abortLogin?.(); } catch { /* bỏ qua */ }
    }

    async disconnect(): Promise<void> {
        this.cancelConnect();
        let token: string | null = null;
        try { token = this.settings.getGoogleRefreshToken(); } catch { token = null; }
        if (token) {
            // Thu hồi cả quyền Deplao trên tài khoản Google (best effort — lỗi vẫn xoá phiên trên máy)
            const ok = await revokeToken(this.fetchImpl, token).catch(() => false);
            if (!ok) this.log('warn', '[GoogleDrive] Không thu hồi được quyền trên Google (bỏ qua) — vẫn xoá phiên trên máy');
        }
        this.settings.setGoogleRefreshToken(null);
        this.settings.update(d => {
            const g = draftGoogle(d);
            g.email = null;
            g.displayName = null;
            g.rootFolderId = null;
            g.connectedAt = null;
            // customClientId + client secret giữ lại để đăng nhập lại cho nhanh
        });
        this.access = null;
        this.quota = null;
        this.checkedAt = null;
        this.lastError = null;
        this.resetDriveState();
        this.log('log', '[GoogleDrive] Đã ngắt kết nối Google Drive (xoá phiên trên máy, file trên Drive giữ nguyên)');
        this.safeNotify();
    }

    async refresh(): Promise<GoogleDriveStatus> {
        if (!this.isConnected()) throw new CloudError('NOT_CONNECTED', MSG_NOT_CONNECTED);
        try {
            const about = await this.api.about(ABOUT_FIELDS);
            this.applyAbout(about);
            this.checkedAt = this.now();
            this.lastError = null;
        } catch (err) {
            this.lastError = errMessage(err);
            this.safeNotify();
            throw err;
        }
        this.safeNotify();
        return this.status();
    }

    // ── Kho ──

    store(bucket: string): R2Client {
        const name = String(bucket ?? '').trim();
        if (!name || name.includes('/')) throw new CloudError('BAD_BUCKET', 'Tên thư mục lưu không hợp lệ');
        let s = this.stores.get(name);
        if (!s) {
            s = new DriveStore({
                bucket: name,
                api: this.api,
                rootId: create => this.rootId(create),
                invalidateRoot: () => this.invalidateRoot(),
                generation: () => this.generation,
                now: this.now,
                sleep: this.sleep,
                ...(this.deps.storeOptions || {}),
            });
            this.stores.set(name, s);
        }
        return s;
    }

    async ensureBucket(name: string): Promise<void> {
        await (this.store(name) as DriveStore).ensureBucketFolder();
    }

    async listBuckets(prefix: string): Promise<string[]> {
        const pre = String(prefix ?? '');
        const root = await this.rootId(false);
        if (!root) return [];
        const names = new Set<string>();
        let pageToken: string | null = null;
        for (let page = 0; page < 100; page++) {
            const res = await this.api.listFiles({
                q: `'${escapeQueryValue(root)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
                fields: 'nextPageToken,files(id,name)',
                orderBy: 'name',
                pageSize: 1000,
                pageToken,
            });
            for (const f of res.files) {
                const n = String(f.name || '');
                if (n && n.startsWith(pre)) names.add(n);
            }
            pageToken = res.nextPageToken;
            if (!pageToken) break;
        }
        return Array.from(names).sort();
    }

    // ── Token ──

    /**
     * Access token còn hạn (≥ 60 s) hoặc làm mới (một lượt cho cả app). force + rejected: token đó vừa bị Google từ
     * chối (401) — đã có token khác mới hơn thì dùng luôn, không làm mới lại.
     */
    async accessToken(opts: { force?: boolean; rejected?: string } = {}): Promise<string> {
        const refreshToken = this.settings.getGoogleRefreshToken();
        if (!refreshToken) {
            throw new CloudError('NOT_CONNECTED', this.lastError === MSG_SESSION_EXPIRED ? MSG_SESSION_EXPIRED : MSG_NOT_CONNECTED);
        }
        const a = this.access;
        const valid = !!a && a.refreshToken === refreshToken && a.expiresAt - TOKEN_SKEW_MS > this.now();
        if (valid && (!opts.force || (opts.rejected !== undefined && opts.rejected !== a.token))) return a.token;
        if (!this.refreshing) {
            const run = this.refreshAccess(refreshToken);
            this.refreshing = run;
            run.then(
                () => { if (this.refreshing === run) this.refreshing = null; },
                () => { if (this.refreshing === run) this.refreshing = null; },
            );
        }
        return this.refreshing;
    }

    private async refreshAccess(refreshToken: string): Promise<string> {
        const client = this.activeClient();
        if (!client) throw new CloudError('GOOGLE_CLIENT_REQUIRED', MSG_CLIENT_REQUIRED);
        try {
            const t = await refreshAccessToken(this.fetchImpl, client, refreshToken, this.now);
            // Phiên bị thay giữa chừng (ngắt kết nối / đăng nhập lại) → bỏ kết quả
            if (this.settings.getGoogleRefreshToken() !== refreshToken) throw new CloudError('NOT_CONNECTED', MSG_NOT_CONNECTED);
            let rt = refreshToken;
            if (t.refreshToken && t.refreshToken !== refreshToken) {
                // Google hiếm khi xoay refresh token; có thì lưu bản mới
                try {
                    this.settings.setGoogleRefreshToken(t.refreshToken);
                    rt = t.refreshToken;
                } catch (err) {
                    this.log('warn', `[GoogleDrive] Không lưu được phiên Google mới: ${errMessage(err)}`);
                }
            }
            this.access = { token: t.accessToken, expiresAt: t.expiresAt, refreshToken: rt };
            return t.accessToken;
        } catch (err) {
            if (err instanceof CloudError && err.code === 'GOOGLE_INVALID_GRANT') {
                this.onSessionDead(refreshToken);
                throw new CloudError('NOT_CONNECTED', MSG_SESSION_EXPIRED);
            }
            throw err;
        }
    }

    /** Refresh token bị Google từ chối (hết hạn / thu hồi / đổi mật khẩu…) → xoá trên máy, báo đăng nhập lại. */
    private onSessionDead(refreshToken: string): void {
        let current: string | null = null;
        try { current = this.settings.getGoogleRefreshToken(); } catch { current = null; }
        if (current !== refreshToken) return;
        try {
            this.settings.setGoogleRefreshToken(null);
        } catch (err) {
            this.log('warn', `[GoogleDrive] Không xoá được phiên Google đã hết hạn: ${errMessage(err)}`);
        }
        this.access = null;
        this.lastError = MSG_SESSION_EXPIRED;
        this.resetDriveState();
        this.log('warn', '[GoogleDrive] Phiên Google đã hết hạn hoặc bị thu hồi — cần đăng nhập lại Google Drive');
        this.safeNotify();
    }

    // ── Thư mục gốc "Deplao" ──

    /** id thư mục "Deplao" (kiểm một lần mỗi phiên; create=false: không tạo, null nếu chưa có). */
    rootId(create: boolean): Promise<string | null> {
        if (this.rootVerified) return Promise.resolve(this.rootVerified);
        const job = this.rootJob;
        if (job) {
            if (job.create || !create) return job.promise;
            return job.promise.then(id => id ?? this.rootId(create));
        }
        const promise: Promise<string | null> = this.resolveRoot(create).finally(() => {
            if (this.rootJob && this.rootJob.promise === promise) this.rootJob = null;
        });
        this.rootJob = { create, promise };
        return promise;
    }

    private invalidateRoot(): void {
        this.rootVerified = null;
    }

    private async resolveRoot(create: boolean): Promise<string | null> {
        const gen = this.generation;
        const saved = this.googleSettings().rootFolderId;
        if (saved) {
            let alive = false;
            try {
                const f = await this.api.getFile(saved, 'id,trashed,mimeType');
                alive = !!f && !f.trashed && (!f.mimeType || f.mimeType === FOLDER_MIME);
            } catch (err) {
                // 404: đã xoá hẳn, hoặc do client OAuth khác tạo (drive.file không thấy) → tìm lại
                if (!isNotFound(err)) throw err;
            }
            if (alive) return this.acceptRoot(saved, gen);
        }
        const res = await this.api.listFiles({
            q: `name = '${ROOT_FOLDER_NAME}' and 'root' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
            fields: 'files(id,name,createdTime)',
            orderBy: 'createdTime',
            pageSize: 10,
        });
        const found = res.files
            .filter(f => f.name === ROOT_FOLDER_NAME)
            .sort((a, b) => (Date.parse(a.createdTime || '') || 0) - (Date.parse(b.createdTime || '') || 0))[0];
        if (found) return this.acceptRoot(found.id, gen);
        if (!create) return null;
        const created = await this.api.createFolder(ROOT_FOLDER_NAME, 'root');
        this.log('log', `[GoogleDrive] Đã tạo thư mục "${ROOT_FOLDER_NAME}" trong Google Drive`);
        return this.acceptRoot(created.id, gen);
    }

    private acceptRoot(id: string, gen: number): string {
        // Đăng nhập lại / ngắt kết nối giữa chừng → không ghi đè cấu hình của phiên mới
        if (gen !== this.generation) return id;
        const saved = this.googleSettings().rootFolderId;
        if (saved !== id) {
            try {
                this.settings.update(d => { draftGoogle(d).rootFolderId = id; });
            } catch (err) {
                this.log('warn', `[GoogleDrive] Không lưu được id thư mục "${ROOT_FOLDER_NAME}": ${errMessage(err)}`);
            }
            // Gốc đổi → id thư mục con đã nhớ trong các store không còn đúng
            if (saved) this.generation++;
        }
        this.rootVerified = id;
        return id;
    }

    // ── Nội bộ ──

    private pickClient(input: GoogleClientInput | null | undefined): ClientChoice {
        if (input) {
            const clientId = String(input.clientId ?? '').trim();
            if (!clientId || clientId.length > 256 || !CLIENT_ID_RE.test(clientId)) throw new CloudError('BAD_INPUT', MSG_BAD_CLIENT_ID);
            let secret = String(input.clientSecret ?? '').trim();
            if (secret && (secret.length > 256 || !/^[\x21-\x7e]+$/.test(secret))) throw new CloudError('BAD_INPUT', 'Client secret Google không hợp lệ');
            // Đăng nhập lại bằng client riêng đã lưu (giao diện chỉ gửi Client ID) → dùng lại secret đã lưu, không xoá mất
            if (!secret && clientId === this.googleSettings().customClientId) secret = String(this.settings.getGoogleClientSecret() || '');
            return { client: { clientId, clientSecret: secret || null }, kind: 'custom' };
        }
        if (this.builtin.clientId) return { client: { clientId: this.builtin.clientId, clientSecret: this.builtin.clientSecret }, kind: 'builtin' };
        const saved = this.googleSettings().customClientId;
        if (saved) return { client: { clientId: saved, clientSecret: this.settings.getGoogleClientSecret() }, kind: 'saved' };
        throw new CloudError('GOOGLE_CLIENT_REQUIRED', MSG_CLIENT_REQUIRED);
    }

    /** Client đã cấp refresh token đang lưu: client riêng nếu có, không thì client chung. */
    private activeClient(): OAuthClient | null {
        const custom = this.googleSettings().customClientId;
        if (custom) return { clientId: custom, clientSecret: this.settings.getGoogleClientSecret() };
        return this.builtin.clientId ? { clientId: this.builtin.clientId, clientSecret: this.builtin.clientSecret } : null;
    }

    private saveLogin(choice: ClientChoice, tokens: { accessToken: string; expiresAt: number; refreshToken: string }, about: any): void {
        const prev = this.googleSettings();
        const email = strOrNull(about?.user?.emailAddress);
        const displayName = strOrNull(about?.user?.displayName);
        const sameAccount = !!email && !!prev.email && email.toLowerCase() === prev.email.toLowerCase();
        this.settings.setGoogleRefreshToken(tokens.refreshToken);
        if (choice.kind === 'custom') this.settings.setGoogleClientSecret(choice.client.clientSecret || null);
        else if (choice.kind === 'builtin') this.settings.setGoogleClientSecret(null);
        this.settings.update(d => {
            const g = draftGoogle(d);
            g.email = email;
            g.displayName = displayName;
            g.connectedAt = this.now();
            if (choice.kind === 'custom') g.customClientId = choice.client.clientId;
            else if (choice.kind === 'builtin') g.customClientId = null;
            // Tài khoản khác → thư mục "Deplao" của tài khoản cũ không dùng được
            if (!sameAccount) g.rootFolderId = null;
        });
        this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt, refreshToken: tokens.refreshToken };
        this.quota = parseQuota(about?.storageQuota);
        this.checkedAt = this.now();
        this.lastError = null;
        this.resetDriveState();
        this.log('log', `[GoogleDrive] Đã kết nối Google Drive ${maskEmail(email)}${choice.kind === 'builtin' ? '' : ' (client OAuth riêng)'}`);
    }

    private applyAbout(about: any): void {
        const quota = parseQuota(about?.storageQuota);
        if (quota) this.quota = quota;
        const email = strOrNull(about?.user?.emailAddress);
        const displayName = strOrNull(about?.user?.displayName);
        const g = this.googleSettings();
        if ((email && email !== g.email) || (displayName && displayName !== g.displayName)) {
            try {
                this.settings.update(d => {
                    const x = draftGoogle(d);
                    if (email) x.email = email;
                    if (displayName) x.displayName = displayName;
                });
            } catch (err) {
                this.log('warn', `[GoogleDrive] Không lưu được thông tin tài khoản Google: ${errMessage(err)}`);
            }
        }
    }

    private resetDriveState(): void {
        this.generation++;
        this.stores.clear();
        this.rootVerified = null;
        this.rootJob = null;
    }

    private googleSettings(): GoogleSettingsData {
        const s = this.settings.peek ? this.settings.peek() : this.settings.get();
        const g: Partial<GoogleSettingsData> = s && s.google ? s.google : {};
        return {
            email: g.email ?? null,
            displayName: g.displayName ?? null,
            rootFolderId: g.rootFolderId ?? null,
            customClientId: g.customClientId ?? null,
            connectedAt: g.connectedAt ?? null,
        };
    }

    private throwIfCancelled(): void {
        if (this.cancelRequested) throw new CloudError('CANCELLED', MSG_CANCELLED);
    }

    private openExternal(url: string): Promise<void> {
        if (this.deps.openExternal) return this.deps.openExternal(url);
        const { shell } = require('electron');
        return Promise.resolve(shell.openExternal(url));
    }

    private recordUsage(units: number, bytes: { up?: number; down?: number }): void {
        try {
            this.deps.usage?.recordGoogle(units, bytes);
        } catch { /* bộ đếm lỗi không làm hỏng request */ }
    }

    private safeNotify(): void {
        try {
            this.deps.notify();
        } catch (err) {
            this.log('warn', `[GoogleDrive] notify lỗi: ${errMessage(err)}`);
        }
    }

    private log(level: 'log' | 'warn', msg: string): void {
        try { this.logFn(level, msg); } catch { /* bỏ qua */ }
    }
}
