import HttpClientService from './HttpClientService';
import WorkspaceManager from '../utils/WorkspaceManager';
import Logger from '../utils/Logger';
import { BrowserWindow } from 'electron';

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

/**
 * HttpConnectionManager — manages one HttpClientService instance per workspace.
 * Replaces SocketConnectionManager — uses HTTP instead of Socket.IO.
 */
class HttpConnectionManager {
    private static instance: HttpConnectionManager;
    private clients: Map<string, WorkspaceClient> = new Map();
    private snapshots: Map<string, WorkspaceSnapshot> = new Map();
    private mainWindow: BrowserWindow | null = null;
    private connecting: Set<string> = new Set();

    public static getInstance(): HttpConnectionManager {
        if (!HttpConnectionManager.instance) {
            HttpConnectionManager.instance = new HttpConnectionManager();
        }
        return HttpConnectionManager.instance;
    }

    public setMainWindow(win: BrowserWindow): void {
        this.mainWindow = win;
    }

    public async connect(
        workspaceId: string,
        bossUrl: string,
        token: string,
        options?: {
            onInitialState?: (data: any) => void;
            onAccountAccessUpdate?: (data: any) => void;
            onSyncProgress?: (phase: string, percent: number) => void;
        }
    ): Promise<{ success: boolean; error?: string }> {
        if (this.connecting.has(workspaceId)) {
            Logger.log(`[HttpConnectionManager] Skip connect for "${workspaceId}": already in progress`);
            return { success: true };
        }

        if (this.clients.has(workspaceId)) {
            this.clients.get(workspaceId)!.service.disconnect();
            this.clients.delete(workspaceId);
        }

        this.connecting.add(workspaceId);

        const service = new HttpClientService();
        service.setWorkspaceId(workspaceId);
        this.clients.set(workspaceId, { workspaceId, service });

        service.setOnStatusChange((connected: boolean, latency: number) => {
            this.sendToRenderer('workspace:connectionStatus', { workspaceId, connected, latency });
        });

        service.setOnInitialState((data: any) => {
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
            Logger.log(`[HttpConnectionManager] initialState → workspace=${workspaceId} assigned=${snapshot.assignedAccounts?.length || 0}`);
            this.sendToRenderer('workspace:initialState', { workspaceId, ...data });
            options?.onInitialState?.(data);
        });

        service.setOnAccountAccessUpdate((data: any) => {
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

        if (options?.onSyncProgress) service.setOnSyncProgress(options.onSyncProgress);

        const result = await service.connect(bossUrl, token);
        this.connecting.delete(workspaceId);

        if (result.success) {
            Logger.log(`[HttpConnectionManager] ✅ Connected workspace "${workspaceId}"`);
        } else {
            const current = this.clients.get(workspaceId);
            if (current?.service === service) {
                this.clients.delete(workspaceId);
            }
            Logger.warn(`[HttpConnectionManager] ❌ Failed: ${result.error}`);
        }

        return result;
    }

    public disconnect(workspaceId: string): void {
        const client = this.clients.get(workspaceId);
        if (client) {
            client.service.disconnect();
            this.clients.delete(workspaceId);
            this.sendToRenderer('workspace:connectionStatus', { workspaceId, connected: false, latency: 0 });
        }
    }

    public disconnectAll(): void {
        for (const [wsId] of this.clients) this.disconnect(wsId);
    }

    public isConnected(workspaceId: string): boolean {
        if (this.connecting.has(workspaceId)) return true;
        return this.clients.get(workspaceId)?.service.isConnected() ?? false;
    }

    public getStatus(workspaceId: string): { connected: boolean; bossUrl: string; latency: number } {
        const client = this.clients.get(workspaceId);
        if (!client) {
            if (this.connecting.has(workspaceId)) return { connected: true, bossUrl: '', latency: 0 };
            return { connected: false, bossUrl: '', latency: 0 };
        }
        return client.service.getStatus();
    }

    public getAllStatuses(): Record<string, { connected: boolean; bossUrl: string; latency: number }> {
        const result: Record<string, { connected: boolean; bossUrl: string; latency: number }> = {};
        for (const [wsId, client] of this.clients) result[wsId] = client.service.getStatus();
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

    public async proxyAction(workspaceId: string, channel: string, params: any): Promise<any> {
        const client = this.clients.get(workspaceId);
        if (!client) throw new Error(`Workspace "${workspaceId}" chưa kết nối tới BOSS`);
        return client.service.proxyAction(channel, params);
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

    private sendToRenderer(channel: string, data: any): void {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }
}

export default HttpConnectionManager;

