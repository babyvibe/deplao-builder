import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Logger from '../../utils/Logger';
import EmployeeService from '../employee/EmployeeService';
import { checkEmployeeAccess, isEmployeeSettingKey } from './employeeAccess';
import { RestReadCache, parseRestQueryParams, restCacheKey } from './employeeRestRead';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import ConnectionManager from '../../utils/connection/ConnectionManager';
import TunnelService, { TunnelOptions, TunnelProvider, type TunnelChangeInfo } from '../tunnel/TunnelService';
import {
    BOSS_URL_CHANGED_EVENT,
    TUNNEL_SWITCH_GRACE_MS,
    type BossUrlChangedEvent,
    type BossUrlChangeReason,
    type RelayTunnelState,
    type RelayTunnelStatus,
} from '../../shared/cloud/tunnelAddress';
import { normalizeBossUrl } from '../../shared/employee/employeeConnection';
import SocketIOService from '../socket/SocketIOService';
import { canReceiveRelayEvent, classifyRelayEvent } from '../socket/relayAudience';
import { RELAY_CHANNELS } from '../socket/relayChannels';
import { handlers as restHandlers } from './handlers/RestApiHandlers';
import { handleMediaRequest as handleMediaFileServe } from './handlers/MediaHandler';
import { libraryHandlers } from './handlers/LibraryHandler';
import {
    ERP_REST_COMMAND_PREFIX, erpRestHttpStatus, erpTaskAttachmentHolder, matchErpRestRoute,
} from './handlers/ErpRestRoutes';
import FileStorageService from '../file/FileStorageService';
import { toSafeFileName } from '../file/safeFileName';
import { runInRuntimeScope } from '../database/dbScope';
import {
    COALESCED_POLL_CHANNELS, SPECIAL_PROXY_CHANNELS, checkProxyChannel, checkProxyFilePaths, employeeSendInfo,
    proxyChannelModules, resolveAccountChannelProxy, resolveProxyAccount, shouldSkipCoalescedPoll,
    type ProxyPathContext, type RecentPoll,
} from './proxyActionPolicy';
import { isAccountChannelProxy } from './employeeChannelRoutes';
import {
    checkRestCommand, commandExtraAccountIds, commandPathParams, defaultCommandAccount, positiveInt, workflowPageIds, workflowPagesAllowed,
} from './restCommandPolicy';
import { canAccessLibraryOwner, checkMediaAccess, classifyMediaPath } from './bossFileAccess';
import ApiPlatform from '../api/ApiPlatform';
import { getApiSettingBool } from '../api/settings';
import { tr } from '../../shared/i18n';

/**
 * Cloudflare auto (src/services/cloudflare/tunnel): in 'cloudflare_auto' mode the relay's tunnel is the 'relay' service
 * of the shared cloudflared process (fixed address). Lazy-loaded: other modes / load errors → null = run as before.
 */
type CloudTunnelApi = typeof import('../cloudflare/tunnel');

function cloudTunnelIfAuto(): CloudTunnelApi | null {
    try {
        const mod: CloudTunnelApi = require('../cloudflare/tunnel');
        return mod.isCloudTunnelAuto() ? mod : null;
    } catch {
        return null;
    }
}

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
        /** zalo | facebook | telegram_user | telegram_bot */
        channel: string;
        /** 1 = session is running on Boss (per channel: isAccountSessionOnline) */
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
/** Path with no existing file: "a.png" → "a (1).png" → "a (2).png"… (does not overwrite a file another employee just uploaded). */
function uniqueFilePath(dir: string, name: string): string {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let candidate = path.join(dir, name);
    for (let i = 1; fs.existsSync(candidate) && i < 1000; i++) candidate = path.join(dir, `${base} (${i})${ext}`);
    return candidate;
}

class HttpRelayService {
    private static instance: HttpRelayService;
    private httpServer: http.Server | null = null;
    private running = false;
    private port = 9900;
    private employees = new Map<string, RegisteredEmployee>(); // employeeId → employee
    private pinnedDbPath: string | null = null;
    private offlineCheckTimer: ReturnType<typeof setInterval> | null = null;

    /** REST API response cache (labels, flags, pins…): employees call again after EVERY message. Avoids blocking the main thread
     *  (better-sqlite3 is synchronous). An entry is only usable while the DB has not changed since it was saved (restCacheToken) and is still within the TTL;
     *  only successful results are stored. See RestReadCache (employeeRestRead.ts). */
    private static REST_CACHE_TTL_MS = 1500; // 1.5s cache for frequent read-only queries
    private restApiCache = new RestReadCache(HttpRelayService.REST_CACHE_TTL_MS);

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
    /** Latest poll command per channel + account + conversation (merges the Telegram reaction polls of several employees). */
    private recentPolls = new Map<string, RecentPoll>();
    private static SSE_QUEUE_TTL_MS = 600_000; // 10-minute TTL (was 2 min - WAN reconnect can take longer)
    private static SSE_QUEUE_MAX = 500;        // max queued events per employee (was 300)

    /** Tunnel state */
    private tunnelActive = false;
    private tunnelUrl: string | null = null;
    /** Saved tunnel that needs a restart when the relay starts again (after a workspace switch) */
    private tunnelPendingRestart = false;
    /** TunnelService.watch() of the relay port (registered once per port). */
    private tunnelWatchOff: (() => void) | null = null;
    private tunnelWatchPort: number | null = null;
    /** Most recent WAN address change (compared with the address from the previous run, saved in relay_tunnel_last_url). */
    private tunnelUrlChange: BossUrlChangedEvent | null = null;
    /** The most recent tunnel start was automatic (app opened / relay restarted), not pressed by BOSS. */
    private tunnelAutoStarted = false;
    /** Cloudflare auto: stop listening for changes, is in this mode, relay address recorded, schedule the old-style tunnel to shut down. */
    private cloudTunnelOff: (() => void) | null = null;
    private cloudTunnelMode = false;
    private cloudRelayUrl: string | null = null;
    private legacyTunnelRetireTimer: ReturnType<typeof setTimeout> | null = null;
    private static TUNNEL_LAST_URL_KEY = 'relay_tunnel_last_url';
    private static TUNNEL_AUTOSTART_KEY = 'relay_tunnel_autostart';

    /** powerSaveBlocker id: blocks Mac/OS sleep while the relay serves employees */
    private powerSaveId: number | null = null;

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

    /**
     * Channels to relay from EventBroadcaster → employees: the same source as the employee side (relayChannels.ts:
     * employees forward exactly these channels; a channel that is not relayed must be in BOSS_ONLY_CHANNELS with a reason).
     */
    private static RELAY_CHANNELS: readonly string[] = RELAY_CHANNELS;

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
            const allAccounts = db.getAccounts();
            // Per-channel session state (Facebook / Telegram are not in the Zalo ConnectionManager)
            const channelOf = new Map<string, string>(
                allAccounts.map((a: any): [string, string] => [String(a.zalo_id), String(a.channel || 'zalo')]));
            const onlineAccounts = assignedAccounts.filter((zaloId) => this.isAccountSessionOnline(zaloId, channelOf.get(zaloId)));
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
                    // Channel: the employee machine needs it to call the right adapter (missing → Facebook / Telegram accounts are treated as Zalo)
                    channel: (a as any).channel || 'zalo',
                    // Zalo My Documents (the built-in Zalo conversation) → the employee machine pins that exact conversation
                    send2me_id: db.resolveMyDocumentsId(a),
                    listener_active: onlineAccounts.includes(a.zalo_id) ? 1 : 0,
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
            // Every request from an employee serves the local workspace that is running (Boss DB), even when the relay was turned on by a command
            // the UI while the employee workspace screen is open (the 'ui' scope of dbScope carries across async flows).
            this.httpServer = http.createServer((req, res) => runInRuntimeScope(() => this.handleHttpRequest(req, res)));

            // Attach Socket.IO to the same HTTP server (path /socket.io)
            // Employees use WebSocket instead of SSE for real-time events. Realtime + catch-up filter by the same
            // assigned_accounts as the REST permission check (updateEmployeeRooms keeps them in sync).
            SocketIOService.getInstance().attach(this.httpServer, {
                resolveAssignedAccounts: (employeeId) => this.employees.get(employeeId)?.assigned_accounts,
            });
            // Public API v1: Socket.IO namespace /v1 for external apps & plugins (separate from employees).
            ApiPlatform.getInstance().attachSocket(SocketIOService.getInstance().getServer());

            this.hookEventBroadcaster();
            this.startOfflineCheck();

            // Option under Tools → Application, API & Webhook → API: listen on 127.0.0.1 only (a machine with no LAN employees).
            let bindLocalOnly = false;
            try { bindLocalOnly = getApiSettingBool('api_bind_localhost_only'); } catch { bindLocalOnly = false; }

