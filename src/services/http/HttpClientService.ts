import * as http from 'http';
import Logger from '../../utils/Logger';
import { BOSS_URL_CHANGED_EVENT } from '../../shared/tunnelAddress';
import { zaloReactionIconToEmoji } from '../../shared/zaloReactions';
import { applyBossUrlAnnouncement } from '../tunnel/BossUrlAnnouncement';
import EventBroadcaster from '../event/EventBroadcaster';
import SocketIOClient, { type SocketStatusInfo } from '../socket/SocketIOClient';
import { EMPLOYEE_FORWARD_CHANNELS } from '../socket/relayChannels';
import {
    AUTH_EXPIRED_MESSAGE,
    heartbeatResyncReason,
    socketResyncNeeded,
    type EmployeeResyncReason,
} from '../../shared/employeeConnection';

/** Thông tin kèm theo khi trạng thái kết nối đổi (main → HttpConnectionManager → renderer). */
export interface ServiceStatusInfo {
    /** Boss từ chối token (heartbeat 401 / Socket.IO auth) → đã dừng heartbeat + socket, cần đăng nhập lại. */
    authExpired?: boolean;
    /** Bị Boss ngắt (relay:kicked) → đã disconnect, không tự kết nối lại. */
    kicked?: boolean;
    reason?: string;
}

export interface ConnectResult {
    success: boolean;
    error?: string;
    /** Boss trả 401 lúc đăng ký → token hết hạn / sai, thử lại vô ích. */
    authExpired?: boolean;
    /** disconnect() được gọi trong lúc đang kết nối. */
    cancelled?: boolean;
}

export interface SnapshotMeta {
    /** Renderer phải áp dụng ngay (bỏ qua throttle 60 s của workspace:initialState). */
    forced?: boolean;
    reason?: string;
}

export type WakeKind = 'resume' | 'unlock-screen' | 'network-online';

