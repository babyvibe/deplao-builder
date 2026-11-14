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
import { tr } from '../../shared/i18n';

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

/** Workspace connection that failed and is waiting to retry (backoff WORKSPACE_RETRY_BACKOFF_MS). */
interface RetryEntry {
    attempt: number;
    /** Start of the connection loss (used to measure the gap when resyncing). */
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

/** resume usually comes with unlock-screen / online right after, so the "đánh thức" (wake) events inside this window are merged. */
const WAKE_DEBOUNCE_MS = 3_000;

/**
 * HttpConnectionManager - manages one HttpClientService instance per workspace.
 * Replaces SocketConnectionManager - uses HTTP instead of Socket.IO.
 *
 * Lifecycle (the main process is the single source of truth for the Boss URL + token = workspace config):
 * - connect() fails (Boss off / network broken) → KEEP the workspace in the retry list (15 s → 60 s), do not remove it.
 * - Boss rejects the token → authExpired: stop retrying until a new token arrives (log in again).
 * - The user clicks Disconnect / is kicked → no automatic reconnect.
 * - The machine wakes from sleep / is unlocked / the network comes back → check the connection right away (handleSystemEvent).
 * - Emits 'employee:credentials' every time a connection succeeds / the URL-token changes → the renderer inits RestQueryService; also writes
 *   bossSessionAuth (the token attached to requests for /api/media, /api/library files), cleared on disconnect / kick.
 * - Emits 'employee:resync' when the connection recovers after a gap of more than 10 s or after the machine wakes from sleep.
 */
class HttpConnectionManager {
    private static instance: HttpConnectionManager;
    private clients: Map<string, WorkspaceClient> = new Map();
    private snapshots: Map<string, WorkspaceSnapshot> = new Map();
    private mainWindow: BrowserWindow | null = null;
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

    /** Running connect attempt: the same URL+token shares its promise; a different one queues up after the running attempt. */
    private inFlight: Map<string, { key: string; promise: Promise<ConnectResult> }> = new Map();
    private retries: Map<string, RetryEntry> = new Map();
    private authExpired: Set<string> = new Set();
    /** The user disconnected / was kicked → no automatic reconnect until an explicit connect() call. */
    private userDisconnected: Set<string> = new Set();
    /** Has connected successfully in this session → the next connection is a "reconnect" (needs a resync). */
    private everConnected: Set<string> = new Set();
    /** Incremented on every disconnect() → cancels the queued connect attempts. */
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
        // Called after the app 'ready' event (createWindow) → attach powerMonitor right away, independent of startupAllWorkspaces
        this.installSystemHooks();
    }

    /**
     * Explicit connect (the user clicks connect, switches workspace, or auto-connect when the app opens).
     * Clears the "user disconnected" state and any pending retry schedule.
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
            return { success: false, error: tr('Đã ngắt kết nối'), cancelled: true };
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
                // Emit credentials BEFORE status/initialState so the REST client uses the right URL/token when it loads data
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
                removeBossSession(workspaceId); // token revoked → no longer attached to file requests
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

        // relay:permissionUpdate (Boss changed permissions / ERP): the renderer already has a handler, but nobody forwarded it before
        service.setOnPermissionUpdate((data: any) => {
            if (!isCurrent()) return;
            this.sendToRenderer('workspace:permissionUpdate', { workspaceId, ...data });
        });

        service.setOnResync((reason: EmployeeResyncReason, gapMs: number) => {
            if (isCurrent()) this.emitResync(workspaceId, reason, gapMs);
        });

        // Socket.IO reconnects and catches up by itself (EventBuffer); a long gap → employee:resync. Catch-up does not replay
        // events that were missed (Boss restarted / buffer too small / old Boss version); these also go through onResync: 'boss-restart' /
        // 'catchup-gap' / 'catchup-unverified', all merged within the RESYNC_COALESCE_MS window.

        const result = await service.connect(bossUrl, token);

        if (!isCurrent()) {
            // disconnect() / another connect() has already replaced this service while it was connecting
            if (result.success) service.disconnect();
            return result.success ? { success: false, error: tr('Đã huỷ kết nối'), cancelled: true } : result;
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

        // Failed: drop the dead service but KEEP the workspace in the retry list (unless the token was rejected)
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

    /** Retry a waiting workspace right away: always reads the LATEST URL/token from the workspace config. */
    private async retryNow(workspaceId: string, reason: string): Promise<void> {
        const entry = this.retries.get(workspaceId);
        if (!entry) return;
        if (this.inFlight.has(workspaceId)) return; // already connecting
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
     * 'employee:credentials': the URL/token that main is using for the workspace (default: the workspace config).
     * The renderer (App) inits RestQueryService from this → REST always matches main.
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
        // Boss files (/api/media, /api/library) need a token: <img>/<video> get the header through session.webRequest
        setBossSession(workspaceId, bossUrl, token);
        let active = false;
        try { active = wm.getActiveWorkspaceId() === workspaceId; } catch { /* ignore */ }
        const payload: EmployeeCredentialsEvent = { workspaceId, bossUrl, token, active, reason };
        Logger.log(`[HttpConnectionManager] employee:credentials "${workspaceId}" (${reason}${active ? ', active' : ''}) → ${bossUrl}`);
        this.sendToRenderer('employee:credentials', payload);
    }