            return new Promise((resolve) => {
                const onListening = () => {
                    this.running = true;
                    this.startPowerSaveBlocker();
                    Logger.log(`[HttpRelayService] ✅ Server started on port ${this.port}`);
                    // Cloudflare auto: listen on the shared tunnel's address and record the current address (other modes: do nothing)
                    this.ensureCloudTunnelWatcher();
                    this.onCloudTunnelChange();
                    // Turn the tunnel back on: it was running before the relay stopped (workspace switch) or "Auto-start tunnel when the app opens" is on.
                    // Use the saved config (Quick / Cloudflare with an account / ngrok); on error (no network yet) → retry automatically.
                    const restoreTunnel = this.tunnelPendingRestart || this.isTunnelAutoStart();
                    this.tunnelPendingRestart = false;
                    if (restoreTunnel) {
                        void this.startTunnel({ auto: true }).then((res) => {
                            if (res.success) {
                                Logger.log(`[HttpRelayService] 🔁 Tunnel auto-started: ${res.tunnelUrl}`);
                                this.broadcastEmployeeList();
                            } else {
                                Logger.warn(`[HttpRelayService] Tunnel auto-start failed: ${res.error} — TunnelService tự thử lại`);
                            }
                        });
                    }
                    resolve({ success: true, port: this.port });
                };
                if (bindLocalOnly) this.httpServer!.listen(this.port, '127.0.0.1', onListening);
                else this.httpServer!.listen(this.port, onListening);
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
            ApiPlatform.getInstance().detachSocket();
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
            // Stop the tunnel if active (including one restarting by itself), but remember to restart it later
            if (this.tunnelActive || TunnelService.getState(this.port)) {
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
            this.stopPowerSaveBlocker();
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
        tunnel: RelayTunnelStatus;
    } {
        const employees = Array.from(this.employees.values()).map(e => ({
            employee_id: e.employee_id,
            display_name: e.display_name,
            avatar_url: e.avatar_url,
            ip_address: e.ip_address,
            connected_at: e.connected_at,
            sseConnected: this.sseClients.has(e.employee_id),
        }));
        const tunnel = this.getTunnelStatus();
        // Cloudflare auto: the address comes from the shared tunnel (tunnelActive/tunnelUrl are only for the old-style tunnel)
        const cloudMode = !!cloudTunnelIfAuto();
        return {
            running: this.running,
            port: this.port,
            connectedEmployees: employees,
            localIPs: this.getLocalIPs(),
            tunnelActive: cloudMode ? tunnel.active : this.tunnelActive,
            tunnelUrl: cloudMode ? tunnel.tunnelUrl : this.tunnelUrl,
            tunnel,
        };
    }

    public isRunning(): boolean {
        return this.running;
    }

    /** Manage the removal of one employee (UI / API v1): ends the session completely. The old token is no longer valid; the employee must log in again. */
    public kickEmployee(employeeId: string): void {
        this.terminateEmployeeSession(employeeId, tr('Bị ngắt kết nối bởi quản lý'));
    }

    /**
     * Ends an employee's session completely: kick, lock / delete / change password (employeeIpc calls this after an edit or delete):
     * sends 'relay:kicked' with the reason → revokes the token (REST / heartbeat 401; the Socket.IO handshake is rejected) → disconnects the socket after
     * ~1 s (time to deliver the notice) → unregisters. Previously it only unregistered: the token was still valid, so the next request re-registered it and
     * the socket stayed open. If the relay is not running there is no session to end, so it only revokes the token.
     */
    public terminateEmployeeSession(employeeId: string, reason: string): void {
        if (!employeeId) return;
        if (this.running) {
            const emp = this.employees.get(employeeId);
            if (emp) {
                this.pushControlToEmployee(emp, 'relay:kicked', { reason });
            } else {
                // Socket still connected but not registered again (e.g. right after Boss restarted)
                try {
                    const sio = SocketIOService.getInstance();
                    if (sio.isOnline(employeeId)) sio.emitToEmployee(employeeId, 'relay:kicked', { reason });
                } catch { /* socket server not running */ }
            }
        }
        EmployeeService.getInstance().revokeEmployeeTokens(employeeId);
        if (this.running) {
            try { SocketIOService.getInstance().disconnectEmployee(employeeId); } catch { /* socket server not running */ }
        }
        this.unregisterEmployee(employeeId, reason);
    }

    /**
     * "Log out all employees": changes the signing key (every old token now has a bad signature; it is changed first, so if that fails nobody is affected) → sends
     * 'relay:kicked' to every connected employee → disconnects all employee sockets after ~1 s → removes all registrations.
     */
    public logoutAllEmployees(reason = tr('Quản lý đã đăng xuất tất cả nhân viên')): { success: boolean; notified: number; error?: string } {
        const rotated = EmployeeService.getInstance().rotateJwtSecret();
        if (!rotated.success) return { success: false, notified: 0, error: rotated.error || tr('Không đổi được khoá ký') };
        const notified = new Set<string>();
        if (this.running) {
            for (const emp of this.employees.values()) {
                this.pushControlToEmployee(emp, 'relay:kicked', { reason });
                notified.add(emp.employee_id);
            }
            try {
                const sio = SocketIOService.getInstance();
                for (const employeeId of sio.getOnlineEmployeeIds()) {
                    if (notified.has(employeeId)) continue;
                    sio.emitToEmployee(employeeId, 'relay:kicked', { reason });
                    notified.add(employeeId);
                }
                sio.disconnectAllEmployees();
            } catch { /* socket server not running */ }
        }
        // All registrations + all SSE streams (including the SSE of employees no longer in the registration list)
        const everyone = new Set<string>([...this.employees.keys(), ...this.sseClients.keys()]);
        for (const employeeId of everyone) this.unregisterEmployee(employeeId, reason);
        Logger.warn(`[HttpRelayService] 🔐 Đã đăng xuất tất cả nhân viên (${notified.size} nhân viên đang nối được báo)`);
        return { success: true, notified: notified.size };
    }

    /** Unregister one employee: close the SSE, clear the queue, end the online session in the DB, update the list. */
    private unregisterEmployee(employeeId: string, why: string): void {
        const sseRes = this.sseClients.get(employeeId);
        if (sseRes) { try { sseRes.end(); } catch {} this.sseClients.delete(employeeId); }
        const kt = this.sseKeepaliveTimers.get(employeeId);
        if (kt) { clearInterval(kt); this.sseKeepaliveTimers.delete(employeeId); }
        this.sseLastWriteOk.delete(employeeId);
        this.sseEventQueue.delete(employeeId); // clear any pending queue
        const emp = this.employees.get(employeeId);
        if (!emp) return;
        this.employees.delete(employeeId);
        // End session in DB for online time tracking
        try { this.runOnPinnedDb((db) => db.endEmployeeSession(employeeId)); } catch {}
        Logger.log(`[HttpRelayService] Ended session of ${emp.display_name}: ${why}`);
        this.broadcastEmployeeList();
    }

    // ─── HTTP Router ──────────────────────────────────────────────────

    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // readBody needs res to return 413 when the body exceeds the limit.
        (req as any).__relayRes = res;
        // ── Public API v1 + /docs (ApiPlatform): handled separately, does not touch the employee routes ──
        if (ApiPlatform.getInstance().handles(req.url || '')) {
            ApiPlatform.getInstance().handle(req, res).catch((err: any) => {
                Logger.error(`[HttpRelayService] API v1 error: ${err?.message || err}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: tr('Lỗi không mong đợi') } }));
                }
            });
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PATCH, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning, Bypass-Tunnel-Reminder, X-Zalo-Id, X-Filename');
        res.setHeader('Access-Control-Max-Age', '600');

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
        // Read queries use POST because the id list is long (stickers by id; CRM contacts filtered by Zalo label)
        if (req.method === 'POST' && url.startsWith('/api/query/stickers/by-ids')) {
            return this.handleRestApi(req, res);
        }
        if (req.method === 'POST' && url.startsWith('/api/query/crm/contacts')) {
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
        // Edit / delete an item, rename / delete a library folder (DataAccessor uses PATCH / DELETE): the router used to return 404
        if ((req.method === 'PATCH' || req.method === 'DELETE') && url.startsWith('/api/library/')) {
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
                    return this.json(res, 400, { success: false, error: tr('Thiếu username hoặc password') });
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
                this.json(res, 400, { success: false, error: tr('Request không hợp lệ') });
            }
        }, HttpRelayService.SMALL_BODY_BYTES);
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

                // Socket.IO has replaced SSE, so there is no need to detect half-open connections any more
                // (the heartbeat is only used to confirm the employee is still alive)

                this.json(res, 200, { success: true, ts: Date.now() });
            } catch (err: any) {
                this.json(res, 400, { success: false, error: err.message });
            }
        }, HttpRelayService.SMALL_BODY_BYTES);
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
        // ── Acting account (proxyActionPolicy.resolveProxyAccount): an explicitly stated ID (params or auth.accountId/zaloId)
        // must be assigned; a channel that runs on an account session (Zalo registry, login:connect) without a stated ID → only guess when
        // the guess is unambiguous (one assigned account / the conversation belongs to exactly one account). Previously, a missing zaloId → the account
        // that was assigned FIRST: a message / reaction / read from account B ran as account A.
        const { ipcHandlerRegistry: zaloRegistry } = require('../../../electron/ipc/zalo/zaloIpc');
        const isRegistryChannel = !!zaloRegistry?.has(channel);
        // Facebook / Telegram personal (employeeChannelRoutes, "proxy" group): the account = params.accountId, REQUIRED and must be
        // assigned (Facebook: the internal id fb_accounts.id → accounts.zalo_id before comparing). Previously the fb: / telegramUser: channels
        // went through no account check at all (resolveProxyAccount ignored accountId at the params level).
        const isAccountChannel = isAccountChannelProxy(channel);
        const accountDecision = isAccountChannel
            ? resolveAccountChannelProxy(params, employee.assigned_accounts, (id) => this.canonicalProxyAccountId(channel, id))
            : resolveProxyAccount(params, employee.assigned_accounts, {
                required: isRegistryChannel || SPECIAL_PROXY_CHANNELS.has(channel),
                ownersOfThreads: (threadIds, candidates) => this.lookupThreadOwners(threadIds, candidates),
            });
        if (accountDecision.allowed === false) {
            Logger.warn(`[HttpRelayService] 🚫 proxy ${channel} employee=${employee.employee_id}: ${accountDecision.code}`);
            return { success: false, error: accountDecision.error, code: accountDecision.code };
        }
        const zaloId = accountDecision.accountId;
        if (accountDecision.source === 'thread') {
            Logger.log(`[HttpRelayService] proxy ${channel}: tài khoản ${zaloId} suy ra từ hội thoại (UI chưa gửi id tài khoản)`);
        }

        // Check permission: needs ONE of the channel's modules (proxyActionPolicy.proxyChannelModules: zalo/fb/telegramUser →
        // chat, Facebook data scanning → crm, add friend / contacts → friends or chat…)
        const empSvc = EmployeeService.getInstance();
        const modules = proxyChannelModules(channel);
        if (modules.length > 0 && !modules.some((m) => empSvc.hasPermission(employee.employee_id, m))) {
            return { success: false, error: tr('Không có quyền truy cập module: {{v1}}', { v1: modules.join(' / ') }), code: 'MODULE_FORBIDDEN' };
        }

        // ── Channels + files (proxyActionPolicy.ts). Previously the `_invokeHandlers` fallback could call ANY ipcMain handler
        // (employee:update, relay:*, settings, plugins, API keys…), and the file-sending handler accepted an arbitrary path on the Boss machine
        // (it could send the whole DB file, containing every account's cookies, into a conversation).
        const channelDecision = checkProxyChannel(channel, (c) => !!zaloRegistry?.has(c));
        if (channelDecision.allowed === false) {
            Logger.warn(`[HttpRelayService] 🚫 proxy ${channel} employee=${employee.employee_id}: ${channelDecision.code}`);
            return { success: false, error: channelDecision.error, code: channelDecision.code };
        }
        const pathDecision = checkProxyFilePaths(params, this.proxyFilePathContext(employee));
        if (pathDecision.allowed === false) {
            Logger.warn(`[HttpRelayService] 🚫 proxy ${channel} employee=${employee.employee_id}: ${pathDecision.code} ${pathDecision.path}`);
            return { success: false, error: pathDecision.error, code: pathDecision.code };
        }
        params = pathDecision.params;
        const libraryDenied = this.checkProxyLibraryItems(employee, params);
        if (libraryDenied) {
            Logger.warn(`[HttpRelayService] 🚫 proxy ${channel} employee=${employee.employee_id}: thư viện ${libraryDenied}`);
            return { success: false, error: tr('Không có quyền dùng file thư viện này'), code: 'ACCOUNT_FORBIDDEN' };
        }
        // A command that only carries a record id (campaign, quick message…): the record must belong to the assigned account
        const ownerDenied = this.checkProxyRecordOwner(employee, channel, params);
        if (ownerDenied) {
            Logger.warn(`[HttpRelayService] 🚫 proxy ${channel} employee=${employee.employee_id}: ${ownerDenied}`);
            return { success: false, error: ownerDenied, code: 'ACCOUNT_FORBIDDEN' };
        }
        // A Zalo registry channel runs on the account's session → the account must have a session (connection) on Boss. Without one, then
        // wrap() / resolveZaloId does not match the cookie and falls into "the only connection" → the action runs as a DIFFERENT account.
        // (A session that is reconnecting, i.e. connected=false but still has a connection, is still allowed to run as on Boss.)
        if (isRegistryChannel && zaloId && !ConnectionManager.getConnection(zaloId)) {
            Logger.warn(`[HttpRelayService] proxy ${channel}: tài khoản ${zaloId} chưa đăng nhập trên Boss`);
            return { success: false, error: tr('Tài khoản chưa đăng nhập trên Boss'), code: 'ACCOUNT_OFFLINE' };
        }

        try {
            // Inject real auth
            if (params?.auth !== undefined) {
                const realAuth = this.resolveRealAuth(zaloId, params.auth);
                if (realAuth) {
                    params = { ...params, auth: realAuth, _fromRelay: true };
                } else if (zaloId) {
                    // No session / cookie for the account on Boss: do NOT pass the employee's auth down to the handler; wrap()
                    // would guess the account (the only connection / auth.zaloId) and could run as another account.
                    Logger.warn(`[HttpRelayService] Proxy: could not resolve real auth for zaloId=${zaloId}, channel=${channel}`);
                    return { success: false, error: tr('Tài khoản chưa đăng nhập trên Boss'), code: 'ACCOUNT_OFFLINE' };
                } else {
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
                    return { success: false, error: tr('Không tìm thấy thông tin xác thực') };
                } catch (err: any) {
                    return { success: false, error: err.message };
                }
            }

            // Use the handler registry. Facebook / Telegram personal (account already checked above): the EXACT ipcMain handler of Boss
            // (same normalization / DB saving / event emitting as the Boss UI), on the same branch as the Zalo registry so it records "which employee sent it".
            const { ipcHandlerRegistry } = require('../../../electron/ipc/zalo/zaloIpc');
            const handler = ipcHandlerRegistry?.get(channel)
                ?? (isAccountChannel ? (require('electron').ipcMain as any)?._invokeHandlers?.get(channel) : undefined);

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
                        return { success: false, error: tr('Không tìm thấy file video trong thư viện') };
                    }

                    const videoPath = libItem.file_path;
                    // zaloId = the account identified at the top of the function (not the first assigned account)

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
                            return { success: false, error: tr('Upload video thất bại') };
                        }
                    }
                    if (!videoUrl) {
                        return { success: false, error: tr('Upload video thất bại') };
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
                // Duplicate Telegram reaction poll (several employees open the same group) → do not ask Telegram again within 15 s:
                // the previous poll already saved to the DB and emitted the event for everyone (proxyActionPolicy.shouldSkipCoalescedPoll)
                if (COALESCED_POLL_CHANNELS.has(channel)) {
                    const pollKey = `${channel}|${params.accountId || ''}|${params.chatId || ''}`;
                    const pollIds: string[] = Array.isArray(params.messageIds) ? params.messageIds.map(String) : [];
                    const now = Date.now();
                    if (shouldSkipCoalescedPoll(this.recentPolls.get(pollKey), pollIds, now)) {
                        return { success: true, applied: 0, coalesced: true };
                    }
                    if (this.recentPolls.size > 500) this.recentPolls.clear();
                    this.recentPolls.set(pollKey, { at: now, ids: new Set(pollIds) });
                }
                Logger.log(`[HttpRelayService] 🔄 Calling handler ${channel}: filePath=${params.filePath?.substring?.(0, 50) || '(empty)'}, filePathType=${typeof params.filePath}`);
                const result = await handler(null, params);
                this.restApiCache.clear();

                // Log send actions + broadcast sender info to all workspaces. proxyActionPolicy.employeeSendInfo: Zalo by name, as before;
                // Facebook / Telegram for the exact channels that send messages (result { messageId }, conversation threadId / chatId);
                // a handler that reports an error → do not record "sent" (previously a failed message still counted as the employee having replied).
                const sendInfo = employeeSendInfo(channel, params, result);
                if (sendInfo) {
                    const { msgId, threadId } = sendInfo;
                    Logger.log(`[HttpRelayService] 📤 SEND result for employee=${employee.employee_id}: channel=${channel}, msgId="${msgId}", threadId="${threadId}", zaloId="${zaloId}", response=${JSON.stringify(result?.response ?? result ?? {}).slice(0, 500)}`);

                    this.runOnPinnedDb((db) => db.logEmployeeAction({
                        employee_id: employee.employee_id,
                        zalo_id: zaloId,
                        thread_id: threadId,
                        thread_type: sendInfo.threadType,
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
                                            thread_type: sendInfo.threadType,
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

                    // Broadcast sender info to employees assigned to this account so they know who replied
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
                        // Push to connected employees who are assigned this account (same rule as the Socket.IO realtime).
                        // Socket.IO: emit per account + buffer for catch-up. Employees not connected via Socket.IO (old version) →
                        // SSE / LAN callback / queue as before. Previously only the branch below existed: an employee over the tunnel
                        // (no SSE, no callback) sat in the queue forever and never saw "who replied".
                        let sio: SocketIOService | null = null;
                        try {
                            sio = SocketIOService.getInstance();
                            sio.publish('relay:messageSentByEmployee', senderPayload);
                        } catch { /* fall back to SSE / callback */ }
                        const senderAudience = classifyRelayEvent('relay:messageSentByEmployee', senderPayload);
                        for (const emp of this.employees.values()) {
                            if (!canReceiveRelayEvent(senderAudience, emp.employee_id, emp.assigned_accounts)) continue;
                            if (sio?.isOnline(emp.employee_id)) continue; // already received via Socket.IO above
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
                const ipcResult = await internalHandlers.get(channel)!(null, params);
                // Just wrote to Boss's DB: clear the GET cache (1.5 s) so the read right after (the UI reloads after saving) sees the new data
                this.restApiCache.clear();
                return ipcResult;
            }

            return { success: false, error: `No handler for channel: ${channel}` };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Proxy error (${channel}): ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /**
     * Among the `candidates` (assigned accounts), which account has the conversation / group `threadIds` (Boss's contacts table).
     * Used to guess the account for a proxy command from an old UI that does not send an account id (resolveProxyAccount).
     */
    private lookupThreadOwners(threadIds: string[], candidates: string[]): string[] {
        const threads = threadIds.slice(0, 50);
        if (threads.length === 0 || candidates.length === 0) return [];
        const rows = this.runOnPinnedDb((db) => db.query<{ owner_zalo_id: string }>(
            `SELECT DISTINCT owner_zalo_id FROM contacts WHERE contact_id IN (${threads.map(() => '?').join(',')})
             AND owner_zalo_id IN (${candidates.map(() => '?').join(',')})`,
            [...threads, ...candidates],
        )) || [];
        return rows.map((row) => String(row.owner_zalo_id));
    }

    /** Owner (owner_zalo_id) of a CRM campaign; null = no such campaign. */
    private campaignOwner(campaignId: unknown): string | null {
        const id = positiveInt(campaignId);
        if (!id) return null;
        const row = this.runOnPinnedDb((db) => db.queryOne<{ owner_zalo_id: string }>(
            'SELECT owner_zalo_id FROM crm_campaigns WHERE id = ?', [id]));
        return row?.owner_zalo_id ? String(row.owner_zalo_id) : null;
    }

    /** Owner of a local quick message; null = none. */
    private quickMessageOwner(id: unknown): string | null {
        const qmId = positiveInt(id);
        if (!qmId) return null;
        const row = this.runOnPinnedDb((db) => db.queryOne<{ owner_zalo_id: string }>(
            'SELECT owner_zalo_id FROM local_quick_messages WHERE id = ?', [qmId]));
        return row?.owner_zalo_id ? String(row.owner_zalo_id) : null;
    }

    /**
     * A proxy command that only carries a record id (no zaloId, or not enough of one): the record must belong to the assigned account (and to the
     * account in the params, if any). Previously, changing the status / deleting a campaign or toggling a quick message of a DIFFERENT account
     * was possible with only the id. If the record is not found, the handler reports it. Returns an error message, or null = allowed.
     */
    private checkProxyRecordOwner(employee: RegisteredEmployee, channel: string, params: any): string | null {
        let owner: string | null = null;
        if (channel === 'crm:updateCampaignStatus' || channel === 'crm:deleteCampaign' || channel === 'crm:cloneCampaign'
            || channel === 'crm:addCampaignContacts' || channel === 'crm:deleteCampaignContacts'
            || channel === 'crm:deleteAllCampaignContacts') {
            owner = this.campaignOwner(params?.campaignId);
        } else if (channel === 'db:setLocalQMActive' || channel === 'db:setLocalQMOrder') {
            owner = this.quickMessageOwner(params?.id);
        } else if (channel.startsWith('workflow:')) {
            return this.checkProxyWorkflowAccess(employee, channel, params);
        } else {
            return null;
        }
        if (!owner) return null;
        if (!employee.assigned_accounts.includes(owner)) return tr('Không có quyền truy cập tài khoản này');
        const requested = String(params?.zaloId || '');
        if (requested && requested !== owner) return tr('Bản ghi không thuộc tài khoản này');
        // Campaign copies into other accounts: every target account must be assigned too
        if (channel === 'crm:cloneCampaign' && commandExtraAccountIds({ targetZaloIds: params?.targetZaloIds })
            .some((id) => !employee.assigned_accounts.includes(id))) {
            return tr('Không có quyền truy cập tài khoản này');
        }
        return null;
    }

    /**
     * Workflow through the proxy (WorkflowEditor / template library / employee duplicate): the same rules as REST /api/command/workflows:
     * every page of the workflow (new and existing) must belong to an assigned account; the source / target pages of a duplicate too.
     */
    private checkProxyWorkflowAccess(employee: RegisteredEmployee, channel: string, params: any): string | null {
        const assigned = employee.assigned_accounts;
        const accountDenied = tr('Không có quyền truy cập tài khoản này');
        const pagesDenied = tr('Workflow gắn trang không được giao cho bạn');
        if (channel === 'workflow:cloneAll') {
            const ids = [params?.sourceZaloId, params?.targetZaloId].map((id) => String(id ?? ''));
            return ids.every((id) => id && assigned.includes(id)) ? null : accountDenied;
        }
        if (channel === 'workflow:clone') {
            const target = String(params?.targetZaloId ?? '');
            if (!target || !assigned.includes(target)) return accountDenied;
        }
        if (channel === 'workflow:save') {
            const workflow = params?.workflow || {};
            if (!workflowPagesAllowed(workflowPageIds(workflow.pageIds, workflow.pageId), assigned)) return pagesDenied;
        }
        const id = channel === 'workflow:save' ? String(params?.workflow?.id || '') : String(params?.id || '');
        return this.checkWorkflowPages(id, assigned) ? pagesDenied : null;
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
     * Handle media upload as raw binary (Content-Type: application/octet-stream).
     * The employee sends the file binary directly (no base64).
     * Headers: X-Filename (required), X-Zalo-Id (optional)
     * Boss saves it to media storage and returns the absolute path.
     */
    private handleMediaUploadMultipart(req: http.IncomingMessage, res: http.ServerResponse): void {
        const employee = this.authenticateRequest(req);
        if (!employee) {
            return this.json(res, 401, { success: false, error: 'Unauthorized' });
        }

        const rawFilename = req.headers['x-filename'] as string;
        if (!rawFilename) {
            return this.json(res, 400, { success: false, error: 'Missing X-Filename header' });
        }
        const zaloId = (req.headers['x-zalo-id'] as string) || employee.assigned_accounts[0] || '';
        if (zaloId && !employee.assigned_accounts.includes(zaloId)) {
            return this.json(res, 403, { success: false, error: tr('Không có quyền truy cập tài khoản này'), code: 'ACCOUNT_FORBIDDEN' });
        }
        const maxBytes = HttpRelayService.MAX_MEDIA_UPLOAD_BYTES;
        if (Number(req.headers['content-length'] || 0) > maxBytes) {
            req.resume();
            return this.json(res, 413, { success: false, error: tr('File tối đa {{v1}} MB', { v1: Math.round(maxBytes / 1024 / 1024) }), code: 'PAYLOAD_TOO_LARGE' });
        }

        // The name sent by the employee (the client uses encodeURIComponent): only the name part is kept. Previously it was joined straight into the path,
        // "..\..\Startup\x.bat" could write a file outside the media folder. The original name is kept (Zalo uses it as the attachment file name).
        const filename = toSafeFileName(rawFilename, `upload_${Date.now()}`);
        let dir: string;
        try {
            dir = zaloId ? FileStorageService.getAccountDir(zaloId) : path.join(FileStorageService.getBaseDir(), '_uploads');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (err: any) {
            req.resume();
            Logger.error(`[HttpRelayService] Upload error: ${err.message}`);
            return this.json(res, 500, { success: false, error: err.message });
        }

        // Write straight to disk (temp file, then rename), without gathering the whole file in RAM; over the limit → 413.
        const tmpPath = path.join(dir, `.upload-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.part`);
        const out = fs.createWriteStream(tmpPath);
        let size = 0;
        let settled = false;
        const fail = (status: number, error: string, code?: string) => {
            if (settled) return;
            settled = true;
            req.unpipe(out);
            out.destroy();
            fs.promises.unlink(tmpPath).catch(() => {});
            req.resume();
            if (status >= 500) Logger.error(`[HttpRelayService] Upload error: ${error}`);
            this.json(res, status, { success: false, error, ...(code ? { code } : {}) });
        };
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) fail(413, tr('File tối đa {{v1}} MB', { v1: Math.round(maxBytes / 1024 / 1024) }), 'PAYLOAD_TOO_LARGE');
        });
        req.on('close', () => { if (!req.complete) fail(400, tr('Upload bị ngắt giữa chừng')); });
        req.on('error', (err: Error) => fail(400, err.message));
        out.on('error', (err: Error) => fail(500, err.message));
        out.on('finish', () => {
            if (settled) return;
            if (size === 0) return fail(400, 'Empty file');
            try {
                // Name collision (two employees both send "image.png") → "image (1).png" instead of overwriting the other person's file
                const bossPath = uniqueFilePath(dir, filename);
                fs.renameSync(tmpPath, bossPath);
                settled = true;
                Logger.log(`[HttpRelayService] Binary upload: ${filename} (${(size / 1024).toFixed(1)}KB) → ${bossPath}`);
                this.json(res, 200, { success: true, bossPath });
            } catch (err: any) {
                fail(500, err.message);
            }
        });
        req.pipe(out);
    }

    // ═════════════════════════════════════════════════════════════════
    // REST API HANDLER — dispatch to RestApiHandlers or MediaHandler
    // ═════════════════════════════════════════════════════════════════

    private handleRestApi(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = req.url || '';

        // ── Media / library files: requires an employee session + account permission (bossFileAccess.ts) ──
        // It used to be open ("tunnel security"): anyone who knew the Boss / tunnel URL could download the files. The employee machine attaches
        // Authorization for <img>/<video> (session.webRequest, bossSessionAuth.ts). NO loopback exemption:
        // cloudflared / ngrok connect from 127.0.0.1 → loopback = Internet. Boss's own UI uses local-media://.
        if (req.method === 'GET') {
            const filePathname = url.indexOf('?') >= 0 ? url.slice(0, url.indexOf('?')) : url;
            const libraryFile = /^\/api\/library\/(file|thumb)\/([a-f0-9-]+)$/.exec(filePathname);
            if (url.startsWith('/api/media/') || libraryFile) {
                const fileEmployee = this.authenticateRequest(req);
                if (!fileEmployee) {
                    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return;
                }
                fileEmployee.lastSeen = Date.now();

                if (libraryFile) {
                    // A library item lives in Boss's DB → runOnPinnedDb; LibraryHandler checks the item's owner
                    const [, kind, uuid] = libraryFile;
                    this.runOnPinnedDb(() => (kind === 'file'
                        ? libraryHandlers.serveFile(req, res, uuid, fileEmployee)
                        : libraryHandlers.serveThumb(req, res, uuid, fileEmployee)));
                    return;
                }

                const mediaBasePath = this.getBossMediaBasePath();
                if (!mediaBasePath) {
                    return this.json(res, 500, { error: 'Media path not configured' });
                }
                return handleMediaFileServe(req, res, mediaBasePath, {
                    employee: fileEmployee,
                    lookupAccount: (segment) => this.lookupMediaAccountId(segment),
                });
            }
        }

        // ── Other endpoints that need auth ──
        const employee = this.authenticateRequest(req);
        if (!employee) {
            return this.json(res, 401, { success: false, error: 'Unauthorized' });
        }
        // A successful REST call also proves the employee is online (not only the heartbeat)
        employee.lastSeen = Date.now();

        // Parse the URL to dispatch
        const method = req.method;
        let params: any = {};

        // Parse query params from the URL: auto-parse JSON objects/arrays (except text boxes the user types in: search, q, phone…)
        const queryIndex = url.indexOf('?');
        const pathname = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
        if (queryIndex >= 0) params = parseRestQueryParams(url.slice(queryIndex));

        // ── Permissions: the accounts in the params must be assigned to the employee; /api/query/analytics/* needs the
        // 'analytics' module. Write commands (/api/command/*) are checked again on the body in executeRestCommand.
        if (method === 'GET') {
            const denied = checkEmployeeAccess(employee, pathname, params,
                (module) => EmployeeService.getInstance().hasPermission(employee.employee_id, module));
            if (denied) {
                Logger.warn(`[HttpRelayService] 🚫 ${method} ${pathname} employee=${employee.employee_id}: ${denied.code}`);
                return this.json(res, denied.status, { success: false, error: denied.error, code: denied.code });
            }
        }

        // ── Dispatch by URL pattern (runs in the pinned DB context) ──
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
                    () => DatabaseService.getInstance().getContactsWithFlags(zaloId) || [], params);
                return this.json(res, 200, { success: true, data: { items: rows } });
            }
            // Unread conversations, "Tự động đánh dấu đã đọc" (auto mark as read): MUST come before the /conversations/:id regex below
            // (previously placed after it → read as the conversation id "unread" → always empty in employee mode)
            if (method === 'GET' && pathname === '/api/query/conversations/unread') {
                return this.json(res, 200, restHandlers.getUnreadConversations(employee, params));
            }
            // Filter for the employee's conversation list (channel / search / Unread / Other / Not replied / date range)
            if (method === 'GET' && pathname === '/api/query/conversations/filtered') {
                return this.json(res, 200, restHandlers.getConversationsFiltered(employee, params));
            }
            // ⚠️ The specific route /api/query/conversations/<name> must come BEFORE this catch-all regex (employeeRestContract.test)
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
            // unread / by-type MUST come before the /messages/:msgId regex below (previously placed after it → read as the message id
            // "unread" / "by-type" → return null: the group messages table has no polls, and the unread count is empty in employee mode)
            if (method === 'GET' && pathname === '/api/query/messages/unread') {
                return this.json(res, 200, restHandlers.getUnreadCountHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/messages/by-type') {
                return this.json(res, 200, restHandlers.getMessagesByTypeHandler(employee, params));
            }
            // ⚠️ The specific route /api/query/messages/<name> must come BEFORE this catch-all regex (employeeRestContract.test)
            if (method === 'GET' && pathname.match(/^\/api\/query\/messages\/[^/]+$/)) {
                const msgId = pathname.split('/').pop() || '';
                return this.json(res, 200, restHandlers.getMessageById(employee, { ...params, msgId }));
            }

            // Search
            if (method === 'GET' && pathname === '/api/search/messages') {
                return this.json(res, 200, restHandlers.searchMessages(employee, params));
            }
            if (method === 'GET' && pathname === '/api/search/contacts') {
                return this.json(res, 200, restHandlers.searchContactsForPicker(employee, params));
            }
            if (method === 'GET' && pathname === '/api/search/contact-by-phone') {
                return this.json(res, 200, restHandlers.searchContactByPhone(employee, params));
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
            if (method === 'GET' && pathname === '/api/query/groups/members/page') {
                return this.json(res, 200, restHandlers.getGroupMembersPage(employee, params));
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
                    () => restHandlers.getLabels(employee, params), params));
            }
            if (method === 'GET' && pathname === '/api/query/label-threads') {
                return this.json(res, 200, this.getCachedRestResult(method, pathname, employee.employee_id,
                    () => restHandlers.getLabelThreads(employee, params), params));
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

            // Settings: per-account notifications (previously swallowed by the generic route)
            if (method === 'GET' && pathname === '/api/query/settings/notif') {
                const target = String(params.zaloId || employee.assigned_accounts[0] || '');
                const raw = target ? DatabaseService.getInstance().getSetting(`notifSettings_${target}`) : null;
                let data: any = null;
                try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
                return this.json(res, 200, { success: true, data });
            }
            // Settings: one key, and only keys in the allowlist (does not expose employee_jwt_secret, tunnel tokens…)
            if (method === 'GET' && pathname.match(/^\/api\/query\/settings\/[^/]+$/)) {
                const key = decodeURIComponent(pathname.split('/').pop() || '');
                if (!isEmployeeSettingKey(key)) {
                    return this.json(res, 403, { success: false, error: tr('Không có quyền đọc cài đặt này'), code: 'SETTING_FORBIDDEN' });
                }
                return this.json(res, 200, restHandlers.getSetting(employee, { ...params, key }));
            }

            // (Unread conversations: see the route before the /conversations/:id regex above)

            // Starred messages, "Tin đánh dấu" (starred): keys of one account or the list of several
            if (method === 'GET' && pathname === '/api/query/starred-messages') {
                return this.json(res, 200, restHandlers.getStarredMessages(employee, params));
            }

            // Pinned conversations (cached — called redundantly after every message)
            if (method === 'GET' && pathname === '/api/query/pinned-conversations') {
                return this.json(res, 200, this.getCachedRestResult(method, pathname, employee.employee_id,
                    () => restHandlers.getPinnedConversations(employee, params), params));
            }

            // Settings — all
            if (method === 'GET' && pathname === '/api/query/settings') {
                const allSettings = (DatabaseService.getInstance().query<any>('SELECT key, value FROM app_settings') || [])
                    .filter((row: any) => isEmployeeSettingKey(String(row?.key || '')));
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
            if (method === 'GET' && pathname === '/api/query/analytics/outreach') {
                return this.json(res, 200, restHandlers.getOutreachStats(employee, params));
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
            // Reports with several accounts: one query over all of them (assigned accounts only)
            if (method === 'GET' && pathname === '/api/query/analytics/workflows-multi') {
                return this.json(res, 200, restHandlers.getWorkflowAnalyticsMulti(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/ai') {
                return this.json(res, 200, restHandlers.getAIAnalytics(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/response-time') {
                return this.json(res, 200, restHandlers.getResponseTime(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/response-time-multi') {
                return this.json(res, 200, restHandlers.getResponseTimeMulti(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/analytics/label-usage') {
                return this.json(res, 200, restHandlers.getLabelUsage(employee, params));
            }


            // ── Pinned messages ──
            if (method === 'GET' && pathname === '/api/query/pinned-messages') {
                return this.json(res, 200, restHandlers.getPinnedMessages(employee, params));
            }

            // ── Stickers ──
            if (method === 'GET' && pathname === '/api/query/sticker-packs') {
                // ?catId=… = the stickers of ONE pack (DataAccessor.getStickersByPackId); previously it always returned the list of packs
                if (params.catId !== undefined && params.catId !== '') {
                    return this.json(res, 200, restHandlers.getStickersByPackIdHandler(employee, params));
                }
                return this.json(res, 200, restHandlers.getStickerPacksHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/stickers/recent') {
                return this.json(res, 200, restHandlers.getRecentStickersHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/stickers/by-ids') {
                return this.json(res, 200, restHandlers.getStickersByIdsHandler(employee, params));
            }
            if (method === 'POST' && pathname === '/api/query/stickers/by-ids') {
                // The id list is in the JSON body → read the body, then answer in the correct relay DB
                this.readBody(req, (body) => {
                    let parsed: any = {};
                    try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
                    const result = this.runOnPinnedDb(() => restHandlers.getStickersByIdsHandler(employee, { ...params, ...parsed }));
                    return this.json(res, 200, result);
                });
                return;
            }

            // ── CRM tags ──
            if (method === 'GET' && pathname === '/api/query/crm/tags') {
                return this.json(res, 200, restHandlers.getCRMTagsHandler(employee, params));
            }

            // ── Bank cards ──
            if (method === 'GET' && pathname === '/api/query/bank-cards') {
                return this.json(res, 200, restHandlers.getBankCardsHandler(employee, params));
            }

            // ── ERP: projects, tasks, calendar, notes, HR, attendance, leave, notifications ──
            // The ErpRestRoutes table (specific routes before /:id) → the EXACT erp:* IPC handler with the employee's ERP identity
            // (executeErpRest). The 'erp' module permission was already checked in checkEmployeeAccess above.
            if (method === 'GET' && pathname.match(/^\/api\/query\/erp\//)) {
                this.executeErpRest(employee, method, pathname, params)
                    .then(({ status, body }) => this.json(res, status, body))
                    .catch((err: any) => {
                        Logger.error(`[HttpRelayService] ERP ${method} ${pathname} error: ${err?.message || err}`);
                        this.json(res, 500, { success: false, error: err?.message || String(err) });
                    });
                return;
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
            if (method === 'POST' && pathname === '/api/query/crm/contacts') {
                // Filter by Zalo label: the list of conversations for the label is in the body. Check account permission on the body, like GET
                // (checkEmployeeAccess above only runs for GET), then answer in the correct relay DB.
                this.readBody(req, (body) => {
                    let parsed: any = {};
                    try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
                    const merged = { ...params, ...parsed };
                    const denied = checkEmployeeAccess(employee, pathname, merged,
                        (module) => EmployeeService.getInstance().hasPermission(employee.employee_id, module));
                    if (denied) {
                        Logger.warn(`[HttpRelayService] 🚫 ${method} ${pathname} employee=${employee.employee_id}: ${denied.code}`);
                        return this.json(res, denied.status, { success: false, error: denied.error, code: denied.code });
                    }
                    const result = this.runOnPinnedDb(() => restHandlers.getCRMContactsHandler(employee, merged));
                    return this.json(res, 200, result);
                });
                return;
            }
            if (method === 'GET' && pathname === '/api/query/crm/contacts/stats') {
                return this.json(res, 200, restHandlers.getContactStatsHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/campaigns/contacts') {
                return this.json(res, 200, restHandlers.getCampaignContactsHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/crm/campaigns/engagement') {
                return this.json(res, 200, restHandlers.getCampaignEngagementHandler(employee, params));
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

            // (Messages extended: unread / by-type, see the route before the /messages/:msgId regex above)

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
                        const assistantId = parsed.assistantId || parsed.params?.assistantId;
                        const messages = parsed.messages || parsed.params?.messages || [];
                        const maxTokens = parsed.maxTokens || parsed.params?.maxTokens || undefined;
                        const result = (parsed.rawSystem === true || parsed.params?.rawSystem === true)
                            ? await AIAssistantService.getInstance().chatRaw(assistantId, messages, {
                                maxTokens, temperature: parsed.temperature ?? parsed.params?.temperature,
                            })
                            : await AIAssistantService.getInstance().chat(
                                assistantId,
                                messages,
                                parsed.structured === true || parsed.params?.structured === true,
                                maxTokens
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
                            parsed.chatHistory || parsed.params?.chatHistory || [],
                            parsed.count ?? parsed.params?.count,
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
            // executeRestCommand: check permission → Boss's IPC handler (workflow / integration / campaign / note / attaching
            // label; same logic + events as the Boss UI) or write to the DB directly (runOnPinnedDb). The body is read first, then it runs, so
            // it must wait (async) and pin the DB itself; the readBody callback is outside handleRestApi's runOnPinnedDb.
            if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && pathname.startsWith('/api/command/')) {
                const commandMethod = method;
                this.readBody(req, async (body) => {
                    let parsed: any;
                    try {
                        parsed = body ? JSON.parse(body) : {};
                    } catch (err: any) {
                        return this.json(res, 400, { success: false, error: err.message });
                    }
                    try {
                        const result = await this.executeRestCommand(employee, pathname, { ...params, ...parsed }, commandMethod);
                        // Permission denied → 403 like a read command (RestQueryService: ACCOUNT_FORBIDDEN → refresh the snapshot)
                        const status = result?.success === false && result?.status === 403 ? 403 : 200;
                        return this.json(res, status, result);
                    } catch (err: any) {
                        Logger.error(`[HttpRelayService] Command ${commandMethod} ${pathname} error: ${err.message}`);
                        return this.json(res, 500, { success: false, error: err.message });
                    }
                });
                return;
            }

            // ── LIBRARY endpoints ──
            if (method === 'POST' && pathname === '/api/library/upload') {
                return libraryHandlers.handleUpload(req, res, employee);
            }
            // Employee mode: upload via JSON base64 (DataAccessor sends it through RestQueryService)
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
                // The uuid is in the path (previously only the query was read → always "Missing uuid"); the body is read outside
                // runOnPinnedDb → pins the DB itself; broken JSON → 400 (previously it threw inside the 'end' callback)
                const uuid = pathname.split('/').pop() || '';
                this.readBody(req, (body) => {
                    let parsed: any = {};
                    try { parsed = body ? JSON.parse(body) : {}; } catch { return this.json(res, 400, { success: false, error: tr('Body không hợp lệ') }); }
                    try {
                        const result = this.runOnPinnedDb(() => libraryHandlers.updateItem(employee, { ...params, ...parsed, uuid }));
                        return this.json(res, 200, result);
                    } catch (err: any) {
                        return this.json(res, 500, { success: false, error: err.message });
                    }
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
                    let parsed: any = {};
                    try { parsed = body ? JSON.parse(body) : {}; } catch { return this.json(res, 400, { success: false, error: tr('Body không hợp lệ') }); }
                    try {
                        return this.json(res, 200, this.runOnPinnedDb(() => libraryHandlers.createFolder(employee, { ...params, ...parsed })));
                    } catch (err: any) {
                        return this.json(res, 500, { success: false, error: err.message });
                    }
                });
                return;
            }
            // Rename a folder (DataAccessor.renameLibraryFolder): there was no route before
            if (method === 'PATCH' && pathname.match(/^\/api\/library\/folders\/\d+$/)) {
                const id = pathname.split('/').pop() || '';
                this.readBody(req, (body) => {
                    let parsed: any = {};
                    try { parsed = body ? JSON.parse(body) : {}; } catch { return this.json(res, 400, { success: false, error: tr('Body không hợp lệ') }); }
                    try {
                        return this.json(res, 200, this.runOnPinnedDb(() => libraryHandlers.renameFolder(employee, { ...params, ...parsed, id })));
                    } catch (err: any) {
                        return this.json(res, 500, { success: false, error: err.message });
                    }
                });
                return;
            }
            if (method === 'DELETE' && pathname.match(/^\/api\/library\/folders\/\d+$/)) {
                const id = pathname.split('/').pop() || '';
                return this.json(res, 200, libraryHandlers.deleteFolder(employee, { ...params, id }));
            }
            // GET /api/library/file|thumb/<uuid> is served at the start of handleRestApi (auth + owner check on the item)

            return this.json(res, 404, { success: false, error: `Unknown endpoint: ${method} ${pathname}` });
            }); // end runOnPinnedDb
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Rest API error: ${err.message}`);
            this.json(res, 500, { success: false, error: err.message });
        }
    }

    /**
     * Employee REST write commands: POST/PUT/PATCH/DELETE /api/command/*.
     * Order: account permission (employeeAccess) → command permission (restCommandPolicy: module, Boss-only commands, source / target
     * account) → Boss's IPC handler if the command has a matching one (executeRestCommandViaIpc) → direct DB write
     * (executeRestCommandOnDb, inside the pinned DB). After writing, it emits the SAME events as the Boss UI so Boss and the other
     * employees update right away (previously many REST commands wrote to the DB without emitting anything, or emitted without ownerZaloId).
     * Permission denied → `{ success: false, …, status: 403 }` (the router returns HTTP 403, like read commands).
     */
    private executeRestCommand(employee: any, pathname: string, params: any, _method?: string): Promise<any> {
        // The signature stays in the form `private executeRestCommand(` (not async): employeeRestContract.test uses it as the end marker of handleRestApi
        return this.runRestCommand(employee, pathname, params, _method || 'POST');
    }

    private async runRestCommand(employee: any, pathname: string, params: any, httpMethod: string): Promise<any> {
        const hasPermission = (module: string) => EmployeeService.getInstance().hasPermission(employee.employee_id, module);
        const denied = checkEmployeeAccess(employee, pathname, params, hasPermission)
            || checkRestCommand(employee, pathname, params, hasPermission);
        if (denied) {
            Logger.warn(`[HttpRelayService] 🚫 ${httpMethod} ${pathname} employee=${employee.employee_id}: ${denied.code}`);
            return { success: false, error: denied.error, code: denied.code, status: 403 };
        }
        try {
            // ERP: the ErpRestRoutes table → the erp:* IPC handler with the employee's ERP identity (ERP permission is checked before IPC)
            if (pathname.startsWith(ERP_REST_COMMAND_PREFIX)) {
                const { status, body } = await this.executeErpRest(employee, httpMethod, pathname, params);
                return status === 403 ? { ...body, status: 403 } : body;
            }
            const viaIpc = await this.executeRestCommandViaIpc(employee, pathname, params, httpMethod);
            if (viaIpc !== undefined) return viaIpc;
            return this.runOnPinnedDb(() => this.executeRestCommandOnDb(employee, pathname, params, httpMethod));
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Command error (${httpMethod} ${pathname}): ${err.message}`);
            return { success: false, error: err.message };
        } finally {
            // Just wrote to the DB: clear the GET cache (1.5 s) so the read right after (the UI reloads after saving) sees the new data
            this.restApiCache.clear();
        }
    }

    /** Call Boss's own IPC handler (as the Boss UI calls it). `_fromRelay`: the handler does not proxy any further. */
    private async invokeBossIpc(channel: string, params: any): Promise<any> {
        const { ipcMain } = require('electron');
        const handler: Function | undefined = (ipcMain as any)._invokeHandlers?.get(channel);
        if (!handler) return { success: false, error: `No handler for channel: ${channel}` };
        const result = await handler(null, { ...params, _fromRelay: true });
        return result ?? { success: false, error: tr('Handler {{channel}} không trả kết quả', { channel }) };
    }

    /**
     * ERP over REST (GET /api/query/erp/*, /api/command/erp/* commands): a route in the ErpRestRoutes table → the EXACT erp:* IPC handler
     * on Boss, running with the employee's ERP identity (ErpAuthContext.forEmployee + runAs: role / permissions set per ERP profile
     * on Boss; the caller never takes these from the params). The 'erp' module permission was already checked earlier
     * (employeeAccess / restCommandPolicy); here the route's ERP permission is checked BEFORE entering IPC (withErpAuth checks
     * the same action again). Same service → the realtime event is emitted exactly once, as in the Boss UI; same envelope
     * `{ success, ...fields, error, code }`; permission denied → `code: 'permission_denied'` + HTTP 403.
     * The ERP handlers are synchronous (better-sqlite3): the DB read/write runs entirely inside runOnPinnedDb before the first `await`.
     */
    private async executeErpRest(employee: RegisteredEmployee, httpMethod: string, pathname: string, params: any): Promise<{ status: number; body: any }> {
        const match = matchErpRestRoute(httpMethod, pathname, params);
        if (!match) {
            return { status: 404, body: { success: false, error: `Unknown endpoint: ${httpMethod} ${pathname}`, code: 'NOT_FOUND' } };
        }
        const { default: ErpAuthContext, ErpPermissionError } = require('../erp/ErpAuthContext');
        try {
            const body = await this.runOnPinnedDb(() => {
                const ctx = ErpAuthContext.forEmployee(String(employee.employee_id));
                if (match.route.action) ErpAuthContext.requirePermission(match.route.action, ctx);
                const attachmentsDenied = this.checkErpTaskAttachments(employee, match.route.channel, match.input);
                if (attachmentsDenied) return attachmentsDenied;
                return ErpAuthContext.runAs(ctx, () => this.invokeBossIpc(match.route.channel, match.input));
            });
            if (body?.success === false && body?.code === 'permission_denied') {
                Logger.warn(`[HttpRelayService] 🚫 ERP ${httpMethod} ${pathname} employee=${employee.employee_id}: ${body.error}`);
            }
            return { status: erpRestHttpStatus(body), body };
        } catch (err: any) {
            if (err instanceof ErpPermissionError) {
                Logger.warn(`[HttpRelayService] 🚫 ERP ${httpMethod} ${pathname} employee=${employee.employee_id}: ${err.message}`);
                return { status: 403, body: { success: false, error: err.message, code: 'permission_denied' } };
            }
            throw err;
        }
    }

    /**
     * Attachments on a task sent by an employee (create / edit task): only files already attached to this same task, or files in
     * Boss's media folder that the employee is allowed to use (uploaded earlier via /api/media/upload). Same path rules as
     * /api/proxy/action. Previously REST accepted any path: Boss copied ANY file on the Boss machine into
     * media/erp/tasks (every employee could download it). If valid, the normalized path is returned (the handler uses exactly the file that was checked).
     */
    private checkErpTaskAttachments(employee: RegisteredEmployee, channel: string, input: any): any | null {
        const holder = erpTaskAttachmentHolder(channel, input);
        if (!holder) return null;
        const existing = new Set<string>();
        if (channel === 'erp:task:update' && input?.id) {
            const rows = DatabaseService.getInstance().query<{ file_path: string }>(
                'SELECT file_path FROM erp_task_attachments WHERE task_id = ?', [String(input.id)]) || [];
            for (const row of rows) if (row?.file_path) existing.add(String(row.file_path));
        }
        let pathContext: ProxyPathContext | null = null;
        const next: any[] = [];
        for (const item of holder.attachments) {
            const filePath = item?.file_path;
            if (typeof filePath === 'string' && existing.has(filePath)) { next.push(item); continue; }
            pathContext = pathContext || this.proxyFilePathContext(employee);
            const decision = checkProxyFilePaths({ filePath }, pathContext);
            if (decision.allowed === false) {
                Logger.warn(`[HttpRelayService] 🚫 ERP ${channel} employee=${employee.employee_id}: tệp đính kèm ${decision.code} ${decision.path}`);
                return { success: false, error: decision.error, code: decision.code };
            }
            next.push({ ...item, file_path: decision.params.filePath });
        }
        holder.attachments = next;
        return null;
    }

    /** Account-scoped command without a zaloId (the employee has several assigned accounts → no guessing). */
    private static commandAccountRequired(): any {
        return { success: false, error: tr('Thiếu tài khoản (zaloId) cho thao tác này'), code: 'ACCOUNT_REQUIRED' };
    }

    /**
     * The campaign of the command must belong to the assigned account (and match the zaloId if the command sends one). `error` not null = return
     * right away. Previously it was checked by id alone: changing the status, deleting a contact or duplicating another account's campaign was allowed; and
     * deleting a campaign with one's own zaloId plus someone else's id wiped that campaign's whole contact list.
     */
    private requireCampaignOwner(campaignId: number, zaloId: string, assigned: readonly string[]): { owner: string; error: any } {
        const owner = this.campaignOwner(campaignId);
        if (!owner) return { owner: '', error: { success: false, error: tr('Không tìm thấy chiến dịch') } };
        if (!assigned.includes(owner) || (zaloId && zaloId !== owner)) {
            return { owner: '', error: { success: false, error: tr('Không có quyền với chiến dịch này'), code: 'ACCOUNT_FORBIDDEN', status: 403 } };
        }
        return { owner, error: null };
    }

    /** The workflow in use must have all its pages assigned (workflowPagesAllowed). null = allowed / no such workflow. */
    private checkWorkflowPages(workflowId: string, assigned: readonly string[]): any | null {
        if (!workflowId) return null;
        const row: any = this.runOnPinnedDb((db) => db.getWorkflowById(workflowId));
        if (!row) return null;
        if (workflowPagesAllowed(workflowPageIds(row.page_ids, row.page_id), assigned)) return null;
        return { success: false, error: tr('Workflow gắn trang không được giao cho bạn'), code: 'ACCOUNT_FORBIDDEN', status: 403 };
    }

    /**
     * A REST command with a matching IPC handler on Boss → runs that handler: same normalization, checks, events and engine reload as the Boss UI.
     * Previously REST wrote straight to the DB: saving / toggling a workflow did not reload the engine (it only took effect after Boss restarted), an integration
     * called a function that did not exist (IntegrationRegistry.getInstance → always an error), a campaign switched to "active" while the send queue did not run,
     * labeling did not trigger the "label" workflow, conversation flag events lacked ownerZaloId (other employees could not save), and the id was cut at the wrong position
     * (`split('/')[3]` = "conversations" / "labels" / "workflows" / "integrations" → flags, nicknames and toggles wrote into a record with that name).
     * undefined = not this kind of command (written directly to the DB in executeRestCommandOnDb).
     */
    private async executeRestCommandViaIpc(employee: any, pathname: string, params: any, httpMethod: string): Promise<any | undefined> {
        const assigned: string[] = (employee.assigned_accounts || []).map(String);
        const zaloId = defaultCommandAccount(params, assigned);
        const isDelete = httpMethod === 'DELETE';
        const accountRequired = HttpRelayService.commandAccountRequired;

        // ── Conversations: flags (mute notifications / Other folder / @) + nickname ──
        const flagsPath = commandPathParams(pathname, /^\/api\/command\/conversations\/([^/]+)\/flags$/);
        if (flagsPath) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:setContactFlags', { zaloId, contactId: flagsPath[0], flags: params.flags || {} });
        }
        const aliasPath = commandPathParams(pathname, /^\/api\/command\/conversations\/([^/]+)\/alias$/);
        if (aliasPath) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:setContactAlias', { zaloId, contactId: aliasPath[0], alias: String(params.alias ?? '') });
        }
        // Contact profile: the handler only emits db:contactProfileUpdated when the profile actually changes (the old REST emitted every time)
        // MUST come before the delete route (the /conversations/<id> regex also matches "update-profile")
        if (pathname === '/api/command/conversations/update-profile') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:updateContactProfile', {
                zaloId, contactId: params.contactId, displayName: params.displayName, avatarUrl: params.avatarUrl,
                phone: params.phone, contactType: params.contactType, gender: params.gender, birthday: params.birthday,
                isBot: null, manualDetails: !!params.manualDetails,
            });
        }
        // Mark as replied / unmark in bulk (the handler emits db:replyStateChanged like the Boss UI): before the delete regex
        if (pathname === '/api/command/conversations/replied') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:markConversationsReplied', {
                zaloId,
                contactIds: Array.isArray(params.contactIds) ? params.contactIds.map(String) : [],
                replied: params.replied !== false,
            });
        }
        const conversationPath = commandPathParams(pathname, /^\/api\/command\/conversations\/([^/]+)$/);
        if (conversationPath && isDelete) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:deleteConversation', { zaloId, contactId: conversationPath[0] });
        }

        // ── Messages: read / removed from app (the handler emits db:unreadChanged / event:delete like the Boss UI) ──
        if (pathname === '/api/command/messages/mark-read') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:markAsRead', { zaloId, contactId: params.contactId });
        }
        if (pathname === '/api/command/messages/delete') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:deleteMessages', {
                zaloId, msgIds: Array.isArray(params.msgIds) ? params.msgIds.map(String) : [],
                ...(params.threadId ? { threadId: String(params.threadId) } : {}),
            });
        }

        // ── Pin a conversation / starred messages / pin a message ──
        if (pathname === '/api/command/pinned-conversations') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:setLocalPinnedConversation', { zaloId, threadId: String(params.threadId || ''), isPinned: !!params.isPinned });
        }
        if (pathname === '/api/command/starred-messages') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:setMessageStarred', {
                zaloId, threadId: String(params.threadId || ''), msgId: String(params.msgId || ''), starred: !!params.starred, snapshot: params.snapshot,
            });
        }
        if (pathname === '/api/command/pinned-messages') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:pinMessage', { zaloId, threadId: String(params.threadId || ''), pin: params.pin, localOnly: !!params.localOnly });
        }
        if (pathname === '/api/command/pinned-messages/bring-to-top') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:bringPinnedToTop', { zaloId, threadId: String(params.threadId || ''), msgId: String(params.msgId || '') });
        }
        const unpinPath = commandPathParams(pathname, /^\/api\/command\/pinned-messages\/([^/]+)$/);
        if (unpinPath && isDelete) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:unpinMessage', { zaloId, threadId: String(params.threadId || ''), msgId: unpinPath[0] });
        }

        // ── Local labels (shared definitions) + attaching labels to conversations (triggers the "label" workflow like the Boss UI) ──
        if (pathname === '/api/command/labels' && !isDelete) {
            return this.invokeBossIpc('db:upsertLocalLabel', { label: params.label || {} });
        }
        if (pathname === '/api/command/labels/clone') {
            return this.invokeBossIpc('db:cloneLocalLabels', { sourceZaloId: params.sourceZaloId, targetZaloId: params.targetZaloId });
        }
        const labelFlagPath = commandPathParams(pathname, /^\/api\/command\/labels\/(\d+)\/(active|order)$/);
        if (labelFlagPath) {
            const id = positiveInt(labelFlagPath[0]);
            return labelFlagPath[1] === 'active'
                ? this.invokeBossIpc('db:setLocalLabelActive', { id, isActive: params.isActive ?? 1 })
                : this.invokeBossIpc('db:setLocalLabelOrder', { id, order: parseInt(params.order) || 0 });
        }
        const labelPath = commandPathParams(pathname, /^\/api\/command\/labels\/(\d+)$/);
        if (labelPath && isDelete) {
            return this.invokeBossIpc('db:deleteLocalLabel', { id: positiveInt(labelPath[0]) });
        }
        if (pathname === '/api/command/label-threads/bulk') {
            if (!zaloId) return accountRequired();
            const labelIds = (Array.isArray(params.labelIds) ? params.labelIds : []).map(positiveInt).filter(Boolean);
            const threadIds = (Array.isArray(params.threadIds) ? params.threadIds : []).map((id: unknown) => String(id ?? '')).filter(Boolean);
            return this.invokeBossIpc('db:bulkAssignLocalLabelToThread', { zaloId, labelIds, threadIds });
        }
        if (pathname === '/api/command/label-threads') {
            if (!zaloId) return accountRequired();
            // Query string (DELETE) for a labelId given as a string: the handler / events need a number, like the Boss UI
            const labelId = positiveInt(params.labelId);
            const threadId = String(params.threadId || '');
            if (!labelId || !threadId) return { success: false, error: tr('Thiếu nhãn hoặc hội thoại') };
            return this.invokeBossIpc(isDelete ? 'db:removeLocalLabelFromThread' : 'db:assignLocalLabelToThread', {
                zaloId, labelId, threadId,
                threadType: params.threadType !== undefined ? Number(params.threadType) || 0 : undefined,
                labelText: params.labelText, labelColor: params.labelColor, labelEmoji: params.labelEmoji,
            });
        }

        // ── Local quick messages (per account) ──
        if (pathname === '/api/command/quick-messages' && !isDelete) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:upsertLocalQuickMessage', { zaloId, item: params.item || {} });
        }
        if (pathname === '/api/command/quick-messages/bulk-replace') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:bulkReplaceLocalQuickMessages', { zaloId, items: Array.isArray(params.items) ? params.items : [] });
        }
        if (pathname === '/api/command/quick-messages/clone') {
            return this.invokeBossIpc('db:cloneLocalQuickMessages', { sourceZaloId: params.sourceZaloId, targetZaloId: params.targetZaloId });
        }
        const qmFlagPath = commandPathParams(pathname, /^\/api\/command\/quick-messages\/(\d+)\/(active|order)$/);
        if (qmFlagPath) {
            // Only an id given: the quick message must belong to the assigned account
            const id = positiveInt(qmFlagPath[0]);
            const owner = this.quickMessageOwner(id);
            if (owner && !assigned.includes(owner)) {
                return { success: false, error: tr('Không có quyền truy cập tài khoản này'), code: 'ACCOUNT_FORBIDDEN', status: 403 };
            }
            return qmFlagPath[1] === 'active'
                ? this.invokeBossIpc('db:setLocalQMActive', { id, isActive: params.isActive ?? 1 })
                : this.invokeBossIpc('db:setLocalQMOrder', { id, order: parseInt(params.order) || 0 });
        }
        const qmPath = commandPathParams(pathname, /^\/api\/command\/quick-messages\/(\d+)$/);
        if (qmPath && isDelete) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:deleteLocalQuickMessage', { zaloId, id: positiveInt(qmPath[0]) });
        }

        // ── CRM: notes ──
        if (pathname === '/api/command/crm/notes') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('crm:saveNote', { zaloId, note: params.note || {} });
        }
        const notePath = commandPathParams(pathname, /^\/api\/command\/crm\/notes\/(\d+)$/);
        if (notePath && isDelete) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('crm:deleteNote', { zaloId, noteId: positiveInt(notePath[0]) });
        }

        // ── CRM: campaigns (check channel, run / stop the queue, events like the Boss UI) ──
        if (pathname === '/api/command/crm/campaigns') {
            if (!zaloId) return accountRequired();
            const campaign = params.campaign || {};
            if (positiveInt(campaign.id)) {
                const owned = this.requireCampaignOwner(positiveInt(campaign.id), zaloId, assigned);
                if (owned.error) return owned.error;
            }
            return this.invokeBossIpc('crm:saveCampaign', { zaloId, campaign });
        }
        if (pathname === '/api/command/crm/campaigns/clone') {
            const campaignId = positiveInt(params.campaignId);
            const owned = this.requireCampaignOwner(campaignId, zaloId, assigned);
            if (owned.error) return owned.error;
            return this.invokeBossIpc('crm:cloneCampaign', {
                zaloId: owned.owner, campaignId, includeContacts: !!params.includeContacts, newName: params.newName,
                contactIds: Array.isArray(params.contactIds) ? params.contactIds.map(String) : undefined,
                // Every target was checked against the assigned accounts (restCommandPolicy: targetZaloIds)
                targetZaloIds: Array.isArray(params.targetZaloIds) ? params.targetZaloIds.map(String) : undefined,
            });
        }
        if (pathname === '/api/command/crm/campaigns/status') {
            const campaignId = positiveInt(params.campaignId);
            const owned = this.requireCampaignOwner(campaignId, zaloId, assigned);
            if (owned.error) return owned.error;
            return this.invokeBossIpc('crm:updateCampaignStatus', { campaignId, status: params.status });
        }
        if (pathname === '/api/command/crm/campaigns/contacts' && !isDelete) {
            const campaignId = positiveInt(params.campaignId);
            const owned = this.requireCampaignOwner(campaignId, zaloId, assigned);
            if (owned.error) return owned.error;
            return this.invokeBossIpc('crm:addCampaignContacts', {
                zaloId: owned.owner, campaignId, contacts: Array.isArray(params.contacts) ? params.contacts : [],
            });
        }
        if ((pathname === '/api/command/crm/campaigns/contacts' && isDelete) || pathname === '/api/command/crm/campaigns/contacts/delete') {
            const campaignId = positiveInt(params.campaignId);
            const owned = this.requireCampaignOwner(campaignId, zaloId, assigned);
            if (owned.error) return owned.error;
            const contactIds = (Array.isArray(params.contactIds) ? params.contactIds : []).map((id: unknown) => String(id ?? '')).filter(Boolean);
            return this.invokeBossIpc('crm:deleteCampaignContacts', { campaignId, contactIds });
        }
        // DataAccessor calls /contacts/delete-all; the old route only had /contacts/all ("Unknown command")
        if (pathname === '/api/command/crm/campaigns/contacts/all' || pathname === '/api/command/crm/campaigns/contacts/delete-all') {
            const campaignId = positiveInt(params.campaignId);
            const owned = this.requireCampaignOwner(campaignId, zaloId, assigned);
            if (owned.error) return owned.error;
            return this.invokeBossIpc('crm:deleteAllCampaignContacts', { campaignId });
        }
        const campaignPath = commandPathParams(pathname, /^\/api\/command\/crm\/campaigns\/(\d+)$/);
        if (campaignPath && isDelete) {
            const campaignId = positiveInt(campaignPath[0]);
            const owned = this.requireCampaignOwner(campaignId, zaloId, assigned);
            if (owned.error) return owned.error;
            return this.invokeBossIpc('crm:deleteCampaign', { zaloId: owned.owner, campaignId });
        }

        // ── Workflows (workflow module): only workflows where every page belongs to the assigned account ──
        if (pathname === '/api/command/workflows' && !isDelete) {
            const workflow = params.workflow || params;
            if (!workflowPagesAllowed(workflowPageIds(workflow?.pageIds, workflow?.pageId), assigned)) {
                return { success: false, error: tr('Workflow gắn trang không được giao cho bạn'), code: 'ACCOUNT_FORBIDDEN', status: 403 };
            }
            const existingDenied = this.checkWorkflowPages(String(workflow?.id || ''), assigned);
            if (existingDenied) return existingDenied;
            return this.invokeBossIpc('workflow:save', { workflow });
        }
        const workflowTogglePath = commandPathParams(pathname, /^\/api\/command\/workflows\/([^/]+)\/toggle$/);
        if (workflowTogglePath) {
            const pagesDenied = this.checkWorkflowPages(workflowTogglePath[0], assigned);
            if (pagesDenied) return pagesDenied;
            return this.invokeBossIpc('workflow:toggle', { id: workflowTogglePath[0], enabled: params.enabled !== false });
        }
        const workflowPath = commandPathParams(pathname, /^\/api\/command\/workflows\/([^/]+)$/);
        if (workflowPath && isDelete) {
            const pagesDenied = this.checkWorkflowPages(workflowPath[0], assigned);
            if (pagesDenied) return pagesDenied;
            return this.invokeBossIpc('workflow:delete', { id: workflowPath[0] });
        }

        // ── Integrations (integration module): workspace-level configuration ──
        if (pathname === '/api/command/integrations' && !isDelete) {
            return this.invokeBossIpc('integration:save', { integration: params.integration || params });
        }
        const integrationTogglePath = commandPathParams(pathname, /^\/api\/command\/integrations\/([^/]+)\/toggle$/);
        if (integrationTogglePath) {
            return this.invokeBossIpc('integration:toggle', { id: integrationTogglePath[0], enabled: params.enabled !== false });
        }
        const integrationPath = commandPathParams(pathname, /^\/api\/command\/integrations\/([^/]+)$/);
        if (integrationPath && isDelete) {
            return this.invokeBossIpc('integration:delete', { id: integrationPath[0] });
        }

        return undefined;
    }

    /** Writes directly to Boss's DB (synchronous; executeRestCommand calls it inside runOnPinnedDb). */
    private executeRestCommandOnDb(employee: any, pathname: string, params: any, httpMethod: string): any {
        const zaloId = defaultCommandAccount(params, employee.assigned_accounts);
        const db = DatabaseService.getInstance();
        const isDelete = httpMethod === 'DELETE';
        const accountRequired = HttpRelayService.commandAccountRequired;

        // Contact profile / delete conversation / read / delete message: run Boss's IPC handler (executeRestCommandViaIpc)

        // ── Drafts ── (cleanup BEFORE the threadId route: previously "cleanup" was read as a threadId and created an empty draft named "cleanup")
        if (pathname === '/api/command/drafts/cleanup') {
            db.deleteOldDrafts(parseInt(params.days) || 7);
            return { success: true };
        }
        const draftPath = commandPathParams(pathname, /^\/api\/command\/drafts\/([^/]+)$/);
        if (draftPath) {
            if (!zaloId) return accountRequired();
            if (isDelete) {
                db.deleteDraft(zaloId, draftPath[0]);
            } else {
                db.upsertDraft(zaloId, draftPath[0], params.content || '');
            }
            return { success: true };
        }

        // ── Settings ──
        // Per-account notifications (previously fell into the generic route and wrote into an empty "notif" key)
        if (pathname === '/api/command/settings/notif') {
            if (!zaloId) return { success: false, error: 'Missing zaloId' };
            db.setSetting(`notifSettings_${zaloId}`, JSON.stringify(params.settings ?? {}));
            return { success: true };
        }
        // One key: only keys in the allowlist; employees may not change Boss's settings
        if (pathname.match(/^\/api\/command\/settings\/[^/]+$/)) {
            const key = decodeURIComponent(pathname.split('/').pop() || '');
            if (!isEmployeeSettingKey(key)) {
                return { success: false, error: tr('Không có quyền sửa cài đặt này'), code: 'SETTING_FORBIDDEN' };
            }
            db.setSetting(key, params.value || '');
            return { success: true };
        }

        // ── Stickers (shared cache) ──
        if (pathname === '/api/command/stickers/save') {
            db.saveStickers(params.stickers || []);
            return { success: true };
        }
        if (pathname === '/api/command/sticker-packs/save') {
            db.saveStickerPacks(params.packs || []);
            return { success: true };
        }
        if (pathname === '/api/command/stickers/recent') {
            db.addRecentSticker(parseInt(params.stickerId) || 0);
            return { success: true };
        }
        if (pathname === '/api/command/stickers/keyword') {
            db.saveKeywordStickers(params.keyword || '', params.stickerIds || []);
            return { success: true };
        }

        // ── CRM Tags (per account) ──
        if (pathname === '/api/command/crm/tags') {
            if (!zaloId) return accountRequired();
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
        if (pathname === '/api/command/crm/tags/assign') {
            if (!zaloId) return accountRequired();
            db.run(`INSERT OR IGNORE INTO crm_contact_tags (owner_zalo_id,tag_id,contact_id) VALUES (?,?,?)`,
                [zaloId, params.tagId, params.contactId]);
            EventBroadcaster.emit('crm:tagChanged', { action: 'assign', ownerZaloId: zaloId, tagId: params.tagId, contactId: params.contactId });
            return { success: true };
        }
        // Previously it cut parts[4]/parts[6] = "tags"/"contacts", so no tag could ever be removed
        const tagContactPath = commandPathParams(pathname, /^\/api\/command\/crm\/tags\/(\d+)\/contacts\/([^/]+)$/);
        if (tagContactPath) {
            if (!zaloId) return accountRequired();
            const tagId = positiveInt(tagContactPath[0]);
            const contactId = tagContactPath[1];
            db.run(`DELETE FROM crm_contact_tags WHERE owner_zalo_id=? AND tag_id=? AND contact_id=?`, [zaloId, tagId, contactId]);
            EventBroadcaster.emit('crm:tagChanged', { action: 'remove', ownerZaloId: zaloId, tagId, contactId });
            return { success: true };
        }
        const tagPath = commandPathParams(pathname, /^\/api\/command\/crm\/tags\/(\d+)$/);
        if (tagPath && isDelete) {
            if (!zaloId) return accountRequired();
            // Only tags of this account (previously any account's tag could be deleted by id)
            const tagId = positiveInt(tagPath[0]);
            const owned = db.queryOne<any>(`SELECT id FROM crm_tags WHERE id=? AND owner_zalo_id=?`, [tagId, zaloId]);
            if (!owned) return { success: false, error: tr('Không tìm thấy thẻ') };
            db.run(`DELETE FROM crm_contact_tags WHERE tag_id=? AND owner_zalo_id=?`, [tagId, zaloId]);
            db.run(`DELETE FROM crm_tags WHERE id=? AND owner_zalo_id=?`, [tagId, zaloId]);
            EventBroadcaster.emit('crm:tagChanged', { action: 'delete', ownerZaloId: zaloId, tagId });
            return { success: true };
        }

        // ── Bank cards (per account) ──
        if (pathname === '/api/command/bank-cards') {
            if (!zaloId) return accountRequired();
            const id = db.upsertBankCard(zaloId, { ...params.card, ...params });
            if (!(id > 0)) return { success: false, error: tr('Không lưu được thẻ ngân hàng') };
            return { success: true, data: { id } };
        }
        const bankCardPath = commandPathParams(pathname, /^\/api\/command\/bank-cards\/(\d+)$/);
        if (bankCardPath && isDelete) {
            if (!zaloId) return accountRequired();
            db.deleteBankCard(zaloId, positiveInt(bankCardPath[0]));
            return { success: true };
        }

        // Network proxies (/api/command/proxies*, /api/command/accounts/proxy): Boss only; checkRestCommand already rejects them.

        // ── Messages: unsend, reactions, media paths (read / removed from app: IPC handler) ──
        if (pathname === '/api/command/messages/mark-recalled') {
            if (!zaloId) return accountRequired();
            db.markMessageRecalled(zaloId, params.msgId, params.threadId ? String(params.threadId) : undefined);
            // event:undo is already relayed from the Zalo webhook; emit it again to sync (threadId lets the UI update the conversation row)
            EventBroadcaster.emit('event:undo', { zaloId, msgId: params.msgId, ...(params.threadId ? { threadId: String(params.threadId) } : {}) });
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
            if (!zaloId) return accountRequired();
            db.updateLocalPaths(zaloId, params.msgId, params.localPaths || {});
            EventBroadcaster.emit('event:localPath', { zaloId, msgId: params.msgId, threadId: params.threadId || '', localPaths: params.localPaths });
            return { success: true };
        }

        // ── Friends / friend requests (cache per account) ──
        if (pathname === '/api/command/friends/batch') {
            if (!zaloId) return accountRequired();
            db.saveFriends(zaloId, params.friends || []);
            return { success: true };
        }
        if (pathname === '/api/command/friends') {
            if (!zaloId) return accountRequired();
            db.addFriend(zaloId, params.friend || params);
            return { success: true };
        }
        const friendPath = commandPathParams(pathname, /^\/api\/command\/friends\/([^/]+)$/);
        if (friendPath && isDelete) {
            if (!zaloId) return accountRequired();
            db.removeFriend(zaloId, friendPath[0]);
            return { success: true };
        }
        if (pathname === '/api/command/friend-requests') {
            if (!zaloId) return accountRequired();
            db.upsertFriendRequest(zaloId, params.request || params, params.direction || 'received');
            return { success: true };
        }
        const friendRequestPath = commandPathParams(pathname, /^\/api\/command\/friend-requests\/([^/]+)$/);
        if (friendRequestPath && isDelete) {
            if (!zaloId) return accountRequired();
            db.removeFriendRequest(zaloId, friendRequestPath[0], params.direction || 'received');
            return { success: true };
        }

        // ── Group members (cache per account) ──
        // DataAccessor.saveGroupMembers calls POST /groups/members; previously there was no route ("Unknown command")
        if (pathname === '/api/command/groups/members') {
            if (!zaloId) return accountRequired();
            if (!params.groupId) return { success: false, error: tr('Thiếu groupId') };
            db.saveGroupMembers(zaloId, String(params.groupId), Array.isArray(params.members) ? params.members : []);
            return { success: true };
        }
        if (pathname === '/api/command/groups/members/upsert') {
            if (!zaloId) return accountRequired();
            db.upsertGroupMember(zaloId, params.groupId, params.member);
            return { success: true };
        }
        const groupMemberPath = commandPathParams(pathname, /^\/api\/command\/groups\/members\/([^/]+)$/);
        if (groupMemberPath && isDelete) {
            if (!zaloId) return accountRequired();
            db.removeGroupMember(zaloId, params.groupId || params.group_id, groupMemberPath[0]);
            return { success: true };
        }

        // ── Links ──
        if (pathname === '/api/command/links') {
            if (!zaloId) return accountRequired();
            db.saveLink(zaloId, params.threadId, params.msgId, params.url, params.title, params.domain, params.thumbUrl, parseInt(params.timestamp) || Date.now());
            return { success: true };
        }

        // ── Accounts: phone number ──
        if (pathname === '/api/command/accounts/phone') {
            if (!zaloId) return accountRequired();
            db.updateAccountPhone(zaloId, params.phone || '');
            return { success: true };
        }

        // ── AI Assistant CRUD (ai_assistant module): same functions as ai:saveAssistant / ai:deleteAssistant ──
        if (pathname === '/api/command/ai/assistants') {
            const AIAssistantService = require('../ai/AIAssistantService').default;
            const savedId = AIAssistantService.getInstance().saveAssistant(params.assistant || params);
            return { success: true, id: savedId };
        }
        const assistantPath = commandPathParams(pathname, /^\/api\/command\/ai\/assistants\/([^/]+)$/);
        if (assistantPath && isDelete) {
            const AIAssistantService = require('../ai/AIAssistantService').default;
            AIAssistantService.getInstance().deleteAssistant(assistantPath[0]);
            return { success: true };
        }

        // ERP (/api/command/erp/*): runRestCommand → executeErpRest (erp:* IPC handler + RBAC by the employee's identity)

        return { success: false, error: `Unknown command: ${httpMethod} ${pathname}` };
    }

    /** Max ms since last successful SSE write before considering connection stale */
    private static SSE_STALE_THRESHOLD_MS = 60_000;

    /**
     * Control command for exactly one employee (kicked / snapshot / permissions / assigned accounts): via Socket.IO if
     * the employee is connected (immediate channel, no buffer), otherwise via SSE → the LAN callback as before. Only ONE path is used:
     * sending both would make the renderer handle it twice (e.g. reloading a conversation twice when the assigned account changes).
     * Newer employee versions no longer open SSE. Previously commands only reached them through the LAN callback, so employees over the tunnel never received them.
     */
    private pushControlToEmployee(emp: RegisteredEmployee, channel: string, data: any): void {
        try {
            const sio = SocketIOService.getInstance();
            if (sio.isOnline(emp.employee_id)) {
                sio.emitToEmployee(emp.employee_id, channel, data);
                return;
            }
        } catch { /* fall back to SSE / callback */ }
        if (!this.pushViaSSE(emp.employee_id, channel, data)) {
            this.pushToEmployee(emp, channel, data).catch(() => {});
        }
    }

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
    //
    // TunnelService monitors the tunnel (restarts it by itself when cloudflared dies; config changes use make-before-break);
    // the relay only listens to watch() for its own port: it updates the status, emits relay:tunnelStatusUpdate, and when the address
    // differs from the previous run (relay_tunnel_last_url, kept across app restarts) it notifies BOSS + the employees.

    /** Turn the tunnel on with the saved config. auto = started automatically (app opened / relay restarted): on error, TunnelService retries by itself. */
    public async startTunnel(options: { auto?: boolean } = {}): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
        if (!this.running) {
            return { success: false, error: tr('Relay server chưa được bật') };
        }
        const cloud = cloudTunnelIfAuto();
        if (cloud) return this.startCloudTunnel(cloud, options);
        this.ensureTunnelWatcher();
        this.tunnelAutoStarted = !!options.auto;
        try {
            const url = await TunnelService.start(this.port, 'Employee Relay', { ...this.getTunnelOptions(), keepAlive: !!options.auto });
            Logger.log(`[HttpRelayService] 🌐 Tunnel active: ${url}`);
            return { success: true, tunnelUrl: url };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Tunnel start error: ${err.message}`);
            EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
            return { success: false, error: err.message };
        }
    }

    /**
     * Apply a new tunnel config while running (e.g. switching to a fixed address) without disconnecting employees:
     * the new tunnel comes up first, connected employees are told the new address over the old tunnel, and the old tunnel shuts down after ~10 s.
     * If the new tunnel fails, the old tunnel stays. If nothing is running, start normally.
     */
    public async restartTunnel(): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
        if (!this.running) {
            return { success: false, error: tr('Relay server chưa được bật') };
        }
        const cloud = cloudTunnelIfAuto();
        if (cloud) return this.startCloudTunnel(cloud, {});
        this.ensureTunnelWatcher();
        try {
            const url = await TunnelService.replace(this.port, 'Employee Relay', this.getTunnelOptions());
            return { success: true, tunnelUrl: url };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Tunnel switch error: ${err.message}`);
            EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
            return { success: false, error: err.message };
        }
    }

    public async stopTunnel(): Promise<{ success: boolean; error?: string }> {
        const cloud = cloudTunnelIfAuto();
        if (cloud) {
            // Cloudflare auto: turn off the 'relay' service (remove it from ingress); cloudflared keeps running if other services remain
            try {
                await cloud.cloudTunnel.setServiceEnabled('relay', false);
            } catch (err: any) {
                Logger.error(`[HttpRelayService] Cloudflare tunnel stop error: ${err.message}`);
                return { success: false, error: err.message };
            }
            this.cloudRelayUrl = null;
        }
        this.tunnelPendingRestart = false;
        await TunnelService.stop(this.port);
        this.tunnelActive = false;
        this.tunnelUrl = null;
        EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
        return { success: true };
    }

    public getTunnelStatus(): RelayTunnelStatus {
        const cloud = cloudTunnelIfAuto();
        if (cloud) return this.cloudTunnelStatus(cloud);
        const state = TunnelService.getState(this.port);
        const url = state?.url ?? null;
        const change = url && this.tunnelUrlChange && this.tunnelUrlChange.newUrl === normalizeBossUrl(url)
            ? this.tunnelUrlChange
            : null;
        return {
            active: !!url,
            tunnelUrl: url,
            state: state ? state.state : 'stopped',
            provider: state ? state.provider : null,
            kind: state ? state.kind : null,
            restarts: state?.restarts ?? 0,
            attempt: state?.attempt ?? 0,
            lastError: state?.lastError ?? null,
            nextRetryAt: state?.nextRetryAt ?? null,
            warning: state?.warning ?? null,
            previousUrl: change?.previousUrl ?? null,
            urlChangedAt: change?.at ?? null,
            changeReason: change?.reason ?? null,
            autoStart: this.isTunnelAutoStart(),
        };
    }

    /** "Tự bật tunnel khi mở app" (auto-start the tunnel when the app opens; Settings → Employees → Connection, relay_tunnel_autostart = '1'). */
    private isTunnelAutoStart(): boolean {
        try {
            return DatabaseService.getInstance().getSetting(HttpRelayService.TUNNEL_AUTOSTART_KEY) === '1';
        } catch {
            return false;
        }
    }

    /** One durable watcher for the relay's tunnel port; when the port changes (the relay turns on a different port), register again. */
    private ensureTunnelWatcher(): void {
        if (this.tunnelWatchOff && this.tunnelWatchPort === this.port) return;
        this.tunnelWatchOff?.();
        this.tunnelWatchPort = this.port;
        this.tunnelWatchOff = TunnelService.watch(this.port, (url, info) => this.onTunnelChange(url, info));
    }

    private onTunnelChange(url: string | null, info: TunnelChangeInfo): void {
        // Cloudflare auto: the port's old-style tunnel (waiting to shut down) no longer decides the relay's address
        if (cloudTunnelIfAuto()) {
            EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
            return;
        }
        this.tunnelUrl = url;
        this.tunnelActive = !!url;
        if (url && (info.reason === 'started' || info.reason === 'restarted' || info.reason === 'switched')) {
            this.recordPublicUrl(url, info);
        }
        EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
    }

    // ─── Cloudflare auto ───────────────────────────────────────────
    //
    // 'cloudflare_auto' mode: the relay is the 'relay' service of the fixed shared tunnel (one cloudflared for 9900 /
    // 9888 / 9889). Turning the relay's tunnel on / off = turning the service on / off (only changes the ingress). A new address that comes up (e.g. from Quick
    // Tunnel to a custom domain) → recorded and employees notified, as when the config changes (recordPublicUrl); the old-style tunnel
    // of the port keeps running for TUNNEL_SWITCH_GRACE_MS more so employees can switch over, and then shuts down.

    private async startCloudTunnel(cloud: CloudTunnelApi, options: { auto?: boolean }): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
        this.ensureCloudTunnelWatcher();
        this.tunnelAutoStarted = !!options.auto;
        try {
            // Auto-start (app opened / relay restarted) only when the relay is on in Cloudflare auto mode: it does not turn the tunnel on for BOSS
            if (options.auto && !cloud.cloudTunnel.addressOf('relay').enabled) {
                return { success: false, error: tr('Relay chưa bật trong Cloudflare tự động') };
            }
            await cloud.cloudTunnel.setServiceEnabled('relay', true);
            this.onCloudTunnelChange();
            const status = this.getTunnelStatus();
            if (status.active && status.tunnelUrl) {
                Logger.log(`[HttpRelayService] 🌐 Cloudflare tự động: ${status.tunnelUrl}`);
                return { success: true, tunnelUrl: status.tunnelUrl };
            }
            return { success: false, error: status.lastError || tr('Địa chỉ Cloudflare chưa kết nối xong — đang tự thử lại') };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Cloudflare tunnel start error: ${err.message}`);
            EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
            return { success: false, error: err.message };
        }
    }

