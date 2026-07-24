import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Logger from '../../utils/Logger';
import EmployeeService from '../employee/EmployeeService';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import ConnectionManager from '../../utils/ConnectionManager';
import TunnelService from '../tunnel/TunnelService';
import SocketIOService from '../socket/SocketIOService';
import { handlers as restHandlers } from './handlers/RestApiHandlers';
import { handleMediaRequest as handleMediaFileServe } from './handlers/MediaHandler';
import { libraryHandlers } from './handlers/LibraryHandler';
import FileStorageService from '../file/FileStorageService';

interface RegisteredEmployee {
    employee_id: string;
    display_name: string;
    avatar_url: string;
    username: string;
    callbackUrl: string; // http://IP:PORT - employee's local HTTP server
    token: string;
    lastSeen: number;
    assigned_accounts: string[];
    ip_address: string;
    connected_at: number;
    consecutiveFailures: number;
}

interface EmployeeSnapshot {
    assignedAccounts: string[];
    permissions: Array<{ module: string; can_access: boolean }>;
    erpRole?: string;
    erpExtraJson?: string;
    employeesData: Array<{
        employee_id: string;
        username: string;
        display_name: string;
        avatar_url?: string;
        role?: string;
        is_active?: number;
        permissions?: Array<{ module: string; can_access: boolean }>;
        assigned_accounts?: string[];
    }>;
    accountsData: Array<{
        zalo_id: string;
        full_name: string;
        avatar_url: string;
        phone: string;
        is_business: number;
        is_active: number;
        listener_active: number;
    }>;
    onlineAccounts: string[];
}

/**
 * HttpRelayService - Boss side only.
 * HTTP server that relays Zalo events to Employee machines via HTTP POST
 * and proxies Employee actions back to Zalo via IPC handler registry.
 *
 * Replaces SocketRelayService - no persistent WebSocket connections.
 */
class HttpRelayService {
    private static instance: HttpRelayService;
    private httpServer: http.Server | null = null;
    private running = false;
    private port = 9900;
    private employees = new Map<string, RegisteredEmployee>(); // employeeId → employee
    private pinnedDbPath: string | null = null;
    private offlineCheckTimer: ReturnType<typeof setInterval> | null = null;

    /** REST API response cache: key → { data, ts }.
     *  Prevents redundant DB queries on every message (labels, flags, pins, etc.),
     *  which block the main thread via synchronous better-sqlite3 and delay SSE writes. */
    private restApiCache = new Map<string, { data: any; ts: number }>();
    private static REST_CACHE_TTL_MS = 1500; // 1.5s cache for frequent read-only queries

    /** SSE clients: employeeId → ServerResponse (persistent event stream) */
    private sseClients = new Map<string, http.ServerResponse>();
    /** Keepalive timers for SSE connections */
    private sseKeepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();
    /** Last successful SSE write timestamp per employee (ms) — detect half-open sockets */
    private sseLastWriteOk = new Map<string, number>();
    /**
     * Per-employee SSE event queue for WAN mode.
     * When pushViaSSE fails and there is no callbackUrl fallback, events are
     * queued here and flushed the next time the employee's SSE stream reconnects.
     */
    private sseEventQueue = new Map<string, Array<{ channel: string; data: any; ts: number }>>();
    private static SSE_QUEUE_TTL_MS = 600_000; // 10-minute TTL (was 2 min - WAN reconnect can take longer)
    private static SSE_QUEUE_MAX = 500;        // max queued events per employee (was 300)

    /** Tunnel state */
    private tunnelActive = false;
    private tunnelUrl: string | null = null;
    /** Lưu tunnel cần restart khi relay start lại (sau workspace switch) */
    private tunnelPendingRestart = false;

    /**
     * Pending employee sender info: msgId → employee data.
     * Set immediately when employee sends a message (before webhook arrives).
     * Consumed by EventBroadcaster.broadcastMessage to tag the message at save time.
     */
    private static pendingEmployeeMsgIds = new Map<string, {
        employee_id: string;
        employee_name: string;
        employee_avatar: string;
        zaloId: string;
        threadId: string;
        timestamp: number;
    }>();

    /** Secondary fallback map: zaloId:threadId → employee info (for when msgId doesn't match) */
    private static pendingEmployeeByThread = new Map<string, {
        employee_id: string;
        employee_name: string;
        employee_avatar: string;
        zaloId: string;
        threadId: string;
        timestamp: number;
    }>();

    /** Register a pending employee message (called before webhook arrives) */
    public static setPendingEmployeeMsg(msgId: string, info: {
        employee_id: string; employee_name: string; employee_avatar: string;
        zaloId: string; threadId: string;
    }): void {
        const now = Date.now();
        const entry = { ...info, timestamp: now };
        // Key by msgId if available
        if (msgId) {
            this.pendingEmployeeMsgIds.set(String(msgId), entry);
            setTimeout(() => this.pendingEmployeeMsgIds.delete(String(msgId)), 30_000);
        }
        // Always also key by zaloId:threadId as fallback
        const threadKey = `${info.zaloId}:${info.threadId}`;
        this.pendingEmployeeByThread.set(threadKey, entry);
        setTimeout(() => {
            const cur = this.pendingEmployeeByThread.get(threadKey);
            if (cur && cur.timestamp === now) this.pendingEmployeeByThread.delete(threadKey);
        }, 15_000);
    }

    /** Check and consume pending employee info for a msgId (with cliMsgId + thread fallback) */
    public static consumePendingEmployeeMsg(msgId: string, zaloId?: string, threadId?: string, cliMsgId?: string): {
        employee_id: string; employee_name: string; employee_avatar: string;
        zaloId: string; threadId: string;
    } | null {
        Logger.log(`[HttpRelayService] 🔎 consumePendingEmployeeMsg: msgId="${msgId}", cliMsgId="${cliMsgId}", zaloId="${zaloId}", threadId="${threadId}", maps=${this.pendingEmployeeMsgIds.size}/${this.pendingEmployeeByThread.size}`);
        // Try by global msgId first
        if (msgId) {
            const key = String(msgId);
            const info = this.pendingEmployeeMsgIds.get(key);
            if (info) {
                this.pendingEmployeeMsgIds.delete(key);
                this.pendingEmployeeByThread.delete(`${info.zaloId}:${info.threadId}`);
                return info;
            }
        }
        // Try by cliMsgId - proxy may have registered under this key
        if (cliMsgId && cliMsgId !== msgId) {
            const key = String(cliMsgId);
            const info = this.pendingEmployeeMsgIds.get(key);
            if (info) {
                this.pendingEmployeeMsgIds.delete(key);
                this.pendingEmployeeByThread.delete(`${info.zaloId}:${info.threadId}`);
                return info;
            }
        }
        // Fallback: try by zaloId:threadId (within 15s window)
        if (zaloId && threadId) {
            const threadKey = `${zaloId}:${threadId}`;
            const info = this.pendingEmployeeByThread.get(threadKey);
            if (info && (Date.now() - info.timestamp) < 15_000) {
                this.pendingEmployeeByThread.delete(threadKey);
                return info;
            }
        }
        return null;
    }

    /** Max consecutive push failures before marking employee offline */
    private static MAX_FAILURES = 3;
    /** Heartbeat timeout - if no heartbeat for this long, mark offline */
    private static HEARTBEAT_TIMEOUT_MS = 45_000; // 45s (employee sends every 15s)
    /** Push timeout for event delivery */
    private static PUSH_TIMEOUT_MS = 3000;

    /** Channels to relay from EventBroadcaster → employees */
    private static RELAY_CHANNELS = [
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
        // ─── ERP module events (Phase 1 MVP) ───────────────────────
        'erp:event:projectCreated',
        'erp:event:projectUpdated',
        'erp:event:projectDeleted',
        'erp:event:taskCreated',
        'erp:event:taskUpdated',
        'erp:event:taskDeleted',
        'erp:event:commentAdded',
        'erp:event:calendarEventCreated',
        'erp:event:calendarEventUpdated',
        'erp:event:calendarEventDeleted',
        'erp:event:reminder',
        'erp:event:noteCreated',
        'erp:event:noteUpdated',
        'erp:event:noteDeleted',
        'erp:event:notification',
        // ─── ERP Phase 2 events ────────────────────────────────────
        'erp:event:leaveCreated',
        'erp:event:leaveDecided',
        'erp:event:attendanceUpdated',
        'erp:event:noteShared',
        'erp:event:departmentUpdated',
        'erp:event:employeeProfileUpdated',
        // ─── ERP Phase 2 missing events ──────────────────────────────────
        'erp:event:employeeProfileDeleted',
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
        'db:unreadChanged',
        'db:conversationDeleted',
        'db:contactProfileUpdated',
        'crm:tagChanged',
        'event:friendRequestSent',
        // ─── Library events ────────────────────────────────────────────
        'library:itemAdded',
        'library:itemUpdated',
        'library:itemDeleted',
        'event:friendRequestRemoved',
        'crm:queueUpdate',
        'crm:queueStatus',
        'crm:campaignDone',
        'workflow:executed',
        'integration:payment',
        'integration:webhook',
    ];

    public static getInstance(): HttpRelayService {
        if (!HttpRelayService.instance) {
            HttpRelayService.instance = new HttpRelayService();
        }
        return HttpRelayService.instance;
    }

    // ─── Pinned DB helper ─────────────────────────────────────────────

    private runOnPinnedDb<T>(fn: (db: DatabaseService) => T): T {
        const db = DatabaseService.getInstance();
        if (this.pinnedDbPath && db.getDbPath() !== this.pinnedDbPath) {
            return db.withDbPath(this.pinnedDbPath, () => fn(db));
        }
        return fn(db);
    }

    private buildEmployeeSnapshot(employeeId: string): EmployeeSnapshot | null {
        return this.runOnPinnedDb((db) => {
            const employeeService = EmployeeService.getInstance();
            const emp = employeeService.getEmployeeById(employeeId);
            if (!emp) return null;

            const assignedAccounts = emp.assigned_accounts || [];
            const onlineAccounts = assignedAccounts.filter((zaloId) => ConnectionManager.isConnected(zaloId));
            const allAccounts = db.getAccounts();
            let profile = db.queryOne<{ erp_role?: string; extra_json?: string }>(
                `SELECT erp_role, extra_json FROM erp_employee_profiles WHERE employee_id = ?`,
                [employeeId],
            );

            // Repair: if employee has erp module permission but no ERP profile, auto-create one.
            // This handles cases where the initial auto-create in employeeIpc failed silently.
            if (!profile) {
                const hasErpPerm = (emp.permissions || []).some(
                    (p: any) => p.module === 'erp' && p.can_access,
                );
                if (hasErpPerm) {
                    try {
                        db.run(
                            `INSERT OR IGNORE INTO erp_employee_profiles (employee_id, erp_role, extra_json, updated_at)
                             VALUES (?, 'member', '{}', ?)`,
                            [employeeId, Date.now()],
                        );
                        profile = { erp_role: 'member', extra_json: '{}' };
                        Logger.log(`[HttpRelayService] Auto-repaired ERP profile for employee ${employeeId}`);
                    } catch (repairErr: any) {
                        Logger.warn(`[HttpRelayService] Failed to repair ERP profile: ${repairErr.message}`);
                    }
                }
            }
            const employeesData = employeeService.getEmployees().map((employee: any) => ({
                employee_id: employee.employee_id,
                username: employee.username,
                display_name: employee.display_name,
                avatar_url: employee.avatar_url,
                role: employee.role,
                is_active: employee.is_active,
                permissions: employee.permissions || [],
                assigned_accounts: employee.assigned_accounts || [],
            }));
            const accountsData = allAccounts
                .filter(a => assignedAccounts.includes(a.zalo_id))
                .map(a => ({
                    zalo_id: a.zalo_id,
                    full_name: a.full_name,
                    avatar_url: a.avatar_url,
                    phone: a.phone || '',
                    is_business: a.is_business || 0,
                    is_active: a.is_active,
                    listener_active: ConnectionManager.isConnected(a.zalo_id) ? 1 : 0,
                }));

            return {
                assignedAccounts,
                permissions: emp.permissions || [],
                erpRole: profile?.erp_role || undefined,
                erpExtraJson: profile?.extra_json || undefined,
                employeesData,
                accountsData,
                onlineAccounts,
            };
        });
    }

    // ─── Lifecycle ────────────────────────────────────────────────────

    public async start(port?: number): Promise<{ success: boolean; port?: number; error?: string }> {
        if (this.running) {
            return { success: true, port: this.port };
        }

        this.port = port || this.port;

        EmployeeService.getInstance().pinToCurrentDb();
        this.pinnedDbPath = DatabaseService.getInstance().getDbPath();

        try {
            this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));

            // Attach Socket.IO vào cùng HTTP server (path /socket.io)
            // Employee dùng WebSocket thay SSE cho real-time event
            SocketIOService.getInstance().attach(this.httpServer);

            this.hookEventBroadcaster();
            this.startOfflineCheck();