    /**
     * Preload the Boss URL + token of the remote workspaces (when the app opens, before the connection finishes): the renderer already shows
     * the Boss /api/media images from the employee DB; without a token <img> gets a 401 and does not reload by itself. Does not overwrite an existing session.
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
     * The URL/token config of a workspace that just changed (workspace:update). Notifies the renderer and, if the workspace
     * is kept connected / waiting to retry / session expired, reconnects with the new config.
     * A workspace the user disconnected keeps its state (the new config is used at the next connect).
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

    /** 'employee:resync': merges the recoveries of the SAME network loss (socket + heartbeat) within RESYNC_COALESCE_MS. */
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

    /** The user disconnected: stop the heartbeat + Socket.IO, remove from the retry list. */
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

    /** Actually connected (heartbeat OK). While connecting → false; calling connect() will share the running attempt. */
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
     * Re-fetch the employee snapshot (permissions + assigned accounts) via /api/sync/snapshot and push
     * 'workspace:initialState' { forced: true }: the renderer applies it right away (403 ACCOUNT_FORBIDDEN, resync).
     */
    public refreshSnapshot(workspaceId: string, reason = 'manual'): Promise<{ success: boolean; error?: string }> {
        const running = this.snapshotRefreshes.get(workspaceId);
        if (running) return running;
        const client = this.clients.get(workspaceId);
        if (!client || !client.service.isConnected()) {
            return Promise.resolve({ success: false, error: tr('Workspace chưa kết nối tới BOSS') });
        }
        Logger.log(`[HttpConnectionManager] Làm mới snapshot "${workspaceId}" (${reason})`);
        const promise = client.service.requestSnapshot({ forced: true, reason })
            .then(res => ({ success: res.success, error: res.error }))
            .catch((err: any) => ({ success: false, error: err?.message || String(err) }))
            .finally(() => { this.snapshotRefreshes.delete(workspaceId); });
        this.snapshotRefreshes.set(workspaceId, promise);
        return promise;
    }

    /** `timeoutMs`: wait for Boss to reply (default 30 s; sending files / Facebook / Telegram sync take longer: employeeChannelRoutes). */
    public async proxyAction(workspaceId: string, channel: string, params: any, timeoutMs?: number): Promise<any> {
        const client = this.clients.get(workspaceId);
        if (!client) throw new Error(tr('Workspace "{{workspaceId}}" chưa kết nối tới BOSS', { workspaceId }));
        return client.service.proxyAction(channel, params, timeoutMs);
    }

    public async proxyActiveWorkspace(channel: string, params: any): Promise<any> {
        const ws = WorkspaceManager.getInstance().getActiveWorkspace();
        if (!ws || ws.type !== 'remote') throw new Error(tr('Workspace đang active không phải remote workspace'));
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
     * The machine wakes from sleep / is unlocked / the network comes back → check the connection right away instead of waiting for the backoff:
     * - workspace waiting to retry: retry now, the backoff is recalculated from 15 s
     * - connection running: heartbeat now (+ reopen Socket.IO; on resume, resync when Boss replies)
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
     * Start the periodic health check (safety net), called once when the app opens after connectAutoWorkspaces.
     * A running connection recovers by itself through the 15 s heartbeat; a failed workspace sits in the retry list with
     * its own timer. The health check only makes up for retries that were late (machine asleep) and reopens Socket.IO that gave up.
     * It also attaches powerMonitor (resume / unlock-screen).
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