    /** RelayTunnelStatus from the 'relay' address of the shared tunnel (always provider 'cloudflare_named', kind 'fixed'). */
    private cloudTunnelStatus(cloud: CloudTunnelApi): RelayTunnelStatus {
        const address = cloud.cloudTunnel.addressOf('relay');
        const proc = address.enabled ? cloud.cloudTunnelProcessInfo() : null;
        const url = address.state === 'active' && address.url ? address.url : null;
        const change = url && this.tunnelUrlChange && this.tunnelUrlChange.newUrl === normalizeBossUrl(url)
            ? this.tunnelUrlChange
            : null;
        const state: RelayTunnelState = address.state === 'error' ? 'stopped' : address.state;
        return {
            active: !!url,
            tunnelUrl: url,
            state,
            provider: address.enabled ? 'cloudflare_named' : null,
            kind: address.enabled ? 'fixed' : null,
            restarts: proc?.restarts ?? 0,
            attempt: proc?.attempt ?? 0,
            lastError: address.error ?? proc?.lastError ?? null,
            nextRetryAt: proc?.nextRetryAt ?? null,
            warning: address.state === 'error' ? address.error ?? null : null,
            previousUrl: change?.previousUrl ?? null,
            urlChangedAt: change?.at ?? null,
            changeReason: change?.reason ?? null,
            autoStart: this.isTunnelAutoStart(),
        };
    }

