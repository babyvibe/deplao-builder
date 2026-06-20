import * as http from 'http';
import Logger from '../../utils/Logger';
import EventBroadcaster from '../event/EventBroadcaster';
import DataSyncService, { SyncPayload } from '../employee/DataSyncService';

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

    /** SSE connection to boss (replaces local server push model) */
    private sseReq: any = null;
    private sseConnected = false;
    private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** SSE reconnect attempt counter for exponential backoff (3s → 6s → 12s → 24s → 30s cap) */
    private sseReconnectAttempt = 0;
    private static SSE_MAX_RECONNECT_DELAY = 30_000;
    /** Track consecutive heartbeat failures to trigger SSE reconnect */
    private consecutiveHeartbeatFailures = 0;

    /** SSE watchdog — detect silent TCP drops that res.on('end') never fires for */
    private lastSseDataAt = 0;
    private sseWatchdogTimer: ReturnType<typeof setInterval> | null = null;
    private static SSE_WATCHDOG_INTERVAL = 30_000; // check every 30s
    private static SSE_STALE_THRESHOLD = 60_000;   // 60s without data = stale

    /** Track if SSE was previously connected (for reconnect vs first-connect detection) */
    private sseWasConnected = false;

    /** Dedicated HTTP agent for SSE connections (keep-alive, isolated from other requests) */
    private sseAgent: any = null;

    /** Last successful sync timestamp (for auto delta sync on reconnect) */
    private lastSyncTs = 0;

    /** CallbackUrl for LAN fallback push from boss */
    private callbackUrl = '';

    /** Max consecutive heartbeat failures before marking disconnected */
    private static MAX_HEARTBEAT_FAILURES = 5;

    private onStatusChange: ((connected: boolean, latency: number) => void) | null = null;
    private onInitialState: ((data: any) => void) | null = null;
    private onAccountAccessUpdate: ((data: any) => void) | null = null;
    private onSyncProgress: ((phase: string, percent: number) => void) | null = null;
    private onSSEReconnected: (() => void) | null = null;

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
        // ─── CRM / Settings real-time sync ────────────────────────────
        'db:localLabelChanged',
        'db:localLabelThreadChanged',
        'db:pinnedMessageChanged',
        'db:localQuickMessageChanged',
        'crm:campaignChanged',
        'crm:noteChanged',
        'db:pinnedConversationChanged',
        'db:contactFlagsChanged',
        'db:contactAliasChanged',
        'event:friendRequestSent',
        'event:friendRequestRemoved',
        'crm:queueUpdate',
        'crm:queueStatus',
        'crm:campaignDone',
        'workflow:executed',
        'integration:payment',
        'integration:webhook',
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
            // 1. Verify Boss is reachable via health check
            const health = await this.httpGet(`${this.bossUrl}/api/health`, {}, 8000).catch(() => null);
            if (!health?.status) {
                return { success: false, error: 'Không thể kết nối tới Boss. Kiểm tra địa chỉ và relay server đã bật chưa.' };
            }

            // 2. Start local HTTP server for LAN callback fallback (non-fatal if fails)
            this.callbackUrl = '';
            try {
                await this.startLocalServer();
                this.callbackUrl = `http://${this.getLocalIP()}:${this.localPort}`;
                Logger.log(`[HttpClientService] LAN callback server ready at ${this.callbackUrl}`);
            } catch {
                // WAN-only mode — local server not needed, SSE is the only channel
                Logger.log('[HttpClientService] Local server not available (WAN-only mode)');
            }

            // 3. Register with Boss via heartbeat (sends callbackUrl for LAN fallback)
            const hbResult = await this.httpPost(
                `${this.bossUrl}/api/auth/heartbeat`,
                { callbackUrl: this.callbackUrl },
                { Authorization: `Bearer ${token}` }
            );

            if (!hbResult.success) {
                this.stopLocalServer(); // Clean up local server before returning
                return { success: false, error: hbResult.error || 'Không thể kết nối tới Boss' };
            }

            this.connected = true;
            Logger.log('[HttpClientService] ✅ Connected to Boss');
            this.onStatusChange?.(true, 0);
            this.startHeartbeat();

            // 4. Start SSE connection for real-time event stream (primary method)
            this.connectSSE();

            // 5. Fetch initial snapshot (SSE will also push it, but fetch as early warmup)
            try {
                const snapshot = await this.httpGet(
                    `${this.bossUrl}/api/sync/snapshot`,
                    { Authorization: `Bearer ${token}` }
                );
                if (snapshot?.success && snapshot?.snapshot) {
                    this.onInitialState?.(snapshot.snapshot);
                }
            } catch (_) {
                // Non-critical — snapshot comes via SSE push
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
        this.disconnectSSE();
        this.stopSSEWatchdog();
        this.onStatusChange = null;
        this.onInitialState = null;
        this.onAccountAccessUpdate = null;
        this.onSyncProgress = null;
        this.onSSEReconnected = null;
        this.connected = false;
        this.callbackUrl = '';
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

    // ─── Media upload (Employee → Boss) ──────────────────────────────

    /**
     * Upload a media file from Employee to Boss storage.
     * Boss saves the file and returns its absolute path.
     */
    public async uploadMedia(base64: string, filename: string, zaloId?: string): Promise<{ success: boolean; bossPath?: string; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Not connected' };
        }

        try {
            return await this.httpPost(
                `${this.bossUrl}/api/media/upload`,
                { base64, filename, zaloId },
                { Authorization: `Bearer ${this.token}` },
                120000 // 2 phút cho ảnh lớn qua tunnel
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
    public setOnSSEReconnected(cb: () => void): void {
        this.onSSEReconnected = cb;
    }
    public setWorkspaceId(id: string): void {
        this.workspaceId = id;
    }
    public setLastSyncTs(ts: number): void {
        this.lastSyncTs = ts;
    }
    public getLastSyncTs(): number {
        return this.lastSyncTs;
    }

    // ─── Data Sync ────────────────────────────────────────────────────

    /** Request fresh account/employee snapshot from Boss (for SSE reconnect recovery) */
    public async requestSnapshot(): Promise<{ success: boolean; snapshot?: any; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Chưa kết nối tới BOSS' };
        }
        try {
            const result = await this.httpGet(
                `${this.bossUrl}/api/sync/snapshot`,
                { Authorization: `Bearer ${this.token}` },
                15000
            );
            if (!result?.success || !result?.snapshot) {
                return { success: false, error: result?.error || 'Snapshot failed' };
            }
            // Forward snapshot to renderer as initialState (refreshes account status)
            this.onInitialState?.(result.snapshot);
            Logger.log(`[HttpClientService] Snapshot refreshed: assigned=${result.snapshot.assignedAccounts?.length || 0}, online=${result.snapshot.onlineAccounts?.length || 0}`);
            return { success: true, snapshot: result.snapshot };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    public async requestFullSync(_zaloIds: string[]): Promise<{ success: boolean; payload?: SyncPayload; syncTs?: number; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Chưa kết nối tới BOSS' };
        }

        try {
            this.onSyncProgress?.('Đang yêu cầu dữ liệu...', 0);
            const result = await this.httpGet(
                `${this.bossUrl}/api/sync/full`,
                { Authorization: `Bearer ${this.token}` },
                600000
            );

            if (!result?.success) {
                // Log chi tiết lý do sync thất bại
                Logger.error(`[HttpClientService] Full sync failed: ${result?.error || 'unknown'}. Boss may have 100k+ messages - try increasing server timeout or reducing batch size.`);
                return { success: false, error: result?.error || 'Sync failed - dữ liệu quá lớn, vui lòng thử lại' };
            }

            this.onSyncProgress?.('Đang xử lý dữ liệu...', 50);
            return { success: true, payload: result.payload, syncTs: result.syncTs };
        } catch (err: any) {
            Logger.error(`[HttpClientService] Full sync exception: ${err.message}. Boss may have too many messages - consider paginated sync.`);
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
                600000
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

            // Track sync timestamp for auto delta sync on reconnect
            if (result.syncTs) {
                this.lastSyncTs = result.syncTs;
            }

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

            // Track sync timestamp for auto delta sync on reconnect
            if (result.syncTs) {
                this.lastSyncTs = result.syncTs;
            }

            this.onSyncProgress?.('Hoàn tất cập nhật!', 100);
            return { success: true, syncTs: result.syncTs };
        } catch (err: any) {
            Logger.error(`[HttpClientService] Delta sync error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    // ─── Local HTTP Server (legacy fallback — kept for backward compat) ──

    /** Local HTTP server for LAN callback fallback — boss can push events via POST when SSE is down. */
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

        // Employee sender info: update DB + forward to renderer for store merge
        if (channel === 'relay:messageSentByEmployee' && data?.zaloId && data?.employee_id) {
            try {
                const DatabaseService = require('../database/DatabaseService').default;
                const WorkspaceManager = require('../../utils/WorkspaceManager').default;
                const db = DatabaseService.getInstance();

                // Resolve target DB path for this workspace
                let targetDbPath: string | null = null;
                if (this.workspaceId) {
                    const ws = WorkspaceManager.getInstance().getWorkspaceById(this.workspaceId);
                    if (ws) targetDbPath = WorkspaceManager.getInstance().resolveDbPath(ws.dbPath || 'deplao-tool.db');
                }
                const activeDbPath = db.getDbPath();
                const msgId = String(data.msgId || '');
                const cliMsgId = String(data.cliMsgId || data.cli_msg_id || '');
                const threadId = String(data.threadId || data.thread_id || '');

                // Update DB (match by msg_id OR cli_msg_id when available)
                if (msgId || cliMsgId) {
                    const updateFn = () => {
                        if (msgId) db.setMessageHandledByEmployeeFlexible(data.zaloId, msgId, data.employee_id);
                        if (cliMsgId && cliMsgId !== msgId) db.setMessageHandledByEmployeeFlexible(data.zaloId, cliMsgId, data.employee_id);
                    };
                    if (targetDbPath && targetDbPath !== activeDbPath) {
                        db.withDbPath(targetDbPath, updateFn);
                    } else {
                        updateFn();
                    }
                } else if (threadId) {
                    // Thread-based fallback for attachment-only sends (image/file) where msgId is empty
                    const updateFn = () => {
                        try {
                            const rows = db.query(
                                `SELECT msg_id FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND is_sent = 1
                                 AND handled_by_employee IS NULL ORDER BY timestamp DESC LIMIT 1`,
                                [data.zaloId, threadId]
                            ) as any[];
                            if (rows?.[0]?.msg_id) {
                                db.setMessageHandledByEmployee(data.zaloId, String(rows[0].msg_id), data.employee_id);
                            }
                        } catch {}
                    };
                    if (targetDbPath && targetDbPath !== activeDbPath) {
                        db.withDbPath(targetDbPath, updateFn);
                    } else {
                        updateFn();
                    }
                }

                // Forward to renderer so useZaloEvents can update the store
                const activeWsId = WorkspaceManager.getInstance().getActiveWorkspaceId();
                if (activeWsId === this.workspaceId) {
                    EventBroadcaster.sendDirect(channel, data);
                }
                Logger.log(`[HttpClientService] relay:messageSentByEmployee DB update: msgId="${msgId}", threadId="${threadId}", empId="${data.employee_id}"`);
            } catch (err: any) {
                Logger.warn(`[HttpClientService] relay:messageSentByEmployee error: ${err.message}`);
            }
            return;
        }

        // Persist conversation-level events from Boss to employee's local DB
        // (labels, pins, quick messages, CRM, pinned conversations, contact settings)
        if (HttpClientService.FORWARD_CHANNELS.includes(channel)) {
            this.persistRelayConversationEvent(channel, data);
            // Only forward to renderer when this employee workspace is the active one.
            try {
                const WorkspaceManager = require('../../utils/WorkspaceManager').default;
                const activeWsId = WorkspaceManager.getInstance().getActiveWorkspaceId();
                if (activeWsId === this.workspaceId) {
                    EventBroadcaster.sendDirect(channel, data);
                } else {
                    Logger.log(`[HttpClientService] Skipping renderer forward for ${channel}: activeWs="${activeWsId}" !== ourWs="${this.workspaceId}"`);
                }
            } catch {
                EventBroadcaster.sendDirect(channel, data);
            }
        }
    }

    /**
     * Persist conversation-level relay events from Boss to the employee's local DB.
     * Without this, the renderer re-fetches from an empty local DB and sees nothing.
     */
    private persistRelayConversationEvent(channel: string, data: any): void {
        try {
            const DatabaseService = require('../database/DatabaseService').default;
            const WorkspaceManager = require('../../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();

            // Resolve workspace DB path
            let targetDbPath: string | null = null;
            if (this.workspaceId) {
                const ws = WorkspaceManager.getInstance().getWorkspaceById(this.workspaceId);
                if (ws) targetDbPath = WorkspaceManager.getInstance().resolveDbPath(ws.dbPath || 'deplao-tool.db');
            }
            const runOnWsDb = (fn: () => void) => {
                if (targetDbPath && targetDbPath !== db.getDbPath()) {
                    db.withDbPath(targetDbPath, fn);
                } else {
                    fn();
                }
            };

            // ── Labels ──
            if (channel === 'db:localLabelChanged' && data) {
                runOnWsDb(() => {
                    if (data.action === 'upsert' && data.label) {
                        db.upsertLocalLabel(data.label);
                    } else if (data.action === 'delete' && data.labelId != null) {
                        db.deleteLocalLabel(data.labelId);
                    } else if (data.action === 'active' && data.labelId != null) {
                        db.setLocalLabelActive(data.labelId, data.isActive);
                    } else if (data.action === 'reorder' && data.labelId != null) {
                        db.setLocalLabelOrder(data.labelId, data.order);
                    }
                });
                return;
            }

            // ── Label-Thread assignments ──
            if (channel === 'db:localLabelThreadChanged' && data) {
                runOnWsDb(() => {
                    if (data.action === 'assign' && data.ownerZaloId && data.labelId != null && data.threadId) {
                        db.assignLocalLabelToThread(data.ownerZaloId, data.labelId, data.threadId);
                    } else if (data.action === 'remove' && data.ownerZaloId && data.labelId != null && data.threadId) {
                        db.removeLocalLabelFromThread(data.ownerZaloId, data.labelId, data.threadId);
                    }
                });
                return;
            }

            // ── Pinned messages ──
            if (channel === 'db:pinnedMessageChanged' && data) {
                runOnWsDb(() => {
                    if (data.action === 'pin' && data.ownerZaloId && data.threadId && data.pin) {
                        db.pinMessage(data.ownerZaloId, data.threadId, data.pin);
                    } else if (data.action === 'unpin' && data.ownerZaloId && data.threadId && data.msgId) {
                        db.unpinMessage(data.ownerZaloId, data.threadId, data.msgId);
                    } else if (data.action === 'bringToTop' && data.ownerZaloId && data.threadId && data.msgId) {
                        db.bringPinnedToTop(data.ownerZaloId, data.threadId, data.msgId);
                    }
                });
                return;
            }

            // ── Quick messages ──
            if (channel === 'db:localQuickMessageChanged' && data) {
                runOnWsDb(() => {
                    if (data.action === 'upsert' && data.ownerZaloId && data.item) {
                        db.upsertLocalQuickMessage(data.ownerZaloId, data.item);
                    } else if (data.action === 'delete' && data.ownerZaloId && data.id != null) {
                        db.deleteLocalQuickMessage(data.ownerZaloId, data.id);
                    } else if (data.action === 'active' && data.id != null) {
                        db.setLocalQMActive(data.id, data.isActive);
                    } else if (data.action === 'reorder' && data.id != null) {
                        db.setLocalQMOrder(data.id, data.order);
                    }
                });
                return;
            }

            // ── CRM notes ──
            if (channel === 'crm:noteChanged' && data) {
                runOnWsDb(() => {
                    if (data.action === 'save' && data.note) {
                        db.saveCRMNote({ ...data.note, owner_zalo_id: data.ownerZaloId });
                    } else if (data.action === 'delete' && data.noteId != null) {
                        db.deleteCRMNote(data.noteId, data.ownerZaloId);
                    }
                });
                return;
            }

            // ── CRM campaigns ──
            if (channel === 'crm:campaignChanged' && data) {
                runOnWsDb(() => {
                    if (data.action === 'save' && data.campaign) {
                        db.saveCRMCampaign({ ...data.campaign, owner_zalo_id: data.ownerZaloId });
                    } else if (data.action === 'delete' && data.campaignId != null) {
                        db.deleteCRMCampaign(data.campaignId, data.ownerZaloId);
                    } else if (data.action === 'status' && data.campaignId != null) {
                        db.updateCRMCampaignStatus(data.campaignId, data.status);
                    }
                });
                return;
            }

            // ── Pinned conversations ──
            if (channel === 'db:pinnedConversationChanged' && data) {
                runOnWsDb(() => {
                    if (data.ownerZaloId && data.threadId) {
                        db.setLocalPinnedConversation(data.ownerZaloId, data.threadId, data.isPinned);
                    }
                });
                return;
            }

            // ── Contact flags ──
            if (channel === 'db:contactFlagsChanged' && data) {
                runOnWsDb(() => {
                    if (data.ownerZaloId && data.contactId && data.flags) {
                        db.setContactFlags(data.ownerZaloId, data.contactId, data.flags);
                    }
                });
                return;
            }

            // ── Contact alias ──
            if (channel === 'db:contactAliasChanged' && data) {
                runOnWsDb(() => {
                    if (data.ownerZaloId && data.contactId) {
                        db.setContactAlias(data.ownerZaloId, data.contactId, data.alias);
                    }
                });
                return;
            }
        } catch (err: any) {
            Logger.warn(`[HttpClientService] persistRelayConversationEvent error (${channel}): ${err.message}`);
        }
    }

    // ─── SSE client (receive events from Boss) ──────────────────────

    private connectSSE(): void {
        if (!this.connected) return;
        if (this.sseReq) {
            Logger.warn(`[HttpClientService] connectSSE() called while existing SSE request active — destroying old`);
            try { this.sseReq.destroy(); } catch {}
            this.sseReq = null;
        } else {
            Logger.log(`[HttpClientService] connectSSE() called (attempt=${this.sseReconnectAttempt})`);
        }
        if (this.sseReconnectTimer) {
            try { this.sseReq.destroy(); } catch {}
            this.sseReq = null;
        }
        if (this.sseReconnectTimer) {
            clearTimeout(this.sseReconnectTimer);
            this.sseReconnectTimer = null;
        }

        try {
            const urlObj = new URL('/api/events/stream', this.bossUrl);
            const isHttps = urlObj.protocol === 'https:';
            const httpModule = isHttps ? require('https') : require('http');

            // Dedicated agent with keepAlive to prevent socket reuse with other requests
            if (!this.sseAgent) {
                const AgentClass = isHttps ? httpModule.Agent : httpModule.Agent;
                this.sseAgent = new AgentClass({ keepAlive: true, keepAliveMsecs: 30000 });
            }

            const req = httpModule.request(
                {
                    hostname: urlObj.hostname,
                    port: urlObj.port || (isHttps ? 443 : 80),
                    path: urlObj.pathname,
                    method: 'GET',
                    agent: this.sseAgent,
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        Accept: 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                        ...this.getTunnelBypassHeaders(),
                    },
                },
                (res: any) => {
                    if (res.statusCode !== 200) {
                        Logger.warn(`[HttpClientService] SSE connect failed: HTTP ${res.statusCode}`);
                        res.resume();
                        this.sseConnected = false;
                        // Schedule reconnect (non-200 was a dead end before)
                        if (this.connected) {
                            const delay = Math.min(
                                5000 * Math.pow(2, this.sseReconnectAttempt),
                                HttpClientService.SSE_MAX_RECONNECT_DELAY
                            );
                            this.sseReconnectAttempt++;
                            Logger.log(`[HttpClientService] SSE reconnect in ${delay}ms (attempt ${this.sseReconnectAttempt})`);
                            this.sseReconnectTimer = setTimeout(() => this.connectSSE(), delay);
                        }
                        return;
                    }

                    this.sseConnected = true;
                    this.sseReconnectAttempt = 0; // Reset backoff on successful connection
                    this.lastSseDataAt = Date.now();
                    this.startSSEWatchdog();
                    Logger.log('[HttpClientService] 📡 SSE stream connected');

                    // Fire reconnect callback (not on first connect, only on reconnect)
                    if (this.sseWasConnected) {
                        Logger.log('[HttpClientService] 🔄 SSE reconnected — notifying for delta sync');
                        try { this.onSSEReconnected?.(); } catch {}
                    }
                    this.sseWasConnected = true;

                    let buffer = '';
                    let eventData = '';

                    res.on('data', (chunk: Buffer) => {
                        this.lastSseDataAt = Date.now(); // Watchdog: mark SSE alive
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || ''; // keep incomplete line

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                eventData += line.slice(6);
                            } else if (line === '' && eventData) {
                                // Empty line = end of SSE event
                                try {
                                    const { channel, data } = JSON.parse(eventData);
                                    this.handlePushedEvent(channel, data);
                                } catch { /* ignore malformed events */ }
                                eventData = '';
                            }
                            // Lines starting with ':' are comments/keepalive — also mark alive
                            else if (line.startsWith(':')) {
                                this.lastSseDataAt = Date.now();
                            }
                        }
                    });

                    res.on('end', () => {
                        const aliveMs = this.lastSseDataAt > 0 ? Date.now() - this.lastSseDataAt : -1;
                        this.sseConnected = false;
                        this.sseReq = null;
                        this.stopSSEWatchdog();
                        Logger.warn(`[HttpClientService] SSE stream ended (alive=${aliveMs}ms, attempt=${this.sseReconnectAttempt})`);
                        if (this.connected) {
                            const delay = Math.min(
                                3000 * Math.pow(2, this.sseReconnectAttempt),
                                HttpClientService.SSE_MAX_RECONNECT_DELAY
                            );
                            this.sseReconnectAttempt++;
                            this.sseReconnectTimer = setTimeout(() => this.connectSSE(), delay);
                        }
                    });

                    res.on('error', (err: Error) => {
                        this.sseConnected = false;
                        this.sseReq = null;
                        this.stopSSEWatchdog();
                        Logger.warn(`[HttpClientService] SSE stream error: ${err.message}`);
                        if (this.connected) {
                            const delay = Math.min(
                                5000 * Math.pow(2, this.sseReconnectAttempt),
                                HttpClientService.SSE_MAX_RECONNECT_DELAY
                            );
                            this.sseReconnectAttempt++;
                            this.sseReconnectTimer = setTimeout(() => this.connectSSE(), delay);
                        }
                    });
                }
            );

            req.on('error', (err: Error) => {
                this.sseConnected = false;
                this.sseReq = null;
                this.stopSSEWatchdog();
                Logger.warn(`[HttpClientService] SSE request error: ${err.message}`);
                if (this.connected) {
                    const delay = Math.min(
                        5000 * Math.pow(2, this.sseReconnectAttempt),
                        HttpClientService.SSE_MAX_RECONNECT_DELAY
                    );
                    this.sseReconnectAttempt++;
                    this.sseReconnectTimer = setTimeout(() => this.connectSSE(), delay);
                }
            });

            req.end();
            this.sseReq = req;
        } catch (err: any) {
            Logger.error(`[HttpClientService] SSE connect error: ${err.message}`);
            if (this.connected) {
                const delay = Math.min(
                    5000 * Math.pow(2, this.sseReconnectAttempt),
                    HttpClientService.SSE_MAX_RECONNECT_DELAY
                );
                this.sseReconnectAttempt++;
                this.sseReconnectTimer = setTimeout(() => this.connectSSE(), delay);
            }
        }
    }

    private disconnectSSE(): void {
        if (this.sseReconnectTimer) {
            clearTimeout(this.sseReconnectTimer);
            this.sseReconnectTimer = null;
        }
        this.stopSSEWatchdog();
        if (this.sseReq) {
            try { this.sseReq.destroy(); } catch {}
            this.sseReq = null;
        }
        if (this.sseAgent) {
            try { this.sseAgent.destroy(); } catch {}
            this.sseAgent = null;
        }
        this.sseConnected = false;
        this.sseWasConnected = false;
        this.sseReconnectAttempt = 0;
    }

    // ─── SSE Watchdog ────────────────────────────────────────────────

    /**
     * Start SSE watchdog that detects silent TCP drops.
     * If no SSE data received for 60s, forces reconnect.
     * Catches scenarios where res.on('end') never fires (common with tunnels).
     */
    private startSSEWatchdog(): void {
        this.stopSSEWatchdog();
        this.sseWatchdogTimer = setInterval(() => {
            if (!this.sseConnected || !this.connected) return;
            if (this.lastSseDataAt > 0 && Date.now() - this.lastSseDataAt > HttpClientService.SSE_STALE_THRESHOLD) {
                Logger.warn(`[HttpClientService] ⏰ SSE watchdog: no data for ${Math.round((Date.now() - this.lastSseDataAt) / 1000)}s — forcing reconnect`);
                this.sseConnected = false;
                if (this.sseReq) {
                    try { this.sseReq.destroy(); } catch {}
                    this.sseReq = null;
                }
                // Force immediate reconnect
                this.sseReconnectAttempt = 0;
                this.connectSSE();
            }
        }, HttpClientService.SSE_WATCHDOG_INTERVAL);
    }

    private stopSSEWatchdog(): void {
        if (this.sseWatchdogTimer) {
            clearInterval(this.sseWatchdogTimer);
            this.sseWatchdogTimer = null;
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
            const DatabaseService = require('../database/DatabaseService').default;
            const WorkspaceManager = require('../../utils/WorkspaceManager').default;
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
            const DatabaseService = require('../database/DatabaseService').default;
            const WorkspaceManager = require('../../utils/WorkspaceManager').default;
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
            const DatabaseService = require('../database/DatabaseService').default;
            const WorkspaceManager = require('../../utils/WorkspaceManager').default;
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
                        db.setMessageHandledByEmployeeFlexible(zaloId, String(msgId), empInfo.employee_id);
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
                    db.setMessageHandledByEmployeeFlexible(zaloId, String(msgId), empInfo.employee_id);
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
        this.consecutiveHeartbeatFailures = 0;
        this.heartbeatTimer = setInterval(async () => {
            if (!this.connected) return;

            const start = Date.now();
            try {
                // Send callbackUrl for LAN fallback — boss can push via HTTP POST if SSE is down
                const result = await this.httpPost(
                    `${this.bossUrl}/api/auth/heartbeat`,
                    { callbackUrl: this.callbackUrl },
                    { Authorization: `Bearer ${this.token}` },
                    10000
                );

                if (result.success) {
                    this.latencyMs = Date.now() - start;
                    this.consecutiveHeartbeatFailures = 0;
                    this.onStatusChange?.(true, this.latencyMs);
                } else {
                    this.consecutiveHeartbeatFailures++;
                    this.onStatusChange?.(false, 0);
                    // After 2 consecutive failures, force SSE reconnect if stream is down
                    if (this.consecutiveHeartbeatFailures >= 2 && !this.sseConnected) {
                        Logger.log(`[HttpClientService] ${this.consecutiveHeartbeatFailures} heartbeat failures, forcing SSE reconnect`);
                        this.sseReconnectAttempt = 0; // Reset backoff for fresh reconnect attempt
                        this.connectSSE();
                    }
                    // After MAX failures, mark as disconnected so health check can trigger full reconnect
                    if (this.consecutiveHeartbeatFailures >= HttpClientService.MAX_HEARTBEAT_FAILURES) {
                        Logger.warn(`[HttpClientService] ${this.consecutiveHeartbeatFailures} consecutive heartbeat failures — marking disconnected`);
                        this.connected = false;
                        this.onStatusChange?.(false, 0);
                    }
                }
            } catch (err) {
                this.latencyMs = 0;
                this.consecutiveHeartbeatFailures++;
                this.onStatusChange?.(false, 0);
                // After 2 consecutive failures, force SSE reconnect if stream is down
                if (this.consecutiveHeartbeatFailures >= 2 && !this.sseConnected) {
                    Logger.log(`[HttpClientService] ${this.consecutiveHeartbeatFailures} heartbeat failures (error), forcing SSE reconnect`);
                    this.sseReconnectAttempt = 0;
                    this.connectSSE();
                }
                // After MAX failures, mark as disconnected so health check can trigger full reconnect
                if (this.consecutiveHeartbeatFailures >= HttpClientService.MAX_HEARTBEAT_FAILURES) {
                    Logger.warn(`[HttpClientService] ${this.consecutiveHeartbeatFailures} consecutive heartbeat failures (error) — marking disconnected`);
                    this.connected = false;
                    this.onStatusChange?.(false, 0);
                }
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

    /**
     * Returns extra headers needed to bypass localtunnel / loca.lt interstitial pages.
     * loca.lt shows an HTML "Visitor Pass" page for programmatic requests unless the
     * bypass header is present.
     */
    private getTunnelBypassHeaders(): Record<string, string> {
        try {
            const hostname = new URL(this.bossUrl).hostname;
            // loca.lt, localtunnel.me, or any custom tunnel subdomain
            if (hostname.endsWith('.loca.lt') || hostname.endsWith('.localtunnel.me')) {
                return { 'bypass-tunnel-reminder': 'true' };
            }
        } catch { /* ignore */ }
        return {};
    }

    /**
     * Parses a raw HTTP response body as JSON.
     * If the body is an HTML page (e.g., loca.lt interstitial) a descriptive error is returned.
     */
    private parseJsonResponse(data: string): any {
        const trimmed = data.trimStart();
        if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
            // HTML interstitial — likely a tunnel challenge page
            Logger.warn('[HttpClientService] Received HTML response instead of JSON (tunnel interstitial?)');
            return {
                success: false,
                error: 'URL tunnel cần xác nhận trình duyệt. Vui lòng mở địa chỉ Boss trong trình duyệt một lần để kích hoạt, sau đó thử lại.',
            };
        }
        try {
            return JSON.parse(data);
        } catch {
            return { success: false, error: 'Invalid JSON response' };
        }
    }

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
                            ...this.getTunnelBypassHeaders(),
                            ...headers,
                        },
                        timeout,
                    },
                    (res: http.IncomingMessage) => {
                        let data = '';
                        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        res.on('end', () => resolve(this.parseJsonResponse(data)));
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
                        headers: {
                            ...this.getTunnelBypassHeaders(),
                            ...headers,
                        },
                        timeout,
                    },
                    (res: http.IncomingMessage) => {
                        let data = '';
                        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        res.on('end', () => resolve(this.parseJsonResponse(data)));
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
                            ...this.getTunnelBypassHeaders(),
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
                            res.on('end', () => resolve(this.parseJsonResponse(data)));
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

