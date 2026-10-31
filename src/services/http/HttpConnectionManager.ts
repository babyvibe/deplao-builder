import HttpClientService, { type ConnectResult, type ServiceStatusInfo, type SnapshotMeta, type WakeKind } from './HttpClientService';
import WorkspaceManager from '../../utils/app/WorkspaceManager';
import Logger from '../../utils/Logger';
import { removeBossSession, seedBossSession, setBossSession } from './bossSessionAuth';
import { BrowserWindow, powerMonitor } from 'electron';
import {
    backoffDelay,
    normalizeBossUrl,
    RESYNC_COALESCE_MS,
    WORKSPACE_RETRY_BACKOFF_MS,
    type EmployeeCredentialsEvent,
    type EmployeeCredentialsReason,
    type EmployeeResyncEvent,
    type EmployeeResyncReason,
    type WorkspaceConnectionStatusEvent,
} from '../../shared/employee/employeeConnection';

interface WorkspaceClient {
    workspaceId: string;
    service: HttpClientService;
}

interface WorkspaceSnapshot {
    permissions?: Array<{ module: string; can_access: boolean }>;
    assignedAccounts?: string[];
    erpRole?: string;
    erpExtraJson?: string;
    employeesData?: any[];
    accountsData?: any[];
    onlineAccounts?: string[];
    updatedAt: number;
    source: 'initialState' | 'accountAccessUpdate';
}

interface ConnectOptions {
    onInitialState?: (data: any) => void;
    onAccountAccessUpdate?: (data: any) => void;
    onSyncProgress?: (phase: string, percent: number) => void;
}

/** Workspace kết nối thất bại đang chờ thử lại (backoff WORKSPACE_RETRY_BACKOFF_MS). */
interface RetryEntry {
    attempt: number;
    /** Bắt đầu mất kết nối (để đo khoảng mất khi resync). */
    since: number;
    nextAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    lastError: string;
}

export interface WorkspaceConnectionInfo {
    connected: boolean;
    bossUrl: string;
    latency: number;
    authExpired: boolean;
    retrying: boolean;
    connecting: boolean;
}

/** resume thường kèm unlock-screen / online ngay sau → gộp các sự kiện "đánh thức" trong cửa sổ này. */
const WAKE_DEBOUNCE_MS = 3_000;

/**
 * HttpConnectionManager - manages one HttpClientService instance per workspace.
 * Replaces SocketConnectionManager - uses HTTP instead of Socket.IO.
 *
 * Vòng đời (main process là nguồn sự thật duy nhất cho Boss URL + token = cấu hình workspace):
 * - connect() lỗi (Boss tắt / mạng hỏng) → GIỮ workspace trong danh sách thử lại (15 s → 60 s), không xoá.
 * - Boss từ chối token → authExpired: dừng thử lại tới khi có token mới (đăng nhập lại).
 * - Người dùng bấm Ngắt kết nối / bị kick → không tự kết nối lại.
 * - Máy ngủ dậy / mở khoá / mạng có lại → kiểm tra kết nối ngay (handleSystemEvent).
 * - Phát 'employee:credentials' mỗi khi kết nối được / đổi URL-token → renderer init RestQueryService; đồng thời ghi
 *   bossSessionAuth (token gắn vào request file /api/media, /api/library) — xoá khi ngắt / bị kick.
 * - Phát 'employee:resync' khi kết nối hồi phục sau khoảng mất > 10 s hoặc sau khi máy ngủ dậy.
 */
class HttpConnectionManager {
    private static instance: HttpConnectionManager;
    private clients: Map<string, WorkspaceClient> = new Map();
    private snapshots: Map<string, WorkspaceSnapshot> = new Map();
    private mainWindow: BrowserWindow | null = null;
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

