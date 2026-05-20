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
const os = __importStar(require("os"));
const Logger_1 = __importDefault(require("../utils/Logger"));
const EmployeeService_1 = __importDefault(require("./EmployeeService"));
const DatabaseService_1 = __importDefault(require("./DatabaseService"));
const DataSyncService_1 = __importDefault(require("./DataSyncService"));
const EventBroadcaster_1 = __importDefault(require("./EventBroadcaster"));
const ConnectionManager_1 = __importDefault(require("../utils/ConnectionManager"));
/**
 * HttpRelayService — Boss side only.
 * HTTP server that relays Zalo events to Employee machines via HTTP POST
 * and proxies Employee actions back to Zalo via IPC handler registry.
 *
 * Replaces SocketRelayService — no persistent WebSocket connections.
 */
class HttpRelayService {
    constructor() {
        this.httpServer = null;
        this.running = false;
        this.port = 9900;
        this.employees = new Map(); // employeeId → employee
        this.pinnedDbPath = null;
        this.offlineCheckTimer = null;
        this._boundRelayCallbacks = null;
    }
    /** Register a pending employee message (called before webhook arrives) */
    static setPendingEmployeeMsg(msgId, info) {
        const now = Date.now();
        const entry = { ...info, timestamp: now };
        // Key by msgId if available
        if (msgId) {
            this.pendingEmployeeMsgIds.set(String(msgId), entry);
            setTimeout(() => this.pendingEmployeeMsgIds.delete(String(msgId)), 30000);
        }
        // Always also key by zaloId:threadId as fallback
        const threadKey = `${info.zaloId}:${info.threadId}`;
        this.pendingEmployeeByThread.set(threadKey, entry);
        setTimeout(() => {
            const cur = this.pendingEmployeeByThread.get(threadKey);
            if (cur && cur.timestamp === now)
                this.pendingEmployeeByThread.delete(threadKey);
        }, 15000);
    }
    /** Check and consume pending employee info for a msgId (with thread fallback) */
    static consumePendingEmployeeMsg(msgId, zaloId, threadId) {
        Logger_1.default.log(`[HttpRelayService] 🔎 consumePendingEmployeeMsg: msgId="${msgId}", zaloId="${zaloId}", threadId="${threadId}", maps=${this.pendingEmployeeMsgIds.size}/${this.pendingEmployeeByThread.size}`);
        // Try by msgId first
        if (msgId) {
            const key = String(msgId);
            const info = this.pendingEmployeeMsgIds.get(key);
            if (info) {
                this.pendingEmployeeMsgIds.delete(key);
                // Also clean thread map
                this.pendingEmployeeByThread.delete(`${info.zaloId}:${info.threadId}`);
                return info;
            }
        }
        // Fallback: try by zaloId:threadId (within 15s window)
        if (zaloId && threadId) {
            const threadKey = `${zaloId}:${threadId}`;
            const info = this.pendingEmployeeByThread.get(threadKey);
            if (info && (Date.now() - info.timestamp) < 15000) {
                this.pendingEmployeeByThread.delete(threadKey);
                return info;
            }
        }
        return null;
    }
    static getInstance() {
        if (!HttpRelayService.instance) {
            HttpRelayService.instance = new HttpRelayService();
        }
        return HttpRelayService.instance;
    }
    // ─── Pinned DB helper ─────────────────────────────────────────────
    runOnPinnedDb(fn) {
        const db = DatabaseService_1.default.getInstance();
        if (this.pinnedDbPath && db.getDbPath() !== this.pinnedDbPath) {
            return db.withDbPath(this.pinnedDbPath, () => fn(db));
        }
        return fn(db);
    }
    buildEmployeeSnapshot(employeeId) {
        return this.runOnPinnedDb((db) => {
            const employeeService = EmployeeService_1.default.getInstance();
            const emp = employeeService.getEmployeeById(employeeId);
            if (!emp)
                return null;
            const assignedAccounts = emp.assigned_accounts || [];
            const onlineAccounts = assignedAccounts.filter((zaloId) => ConnectionManager_1.default.isConnected(zaloId));
            const allAccounts = db.getAccounts();
            const profile = db.queryOne(`SELECT erp_role, extra_json FROM erp_employee_profiles WHERE employee_id = ?`, [employeeId]);
            const employeesData = employeeService.getEmployees().map((employee) => ({
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
                listener_active: ConnectionManager_1.default.isConnected(a.zalo_id) ? 1 : 0,
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
    async start(port) {
        if (this.running) {
            return { success: true, port: this.port };
        }
        this.port = port || this.port;
        EmployeeService_1.default.getInstance().pinToCurrentDb();
        this.pinnedDbPath = DatabaseService_1.default.getInstance().getDbPath();
        try {
            this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
            this.hookEventBroadcaster();
            this.startOfflineCheck();
            return new Promise((resolve) => {
                this.httpServer.listen(this.port, () => {
                    this.running = true;
                    Logger_1.default.log(`[HttpRelayService] ✅ Server started on port ${this.port}`);
                    resolve({ success: true, port: this.port });
                });
                this.httpServer.on('error', (err) => {
                    Logger_1.default.error(`[HttpRelayService] ❌ Server error: ${err.message}`);
                    resolve({ success: false, error: err.message });
                });
            });
        }
        catch (err) {
            Logger_1.default.error(`[HttpRelayService] Start error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    stop() {
        try {
            if (this.httpServer) {
                this.httpServer.close();
                this.httpServer = null;
            }
            this.stopOfflineCheck();
            // End all active employee sessions in DB
            for (const [empId] of this.employees) {
                try {
                    this.runOnPinnedDb((db) => db.endEmployeeSession(empId));
                }
                catch { }
            }
            this.employees.clear();
            this.running = false;
            this.pinnedDbPath = null;
            EmployeeService_1.default.getInstance().unpinDb();
            Logger_1.default.log('[HttpRelayService] Server stopped');
            return { success: true };
        }
        catch (err) {
            Logger_1.default.error(`[HttpRelayService] Stop error: ${err.message}`);
            return { success: true };
        }
    }
    getStatus() {
        const employees = Array.from(this.employees.values()).map(e => ({
            employee_id: e.employee_id,
            display_name: e.display_name,
            avatar_url: e.avatar_url,
            ip_address: e.ip_address,
            connected_at: e.connected_at,
        }));
        return {
            running: this.running,
            port: this.port,
            connectedEmployees: employees,
            localIPs: this.getLocalIPs(),
        };
    }
    kickEmployee(employeeId) {
        const emp = this.employees.get(employeeId);
        if (emp) {
            // Notify employee they've been kicked
            this.pushToEmployee(emp, 'relay:kicked', { reason: 'Bị ngắt kết nối bởi quản lý' }).catch(() => { });
            this.employees.delete(employeeId);
            // End session in DB for online time tracking
            try {
                this.runOnPinnedDb((db) => db.endEmployeeSession(employeeId));
            }
            catch { }
            Logger_1.default.log(`[HttpRelayService] Kicked employee: ${emp.display_name}`);
            this.broadcastEmployeeList();
        }
    }
    // ─── HTTP Router ──────────────────────────────────────────────────
    handleHttpRequest(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
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
        // ── Sync endpoints ────────────────────────────────────────────
        if (req.method === 'GET' && url === '/api/sync/full') {
            return this.handleSyncFull(req, res);
        }
        if (req.method === 'GET' && url.startsWith('/api/sync/delta')) {
            return this.handleSyncDelta(req, res);
        }
        // ── Media ─────────────────────────────────────────────────────
        if (req.method === 'POST' && url === '/api/media/request') {
            return this.handleMediaRequest(req, res);
        }
        // ── Healthcheck ───────────────────────────────────────────────
        if (req.method === 'GET' && (url === '/api/health' || url === '/')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', relay: this.running, port: this.port }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
    // ─── Auth handlers ────────────────────────────────────────────────
    handleLogin(req, res) {
        this.readBody(req, async (body) => {
            try {
                const { username, password, callbackUrl } = JSON.parse(body);
                if (!username || !password) {
                    return this.json(res, 400, { success: false, error: 'Thiếu username hoặc password' });
                }
                const result = await EmployeeService_1.default.getInstance().authenticate(username, password);
                if (!result.success || !result.employee) {
                    return this.json(res, 401, result);
                }
                const emp = result.employee;
                const clientIp = req.socket.remoteAddress || '';
                // Register employee
                const registered = {
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
                Logger_1.default.log(`[HttpRelayService] 🟢 Employee registered: ${emp.display_name} (@${username}) callback=${callbackUrl} ip=${clientIp}`);
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
            }
            catch (err) {
                Logger_1.default.error(`[HttpRelayService] Login error: ${err.message}`);
                this.json(res, 400, { success: false, error: 'Request không hợp lệ' });
            }
        });
    }
    handleHeartbeat(req, res) {
        this.readBody(req, (body) => {
            try {
                const { callbackUrl } = JSON.parse(body);
                const employee = this.authenticateRequest(req);
                if (!employee) {
                    return this.json(res, 401, { success: false, error: 'Unauthorized' });
                }
                employee.lastSeen = Date.now();
                employee.consecutiveFailures = 0;
                if (callbackUrl) {
                    employee.callbackUrl = callbackUrl;
                }
                this.json(res, 200, { success: true, ts: Date.now() });
            }
            catch (err) {
                this.json(res, 400, { success: false, error: err.message });
            }
        });
    }
    // ─── Proxy action handler ─────────────────────────────────────────
    handleProxyAction(req, res) {
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
            }
            catch (err) {
                Logger_1.default.error(`[HttpRelayService] Proxy action error: ${err.message}`);
                this.json(res, 500, { success: false, error: err.message });
            }
        });
    }
    async executeProxyAction(employee, channel, params) {
        let zaloId = params?.zaloId || params?.zalo_id || '';
        if (!zaloId && employee.assigned_accounts.length > 0) {
            zaloId = employee.assigned_accounts[0];
        }
        if (zaloId && !employee.assigned_accounts.includes(zaloId)) {
            return { success: false, error: 'Không có quyền truy cập tài khoản này' };
        }
        // Check permission
        const empSvc = EmployeeService_1.default.getInstance();
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
                }
                else if (zaloId) {
                    Logger_1.default.warn(`[HttpRelayService] Proxy: could not resolve real auth for zaloId=${zaloId}, channel=${channel}`);
                    params = { ...params, _fromRelay: true };
                }
            }
            else {
                params = { ...params, _fromRelay: true };
            }
            // Use handler registry
            const { ipcHandlerRegistry } = require('../../electron/ipc/zaloIpc');
            const handler = ipcHandlerRegistry?.get(channel);
            if (handler) {
                const result = await handler(null, params);
                // Log send actions + broadcast sender info to all workspaces
                if ((channel.includes('send') || channel.includes('Send')) && !channel.includes('Seen') && !channel.includes('seen') && !channel.includes('Typing') && !channel.includes('typing')) {
                    const rawMsgId = result?.response?.msgId
                        ?? result?.response?.message?.msgId
                        ?? result?.response?.message?.data?.msgId
                        ?? '';
                    const msgId = String(rawMsgId);
                    const threadId = params?.threadId || params?.thread_id || '';
                    Logger_1.default.log(`[HttpRelayService] 📤 SEND result for employee=${employee.employee_id}: channel=${channel}, msgId="${msgId}", rawMsgId=${rawMsgId} (type=${typeof rawMsgId}), threadId="${threadId}", zaloId="${zaloId}", response=${JSON.stringify(result?.response || {}).slice(0, 500)}`);
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
                                const rows = db.query(`SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND is_sent = 0 ORDER BY timestamp DESC LIMIT 1`, [zaloId, threadId]);
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
                        }
                        catch { }
                    }
                    // Mark message as handled by employee in DB
                    // Register pending info IMMEDIATELY so broadcastMessage can tag it at save time
                    if (zaloId) {
                        const empId = employee.employee_id;
                        // Register in pending map — consumed by EventBroadcaster.broadcastMessage
                        // Always register (even if msgId is empty) — the thread fallback will work
                        HttpRelayService.setPendingEmployeeMsg(msgId, {
                            employee_id: empId,
                            employee_name: employee.display_name,
                            employee_avatar: employee.avatar_url || '',
                            zaloId,
                            threadId,
                        });
                        Logger_1.default.log(`[HttpRelayService] 📌 setPendingEmployeeMsg: msgId="${msgId}", threadKey="${zaloId}:${threadId}", empId="${empId}"`);
                        // Also retry DB update after delays as fallback
                        if (msgId) {
                            setTimeout(() => {
                                try {
                                    this.runOnPinnedDb((db) => db.setMessageHandledByEmployee(zaloId, msgId, empId));
                                    Logger_1.default.log(`[HttpRelayService] 📌 DB fallback update (500ms): msgId="${msgId}", empId="${empId}"`);
                                }
                                catch { }
                            }, 500);
                            setTimeout(() => {
                                try {
                                    this.runOnPinnedDb((db) => db.setMessageHandledByEmployee(zaloId, msgId, empId));
                                }
                                catch { }
                            }, 3000);
                        }
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
                            if (!emp.callbackUrl)
                                continue;
                            this.pushToEmployee(emp, 'relay:messageSentByEmployee', senderPayload).catch(() => { });
                        }
                        // Also emit to local renderer (boss side)
                        Logger_1.default.log(`[HttpRelayService] 📡 Emitting relay:messageSentByEmployee to boss renderer: msgId="${msgId}", empId="${employee.employee_id}", threadId="${threadId}"`);
                        EventBroadcaster_1.default.emit('relay:messageSentByEmployee', senderPayload);
                    }
                }
                return result;
            }
            // Fallback: ipcMain._invokeHandlers
            const { ipcMain } = require('electron');
            const internalHandlers = ipcMain._invokeHandlers;
            if (internalHandlers && internalHandlers.has(channel)) {
                return await internalHandlers.get(channel)(null, params);
            }
            return { success: false, error: `No handler for channel: ${channel}` };
        }
        catch (err) {
            Logger_1.default.error(`[HttpRelayService] Proxy error (${channel}): ${err.message}`);
            return { success: false, error: err.message };
        }
    }
    // ─── Sync handlers ────────────────────────────────────────────────
    handleSyncSnapshot(req, res) {
        try {
            const employee = this.authenticateRequest(req);
            if (!employee) {
                return this.json(res, 401, { success: false, error: 'Unauthorized' });
            }
            employee.lastSeen = Date.now();
            const snapshot = this.buildEmployeeSnapshot(employee.employee_id);
            this.json(res, 200, { success: true, snapshot });
        }
        catch (err) {
            Logger_1.default.error(`[HttpRelayService] Snapshot error: ${err.message}`);
            this.json(res, 500, { success: false, error: err.message });
        }
    }
    handleSyncFull(req, res) {
        try {
            const employee = this.authenticateRequest(req);
            if (!employee) {
                return this.json(res, 401, { success: false, error: 'Unauthorized' });
            }
            employee.lastSeen = Date.now();
            Logger_1.default.log(`[HttpRelayService] Full sync requested by ${employee.display_name}`);
            const payload = this.runOnPinnedDb(() => DataSyncService_1.default.getInstance().exportFullSync(employee.assigned_accounts, employee.employee_id));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, payload, syncTs: payload.syncTs }));
        }
        catch (err) {
            Logger_1.default.error(`[HttpRelayService] Full sync error: ${err.message}`);
            this.json(res, 500, { success: false, error: err.message });
        }
    }
    handleSyncDelta(req, res) {
        try {
            const employee = this.authenticateRequest(req);
            if (!employee) {
                return this.json(res, 401, { success: false, error: 'Unauthorized' });
            }
            employee.lastSeen = Date.now();
            const urlObj = new URL(req.url || '', `http://localhost:${this.port}`);
            const sinceTs = Number(urlObj.searchParams.get('sinceTs') || '0');
            Logger_1.default.log(`[HttpRelayService] Delta sync requested by ${employee.display_name} since ${new Date(sinceTs).toISOString()}`);
            const payload = this.runOnPinnedDb(() => DataSyncService_1.default.getInstance().exportDeltaSync(employee.assigned_accounts, sinceTs, employee.employee_id));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, payload, syncTs: payload.syncTs }));
        }
        catch (err) {
            Logger_1.default.error(`[HttpRelayService] Delta sync error: ${err.message}`);
            this.json(res, 500, { success: false, error: err.message });
        }
    }
    // ─── Media handler ────────────────────────────────────────────────
    handleMediaRequest(req, res) {
        this.readBody(req, (body) => {
            try {
                const employee = this.authenticateRequest(req);
                if (!employee) {
                    return this.json(res, 401, { success: false, error: 'Unauthorized' });
                }
                const { filePath } = JSON.parse(body);
                const fs = require('fs');
                const path = require('path');
                const FileStorageService = require('./FileStorageService').default;
                const storagePath = FileStorageService.getMediaBasePath?.() || '';
                const resolved = path.resolve(filePath);
                if (storagePath && !resolved.startsWith(storagePath)) {
                    return this.json(res, 403, { success: false, error: 'Access denied' });
                }
                if (!fs.existsSync(resolved)) {
                    return this.json(res, 404, { success: false, error: 'File not found' });
                }
                const stat = fs.statSync(resolved);
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': `attachment; filename="${path.basename(resolved)}"`,
                    'Content-Length': stat.size,
                });
                fs.createReadStream(resolved).pipe(res);
            }
            catch (err) {
                this.json(res, 500, { success: false, error: err.message });
            }
        });
    }
    // ─── Event relay (push to employees) ──────────────────────────────
    /**
     * Hook into EventBroadcaster to relay events to employees.
     * Public so workspaceIpc can re-hook after clearBeforeSendHooks().
     */
    hookEventBroadcaster() {
        // Store bound callbacks so we can re-register after clear
        if (!this._boundRelayCallbacks) {
            this._boundRelayCallbacks = new Map();
            for (const channel of HttpRelayService.RELAY_CHANNELS) {
                this._boundRelayCallbacks.set(channel, (data) => {
                    this.relayEventToEmployees(channel, data);
                });
            }
        }
        for (const [channel, cb] of this._boundRelayCallbacks) {
            EventBroadcaster_1.default.onBeforeSend(channel, cb);
        }
        Logger_1.default.log(`[HttpRelayService] Hooked ${HttpRelayService.RELAY_CHANNELS.length} EventBroadcaster channels`);
    }
    relayEventToEmployees(channel, data) {
        if (!this.running)
            return;
        // Push to ALL connected employees — no filtering by assigned_accounts.
        // Each employee saves to their own DB if online.
        // If offline, they sync later from boss via full/delta sync.
        for (const emp of this.employees.values()) {
            if (!emp.callbackUrl)
                continue;
            if (!this.shouldRelayErpEventToEmployee(channel, data, emp.employee_id))
                continue;
            // Fire-and-forget push
            this.pushToEmployee(emp, channel, data).catch(() => { });
        }
    }
    shouldRelayErpEventToEmployee(channel, data, employeeId) {
        if (channel.startsWith('erp:event:calendarEvent')) {
            const visibleEmployeeIds = Array.isArray(data?.visibleEmployeeIds) ? data.visibleEmployeeIds.filter(Boolean) : [];
            const event = data?.event;
            const derivedIds = event ? [event.organizer_id, ...(event.attendees || []).map((attendee) => attendee.employee_id)] : [];
            const allowed = new Set([...visibleEmployeeIds, ...derivedIds].filter(Boolean));
            return allowed.size === 0 ? employeeId === 'boss' : allowed.has(employeeId);
        }
        if (channel.startsWith('erp:event:note')) {
            const note = data?.note;
            if (note?.share_scope === 'workspace' || data?.scope === 'workspace')
                return true;
            const visibleEmployeeIds = Array.isArray(data?.visibleEmployeeIds) ? data.visibleEmployeeIds.filter(Boolean) : [];
            const shareEmployeeIds = Array.isArray(data?.shares) ? data.shares.map((share) => share.employeeId || share.employee_id).filter(Boolean) : [];
            const allowed = new Set([
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
    pushToEmployee(emp, channel, data) {
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
                const req = httpModule.request({
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
                }, (res) => {
                    res.resume(); // drain response
                    emp.consecutiveFailures = 0;
                    resolve();
                });
                req.on('error', () => {
                    emp.consecutiveFailures++;
                    if (emp.consecutiveFailures >= HttpRelayService.MAX_FAILURES) {
                        Logger_1.default.warn(`[HttpRelayService] Employee ${emp.display_name} unreachable (${emp.consecutiveFailures} failures)`);
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
            }
            catch (err) {
                emp.consecutiveFailures++;
                resolve();
            }
        });
    }
    // ─── Offline check ────────────────────────────────────────────────
    startOfflineCheck() {
        this.offlineCheckTimer = setInterval(() => {
            const now = Date.now();
            for (const [empId, emp] of this.employees) {
                if (now - emp.lastSeen > HttpRelayService.HEARTBEAT_TIMEOUT_MS) {
                    Logger_1.default.log(`[HttpRelayService] 🔴 Employee offline (heartbeat timeout): ${emp.display_name}`);
                    this.employees.delete(empId);
                    // End session in DB for online time tracking
                    try {
                        this.runOnPinnedDb((db) => db.endEmployeeSession(empId));
                    }
                    catch { }
                    this.broadcastEmployeeList();
                }
            }
        }, 15000);
    }
    stopOfflineCheck() {
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
    authenticateRequest(req) {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!token)
            return null;
        const validation = EmployeeService_1.default.getInstance().validateToken(token);
        if (!validation.valid || !validation.employee_id)
            return null;
        const emp = this.employees.get(validation.employee_id);
        if (!emp) {
            // Employee authenticated but not registered — auto-register
            const empData = EmployeeService_1.default.getInstance().getEmployeeById(validation.employee_id);
            if (!empData || !empData.is_active)
                return null;
            const registered = {
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
    resolveRealAuth(zaloId, employeeAuth) {
        if (!zaloId)
            return employeeAuth;
        try {
            const conn = ConnectionManager_1.default.getAllConnections().get(zaloId);
            if (conn?.auth) {
                const authObj = typeof conn.auth === 'string' ? JSON.parse(conn.auth) : conn.auth;
                return authObj;
            }
            const account = this.runOnPinnedDb((db) => {
                const rows = db.query(`SELECT cookies, imei, user_agent FROM accounts WHERE zalo_id = ? LIMIT 1`, [zaloId]);
                return rows[0] || null;
            });
            if (account && account.cookies) {
                return {
                    cookies: account.cookies,
                    imei: account.imei || '',
                    userAgent: account.user_agent || '',
                };
            }
        }
        catch (err) {
            Logger_1.default.warn(`[HttpRelayService] resolveRealAuth error: ${err.message}`);
        }
        return null;
    }
    channelToModule(channel) {
        if (channel.startsWith('zalo:'))
            return 'chat';
        if (channel.startsWith('crm:'))
            return 'crm';
        if (channel.startsWith('workflow:'))
            return 'workflow';
        if (channel.startsWith('integration:'))
            return 'integration';
        if (channel.startsWith('ai:'))
            return 'ai_assistant';
        if (channel.startsWith('db:'))
            return null;
        return null;
    }
    // ─── Helpers ──────────────────────────────────────────────────────
    broadcastEmployeeList() {
        const employees = Array.from(this.employees.values()).map(e => ({
            employee_id: e.employee_id,
            display_name: e.display_name,
            avatar_url: e.avatar_url,
            ip_address: e.ip_address,
            connected_at: e.connected_at,
        }));
        EventBroadcaster_1.default.emit('relay:employeeListUpdate', { employees });
    }
    getLocalIPs() {
        const nets = os.networkInterfaces();
        const ips = [];
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
    updateEmployeeRooms(employeeId, newZaloIds) {
        const emp = this.employees.get(employeeId);
        if (!emp)
            return;
        Logger_1.default.log(`[HttpRelayService] updateEmployeeRooms → employee=${employeeId} old=${emp.assigned_accounts.length} new=${newZaloIds.length}`);
        emp.assigned_accounts = newZaloIds;
        const snapshot = this.buildEmployeeSnapshot(employeeId);
        // Push update to employee
        this.pushToEmployee(emp, 'relay:accountAccessUpdate', {
            assignedAccounts: snapshot?.assignedAccounts || newZaloIds,
            accountsData: snapshot?.accountsData || [],
            permissions: snapshot?.permissions || [],
        }).catch(() => { });
    }
    /** Push a fresh employee snapshot to the employee */
    refreshEmployeeState(employeeId, reason = 'manual-refresh') {
        const emp = this.employees.get(employeeId);
        if (!emp)
            return;
        const snapshot = this.buildEmployeeSnapshot(employeeId);
        if (snapshot) {
            this.pushToEmployee(emp, 'relay:initialState', snapshot).catch(() => { });
        }
        Logger_1.default.log(`[HttpRelayService] refreshEmployeeState(${reason}) → employee=${employeeId}`);
    }
    // ─── Utility ──────────────────────────────────────────────────────
    readBody(req, cb) {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => cb(body));
    }
    json(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }
}
/**
 * Pending employee sender info: msgId → employee data.
 * Set immediately when employee sends a message (before webhook arrives).
 * Consumed by EventBroadcaster.broadcastMessage to tag the message at save time.
 */
HttpRelayService.pendingEmployeeMsgIds = new Map();
/** Secondary fallback map: zaloId:threadId → employee info (for when msgId doesn't match) */
HttpRelayService.pendingEmployeeByThread = new Map();
/** Max consecutive push failures before marking employee offline */
HttpRelayService.MAX_FAILURES = 3;
/** Heartbeat timeout — if no heartbeat for this long, mark offline */
HttpRelayService.HEARTBEAT_TIMEOUT_MS = 45000; // 45s (employee sends every 15s)
/** Push timeout for event delivery */
HttpRelayService.PUSH_TIMEOUT_MS = 3000;
/** Channels to relay from EventBroadcaster → employees */
HttpRelayService.RELAY_CHANNELS = [
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
];
exports.default = HttpRelayService;
//# sourceMappingURL=HttpRelayService.js.map