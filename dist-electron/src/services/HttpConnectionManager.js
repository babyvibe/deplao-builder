"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const HttpClientService_1 = __importDefault(require("./HttpClientService"));
const WorkspaceManager_1 = __importDefault(require("../utils/WorkspaceManager"));
const Logger_1 = __importDefault(require("../utils/Logger"));
/**
 * HttpConnectionManager — manages one HttpClientService instance per workspace.
 * Replaces SocketConnectionManager — uses HTTP instead of Socket.IO.
 */
class HttpConnectionManager {
    constructor() {
        this.clients = new Map();
        this.snapshots = new Map();
        this.mainWindow = null;
        this.connecting = new Set();
    }
    static getInstance() {
        if (!HttpConnectionManager.instance) {
            HttpConnectionManager.instance = new HttpConnectionManager();
        }
        return HttpConnectionManager.instance;
    }
    setMainWindow(win) {
        this.mainWindow = win;
    }
    async connect(workspaceId, bossUrl, token, options) {
        if (this.connecting.has(workspaceId)) {
            Logger_1.default.log(`[HttpConnectionManager] Skip connect for "${workspaceId}": already in progress`);
            return { success: true };
        }
        if (this.clients.has(workspaceId)) {
            this.clients.get(workspaceId).service.disconnect();
            this.clients.delete(workspaceId);
        }
        this.connecting.add(workspaceId);
        const service = new HttpClientService_1.default();
        service.setWorkspaceId(workspaceId);
        this.clients.set(workspaceId, { workspaceId, service });
        service.setOnStatusChange((connected, latency) => {
            this.sendToRenderer('workspace:connectionStatus', { workspaceId, connected, latency });
        });
        service.setOnInitialState((data) => {
            const snapshot = {
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
            Logger_1.default.log(`[HttpConnectionManager] initialState → workspace=${workspaceId} assigned=${snapshot.assignedAccounts?.length || 0}`);
            this.sendToRenderer('workspace:initialState', { workspaceId, ...data });
            options?.onInitialState?.(data);
        });
        service.setOnAccountAccessUpdate((data) => {
            const previous = this.snapshots.get(workspaceId);
            const snapshot = {
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
        if (options?.onSyncProgress)
            service.setOnSyncProgress(options.onSyncProgress);
        const result = await service.connect(bossUrl, token);
        this.connecting.delete(workspaceId);
        if (result.success) {
            Logger_1.default.log(`[HttpConnectionManager] ✅ Connected workspace "${workspaceId}"`);
        }
        else {
            const current = this.clients.get(workspaceId);
            if (current?.service === service) {
                this.clients.delete(workspaceId);
            }
            Logger_1.default.warn(`[HttpConnectionManager] ❌ Failed: ${result.error}`);
        }
        return result;
    }
    disconnect(workspaceId) {
        const client = this.clients.get(workspaceId);
        if (client) {
            client.service.disconnect();
            this.clients.delete(workspaceId);
            this.sendToRenderer('workspace:connectionStatus', { workspaceId, connected: false, latency: 0 });
        }
    }
    disconnectAll() {
        for (const [wsId] of this.clients)
            this.disconnect(wsId);
    }
    isConnected(workspaceId) {
        if (this.connecting.has(workspaceId))
            return true;
        return this.clients.get(workspaceId)?.service.isConnected() ?? false;
    }
    getStatus(workspaceId) {
        const client = this.clients.get(workspaceId);
        if (!client) {
            if (this.connecting.has(workspaceId))
                return { connected: true, bossUrl: '', latency: 0 };
            return { connected: false, bossUrl: '', latency: 0 };
        }
        return client.service.getStatus();
    }
    getAllStatuses() {
        const result = {};
        for (const [wsId, client] of this.clients)
            result[wsId] = client.service.getStatus();
        return result;
    }
    getServiceForWorkspace(workspaceId) {
        return this.clients.get(workspaceId)?.service ?? null;
    }
    getSnapshot(workspaceId) {
        return this.snapshots.get(workspaceId) ?? null;
    }
    replaySnapshotToRenderer(workspaceId) {
        const snapshot = this.snapshots.get(workspaceId);
        if (!snapshot)
            return false;
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
    async proxyAction(workspaceId, channel, params) {
        const client = this.clients.get(workspaceId);
        if (!client)
            throw new Error(`Workspace "${workspaceId}" chưa kết nối tới BOSS`);
        return client.service.proxyAction(channel, params);
    }
    async proxyActiveWorkspace(channel, params) {
        const ws = WorkspaceManager_1.default.getInstance().getActiveWorkspace();
        if (!ws || ws.type !== 'remote')
            throw new Error('Workspace đang active không phải remote workspace');
        return this.proxyAction(ws.id, channel, params);
    }
    async connectAutoWorkspaces() {
        const autoConnects = WorkspaceManager_1.default.getInstance().getAutoConnectRemotes();
        if (autoConnects.length === 0)
            return;
        Logger_1.default.log(`[HttpConnectionManager] Auto-connecting ${autoConnects.length} remote workspace(s)...`);
        for (const ws of autoConnects) {
            if (!ws.bossUrl || !ws.token)
                continue;
            if (this.isConnected(ws.id))
                continue;
            try {
                await this.connect(ws.id, ws.bossUrl, ws.token);
            }
            catch (err) {
                Logger_1.default.warn(`[HttpConnectionManager] Auto-connect failed for "${ws.name}": ${err.message}`);
            }
        }
    }
    sendToRenderer(channel, data) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }
}
exports.default = HttpConnectionManager;
//# sourceMappingURL=HttpConnectionManager.js.map