    /** Lần kết nối đang chạy: cùng URL+token → dùng chung promise; khác → xếp hàng sau lần đang chạy. */
    private inFlight: Map<string, { key: string; promise: Promise<ConnectResult> }> = new Map();
    private retries: Map<string, RetryEntry> = new Map();
    private authExpired: Set<string> = new Set();
    /** Người dùng ngắt / bị kick → không tự kết nối lại cho tới khi connect() tường minh. */
    private userDisconnected: Set<string> = new Set();
    /** Đã từng kết nối được trong phiên này → lần kết nối sau là "kết nối lại" (cần resync). */
    private everConnected: Set<string> = new Set();
    /** Tăng mỗi lần disconnect() → huỷ các lần connect đang xếp hàng. */
    private disconnectEpoch: Map<string, number> = new Map();
    private lastResyncAt: Map<string, number> = new Map();
    private snapshotRefreshes: Map<string, Promise<{ success: boolean; error?: string }>> = new Map();
    private systemHooksInstalled = false;
    private lastWakeAt = 0;

    public static getInstance(): HttpConnectionManager {
        if (!HttpConnectionManager.instance) {
            HttpConnectionManager.instance = new HttpConnectionManager();
        }
        return HttpConnectionManager.instance;
    }

    public setMainWindow(win: BrowserWindow): void {
        this.mainWindow = win;
        // Gọi sau app 'ready' (createWindow) → gắn powerMonitor ngay, không phụ thuộc startupAllWorkspaces
        this.installSystemHooks();
    }

    /**
     * Kết nối tường minh (người dùng bấm kết nối, chuyển workspace, auto-connect lúc mở app).
     * Huỷ trạng thái "người dùng đã ngắt" và lịch thử lại đang chờ.
     */
    public connect(
        workspaceId: string,
        bossUrl: string,
        token: string,
        options?: ConnectOptions
    ): Promise<ConnectResult> {
        this.userDisconnected.delete(workspaceId);
        this.clearRetry(workspaceId);
        return this.runConnect(workspaceId, bossUrl, token, 'explicit', options);
    }

    private runConnect(
        workspaceId: string,
        bossUrl: string,
        token: string,
        source: 'explicit' | 'retry',
        options?: ConnectOptions
    ): Promise<ConnectResult> {
        const key = `${normalizeBossUrl(bossUrl)}\n${token}`;
        const current = this.inFlight.get(workspaceId);
        if (current && current.key === key) {
            Logger.log(`[HttpConnectionManager] connect "${workspaceId}": dùng chung lần kết nối đang chạy`);
            return current.promise;
        }

        const epoch = this.disconnectEpoch.get(workspaceId) || 0;
        const previous: Promise<ConnectResult | null> = current ? current.promise : Promise.resolve(null);
        const promise = previous
            .catch(() => null)
            .then(() => this.doConnect(workspaceId, bossUrl, token, source, epoch, options));
        const entry = { key, promise };
        this.inFlight.set(workspaceId, entry);
        const cleanup = () => {
            if (this.inFlight.get(workspaceId) === entry) this.inFlight.delete(workspaceId);
        };
        promise.then(cleanup, cleanup);
        return promise;
    }

