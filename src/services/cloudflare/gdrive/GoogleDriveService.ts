/**
 * GoogleDriveService: Google Drive as the storage (instead of R2) for images / files + the DB copies.
 *
 *  - Sign-in: OAuth "Desktop app" (PKCE + loopback 127.0.0.1, drive.file scope) in the machine's browser. The shared client
 *    of Deplao (googleOAuthClient) or a private client entered by the user (client_id stored normally, secret via safeStorage).
 *    Only one sign-in at a time (connecting shows in the UI, and it can be cancelled).
 *  - Refresh token stored with safeStorage (cloudSettings); the access token is kept only in RAM, refreshed 60 s before it expires, with one
 *    refresh shared by the whole app. invalid_grant = the session is dead → delete the refresh token, write lastError, notify the UI.
 *  - Root folder "Deplao" in My Drive: id stored in settings.google.rootFolderId, re-checked once per session (missing / in the
 *    trash → look it up by name again, the earliest-created one; none found → create it). "Bucket" = subfolder Deplao/<bucket>; a client
 *    of the R2Client kind = DriveStore (cache per bucket name, forgotten on sign-in / disconnect).
 *  - status() makes no network calls; refresh() reloads the email + quota (about.get).
 *  - Touches neither Electron / network / disk at startup (CloudflareService creates it in its constructor, even in tests).
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
import { tr } from '../../../shared/i18n';

export const ROOT_FOLDER_NAME = 'Deplao';
/** Refresh the access token this many ms before it expires. */
const TOKEN_SKEW_MS = 60_000;
const ABOUT_FIELDS = 'user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)';
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;

export const MSG_NOT_CONNECTED = tr('Chưa đăng nhập Google Drive — đăng nhập Google ở phần Kho lưu.');
export const MSG_CLIENT_REQUIRED = tr('Bản app này chưa có sẵn client Google của Deplao — nhập client OAuth riêng (mục Nâng cao) rồi đăng nhập.');
export const MSG_BAD_CLIENT_ID = tr('Client ID Google không hợp lệ (dạng …apps.googleusercontent.com)');

export interface GoogleDriveDeps {
    settings: CloudSettingsStore & { peek?(): Readonly<CloudSettingsData>; assertSecretsAvailable?(): void };
    /** Calls recordGoogle(units, { up, down }) after every Drive request that reaches Google. */
    usage: CloudUsageRecorder;
    /** State changed → core notifies the UI. */
    notify: () => void;
    /** Default: require('electron').shell.openExternal (late require). */
    openExternal?: (url: string) => Promise<void>;
    /** Default: globalThis.fetch; downloads need a body (web stream) like R2Client. */
    fetchImpl?: (url: string, init: any) => Promise<DriveFetchResponse>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Default: Logger. */
    log?: (level: 'log' | 'warn', msg: string) => void;
    /** Replaces the shared OAuth client (for tests). Default BUILTIN_GOOGLE_CLIENT. */
    builtinClient?: { clientId: string; clientSecret?: string | null } | null;
    /** Timeout for waiting for sign-in in the browser (default 5 minutes). */
    loginTimeoutMs?: number;
    /** DriveStore options (for tests: small resumable chunks, small multipart threshold). */
    storeOptions?: Partial<Pick<DriveStoreOptions, 'simpleUploadMax' | 'chunkSize' | 'chunkRetries' | 'fileCacheMax' | 'deleteConcurrency'>>;
    /** DriveApi deadline options (for tests). */
    apiOptions?: Partial<Pick<DriveApiOptions, 'timeoutMs' | 'idleTimeoutMs'>>;
}

type ClientChoice = { client: OAuthClient; kind: 'custom' | 'builtin' | 'saved' };

function defaultLog(level: 'log' | 'warn', msg: string): void {
    try {
        if (level === 'warn') Logger.warn(msg);
        else Logger.log(msg);
    } catch { /* a logging error does not break the main work */ }
}

function errMessage(err: unknown): string {
    if (err instanceof CloudError) return err.message;
    return String((err as Error)?.message || err || tr('Lỗi không xác định'));
}

/** 'nguyenvana@gmail.com' → 'ng***@gmail.com' (the log does not reveal the full address). */
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