    /** Listens for changes to the shared tunnel (service on/off, process up/down, mode change): registered once. */
    private ensureCloudTunnelWatcher(): void {
        if (this.cloudTunnelOff) return;
        try {
            const mod: CloudTunnelApi = require('../cloudflare/tunnel');
            this.cloudTunnelOff = mod.onCloudTunnelChange(() => this.onCloudTunnelChange());
        } catch { /* Cloudflare module failed to load → only the old-style tunnel is available */ }
    }

    private onCloudTunnelChange(): void {
        const cloud = cloudTunnelIfAuto();
        const wasCloud = this.cloudTunnelMode;
        this.cloudTunnelMode = !!cloud;
        if (!cloud) {
            // Leaving Cloudflare auto mode → the status goes back to the port's old-style tunnel
            if (wasCloud) {
                this.cloudRelayUrl = null;
                this.tunnelUrl = TunnelService.getUrl(this.port);
                this.tunnelActive = !!this.tunnelUrl;
                EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
            }
            return;
        }
        const url = this.cloudTunnelStatus(cloud).tunnelUrl;
        if (url && url !== this.cloudRelayUrl && this.running) {
            const legacy = TunnelService.getState(this.port);
            this.recordPublicUrl(url, {
                port: this.port,
                label: 'Employee Relay',
                reason: legacy ? 'switched' : 'started',
                provider: 'cloudflare_named',
                kind: 'fixed',
                previousUrl: this.cloudRelayUrl ?? legacy?.url ?? legacy?.lastUrl ?? null,
            });
            if (legacy) this.retireLegacyTunnel();
        }
        // Relay not running yet: nothing recorded (the next run compares against relay_tunnel_last_url)
        if (this.running || !url) this.cloudRelayUrl = url;
        this.tunnelUrl = url;
        this.tunnelActive = !!url;
        EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
    }