    private async doConnect(
        workspaceId: string,
        bossUrl: string,
        token: string,
        source: 'explicit' | 'retry',
        epoch: number,
        options?: ConnectOptions
    ): Promise<ConnectResult> {
        if ((this.disconnectEpoch.get(workspaceId) || 0) !== epoch) {
            return { success: false, error: 'Đã ngắt kết nối', cancelled: true };
        }

        const existing = this.clients.get(workspaceId);
        if (existing) {
            Logger.warn(`[HttpConnectionManager] ⚠️ connect() replacing EXISTING client for "${workspaceId}" - old connection will be destroyed`);
            existing.service.disconnect();
            this.clients.delete(workspaceId);
        }

        const service = new HttpClientService();
        service.setWorkspaceId(workspaceId);
        this.clients.set(workspaceId, { workspaceId, service });
        const isCurrent = () => this.clients.get(workspaceId)?.service === service;
        let credentialsSent = false;

        service.setOnStatusChange((connected: boolean, latency: number, info?: ServiceStatusInfo) => {
            if (!isCurrent()) return;
            if (connected && !credentialsSent) {
                // Phát credentials TRƯỚC status/initialState để REST client dùng đúng URL/token khi tải dữ liệu
                credentialsSent = true;
                this.authExpired.delete(workspaceId);
                this.emitCredentials(workspaceId, 'connected', { bossUrl, token });
            }
            if (info?.authExpired) {
                this.authExpired.add(workspaceId);
                this.clearRetry(workspaceId);
                Logger.warn(`[HttpConnectionManager] "${workspaceId}": phiên đăng nhập hết hạn — ngừng tự kết nối lại`);
            }
            if (info?.kicked) {
                this.clients.delete(workspaceId);
                this.clearRetry(workspaceId);
                this.userDisconnected.add(workspaceId);
                removeBossSession(workspaceId); // token bị thu hồi → không gắn vào request file nữa
                Logger.warn(`[HttpConnectionManager] "${workspaceId}": bị Boss ngắt kết nối (${info.reason || 'kicked'})`);
            }
            this.sendStatus(workspaceId, connected, latency, info);
        });

        service.setOnInitialState((data: any, meta?: SnapshotMeta) => {
            if (!isCurrent()) return;
            const snapshot: WorkspaceSnapshot = {
                permissions: data?.permissions || [],
                assignedAccounts: data?.assignedAccounts || [],
                erpRole: data?.erpRole || '',
                erpExtraJson: data?.erpExtraJson || '',
                employeesData: data?.employeesData || [],
                accountsData: data?.accountsData || [],
                onlineAccounts: data?.onlineAccounts || [],
                updatedAt: Date.now(),
                source: 'initialState',
            };
            this.snapshots.set(workspaceId, snapshot);
            Logger.log(`[HttpConnectionManager] initialState → workspace=${workspaceId} assigned=${snapshot.assignedAccounts?.length || 0}${meta?.forced ? ` (forced: ${meta.reason || ''})` : ''}`);
            this.sendToRenderer('workspace:initialState', {
                workspaceId,
                ...data,
                ...(meta?.forced ? { forced: true, forcedReason: meta.reason || '' } : {}),
            });
            options?.onInitialState?.(data);
        });

        service.setOnAccountAccessUpdate((data: any) => {
            if (!isCurrent()) return;
            const previous = this.snapshots.get(workspaceId);
            const snapshot: WorkspaceSnapshot = {
                permissions: previous?.permissions || [],
                assignedAccounts: data?.assignedAccounts || [],
                erpRole: previous?.erpRole || '',
                erpExtraJson: previous?.erpExtraJson || '',
                employeesData: previous?.employeesData || [],
                accountsData: data?.accountsData || [],
                onlineAccounts: previous?.onlineAccounts || [],
                updatedAt: Date.now(),
                source: 'accountAccessUpdate',
            };
            this.snapshots.set(workspaceId, snapshot);
            this.sendToRenderer('workspace:accountAccessUpdate', { workspaceId, ...data });
            options?.onAccountAccessUpdate?.(data);
        });

        // relay:permissionUpdate (Boss đổi quyền / ERP) — renderer đã có handler, trước đây không ai chuyển tiếp
        service.setOnPermissionUpdate((data: any) => {
            if (!isCurrent()) return;
            this.sendToRenderer('workspace:permissionUpdate', { workspaceId, ...data });
        });

        service.setOnResync((reason: EmployeeResyncReason, gapMs: number) => {
            if (isCurrent()) this.emitResync(workspaceId, reason, gapMs);
        });

        // Socket.IO tự reconnect + catch-up (EventBuffer); khoảng mất dài → employee:resync. Catch-up không phát lại
        // được (Boss khởi động lại / buffer không đủ / Boss bản cũ) cũng đi qua onResync: 'boss-restart' /
        // 'catchup-gap' / 'catchup-unverified' — cùng cửa sổ gộp RESYNC_COALESCE_MS.

        const result = await service.connect(bossUrl, token);

        if (!isCurrent()) {
            // disconnect() / connect() khác đã thay service này trong lúc đang kết nối
            if (result.success) service.disconnect();
            return result.success ? { success: false, error: 'Đã huỷ kết nối', cancelled: true } : result;
        }

        if (result.success) {
            const retry = this.retries.get(workspaceId);
            this.clearRetry(workspaceId);
            const reconnected = source === 'retry' || !!retry || this.everConnected.has(workspaceId);
            this.everConnected.add(workspaceId);
            Logger.log(`[HttpConnectionManager] ✅ Connected workspace "${workspaceId}"${reconnected ? ' (kết nối lại)' : ''}`);
            if (reconnected) this.emitResync(workspaceId, 'reconnect', retry ? Date.now() - retry.since : 0);
            return result;
        }

        // Thất bại: bỏ service chết nhưng GIỮ workspace trong danh sách thử lại (trừ khi token bị từ chối)
        this.clients.delete(workspaceId);
        service.disconnect();
        if (result.authExpired) {
            this.authExpired.add(workspaceId);
            this.clearRetry(workspaceId);
            Logger.warn(`[HttpConnectionManager] ❌ "${workspaceId}": Boss từ chối token — chờ đăng nhập lại, không tự thử lại`);
        } else if (!result.cancelled) {
            this.scheduleRetry(workspaceId, result.error || 'unknown error');
            Logger.warn(`[HttpConnectionManager] ❌ Failed: ${result.error}`);
        }
        this.sendStatus(workspaceId, false, 0, result.authExpired ? { authExpired: true, reason: result.error } : undefined);
        return result;
    }