/**
 * HttpClientService - Employee side only.
 * Replaces SocketClientService.
 *
 * - Runs a lightweight HTTP server to receive pushed events from Boss
 * - Sends proxy actions to Boss via HTTP POST
 * - Heartbeat every 15s to keep registration alive (tự hồi phục: vẫn chạy khi đang mất kết nối)
 * - Phát hiện token hết hạn (heartbeat 401 x2 / Socket.IO auth) → dừng, báo authExpired
 * - Báo onResync khi Socket.IO / heartbeat hồi phục sau khoảng mất > 10 s, sau khi máy ngủ dậy, hoặc khi catch-up
 *   Socket.IO không phát lại được phần đã lỡ (Boss khởi động lại / buffer không đủ / Boss bản cũ)
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

    private consecutiveHeartbeatFailures = 0;
    private static MAX_HEARTBEAT_FAILURES = 5;
    private static HEARTBEAT_INTERVAL_MS = 15_000;
    /** 401 liên tiếp trước khi kết luận token hết hạn (1 lần lẻ có thể do Boss đang khởi động lại). */
    private static AUTH_FAILURES_BEFORE_EXPIRED = 2;
    private callbackUrl = '';

    /** Tăng mỗi lần connect()/disconnect() → bỏ qua kết quả của lần kết nối / heartbeat cũ. */
    private generation = 0;
    private heartbeatInFlight = false;
    private consecutiveAuthFailures = 0;
    private authExpired = false;
    /** Thời điểm bắt đầu chuỗi heartbeat lỗi hiện tại (0 = đang khoẻ). */
    private firstHeartbeatFailureAt = 0;
    /** Máy vừa ngủ dậy → resync ngay khi heartbeat kế tiếp thành công. */
    private pendingWakeResync = false;
    private lastSocketConnected: boolean | null = null;

    private onStatusChange: ((connected: boolean, latency: number, info?: ServiceStatusInfo) => void) | null = null;
    private onInitialState: ((data: any, meta?: SnapshotMeta) => void) | null = null;
    private onAccountAccessUpdate: ((data: any) => void) | null = null;
    private onPermissionUpdate: ((data: any) => void) | null = null;
    private onResync: ((reason: EmployeeResyncReason, gapMs: number) => void) | null = null;

    /** Socket.IO client - transport duy nhất cho real-time event */
    private socketIOClient = new SocketIOClient();

    /**
     * Channels to forward to local EventBroadcaster — CÙNG danh sách Boss relay (relayChannels.ts). Trước đây là danh
     * sách riêng: Boss relay db:unreadChanged, db:conversationDeleted, db:contactProfileUpdated, library:*,
     * erp:event:employeeProfileDeleted… nhưng nhân viên bỏ qua → không bao giờ tới renderer.
     */
    private static FORWARD_CHANNELS: ReadonlySet<string> = EMPLOYEE_FORWARD_CHANNELS;

    public static getInstance(): HttpClientService {
        if (!HttpClientService.instance) {
            HttpClientService.instance = new HttpClientService();
        }
        return HttpClientService.instance;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────

    public async connect(bossUrl: string, token: string): Promise<ConnectResult> {
        if (this.connected) {
            this.disconnect();
        }

        const gen = ++this.generation;
        const cancelled: ConnectResult = { success: false, error: 'Đã huỷ kết nối', cancelled: true };
        this.token = token;
        this.authExpired = false;
        this.consecutiveAuthFailures = 0;
        this.consecutiveHeartbeatFailures = 0;
        this.firstHeartbeatFailureAt = 0;
        this.pendingWakeResync = false;
        this.lastSocketConnected = null;

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
            if (gen !== this.generation) return cancelled;
            if (!health?.status) {
                return { success: false, error: 'Không thể kết nối tới Boss. Kiểm tra địa chỉ và relay server đã bật chưa.' };
            }

            // 2. Start local HTTP server for LAN callback fallback (non-fatal if fails)
            this.callbackUrl = '';
            try {
                await this.startLocalServer();
                if (gen !== this.generation) return cancelled;
                this.callbackUrl = `http://${this.getLocalIP()}:${this.localPort}`;
                Logger.log(`[HttpClientService] LAN callback server ready at ${this.callbackUrl}`);
            } catch {
                if (gen !== this.generation) return cancelled;
                // WAN-only mode - local server not needed, SSE is the only channel
                Logger.log('[HttpClientService] Local server not available (WAN-only mode)');
            }

            // 3. Register with Boss via heartbeat (sends callbackUrl for LAN fallback)
            const hbResult = await this.httpPost(
                `${this.bossUrl}/api/auth/heartbeat`,
                { callbackUrl: this.callbackUrl },
                { Authorization: `Bearer ${token}` }
            );
            if (gen !== this.generation) return cancelled;

            if (!hbResult.success) {
                this.stopLocalServer(); // Clean up local server before returning
                if (this.isAuthFailure(hbResult)) {
                    this.authExpired = true;
                    Logger.warn('[HttpClientService] Boss từ chối token (HTTP 401) — phiên đăng nhập hết hạn');
                    return { success: false, error: AUTH_EXPIRED_MESSAGE, authExpired: true };
                }
                return { success: false, error: hbResult.error || 'Không thể kết nối tới Boss' };
            }

            this.connected = true;
            Logger.log('[HttpClientService] ✅ Connected to Boss');
            this.onStatusChange?.(true, 0);
            this.startHeartbeat();

            // 4. Start Socket.IO for real-time event delivery (primary transport)
            this.socketIOClient.setWorkspaceId(this.workspaceId);
            this.socketIOClient.setOnEvent((channel, eventData) => {
                this.handlePushedEvent(channel, eventData);
            });
            this.socketIOClient.setOnStatusChange((sioConnected, info) => this.handleSocketStatus(gen, sioConnected, info));
            this.socketIOClient.setOnAuthRejected((message) => {
                if (gen === this.generation) this.handleAuthExpired('Socket.IO', message);
            });
            // Catch-up không phát lại được phần đã lỡ (Boss khởi động lại / buffer không đủ / Boss cũ) → employee:resync
            this.socketIOClient.setOnResync((reason, gapMs) => {
                if (gen === this.generation) this.onResync?.(reason, gapMs);
            });
            // ts (giờ Boss) của heartbeat đăng ký: lần nối đầu chỉ xin phát lại event từ thời điểm này
            this.socketIOClient.connect(this.bossUrl, this.token, {
                sinceTs: typeof hbResult?.ts === 'number' ? hbResult.ts : undefined,
            });

            // 5. Fetch initial snapshot
            try {
                const snapshot = await this.httpGet(
                    `${this.bossUrl}/api/sync/snapshot`,
                    { Authorization: `Bearer ${token}` }
                );
                if (gen !== this.generation) return cancelled;
                if (snapshot?.success && snapshot?.snapshot) {
                    this.onInitialState?.(snapshot.snapshot);
                }
            } catch (_) {
                // Non-critical - snapshot comes via SSE push
            }

            return { success: true };
        } catch (err: any) {
            if (gen !== this.generation) return cancelled;
            Logger.error(`[HttpClientService] Connect error: ${err.message}`);
            this.stopLocalServer();
            return { success: false, error: err.message };
        }
    }

    public disconnect(): void {
        this.generation++;
        this.stopHeartbeat();
        this.heartbeatInFlight = false;
        this.stopLocalServer();
        this.socketIOClient.disconnect();
        this.onStatusChange = null;
        this.onInitialState = null;
        this.onAccountAccessUpdate = null;
        this.onPermissionUpdate = null;
        this.onResync = null;
        this.connected = false;
        this.callbackUrl = '';
        this.pendingWakeResync = false;
        Logger.log('[HttpClientService] Disconnected');
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public getStatus(): { connected: boolean; bossUrl: string; latency: number; authExpired: boolean } {
        return { connected: this.connected, bossUrl: this.bossUrl, latency: this.latencyMs, authExpired: this.authExpired };
    }

    // ─── Wake / health (gọi từ HttpConnectionManager) ─────────────────

    /**
     * Máy ngủ dậy / mở khoá / mạng có lại: heartbeat ngay thay vì chờ chu kỳ 15 s.
     * resume: luôn mở lại Socket.IO (socket cũ có thể đã chết mà chưa biết) và resync khi heartbeat OK.
     */
    public handleWake(kind: WakeKind): void {
        if (!this.heartbeatTimer || this.authExpired) return; // chưa chạy / đã dừng
        if (kind === 'resume') {
            this.pendingWakeResync = true;
            this.socketIOClient.reconnectNow('máy vừa ngủ dậy');
        } else if (!this.socketIOClient.isConnected()) {
            this.socketIOClient.reconnectNow(kind);
        }
        void this.runHeartbeat();
    }

    /** Lưới an toàn (health check 60 s): heartbeat OK mà Socket.IO đã bỏ cuộc → mở lại. */
    public ensureRealtime(): void {
        if (!this.connected || this.authExpired || !this.heartbeatTimer) return;
        if (this.socketIOClient.isConnected() || this.socketIOClient.isRecovering()) return;
        Logger.warn(`[HttpClientService] Socket.IO không chạy trong khi heartbeat OK (workspace=${this.workspaceId}) — kết nối lại`);
        this.socketIOClient.reconnectNow('health check');
    }

    private handleSocketStatus(gen: number, sioConnected: boolean, info?: SocketStatusInfo): void {
        if (gen !== this.generation) return;
        if (this.lastSocketConnected !== sioConnected) {
            this.lastSocketConnected = sioConnected;
            Logger.log(`[HttpClientService] Socket.IO ${sioConnected ? '🟢' : '🔴'} (workspace=${this.workspaceId}${info?.reason ? `, ${info.reason}` : ''})`);
        }
        if (sioConnected && socketResyncNeeded(info?.gapMs)) {
            this.onResync?.('socket-reconnect', info!.gapMs!);
        }
    }

    /** Token bị Boss từ chối → dừng heartbeat + socket (thử lại vô ích), báo authExpired. */
    private handleAuthExpired(source: string, message: string): void {
        if (this.authExpired) return;
        this.authExpired = true;
        this.connected = false;
        this.latencyMs = 0;
        this.pendingWakeResync = false;
        this.stopHeartbeat();
        this.socketIOClient.stop();
        Logger.warn(`[HttpClientService] Phiên đăng nhập hết hạn (${source}: ${message}) — dừng heartbeat + Socket.IO, chờ đăng nhập lại (workspace=${this.workspaceId})`);
        this.onStatusChange?.(false, 0, { authExpired: true, reason: message });
    }

    /** Heartbeat / đăng ký trả 401 (Boss: authenticateRequest() = null). */
    private isAuthFailure(result: any): boolean {
        if (!result || result.success) return false;
        if (result.__httpStatus === 401) return true;
        return /^unauthori[sz]ed$/i.test(String(result.error || '').trim());
    }

    // ─── Proxy actions through Boss ──────────────────────────────────

    public async proxyAction(channel: string, params: any, timeoutMs = 30000): Promise<any> {
        if (!this.connected) {
            throw new Error('Chưa kết nối tới BOSS');
        }

        return this.httpPost(
            `${this.bossUrl}/api/proxy/action`,
            { channel, params },
            { Authorization: `Bearer ${this.token}` },
            timeoutMs > 0 ? timeoutMs : 30000
        );
    }

    // ─── Media upload (Employee → Boss) ──────────────────────────────

    /**
     * Upload a media file from Employee to Boss storage.
     * Boss saves the file and returns its absolute path.
     */
    public async uploadMedia(buffer: Buffer, filename: string, zaloId?: string): Promise<{ success: boolean; bossPath?: string; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Not connected' };
        }

        try {
            return await this.httpPostBinary(
                `${this.bossUrl}/api/media/upload`,
                buffer,
                {
                    'Authorization': `Bearer ${this.token}`,
                    'X-Filename': encodeURIComponent(filename),
                    ...(zaloId ? { 'X-Zalo-Id': zaloId } : {}),
                },
                120000
            );
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    // ─── Callbacks ────────────────────────────────────────────────────

    public setOnStatusChange(cb: (connected: boolean, latency: number, info?: ServiceStatusInfo) => void): void {
        this.onStatusChange = cb;
    }
    public setOnInitialState(cb: (data: any, meta?: SnapshotMeta) => void): void {
        this.onInitialState = cb;
    }
    public setOnAccountAccessUpdate(cb: (data: any) => void): void {
        this.onAccountAccessUpdate = cb;
    }
    public setOnPermissionUpdate(cb: (data: any) => void): void {
        this.onPermissionUpdate = cb;
    }
    /** Kết nối vừa hồi phục sau khoảng mất > RESYNC_GAP_MS, máy ngủ dậy, hoặc catch-up không đủ → renderer tải lại dữ liệu. */
    public setOnResync(cb: (reason: EmployeeResyncReason, gapMs: number) => void): void {
        this.onResync = cb;
    }
    public setWorkspaceId(id: string): void {
        this.workspaceId = id;
    }

    // ─── Snapshot ─────────────────────────────────────────────────────

    /** Request fresh account/employee snapshot from Boss (reconnect recovery / 403 ACCOUNT_FORBIDDEN) */
    public async requestSnapshot(meta?: SnapshotMeta): Promise<{ success: boolean; snapshot?: any; error?: string }> {
        if (!this.connected) {
            return { success: false, error: 'Chưa kết nối tới BOSS' };
        }
        const gen = this.generation;
        try {
            const result = await this.httpGet(
                `${this.bossUrl}/api/sync/snapshot`,
                { Authorization: `Bearer ${this.token}` },
                15000
            );
            if (gen !== this.generation) {
                return { success: false, error: 'Đã huỷ kết nối' };
            }
            if (!result?.success || !result?.snapshot) {
                return { success: false, error: result?.error || 'Snapshot failed' };
            }
            // Forward snapshot to renderer as initialState (refreshes account status)
            this.onInitialState?.(result.snapshot, meta);
            Logger.log(`[HttpClientService] Snapshot refreshed: assigned=${result.snapshot.assignedAccounts?.length || 0}, online=${result.snapshot.onlineAccounts?.length || 0}`);
            return { success: true, snapshot: result.snapshot };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    // ─── Local HTTP Server (legacy fallback - kept for backward compat) ──

    /** Local HTTP server for LAN callback fallback - boss can push events via POST when SSE is down. */
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
        if (channel === 'relay:permissionUpdate') {
            Logger.log(`[HttpClientService] Permission update received: erpRole=${data?.erpRole || 'none'}`);
            this.onPermissionUpdate?.(data);
            return;
        }
        if (channel === 'relay:accountAccessUpdate') {
            Logger.log(`[HttpClientService] Account access updated: assigned=${data?.assignedAccounts?.length || 0}`);
            this.onAccountAccessUpdate?.(data);
            return;
        }
        if (channel === 'relay:kicked') {
            Logger.log(`[HttpClientService] Kicked by boss: ${data?.reason}`);
            // disconnect() xoá callback → giữ lại trước để còn báo được cho manager/renderer
            const notify = this.onStatusChange;
            this.disconnect();
            notify?.(false, 0, { kicked: true, reason: data?.reason || 'Bị ngắt kết nối bởi quản lý' });
            return;
        }

        // Boss báo địa chỉ (tunnel) đổi: tự chuyển nếu địa chỉ đang lưu đúng là địa chỉ cũ, luôn báo renderer
        if (channel === BOSS_URL_CHANGED_EVENT) {
            applyBossUrlAnnouncement(this.workspaceId, data);
            return;
        }

        // Forward Zalo events to local EventBroadcaster
        // Use sendDirect to bypass onBeforeSend hooks - prevents infinite relay loop
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

        // Persist undo/recall to employee DB - boss uses runOnBossDb, so employee DB
        // must be updated separately on the employee side.
        if (channel === 'event:undo' && data?.zaloId && data?.msgId) {
            this.saveRelayRecallToWorkspaceDb('event:undo', data, data.zaloId, [String(data.msgId)], data.threadId);
            return;
        }

        // "Xoá khỏi app" ở Boss / nhân viên khác (scope 'app'): xoá hẳn khỏi DB nhân viên, chuyển nguyên event cho renderer
        // (nhánh dưới đổi 1 tin thành event:undo → hiện "đã thu hồi", sai với xoá khỏi app).
        if (channel === 'event:delete' && data?.scope === 'app' && data?.zaloId && Array.isArray(data?.msgIds) && data.msgIds.length) {
            this.saveRelayAppDeleteToWorkspaceDb(String(data.zaloId), data.msgIds.map(String), data);
            return;
        }

        // Persist delete (chat.delete) to employee DB - same as undo, mark as recalled.
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
                EventBroadcaster.sendDirect(channel, data);
                Logger.log(`[HttpClientService] relay:messageSentByEmployee DB update: msgId="${msgId}", threadId="${threadId}", empId="${data.employee_id}"`);
            } catch (err: any) {
                Logger.warn(`[HttpClientService] relay:messageSentByEmployee error: ${err.message}`);
            }
            return;
        }

        // ── Contact alias - persist + forward to employee renderer ──
        if (channel === 'db:contactAliasChanged' && data) {
            try {
                const DatabaseService = require('../database/DatabaseService').default;
                const WorkspaceManager = require('../../utils/WorkspaceManager').default;
                const db = DatabaseService.getInstance();

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
                runOnWsDb(() => {
                    if (data.ownerZaloId && data.contactId) {
                        db.setContactAlias(data.ownerZaloId, data.contactId, data.alias);
                    }
                });

                // Forward to renderer always (worker-specific data already saved to correct DB via withDbPath)
                EventBroadcaster.sendDirect(channel, data);
            } catch (err: any) {
                Logger.warn(`[HttpClientService] contactAliasChanged error: ${err.message}`);
            }
            return;
        }

        // Persist conversation-level events from Boss to employee's local DB
        // (labels, pins, quick messages, CRM, pinned conversations, contact settings).
        // UI nhân viên đọc dữ liệu qua REST (DataAccessor) — DB cục bộ chỉ là bản đệm; kênh mới (Telegram sửa / xoá
        // tin, Facebook, thư viện, đánh dấu…) chỉ cần chuyển tiếp, renderer cập nhật store từ payload.
        // Gửi renderer kể cả khi workspace này đang chạy nền (store theo zaloId, không lẫn tài khoản).
        if (HttpClientService.FORWARD_CHANNELS.has(channel)) {
            this.persistRelayConversationEvent(channel, data);
            // Forward to renderer always. Data was persisted to correct DB via withDbPath above.
            EventBroadcaster.sendDirect(channel, data);
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
                // Lệnh REST của nhân viên phát { zaloId, … }, IPC của Boss phát { ownerZaloId, … }
                const ownerZaloId = data.ownerZaloId || data.zaloId;
                runOnWsDb(() => {
                    if (ownerZaloId && data.contactId && data.flags) {
                        db.setContactFlags(ownerZaloId, data.contactId, data.flags);
                    }
                });
                return;
            }

            // ── Event: local path (image/video download complete on boss) ──
            // Persist the boss-downloaded local_paths to the employee DB so
            // conversations survive reload and the employee can load the media
            // via boss REST API (toLocalMediaUrl → boss /api/media/...).
            // NOTE: no `return` here — the event is also forwarded to renderer
            // below so the store gets the local_paths update immediately.
            if (channel === 'event:localPath' && data?.zaloId && data?.msgId && data?.localPaths) {
                runOnWsDb(() => {
                    try {
                        db.updateLocalPaths(data.zaloId, String(data.msgId), data.localPaths);
                        Logger.log(`[HttpClientService] Persisted event:localPath for msg ${data.msgId}`);
                    } catch { /* best-effort */ }
                });
                // Don't return — fall through to forward to renderer
            }
        } catch (err: any) {
            Logger.warn(`[HttpClientService] persistRelayConversationEvent error (${channel}): ${err.message}`);
        }
    }

    // ─── Socket.IO client — thay thế toàn bộ SSE ────────────────
    // HttpClientService dùng SocketIOClient cho real-time event.
    // SSE đã được xoá. Xem src/services/socket/SocketIOClient.ts


    // ─── Heartbeat ────────────────────────────────────────────────────

    /**
     * Save a relayed reaction to this employee workspace's DB, then send to renderer.
     * Uses withDbPath to target the correct DB when another workspace is active.
     * Mirrors saveRelayMessageToWorkspaceDb - ensures boss reactions are persisted
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
            const emoji = zaloReactionIconToEmoji(rawIcon);
            const threadId = String(reaction.threadId || rData.idTo || rData.threadId || '') || undefined;

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
                    db.updateMessageReaction(zaloId, targetMsgId, userId, emoji, threadId);
                });
                Logger.log(`[HttpClientService] Saved relay reaction to ${targetDbPath} via withDbPath`);
            } else {
                db.updateMessageReaction(zaloId, targetMsgId, userId, emoji, threadId);
                Logger.log(`[HttpClientService] Saved relay reaction to active DB (our workspace)`);
            }

            // Always forward reaction to renderer (dedup-safe like saveRelayMessageToWorkspaceDb)
            EventBroadcaster.sendDirect('event:reaction', { zaloId, reaction });
        } catch (err: any) {
            Logger.warn(`[HttpClientService] saveRelayReaction error: ${err.message}`);
        }
    }

    /**
     * Mark relayed recalled/deleted messages in this employee workspace's DB.
     * Called for event:undo and event:delete - both just mark messages as recalled.
     * Uses withDbPath to target the correct DB when another workspace is active.
     */
    /** "Xoá khỏi app" từ Boss: xoá tin khỏi DB của workspace nhân viên (đúng DB kể cả khi workspace khác đang mở) rồi báo renderer. */
    private saveRelayAppDeleteToWorkspaceDb(zaloId: string, msgIds: string[], data: any): void {
        try {
            const DatabaseService = require('../database/DatabaseService').default;
            const WorkspaceManager = require('../../utils/WorkspaceManager').default;
            const db = DatabaseService.getInstance();
            const ws = this.workspaceId ? WorkspaceManager.getInstance().getWorkspaceById(this.workspaceId) : null;
            const targetDbPath = ws ? WorkspaceManager.getInstance().resolveDbPath(ws.dbPath || 'deplao-tool.db') : null;
            const doDelete = () => db.deleteMessages(zaloId, msgIds, data?.threadId ? String(data.threadId) : undefined);
            if (targetDbPath && targetDbPath !== db.getDbPath()) db.withDbPath(targetDbPath, doDelete);
            else doDelete();
        } catch (err: any) {
            Logger.warn(`[HttpClientService] saveRelayAppDelete error: ${err.message}`);
        }
        EventBroadcaster.sendDirect('event:delete', data);
    }

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
                    db.markMessageRecalled(zaloId, msgId, threadId || undefined);
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

            // Always forward recall/delete to renderer (dedup-safe like saveRelayMessageToWorkspaceDb)
            EventBroadcaster.sendDirect(channel, eventData);
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
                // ⚠️ db.saveMessage is async but has NO await inside, so it runs synchronously.
                // If you add `await`, the withDbPath callback will return a Promise and the DB
                // will be swapped back before the write completes — use db.queryOtherDb instead.
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
                // Active DB IS our workspace - save directly
                db.saveMessage(zaloId, message);
                // Persist employee sender info so it survives conversation reload
                const empInfo = message.data?._employeeInfo;
                const msgId = message.data?.msgId;
                if (empInfo?.employee_id && msgId) {
                    db.setMessageHandledByEmployeeFlexible(zaloId, String(msgId), empInfo.employee_id);
                }
                Logger.log(`[HttpClientService] Saved relay message to active DB (our workspace)`);
            }

            // Always forward event:message to renderer.
            // addMessage in chatStore deduplicates by msg_id (line 226-228),
            // so double events (Boss direct + SSE relay) are safe.
            // This ensures the employee workspace UI updates even when
            // the user is currently viewing another workspace.
            EventBroadcaster.sendDirect('event:message', { zaloId, message });

        } catch (err: any) {
            Logger.warn(`[HttpClientService] saveRelayMessage error: ${err.message}`);
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.consecutiveHeartbeatFailures = 0;
        this.firstHeartbeatFailureAt = 0;
        // Kể cả khi đã disconnected → vẫn thử heartbeat để tự reconnect
        this.heartbeatTimer = setInterval(() => { void this.runHeartbeat(); }, HttpClientService.HEARTBEAT_INTERVAL_MS);
    }

    /** Một nhịp heartbeat (chu kỳ 15 s hoặc gọi ngay khi máy ngủ dậy) — không chạy chồng. */
    private async runHeartbeat(): Promise<void> {
        if (this.heartbeatInFlight || this.authExpired || !this.bossUrl) return;
        const gen = this.generation;
        this.heartbeatInFlight = true;
        const start = Date.now();
        try {
            const sioConnected = this.socketIOClient.isConnected();
            const result = await this.httpPost(
                `${this.bossUrl}/api/auth/heartbeat`,
                { callbackUrl: this.callbackUrl, sioConnected },
                { Authorization: `Bearer ${this.token}` },
                10000
            );
            if (gen !== this.generation) return;
            if (result?.success) {
                this.onHeartbeatOk(Date.now() - start);
            } else {
                this.onHeartbeatFailure(start, result?.error || 'heartbeat failed', this.isAuthFailure(result));
            }
        } catch (err: any) {
            if (gen !== this.generation) return;
            this.onHeartbeatFailure(start, err?.message || 'heartbeat error', false);
        } finally {
            if (gen === this.generation) this.heartbeatInFlight = false;
        }
    }

    private onHeartbeatOk(latency: number): void {
        const now = Date.now();
        const failuresBefore = this.consecutiveHeartbeatFailures;
        const gapMs = this.firstHeartbeatFailureAt ? now - this.firstHeartbeatFailureAt : 0;
        const resyncReason = heartbeatResyncReason({ failuresBefore, gapMs, pendingWake: this.pendingWakeResync });

        this.latencyMs = latency;
        this.consecutiveHeartbeatFailures = 0;
        this.consecutiveAuthFailures = 0;
        this.firstHeartbeatFailureAt = 0;
        this.pendingWakeResync = false;
        // Nếu trước đó đang disconnected mà heartbeat thành công → reconnect!
        if (!this.connected) {
            this.connected = true;
            Logger.log(`[HttpClientService] ✅ Reconnected via heartbeat (sau ${failuresBefore} lần lỗi, ${Math.round(gapMs / 1000)}s)`);
        }
        this.onStatusChange?.(true, latency);

        // Boss vừa không tới được: Socket.IO có thể đang chờ backoff dài → mở lại ngay
        if (failuresBefore > 0 && !this.socketIOClient.isConnected()) {
            this.socketIOClient.reconnectNow('heartbeat hồi phục');
        }
        if (resyncReason) this.onResync?.(resyncReason, gapMs);
    }

    private onHeartbeatFailure(start: number, error: string, authFailure: boolean): void {
        this.latencyMs = 0;
        if (!this.firstHeartbeatFailureAt) this.firstHeartbeatFailureAt = start;
        this.consecutiveHeartbeatFailures++;
        this.consecutiveAuthFailures = authFailure ? this.consecutiveAuthFailures + 1 : 0;
        if (authFailure && this.consecutiveAuthFailures >= HttpClientService.AUTH_FAILURES_BEFORE_EXPIRED) {
            this.handleAuthExpired('heartbeat 401', error);
            return;
        }
        if (this.connected) this.onStatusChange?.(false, 0);
        if (this.consecutiveHeartbeatFailures >= HttpClientService.MAX_HEARTBEAT_FAILURES && this.connected) {
            Logger.warn(`[HttpClientService] ${this.consecutiveHeartbeatFailures} consecutive heartbeat failures - marking disconnected (${error})`);
            this.connected = false;
            this.onStatusChange?.(false, 0);
        }
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
            // ngrok free domains chèn trang cảnh báo trình duyệt → header này bỏ qua,
            // trả JSON trực tiếp thay vì HTML interstitial.
            if (hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok-free.app') || hostname.endsWith('.ngrok.app') || hostname.endsWith('.ngrok.io')) {
                return { 'ngrok-skip-browser-warning': 'true' };
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
            // HTML interstitial - likely a tunnel challenge page
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

    /**
     * Gắn HTTP status vào kết quả đã parse dưới dạng thuộc tính KHÔNG enumerable (`__httpStatus`)
     * → nhận ra 401 mà không lọt ra IPC / JSON (structured clone bỏ qua thuộc tính không enumerable).
     */
    private withHttpStatus(parsed: any, statusCode?: number): any {
        if (parsed && typeof parsed === 'object' && statusCode) {
            try {
                Object.defineProperty(parsed, '__httpStatus', { value: statusCode, enumerable: false, configurable: true });
            } catch { /* ignore */ }
        }
        return parsed;
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
                        res.on('end', () => resolve(this.withHttpStatus(this.parseJsonResponse(data), res.statusCode)));
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

    /** POST binary data (raw Buffer, not JSON) */
    private httpPostBinary(url: string, data: Buffer, headers: Record<string, string> = {}, timeout = 120000): Promise<any> {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');

                const req = httpModule.request(
                    {
                        hostname: urlObj.hostname,
                        port: urlObj.port,
                        path: urlObj.pathname,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': Buffer.byteLength(data),
                            ...this.getTunnelBypassHeaders(),
                            ...headers,
                        },
                        timeout,
                    },
                    (res: http.IncomingMessage) => {
                        let body = '';
                        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                        res.on('end', () => resolve(this.parseJsonResponse(body)));
                    }
                );

                req.on('error', (err: Error) => reject(err));
                req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
                req.end(data);
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
                        res.on('end', () => resolve(this.withHttpStatus(this.parseJsonResponse(data), res.statusCode)));
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