    /** A Cloudflare auto address exists: the relay's old-style tunnel is kept a while longer (so employees can pick up the new address), then shut down. */
    private retireLegacyTunnel(): void {
        if (this.legacyTunnelRetireTimer) return;
        this.legacyTunnelRetireTimer = setTimeout(() => {
            this.legacyTunnelRetireTimer = null;
            if (!cloudTunnelIfAuto() || !TunnelService.getState(this.port)) return;
            Logger.log('[HttpRelayService] Tắt tunnel kiểu cũ của relay — đã dùng địa chỉ Cloudflare tự động');
            void TunnelService.stop(this.port).catch(() => {});
        }, TUNNEL_SWITCH_GRACE_MS);
    }

    /**
     * Compare the address that just came up with the address from the previous run (saved in the DB). If different → record the change (BOSS sees
     * "the address for employees has changed"), tell the employees that are still connected (LAN / old tunnel during a config change) via Socket.IO, and
     * send a system notification to BOSS if it changed unexpectedly (the tunnel restarted / the app opened).
     */
    private recordPublicUrl(url: string, info: TunnelChangeInfo): void {
        const current = normalizeBossUrl(url);
        let previous = '';
        try {
            const db = DatabaseService.getInstance();
            previous = normalizeBossUrl(db.getSetting(HttpRelayService.TUNNEL_LAST_URL_KEY) || '');
            if (previous !== current) db.setSetting(HttpRelayService.TUNNEL_LAST_URL_KEY, current);
        } catch (err: any) {
            Logger.warn(`[HttpRelayService] Không đọc/ghi được địa chỉ tunnel lần trước: ${err.message}`);
            previous = normalizeBossUrl(info.previousUrl || '');
        }
        if (!previous || previous === current) return;

        const reason: BossUrlChangeReason = info.reason === 'switched' ? 'switch' : info.reason === 'restarted' ? 'restart' : 'start';
        const change: BossUrlChangedEvent = { previousUrl: previous, newUrl: current, kind: info.kind, reason, at: Date.now() };
        this.tunnelUrlChange = change;
        const notified = this.employees.size;
        this.relayEventToEmployees(BOSS_URL_CHANGED_EVENT, change);
        Logger.log(`[HttpRelayService] 📣 Địa chỉ cho nhân viên đổi: ${previous} → ${current} (${reason}, ${info.kind}) — đã báo ${notified} nhân viên đang đăng ký`);
        // If BOSS turns it on or changes the config themselves, they already see it in Settings; only notify the system when it changes "ngầm" (silently)
        if (reason === 'restart' || (reason === 'start' && this.tunnelAutoStarted)) this.showTunnelUrlChangedNotification(change);
    }