    // ─── Retry list ──────────────────────────────────────────────────

    private scheduleRetry(workspaceId: string, error: string): void {
        const now = Date.now();
        const entry: RetryEntry = this.retries.get(workspaceId)
            ?? { attempt: 0, since: now, nextAt: 0, timer: null, lastError: '' };
        if (entry.timer) clearTimeout(entry.timer);
        const delay = backoffDelay(entry.attempt, WORKSPACE_RETRY_BACKOFF_MS);
        entry.attempt++;
        entry.nextAt = now + delay;
        entry.lastError = error;
        entry.timer = setTimeout(() => {
            entry.timer = null;
            void this.retryNow(workspaceId, 'backoff');
        }, delay);
        this.retries.set(workspaceId, entry);
        Logger.log(`[HttpConnectionManager] "${workspaceId}": thử kết nối lại sau ${Math.round(delay / 1000)}s (lần ${entry.attempt}, lỗi: ${error})`);
    }

    private clearRetry(workspaceId: string): void {
        const entry = this.retries.get(workspaceId);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        this.retries.delete(workspaceId);
    }

    /** Thử lại ngay một workspace trong danh sách chờ — luôn đọc URL/token MỚI NHẤT từ cấu hình workspace. */
    private async retryNow(workspaceId: string, reason: string): Promise<void> {
        const entry = this.retries.get(workspaceId);
        if (!entry) return;
        if (this.inFlight.has(workspaceId)) return; // đang kết nối
        const ws = WorkspaceManager.getInstance().getWorkspaceById(workspaceId);
        if (!ws || ws.type !== 'remote' || !ws.bossUrl || !ws.token) {
            Logger.log(`[HttpConnectionManager] "${workspaceId}": bỏ khỏi danh sách thử lại (workspace không còn / thiếu URL-token)`);
            this.clearRetry(workspaceId);
            return;
        }
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        Logger.log(`[HttpConnectionManager] "${workspaceId}": thử kết nối lại (${reason})`);
        try {
            await this.runConnect(workspaceId, ws.bossUrl, ws.token, 'retry');
        } catch (err: any) {
            Logger.warn(`[HttpConnectionManager] Retry error for "${workspaceId}": ${err?.message || err}`);
        }
    }

    // ─── Credentials / resync / status events → renderer ─────────────

    /**
     * 'employee:credentials' — URL/token mà main đang dùng cho workspace (mặc định: cấu hình workspace).
     * Renderer (App) init RestQueryService từ đây → REST luôn khớp main.
     */
    public emitCredentials(
        workspaceId: string,
        reason: EmployeeCredentialsReason,
        creds?: { bossUrl?: string; token?: string }
    ): void {
        const wm = WorkspaceManager.getInstance();
        const ws = wm.getWorkspaceById(workspaceId);
        const bossUrl = normalizeBossUrl(creds?.bossUrl ?? ws?.bossUrl);
        const token = String(creds?.token ?? ws?.token ?? '');
        if (!bossUrl || !token) return;
        // File Boss (/api/media, /api/library) cần token: <img>/<video> được gắn header qua session.webRequest
        setBossSession(workspaceId, bossUrl, token);
        let active = false;
        try { active = wm.getActiveWorkspaceId() === workspaceId; } catch { /* ignore */ }
        const payload: EmployeeCredentialsEvent = { workspaceId, bossUrl, token, active, reason };
        Logger.log(`[HttpConnectionManager] employee:credentials "${workspaceId}" (${reason}${active ? ', active' : ''}) → ${bossUrl}`);
        this.sendToRenderer('employee:credentials', payload);
    }