            return new Promise((resolve) => {
                this.httpServer!.listen(this.port, () => {
                    this.running = true;
                    Logger.log(`[HttpRelayService] ✅ Server started on port ${this.port}`);
                    // Auto-restart tunnel nếu trước đó tunnel đang chạy
                    if (this.tunnelPendingRestart) {
                        this.tunnelPendingRestart = false;
                        TunnelService.start(this.port).then((url) => {
                            this.tunnelActive = true;
                            this.tunnelUrl = url;
                            Logger.log(`[HttpRelayService] 🔁 Tunnel auto-restarted: ${url}`);
                            this.broadcastEmployeeList();
                        }).catch((err) => {
                            Logger.warn(`[HttpRelayService] Tunnel auto-restart failed: ${err.message}`);
                        });
                    }
                    resolve({ success: true, port: this.port });
                });
                this.httpServer!.on('error', (err: any) => {
                    Logger.error(`[HttpRelayService] ❌ Server error: ${err.message}`);
                    resolve({ success: false, error: err.message });
                });
            });
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Start error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public stop(): { success: boolean } {
        try {
            if (this.httpServer) {
                this.httpServer.close();
                this.httpServer = null;
            }
            this.stopOfflineCheck();
            // Stop Socket.IO
            SocketIOService.getInstance().stop();
            // Close all SSE streams
            for (const [empId, res] of this.sseClients) {
                try { res.end(); } catch {}
                const kt = this.sseKeepaliveTimers.get(empId);
                if (kt) clearInterval(kt);
            }
            this.sseClients.clear();
            this.sseKeepaliveTimers.clear();
            this.sseLastWriteOk.clear();
            // Stop tunnel if active — nhưng nhớ để restart sau
            if (this.tunnelActive) {
                this.tunnelPendingRestart = true;
                TunnelService.stop(this.port).catch(() => {});
                this.tunnelActive = false;
                this.tunnelUrl = null;
            }
            // End all active employee sessions in DB
            for (const [empId] of this.employees) {
                try { this.runOnPinnedDb((db) => db.endEmployeeSession(empId)); } catch {}
            }
            this.employees.clear();
            this.running = false;
            this.pinnedDbPath = null;
            EmployeeService.getInstance().unpinDb();
            Logger.log('[HttpRelayService] Server stopped');
            return { success: true };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Stop error: ${err.message}`);
            return { success: true };
        }
    }

    public getStatus(): {
        running: boolean;
        port: number;
        connectedEmployees: Array<{ employee_id: string; display_name: string; avatar_url: string; ip_address: string; connected_at: number; sseConnected: boolean }>;
        localIPs: string[];
        tunnelActive: boolean;
        tunnelUrl: string | null;
    } {
        const employees = Array.from(this.employees.values()).map(e => ({
            employee_id: e.employee_id,
            display_name: e.display_name,
            avatar_url: e.avatar_url,
            ip_address: e.ip_address,
            connected_at: e.connected_at,
            sseConnected: this.sseClients.has(e.employee_id),
        }));
        return {
            running: this.running,
            port: this.port,
            connectedEmployees: employees,
            localIPs: this.getLocalIPs(),
            tunnelActive: this.tunnelActive,
            tunnelUrl: this.tunnelUrl,
        };
    }

    public kickEmployee(employeeId: string): void {
        const emp = this.employees.get(employeeId);
        if (emp) {
            // Notify employee they've been kicked (via SSE first, then callbackUrl)
            if (!this.pushViaSSE(employeeId, 'relay:kicked', { reason: 'Bị ngắt kết nối bởi quản lý' })) {
                this.pushToEmployee(emp, 'relay:kicked', { reason: 'Bị ngắt kết nối bởi quản lý' }).catch(() => {});
            }
            // Close SSE stream
            const sseRes = this.sseClients.get(employeeId);
            if (sseRes) { try { sseRes.end(); } catch {} this.sseClients.delete(employeeId); }
            const kt = this.sseKeepaliveTimers.get(employeeId);
            if (kt) { clearInterval(kt); this.sseKeepaliveTimers.delete(employeeId); }
            this.sseLastWriteOk.delete(employeeId);
            this.employees.delete(employeeId);
            this.sseEventQueue.delete(employeeId); // clear any pending queue
            // End session in DB for online time tracking
            try { this.runOnPinnedDb((db) => db.endEmployeeSession(employeeId)); } catch {}
            Logger.log(`[HttpRelayService] Kicked employee: ${emp.display_name}`);
            this.broadcastEmployeeList();
        }
    }

    // ─── HTTP Router ──────────────────────────────────────────────────

    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PATCH, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = req.url || '';

        // ── Auth endpoints ────────────────────────────────────────────
        if (req.method === 'POST' && url === '/api/auth/login') {
            return this.handleLogin(req, res);
        }
        if (req.method === 'POST' && url === '/api/auth/heartbeat') {
            return this.handleHeartbeat(req, res);
        }

        // ── Proxy action ──────────────────────────────────────────────
        if (req.method === 'POST' && url === '/api/proxy/action') {
            return this.handleProxyAction(req, res);
        }

        // ── Snapshot endpoint ─────────────────────────────────────────
        if (req.method === 'GET' && url === '/api/sync/snapshot') {
            return this.handleSyncSnapshot(req, res);
        }

        // ── Media upload (multipart) ──────────────────────────────────
        if (req.method === 'POST' && url === '/api/media/upload') {
            return this.handleMediaUploadMultipart(req, res);
        }

        // ── Healthcheck ───────────────────────────────────────────────
        if (req.method === 'GET' && (url === '/api/health' || url === '/')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', relay: this.running, port: this.port }));
            return;
        }

        // ── SSE event stream ──────────────────────────────────────────
        if (req.method === 'GET' && url === '/api/events/stream') {
            return this.handleSSEStream(req, res);
        }

        // ── REST API (New employee query/command endpoints) ──────────
        if (req.method === 'GET' && url.startsWith('/api/boot')) {
            return this.handleRestApi(req, res);
        }
        if (req.method === 'GET' && url.startsWith('/api/query/')) {
            return this.handleRestApi(req, res);
        }
        if (req.method === 'GET' && url.startsWith('/api/search/')) {
            return this.handleRestApi(req, res);
        }
        if (req.method === 'GET' && url.startsWith('/api/media/')) {
            return this.handleRestApi(req, res);
        }
        if (req.method === 'POST' && url.startsWith('/api/command/')) {
            return this.handleRestApi(req, res);
        }
        if ((req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')
            && url.startsWith('/api/command/')) {
            return this.handleRestApi(req, res);
        }
        if (req.method === 'GET' && url.startsWith('/api/library/')) {
            return this.handleRestApi(req, res);
        }
        if (req.method === 'POST' && url.startsWith('/api/library/')) {
            return this.handleRestApi(req, res);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }

    // ─── Auth handlers ────────────────────────────────────────────────

    private handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
        this.readBody(req, async (body) => {
            try {
                const { username, password, callbackUrl } = JSON.parse(body);
                if (!username || !password) {
                    return this.json(res, 400, { success: false, error: 'Thiếu username hoặc password' });
                }

                const result = await EmployeeService.getInstance().authenticate(username, password);
                if (!result.success || !result.employee) {
                    return this.json(res, 401, result);
                }

                const emp = result.employee;
                const clientIp = req.socket.remoteAddress || '';

                // Register employee
                const registered: RegisteredEmployee = {
                    employee_id: emp.employee_id,
                    display_name: emp.display_name,
                    avatar_url: emp.avatar_url,
                    username,
                    callbackUrl: callbackUrl || '', // employee provides their local server URL
                    token: result.token || '',
                    lastSeen: Date.now(),
                    assigned_accounts: emp.assigned_accounts || [],
                    ip_address: clientIp,
                    connected_at: Date.now(),
                    consecutiveFailures: 0,
                };

                this.employees.set(emp.employee_id, registered);

                // Log session start in employee_sessions table (for online time analytics)
                this.runOnPinnedDb((db) => {
                    // Close any stale open sessions first
                    db.endEmployeeSession(emp.employee_id);
                    // Start new session
                    db.startEmployeeSession(emp.employee_id, clientIp);
                    db.logEmployeeAction({
                        employee_id: emp.employee_id,
                        zalo_id: '',
                        thread_id: '',
                        action: 'session_start',
                        metadata: JSON.stringify({ ip: clientIp, callbackUrl }),
                    });
                });

                Logger.log(`[HttpRelayService] 🟢 Employee registered: ${emp.display_name} (@${username}) callback=${callbackUrl} ip=${clientIp}`);

                // Build snapshot
                const snapshot = this.buildEmployeeSnapshot(emp.employee_id);

                this.broadcastEmployeeList();

                // Return token + snapshot (strip password_hash)
                this.json(res, 200, {
                    success: true,
                    token: result.token,
                    employee: { ...emp, password_hash: '' },
                    snapshot,
                });
            } catch (err: any) {
                Logger.error(`[HttpRelayService] Login error: ${err.message}`);
                this.json(res, 400, { success: false, error: 'Request không hợp lệ' });
            }
        });
    }

    private handleHeartbeat(req: http.IncomingMessage, res: http.ServerResponse): void {
        this.readBody(req, (body) => {
            try {
                const { callbackUrl, sseAlive } = JSON.parse(body);
                const employee = this.authenticateRequest(req);
                if (!employee) {
                    return this.json(res, 401, { success: false, error: 'Unauthorized' });
                }

                employee.lastSeen = Date.now();
                employee.consecutiveFailures = 0;
                if (callbackUrl) {
                    employee.callbackUrl = callbackUrl;
                }

                // Socket.IO đã thay thế SSE - không cần detect half-open nữa
                // (heartbeat chỉ để xác nhận employee còn alive)

                this.json(res, 200, { success: true, ts: Date.now() });
            } catch (err: any) {
                this.json(res, 400, { success: false, error: err.message });
            }
        });
    }

    // ─── Proxy action handler ─────────────────────────────────────────

    private handleProxyAction(req: http.IncomingMessage, res: http.ServerResponse): void {
        this.readBody(req, async (body) => {
            try {
                const employee = this.authenticateRequest(req);
                if (!employee) {
                    return this.json(res, 401, { success: false, error: 'Unauthorized' });
                }

                employee.lastSeen = Date.now();

                const { channel, params } = JSON.parse(body);
                if (!channel) {
                    return this.json(res, 400, { success: false, error: 'Missing channel' });
                }

                const result = await this.executeProxyAction(employee, channel, params || {});
                this.json(res, 200, result);
            } catch (err: any) {
                Logger.error(`[HttpRelayService] Proxy action error: ${err.message}`);
                this.json(res, 500, { success: false, error: err.message });
            }
        });
    }

    private async executeProxyAction(employee: RegisteredEmployee, channel: string, params: any): Promise<any> {
        let zaloId = params?.zaloId || params?.zalo_id || '';

        if (!zaloId && employee.assigned_accounts.length > 0) {
            zaloId = employee.assigned_accounts[0];
        }

        if (zaloId && !employee.assigned_accounts.includes(zaloId)) {
            return { success: false, error: 'Không có quyền truy cập tài khoản này' };
        }

        // Check permission
        const empSvc = EmployeeService.getInstance();
        const module = this.channelToModule(channel);
        if (module && !empSvc.hasPermission(employee.employee_id, module)) {
            return { success: false, error: `Không có quyền truy cập module: ${module}` };
        }

        try {
            // Inject real auth
            if (params?.auth !== undefined) {
                const realAuth = this.resolveRealAuth(zaloId, params.auth);
                if (realAuth) {
                    params = { ...params, auth: realAuth, _fromRelay: true };
                } else if (zaloId) {
                    Logger.warn(`[HttpRelayService] Proxy: could not resolve real auth for zaloId=${zaloId}, channel=${channel}`);
                    params = { ...params, _fromRelay: true };
                }
            } else {
                params = { ...params, _fromRelay: true };
            }

            // Special handling for login:connect - not in zaloIpc handler registry
            // Boss looks up real auth from its own DB and connects directly
            if (channel === 'login:connect' && zaloId) {
                try {
                    const realAuth = this.resolveRealAuth(zaloId, {});
                    if (realAuth) {
                        // Map DB fields (snake_case) to loginZalo expected format (camelCase)
                        const authPayload = {
                            cookies: realAuth.cookies || '',
                            imei: realAuth.imei || '',
                            userAgent: realAuth.userAgent || realAuth.user_agent || '',
                        };
                        const { ipcMain } = require('electron');
                        const handlers: Map<string, Function> | undefined = (ipcMain as any)._invokeHandlers;
                        const loginHandler = handlers?.get('login:connect');
                        if (loginHandler) {
                            const result = await loginHandler(null, { auth: authPayload });
                            Logger.log(`[HttpRelayService] Proxy login:connect for zaloId=${zaloId}: success=${result?.success}`);
                            return result;
                        }
                    }
                    return { success: false, error: 'Không tìm thấy thông tin xác thực' };
                } catch (err: any) {
                    return { success: false, error: err.message };
                }
            }

            // Use handler registry
            const { ipcHandlerRegistry } = require('../../../electron/ipc/zaloIpc');
            const handler = ipcHandlerRegistry?.get(channel);

            // ── Special: sendVideo from library → do full 3-step upload chain ──
            if (channel === 'zalo:sendVideo' && params._libraryUuid) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const libItem = this.runOnPinnedDb(() => {
                        const LibraryService = require('../library/LibraryService').default;
                        return LibraryService.getInstance().getItem(params._libraryUuid);
                    });
                    Logger.log(`[HttpRelayService] 🔄 Video libraryUuid=${params._libraryUuid}: found=${!!libItem}, file_path=${libItem?.file_path}`);

                    if (!libItem || !libItem.file_path || !fs.existsSync(libItem.file_path)) {
                        Logger.error(`[HttpRelayService] Library video file not found: ${libItem?.file_path}`);
                        return { success: false, error: 'Không tìm thấy file video trong thư viện' };
                    }

                    const videoPath = libItem.file_path;
                    const zaloId = params.zaloId || employee.assigned_accounts[0] || '';

                    // Step 1: Extract video metadata & thumbnail
                    const { execSync } = require('child_process');
                    let duration = 0, width = 0, height = 0, thumbPath = '';

                    try {
                        const ffprobe = require('@ffprobe-installer/ffprobe')?.path || 'ffprobe';
                        const probeOut = execSync(
                            `"${ffprobe}" -v quiet -print_format json -show_format -show_streams "${videoPath}"`,
                            { timeout: 10000 }
                        ).toString();
                        const probe = JSON.parse(probeOut);
                        duration = parseFloat(probe.format?.duration) || 0;
                        const videoStream = probe.streams?.find((s: any) => s.codec_type === 'video');
                        width = parseInt(videoStream?.width) || 0;
                        height = parseInt(videoStream?.height) || 0;
                    } catch { /* ffprobe unavailable */ }

                    // Try to find/create thumbnail
                    try {
                        const thumbDir = path.dirname(videoPath);
                        thumbPath = path.join(thumbDir, `_thumb_${path.basename(videoPath)}.jpg`);
                        if (!fs.existsSync(thumbPath)) {
                            const ffmpegBin = (() => {
                                try {
                                    let fp = require('ffmpeg-static') as string;
                                    if (fp.includes('app.asar') && !fp.includes('app.asar.unpacked')) {
                                        fp = fp.replace('app.asar', 'app.asar.unpacked');
                                    }
                                    return fp;
                                } catch { return 'ffmpeg'; }
                            })();
                            const seekSec = duration > 2 ? 1 : 0;
                            execSync(
                                `"${ffmpegBin}" -ss ${seekSec} -i "${videoPath}" -vframes 1 -q:v 2 "${thumbPath}" -y`,
                                { timeout: 15000 }
                            );
                            if (!fs.existsSync(thumbPath)) thumbPath = '';
                        }
                    } catch { thumbPath = ''; }

                    // Step 2: Upload video thumb to Zalo
                    const uploadThumbIpc = ipcHandlerRegistry?.get('zalo:uploadVideoThumb');
                    let thumbUrl = '';
                    if (uploadThumbIpc && thumbPath && fs.existsSync(thumbPath)) {
                        try {
                            const thumbRes = await uploadThumbIpc(null, {
                                ...params,
                                thumbPath,
                                zaloId,
                                _fromRelay: true,
                            });
                            const resp = thumbRes?.response || thumbRes;
                            thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
                        } catch { /* thumb upload failed - send without thumb */ }
                    }

                    // Step 3: Upload video file to Zalo
                    const uploadVideoIpc = ipcHandlerRegistry?.get('zalo:uploadVideoFile');
                    let videoUrl = '';
                    if (uploadVideoIpc) {
                        try {
                            const videoRes = await uploadVideoIpc(null, {
                                ...params,
                                videoPath,
                                zaloId,
                                _fromRelay: true,
                            });
                            const resp = videoRes?.response || videoRes;
                            videoUrl = resp?.fileUrl || resp?.normalUrl || resp?.hdUrl || resp?.url || '';
                        } catch (err: any) {
                            Logger.error(`[HttpRelayService] Video upload error: ${err.message}`);
                            return { success: false, error: 'Upload video thất bại' };
                        }
                    }
                    if (!videoUrl) {
                        return { success: false, error: 'Upload video thất bại' };
                    }

                    // Step 4: Send video message
                    params.options = {
                        videoUrl,
                        thumbnailUrl: thumbUrl || videoUrl,
                        duration: duration ? Math.round(duration * 1000) : undefined,
                        width: width || undefined,
                        height: height || undefined,
                    };
                    delete params.fileUrl;
                    delete params._libraryUuid;
                    delete params.filePath;

                    const sendVideoHandler = ipcHandlerRegistry?.get('zalo:sendVideo');
                    if (!sendVideoHandler) {
                        return { success: false, error: 'sendVideo handler not found' };
                    }
                    const sendResult = await sendVideoHandler(null, params);
                    return sendResult;
                } catch (err: any) {
                    Logger.error(`[HttpRelayService] Library video send error: ${err.message}`);
                    return { success: false, error: err.message };
                }
            }

            if (handler) {
                Logger.log(`[HttpRelayService] 🔄 ProxyAction: channel=${channel}, hasLibraryUuid=${!!params._libraryUuid}, hasLibraryUuids=${!!params._libraryUuids}, hasFilePath=${!!params.filePath}, filePathType=${typeof params.filePath}, paramsKeys=${Object.keys(params).join(',')}`);

                // Resolve single library UUID → real file path (cho employee mode)
                if (params._libraryUuid) {
                    try {
                        const libItem = this.runOnPinnedDb(() => {
                            const LibraryService = require('../library/LibraryService').default;
                            return LibraryService.getInstance().getItem(params._libraryUuid);
                        });
                        Logger.log(`[HttpRelayService] 🔄 Resolve libraryUuid=${params._libraryUuid}: found=${!!libItem}, file_path=${libItem?.file_path}, file_path_type=${typeof libItem?.file_path}`);

                        if (!libItem) {
                            Logger.error(`[HttpRelayService] ❌ Library item not found for uuid=${params._libraryUuid}`);
                        } else if (!libItem.file_path) {
                            Logger.error(`[HttpRelayService] ❌ Library item ${params._libraryUuid} has empty file_path`);
                        } else if (typeof libItem.file_path !== 'string') {
                            Logger.error(`[HttpRelayService] ❌ Library item ${params._libraryUuid} file_path is not a string: type=${typeof libItem.file_path}`);
                        }

                        if (libItem && libItem.file_path) {
                            if (channel === 'zalo:sendImages') {
                                params.filePaths = [libItem.file_path];
                            } else {
                                params.filePath = libItem.file_path;
                            }
                            delete params.fileUrl;
                            delete params._libraryUuid;
                        }
                    } catch (err: any) {
                        Logger.error(`[HttpRelayService] Library UUID resolve error: ${err.message}`);
                    }
                }

                // Resolve array of library UUIDs → file paths (cho employee mode sendImages batch)
                if (params._libraryUuids && Array.isArray(params._libraryUuids) && params._libraryUuids.length > 0) {
                    try {
                        const LibraryService = require('../library/LibraryService').default;
                        const filePaths: string[] = [];
                        for (const uuid of params._libraryUuids) {
                            const libItem = this.runOnPinnedDb(() => LibraryService.getInstance().getItem(uuid));
                            if (libItem?.file_path) {
                                filePaths.push(libItem.file_path);
                            } else {
                                Logger.warn(`[HttpRelayService] Library item not found or no file_path: uuid=${uuid}`);
                            }
                        }
                        if (filePaths.length > 0) {
                            params.filePaths = filePaths;
                            Logger.log(`[HttpRelayService] 🔄 Resolved ${filePaths.length}/${params._libraryUuids.length} library UUIDs → filePaths`);
                        }
                        delete params._libraryUuids;
                        delete params.fileUrl;
                    } catch (err: any) {
                        Logger.error(`[HttpRelayService] Library UUIDs array resolve error: ${err.message}`);
                    }
                }
                Logger.log(`[HttpRelayService] 🔄 Calling handler ${channel}: filePath=${params.filePath?.substring?.(0, 50) || '(empty)'}, filePathType=${typeof params.filePath}`);
                const result = await handler(null, params);

                // Log send actions + broadcast sender info to all workspaces
                if ((channel.includes('send') || channel.includes('Send')) && !channel.includes('Seen') && !channel.includes('seen') && !channel.includes('Typing') && !channel.includes('typing')) {
                    const rawMsgId = result?.response?.msgId
                        ?? result?.response?.message?.msgId
                        ?? result?.response?.message?.data?.msgId
                        ?? '';
                    const msgId = String(rawMsgId);
                    const threadId = params?.threadId || params?.thread_id || '';
                    Logger.log(`[HttpRelayService] 📤 SEND result for employee=${employee.employee_id}: channel=${channel}, msgId="${msgId}", rawMsgId=${rawMsgId} (type=${typeof rawMsgId}), threadId="${threadId}", zaloId="${zaloId}", response=${JSON.stringify(result?.response || {}).slice(0, 500)}`);

                    this.runOnPinnedDb((db) => db.logEmployeeAction({
                        employee_id: employee.employee_id,
                        zalo_id: zaloId,
                        thread_id: threadId,
                        thread_type: params?.threadType ?? params?.thread_type ?? 0,
                        msg_id: msgId,
                        action: 'sent',
                        metadata: JSON.stringify({ channel, proxy: true }),
                    }));

                    // Also log 'replied' action with response_time_ms for analytics
                    // Calculate response time = time from last customer message to now
                    if (threadId && zaloId) {
                        try {
                            this.runOnPinnedDb((db) => {
                                // Get the last incoming (non-sent) message timestamp in this thread
                                const rows = db.query<any>(
                                    `SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND is_sent = 0 ORDER BY timestamp DESC LIMIT 1`,
                                    [zaloId, threadId]
                                );
                                const lastIncoming = rows?.[0];
                                if (lastIncoming?.timestamp) {
                                    const responseTimeMs = Date.now() - lastIncoming.timestamp;
                                    // Only log if response time is reasonable (< 24 hours)
                                    if (responseTimeMs > 0 && responseTimeMs < 86400000) {
                                        db.logEmployeeAction({
                                            employee_id: employee.employee_id,
                                            zalo_id: zaloId,
                                            thread_id: threadId,
                                            thread_type: params?.threadType ?? params?.thread_type ?? 0,
                                            msg_id: msgId,
                                            action: 'replied',
                                            metadata: JSON.stringify({ channel, response_time_ms: responseTimeMs }),
                                        });
                                    }
                                }
                            });
                        } catch {}
                    }

                    // Mark message as handled by employee in DB
                    // Register pending info IMMEDIATELY so broadcastMessage can tag it at save time
                    if (zaloId) {
                        const empId = employee.employee_id;

                        // Register in pending map - consumed by EventBroadcaster.broadcastMessage
                        // Always register (even if msgId is empty) - the thread fallback will work
                        HttpRelayService.setPendingEmployeeMsg(msgId, {
                            employee_id: empId,
                            employee_name: employee.display_name,
                            employee_avatar: employee.avatar_url || '',
                            zaloId,
                            threadId,
                        });
                        Logger.log(`[HttpRelayService] 📌 setPendingEmployeeMsg: msgId="${msgId}", threadKey="${zaloId}:${threadId}", empId="${empId}"`);

                        // Also retry DB update after delays as fallback
                        // Use setMessageHandledByEmployeeFlexible to match by msg_id OR cli_msg_id
                        // (proxy may return cliMsgId while webhook uses globalMsgId)
                        // Delay 2s/5s - webhook typically arrives within 200ms-2s
                        const doFallbackUpdate = (delay: number) => {
                            setTimeout(() => {
                                try {
                                    if (msgId) {
                                        this.runOnPinnedDb((db) => db.setMessageHandledByEmployeeFlexible(zaloId, msgId, empId));
                                        Logger.log(`[HttpRelayService] 📌 DB fallback update (${delay}s): msgId="${msgId}", empId="${empId}"`);
                                    } else if (threadId) {
                                        // Thread-based fallback for attachment-only sends (image/file) where msgId is empty
                                        this.runOnPinnedDb((db) => {
                                            const rows = db.query(
                                                `SELECT msg_id FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND is_sent = 1
                                                 AND handled_by_employee IS NULL ORDER BY timestamp DESC LIMIT 1`,
                                                [zaloId, threadId]
                                            ) as any[];
                                            if (rows?.[0]?.msg_id) {
                                                db.setMessageHandledByEmployee(zaloId, String(rows[0].msg_id), empId);
                                                Logger.log(`[HttpRelayService] 📌 DB thread-fallback update (${delay}s): thread="${threadId}", found msgId="${rows[0].msg_id}", empId="${empId}"`);
                                            }
                                        });
                                    }
                                } catch {}
                            }, delay);
                        };
                        doFallbackUpdate(2000);
                        doFallbackUpdate(5000);
                    }

                    // Broadcast sender info to ALL employees so they know who replied
                    if (msgId || threadId) {
                        const senderPayload = {
                            zaloId,
                            threadId,
                            msgId,
                            employee_id: employee.employee_id,
                            employee_name: employee.display_name,
                            employee_avatar: employee.avatar_url || '',
                            channel,
                        };
                        // Push to all connected employees
                        for (const emp of this.employees.values()) {
                            if (!this.pushViaSSE(emp.employee_id, 'relay:messageSentByEmployee', senderPayload)) {
                                if (emp.callbackUrl) {
                                    this.pushToEmployee(emp, 'relay:messageSentByEmployee', senderPayload).catch(() => {});
                                } else {
                                    // WAN mode - queue for delivery on reconnect
                                    this.queueSseEvent(emp.employee_id, 'relay:messageSentByEmployee', senderPayload);
                                }
                            }
                        }
                        // Also emit to local renderer (boss side)
                        Logger.log(`[HttpRelayService] 📡 Emitting relay:messageSentByEmployee to boss renderer: msgId="${msgId}", empId="${employee.employee_id}", threadId="${threadId}"`);
                        EventBroadcaster.emit('relay:messageSentByEmployee', senderPayload);
                    }
                }

                return result;
            }

            // Fallback: ipcMain._invokeHandlers
            const { ipcMain } = require('electron');
            const internalHandlers: Map<string, Function> | undefined = (ipcMain as any)._invokeHandlers;
            if (internalHandlers && internalHandlers.has(channel)) {
                return await internalHandlers.get(channel)!(null, params);
            }

            return { success: false, error: `No handler for channel: ${channel}` };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Proxy error (${channel}): ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    // ─── Sync handlers ────────────────────────────────────────────────

    private handleSyncSnapshot(req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            const employee = this.authenticateRequest(req);
            if (!employee) {
                return this.json(res, 401, { success: false, error: 'Unauthorized' });
            }

            employee.lastSeen = Date.now();

            const snapshot = this.buildEmployeeSnapshot(employee.employee_id);
            this.json(res, 200, { success: true, snapshot });
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Snapshot error: ${err.message}`);
            this.json(res, 500, { success: false, error: err.message });
        }
    }

    // ─── SSE stream handler ───────────────────────────────────────────

    private handleSSEStream(req: http.IncomingMessage, res: http.ServerResponse): void {
        const employee = this.authenticateRequest(req);
        if (!employee) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        employee.lastSeen = Date.now();
        employee.consecutiveFailures = 0;

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });

        // Send initial ping so client knows it's connected
        res.write(': connected\n\n');

        // Replace any previous SSE stream for this employee
        const old = this.sseClients.get(employee.employee_id);
        if (old && old !== res) {
            Logger.warn(`[HttpRelayService] ⚠️ Replacing EXISTING SSE for ${employee.display_name} - old.end() called. New request from ${req.socket?.remoteAddress || 'unknown'}`);
            try { old.end(); } catch {}
            const oldKt = this.sseKeepaliveTimers.get(employee.employee_id);
            if (oldKt) clearInterval(oldKt);
            this.sseLastWriteOk.delete(employee.employee_id);
        } else if (!old) {
            Logger.log(`[HttpRelayService] ℹ️ First SSE connection for ${employee.display_name} from ${req.socket?.remoteAddress || 'unknown'}`);
        }
        this.sseClients.set(employee.employee_id, res);
        // Reset health tracking for the new SSE connection
        this.sseLastWriteOk.set(employee.employee_id, Date.now());

        // ── Flush any events queued while SSE was disconnected ──
        const queued = this.sseEventQueue.get(employee.employee_id) || [];
        if (queued.length > 0) {
            this.sseEventQueue.delete(employee.employee_id);
            const now = Date.now();
            let flushed = 0;
            for (const ev of queued) {
                if (now - ev.ts >= HttpRelayService.SSE_QUEUE_TTL_MS) continue; // expired
                try {
                    res.write(`data: ${JSON.stringify({ channel: ev.channel, data: ev.data })}\n\n`);
                    flushed++;
                } catch {
                    // SSE already broken again - stop flushing
                    break;
                }
            }
            if (flushed > 0) {
                Logger.log(`[HttpRelayService] 📬 Flushed ${flushed}/${queued.length} queued SSE events to ${employee.display_name}`);
            }
        }

        // Keepalive ping every 25s to prevent proxy/tunnel timeout
        const keepalive = setInterval(() => {
            try {
                res.write(': ping\n\n');
                this.sseLastWriteOk.set(employee.employee_id, Date.now());
            } catch {
                clearInterval(keepalive);
                if (this.sseClients.get(employee.employee_id) === res) {
                    this.sseClients.delete(employee.employee_id);
                    this.sseKeepaliveTimers.delete(employee.employee_id);
                    this.sseLastWriteOk.delete(employee.employee_id);
                }
            }
        }, 25_000);
        this.sseKeepaliveTimers.set(employee.employee_id, keepalive);

        Logger.log(`[HttpRelayService] 📡 SSE stream opened for ${employee.display_name}`);

        // Push initial snapshot via SSE
        try {
            const snapshot = this.buildEmployeeSnapshot(employee.employee_id);
            if (snapshot) {
                res.write(`data: ${JSON.stringify({ channel: 'relay:initialState', data: snapshot })}\n\n`);
            }
        } catch {}

        req.on('close', () => {
            clearInterval(keepalive);
            if (this.sseClients.get(employee.employee_id) === res) {
                this.sseClients.delete(employee.employee_id);
                this.sseKeepaliveTimers.delete(employee.employee_id);
                this.sseLastWriteOk.delete(employee.employee_id);
            }
            Logger.log(`[HttpRelayService] 📡 SSE stream closed for ${employee.display_name}`);
        });
    }

    // ═════════════════════════════════════════════════════════════════
    // MEDIA UPLOAD (multipart/form-data)
    // ═════════════════════════════════════════════════════════════════

    /**
     * Handle media upload via raw binary (Content-Type: application/octet-stream).
     * Employee sends file binary directly (không base64).
     * Headers: X-Filename (required), X-Zalo-Id (optional)
     * Boss saves to media storage, returns absolute path.
     */
    private handleMediaUploadMultipart(req: http.IncomingMessage, res: http.ServerResponse): void {
        const employee = this.authenticateRequest(req);
        if (!employee) {
            return this.json(res, 401, { success: false, error: 'Unauthorized' });
        }

        const filename = req.headers['x-filename'] as string;
        if (!filename) {
            return this.json(res, 400, { success: false, error: 'Missing X-Filename header' });
        }
        const zaloId = (req.headers['x-zalo-id'] as string) || employee.assigned_accounts[0] || '';

        const FileStorageService = require('../file/FileStorageService').default;
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
            try {
                const buffer = Buffer.concat(chunks);
                if (buffer.length === 0) {
                    return this.json(res, 400, { success: false, error: 'Empty file' });
                }

                // Save to Boss storage
                let bossPath: string;
                if (zaloId) {
                    bossPath = await FileStorageService.saveBuffer(zaloId, buffer, filename);
                } else {
                    const fs = require('fs');
                    const path = require('path');
                    const dir = path.join(FileStorageService.getBaseDir(), '_uploads');
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    bossPath = path.join(dir, filename);
                    fs.writeFileSync(bossPath, buffer);
                }

                Logger.log(`[HttpRelayService] Binary upload: ${filename} (${(buffer.length / 1024).toFixed(1)}KB) → ${bossPath}`);
                this.json(res, 200, { success: true, bossPath });
            } catch (err: any) {
                Logger.error(`[HttpRelayService] Upload error: ${err.message}`);
                this.json(res, 500, { success: false, error: err.message });
            }
        });
    }

    // ═════════════════════════════════════════════════════════════════
    // REST API HANDLER — dispatch to RestApiHandlers or MediaHandler
    // ═════════════════════════════════════════════════════════════════

    private handleRestApi(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = req.url || '';

        // ── Media serving (không cần auth — tunnel security) ──
        if (req.method === 'GET' && url.startsWith('/api/media/')) {
            // Luôn dùng default workspace (Boss) media path, không dùng active workspace
            // Vì khi employee workspace active, getBaseDir() trả về path của employee
            // → Boss không tìm thấy file của chính nó → 404
            let mediaBasePath = '';
            try {
                const WorkspaceManager = require('../../utils/WorkspaceManager').default;
                const wm = WorkspaceManager.getInstance();
                const defaultWs = wm.getWorkspaceById('default');
                if (defaultWs && defaultWs.dbPath) {
                    const dbFolder = path.dirname(wm.resolveDbPath(defaultWs.dbPath));
                    mediaBasePath = path.join(dbFolder, 'media');
                }
            } catch {}
            if (!mediaBasePath) {
                mediaBasePath = FileStorageService.getBaseDir?.() || '';
            }
            if (!mediaBasePath) {
                return this.json(res, 500, { error: 'Media path not configured' });
            }
            return handleMediaFileServe(req, res, mediaBasePath);
        }

        // ── Library file/thumb serving (không cần auth — tunnel security, cần runOnPinnedDb) ──
        if (req.method === 'GET') {
            const pathname = url.indexOf('?') >= 0 ? url.slice(0, url.indexOf('?')) : url;
            if (pathname.match(/^\/api\/library\/file\/[a-f0-9-]+$/)) {
                const uuid = pathname.split('/').pop() || '';
                this.runOnPinnedDb(() => libraryHandlers.serveFile(req, res, uuid));
                return;
            }
            if (pathname.match(/^\/api\/library\/thumb\/[a-f0-9-]+$/)) {
                const uuid = pathname.split('/').pop() || '';
                this.runOnPinnedDb(() => libraryHandlers.serveThumb(req, res, uuid));
                return;
            }
        }

        // ── Các endpoint khác cần auth ──
        const employee = this.authenticateRequest(req);
        if (!employee) {
            return this.json(res, 401, { success: false, error: 'Unauthorized' });
        }

        // Parse URL để dispatch
        const method = req.method;
        let params: any = {};

        // Parse query params từ URL — auto-parse JSON objects/arrays
        const queryIndex = url.indexOf('?');
        const pathname = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
        if (queryIndex >= 0) {
            const searchParams = new URLSearchParams(url.slice(queryIndex));
            for (const [k, v] of searchParams) {
                if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
                    try { params[k] = JSON.parse(v); continue; } catch {}
                }
                params[k] = v;
            }
        }

        // ── Điều phối dựa trên URL pattern (chạy trong pinned DB context) ──
        try {
            return this.runOnPinnedDb(() => {
                const _db = DatabaseService.getInstance();
                console.log(`[HttpRelayService] 🔄 Handling ${method} ${pathname} — DB: ${_db?.getDbPath?.() || 'unknown'}`);

            // Boot
            if (method === 'GET' && pathname === '/api/boot') {
                return this.json(res, 200, restHandlers.getBoot(employee, params));
            }

            // Conversations
            if (method === 'GET' && pathname === '/api/query/conversations') {
                return this.json(res, 200, restHandlers.getConversations(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/conversations/updates') {
                return this.json(res, 200, restHandlers.getConversationsUpdates(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/conversations/flags') {
                const zaloId = params.zaloId || employee.assigned_accounts[0];
                if (!zaloId) return this.json(res, 400, { error: 'Missing zaloId' });
                const rows = this.getCachedRestResult(method, pathname, employee.employee_id,
                    () => DatabaseService.getInstance().getContactsWithFlags(zaloId) || []);
                return this.json(res, 200, { success: true, data: { items: rows } });
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/conversations\/[^/]+$/)) {
                const contactId = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getConversationById(employee, { ...params, contactId }));
            }

            // Messages
            if (method === 'GET' && pathname === '/api/query/messages/around') {
                return this.json(res, 200, restHandlers.getMessagesAround(employee, { ...params, msgId: params.msgId }));
            }
            if (method === 'GET' && pathname === '/api/query/messages/file') {
                return this.json(res, 200, restHandlers.getFileMessages(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/messages/media') {
                return this.json(res, 200, restHandlers.getMediaMessages(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/messages') {
                return this.json(res, 200, restHandlers.getMessages(employee, params));
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/messages\/[^/]+$/)) {
                const msgId = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getMessageById(employee, { ...params, msgId }));
            }

            // Search
            if (method === 'GET' && pathname === '/api/search/messages') {
                return this.json(res, 200, restHandlers.searchMessages(employee, params));
            }

            // Friends
            if (method === 'GET' && pathname === '/api/query/friends') {
                return this.json(res, 200, restHandlers.getFriends(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/friends/check') {
                return this.json(res, 200, restHandlers.getFriendCheck(employee, params));
            }

            // Friend requests
            if (method === 'GET' && pathname === '/api/query/friend-requests') {
                return this.json(res, 200, restHandlers.getFriendRequests(employee, params));
            }

            // Groups
            if (method === 'GET' && pathname === '/api/query/groups/members') {
                return this.json(res, 200, restHandlers.getGroupMembers(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/groups/all') {
                return this.json(res, 200, restHandlers.getAllGroupMembers(employee, params));
            }

            // CRM
            if (method === 'GET' && pathname === '/api/query/crm/notes') {
                return this.json(res, 200, restHandlers.getCRMNotes(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/campaigns') {
                return this.json(res, 200, restHandlers.getCRMCampaigns(employee, params));
            }

            // Labels (cached — called redundantly after every message, blocks main thread)
            if (method === 'GET' && pathname === '/api/query/labels') {
                return this.json(res, 200, this.getCachedRestResult(method, pathname, employee.employee_id,
                    () => restHandlers.getLabels(employee, params)));
            }
            if (method === 'GET' && pathname === '/api/query/label-threads') {
                return this.json(res, 200, this.getCachedRestResult(method, pathname, employee.employee_id,
                    () => restHandlers.getLabelThreads(employee, params)));
            }

            // Quick messages
            if (method === 'GET' && pathname === '/api/query/quick-messages') {
                return this.json(res, 200, restHandlers.getQuickMessages(employee, params));
            }

            // Drafts
            if (method === 'GET' && pathname === '/api/query/drafts') {
                return this.json(res, 200, restHandlers.getDrafts(employee, params));
            }

            // Links
            if (method === 'GET' && pathname === '/api/query/links') {
                return this.json(res, 200, restHandlers.getLinks(employee, params));
            }

            // Settings
            if (method === 'GET' && pathname.match(/^\/api\/query\/settings\/[^/]+$/)) {
                const key = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getSetting(employee, { ...params, key }));
            }

            // Pinned conversations (cached — called redundantly after every message)
            if (method === 'GET' && pathname === '/api/query/pinned-conversations') {
                return this.json(res, 200, this.getCachedRestResult(method, pathname, employee.employee_id,
                    () => restHandlers.getPinnedConversations(employee, params)));
            }

            // Settings — all
            if (method === 'GET' && pathname === '/api/query/settings') {
                const allSettings = DatabaseService.getInstance().query<any>('SELECT key, value FROM app_settings') || [];
                return this.json(res, 200, { success: true, data: { items: allSettings } });
            }

            // Analytics / Dashboard
            if (method === 'GET' && pathname === '/api/query/analytics/dashboard') {
                return this.json(res, 200, restHandlers.getDashboardOverview(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/message-volume') {
                return this.json(res, 200, restHandlers.getMessageVolume(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/peak-hours') {
                return this.json(res, 200, restHandlers.getPeakHours(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/segmentation') {
                return this.json(res, 200, restHandlers.getContactSegmentation(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/campaign-comparison') {
                return this.json(res, 200, restHandlers.getCampaignComparison(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/friend-requests') {
                return this.json(res, 200, restHandlers.getFriendRequestAnalytics(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/contact-growth') {
                return this.json(res, 200, restHandlers.getContactGrowth(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/workflows') {
                return this.json(res, 200, restHandlers.getWorkflowAnalytics(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/ai') {
                return this.json(res, 200, restHandlers.getAIAnalytics(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/response-time') {
                return this.json(res, 200, restHandlers.getResponseTime(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/label-usage') {
                return this.json(res, 200, restHandlers.getLabelUsage(employee, params));
            }

            // ── Notif settings ──
            if (method === 'GET' && pathname === '/api/query/settings/notif') {
                const val = DatabaseService.getInstance().getSetting(`notifSettings_${params.zaloId}`);
                return this.json(res, 200, { success: true, data: val ? JSON.parse(val) : null });
            }

            // ── Pinned messages ──
            if (method === 'GET' && pathname === '/api/query/pinned-messages') {
                return this.json(res, 200, restHandlers.getPinnedMessages(employee, params));
            }

            // ── Stickers ──
            if (method === 'GET' && pathname === '/api/query/sticker-packs') {
                return this.json(res, 200, restHandlers.getStickerPacksHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/stickers/recent') {
                return this.json(res, 200, restHandlers.getRecentStickersHandler(employee, params));
            }
            if ((method === 'POST' || method === 'GET') && pathname === '/api/query/stickers/by-ids') {
                return this.json(res, 200, restHandlers.getStickersByIdsHandler(employee, params));
            }

            // ── CRM tags ──
            if (method === 'GET' && pathname === '/api/query/crm/tags') {
                return this.json(res, 200, restHandlers.getCRMTagsHandler(employee, params));
            }

            // ── Bank cards ──
            if (method === 'GET' && pathname === '/api/query/bank-cards') {
                return this.json(res, 200, restHandlers.getBankCardsHandler(employee, params));
            }

            // ── ERP Tasks ──
            if (method === 'GET' && pathname === '/api/query/erp/projects') {
                return this.json(res, 200, restHandlers.getErpProjects(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/erp/tasks') {
                return this.json(res, 200, restHandlers.getErpTasks(employee, params));
            }
            // ⚠️ Specific routes MUST come BEFORE the regex catch-all
            if (method === 'GET' && pathname === '/api/query/erp/tasks/inbox') {
                return this.json(res, 200, restHandlers.getErpMyInbox(employee, params));
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/erp\/tasks\/[^/]+$/)) {
                const id = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getErpTaskDetail(employee, { ...params, id }));
            }

            // ── ERP Departments / Positions / Profiles ──
            if (method === 'GET' && pathname === '/api/query/erp/departments') {
                return this.json(res, 200, restHandlers.getErpDepartments(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/erp/positions') {
                return this.json(res, 200, restHandlers.getErpPositions(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/erp/profiles') {
                return this.json(res, 200, restHandlers.getErpProfiles(employee, params));
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/erp\/profiles\/[^/]+$/)) {
                const employeeId = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getErpProfile(employee, { ...params, employeeId }));
            }

            // ── ERP Calendar ──
            if (method === 'GET' && pathname === '/api/query/erp/calendar/events') {
                return this.json(res, 200, restHandlers.getErpCalendarEvents(employee, params));
            }

            // ── Proxies ──
            if (method === 'GET' && pathname === '/api/query/proxies') {
                return this.json(res, 200, restHandlers.getProxies(employee, params));
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/proxies\/\d+$/)) {
                const id = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getProxyById(employee, { ...params, id }));
            }

            // ── Friends last fetched ──
            if (method === 'GET' && pathname === '/api/query/friends/last-fetched') {
                return this.json(res, 200, restHandlers.getFriendsLastFetchedHandler(employee, params));
            }

            // ── Stickers extended ──
            if (method === 'GET' && pathname === '/api/query/stickers/by-id') {
                return this.json(res, 200, restHandlers.getStickerByIdHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/stickers/keyword') {
                return this.json(res, 200, restHandlers.getKeywordStickersHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/sticker-packs/summaries') {
                return this.json(res, 200, restHandlers.getCachedPackSummariesHandler(employee, params));
            }

            // ── CRM extended ──
            if (method === 'GET' && pathname === '/api/query/crm/contacts') {
                return this.json(res, 200, restHandlers.getCRMContactsHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/contacts/stats') {
                return this.json(res, 200, restHandlers.getContactStatsHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/campaigns/contacts') {
                return this.json(res, 200, restHandlers.getCampaignContactsHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/campaigns/send-log') {
                return this.json(res, 200, restHandlers.getSendLogHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/queue-status') {
                return this.json(res, 200, restHandlers.getQueueStatusHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/campaigns/stats') {
                return this.json(res, 200, restHandlers.getCampaignStatsHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/activity-stats') {
                return this.json(res, 200, restHandlers.getActivityStatsHandler(employee, params));
            }

            // ── Messages extended ──
            if (method === 'GET' && pathname === '/api/query/messages/unread') {
                return this.json(res, 200, restHandlers.getUnreadCountHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/messages/by-type') {
                return this.json(res, 200, restHandlers.getMessagesByTypeHandler(employee, params));
            }

            // ── Quick Messages all ──
            if (method === 'GET' && pathname === '/api/query/quick-messages/all') {
                return this.json(res, 200, restHandlers.getAllQuickMessagesHandler(employee, params));
            }

            // ── Labels: thread labels ──
            if (method === 'GET' && pathname === '/api/query/label-threads/thread') {
                return this.json(res, 200, restHandlers.getThreadLabelsHandler(employee, params));
            }

            // ── Drafts: single ──
            if (method === 'GET' && pathname === '/api/query/drafts/single') {
                return this.json(res, 200, restHandlers.getSingleDraftHandler(employee, params));
            }

            // ── Workflows ──
            if (method === 'GET' && pathname === '/api/query/workflows') {
                return this.json(res, 200, restHandlers.getWorkflows(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/workflows/run-logs') {
                return this.json(res, 200, restHandlers.getRecentRunLogs(employee, params));
            }
            // /api/query/workflows/{id}/run-logs
            if (method === 'GET' && pathname.match(/^\/api\/query\/workflows\/[^/]+\/run-logs$/)) {
                const parts = pathname.split('/');
                const id = parts[4];
                return this.json(res, 200, restHandlers.getWorkflowRunLogs(employee, { ...params, workflowId: id }));
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/workflows\/[^/]+$/)) {
                const id = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getWorkflowById(employee, { ...params, id }));
            }

            // ── Integrations ──
            if (method === 'GET' && pathname === '/api/query/integrations') {
                return this.json(res, 200, restHandlers.getIntegrations(employee, params));
            }

            // ── AI Assistants ──
            if (method === 'GET' && pathname === '/api/query/ai/assistants') {
                return this.json(res, 200, restHandlers.getAiAssistants(employee, params));
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/ai\/assistants\/([^/]+)\/files$/)) {
                const id = pathname.split('/')[5];
                return this.json(res, 200, restHandlers.getAiAssistantFiles(employee, { ...params, assistantId: id, id }));
            }
            if (method === 'GET' && pathname.match(/^\/api\/query\/ai\/assistants\/([^/]+)$/)) {
                const id = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getAiAssistant(employee, { ...params, id }));
            }
            if (method === 'GET' && pathname === '/api/query/ai/usage-stats') {
                return this.json(res, 200, restHandlers.getAiUsageStats(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/ai/usage-logs') {
                return this.json(res, 200, restHandlers.getAiUsageLogs(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/ai/default') {
                return this.json(res, 200, restHandlers.getAiDefaultAssistant(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/ai/account-assistant') {
                return this.json(res, 200, restHandlers.getAiAccountAssistant(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/ai/account-assistants') {
                return this.json(res, 200, restHandlers.getAiAccountAssistants(employee, params));
            }

            // ── AI Chat & Suggest (async — proxy LLM calls qua Boss) ──
            if (method === 'POST' && pathname === '/api/command/ai/chat') {
                this.readBody(req, async (body) => {
                    try {
                        const parsed = JSON.parse(body);
                        const AIAssistantService = require('../ai/AIAssistantService').default;
                        const result = await AIAssistantService.getInstance().chat(
                            parsed.assistantId || parsed.params?.assistantId,
                            parsed.messages || parsed.params?.messages || [],
                            parsed.structured === true || parsed.params?.structured === true,
                            parsed.maxTokens || parsed.params?.maxTokens || undefined
                        );
                        return this.json(res, 200, { success: true, ...result });
                    } catch (err: any) {
                        Logger.error(`[HttpRelayService] AI chat error: ${err.message}`);
                        return this.json(res, 200, { success: false, error: err.message });
                    }
                });
                return;
            }
            if (method === 'POST' && pathname === '/api/command/ai/suggest') {
                this.readBody(req, async (body) => {
                    try {
                        const parsed = JSON.parse(body);
                        const AIAssistantService = require('../ai/AIAssistantService').default;
                        const suggestions = await AIAssistantService.getInstance().getSuggestions(
                            parsed.assistantId || parsed.params?.assistantId,
                            parsed.chatHistory || parsed.params?.chatHistory || []
                        );
                        return this.json(res, 200, { success: true, suggestions });
                    } catch (err: any) {
                        Logger.error(`[HttpRelayService] AI suggest error: ${err.message}`);
                        return this.json(res, 200, { success: false, error: err.message, suggestions: [] });
                    }
                });
                return;
            }

            // ── COMMAND endpoints (WRITE) ──
            // Command handlers gọi trực tiếp DatabaseService
            if (method === 'POST' && pathname.startsWith('/api/command/')) {
                this.readBody(req, (body) => {
                    try {
                        const parsed = JSON.parse(body);
                        const result = this.executeRestCommand(employee, pathname, { ...params, ...parsed }, 'POST');
                        return this.json(res, 200, result);
                    } catch (err: any) {
                        return this.json(res, 400, { success: false, error: err.message });
                    }
                });
                return;
            }
            if ((method === 'PUT' || method === 'PATCH' || method === 'DELETE') && pathname.startsWith('/api/command/')) {
                this.readBody(req, (body) => {
                    try {
                        const parsed = body ? JSON.parse(body) : {};
                        const result = this.executeRestCommand(employee, pathname, { ...params, ...parsed }, method);
                        return this.json(res, 200, result);
                    } catch (err: any) {
                        return this.json(res, 400, { success: false, error: err.message });
                    }
                });
                return;
            }

            // ── LIBRARY endpoints ──
            if (method === 'POST' && pathname === '/api/library/upload') {
                return libraryHandlers.handleUpload(req, res, employee);
            }
            // Employee mode: upload via JSON base64 (DataAccessor gửi qua RestQueryService)
            if (method === 'POST' && pathname === '/api/library/upload/json') {
                return libraryHandlers.handleUploadJson(req, res, employee);
            }
            if (method === 'GET' && pathname === '/api/library/items') {
                // Pass boss URL to build absolute fileUrl/thumbUrl for employee
                const proto = req.headers['x-forwarded-proto'] || 'http';
                const host = req.headers.host || '';
                params._bossUrl = `${proto}://${host}`;
                return this.json(res, 200, libraryHandlers.getItems(employee, params));
            }
            if (method === 'GET' && pathname.match(/^\/api\/library\/item\/[a-f0-9-]+$/)) {
                const uuid = pathname.split('/').pop() || '';
                const proto = req.headers['x-forwarded-proto'] || 'http';
                const host = req.headers.host || '';
                return this.json(res, 200, libraryHandlers.getItem(employee, { ...params, uuid, _bossUrl: `${proto}://${host}` }));
            }
            if (method === 'PATCH' && pathname.match(/^\/api\/library\/item\/[a-f0-9-]+$/)) {
                this.readBody(req, (body) => {
                    const parsed = JSON.parse(body);
                    return this.json(res, 200, libraryHandlers.updateItem(employee, { ...params, ...parsed }));
                });
                return;
            }
            if (method === 'DELETE' && pathname.match(/^\/api\/library\/item\/[a-f0-9-]+$/)) {
                const uuid = pathname.split('/').pop() || '';
                return this.json(res, 200, libraryHandlers.deleteItem(employee, { ...params, uuid }));
            }
            // Folders
            if (method === 'GET' && pathname === '/api/library/folders') {
                return this.json(res, 200, libraryHandlers.getFolders(employee, params));
            }
            if (method === 'POST' && pathname === '/api/library/folders') {
                this.readBody(req, (body) => {
                    const parsed = JSON.parse(body);
                    return this.json(res, 200, libraryHandlers.createFolder(employee, { ...params, ...parsed }));
                });
                return;
            }
            if (method === 'DELETE' && pathname.match(/^\/api\/library\/folders\/\d+$/)) {
                const id = pathname.split('/').pop() || '';
                return this.json(res, 200, libraryHandlers.deleteFolder(employee, { ...params, id }));
            }
            // Serve media files
            if (method === 'GET' && pathname.match(/^\/api\/library\/file\/[a-f0-9-]+$/)) {
                const uuid = pathname.split('/').pop() || '';
                return libraryHandlers.serveFile(req, res, uuid);
            }
            if (method === 'GET' && pathname.match(/^\/api\/library\/thumb\/[a-f0-9-]+$/)) {
                const uuid = pathname.split('/').pop() || '';
                return libraryHandlers.serveThumb(req, res, uuid);
            }

            return this.json(res, 404, { success: false, error: `Unknown endpoint: ${method} ${pathname}` });
            }); // end runOnPinnedDb
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Rest API error: ${err.message}`);
            this.json(res, 500, { success: false, error: err.message });
        }
    }

    /**
     * Execute a REST command (WRITE operations).
     * POST/PUT/PATCH/DELETE tới /api/command/*
     */
    private executeRestCommand(employee: any, pathname: string, params: any, _method?: string): any {
        const zaloId = params.zaloId || employee.assigned_accounts?.[0] || '';
        const db = DatabaseService.getInstance();
        const httpMethod = _method || 'POST';

        try {
            // ── Conversations ──
            if (pathname.match(/^\/api\/command\/conversations\/[^/]+\/flags$/)) {
                const contactId = pathname.split('/')[3];
                db.setContactFlags(zaloId, contactId, params.flags || {});
                EventBroadcaster.emit('db:contactFlagsChanged', { zaloId, contactId, flags: params.flags });
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/conversations\/[^/]+\/alias$/)) {
                const contactId = pathname.split('/')[3];
                db.setContactAlias(zaloId, contactId, params.alias || '');
                EventBroadcaster.emit('db:contactAliasChanged', { ownerZaloId: zaloId, contactId, alias: params.alias });
                return { success: true };
            }
            // MUST be BEFORE the generic delete pattern — the regex /^\/api\/command\/conversations\/[^/]+$/ would match "update-profile" as a contactId
            if (pathname === '/api/command/conversations/update-profile') {
                db.updateContactProfile(zaloId, params.contactId, params.displayName || '', params.avatarUrl || '', params.phone || '', params.contactType || '', params.gender ?? null, params.birthday ?? null);
                EventBroadcaster.emit('db:contactProfileUpdated', {
                    ownerZaloId: zaloId, contactId: params.contactId,
                    displayName: params.displayName, avatarUrl: params.avatarUrl,
                    phone: params.phone, gender: params.gender, birthday: params.birthday,
                });
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/conversations\/[^/]+$/)) {
                const contactId = pathname.split('/')[3];
                db.deleteConversation(zaloId, contactId);
                EventBroadcaster.emit('db:conversationDeleted', { zaloId, contactId, threadId: contactId });
                return { success: true };
            }

            // ── CRM Notes ──
            if (pathname === '/api/command/crm/notes') {
                const id = db.saveCRMNote({ ...params.note, owner_zalo_id: zaloId });
                EventBroadcaster.emit('crm:noteChanged', { action: 'save', ownerZaloId: zaloId, id, note: params.note });
                return { success: true, data: { id } };
            }
            if (pathname.match(/^\/api\/command\/crm\/notes\/\d+$/)) {
                const noteId = parseInt(pathname.split('/').pop() || '0');
                db.deleteCRMNote(noteId, zaloId);
                EventBroadcaster.emit('crm:noteChanged', { action: 'delete', ownerZaloId: zaloId, noteId });
                return { success: true };
            }

            // ── CRM Campaigns ──
            if (pathname === '/api/command/crm/campaigns') {
                const id = db.saveCRMCampaign({ ...params.campaign, owner_zalo_id: zaloId });
                EventBroadcaster.emit('crm:campaignChanged', { action: 'save', ownerZaloId: zaloId, id, campaign: params.campaign });
                return { success: true, data: { id } };
            }
            if (pathname.match(/^\/api\/command\/crm\/campaigns\/\d+$/)) {
                const campaignId = parseInt(pathname.split('/').pop() || '0');
                db.deleteCRMCampaign(campaignId, zaloId);
                EventBroadcaster.emit('crm:campaignChanged', { action: 'delete', ownerZaloId: zaloId, campaignId });
                return { success: true };
            }

            // ── Labels ──
            if (pathname === '/api/command/labels') {
                const id = db.upsertLocalLabel(params.label);
                EventBroadcaster.emit('db:localLabelChanged', { action: 'upsert', label: { ...params.label, id } });
                return { success: true, data: { id } };
            }
            if (pathname.match(/^\/api\/command\/labels\/\d+$/)) {
                const id = parseInt(pathname.split('/').pop() || '0');
                db.deleteLocalLabel(id);
                EventBroadcaster.emit('db:localLabelChanged', { action: 'delete', labelId: id });
                return { success: true };
            }
            if (pathname === '/api/command/label-threads') {
                if (httpMethod === 'DELETE') {
                    db.removeLocalLabelFromThread(zaloId, params.labelId, params.threadId);
                    EventBroadcaster.emit('db:localLabelThreadChanged', { action: 'remove', ownerZaloId: zaloId, labelId: params.labelId, threadId: params.threadId });
                } else {
                    db.assignLocalLabelToThread(zaloId, params.labelId, params.threadId);
                    EventBroadcaster.emit('db:localLabelThreadChanged', { action: 'assign', ownerZaloId: zaloId, labelId: params.labelId, threadId: params.threadId });
                }
                return { success: true };
            }

            // ── Quick Messages ──
            if (pathname === '/api/command/quick-messages') {
                const id = db.upsertLocalQuickMessage(zaloId, params.item);
                EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'upsert', ownerZaloId: zaloId, item: { ...params.item, id } });
                return { success: true, data: { id } };
            }
            if (pathname.match(/^\/api\/command\/quick-messages\/\d+$/)) {
                const id = parseInt(pathname.split('/').pop() || '0');
                if (httpMethod === 'DELETE') {
                    db.deleteLocalQuickMessage(zaloId, id);
                    EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'delete', id, ownerZaloId: zaloId });
                }
                return { success: true };
            }

            // ── Drafts ──
            if (pathname.match(/^\/api\/command\/drafts\/[^/]+$/)) {
                const threadId = pathname.split('/').pop() || '';
                if (httpMethod === 'DELETE') {
                    db.deleteDraft(zaloId, threadId);
                } else {
                    db.upsertDraft(zaloId, threadId, params.content || '');
                }
                return { success: true };
            }

            // ── Pinned Conversations ──
            if (pathname === '/api/command/pinned-conversations') {
                db.setLocalPinnedConversation(zaloId, params.threadId, params.isPinned);
                EventBroadcaster.emit('db:pinnedConversationChanged', { ownerZaloId: zaloId, threadId: params.threadId, isPinned: !!params.isPinned });
                return { success: true };
            }

            // ── Settings ──
            if (pathname.match(/^\/api\/command\/settings\/[^/]+$/)) {
                const key = pathname.split('/').pop() || '';
                db.setSetting(key, params.value || '');
                return { success: true };
            }

            // ── Pinned Messages ──
            if (pathname === '/api/command/pinned-messages') {
                db.pinMessage(zaloId, params.threadId, params.pin);
                EventBroadcaster.emit('db:pinnedMessageChanged', { action: 'pin', ownerZaloId: zaloId, threadId: params.threadId, pin: params.pin });
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/pinned-messages\/[^/]+$/)) {
                const msgId = pathname.split('/').pop() || '';
                if (httpMethod === 'DELETE') {
                    db.unpinMessage(zaloId, params.threadId, msgId);
                    EventBroadcaster.emit('db:pinnedMessageChanged', { action: 'unpin', ownerZaloId: zaloId, threadId: params.threadId, msgId, zaloId });
                } else if (msgId === 'bring-to-top') {
                    db.bringPinnedToTop(zaloId, params.threadId, params.msgId);
                    EventBroadcaster.emit('db:pinnedMessageChanged', { action: 'bringToTop', ownerZaloId: zaloId, threadId: params.threadId, msgId: params.msgId });
                }
                return { success: true };
            }

            // ── Stickers ──
            if (pathname === '/api/command/stickers/save') {
                db.saveStickers(params.stickers || []);
                return { success: true };
            }
            if (pathname === '/api/command/sticker-packs/save') {
                db.saveStickerPacks(params.packs || []);
                return { success: true };
            }

            // ── CRM Tags (query trực tiếp + emit) ──
            if (pathname === '/api/command/crm/tags') {
                const tag = params.tag || params;
                const existing = db.queryOne<any>(`SELECT id FROM crm_tags WHERE owner_zalo_id=? AND name=?`, [zaloId, tag.name]);
                if (existing) {
                    db.run(`UPDATE crm_tags SET name=?,color=? WHERE id=?`, [tag.name, tag.color, existing.id]);
                    EventBroadcaster.emit('crm:tagChanged', { action: 'update', ownerZaloId: zaloId, tag: { ...tag, id: existing.id } });
                    return { success: true, data: { id: existing.id } };
                }
                const rowId = db.runInsert(`INSERT INTO crm_tags (owner_zalo_id,name,color) VALUES (?,?,?)`, [zaloId, tag.name, tag.color]);
                EventBroadcaster.emit('crm:tagChanged', { action: 'create', ownerZaloId: zaloId, tag: { ...tag, id: rowId } });
                return { success: true, data: { id: rowId } };
            }
            if (pathname.match(/^\/api\/command\/crm\/tags\/\d+$/)) {
                const id = parseInt(pathname.split('/').pop() || '0');
                db.run(`DELETE FROM crm_contact_tags WHERE tag_id=?`, [id]);
                db.run(`DELETE FROM crm_tags WHERE id=?`, [id]);
                EventBroadcaster.emit('crm:tagChanged', { action: 'delete', ownerZaloId: zaloId, tagId: id });
                return { success: true };
            }
            if (pathname === '/api/command/crm/tags/assign') {
                db.run(`INSERT OR IGNORE INTO crm_contact_tags (owner_zalo_id,tag_id,contact_id) VALUES (?,?,?)`,
                    [zaloId, params.tagId, params.contactId]);
                EventBroadcaster.emit('crm:tagChanged', { action: 'assign', ownerZaloId: zaloId, tagId: params.tagId, contactId: params.contactId });
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/crm\/tags\/\d+\/contacts\/[^/]+$/)) {
                const parts = pathname.split('/');
                const tagId = parseInt(parts[4] || '0');
                const contactId = parts[6] || '';
                db.run(`DELETE FROM crm_contact_tags WHERE owner_zalo_id=? AND tag_id=? AND contact_id=?`,
                    [zaloId, tagId, contactId]);
                EventBroadcaster.emit('crm:tagChanged', { action: 'remove', ownerZaloId: zaloId, tagId, contactId });
                return { success: true };
            }

            // ── Bank Cards ──
            if (pathname === '/api/command/bank-cards') {
                const id = db.upsertBankCard(zaloId, { ...params.card, ...params });
                return { success: true, data: { id } };
            }
            if (pathname.match(/^\/api\/command\/bank-cards\/\d+$/)) {
                const id = parseInt(pathname.split('/').pop() || '0');
                db.deleteBankCard(zaloId, id);
                return { success: true };
            }

            // ── Proxies CRUD ──
            if (pathname === '/api/command/proxies') {
                const id = db.saveProxy(params.proxy || params);
                return { success: true, data: { id } };
            }
            if (pathname.match(/^\/api\/command\/proxies\/\d+$/)) {
                const id = parseInt(pathname.split('/').pop() || '0');
                db.deleteProxy(id);
                return { success: true };
            }
            if (pathname === '/api/command/accounts/proxy') {
                // Assign proxy to account: params.zaloId, params.proxyId
                db.run('UPDATE accounts SET proxy_id=? WHERE zalo_id=?', [params.proxyId || null, params.zaloId || zaloId]);
                return { success: true };
            }

            // ── Messages — mark-read, mark-recalled, delete, reaction, local-paths ──
            if (pathname === '/api/command/messages/mark-read') {
                db.markAsRead(zaloId, params.contactId);
                EventBroadcaster.emit('db:unreadChanged', { zaloId, contactId: params.contactId, unread: 0 });
                return { success: true };
            }
            if (pathname === '/api/command/messages/mark-recalled') {
                db.markMessageRecalled(zaloId, params.msgId);
                // event:undo đã được relay từ Zalo webhook — emit thêm để đồng bộ
                EventBroadcaster.emit('event:undo', { zaloId, msgId: params.msgId });
                return { success: true };
            }
            if (pathname === '/api/command/messages/delete') {
                db.deleteMessages(zaloId, params.msgIds || []);
                EventBroadcaster.emit('event:delete', { zaloId, msgIds: params.msgIds || [] });
                return { success: true };
            }
            if (pathname === '/api/command/messages/reaction') {
                // Note: boss DB is already updated by EventBroadcaster.broadcastReaction()
                // via runOnBossDb. Only the employee DB needs updating here, which was
                // already done by HttpClientService.saveRelayReactionToWorkspaceDb().
                // Do NOT emit event:reaction back to renderer — it was already forwarded
                // by HttpClientService via sendDirect, and emitting again causes double display.
                return { success: true };
            }
            if (pathname === '/api/command/messages/local-paths') {
                db.updateLocalPaths(zaloId, params.msgId, params.localPaths || {});
                EventBroadcaster.emit('event:localPath', { zaloId, msgId: params.msgId, threadId: params.threadId || '', localPaths: params.localPaths });
                return { success: true };
            }

            // ── Stickers — recent, keyword ──
            if (pathname === '/api/command/stickers/recent') {
                db.addRecentSticker(parseInt(params.stickerId) || 0);
                return { success: true };
            }
            if (pathname === '/api/command/stickers/keyword') {
                db.saveKeywordStickers(params.keyword || '', params.stickerIds || []);
                return { success: true };
            }

            // ── CRM — cloneCampaign, updateStatus, addContacts ──
            if (pathname === '/api/command/crm/campaigns/clone') {
                const id = db.cloneCRMCampaign(parseInt(params.campaignId) || 0, zaloId, params.includeContacts, params.newName);
                EventBroadcaster.emit('crm:campaignChanged', { action: 'clone', ownerZaloId: zaloId, campaignId: id });
                return { success: true, data: { id } };
            }
            if (pathname === '/api/command/crm/campaigns/status') {
                db.updateCRMCampaignStatus(parseInt(params.campaignId) || 0, params.status);
                EventBroadcaster.emit('crm:campaignChanged', { action: 'status', ownerZaloId: zaloId, campaignId: parseInt(params.campaignId) || 0, status: params.status });
                return { success: true };
            }
            if (pathname === '/api/command/crm/campaigns/contacts') {
                db.addCampaignContacts(parseInt(params.campaignId) || 0, zaloId, params.contacts || []);
                return { success: true };
            }

            // ── Friends — CRUD ──
            if (pathname === '/api/command/friends/batch') {
                db.saveFriends(zaloId, params.friends || []);
                return { success: true };
            }
            if (pathname === '/api/command/friends') {
                db.addFriend(zaloId, params.friend || params);
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/friends\/[^/]+$/)) {
                const userId = pathname.split('/').pop() || '';
                db.removeFriend(zaloId, userId);
                return { success: true };
            }

            // ── Friend Requests — CRUD ──
            if (pathname === '/api/command/friend-requests') {
                db.upsertFriendRequest(zaloId, params.request || params, params.direction || 'received');
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/friend-requests\/[^/]+$/)) {
                const userId = pathname.split('/').pop() || '';
                db.removeFriendRequest(zaloId, userId, params.direction || 'received');
                return { success: true };
            }

            // ── Groups — upsert/remove member ──
            if (pathname === '/api/command/groups/members/upsert') {
                db.upsertGroupMember(zaloId, params.groupId, params.member);
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/groups\/members\/[^/]+$/)) {
                const memberId = pathname.split('/').pop() || '';
                db.removeGroupMember(zaloId, params.groupId || params.group_id, memberId);
                return { success: true };
            }

            // ── Links ──
            if (pathname === '/api/command/links') {
                db.saveLink(zaloId, params.threadId, params.msgId, params.url, params.title, params.domain, params.thumbUrl, parseInt(params.timestamp) || Date.now());
                return { success: true };
            }

            // ── Quick Messages — bulk-replace, clone, setActive, setOrder ──
            if (pathname === '/api/command/quick-messages/bulk-replace') {
                db.bulkReplaceLocalQuickMessages(zaloId, params.items || []);
                EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'bulkReplace', ownerZaloId: zaloId });
                return { success: true };
            }
            if (pathname === '/api/command/quick-messages/clone') {
                const count = db.cloneLocalQuickMessages(params.sourceZaloId, params.targetZaloId);
                return { success: true, data: { count } };
            }
            if (pathname.match(/^\/api\/command\/quick-messages\/\d+\/active$/)) {
                const id = parseInt(pathname.split('/')[4]);
                db.setLocalQMActive(id, params.isActive ?? 1);
                EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'active', id, isActive: params.isActive ?? 1 });
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/quick-messages\/\d+\/order$/)) {
                const id = parseInt(pathname.split('/')[4]);
                db.setLocalQMOrder(id, parseInt(params.order) || 0);
                EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'reorder', id, order: parseInt(params.order) || 0 });
                return { success: true };
            }

            // ── Labels — clone, setActive, setOrder ──
            if (pathname === '/api/command/labels/clone') {
                const count = db.cloneLocalLabels(params.sourceZaloId, params.targetZaloId);
                return { success: true, data: { count } };
            }
            if (pathname.match(/^\/api\/command\/labels\/\d+\/active$/)) {
                const id = parseInt(pathname.split('/')[3]);
                db.setLocalLabelActive(id, params.isActive ?? 1);
                EventBroadcaster.emit('db:localLabelChanged', { action: 'active', labelId: id, isActive: params.isActive ?? 1 });
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/labels\/\d+\/order$/)) {
                const id = parseInt(pathname.split('/')[3]);
                db.setLocalLabelOrder(id, parseInt(params.order) || 0);
                EventBroadcaster.emit('db:localLabelChanged', { action: 'reorder', labelId: id, order: parseInt(params.order) || 0 });
                return { success: true };
            }

            // ── Drafts — cleanup ──
            if (pathname === '/api/command/drafts/cleanup') {
                db.deleteOldDrafts(parseInt(params.days) || 7);
                return { success: true };
            }

            // ── Contacts — updatePhone ──
            if (pathname === '/api/command/accounts/phone') {
                db.updateAccountPhone(zaloId, params.phone || '');
                return { success: true };
            }

            // ── Workflow CRUD ──
            if (pathname === '/api/command/workflows') {
                try {
                    db.saveWorkflow(params.workflow || params);
                } catch (wfErr: any) {
                    return { success: false, error: wfErr.message };
                }
                EventBroadcaster.emit('workflow:executed', { action: 'save', workflowId: params.workflow?.id || params.id });
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/workflows\/[^/]+\/toggle$/)) {
                const id = pathname.split('/')[3];
                db.toggleWorkflow(id, params.enabled !== false);
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/workflows\/[^/]+$/)) {
                const id = pathname.split('/').pop() || '';
                db.deleteWorkflow(id);
                return { success: true };
            }

            // ── Integration CRUD ──
            if (pathname === '/api/command/integrations') {
                const { IntegrationRegistry } = require('../integrations/IntegrationRegistry');
                const saved = IntegrationRegistry.getInstance().saveIntegration(params.integration || params);
                return { success: true, data: saved };
            }
            if (pathname.match(/^\/api\/command\/integrations\/[^/]+\/toggle$/)) {
                const id = pathname.split('/')[3];
                const { IntegrationRegistry } = require('../integrations/IntegrationRegistry');
                IntegrationRegistry.getInstance().toggleIntegration(id, params.enabled !== false);
                return { success: true };
            }
            if (pathname.match(/^\/api\/command\/integrations\/[^/]+$/)) {
                const id = pathname.split('/').pop() || '';
                const { IntegrationRegistry } = require('../integrations/IntegrationRegistry');
                IntegrationRegistry.getInstance().deleteIntegration(id);
                return { success: true };
            }

            // ── AI Assistant CRUD ──
            if (pathname === '/api/command/ai/assistants') {
                const AIAssistantService = require('../ai/AIAssistantService').default;
                const savedId = AIAssistantService.getInstance().saveAssistant(params.assistant || params);
                return { success: true, id: savedId };
            }
            if (pathname.match(/^\/api\/command\/ai\/assistants\/[^/]+$/)) {
                const id = pathname.split('/').pop() || '';
                const AIAssistantService = require('../ai/AIAssistantService').default;
                AIAssistantService.getInstance().deleteAssistant(id);
                return { success: true };
            }

            // ── ERP Tasks ──
            if (pathname === '/api/command/erp/tasks') {
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                const task = ErpTaskService.getInstance().createTask(params.input || params, employee.employee_id);
                EventBroadcaster.emit('erp:event:taskCreated', { task });
                return { success: true, task };
            }
            // ⚠️ Specific routes BEFORE regex catch-all
            if (pathname === '/api/command/erp/tasks/assign') {
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                ErpTaskService.getInstance().assignTask(params.id, params.employeeIds || [], employee.employee_id);
                return { success: true };
            }
            if (pathname === '/api/command/erp/tasks/watcher') {
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                if (params.action === 'remove') {
                    ErpTaskService.getInstance().removeWatcher(params.taskId, params.employeeId || employee.employee_id);
                } else {
                    ErpTaskService.getInstance().addWatcher(params.taskId, params.employeeId || employee.employee_id);
                }
                return { success: true };
            }
            if (pathname === '/api/command/erp/tasks/comment') {
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                const comment = ErpTaskService.getInstance().addComment(params.taskId, employee.employee_id, params.content, params.mentions || []);
                return { success: true, comment };
            }
            if (pathname === '/api/command/erp/tasks/checklist') {
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                const item = ErpTaskService.getInstance().addChecklist(params.taskId, params.content);
                return { success: true, item };
            }
            if (pathname.match(/^\/api\/command\/erp\/tasks\/checklist\/\d+\/toggle$/)) {
                const checkId = parseInt(pathname.split('/')[6]);
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                const item = ErpTaskService.getInstance().toggleChecklist(checkId, !!params.done);
                return { success: true, item };
            }
            // Regex catch-all for tasks/{id} — MUST be after specific routes
            if (pathname.match(/^\/api\/command\/erp\/tasks\/[^/]+\/status$/)) {
                const taskId = pathname.split('/')[5];
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                const task = ErpTaskService.getInstance().updateTask(taskId, { status: params.status }, employee.employee_id);
                return { success: true, task };
            }
            if (pathname.match(/^\/api\/command\/erp\/tasks\/[^/]+$/)) {
                const taskId = pathname.split('/')[5];
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                if (httpMethod === 'DELETE') {
                    ErpTaskService.getInstance().deleteTask(taskId);
                    return { success: true };
                }
                // PUT/PATCH — update
                const task = ErpTaskService.getInstance().updateTask(taskId, params.patch || params, employee.employee_id);
                return { success: true, task };
            }
            if (pathname === '/api/command/erp/projects') {
                const ErpTaskService = require('../../services/erp/ErpTaskService').default;
                const project = ErpTaskService.getInstance().createProject({
                    name: params.name,
                    description: params.description,
                    color: params.color,
                    department_id: params.department_id,
                }, employee.employee_id);
                return { success: true, project };
            }

            // ── ERP Calendar ──
            if (pathname === '/api/command/erp/calendar') {
                const { default: ErpCalendarService } = require('../../services/erp/ErpCalendarService');
                const event = ErpCalendarService.getInstance().createEvent(params.input || params, employee.employee_id);
                return { success: true, event };
            }
            if (pathname.match(/^\/api\/command\/erp\/calendar\/[^/]+$/)) {
                const eventId = pathname.split('/').pop() || '';
                const { default: ErpCalendarService } = require('../../services/erp/ErpCalendarService');
                if (httpMethod === 'DELETE') {
                    ErpCalendarService.getInstance().deleteEvent(eventId);
                    return { success: true };
                }
                const event = ErpCalendarService.getInstance().updateEvent(eventId, params.patch || params);
                return { success: true, event };
            }

            return { success: false, error: `Unknown command: ${httpMethod} ${pathname}` };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Command error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /** Max ms since last successful SSE write before considering connection stale */
    private static SSE_STALE_THRESHOLD_MS = 60_000;

    /** Push an event via SSE to an employee. Returns true if SSE was available. */
    private pushViaSSE(employeeId: string, channel: string, data: any): boolean {
        const res = this.sseClients.get(employeeId);
        if (!res) return false;

        // Half-open socket detection: if no write has succeeded in > 60s
        // (keepalive ping hasn't confirmed the connection is healthy),
        // treat the SSE as stale and fall through to queuing / callback.
        const lastOk = this.sseLastWriteOk.get(employeeId) || 0;
        if (lastOk > 0 && Date.now() - lastOk > HttpRelayService.SSE_STALE_THRESHOLD_MS) {
            Logger.warn(`[HttpRelayService] ⚠️ SSE for ${employeeId} stale (${Date.now() - lastOk}ms since last write) — queuing event`);
            this.sseClients.delete(employeeId);
            const kt = this.sseKeepaliveTimers.get(employeeId);
            if (kt) { clearInterval(kt); this.sseKeepaliveTimers.delete(employeeId); }
            this.sseLastWriteOk.delete(employeeId);
            return false;
        }

        try {
            res.write(`data: ${JSON.stringify({ channel, data })}\n\n`);
            this.sseLastWriteOk.set(employeeId, Date.now());
            return true;
        } catch {
            this.sseClients.delete(employeeId);
            const kt = this.sseKeepaliveTimers.get(employeeId);
            if (kt) { clearInterval(kt); this.sseKeepaliveTimers.delete(employeeId); }
            this.sseLastWriteOk.delete(employeeId);
            return false;
        }
    }

    /**
     * Queue an event for an employee when SSE is temporarily unavailable.
     * Events are flushed when the employee's SSE stream reconnects.
     */
    private queueSseEvent(employeeId: string, channel: string, data: any): void {
        // Only queue if the employee is still registered
        if (!this.employees.has(employeeId)) return;
        let queue = this.sseEventQueue.get(employeeId) || [];
        const now = Date.now();
        // Expire stale entries first
        queue = queue.filter(e => now - e.ts < HttpRelayService.SSE_QUEUE_TTL_MS);
        // Cap queue size - drop oldest if full
        if (queue.length >= HttpRelayService.SSE_QUEUE_MAX) queue.shift();
        queue.push({ channel, data, ts: now });
        this.sseEventQueue.set(employeeId, queue);
        Logger.log(`[HttpRelayService] 📥 Queued SSE event for ${employeeId}: channel=${channel}, queueLen=${queue.length}`);
    }

    // ─── Tunnel management ────────────────────────────────────────────

    public async startTunnel(): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
        if (!this.running) {
            return { success: false, error: 'Relay server chưa được bật' };
        }
        try {
            this.tunnelPendingRestart = false;
            const url = await TunnelService.start(this.port, 'Employee Relay');
            this.tunnelActive = true;
            this.tunnelUrl = url;
            Logger.log(`[HttpRelayService] 🌐 Tunnel active: ${url}`);

            // Listen for URL changes (relay reconnects)
            TunnelService.onChange(this.port, (newUrl) => {
                this.tunnelUrl = newUrl;
                this.tunnelActive = !!newUrl;
                EventBroadcaster.emit('relay:tunnelStatusUpdate', {
                    active: this.tunnelActive,
                    tunnelUrl: this.tunnelUrl,
                });
            });

            EventBroadcaster.emit('relay:tunnelStatusUpdate', { active: true, tunnelUrl: url });
            return { success: true, tunnelUrl: url };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Tunnel start error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    public async stopTunnel(): Promise<{ success: boolean }> {
        await TunnelService.stop(this.port);
        this.tunnelActive = false;
        this.tunnelUrl = null;
        EventBroadcaster.emit('relay:tunnelStatusUpdate', { active: false, tunnelUrl: null });
        return { success: true };
    }

    public getTunnelStatus(): { active: boolean; tunnelUrl: string | null } {
        return { active: this.tunnelActive, tunnelUrl: this.tunnelUrl };
    }

    // ─── Event relay (push to employees) ──────────────────────────────

    /**
     * Hook into EventBroadcaster to relay events to employees.
     * Public so workspaceIpc can re-hook after clearBeforeSendHooks().
     */
    public hookEventBroadcaster(): void {
        // Store bound callbacks so we can re-register after clear
        if (!this._boundRelayCallbacks) {
            this._boundRelayCallbacks = new Map<string, (data: any) => void>();
            for (const channel of HttpRelayService.RELAY_CHANNELS) {
                this._boundRelayCallbacks.set(channel, (data: any) => {
                    this.relayEventToEmployees(channel, data);
                });
            }
        }

        for (const [channel, cb] of this._boundRelayCallbacks) {
            EventBroadcaster.onBeforeSend(channel, cb);
        }
        Logger.log(`[HttpRelayService] Hooked ${HttpRelayService.RELAY_CHANNELS.length} EventBroadcaster channels`);
    }

    private _boundRelayCallbacks: Map<string, (data: any) => void> | null = null;

    private relayEventToEmployees(channel: string, data: any): void {
        if (!this.running) return;

        // Pre-compute zaloId for assigned_accounts filtering
        const eventZaloId: string | undefined =
            data?.zaloId || data?.zalo_id ||
            (channel === 'event:message' ? data?.message?.zaloId : undefined);

        for (const [empId, emp] of this.employees) {
            if (!this.shouldRelayErpEventToEmployee(channel, data, empId)) continue;

            // ─── Tối ưu: filter theo assigned_accounts ──────────────
            // Không gửi event cho employee không được gán account này
            const assigned = emp.assigned_accounts || [];
            if (assigned.length > 0 && eventZaloId && !assigned.includes(eventZaloId)) {
                continue;
            }

            // ─── Socket.IO (transport duy nhất) ──────────────────────
            // Tất cả employee dùng Socket.IO, không còn SSE fallback.
            // Event được buffer → EventBuffer → catch-up khi reconnect.
            // Nếu employee offline → room rỗng → no-op, event ở buffer.
            try {
                SocketIOService.getInstance().emitToEmployee(empId, channel, data);
            } catch {}
        }
    }

    private shouldRelayErpEventToEmployee(channel: string, data: any, employeeId: string): boolean {
        if (channel.startsWith('erp:event:calendarEvent')) {
            const visibleEmployeeIds = Array.isArray(data?.visibleEmployeeIds) ? data.visibleEmployeeIds.filter(Boolean) : [];
            const event = data?.event;
            const derivedIds = event ? [event.organizer_id, ...(event.attendees || []).map((attendee: any) => attendee.employee_id)] : [];
            const allowed = new Set<string>([...visibleEmployeeIds, ...derivedIds].filter(Boolean));
            return allowed.size === 0 ? employeeId === 'boss' : allowed.has(employeeId);
        }

        if (channel.startsWith('erp:event:note')) {
            const note = data?.note;
            if (note?.share_scope === 'workspace' || data?.scope === 'workspace') return true;
            const visibleEmployeeIds = Array.isArray(data?.visibleEmployeeIds) ? data.visibleEmployeeIds.filter(Boolean) : [];
            const shareEmployeeIds = Array.isArray(data?.shares) ? data.shares.map((share: any) => share.employeeId || share.employee_id).filter(Boolean) : [];
            const allowed = new Set<string>([
                note?.author_id,
                data?.authorId,
                ...visibleEmployeeIds,
                ...shareEmployeeIds,
            ].filter(Boolean));
            return allowed.size === 0 ? employeeId === 'boss' : allowed.has(employeeId);
        }

        return true;
    }

    /**
     * Push an event to an employee's callback URL via HTTP POST.
     * Fire-and-forget with timeout.
     */
    private pushToEmployee(emp: RegisteredEmployee, channel: string, data: any): Promise<void> {
        return new Promise((resolve) => {
            if (!emp.callbackUrl) {
                resolve();
                return;
            }

            try {
                const url = new URL('/event', emp.callbackUrl);
                const payload = JSON.stringify({ channel, data });
                const isHttps = url.protocol === 'https:';
                const httpModule = isHttps ? require('https') : require('http');

                const req = httpModule.request(
                    {
                        hostname: url.hostname,
                        port: url.port,
                        path: url.pathname,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(payload),
                            'X-Boss-Token': emp.token,
                        },
                        timeout: HttpRelayService.PUSH_TIMEOUT_MS,
                    },
                    (res: http.IncomingMessage) => {
                        res.resume(); // drain response
                        emp.consecutiveFailures = 0;
                        resolve();
                    }
                );

                req.on('error', () => {
                    emp.consecutiveFailures++;
                    if (emp.consecutiveFailures >= HttpRelayService.MAX_FAILURES) {
                        Logger.warn(`[HttpRelayService] Employee ${emp.display_name} unreachable (${emp.consecutiveFailures} failures)`);
                    }
                    resolve();
                });

                req.on('timeout', () => {
                    req.destroy();
                    emp.consecutiveFailures++;
                    resolve();
                });

                req.write(payload);
                req.end();
            } catch (err) {
                emp.consecutiveFailures++;
                resolve();
            }
        });
    }

    // ─── Offline check ────────────────────────────────────────────────

    private startOfflineCheck(): void {
        this.offlineCheckTimer = setInterval(() => {
            const now = Date.now();
            for (const [empId, emp] of this.employees) {
                // ── SSE connection is a live heartbeat - employee is definitely online ──
                // Refresh lastSeen so the employee doesn't get kicked when SSE eventually drops.
                if (this.sseClients.has(empId)) {
                    emp.lastSeen = now;
                    continue;
                }

                if (now - emp.lastSeen > HttpRelayService.HEARTBEAT_TIMEOUT_MS) {
                    Logger.log(`[HttpRelayService] 🔴 Employee offline (heartbeat timeout): ${emp.display_name}`);
                    this.employees.delete(empId);
                    // End session in DB for online time tracking
                    try { this.runOnPinnedDb((db) => db.endEmployeeSession(empId)); } catch {}
                    this.broadcastEmployeeList();
                }
            }
        }, 15_000);
    }

    private stopOfflineCheck(): void {
        if (this.offlineCheckTimer) {
            clearInterval(this.offlineCheckTimer);
            this.offlineCheckTimer = null;
        }
    }

    // ─── Auth helper ──────────────────────────────────────────────────

    /**
     * Authenticate a request by Authorization header (Bearer token).
     * Returns the registered employee or null.
     */
    private authenticateRequest(req: http.IncomingMessage): RegisteredEmployee | null {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!token) return null;

        const validation = EmployeeService.getInstance().validateToken(token);
        if (!validation.valid || !validation.employee_id) return null;

        const emp = this.employees.get(validation.employee_id);
        if (!emp) {
            // Employee authenticated but not registered - auto-register
            const empData = EmployeeService.getInstance().getEmployeeById(validation.employee_id);
            if (!empData || !empData.is_active) return null;

            const registered: RegisteredEmployee = {
                employee_id: validation.employee_id,
                display_name: empData.display_name,
                avatar_url: empData.avatar_url,
                username: validation.username || '',
                callbackUrl: '',
                token,
                lastSeen: Date.now(),
                assigned_accounts: empData.assigned_accounts || [],
                ip_address: req.socket.remoteAddress || '',
                connected_at: Date.now(),
                consecutiveFailures: 0,
            };
            this.employees.set(validation.employee_id, registered);
            this.broadcastEmployeeList();
            return registered;
        }

        return emp;
    }

    // ─── Resolve real auth ────────────────────────────────────────────

    private resolveRealAuth(zaloId: string, employeeAuth: any): any {
        if (!zaloId) return employeeAuth;
        try {
            const conn = ConnectionManager.getAllConnections().get(zaloId);
            if (conn?.auth) {
                const authObj = typeof conn.auth === 'string' ? JSON.parse(conn.auth) : conn.auth;
                return authObj;
            }

            const account = this.runOnPinnedDb((db) => {
                const rows = db.query<any>(`SELECT cookies, imei, user_agent FROM accounts WHERE zalo_id = ? LIMIT 1`, [zaloId]);
                return rows[0] || null;
            });
            if (account && account.cookies) {
                return {
                    cookies: account.cookies,
                    imei: account.imei || '',
                    userAgent: account.user_agent || '',
                };
            }
        } catch (err: any) {
            Logger.warn(`[HttpRelayService] resolveRealAuth error: ${err.message}`);
        }
        return null;
    }

    private channelToModule(channel: string): string | null {
        if (channel.startsWith('zalo:')) return 'chat';
        if (channel.startsWith('crm:')) return 'crm';
        if (channel.startsWith('workflow:')) return 'workflow';
        if (channel.startsWith('integration:')) return 'integration';
        if (channel.startsWith('ai:')) return 'ai_assistant';
        if (channel.startsWith('db:')) return null;
        return null;
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    private broadcastEmployeeList(): void {
        const employees = Array.from(this.employees.values()).map(e => ({
            employee_id: e.employee_id,
            display_name: e.display_name,
            avatar_url: e.avatar_url,
            ip_address: e.ip_address,
            connected_at: e.connected_at,
        }));
        EventBroadcaster.emit('relay:employeeListUpdate', { employees });
    }

    private getLocalIPs(): string[] {
        const nets = os.networkInterfaces();
        const ips: string[] = [];
        for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
                if (net.family === 'IPv4' && !net.internal) {
                    ips.push(net.address);
                }
            }
        }
        return ips;
    }

    /** Update assigned accounts when boss changes assignments */
    public updateEmployeeRooms(employeeId: string, newZaloIds: string[]): void {
        const emp = this.employees.get(employeeId);
        if (!emp) return;

        Logger.log(`[HttpRelayService] updateEmployeeRooms → employee=${employeeId} old=${emp.assigned_accounts.length} new=${newZaloIds.length}`);
        emp.assigned_accounts = newZaloIds;

        const snapshot = this.buildEmployeeSnapshot(employeeId);
        const payload = {
            assignedAccounts: snapshot?.assignedAccounts || newZaloIds,
            accountsData: snapshot?.accountsData || [],
            permissions: snapshot?.permissions || [],
        };
        if (!this.pushViaSSE(employeeId, 'relay:accountAccessUpdate', payload)) {
            this.pushToEmployee(emp, 'relay:accountAccessUpdate', payload).catch(() => {});
        }
    }

    /** Push a fresh employee snapshot to the employee */
    public refreshEmployeeState(employeeId: string, reason = 'manual-refresh'): void {
        const emp = this.employees.get(employeeId);
        if (!emp) return;

        const snapshot = this.buildEmployeeSnapshot(employeeId);
        if (snapshot) {
            if (!this.pushViaSSE(employeeId, 'relay:initialState', snapshot)) {
                this.pushToEmployee(emp, 'relay:initialState', snapshot).catch(() => {});
            }
            // Permission updates: send dedicated event that bypasses 60s throttle
            // on workspace:initialState in the renderer.
            if (reason === 'permissions-updated') {
                const permPayload = {
                    permissions: snapshot.permissions,
                    erpRole: snapshot.erpRole,
                    erpExtraJson: snapshot.erpExtraJson,
                    employeesData: snapshot.employeesData,
                };
                if (!this.pushViaSSE(employeeId, 'relay:permissionUpdate', permPayload)) {
                    this.pushToEmployee(emp, 'relay:permissionUpdate', permPayload).catch(() => {});
                }
            }
        }
        Logger.log(`[HttpRelayService] refreshEmployeeState(${reason}) → employee=${employeeId}`);
    }

    // ─── Utility ──────────────────────────────────────────────────────

    private readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => cb(body));
    }

    private json(res: http.ServerResponse, status: number, data: any): void {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    /** Cache-aware REST result - skips the synchronous better-sqlite3 query
     *  if a fresh cached response exists. This prevents main-thread blocking
     *  when the employee calls many GET endpoints after every message. */
    private getCachedRestResult(method: string, pathname: string, employeeId: string, fetchFn: () => any): any {
        if (method !== 'GET') return fetchFn();
        const cacheKey = `${method}:${pathname}:${employeeId}`;
        const cached = this.restApiCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < HttpRelayService.REST_CACHE_TTL_MS) {
            return cached.data;
        }
        const data = fetchFn();
        this.restApiCache.set(cacheKey, { data, ts: Date.now() });
        // Prune stale entries every 50 inserts
        if (this.restApiCache.size > 50) {
            const now = Date.now();
            for (const [k, v] of this.restApiCache) {
                if (now - v.ts > 5000) this.restApiCache.delete(k);
            }
        }
        return data;
    }

    // ─── Utility ──────────────────────────────────────────────────────
}

export default HttpRelayService;

