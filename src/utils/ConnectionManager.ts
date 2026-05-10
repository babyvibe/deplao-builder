import ZaloLoginHelper from "./ZaloLoginHelper";
import { API } from "zca-js";
import Logger from "./Logger";

interface Connection {
    api: API;
    auth: any;
    authKey: string;
    listener: any;
    connected: boolean;
    listenerStarted: boolean;
    createdAt: Date;
}

class ConnectionManager {
    private static connections: Map<string, Connection> = new Map();
    private static pendingConnections: Map<string, Promise<Connection>> = new Map();
    private static connectionLocks: Map<string, boolean> = new Map();

    /**
     * Lấy hoặc tạo connection - Single Source of Truth
     * @param auth
     * @param startListener
     * @param api Optional existing API instance (từ loginQR/loginCookies)
     * @param isReconnection
     */
    public static async getOrCreateConnection(
        auth: any,
        startListener: boolean = false,
        api?: API,
        isReconnection: boolean = false
    ): Promise<Connection> {
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
                    Logger.log(`[ConnectionManager] ♻️  Reusing existing connection`);
                    return connection;
                }
            }

            if (this.pendingConnections.has(authKey)) {
                Logger.log(`[ConnectionManager] ⏳ Waiting for pending connection...`);
                return await this.pendingConnections.get(authKey)!;
            }
        }

        const connectionPromise = this.createNewConnection(parsedAuth, authKey, startListener, api);
        this.pendingConnections.set(authKey, connectionPromise);

        try {
            const connection = await connectionPromise;
            this.pendingConnections.delete(authKey);
            return connection;
        } catch (error) {
            this.pendingConnections.delete(authKey);
            throw error;
        }
    }

    private static async createNewConnection(
        auth: any,
        authKey: string,
        startListener: boolean = false,
        existingApi?: API
    ): Promise<Connection> {
        Logger.log(`[ConnectionManager] 🆕 Creating new connection...`);

        let apiInstance: API;

        if (existingApi) {
            // Dùng API instance đã có (từ loginQR/loginCookies)
            apiInstance = existingApi;
            Logger.log(`[ConnectionManager] Using provided API instance`);
        } else {
            // Tạo mới qua loginZalo
            const loginHelper = new ZaloLoginHelper();
            apiInstance = await loginHelper.loginZalo(auth);
        }

        const zaloId = apiInstance.getOwnId();
        Logger.log(`[ConnectionManager] ✅ Connection ready for ${zaloId}`);

        const connection: Connection = {
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

    private static async forceDisconnectAndCleanup(zaloId: string): Promise<void> {
        const connection = this.connections.get(zaloId);
        if (!connection) return;

        try {
            if (connection.listenerStarted && connection.listener && connection.connected) {
                connection.listener.stop();
            }
        } catch (error: any) {
            Logger.warn(`[ConnectionManager] Stop listener warning for ${zaloId}: ${error.message}`);
        }

        this.connections.delete(zaloId);
        this.connectionLocks.delete(zaloId);
        try {
            const ZaloService = require('../services/ZaloService').default;
            ZaloService.removeInstanceByZaloId(zaloId);
        } catch {}
        Logger.log(`[ConnectionManager] 🗑️  Removed connection for ${zaloId}`);
    }

    public static setConnection(zaloId: string, connection: any): void {
        this.connections.set(zaloId, connection);
    }

    public static getConnection(zaloId: string): Connection | undefined {
        return this.connections.get(zaloId);
    }

    public static removeConnection(zaloId: string): void {
        this.connections.delete(zaloId);
        this.connectionLocks.delete(zaloId);
        // Clean up ZaloService instance to free API memory
        try {
            const ZaloService = require('../services/ZaloService').default;
            ZaloService.removeInstanceByZaloId(zaloId);
        } catch {}
        Logger.log(`[ConnectionManager] 🗑️  Removed connection for ${zaloId}`);
    }

    public static clearConnectionLock(zaloId: string): void {
        this.connectionLocks.delete(zaloId);
    }

    public static removePendingConnection(authKey: string): void {
        this.pendingConnections.delete(authKey);
    }

    public static isConnected(zaloId: string): boolean {
        return this.connections.get(zaloId)?.connected ?? false;
    }

    public static setConnected(zaloId: string, status: boolean): void {
        const conn = this.connections.get(zaloId);
        if (conn) conn.connected = status;
    }

    public static isListenerStarted(zaloId: string): boolean {
        return this.connections.get(zaloId)?.listenerStarted ?? false;
    }

    public static setListenerStarted(zaloId: string, status: boolean): void {
        const conn = this.connections.get(zaloId);
        if (conn) {
            conn.listenerStarted = status;
            Logger.log(`[ConnectionManager] 🎧 Listener ${status ? 'started' : 'stopped'} for ${zaloId}`);
        }
    }

    public static getAllConnections(): Map<string, Connection> {
        return this.connections;
    }

    public static getConnectionCount(): number {
        return this.connections.size;
    }

    /**
     * Kiểm tra sức khỏe WebSocket listener trực tiếp qua readyState.
     * KHÔNG dựa vào flags nội bộ — đọc thẳng từ ws object của zca-js.
     *
     * readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
     * Trả về { zaloId, healthy, readyState, reason? }
     */
    public static checkListenerHealth(
        zaloIdOrIds: string | string[]
    ): Array<{ zaloId: string; healthy: boolean; readyState: number | null; reason?: string }> {
        const ids = Array.isArray(zaloIdOrIds) ? zaloIdOrIds : [zaloIdOrIds];
        const results: Array<{ zaloId: string; healthy: boolean; readyState: number | null; reason?: string }> = [];

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

            const readyState: number = ws.readyState ?? 3;
            const healthy = readyState === 1; // WebSocket.OPEN

            let reason: string | undefined;
            if (!healthy) {
                const stateNames: Record<number, string> = { 0: 'CONNECTING', 2: 'CLOSING', 3: 'CLOSED' };
                reason = stateNames[readyState] ?? `readyState_${readyState}`;
            }

            results.push({ zaloId, healthy, readyState, reason });
        }

        return results;
    }
}

export default ConnectionManager;