    /**
     * Nạp sẵn Boss URL + token của các workspace remote (lúc mở app, trước khi kết nối xong): renderer đã hiện ảnh
     * /api/media của Boss từ DB nhân viên — thiếu token thì <img> nhận 401 và không tự tải lại. Không đè phiên đang có.
     */
    public seedBossSessions(): void {
        try {
            for (const ws of WorkspaceManager.getInstance().listWorkspaces()) {
                if (ws.type === 'remote' && ws.bossUrl && ws.token) seedBossSession(ws.id, ws.bossUrl, ws.token);
            }
        } catch (err: any) {
            Logger.warn(`[HttpConnectionManager] seedBossSessions: ${err?.message || err}`);
        }
    }

    /**
     * Cấu hình URL/token của workspace vừa đổi (workspace:update). Báo renderer và — nếu workspace
     * đang được giữ kết nối / chờ thử lại / hết hạn phiên — kết nối lại bằng cấu hình mới.
     * Workspace người dùng đã ngắt thì giữ nguyên (cấu hình mới dùng ở lần kết nối sau).
     */
    public onCredentialsChanged(workspaceId: string): void {
        const ws = WorkspaceManager.getInstance().getWorkspaceById(workspaceId);
        if (!ws || ws.type !== 'remote') return;
        if (this.userDisconnected.has(workspaceId)) {
            Logger.log(`[HttpConnectionManager] "${workspaceId}": URL/token đổi nhưng đang ngắt kết nối — dùng ở lần kết nối sau`);
            return;
        }
        this.emitCredentials(workspaceId, 'updated');
        const tracked = this.clients.has(workspaceId) || this.retries.has(workspaceId)
            || this.authExpired.has(workspaceId) || this.inFlight.has(workspaceId);
        if (tracked && ws.bossUrl && ws.token) {
            Logger.log(`[HttpConnectionManager] "${workspaceId}": URL/token đổi — kết nối lại với cấu hình mới`);
            this.clearRetry(workspaceId);
            void this.runConnect(workspaceId, ws.bossUrl, ws.token, 'explicit');
        }
    }

    /** 'employee:resync' — gộp các lần hồi phục của CÙNG một lần mất mạng (socket + heartbeat) trong RESYNC_COALESCE_MS. */
    private emitResync(workspaceId: string, reason: EmployeeResyncReason, gapMs: number): void {
        const now = Date.now();
        const last = this.lastResyncAt.get(workspaceId) || 0;
        if (last && now - last < RESYNC_COALESCE_MS) {
            Logger.log(`[HttpConnectionManager] employee:resync "${workspaceId}" (${reason}) gộp với lần ${Math.round((now - last) / 1000)}s trước`);
            return;
        }
        this.lastResyncAt.set(workspaceId, now);
        const payload: EmployeeResyncEvent = { workspaceId, reason, gapMs: Math.max(0, Math.round(gapMs || 0)), at: now };
        Logger.log(`[HttpConnectionManager] 🔄 employee:resync "${workspaceId}" (${reason}, mất kết nối ~${Math.round(payload.gapMs / 1000)}s)`);
        this.sendToRenderer('employee:resync', payload);
    }

    private sendStatus(workspaceId: string, connected: boolean, latency: number, info?: ServiceStatusInfo): void {
        const payload: WorkspaceConnectionStatusEvent = {
            workspaceId,
            connected,
            latency,
            authExpired: this.authExpired.has(workspaceId),
            retrying: this.retries.has(workspaceId),
            ...(info?.kicked ? { kicked: true } : {}),
            ...(info?.reason ? { reason: info.reason } : {}),
        };
        this.sendToRenderer('workspace:connectionStatus', payload);
    }

    // ─── Disconnect ──────────────────────────────────────────────────

    /** Người dùng ngắt kết nối: dừng heartbeat + Socket.IO, bỏ khỏi danh sách thử lại. */
    public disconnect(workspaceId: string): void {
        this.disconnectEpoch.set(workspaceId, (this.disconnectEpoch.get(workspaceId) || 0) + 1);
        this.userDisconnected.add(workspaceId);
        this.clearRetry(workspaceId);
        this.authExpired.delete(workspaceId);
        removeBossSession(workspaceId);
        const client = this.clients.get(workspaceId);
        if (client) {
            client.service.disconnect();
            this.clients.delete(workspaceId);
        }
        this.sendStatus(workspaceId, false, 0, { reason: 'user-disconnect' });
    }

