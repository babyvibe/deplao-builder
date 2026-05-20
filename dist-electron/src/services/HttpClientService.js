"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http = __importStar(require("http"));
const Logger_1 = __importDefault(require("../utils/Logger"));
const EventBroadcaster_1 = __importDefault(require("./EventBroadcaster"));
const DataSyncService_1 = __importDefault(require("./DataSyncService"));
/**
 * HttpClientService — Employee side only.
 * Replaces SocketClientService.
 *
 * - Runs a lightweight HTTP server to receive pushed events from Boss
 * - Sends proxy actions to Boss via HTTP POST
 * - Pulls sync data via HTTP GET
 * - Heartbeat every 15s to keep registration alive
 */
class HttpClientService {
    constructor() {
        this.connected = false;
        this.bossUrl = '';
        this.token = '';
        this.latencyMs = 0;
        this.heartbeatTimer = null;
        this.localServer = null;
        this.localPort = 9901;
        this.workspaceId = '';
        this.onStatusChange = null;
        this.onInitialState = null;
        this.onAccountAccessUpdate = null;
        this.onSyncProgress = null;
    }
    static getInstance() {
        if (!HttpClientService.instance) {
            HttpClientService.instance = new HttpClientService();
        }
        return HttpClientService.instance;
    }
    // ─── Lifecycle ────────────────────────────────────────────────────
    async connect(bossUrl, token) {
        if (this.connected) {
            this.disconnect();
        }
        this.token = token;
        // Normalize URL
        let url = bossUrl;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = `http://${url}`;
        }
        // Remove trailing slash
        this.bossUrl = url.replace(/\/+$/, '');
        Logger_1.default.log(`[HttpClientService] Connecting to Boss at ${this.bossUrl}...`);
        try {
            // 1. Start local HTTP server to receive pushed events
            await this.startLocalServer();
            // 2. Register callbackUrl with Boss via heartbeat
            // (login was already done by the UI, we have the token)
            const callbackUrl = `http://${this.getLocalIP()}:${this.localPort}`;
            const hbResult = await this.httpPost(`${this.bossUrl}/api/auth/heartbeat`, { callbackUrl }, { Authorization: `Bearer ${token}` });
            if (!hbResult.success) {
                this.stopLocalServer();
                return { success: false, error: hbResult.error || 'Không thể kết nối tới Boss' };
            }
            this.connected = true;
            Logger_1.default.log('[HttpClientService] ✅ Connected to Boss');
            this.onStatusChange?.(true, 0);
            this.startHeartbeat();
            // 3. Fetch initial snapshot
            try {
                const snapshot = await this.httpGet(`${this.bossUrl}/api/sync/snapshot`, { Authorization: `Bearer ${token}` });
                if (snapshot?.success && snapshot?.snapshot) {
                    this.onInitialState?.(snapshot.snapshot);
                }
            }
            catch (_) {
                // Non-critical — snapshot may come via push
            }
            return { success: true };
        }
        catch (err) {
            Logger_1.default.error(`[HttpClientService] Connect error: ${err.message}`);
            this.stopLocalServer();
            return { success: false, error: err.message };
        }
    }
    disconnect() {
        this.stopHeartbeat();
        this.stopLocalServer();
        this.onStatusChange = null;
        this.onInitialState = null;
        this.onAccountAccessUpdate = null;
        this.onSyncProgress = null;
        this.connected = false;
        Logger_1.default.log('[HttpClientService] Disconnected');
    }
    isConnected() {
        return this.connected;
    }
    getStatus() {
        return { connected: this.connected, bossUrl: this.bossUrl, latency: this.latencyMs };
    }
    // ─── Proxy actions through Boss ──────────────────────────────────
    async proxyAction(channel, params) {
        if (!this.connected) {
            throw new Error('Chưa kết nối tới BOSS');
        }
        return this.httpPost(`${this.bossUrl}/api/proxy/action`, { channel, params }, { Authorization: `Bearer ${this.token}` }, 30000);
    }
    // ─── Media request ────────────────────────────────────────────────
    async requestMedia(filePath) {
        if (!this.connected) {
            return { success: false, error: 'Not connected' };
        }
        try {
            return await this.httpPostRaw(`${this.bossUrl}/api/media/request`, { filePath }, { Authorization: `Bearer ${this.token}` }, 60000);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    // ─── Callbacks ────────────────────────────────────────────────────
    setOnStatusChange(cb) {
        this.onStatusChange = cb;
    }
    setOnInitialState(cb) {
        this.onInitialState = cb;
    }
    setOnAccountAccessUpdate(cb) {
        this.onAccountAccessUpdate = cb;
    }
    setOnSyncProgress(cb) {
        this.onSyncProgress = cb;
    }
    setWorkspaceId(id) {
        this.workspaceId = id;
    }
    // ─── Data Sync ────────────────────────────────────────────────────
    async requestFullSync(_zaloIds) {
        if (!this.connected) {
            return { success: false, error: 'Chưa kết nối tới BOSS' };
        }
        try {
            this.onSyncProgress?.('Đang yêu cầu dữ liệu...', 0);
            const result = await this.httpGet(`${this.bossUrl}/api/sync/full`, { Authorization: `Bearer ${this.token}` }, 120000);
            if (!result?.success) {
                return { success: false, error: result?.error || 'Sync failed' };
            }
            this.onSyncProgress?.('Đang xử lý dữ liệu...', 50);
            return { success: true, payload: result.payload, syncTs: result.syncTs };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    async requestDeltaSync(sinceTs) {
        if (!this.connected) {
            return { success: false, error: 'Chưa kết nối tới BOSS' };
        }
        try {
            this.onSyncProgress?.('Đang yêu cầu cập nhật...', 0);
            const result = await this.httpGet(`${this.bossUrl}/api/sync/delta?sinceTs=${sinceTs}`, { Authorization: `Bearer ${this.token}` }, 60000);
            if (!result?.success) {
                return { success: false, error: result?.error || 'Delta sync failed' };
            }
            this.onSyncProgress?.('Đang xử lý cập nhật...', 50);
            return { success: true, payload: result.payload, syncTs: result.syncTs };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
    async performFullSync(zaloIds) {
        try {
            this.onSyncProgress?.('Đang tải dữ liệu từ Boss...', 5);
            const result = await this.requestFullSync(zaloIds);
            if (!result.success || !result.payload) {
                this.onSyncProgress?.(`Lỗi: ${result.error}`, 0);
                return { success: false, error: result.error };
            }
            this.onSyncProgress?.('Đang nhập dữ liệu...', 55);
            DataSyncService_1.default.getInstance().importFullSync(result.payload, zaloIds, (phase, percent) => {
                this.onSyncProgress?.(phase, 55 + Math.round(percent * 0.45));
            });
            this.onSyncProgress?.('Hoàn tất đồng bộ!', 100);
            return { success: true, syncTs: result.syncTs };
        }
        catch (err) {
            Logger_1.default.error(`[HttpClientService] Full sync error: ${err.message}`);
            this.onSyncProgress?.(`Lỗi: ${err.message}`, 0);
            return { success: false, error: err.message };
        }
    }
    async performDeltaSync(sinceTs) {
        try {
            this.onSyncProgress?.('Đang kiểm tra cập nhật...', 5);
            const result = await this.requestDeltaSync(sinceTs);
            if (!result.success || !result.payload) {
                return { success: false, error: result.error };
            }
            const totalRows = Object.values(result.payload.tables).reduce((s, arr) => s + arr.length, 0);
            const hasPrivateSnapshots = ['erp_calendar_events', 'erp_event_reminders', 'erp_event_attendees', 'erp_note_folders', 'erp_notes', 'erp_note_shares', 'erp_note_versions', 'erp_note_tag_map', 'erp_note_tags']
                .some(tableName => Object.prototype.hasOwnProperty.call(result.payload?.tables || {}, tableName));
            if (totalRows === 0 && !hasPrivateSnapshots) {
                this.onSyncProgress?.('Không có cập nhật mới', 100);
                return { success: true, syncTs: result.syncTs };
            }
            this.onSyncProgress?.('Đang cập nhật dữ liệu...', 50);
            DataSyncService_1.default.getInstance().importDeltaSync(result.payload, (phase, percent) => {
                this.onSyncProgress?.(phase, 50 + Math.round(percent * 0.5));
            });
            this.onSyncProgress?.('Hoàn tất cập nhật!', 100);
            return { success: true, syncTs: result.syncTs };
        }
        catch (err) {
            Logger_1.default.error(`[HttpClientService] Delta sync error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    // ─── Local HTTP Server (receive pushed events from Boss) ──────────
    startLocalServer() {
        return new Promise((resolve, reject) => {
            if (this.localServer) {
                resolve();
                return;
            }
            this.localServer = http.createServer((req, res) => {
                if (req.method === 'POST' && req.url === '/event') {
                    let body = '';
                    req.on('data', (chunk) => { body += chunk.toString(); });
                    req.on('end', () => {
                        try {
                            const { channel, data } = JSON.parse(body);
                            this.handlePushedEvent(channel, data);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end('{"ok":true}');
                        }
                        catch (err) {
                            res.writeHead(400);
                            res.end('{"error":"bad request"}');
                        }
                    });
                    return;
                }
                // Health
                if (req.method === 'GET' && req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"status":"ok"}');
                    return;
                }
                res.writeHead(404);
                res.end();
            });
            // Try ports 9901-9910 if default is busy
            const tryListen = (port, attempts) => {
                this.localServer.listen(port, () => {
                    this.localPort = port;
                    Logger_1.default.log(`[HttpClientService] Local event server started on port ${port}`);
                    resolve();
                });
                this.localServer.on('error', (err) => {
                    if (err.code === 'EADDRINUSE' && attempts > 0) {
                        this.localServer.removeAllListeners('error');
                        tryListen(port + 1, attempts - 1);
                    }
                    else {
                        reject(new Error(`Cannot start local server: ${err.message}`));
                    }
                });
            };
            tryListen(this.localPort, 10);
        });
    }
    stopLocalServer() {
        if (this.localServer) {
            try {
                this.localServer.close();
            }
            catch (_) { }
            this.localServer = null;
        }
    }
    handlePushedEvent(channel, data) {
        // Special relay channels
        if (channel === 'relay:initialState') {
            Logger_1.default.log(`[HttpClientService] Received initial state push: assigned=${data?.assignedAccounts?.length || 0}`);
            this.onInitialState?.(data);
            return;
        }
        if (channel === 'relay:accountAccessUpdate') {
            Logger_1.default.log(`[HttpClientService] Account access updated: assigned=${data?.assignedAccounts?.length || 0}`);
            this.onAccountAccessUpdate?.(data);
            return;
        }
        if (channel === 'relay:kicked') {
            Logger_1.default.log(`[HttpClientService] Kicked by boss: ${data?.reason}`);
            this.disconnect();
            this.onStatusChange?.(false, 0);
            return;
        }
        // Forward Zalo events to local EventBroadcaster
        // Use sendDirect to bypass onBeforeSend hooks — prevents infinite relay loop
        // when HttpRelayService hooks are active in the same process.
        if (channel === 'event:message' && data?.zaloId && data?.message) {
            this.saveRelayMessageToWorkspaceDb(data.zaloId, data.message);
            return;
        }
        // Persist reaction to employee DB (regardless of whether workspace is active),
        // then forward to renderer if active. Mirrors saveRelayMessageToWorkspaceDb logic.
        if (channel === 'event:reaction' && data?.zaloId && data?.reaction) {
            this.saveRelayReactionToWorkspaceDb(data.zaloId, data.reaction);
            return;
        }
        // Persist undo/recall to employee DB — boss uses runOnBossDb, so employee DB
        // must be updated separately on the employee side.
        if (channel === 'event:undo' && data?.zaloId && data?.msgId) {
            this.saveRelayRecallToWorkspaceDb('event:undo', data, data.zaloId, [String(data.msgId)], data.threadId);
            return;
        }
        // Persist delete (chat.delete) to employee DB — same as undo, mark as recalled.
        if (channel === 'event:delete' && data?.zaloId && Array.isArray(data?.msgIds) && data.msgIds.length) {
            this.saveRelayRecallToWorkspaceDb('event:delete', data, data.zaloId, data.msgIds.map(String), data.threadId);
            return;
        }
        if (HttpClientService.FORWARD_CHANNELS.includes(channel)) {
            // Only forward to renderer when this employee workspace is the active one.
            // When boss workspace is active, boss's send() already went to renderer.
            try {
                const WorkspaceManager = require('../utils/WorkspaceManager').default;
                const activeWsId = WorkspaceManager.getInstance().getActiveWorkspaceId();
                if (activeWsId === this.workspaceId) {
                    EventBroadcaster_1.default.sendDirect(channel, data);
                }
            }
            catch {
                EventBroadcaster_1.default.sendDirect(channel, data);
            }
        }
    }
    // ─── Heartbeat ────────────────────────────────────────────────────
    /**
     * Save a relayed reaction to this employee workspace's DB, then send to renderer.
     * Uses withDbPath to target the correct DB when another workspace is active.
     * Mirrors saveRelayMessageToWorkspaceDb — ensures boss reactions are persisted
     * on the employee side even when the employee workspace is not the active window.
     */
    saveRelayReactionToWorkspaceDb(zaloId, reaction) {
        try {
            const DatabaseService = require('./DatabaseService').default;
            const WorkspaceManager = require('../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();
            const wm = WorkspaceManager.getInstance();
            // Parse reaction fields (mirrors ZaloLoginHelper / EventBroadcaster logic)
            const rData = reaction.data || {};
            const userId = String(rData.uidFrom || reaction.uidFrom || '');
            const rMsg = rData.content?.rMsg || reaction.content?.rMsg || [];
            const targetMsgId = rMsg.length > 0
                ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '')
                : String(rData.msgId || reaction.msgId || '');
            const rawIcon = rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '';
            const ICON_MAP = {
                '/-heart': '❤️', '/-strong': '👍', ':>': '😆', ':o': '😮',
                ':-((': '😢', ':-h': '😡', ':-*': '😘', ":')": '😂',
                '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
                ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '🥱',
                '_()_': '🙏', '/-no': '🙅', '/-ok': '👌', '/-v': '✌️',
                '/-thanks': '🙏', '/-punch': '👊', ':-bye': '👋', ':((': '😭',
                ':))': '😁', '$-)': '🤑',
            };
            const emoji = ICON_MAP[rawIcon] || rawIcon;
            if (!userId || !targetMsgId) {
                Logger_1.default.warn(`[HttpClientService] saveRelayReaction: missing userId or targetMsgId`);
                return;
            }
            // Determine this employee workspace's DB path
            let targetDbPath = null;
            if (this.workspaceId) {
                const ws = wm.getWorkspaceById(this.workspaceId);
                if (ws) {
                    targetDbPath = wm.resolveDbPath(ws.dbPath || 'deplao-tool.db');
                }
            }
            const activeDbPath = db.getDbPath();
            const needSwitch = targetDbPath && targetDbPath !== activeDbPath;
            if (needSwitch) {
                db.withDbPath(targetDbPath, () => {
                    db.updateMessageReaction(zaloId, targetMsgId, userId, emoji);
                });
                Logger_1.default.log(`[HttpClientService] Saved relay reaction to ${targetDbPath} via withDbPath`);
            }
            else {
                db.updateMessageReaction(zaloId, targetMsgId, userId, emoji);
                Logger_1.default.log(`[HttpClientService] Saved relay reaction to active DB (our workspace)`);
            }
            // Forward to renderer only when this employee workspace is the active one
            const activeWsId = wm.getActiveWorkspaceId();
            if (activeWsId === this.workspaceId) {
                EventBroadcaster_1.default.sendDirect('event:reaction', { zaloId, reaction });
            }
        }
        catch (err) {
            Logger_1.default.warn(`[HttpClientService] saveRelayReaction error: ${err.message}`);
        }
    }
    /**
     * Mark relayed recalled/deleted messages in this employee workspace's DB.
     * Called for event:undo and event:delete — both just mark messages as recalled.
     * Uses withDbPath to target the correct DB when another workspace is active.
     */
    saveRelayRecallToWorkspaceDb(_channel, _originalData, zaloId, msgIds, threadId) {
        try {
            const DatabaseService = require('./DatabaseService').default;
            const WorkspaceManager = require('../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();
            const wm = WorkspaceManager.getInstance();
            let targetDbPath = null;
            if (this.workspaceId) {
                const ws = wm.getWorkspaceById(this.workspaceId);
                if (ws) {
                    targetDbPath = wm.resolveDbPath(ws.dbPath || 'deplao-tool.db');
                }
            }
            const activeDbPath = db.getDbPath();
            const needSwitch = targetDbPath && targetDbPath !== activeDbPath;
            const doRecall = () => {
                for (const msgId of msgIds) {
                    db.markMessageRecalled(zaloId, msgId);
                    if (threadId) {
                        try {
                            db.updateLastMessageIfRecalled(zaloId, threadId, msgId);
                        }
                        catch { }
                    }
                }
            };
            if (needSwitch) {
                db.withDbPath(targetDbPath, doRecall);
                Logger_1.default.log(`[HttpClientService] Saved relay recall (${msgIds.length} msgs) to ${targetDbPath} via withDbPath`);
            }
            else {
                doRecall();
                Logger_1.default.log(`[HttpClientService] Saved relay recall (${msgIds.length} msgs) to active DB`);
            }
            // Determine channel from msgIds count (single = undo, multiple = delete)
            const channel = msgIds.length === 1 ? 'event:undo' : 'event:delete';
            const eventData = msgIds.length === 1
                ? { zaloId, msgId: msgIds[0], threadId }
                : { zaloId, msgIds, threadId };
            const activeWsId = wm.getActiveWorkspaceId();
            if (activeWsId === this.workspaceId) {
                EventBroadcaster_1.default.sendDirect(channel, eventData);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[HttpClientService] saveRelayRecall error: ${err.message}`);
        }
    }
    /**
     * Save a relayed message to this employee workspace's DB, then send to renderer.
     * Uses withDbPath to target the correct DB when another workspace is active.
     * Bypasses EventBroadcaster hooks to prevent infinite relay loop.
     */
    saveRelayMessageToWorkspaceDb(zaloId, message) {
        try {
            const DatabaseService = require('./DatabaseService').default;
            const WorkspaceManager = require('../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();
            const wm = WorkspaceManager.getInstance();
            // Determine this employee workspace's DB path
            let targetDbPath = null;
            if (this.workspaceId) {
                const ws = wm.getWorkspaceById(this.workspaceId);
                if (ws) {
                    targetDbPath = wm.resolveDbPath(ws.dbPath || 'deplao-tool.db');
                }
            }
            const activeDbPath = db.getDbPath();
            const needSwitch = targetDbPath && targetDbPath !== activeDbPath;
            if (needSwitch) {
                // Save to a DIFFERENT workspace DB (not the currently active one)
                db.withDbPath(targetDbPath, () => {
                    db.saveMessage(zaloId, message);
                    // Persist employee sender info so it survives conversation reload
                    const empInfo = message.data?._employeeInfo;
                    const msgId = message.data?.msgId;
                    if (empInfo?.employee_id && msgId) {
                        db.setMessageHandledByEmployee(zaloId, String(msgId), empInfo.employee_id);
                    }
                });
                Logger_1.default.log(`[HttpClientService] Saved relay message to ${targetDbPath} via withDbPath`);
            }
            else {
                // Active DB IS our workspace — save directly
                db.saveMessage(zaloId, message);
                // Persist employee sender info so it survives conversation reload
                const empInfo = message.data?._employeeInfo;
                const msgId = message.data?.msgId;
                if (empInfo?.employee_id && msgId) {
                    db.setMessageHandledByEmployee(zaloId, String(msgId), empInfo.employee_id);
                }
                Logger_1.default.log(`[HttpClientService] Saved relay message to active DB (our workspace)`);
            }
            // Only send to renderer when THIS employee workspace is the active one.
            // When boss workspace is active, the boss's broadcastMessage.send() already
            // sent to renderer — sending again would cause double notification.
            const activeWsId = wm.getActiveWorkspaceId();
            if (activeWsId === this.workspaceId) {
                EventBroadcaster_1.default.sendDirect('event:message', { zaloId, message });
            }
        }
        catch (err) {
            Logger_1.default.warn(`[HttpClientService] saveRelayMessage error: ${err.message}`);
        }
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(async () => {
            if (!this.connected)
                return;
            const start = Date.now();
            try {
                const callbackUrl = `http://${this.getLocalIP()}:${this.localPort}`;
                const result = await this.httpPost(`${this.bossUrl}/api/auth/heartbeat`, { callbackUrl }, { Authorization: `Bearer ${this.token}` }, 10000);
                if (result.success) {
                    this.latencyMs = Date.now() - start;
                    this.onStatusChange?.(true, this.latencyMs);
                }
                else {
                    this.onStatusChange?.(false, 0);
                }
            }
            catch (err) {
                this.latencyMs = 0;
                this.onStatusChange?.(false, 0);
            }
        }, 15000);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    // ─── HTTP helpers ─────────────────────────────────────────────────
    httpPost(url, body, headers = {}, timeout = 15000) {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const payload = JSON.stringify(body);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');
                const req = httpModule.request({
                    hostname: urlObj.hostname,
                    port: urlObj.port,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        ...headers,
                    },
                    timeout,
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk.toString(); });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        }
                        catch {
                            resolve({ success: false, error: 'Invalid JSON response' });
                        }
                    });
                });
                req.on('error', (err) => reject(err));
                req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
                req.write(payload);
                req.end();
            }
            catch (err) {
                reject(err);
            }
        });
    }
    httpGet(url, headers = {}, timeout = 15000) {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');
                const req = httpModule.request({
                    hostname: urlObj.hostname,
                    port: urlObj.port,
                    path: urlObj.pathname + urlObj.search,
                    method: 'GET',
                    headers,
                    timeout,
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk.toString(); });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        }
                        catch {
                            resolve({ success: false, error: 'Invalid JSON response' });
                        }
                    });
                });
                req.on('error', (err) => reject(err));
                req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
                req.end();
            }
            catch (err) {
                reject(err);
            }
        });
    }
    httpPostRaw(url, body, headers = {}, timeout = 60000) {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const payload = JSON.stringify(body);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');
                const req = httpModule.request({
                    hostname: urlObj.hostname,
                    port: urlObj.port,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        ...headers,
                    },
                    timeout,
                }, (res) => {
                    const contentType = res.headers['content-type'] || '';
                    if (contentType.includes('application/octet-stream')) {
                        const chunks = [];
                        res.on('data', (chunk) => chunks.push(chunk));
                        res.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            const fileName = (res.headers['content-disposition'] || '')
                                .match(/filename="?([^"]+)"?/)?.[1] || 'file';
                            resolve({ success: true, data: buffer, fileName });
                        });
                    }
                    else {
                        let data = '';
                        res.on('data', (chunk) => { data += chunk.toString(); });
                        res.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            }
                            catch {
                                resolve({ success: false, error: 'Invalid response' });
                            }
                        });
                    }
                });
                req.on('error', (err) => reject(err));
                req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
                req.write(payload);
                req.end();
            }
            catch (err) {
                reject(err);
            }
        });
    }
    getLocalIP() {
        const nets = require('os').networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return '127.0.0.1';
    }
}
/** Channels to forward to local EventBroadcaster */
HttpClientService.FORWARD_CHANNELS = [
    'event:message',
    'event:reaction',
    'event:groupEvent',
    'event:groupInfoUpdate',
    'event:pollVote',
    'event:pinsUpdated',
    'event:connected',
    'event:disconnected',
    'event:friendRequest',
    'event:friendAccepted',
    'event:typing',
    'event:seen',
    'event:undo',
    'event:delete',
    'event:reminder',
    'event:localPath',
    'event:listenerDead',
    'relay:messageSentByEmployee',
    'erp:event:taskCreated',
    'erp:event:taskUpdated',
    'erp:event:taskDeleted',
    'erp:event:commentAdded',
    'erp:event:projectCreated',
    'erp:event:projectUpdated',
    'erp:event:projectDeleted',
    'erp:event:calendarEventCreated',
    'erp:event:calendarEventUpdated',
    'erp:event:calendarEventDeleted',
    'erp:event:notification',
    'erp:event:reminder',
    'erp:event:noteCreated',
    'erp:event:noteUpdated',
    'erp:event:noteDeleted',
    'erp:event:noteShared',
    'erp:event:leaveCreated',
    'erp:event:leaveDecided',
    'erp:event:attendanceUpdated',
    'erp:event:departmentUpdated',
    'erp:event:employeeProfileUpdated',
];
exports.default = HttpClientService;
//# sourceMappingURL=HttpClientService.js.map