/** about.storageQuota (int64 as a string) → number; a missing limit = unlimited (null). */
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
    /** Bumped when signing in / disconnecting / the root folder changes → every DriveStore forgets its cache. */
    private generation = 0;
    private access: { token: string; expiresAt: number; refreshToken: string } | null = null;
    private refreshing: Promise<string> | null = null;
    private quota: GoogleDriveQuota | null = null;
    private checkedAt: number | null = null;
    private lastError: string | null = null;
    private connecting = false;
    private cancelRequested = false;
    private abortLogin: (() => void) | null = null;
    /** id of the "Deplao" folder, checked in this session. */
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

    // ── Status (no network calls) ──

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

    // ── Sign in / disconnect ──

    async connect(client?: GoogleClientInput | null): Promise<GoogleDriveStatus> {
        if (this.connecting) throw new CloudError('BUSY', tr('Đang chờ đăng nhập Google trên trình duyệt — hoàn tất hoặc bấm Huỷ trước.'));
        const choice = this.pickClient(client);
        // If the refresh token cannot be saved, stop before opening the browser
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
                throw new CloudError('GOOGLE_BROWSER', tr('Không mở được trình duyệt để đăng nhập Google — kiểm tra trình duyệt mặc định của máy.'));
            }
            const { code } = await login.result;
            this.throwIfCancelled();
            const tokens = await exchangeAuthCode(this.fetchImpl, choice.client, { code, codeVerifier: pkce.verifier, redirectUri: login.redirectUri }, this.now);
            this.throwIfCancelled();
            // Refresh token not saved yet → read the email / quota with the access token just received
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
            login?.cancel(); // close the loopback server if it is still open (if already done, do nothing)
            this.safeNotify();
        }
        return this.status();
    }

    cancelConnect(): void {
        if (!this.connecting) return;
        this.cancelRequested = true;
        try { this.abortLogin?.(); } catch { /* ignore */ }
    }

    async disconnect(): Promise<void> {
        this.cancelConnect();
        let token: string | null = null;
        try { token = this.settings.getGoogleRefreshToken(); } catch { token = null; }
        if (token) {
            // Also revoke Deplao's permission on the Google account (best effort: an error still deletes the session on this machine)
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
            // keep customClientId + client secret so that signing in again is faster
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
        if (!name || name.includes('/')) throw new CloudError('BAD_BUCKET', tr('Tên thư mục lưu không hợp lệ'));
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
     * An access token still valid (≥ 60 s), or refresh it (one refresh for the whole app). force + rejected: that token was just refused by Google
     * (401). If a newer token already exists, use it directly without refreshing again.
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
            // Session replaced midway (disconnected / signed in again) → discard the result
            if (this.settings.getGoogleRefreshToken() !== refreshToken) throw new CloudError('NOT_CONNECTED', MSG_NOT_CONNECTED);
            let rt = refreshToken;
            if (t.refreshToken && t.refreshToken !== refreshToken) {
                // Google rarely rotates the refresh token; if it does, save the new one
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

    /** Refresh token refused by Google (expired / revoked / password changed…) → delete it on this machine and ask the user to sign in again. */
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

    // ── Root folder "Deplao" ──

    /** id of the "Deplao" folder (checked once per session; create=false: do not create, null if it does not exist yet). */
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
                // 404: permanently deleted, or created by another OAuth client (drive.file cannot see it) → search again
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
        // Signed in again / disconnected midway → do not overwrite the configuration of the new session
        if (gen !== this.generation) return id;
        const saved = this.googleSettings().rootFolderId;
        if (saved !== id) {
            try {
                this.settings.update(d => { draftGoogle(d).rootFolderId = id; });
            } catch (err) {
                this.log('warn', `[GoogleDrive] Không lưu được id thư mục "${ROOT_FOLDER_NAME}": ${errMessage(err)}`);
            }
            // Root changed → the subfolder ids remembered in the stores are no longer valid
            if (saved) this.generation++;
        }
        this.rootVerified = id;
        return id;
    }

    // ── Internal ──

    private pickClient(input: GoogleClientInput | null | undefined): ClientChoice {
        if (input) {
            const clientId = String(input.clientId ?? '').trim();
            if (!clientId || clientId.length > 256 || !CLIENT_ID_RE.test(clientId)) throw new CloudError('BAD_INPUT', MSG_BAD_CLIENT_ID);
            let secret = String(input.clientSecret ?? '').trim();
            if (secret && (secret.length > 256 || !/^[\x21-\x7e]+$/.test(secret))) throw new CloudError('BAD_INPUT', tr('Client secret Google không hợp lệ'));
            // Signing in again with the saved private client (the UI only sends the Client ID) → reuse the saved secret, do not lose it
            if (!secret && clientId === this.googleSettings().customClientId) secret = String(this.settings.getGoogleClientSecret() || '');
            return { client: { clientId, clientSecret: secret || null }, kind: 'custom' };
        }
        if (this.builtin.clientId) return { client: { clientId: this.builtin.clientId, clientSecret: this.builtin.clientSecret }, kind: 'builtin' };
        const saved = this.googleSettings().customClientId;
        if (saved) return { client: { clientId: saved, clientSecret: this.settings.getGoogleClientSecret() }, kind: 'saved' };
        throw new CloudError('GOOGLE_CLIENT_REQUIRED', MSG_CLIENT_REQUIRED);
    }

    /** The client that issued the saved refresh token: the private client if there is one, otherwise the shared client. */
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
            // Different account → the old account's "Deplao" folder cannot be used
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
        } catch { /* a failing counter does not break the request */ }
    }

    private safeNotify(): void {
        try {
            this.deps.notify();
        } catch (err) {
            this.log('warn', `[GoogleDrive] notify lỗi: ${errMessage(err)}`);
        }
    }

    private log(level: 'log' | 'warn', msg: string): void {
        try { this.logFn(level, msg); } catch { /* ignore */ }
    }
}