    public disconnectAll(): void {
        const ids = new Set<string>([...this.clients.keys(), ...this.retries.keys()]);
        for (const wsId of ids) this.disconnect(wsId);
    }

    // ─── Status ──────────────────────────────────────────────────────

    /** Đã kết nối thật (heartbeat OK). Đang kết nối → false; gọi connect() sẽ dùng chung lần đang chạy. */
    public isConnected(workspaceId: string): boolean {
        return this.clients.get(workspaceId)?.service.isConnected() ?? false;
    }

    public getStatus(workspaceId: string): WorkspaceConnectionInfo {
        const client = this.clients.get(workspaceId);
        const base = client ? client.service.getStatus() : { connected: false, bossUrl: '', latency: 0 };
        return {
            connected: !!base.connected,
            bossUrl: base.bossUrl || '',
            latency: base.latency || 0,
            authExpired: this.authExpired.has(workspaceId),
            retrying: this.retries.has(workspaceId),
            connecting: this.inFlight.has(workspaceId),
        };
    }

    public getAllStatuses(): Record<string, WorkspaceConnectionInfo> {
        const result: Record<string, WorkspaceConnectionInfo> = {};
        const ids = new Set<string>([...this.clients.keys(), ...this.retries.keys(), ...this.authExpired]);
        for (const wsId of ids) result[wsId] = this.getStatus(wsId);
        return result;
    }

    public getServiceForWorkspace(workspaceId: string): HttpClientService | null {
        return this.clients.get(workspaceId)?.service ?? null;
    }

    public getSnapshot(workspaceId: string): WorkspaceSnapshot | null {
        return this.snapshots.get(workspaceId) ?? null;
    }

    public replaySnapshotToRenderer(workspaceId: string): boolean {
        const snapshot = this.snapshots.get(workspaceId);
        if (!snapshot) return false;

        this.sendToRenderer('workspace:initialState', {
            workspaceId,
            permissions: snapshot.permissions || [],
            assignedAccounts: snapshot.assignedAccounts || [],
            erpRole: snapshot.erpRole || '',
            erpExtraJson: snapshot.erpExtraJson || '',
            employeesData: snapshot.employeesData || [],
            accountsData: snapshot.accountsData || [],
            onlineAccounts: snapshot.onlineAccounts || [],
            replayed: true,
            replaySource: snapshot.source,
            replayedAt: Date.now(),
        });
        return true;
    }

    /**
     * Lấy lại snapshot nhân viên (quyền + tài khoản được giao) qua /api/sync/snapshot và đẩy
     * 'workspace:initialState' { forced: true } — renderer áp dụng ngay (403 ACCOUNT_FORBIDDEN, resync).
     */
    public refreshSnapshot(workspaceId: string, reason = 'manual'): Promise<{ success: boolean; error?: string }> {
        const running = this.snapshotRefreshes.get(workspaceId);
        if (running) return running;
        const client = this.clients.get(workspaceId);
        if (!client || !client.service.isConnected()) {
            return Promise.resolve({ success: false, error: 'Workspace chưa kết nối tới BOSS' });
        }
        Logger.log(`[HttpConnectionManager] Làm mới snapshot "${workspaceId}" (${reason})`);
        const promise = client.service.requestSnapshot({ forced: true, reason })
            .then(res => ({ success: res.success, error: res.error }))
            .catch((err: any) => ({ success: false, error: err?.message || String(err) }))
            .finally(() => { this.snapshotRefreshes.delete(workspaceId); });
        this.snapshotRefreshes.set(workspaceId, promise);
        return promise;
    }

    /** `timeoutMs`: chờ Boss trả lời (mặc định 30 s; gửi file / đồng bộ Facebook / Telegram lâu hơn — employeeChannelRoutes). */
    public async proxyAction(workspaceId: string, channel: string, params: any, timeoutMs?: number): Promise<any> {
        const client = this.clients.get(workspaceId);
        if (!client) throw new Error(`Workspace "${workspaceId}" chưa kết nối tới BOSS`);
        return client.service.proxyAction(channel, params, timeoutMs);
    }