    /** System notification for BOSS (the app may be hidden in the tray): click it to copy the new address. */
    private showTunnelUrlChangedNotification(change: BossUrlChangedEvent): void {
        try {
            const { Notification, clipboard, BrowserWindow } = require('electron');
            if (!Notification?.isSupported?.()) return;
            const notification = new Notification({
                title: tr('Địa chỉ cho nhân viên đã đổi'),
                body: tr('{{newUrl}}\nNhấn để sao chép rồi gửi cho nhân viên làm việc từ xa.', { newUrl: change.newUrl }),
            });
            notification.on('click', () => {
                try { clipboard.writeText(change.newUrl); } catch { /* ignore */ }
                const win = BrowserWindow.getAllWindows().find((w: any) => !w.isDestroyed());
                if (win) { win.show(); win.focus(); }
            });
            notification.show();
        } catch (err: any) {
            Logger.warn(`[HttpRelayService] Không hiện được thông báo đổi địa chỉ: ${err?.message || err}`);
        }
    }

    /** Read the provider config (cloudflare by default, Cloudflare with an account, or an ngrok static domain) from the DB. */
    private getTunnelOptions(): TunnelOptions {
        try {
            const db = DatabaseService.getInstance();
            const provider = (db.getSetting('relay_tunnel_provider') as TunnelProvider) || 'cloudflare';
            const { decryptSecret } = require('../api/auth/secretBox');
            if (provider === 'ngrok') {
                return {
                    provider: 'ngrok',
                    // relayIpc stores it encrypted (enc:/plain:); old plain values can still be read
                    authtoken: decryptSecret(db.getSetting('relay_ngrok_authtoken') || '') || undefined,
                    domain: db.getSetting('relay_ngrok_domain') || undefined,
                };
            }
            if (provider === 'cloudflare_named') {
                return {
                    provider: 'cloudflare_named',
                    token: decryptSecret(db.getSetting('relay_cf_tunnel_token') || '') || undefined,
                    publicUrl: db.getSetting('relay_cf_public_url') || undefined,
                };
            }
        } catch (err: any) {
            Logger.warn(`[HttpRelayService] getTunnelOptions failed: ${err.message}`);
        }
        return { provider: 'cloudflare' };
    }

