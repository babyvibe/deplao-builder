import * as http from 'http';
import Logger from '../utils/Logger';
import EventBroadcaster from './EventBroadcaster';
import DataSyncService, { SyncPayload } from './DataSyncService';

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
    private static instance: HttpClientService;
    private connected = false;
    private bossUrl = '';
    private token = '';
    private latencyMs = 0;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private localServer: http.Server | null = null;
    private localPort = 9901;
    private workspaceId = '';

    private onStatusChange: ((connected: boolean, latency: number) => void) | null = null;
    private onInitialState: ((data: any) => void) | null = null;
    private onAccountAccessUpdate: ((data: any) => void) | null = null;
    private onSyncProgress: ((phase: string, percent: number) => void) | null = null;

    /** Channels to forward to local EventBroadcaster */
    private static FORWARD_CHANNELS = [
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

    public static getInstance(): HttpClientService {
        if (!HttpClientService.instance) {
            HttpClientService.instance = new HttpClientService();
        }
        return HttpClientService.instance;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────

    public async connect(bossUrl: string, token: string): Promise<{ success: boolean; error?: string }> {
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

        Logger.log(`[HttpClientService] Connecting to Boss at ${this.bossUrl}...`);

        try {
            // 1. Start local HTTP server to receive pushed events
            await this.startLocalServer();

            // 2. Register callbackUrl with Boss via heartbeat
            // (login was already done by the UI, we have the token)
            const callbackUrl = `http://${this.getLocalIP()}:${this.localPort}`;
            const hbResult = await this.httpPost(
                `${this.bossUrl}/api/auth/heartbeat`,
                { callbackUrl },
                { Authorization: `Bearer ${token}` }
            );

            if (!hbResult.success) {
                this.stopLocalServer();
                return { success: false, error: hbResult.error || 'Không thể kết nối tới Boss' };
            }

            this.connected = true;
            Logger.log('[HttpClientService] ✅ Connected to Boss');
            this.onStatusChange?.(true, 0);
            this.startHeartbeat();

            // 3. Fetch initial snapshot
            try {
                const snapshot = await this.httpGet(
                    `${this.bossUrl}/api/sync/snapshot`,
                    { Authorization: `Bearer ${token}` }
                );
                if (snapshot?.success && snapshot?.snapshot) {
                    this.onInitialState?.(snapshot.snapshot);
                }
            } catch (_) {
                // Non-critical — snapshot may come via push
            }

            return { success: true };
        } catch (err: any) {
            Logger.error(`[HttpClientService] Connect error: ${err.message}`);
            this.stopLocalServer();
            return { success: false, error: err.message };
        }
    }

    public disconnect(): void {
        this.stopHeartbeat();
        this.stopLocalServer();
        this.onStatusChange = null;
        this.onInitialState = null;
        this.onAccountAccessUpdate = null;
        this.onSyncProgress = null;
        this.connected = false;
        Logger.log('[HttpClientService] Disconnected');
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public getStatus(): { connected: boolean; bossUrl: string; latency: number } {
        return { connected: this.connected, bossUrl: this.bossUrl, latency: this.latencyMs };
    }

    // ─── Proxy actions through Boss ──────────────────────────────────

    public async proxyAction(channel: string, params: any): Promise<any> {
        if (!this.connected) {
            throw new Error('Chưa kết nối tới BOSS');
        }

        return this.httpPost(
            `${this.bossUrl}/api/proxy/action`,
            { channel, params },
            { Authorization: `Bearer ${this.token}` },
            30000
        );
    }

    // ─── Media request ────────────────────────────────────────────────

    public async requestMedia(filePath: string): Promise<{ success: boolean; data?: Buffer; fileName?: string; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Not connected' };
        }

        try {
            return await this.httpPostRaw(
                `${this.bossUrl}/api/media/request`,
                { filePath },
                { Authorization: `Bearer ${this.token}` },
                60000
            );
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    // ─── Callbacks ────────────────────────────────────────────────────

    public setOnStatusChange(cb: (connected: boolean, latency: number) => void): void {
        this.onStatusChange = cb;
    }
    public setOnInitialState(cb: (data: any) => void): void {
        this.onInitialState = cb;
    }
    public setOnAccountAccessUpdate(cb: (data: any) => void): void {
        this.onAccountAccessUpdate = cb;
    }
    public setOnSyncProgress(cb: (phase: string, percent: number) => void): void {
        this.onSyncProgress = cb;
    }
    public setWorkspaceId(id: string): void {
        this.workspaceId = id;
    }

    // ─── Data Sync ────────────────────────────────────────────────────

    public async requestFullSync(_zaloIds: string[]): Promise<{ success: boolean; payload?: SyncPayload; syncTs?: number; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Chưa kết nối tới BOSS' };
        }

        try {
            this.onSyncProgress?.('Đang yêu cầu dữ liệu...', 0);
            const result = await this.httpGet(
                `${this.bossUrl}/api/sync/full`,
                { Authorization: `Bearer ${this.token}` },
                120000
            );

            if (!result?.success) {
                return { success: false, error: result?.error || 'Sync failed' };
            }

            this.onSyncProgress?.('Đang xử lý dữ liệu...', 50);
            return { success: true, payload: result.payload, syncTs: result.syncTs };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    public async requestDeltaSync(sinceTs: number): Promise<{ success: boolean; payload?: SyncPayload; syncTs?: number; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Chưa kết nối tới BOSS' };
        }

        try {
            this.onSyncProgress?.('Đang yêu cầu cập nhật...', 0);
            const result = await this.httpGet(
                `${this.bossUrl}/api/sync/delta?sinceTs=${sinceTs}`,
                { Authorization: `Bearer ${this.token}` },
                60000
            );

            if (!result?.success) {
                return { success: false, error: result?.error || 'Delta sync failed' };
            }

            this.onSyncProgress?.('Đang xử lý cập nhật...', 50);
            return { success: true, payload: result.payload, syncTs: result.syncTs };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    public async performFullSync(zaloIds: string[]): Promise<{ success: boolean; syncTs?: number; error?: string }> {
        try {
            this.onSyncProgress?.('Đang tải dữ liệu từ Boss...', 5);
            const result = await this.requestFullSync(zaloIds);
            if (!result.success || !result.payload) {
                this.onSyncProgress?.(`Lỗi: ${result.error}`, 0);
                return { success: false, error: result.error };
            }

            this.onSyncProgress?.('Đang nhập dữ liệu...', 55);
            DataSyncService.getInstance().importFullSync(
                result.payload,
                zaloIds,
                (phase, percent) => {
                    this.onSyncProgress?.(phase, 55 + Math.round(percent * 0.45));
                }
            );

            this.onSyncProgress?.('Hoàn tất đồng bộ!', 100);
            return { success: true, syncTs: result.syncTs };
        } catch (err: any) {
            Logger.error(`[HttpClientService] Full sync error: ${err.message}`);
            this.onSyncProgress?.(`Lỗi: ${err.message}`, 0);
            return { success: false, error: err.message };
        }
    }

    public async performDeltaSync(sinceTs: number): Promise<{ success: boolean; syncTs?: number; error?: string }> {
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
            DataSyncService.getInstance().importDeltaSync(
                result.payload,
                (phase, percent) => {
                    this.onSyncProgress?.(phase, 50 + Math.round(percent * 0.5));
                }
            );

            this.onSyncProgress?.('Hoàn tất cập nhật!', 100);
            return { success: true, syncTs: result.syncTs };
        } catch (err: any) {
            Logger.error(`[HttpClientService] Delta sync error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    // ─── Local HTTP Server (receive pushed events from Boss) ──────────

    private startLocalServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.localServer) {
                resolve();
                return;
            }

            this.localServer = http.createServer((req, res) => {
                if (req.method === 'POST' && req.url === '/event') {
                    let body = '';
                    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                    req.on('end', () => {
                        try {
                            const { channel, data } = JSON.parse(body);
                            this.handlePushedEvent(channel, data);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end('{"ok":true}');
                        } catch (err) {
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
            const tryListen = (port: number, attempts: number) => {
                this.localServer!.listen(port, () => {
                    this.localPort = port;
                    Logger.log(`[HttpClientService] Local event server started on port ${port}`);
                    resolve();
                });
                this.localServer!.on('error', (err: any) => {
                    if (err.code === 'EADDRINUSE' && attempts > 0) {
                        this.localServer!.removeAllListeners('error');
                        tryListen(port + 1, attempts - 1);
                    } else {
                        reject(new Error(`Cannot start local server: ${err.message}`));
                    }
                });
            };

            tryListen(this.localPort, 10);
        });
    }

    private stopLocalServer(): void {
        if (this.localServer) {
            try { this.localServer.close(); } catch (_) {}
            this.localServer = null;
        }
    }

    private handlePushedEvent(channel: string, data: any): void {
        // Special relay channels
        if (channel === 'relay:initialState') {
            Logger.log(`[HttpClientService] Received initial state push: assigned=${data?.assignedAccounts?.length || 0}`);
            this.onInitialState?.(data);
            return;
        }
        if (channel === 'relay:accountAccessUpdate') {
            Logger.log(`[HttpClientService] Account access updated: assigned=${data?.assignedAccounts?.length || 0}`);
            this.onAccountAccessUpdate?.(data);
            return;
        }
        if (channel === 'relay:kicked') {
            Logger.log(`[HttpClientService] Kicked by boss: ${data?.reason}`);
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
                    EventBroadcaster.sendDirect(channel, data);
                }
            } catch {
                EventBroadcaster.sendDirect(channel, data);
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
    private saveRelayReactionToWorkspaceDb(zaloId: string, reaction: any): void {
        try {
            const DatabaseService = require('./DatabaseService').default;
            const WorkspaceManager = require('../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();
            const wm = WorkspaceManager.getInstance();

            // Parse reaction fields (mirrors ZaloLoginHelper / EventBroadcaster logic)
            const rData = reaction.data || {};
            const userId = String(rData.uidFrom || reaction.uidFrom || '');
            const rMsg: any[] = rData.content?.rMsg || reaction.content?.rMsg || [];
            const targetMsgId = rMsg.length > 0
                ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '')
                : String(rData.msgId || reaction.msgId || '');
            const rawIcon: string = rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '';
            const ICON_MAP: Record<string, string> = {
                '/-heart': '❤️', '/-strong': '👍', ':>': '😆', ':o': '😮',
                ':-((':  '😢', ':-h': '😡', ':-*': '😘', ":')": '😂',
                '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
                ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '🥱',
                '_()_': '🙏', '/-no': '🙅', '/-ok': '👌', '/-v': '✌️',
                '/-thanks': '🙏', '/-punch': '👊', ':-bye': '👋', ':((': '😭',
                ':))': '😁', '$-)': '🤑',
            };
            const emoji = ICON_MAP[rawIcon] || rawIcon;

            if (!userId || !targetMsgId) {
                Logger.warn(`[HttpClientService] saveRelayReaction: missing userId or targetMsgId`);
                return;
            }

            // Determine this employee workspace's DB path
            let targetDbPath: string | null = null;
            if (this.workspaceId) {
                const ws = wm.getWorkspaceById(this.workspaceId);
                if (ws) {
                    targetDbPath = wm.resolveDbPath(ws.dbPath || 'deplao-tool.db');
                }
            }

            const activeDbPath = db.getDbPath();
            const needSwitch = targetDbPath && targetDbPath !== activeDbPath;

            if (needSwitch) {
                db.withDbPath(targetDbPath!, () => {
                    db.updateMessageReaction(zaloId, targetMsgId, userId, emoji);
                });
                Logger.log(`[HttpClientService] Saved relay reaction to ${targetDbPath} via withDbPath`);
            } else {
                db.updateMessageReaction(zaloId, targetMsgId, userId, emoji);
                Logger.log(`[HttpClientService] Saved relay reaction to active DB (our workspace)`);
            }

            // Forward to renderer only when this employee workspace is the active one
            const activeWsId = wm.getActiveWorkspaceId();
            if (activeWsId === this.workspaceId) {
                EventBroadcaster.sendDirect('event:reaction', { zaloId, reaction });
            }
        } catch (err: any) {
            Logger.warn(`[HttpClientService] saveRelayReaction error: ${err.message}`);
        }
    }

    /**
     * Mark relayed recalled/deleted messages in this employee workspace's DB.
     * Called for event:undo and event:delete — both just mark messages as recalled.
     * Uses withDbPath to target the correct DB when another workspace is active.
     */
    private saveRelayRecallToWorkspaceDb(_channel: string, _originalData: any, zaloId: string, msgIds: string[], threadId?: string): void {
        try {
            const DatabaseService = require('./DatabaseService').default;
            const WorkspaceManager = require('../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();
            const wm = WorkspaceManager.getInstance();

            let targetDbPath: string | null = null;
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
                        try { db.updateLastMessageIfRecalled(zaloId, threadId, msgId); } catch {}
                    }
                }
            };

            if (needSwitch) {
                db.withDbPath(targetDbPath!, doRecall);
                Logger.log(`[HttpClientService] Saved relay recall (${msgIds.length} msgs) to ${targetDbPath} via withDbPath`);
            } else {
                doRecall();
                Logger.log(`[HttpClientService] Saved relay recall (${msgIds.length} msgs) to active DB`);
            }

            // Determine channel from msgIds count (single = undo, multiple = delete)
            const channel = msgIds.length === 1 ? 'event:undo' : 'event:delete';
            const eventData = msgIds.length === 1
                ? { zaloId, msgId: msgIds[0], threadId }
                : { zaloId, msgIds, threadId };

            const activeWsId = wm.getActiveWorkspaceId();
            if (activeWsId === this.workspaceId) {
                EventBroadcaster.sendDirect(channel, eventData);
            }
        } catch (err: any) {
            Logger.warn(`[HttpClientService] saveRelayRecall error: ${err.message}`);
        }
    }

    /**
     * Save a relayed message to this employee workspace's DB, then send to renderer.
     * Uses withDbPath to target the correct DB when another workspace is active.
     * Bypasses EventBroadcaster hooks to prevent infinite relay loop.
     */
    private saveRelayMessageToWorkspaceDb(zaloId: string, message: any): void {
        try {
            const DatabaseService = require('./DatabaseService').default;
            const WorkspaceManager = require('../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();
            const wm = WorkspaceManager.getInstance();

            // Determine this employee workspace's DB path
            let targetDbPath: string | null = null;
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
                db.withDbPath(targetDbPath!, () => {
                    db.saveMessage(zaloId, message);
                    // Persist employee sender info so it survives conversation reload
                    const empInfo = message.data?._employeeInfo;
                    const msgId = message.data?.msgId;
                    if (empInfo?.employee_id && msgId) {
                        db.setMessageHandledByEmployee(zaloId, String(msgId), empInfo.employee_id);
                    }
                });
                Logger.log(`[HttpClientService] Saved relay message to ${targetDbPath} via withDbPath`);
            } else {
                // Active DB IS our workspace — save directly
                db.saveMessage(zaloId, message);
                // Persist employee sender info so it survives conversation reload
                const empInfo = message.data?._employeeInfo;
                const msgId = message.data?.msgId;
                if (empInfo?.employee_id && msgId) {
                    db.setMessageHandledByEmployee(zaloId, String(msgId), empInfo.employee_id);
                }
                Logger.log(`[HttpClientService] Saved relay message to active DB (our workspace)`);
            }

            // Only send to renderer when THIS employee workspace is the active one.
            // When boss workspace is active, the boss's broadcastMessage.send() already
            // sent to renderer — sending again would cause double notification.
            const activeWsId = wm.getActiveWorkspaceId();
            if (activeWsId === this.workspaceId) {
                EventBroadcaster.sendDirect('event:message', { zaloId, message });
            }
        } catch (err: any) {
            Logger.warn(`[HttpClientService] saveRelayMessage error: ${err.message}`);
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(async () => {
            if (!this.connected) return;

            const start = Date.now();
            try {
                const callbackUrl = `http://${this.getLocalIP()}:${this.localPort}`;
                const result = await this.httpPost(
                    `${this.bossUrl}/api/auth/heartbeat`,
                    { callbackUrl },
                    { Authorization: `Bearer ${this.token}` },
                    10000
                );

                if (result.success) {
                    this.latencyMs = Date.now() - start;
                    this.onStatusChange?.(true, this.latencyMs);
                } else {
                    this.onStatusChange?.(false, 0);
                }
            } catch (err) {
                this.latencyMs = 0;
                this.onStatusChange?.(false, 0);
            }
        }, 15_000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // ─── HTTP helpers ─────────────────────────────────────────────────

    private httpPost(url: string, body: any, headers: Record<string, string> = {}, timeout = 15000): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const payload = JSON.stringify(body);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');

                const req = httpModule.request(
                    {
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
                    },
                    (res: http.IncomingMessage) => {
                        let data = '';
                        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        res.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            } catch {
                                resolve({ success: false, error: 'Invalid JSON response' });
                            }
                        });
                    }
                );

                req.on('error', (err: Error) => reject(err));
                req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
                req.write(payload);
                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    private httpGet(url: string, headers: Record<string, string> = {}, timeout = 15000): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');

                const req = httpModule.request(
                    {
                        hostname: urlObj.hostname,
                        port: urlObj.port,
                        path: urlObj.pathname + urlObj.search,
                        method: 'GET',
                        headers,
                        timeout,
                    },
                    (res: http.IncomingMessage) => {
                        let data = '';
                        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        res.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            } catch {
                                resolve({ success: false, error: 'Invalid JSON response' });
                            }
                        });
                    }
                );

                req.on('error', (err: Error) => reject(err));
                req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    private httpPostRaw(url: string, body: any, headers: Record<string, string> = {}, timeout = 60000): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const payload = JSON.stringify(body);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');

                const req = httpModule.request(
                    {
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
                    },
                    (res: http.IncomingMessage) => {
                        const contentType = res.headers['content-type'] || '';
                        if (contentType.includes('application/octet-stream')) {
                            const chunks: Buffer[] = [];
                            res.on('data', (chunk: Buffer) => chunks.push(chunk));
                            res.on('end', () => {
                                const buffer = Buffer.concat(chunks);
                                const fileName = (res.headers['content-disposition'] || '')
                                    .match(/filename="?([^"]+)"?/)?.[1] || 'file';
                                resolve({ success: true, data: buffer, fileName });
                            });
                        } else {
                            let data = '';
                            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)); } catch { resolve({ success: false, error: 'Invalid response' }); }
                            });
                        }
                    }
                );

                req.on('error', (err: Error) => reject(err));
                req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
                req.write(payload);
                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    private getLocalIP(): string {
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

export default HttpClientService;