    public async proxyActiveWorkspace(channel: string, params: any): Promise<any> {
        const ws = WorkspaceManager.getInstance().getActiveWorkspace();
        if (!ws || ws.type !== 'remote') throw new Error('Workspace đang active không phải remote workspace');
        return this.proxyAction(ws.id, channel, params);
    }

    public async connectAutoWorkspaces(): Promise<void> {
        const autoConnects = WorkspaceManager.getInstance().getAutoConnectRemotes();
        if (autoConnects.length === 0) return;

        Logger.log(`[HttpConnectionManager] Auto-connecting ${autoConnects.length} remote workspace(s)...`);
        for (const ws of autoConnects) {
            if (!ws.bossUrl || !ws.token) continue;
            if (this.isConnected(ws.id)) continue;
            try {
                await this.connect(ws.id, ws.bossUrl, ws.token);
            } catch (err: any) {
                Logger.warn(`[HttpConnectionManager] Auto-connect failed for "${ws.name}": ${err.message}`);
            }
        }
    }

    // ─── System events (resume / unlock / network online) ─────────────

    private installSystemHooks(): void {
        if (this.systemHooksInstalled) return;
        try {
            powerMonitor.on('suspend', () => Logger.log('[HttpConnectionManager] System suspend'));
            powerMonitor.on('resume', () => this.handleSystemEvent('resume'));
            powerMonitor.on('unlock-screen', () => this.handleSystemEvent('unlock-screen'));
            this.systemHooksInstalled = true;
        } catch (err: any) {
            Logger.warn(`[HttpConnectionManager] powerMonitor không dùng được: ${err?.message || err}`);
        }
    }

    /**
     * Máy ngủ dậy / mở khoá / mạng có lại → kiểm tra kết nối ngay thay vì chờ backoff:
     * - workspace đang chờ thử lại: thử ngay, backoff tính lại từ 15 s
     * - kết nối đang chạy: heartbeat ngay (+ mở lại Socket.IO; resume thì resync khi Boss trả lời)
     */
    public handleSystemEvent(kind: WakeKind): void {
        const now = Date.now();
        if (kind !== 'resume' && now - this.lastWakeAt < WAKE_DEBOUNCE_MS) return;
        this.lastWakeAt = now;
        if (this.retries.size === 0 && this.clients.size === 0) return;
        Logger.log(`[HttpConnectionManager] ${kind} → kiểm tra kết nối ngay (${this.clients.size} đang chạy, ${this.retries.size} chờ thử lại)`);
        for (const [wsId, entry] of this.retries) {
            entry.attempt = 0;
            void this.retryNow(wsId, kind);
        }
        for (const client of this.clients.values()) {
            client.service.handleWake(kind);
        }
    }

    /**
     * Start periodic health check (lưới an toàn) — gọi 1 lần lúc mở app sau connectAutoWorkspaces.
     * Kết nối đang chạy tự hồi phục qua heartbeat 15 s; workspace lỗi nằm trong danh sách thử lại với
     * timer riêng — health check chỉ chạy bù lần thử bị trễ (máy ngủ) và mở lại Socket.IO đã bỏ cuộc.
     * Đồng thời gắn powerMonitor (resume / unlock-screen).
     */
    public startHealthCheck(intervalMs = 60_000): void {
        this.installSystemHooks();
        this.stopHealthCheck();
        this.healthCheckTimer = setInterval(() => this.runHealthCheck(), intervalMs);
        Logger.log(`[HttpConnectionManager] Health check started (interval=${intervalMs}ms)`);
    }

    private runHealthCheck(): void {
        const now = Date.now();
        for (const [wsId, entry] of this.retries) {
            if (now >= entry.nextAt + 1_000) {
                Logger.log(`[HttpConnectionManager] Health check: "${wsId}" quá hạn thử lại — thử ngay`);
                void this.retryNow(wsId, 'health-check');
            }
        }
        for (const client of this.clients.values()) {
            client.service.ensureRealtime();
        }
    }

    public stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    private sendToRenderer(channel: string, data: any): void {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }
}

export default HttpConnectionManager;

