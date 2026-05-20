"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ZaloLoginHelper_1 = __importDefault(require("./ZaloLoginHelper"));
const Logger_1 = __importDefault(require("./Logger"));
class ConnectionManager {
    /**
     * Lấy hoặc tạo connection - Single Source of Truth
     * @param auth
     * @param startListener
     * @param api Optional existing API instance (từ loginQR/loginCookies)
     * @param isReconnection
     */
    static async getOrCreateConnection(auth, startListener = false, api, isReconnection = false) {
        const parsedAuth = typeof auth === 'string' ? JSON.parse(auth) : auth;
        const authKey = Buffer.from(parsedAuth.cookies).toString('base64');
        if (isReconnection) {
            for (const [existingZaloId, connection] of this.connections.entries()) {
                if (connection.authKey === authKey) {
                    await this.forceDisconnectAndCleanup(existingZaloId);
                    break;
                }
            }
            this.pendingConnections.delete(authKey);
        }
        if (!isReconnection) {
            for (const [, connection] of this.connections.entries()) {
                if (connection.authKey === authKey) {
                    Logger_1.default.log(`[ConnectionManager] ♻️  Reusing existing connection`);
                    return connection;
                }
            }
            if (this.pendingConnections.has(authKey)) {
                Logger_1.default.log(`[ConnectionManager] ⏳ Waiting for pending connection...`);
                return await this.pendingConnections.get(authKey);
            }
        }
        const connectionPromise = this.createNewConnection(parsedAuth, authKey, startListener, api);
        this.pendingConnections.set(authKey, connectionPromise);
        try {
            const connection = await connectionPromise;
            this.pendingConnections.delete(authKey);
            return connection;
        }
        catch (error) {
            this.pendingConnections.delete(authKey);
            throw error;
        }
    }
    static async createNewConnection(auth, authKey, startListener = false, existingApi) {
        Logger_1.default.log(`[ConnectionManager] 🆕 Creating new connection...`);
        let apiInstance;
        if (existingApi) {
            // Dùng API instance đã có (từ loginQR/loginCookies)
            apiInstance = existingApi;
            Logger_1.default.log(`[ConnectionManager] Using provided API instance`);
        }
        else {
            // Tạo mới qua loginZalo
            const loginHelper = new ZaloLoginHelper_1.default();
            apiInstance = await loginHelper.loginZalo(auth);
        }
        const zaloId = apiInstance.getOwnId();
        Logger_1.default.log(`[ConnectionManager] ✅ Connection ready for ${zaloId}`);
        const connection = {
            api: apiInstance,
            auth,
            authKey,
            listener: apiInstance.listener,
            connected: false,
            listenerStarted: false,
            createdAt: new Date(),
        };
        this.connections.set(zaloId, connection);
        return connection;
    }
    static async forceDisconnectAndCleanup(zaloId) {
        const connection = this.connections.get(zaloId);
        if (!connection)
            return;
        try {
            if (connection.listenerStarted && connection.listener && connection.connected) {
                connection.listener.stop();
            }
        }
        catch (error) {
            Logger_1.default.warn(`[ConnectionManager] Stop listener warning for ${zaloId}: ${error.message}`);
        }
        this.connections.delete(zaloId);
        this.connectionLocks.delete(zaloId);
        try {
            const ZaloService = require('../services/ZaloService').default;
            ZaloService.removeInstanceByZaloId(zaloId);
        }
        catch { }
        Logger_1.default.log(`[ConnectionManager] 🗑️  Removed connection for ${zaloId}`);
    }
    static setConnection(zaloId, connection) {
        this.connections.set(zaloId, connection);
    }
    static getConnection(zaloId) {
        return this.connections.get(zaloId);
    }
    static removeConnection(zaloId) {
        this.connections.delete(zaloId);
        this.connectionLocks.delete(zaloId);
        // Clean up ZaloService instance to free API memory
        try {
            const ZaloService = require('../services/ZaloService').default;
            ZaloService.removeInstanceByZaloId(zaloId);
        }
        catch { }
        Logger_1.default.log(`[ConnectionManager] 🗑️  Removed connection for ${zaloId}`);
    }
    static clearConnectionLock(zaloId) {
        this.connectionLocks.delete(zaloId);
    }
    static removePendingConnection(authKey) {
        this.pendingConnections.delete(authKey);
    }
    static isConnected(zaloId) {
        return this.connections.get(zaloId)?.connected ?? false;
    }
    static setConnected(zaloId, status) {
        const conn = this.connections.get(zaloId);
        if (conn)
            conn.connected = status;
    }
    static isListenerStarted(zaloId) {
        return this.connections.get(zaloId)?.listenerStarted ?? false;
    }
    static setListenerStarted(zaloId, status) {
        const conn = this.connections.get(zaloId);
        if (conn) {
            conn.listenerStarted = status;
            Logger_1.default.log(`[ConnectionManager] 🎧 Listener ${status ? 'started' : 'stopped'} for ${zaloId}`);
        }
    }
    static getAllConnections() {
        return this.connections;
    }
    static getConnectionCount() {
        return this.connections.size;
    }
    /**
     * Kiểm tra sức khỏe WebSocket listener trực tiếp qua readyState.
     * KHÔNG dựa vào flags nội bộ — đọc thẳng từ ws object của zca-js.
     *
     * readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
     * Trả về { zaloId, healthy, readyState, reason? }
     */
    static checkListenerHealth(zaloIdOrIds) {
        const ids = Array.isArray(zaloIdOrIds) ? zaloIdOrIds : [zaloIdOrIds];
        const results = [];
        for (const zaloId of ids) {
            const conn = this.connections.get(zaloId);
            if (!conn) {
                results.push({ zaloId, healthy: false, readyState: null, reason: 'no_connection' });
                continue;
            }
            if (!conn.listenerStarted) {
                results.push({ zaloId, healthy: false, readyState: null, reason: 'listener_not_started' });
                continue;
            }
            // Lấy ws object từ listener của zca-js
            // zca-js listener có thể expose ws qua listener.ws hoặc listener._ws hoặc listener.socket
            const listener = conn.listener;
            const ws = listener?.ws || listener?._ws || listener?.socket || listener?._socket || null;
            if (!ws) {
                // Không lấy được ws — dựa vào connected flag
                const healthy = conn.connected && conn.listenerStarted;
                results.push({
                    zaloId,
                    healthy,
                    readyState: null,
                    reason: healthy ? undefined : 'ws_not_accessible',
                });
                continue;
            }
            const readyState = ws.readyState ?? 3;
            const healthy = readyState === 1; // WebSocket.OPEN
            let reason;
            if (!healthy) {
                const stateNames = { 0: 'CONNECTING', 2: 'CLOSING', 3: 'CLOSED' };
                reason = stateNames[readyState] ?? `readyState_${readyState}`;
            }
            results.push({ zaloId, healthy, readyState, reason });
        }
        return results;
    }
}
ConnectionManager.connections = new Map();
ConnectionManager.pendingConnections = new Map();
ConnectionManager.connectionLocks = new Map();
exports.default = ConnectionManager;
//# sourceMappingURL=ConnectionManager.js.map