    /** Prevents the OS from sleeping (idle sleep) while the relay runs; employees can still reach it. */
    private startPowerSaveBlocker(): void {
        if (this.powerSaveId !== null) return;
        try {
            const { powerSaveBlocker } = require('electron');
            this.powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
            Logger.log(`[HttpRelayService] powerSaveBlocker started (id ${this.powerSaveId})`);
        } catch (err: any) {
            Logger.warn(`[HttpRelayService] powerSaveBlocker start failed: ${err.message}`);
        }
    }

    private stopPowerSaveBlocker(): void {
        if (this.powerSaveId === null) return;
        try {
            const { powerSaveBlocker } = require('electron');
            powerSaveBlocker.stop(this.powerSaveId);
            Logger.log(`[HttpRelayService] powerSaveBlocker stopped (id ${this.powerSaveId})`);
        } catch { /* ignore */ }
        this.powerSaveId = null;
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

        // ─── Socket.IO (the only transport) ──────────────────────
        // Buffered ONCE, together with the recipients (relayAudience.ts: the assigned accounts, the same assigned_accounts as the
        // REST permission check; ERP sends to named targets; workspace-wide data) → emitted only to the rooms of the employees who should receive it.
        // An offline employee → the event goes to the buffer → catch-up (same filter rules) when they reconnect.
        try {
            SocketIOService.getInstance().publish(channel, data);
        } catch (err: any) {
            Logger.warn(`[HttpRelayService] relay ${channel} lỗi: ${err?.message || err}`);
        }
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
                // Socket.IO still alive (the current client uses Socket.IO, not SSE) → still counts as online
                try {
                    if (SocketIOService.getInstance().isOnline(empId)) {
                        emp.lastSeen = now;
                        continue;
                    }
                } catch { /* socket server not running */ }

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
                    // accounts.cookies is stored encrypted (safeStorage); read by SQL directly, so it must decrypt itself
                    cookies: DatabaseService.getInstance().decryptCookies(account.cookies),
                    imei: account.imei || '',
                    userAgent: account.user_agent || '',
                };
            }
        } catch (err: any) {
            Logger.warn(`[HttpRelayService] resolveRealAuth error: ${err.message}`);
        }
        return null;
    }

    /**
     * Account id of a Facebook / Telegram proxy command → accounts.zalo_id (the form used in the assigned list). Facebook: the handler
     * receives both the internal fb_accounts.id (UUID) and the real Facebook id (= accounts.zalo_id), so the UUID is mapped back to the facebook_id.
     */
    private canonicalProxyAccountId(channel: string, accountId: string): string {
        if (!channel.startsWith('fb:') || /^\d+$/.test(accountId)) return accountId;
        const fbAcc = this.runOnPinnedDb((db) => db.getFBAccount(accountId));
        return fbAcc?.facebook_id ? String(fbAcc.facebook_id) : accountId;
    }

    /**
     * Accounts with a running session on Boss, per channel: Zalo → ConnectionManager; Facebook → FacebookConnectionManager
     * (by fb_accounts.id); personal Telegram → MTProto listener; Telegram bot → currently receiving updates. Previously the employee snapshot looked up
     * ConnectionManager (Zalo only) for every channel, so Facebook / Telegram accounts always showed "mất kết nối" (lost connection) on the employee machine.
     */
    private isAccountSessionOnline(zaloId: string, channel?: string | null): boolean {
        try {
            if (channel === 'facebook') {
                const fbAcc = this.runOnPinnedDb((db) => db.getFBAccountByFacebookId(zaloId));
                const FacebookConnectionManager = require('../../utils/connection/FacebookConnectionManager').default;
                return !!(fbAcc?.id && FacebookConnectionManager.get(fbAcc.id)?.isConnected());
            }
            if (channel === 'telegram_user') return !!require('../telegram/TelegramUserListener').isConnected(zaloId);
            if (channel === 'telegram_bot') return !!require('../telegram/bot/TelegramBotChannelService').isBotPolling(zaloId);
        } catch {
            return false;
        }
        return ConnectionManager.isConnected(zaloId);
    }

    /**
     * Boss's media folder: always the default workspace (Boss), not the active one. When Boss's machine is
     * showing an employee workspace, getBaseDir() points at that workspace's media, so Boss could not see its own files.
     */
    private getBossMediaBasePath(): string {
        try {
            const WorkspaceManager = require('../../utils/app/WorkspaceManager').default;
            const wm = WorkspaceManager.getInstance();
            const defaultWs = wm.getWorkspaceById('default');
            if (defaultWs && defaultWs.dbPath) {
                return path.join(path.dirname(wm.resolveDbPath(defaultWs.dbPath)), 'media');
            }
        } catch { /* use getBaseDir */ }
        try { return FileStorageService.getBaseDir?.() || ''; } catch { return ''; }
    }

    /** Whether the media/<id>/ folder belongs to an account (accounts.zalo_id: Zalo / Facebook / Telegram) → the canonical id. */
    private lookupMediaAccountId(segment: string): string | null {
        const row = this.runOnPinnedDb((db) => db.queryOne<{ zalo_id: string }>(
            'SELECT zalo_id FROM accounts WHERE zalo_id = ? COLLATE NOCASE LIMIT 1', [segment]));
        return row?.zalo_id ? String(row.zalo_id) : null;
    }

    /** File path in a proxy command: only Boss's media folder, with the same account rules as /api/media downloads. */
    private proxyFilePathContext(employee: RegisteredEmployee): ProxyPathContext {
        const realpath = (p: string): string => {
            const abs = path.resolve(p);
            try { return fs.realpathSync.native(abs); } catch { /* try the JS version */ }
            try { return fs.realpathSync(abs); } catch { return abs; }
        };
        const roots: string[] = [];
        for (const dir of [this.getBossMediaBasePath(), (() => { try { return FileStorageService.getBaseDir(); } catch { return ''; } })()]) {
            if (!dir) continue;
            const real = realpath(dir);
            if (!roots.includes(real)) roots.push(real);
        }
        return {
            roots,
            resolve: (value) => realpath(FileStorageService.resolveAbsolutePath(value) || value),
            checkAccess: (rel) => checkMediaAccess(employee, classifyMediaPath(rel, (segment) => this.lookupMediaAccountId(segment))),
        };
    }

    /** A library item (_libraryUuid / _libraryUuids) must belong to the page the employee is using. Returns the rejected uuid, or null. */
    private checkProxyLibraryItems(employee: RegisteredEmployee, params: any): string | null {
        const uuids: string[] = [];
        if (typeof params?._libraryUuid === 'string' && params._libraryUuid) uuids.push(params._libraryUuid);
        if (Array.isArray(params?._libraryUuids)) uuids.push(...params._libraryUuids.map(String).filter(Boolean));
        if (uuids.length === 0) return null;
        const LibraryService = require('../library/LibraryService').default;
        for (const uuid of uuids) {
            const item = this.runOnPinnedDb(() => LibraryService.getInstance().getItem(uuid));
            // Item not found: let the old flow handle it (it reports "file not found"), so no file is exposed
            if (item && !canAccessLibraryOwner(employee, String(item.owner_zalo_id || ''))) return uuid;
        }
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
        // Realtime filters by the new list right away, including the sockets of employees who have not registered again yet (after Boss restarts)
        try { SocketIOService.getInstance().updateEmployeeAccess(employeeId, newZaloIds); } catch {}
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
        this.pushControlToEmployee(emp, 'relay:accountAccessUpdate', payload);
    }

    /** Push a fresh employee snapshot to the employee */
    public refreshEmployeeState(employeeId: string, reason = 'manual-refresh'): void {
        const emp = this.employees.get(employeeId);
        if (!emp) return;

        const snapshot = this.buildEmployeeSnapshot(employeeId);
        if (snapshot) {
            this.pushControlToEmployee(emp, 'relay:initialState', snapshot);
            // Permission updates: send dedicated event that bypasses 60s throttle
            // on workspace:initialState in the renderer.
            if (reason === 'permissions-updated') {
                const permPayload = {
                    permissions: snapshot.permissions,
                    erpRole: snapshot.erpRole,
                    erpExtraJson: snapshot.erpExtraJson,
                    employeesData: snapshot.employeesData,
                };
                this.pushControlToEmployee(emp, 'relay:permissionUpdate', permPayload);
            }
        }
        Logger.log(`[HttpRelayService] refreshEmployeeState(${reason}) → employee=${employeeId}`);
    }

    // ─── Utility ──────────────────────────────────────────────────────

    /**
     * Read the body with a size limit: many endpoints read the body BEFORE authentication (login, heartbeat, proxy),
     * so without a limit anyone who reaches it through the tunnel could fill the RAM. Concatenate Buffers first, then decode UTF-8
     * (joining strings chunk by chunk breaks the Vietnamese characters that straddle two chunks).
     */
    private readBody(req: http.IncomingMessage, cb: (body: string) => void, maxBytes = HttpRelayService.MAX_BODY_BYTES): void {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                Logger.warn(`[HttpRelayService] body vượt ${maxBytes} byte: ${req.method} ${req.url}`);
                const res: http.ServerResponse | undefined = (req as any).__relayRes;
                if (res && !res.headersSent) {
                    res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
                    res.end(JSON.stringify({ error: 'Payload too large' }));
                }
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!tooLarge) cb(Buffer.concat(chunks).toString('utf8'));
        });
    }

    /** Maximum body size for employee routes (file uploads take their own multipart / JSON path). */
    static readonly MAX_BODY_BYTES = 50 * 1024 * 1024;
    /** Employee media upload (POST /api/media/upload): Zalo PC sends files up to 1 GB. Writes straight to disk. */
    static readonly MAX_MEDIA_UPLOAD_BYTES = 1024 * 1024 * 1024;
    /** Login / heartbeat: only a few hundred bytes of JSON. */
    static readonly SMALL_BODY_BYTES = 256 * 1024;

    private json(res: http.ServerResponse, status: number, data: any): void {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    /** Cache-aware REST result - skips the synchronous better-sqlite3 query
     *  if a fresh cached response exists. This prevents main-thread blocking
     *  when the employee calls many GET endpoints after every message.
     *  Runs inside runOnPinnedDb (the relay's DB). An entry is reused only while the DB HAS NOT changed since it was saved: Boss pins / labels /
     *  mutes → writes to the DB → emits an event → the employee reloads right away. Previously, within 1.5 s it got back the OLD cached value and
     *  kept it wrong until the next event. Error results are not cached. */
    private getCachedRestResult(method: string, pathname: string, employeeId: string, fetchFn: () => any, params?: Record<string, any>): any {
        if (method !== 'GET') return fetchFn();
        // The key now includes the params (zaloId…): previously it used only the pathname, so this account received another account's flags / labels / pins
        const cacheKey = restCacheKey(method, pathname, employeeId, params);
        const token = this.restCacheToken();
        const cached = this.restApiCache.get(cacheKey, token);
        if (cached !== undefined) return cached;
        const data = fetchFn();
        this.restApiCache.set(cacheKey, token, data);
        return data;
    }

    /**
     * Change marker of the DB serving the relay: total_changes() (writes through this connection: Boss IPC, employee commands,
     * listeners) + PRAGMA data_version (commits from OTHER connections). A change ⇒ every cache entry becomes invalid. null (cannot read)
     * ⇒ no caching: correct first, fast second.
     */
    private restCacheToken(): string | null {
        try {
            const db = DatabaseService.getInstance();
            const changes = db.queryOne<{ n: number }>('SELECT total_changes() AS n');
            const version = db.queryOne<{ data_version: number }>('PRAGMA data_version');
            if (!changes || !version) return null;
            return `${db.getDbPath()}|${changes.n}|${version.data_version}`;
        } catch {
            return null;
        }
    }

    // ─── Utility ──────────────────────────────────────────────────────
}

export default HttpRelayService;

