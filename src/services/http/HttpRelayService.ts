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
import ConnectionManager from '../../utils/ConnectionManager';
import TunnelService, { TunnelOptions, TunnelProvider, type TunnelChangeInfo } from '../tunnel/TunnelService';
import {
    BOSS_URL_CHANGED_EVENT,
    TUNNEL_SWITCH_GRACE_MS,
    type BossUrlChangedEvent,
    type BossUrlChangeReason,
    type RelayTunnelState,
    type RelayTunnelStatus,
} from '../../shared/tunnelAddress';
import { normalizeBossUrl } from '../../shared/employeeConnection';
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
import {
    COALESCED_POLL_CHANNELS, SPECIAL_PROXY_CHANNELS, checkProxyChannel, checkProxyFilePaths, employeeSendInfo,
    proxyChannelModules, resolveAccountChannelProxy, resolveProxyAccount, shouldSkipCoalescedPoll,
    type ProxyPathContext, type RecentPoll,
} from './proxyActionPolicy';
import { isAccountChannelProxy } from './employeeChannelRoutes';
import {
    checkRestCommand, commandPathParams, defaultCommandAccount, positiveInt, workflowPageIds, workflowPagesAllowed,
} from './restCommandPolicy';
import { canAccessLibraryOwner, checkMediaAccess, classifyMediaPath } from './bossFileAccess';
import ApiPlatform from '../api/ApiPlatform';
import { getApiSettingBool } from '../api/settings';

/**
 * Cloudflare tự động (src/services/cloudflare/tunnel): chế độ 'cloudflare_auto' → tunnel của relay là dịch vụ 'relay'
 * của tiến trình cloudflared dùng chung (địa chỉ cố định). Nạp lười — chế độ khác / lỗi nạp → null = chạy như cũ.
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
        /** 1 = phiên đang chạy trên Boss (theo kênh — isAccountSessionOnline) */
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
/** Đường dẫn chưa có file: "a.png" → "a (1).png" → "a (2).png"… (không ghi đè file người khác vừa upload). */
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

    /** REST API response cache (labels, flags, pins…): nhân viên gọi lại sau MỖI tin nhắn — tránh chặn main thread
     *  (better-sqlite3 đồng bộ). Entry chỉ dùng được khi DB chưa đổi kể từ lúc lưu (restCacheToken) và còn trong TTL;
     *  chỉ lưu kết quả thành công. Xem RestReadCache (employeeRestRead.ts). */
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
    /** Lệnh poll gần nhất theo kênh + tài khoản + hội thoại (gộp poll reaction Telegram của nhiều nhân viên). */
    private recentPolls = new Map<string, RecentPoll>();
    private static SSE_QUEUE_TTL_MS = 600_000; // 10-minute TTL (was 2 min - WAN reconnect can take longer)
    private static SSE_QUEUE_MAX = 500;        // max queued events per employee (was 300)

    /** Tunnel state */
    private tunnelActive = false;
    private tunnelUrl: string | null = null;
    /** Lưu tunnel cần restart khi relay start lại (sau workspace switch) */
    private tunnelPendingRestart = false;
    /** TunnelService.watch() của cổng relay (đăng ký 1 lần / cổng). */
    private tunnelWatchOff: (() => void) | null = null;
    private tunnelWatchPort: number | null = null;
    /** Lần đổi địa chỉ WAN gần nhất (so với địa chỉ lần chạy trước, lưu ở relay_tunnel_last_url). */
    private tunnelUrlChange: BossUrlChangedEvent | null = null;
    /** Lần bật tunnel gần nhất là tự bật (mở app / relay chạy lại), không phải BOSS bấm. */
    private tunnelAutoStarted = false;
    /** Cloudflare tự động: huỷ nghe thay đổi, đang ở chế độ đó, địa chỉ relay đã ghi nhận, hẹn tắt tunnel kiểu cũ. */
    private cloudTunnelOff: (() => void) | null = null;
    private cloudTunnelMode = false;
    private cloudRelayUrl: string | null = null;
    private legacyTunnelRetireTimer: ReturnType<typeof setTimeout> | null = null;
    private static TUNNEL_LAST_URL_KEY = 'relay_tunnel_last_url';
    private static TUNNEL_AUTOSTART_KEY = 'relay_tunnel_autostart';

    /** powerSaveBlocker id — chặn Mac/OS ngủ khi relay đang phục vụ nhân viên */
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
     * Channels to relay from EventBroadcaster → employees — một nguồn với phía nhân viên (relayChannels.ts:
     * nhân viên chuyển tiếp đúng các kênh này; kênh không relay phải nằm trong BOSS_ONLY_CHANNELS kèm lý do).
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
            // Trạng thái phiên theo kênh (Facebook / Telegram không nằm trong ConnectionManager của Zalo)
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
                    // Kênh: máy nhân viên cần để gọi đúng adapter (thiếu → tài khoản Facebook / Telegram bị coi là Zalo)
                    channel: (a as any).channel || 'zalo',
                    // Zalo My Documents (hội thoại có sẵn của Zalo) → máy nhân viên ghim đúng hội thoại
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
            this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));

            // Attach Socket.IO vào cùng HTTP server (path /socket.io)
            // Employee dùng WebSocket thay SSE cho real-time event. Realtime + catch-up lọc theo cùng
            // assigned_accounts với kiểm tra quyền REST (updateEmployeeRooms giữ đồng bộ).
            SocketIOService.getInstance().attach(this.httpServer, {
                resolveAssignedAccounts: (employeeId) => this.employees.get(employeeId)?.assigned_accounts,
            });
            // Public API v1: namespace Socket.IO /v1 cho app ngoài & plugin (tách khỏi nhân viên).
            ApiPlatform.getInstance().attachSocket(SocketIOService.getInstance().getServer());

            this.hookEventBroadcaster();
            this.startOfflineCheck();

            // Tuỳ chọn ở Công cụ → Ứng dụng, API & Webhook → API: chỉ lắng nghe 127.0.0.1 (máy không có nhân viên LAN).
            let bindLocalOnly = false;
            try { bindLocalOnly = getApiSettingBool('api_bind_localhost_only'); } catch { bindLocalOnly = false; }

            return new Promise((resolve) => {
                const onListening = () => {
                    this.running = true;
                    this.startPowerSaveBlocker();
                    Logger.log(`[HttpRelayService] ✅ Server started on port ${this.port}`);
                    // Cloudflare tự động: nghe địa chỉ của tunnel dùng chung và ghi nhận địa chỉ hiện tại (chế độ khác: không làm gì)
                    this.ensureCloudTunnelWatcher();
                    this.onCloudTunnelChange();
                    // Bật lại tunnel: đang chạy trước khi relay dừng (đổi workspace) hoặc bật "Tự bật tunnel khi mở app".
                    // Dùng đúng cấu hình đã lưu (Quick / Cloudflare có tài khoản / ngrok); lỗi (chưa có mạng) → tự thử lại.
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
            // Stop tunnel if active (kể cả đang tự chạy lại) — nhưng nhớ để restart sau
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
        // Cloudflare tự động: địa chỉ từ tunnel dùng chung (tunnelActive/tunnelUrl riêng chỉ theo tunnel kiểu cũ)
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

    /** Quản lý ngắt một nhân viên (UI / API v1): kết thúc hẳn phiên — token cũ hết hiệu lực, phải đăng nhập lại. */
    public kickEmployee(employeeId: string): void {
        this.terminateEmployeeSession(employeeId, 'Bị ngắt kết nối bởi quản lý');
    }

    /**
     * Kết thúc hẳn phiên của một nhân viên — kick, khoá / xoá / đổi mật khẩu (employeeIpc gọi sau khi sửa / xoá):
     * báo 'relay:kicked' kèm lý do → thu hồi token (REST / heartbeat 401, bắt tay Socket.IO bị từ chối) → ngắt socket sau
     * ~1 s (kịp gửi thông báo) → bỏ đăng ký. Trước đây chỉ bỏ đăng ký: token còn hạn nên request kế tiếp tự đăng ký lại,
     * socket vẫn mở. Relay không chạy → không có phiên nào để ngắt, chỉ thu hồi token.
     */
    public terminateEmployeeSession(employeeId: string, reason: string): void {
        if (!employeeId) return;
        if (this.running) {
            const emp = this.employees.get(employeeId);
            if (emp) {
                this.pushControlToEmployee(emp, 'relay:kicked', { reason });
            } else {
                // Socket còn nối nhưng chưa đăng ký lại (vd ngay sau khi Boss khởi động lại)
                try {
                    const sio = SocketIOService.getInstance();
                    if (sio.isOnline(employeeId)) sio.emitToEmployee(employeeId, 'relay:kicked', { reason });
                } catch { /* socket server chưa chạy */ }
            }
        }
        EmployeeService.getInstance().revokeEmployeeTokens(employeeId);
        if (this.running) {
            try { SocketIOService.getInstance().disconnectEmployee(employeeId); } catch { /* socket server chưa chạy */ }
        }
        this.unregisterEmployee(employeeId, reason);
    }

    /**
     * "Đăng xuất tất cả nhân viên": đổi khoá ký (mọi token cũ sai chữ ký — đổi trước, lỗi thì chưa đụng ai) → báo
     * 'relay:kicked' cho mọi nhân viên đang nối → ngắt mọi socket nhân viên sau ~1 s → bỏ mọi đăng ký.
     */
    public logoutAllEmployees(reason = 'Quản lý đã đăng xuất tất cả nhân viên'): { success: boolean; notified: number; error?: string } {
        const rotated = EmployeeService.getInstance().rotateJwtSecret();
        if (!rotated.success) return { success: false, notified: 0, error: rotated.error || 'Không đổi được khoá ký' };
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
            } catch { /* socket server chưa chạy */ }
        }
        // Mọi đăng ký + mọi luồng SSE (kể cả SSE của nhân viên không còn trong danh sách đăng ký)
        const everyone = new Set<string>([...this.employees.keys(), ...this.sseClients.keys()]);
        for (const employeeId of everyone) this.unregisterEmployee(employeeId, reason);
        Logger.warn(`[HttpRelayService] 🔐 Đã đăng xuất tất cả nhân viên (${notified.size} nhân viên đang nối được báo)`);
        return { success: true, notified: notified.size };
    }

    /** Bỏ đăng ký một nhân viên: đóng SSE, xoá hàng đợi, kết thúc phiên online trong DB, cập nhật danh sách. */
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
        // readBody cần res để trả 413 khi body vượt giới hạn.
        (req as any).__relayRes = res;
        // ── Public API v1 + /docs (ApiPlatform) — xử lý riêng, không đụng route nhân viên ──
        if (ApiPlatform.getInstance().handles(req.url || '')) {
            ApiPlatform.getInstance().handle(req, res).catch((err: any) => {
                Logger.error(`[HttpRelayService] API v1 error: ${err?.message || err}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Lỗi không mong đợi' } }));
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
        // Truy vấn đọc dùng POST vì danh sách id dài (sticker theo id; liên hệ CRM lọc theo nhãn Zalo)
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
        // Sửa / xoá item, đổi tên / xoá thư mục thư viện (DataAccessor dùng PATCH / DELETE) — trước đây router trả 404
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

                // Socket.IO đã thay thế SSE - không cần detect half-open nữa
                // (heartbeat chỉ để xác nhận employee còn alive)

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
        // ── Tài khoản thực hiện (proxyActionPolicy.resolveProxyAccount): id ghi rõ (params hoặc auth.accountId/zaloId)
        // phải được giao; kênh chạy bằng phiên tài khoản (registry Zalo, login:connect) mà không ghi rõ → chỉ đoán khi
        // không mơ hồ (một tài khoản được giao / hội thoại thuộc đúng một tài khoản). Trước đây thiếu zaloId → tài khoản
        // được giao ĐẦU TIÊN: gửi tin / cảm xúc / đã đọc từ tài khoản B chạy bằng tài khoản A.
        const { ipcHandlerRegistry: zaloRegistry } = require('../../../electron/ipc/zaloIpc');
        const isRegistryChannel = !!zaloRegistry?.has(channel);
        // Facebook / Telegram cá nhân (employeeChannelRoutes, nhóm "proxy"): tài khoản = params.accountId, BẮT BUỘC và phải
        // được giao (Facebook: id nội bộ fb_accounts.id → accounts.zalo_id trước khi so). Trước đây kênh fb: / telegramUser:
        // không qua kiểm tra tài khoản nào (resolveProxyAccount bỏ qua accountId ở cấp params).
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

        // Check permission — cần MỘT trong các module của kênh (proxyActionPolicy.proxyChannelModules: zalo/fb/telegramUser →
        // chat, quét dữ liệu Facebook → crm, kết bạn / danh bạ → friends hoặc chat…)
        const empSvc = EmployeeService.getInstance();
        const modules = proxyChannelModules(channel);
        if (modules.length > 0 && !modules.some((m) => empSvc.hasPermission(employee.employee_id, m))) {
            return { success: false, error: `Không có quyền truy cập module: ${modules.join(' / ')}`, code: 'MODULE_FORBIDDEN' };
        }

        // ── Kênh + file (proxyActionPolicy.ts). Trước đây fallback `_invokeHandlers` gọi được MỌI handler ipcMain
        // (employee:update, relay:*, cài đặt, plugin, API key…) và handler gửi file nhận đường dẫn tuỳ ý trên máy Boss
        // (gửi được cả file DB chứa cookie mọi tài khoản vào một cuộc trò chuyện).
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
            return { success: false, error: 'Không có quyền dùng file thư viện này', code: 'ACCOUNT_FORBIDDEN' };
        }
        // Lệnh chỉ mang id bản ghi (chiến dịch, tin nhắn nhanh…): bản ghi phải thuộc tài khoản được giao
        const ownerDenied = this.checkProxyRecordOwner(employee, channel, params);
        if (ownerDenied) {
            Logger.warn(`[HttpRelayService] 🚫 proxy ${channel} employee=${employee.employee_id}: ${ownerDenied}`);
            return { success: false, error: ownerDenied, code: 'ACCOUNT_FORBIDDEN' };
        }
        // Kênh registry Zalo chạy bằng phiên của tài khoản → tài khoản phải có phiên (connection) trên Boss. Không có thì
        // wrap() / resolveZaloId không khớp được cookie và rơi vào "kết nối duy nhất" → thao tác bằng tài khoản KHÁC.
        // (Phiên đang kết nối lại — connected=false nhưng còn connection — vẫn cho chạy như trên máy Boss.)
        if (isRegistryChannel && zaloId && !ConnectionManager.getConnection(zaloId)) {
            Logger.warn(`[HttpRelayService] proxy ${channel}: tài khoản ${zaloId} chưa đăng nhập trên Boss`);
            return { success: false, error: 'Tài khoản chưa đăng nhập trên Boss', code: 'ACCOUNT_OFFLINE' };
        }

        try {
            // Inject real auth
            if (params?.auth !== undefined) {
                const realAuth = this.resolveRealAuth(zaloId, params.auth);
                if (realAuth) {
                    params = { ...params, auth: realAuth, _fromRelay: true };
                } else if (zaloId) {
                    // Không có phiên / cookie của tài khoản trên Boss: KHÔNG chuyển auth của nhân viên xuống handler — wrap()
                    // sẽ đoán tài khoản (kết nối duy nhất / auth.zaloId) và có thể chạy bằng tài khoản khác.
                    Logger.warn(`[HttpRelayService] Proxy: could not resolve real auth for zaloId=${zaloId}, channel=${channel}`);
                    return { success: false, error: 'Tài khoản chưa đăng nhập trên Boss', code: 'ACCOUNT_OFFLINE' };
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
                    return { success: false, error: 'Không tìm thấy thông tin xác thực' };
                } catch (err: any) {
                    return { success: false, error: err.message };
                }
            }

            // Use handler registry. Facebook / Telegram cá nhân (tài khoản đã kiểm tra ở trên): ĐÚNG handler ipcMain của Boss
            // (cùng chuẩn hoá / lưu DB / phát event như UI Boss), đi chung nhánh với registry Zalo để ghi "nhân viên nào đã gửi".
            const { ipcHandlerRegistry } = require('../../../electron/ipc/zaloIpc');
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
                        return { success: false, error: 'Không tìm thấy file video trong thư viện' };
                    }

                    const videoPath = libItem.file_path;
                    // zaloId = tài khoản đã xác định ở đầu hàm (không lấy tài khoản được giao đầu tiên)

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
                // Poll reaction Telegram trùng (nhiều nhân viên mở cùng nhóm) → không hỏi Telegram lần nữa trong 15 s:
                // lần hỏi trước đã ghi DB + phát sự kiện cho mọi người (proxyActionPolicy.shouldSkipCoalescedPoll)
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

                // Log send actions + broadcast sender info to all workspaces. proxyActionPolicy.employeeSendInfo: Zalo theo tên
                // kênh như cũ; Facebook / Telegram đúng các kênh gửi tin (kết quả { messageId }, hội thoại threadId / chatId);
                // handler báo lỗi → không ghi "đã gửi" (trước đây tin gửi lỗi vẫn bị tính là nhân viên đã trả lời).
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
                        // Push to connected employees được giao tài khoản này (cùng quy tắc với realtime Socket.IO).
                        // Socket.IO: phát theo tài khoản + buffer cho catch-up. Nhân viên chưa nối Socket.IO (bản cũ) →
                        // SSE / callback LAN / hàng đợi như trước. Trước đây chỉ có nhánh sau: nhân viên qua tunnel
                        // (không SSE, không callback) bị xếp hàng mãi, không bao giờ thấy "ai đã trả lời".
                        let sio: SocketIOService | null = null;
                        try {
                            sio = SocketIOService.getInstance();
                            sio.publish('relay:messageSentByEmployee', senderPayload);
                        } catch { /* rơi về SSE / callback */ }
                        const senderAudience = classifyRelayEvent('relay:messageSentByEmployee', senderPayload);
                        for (const emp of this.employees.values()) {
                            if (!canReceiveRelayEvent(senderAudience, emp.employee_id, emp.assigned_accounts)) continue;
                            if (sio?.isOnline(emp.employee_id)) continue; // đã nhận qua Socket.IO ở trên
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
                // Vừa ghi DB Boss: bỏ cache GET (1.5 s) để lần đọc ngay sau (UI tải lại sau khi lưu) thấy dữ liệu mới
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
     * Trong `candidates` (tài khoản được giao), tài khoản nào có hội thoại / nhóm `threadIds` (bảng contacts của Boss).
     * Dùng để đoán tài khoản cho lệnh proxy từ UI cũ không gửi id tài khoản (resolveProxyAccount).
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

    /** Chủ (owner_zalo_id) của một chiến dịch CRM; null = không có chiến dịch này. */
    private campaignOwner(campaignId: unknown): string | null {
        const id = positiveInt(campaignId);
        if (!id) return null;
        const row = this.runOnPinnedDb((db) => db.queryOne<{ owner_zalo_id: string }>(
            'SELECT owner_zalo_id FROM crm_campaigns WHERE id = ?', [id]));
        return row?.owner_zalo_id ? String(row.owner_zalo_id) : null;
    }

    /** Chủ của một tin nhắn nhanh local; null = không có. */
    private quickMessageOwner(id: unknown): string | null {
        const qmId = positiveInt(id);
        if (!qmId) return null;
        const row = this.runOnPinnedDb((db) => db.queryOne<{ owner_zalo_id: string }>(
            'SELECT owner_zalo_id FROM local_quick_messages WHERE id = ?', [qmId]));
        return row?.owner_zalo_id ? String(row.owner_zalo_id) : null;
    }

    /**
     * Lệnh proxy chỉ mang id bản ghi (không có / không đủ zaloId): bản ghi phải thuộc tài khoản được giao (và đúng
     * tài khoản trong tham số nếu có). Trước đây đổi trạng thái / xoá chiến dịch, bật tắt tin nhắn nhanh của tài khoản
     * KHÁC chỉ bằng id. Không thấy bản ghi → để handler tự báo. Trả thông báo lỗi, hoặc null = được phép.
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
        if (!employee.assigned_accounts.includes(owner)) return 'Không có quyền truy cập tài khoản này';
        const requested = String(params?.zaloId || '');
        if (requested && requested !== owner) return 'Bản ghi không thuộc tài khoản này';
        return null;
    }

    /**
     * Workflow qua proxy (WorkflowEditor / kho mẫu / nhân bản của nhân viên): cùng quy tắc với REST /api/command/workflows
     * — mọi trang của workflow (mới và đang có) thuộc tài khoản được giao; trang nguồn / đích của nhân bản cũng vậy.
     */
    private checkProxyWorkflowAccess(employee: RegisteredEmployee, channel: string, params: any): string | null {
        const assigned = employee.assigned_accounts;
        const accountDenied = 'Không có quyền truy cập tài khoản này';
        const pagesDenied = 'Workflow gắn trang không được giao cho bạn';
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

        const rawFilename = req.headers['x-filename'] as string;
        if (!rawFilename) {
            return this.json(res, 400, { success: false, error: 'Missing X-Filename header' });
        }
        const zaloId = (req.headers['x-zalo-id'] as string) || employee.assigned_accounts[0] || '';
        if (zaloId && !employee.assigned_accounts.includes(zaloId)) {
            return this.json(res, 403, { success: false, error: 'Không có quyền truy cập tài khoản này', code: 'ACCOUNT_FORBIDDEN' });
        }
        const maxBytes = HttpRelayService.MAX_MEDIA_UPLOAD_BYTES;
        if (Number(req.headers['content-length'] || 0) > maxBytes) {
            req.resume();
            return this.json(res, 413, { success: false, error: `File tối đa ${Math.round(maxBytes / 1024 / 1024)} MB`, code: 'PAYLOAD_TOO_LARGE' });
        }

        // Tên do nhân viên gửi (client encodeURIComponent): chỉ lấy phần tên — trước đây ghép thẳng vào đường dẫn,
        // "..\..\Startup\x.bat" ghi được file ra ngoài thư mục media. Giữ tên gốc (Zalo dùng làm tên tệp đính kèm).
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

        // Ghi thẳng xuống đĩa (file tạm rồi đổi tên), không gom cả file trong RAM; vượt giới hạn → 413.
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
            if (size > maxBytes) fail(413, `File tối đa ${Math.round(maxBytes / 1024 / 1024)} MB`, 'PAYLOAD_TOO_LARGE');
        });
        req.on('close', () => { if (!req.complete) fail(400, 'Upload bị ngắt giữa chừng'); });
        req.on('error', (err: Error) => fail(400, err.message));
        out.on('error', (err: Error) => fail(500, err.message));
        out.on('finish', () => {
            if (settled) return;
            if (size === 0) return fail(400, 'Empty file');
            try {
                // Trùng tên (hai nhân viên cùng gửi "image.png") → "image (1).png" thay vì ghi đè file của người kia
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

        // ── File media / thư viện: bắt buộc phiên nhân viên + quyền tài khoản (bossFileAccess.ts) ──
        // Trước đây mở tự do ("tunnel security") — ai biết URL Boss / tunnel là tải được file. Máy nhân viên tự gắn
        // Authorization cho <img>/<video> (session.webRequest — bossSessionAuth.ts). KHÔNG miễn trừ loopback:
        // cloudflared / ngrok kết nối từ 127.0.0.1 → loopback = Internet. UI của chính Boss dùng local-media://.
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
                    // Item thư viện nằm trong DB của Boss → runOnPinnedDb; LibraryHandler kiểm tra chủ item
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

        // ── Các endpoint khác cần auth ──
        const employee = this.authenticateRequest(req);
        if (!employee) {
            return this.json(res, 401, { success: false, error: 'Unauthorized' });
        }
        // Gọi REST thành công cũng chứng tỏ nhân viên đang online (không chỉ heartbeat)
        employee.lastSeen = Date.now();

        // Parse URL để dispatch
        const method = req.method;
        let params: any = {};

        // Parse query params từ URL — auto-parse JSON objects/arrays (trừ ô chữ người dùng gõ: search, q, phone…)
        const queryIndex = url.indexOf('?');
        const pathname = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
        if (queryIndex >= 0) params = parseRestQueryParams(url.slice(queryIndex));

        // ── Phân quyền: tài khoản trong tham số phải được giao cho nhân viên; /api/query/analytics/* cần quyền
        // module 'analytics'. Lệnh ghi (/api/command/*) kiểm tra lại trên body trong executeRestCommand.
        if (method === 'GET') {
            const denied = checkEmployeeAccess(employee, pathname, params,
                (module) => EmployeeService.getInstance().hasPermission(employee.employee_id, module));
            if (denied) {
                Logger.warn(`[HttpRelayService] 🚫 ${method} ${pathname} employee=${employee.employee_id}: ${denied.code}`);
                return this.json(res, denied.status, { success: false, error: denied.error, code: denied.code });
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
                    () => DatabaseService.getInstance().getContactsWithFlags(zaloId) || [], params);
                return this.json(res, 200, { success: true, data: { items: rows } });
            }
            // Unread conversations ("Tự động đánh dấu đã đọc") — PHẢI đứng trước regex /conversations/:id bên dưới
            // (trước đây đặt sau → bị hiểu là hội thoại id "unread" → luôn rỗng ở chế độ nhân viên)
            if (method === 'GET' && pathname === '/api/query/conversations/unread') {
                return this.json(res, 200, restHandlers.getUnreadConversations(employee, params));
            }
            // Bộ lọc danh sách hội thoại của nhân viên (kênh / tìm / Chưa đọc / Khác / Chưa trả lời / khoảng ngày)
            if (method === 'GET' && pathname === '/api/query/conversations/filtered') {
                return this.json(res, 200, restHandlers.getConversationsFiltered(employee, params));
            }
            // ⚠️ Route cụ thể /api/query/conversations/<tên> phải đặt TRƯỚC regex catch-all này (employeeRestContract.test)
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
            // unread / by-type PHẢI đứng trước regex /messages/:msgId bên dưới (trước đây đặt sau → bị hiểu là tin id
            // "unread" / "by-type" → trả null: bảng tin nhóm thiếu bình chọn, đếm chưa đọc rỗng ở chế độ nhân viên)
            if (method === 'GET' && pathname === '/api/query/messages/unread') {
                return this.json(res, 200, restHandlers.getUnreadCountHandler(employee, params));
            }
            if (method === 'GET' && pathname === '/api/query/messages/by-type') {
                return this.json(res, 200, restHandlers.getMessagesByTypeHandler(employee, params));
            }
            // ⚠️ Route cụ thể /api/query/messages/<tên> phải đặt TRƯỚC regex catch-all này (employeeRestContract.test)
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

            // Settings — thông báo theo tài khoản (trước đây bị route chung che mất)
            if (method === 'GET' && pathname === '/api/query/settings/notif') {
                const target = String(params.zaloId || employee.assigned_accounts[0] || '');
                const raw = target ? DatabaseService.getInstance().getSetting(`notifSettings_${target}`) : null;
                let data: any = null;
                try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
                return this.json(res, 200, { success: true, data });
            }
            // Settings — một khoá: chỉ khoá trong allowlist (không lộ employee_jwt_secret, token tunnel…)
            if (method === 'GET' && pathname.match(/^\/api\/query\/settings\/[^/]+$/)) {
                const key = decodeURIComponent(pathname.split('/').pop() || '');
                if (!isEmployeeSettingKey(key)) {
                    return this.json(res, 403, { success: false, error: 'Không có quyền đọc cài đặt này', code: 'SETTING_FORBIDDEN' });
                }
                return this.json(res, 200, restHandlers.getSetting(employee, { ...params, key }));
            }

            // (Unread conversations: xem route trước regex /conversations/:id ở trên)

            // Starred messages ("Tin đánh dấu") - keys of one account or the list of several
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
                // ?catId=… = sticker của MỘT bộ (DataAccessor.getStickersByPackId); trước đây luôn trả danh sách bộ
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
                // Danh sách id nằm trong body JSON → đọc body rồi trả lời trong đúng DB của relay
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

            // ── ERP: dự án, công việc, lịch, ghi chú, nhân sự, chấm công, nghỉ phép, thông báo ──
            // Bảng ErpRestRoutes (route cụ thể trước /:id) → ĐÚNG handler IPC erp:* với danh tính ERP của nhân viên
            // (executeErpRest). Quyền module 'erp' đã kiểm tra ở checkEmployeeAccess phía trên.
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
                // Lọc theo nhãn Zalo: danh sách hội thoại của nhãn nằm trong body. Kiểm quyền tài khoản trên body như GET
                // (checkEmployeeAccess phía trên chỉ chạy cho GET), rồi trả lời trong đúng DB của relay.
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

            // (Messages extended — unread / by-type: xem route trước regex /messages/:msgId ở trên)

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
            // executeRestCommand: kiểm tra quyền → handler IPC của Boss (workflow / tích hợp / chiến dịch / ghi chú / gắn
            // nhãn — cùng logic + event như UI Boss) hoặc ghi DB trực tiếp (runOnPinnedDb). Body đọc xong mới chạy, nên
            // phải chờ (async) và tự ghim DB — callback readBody nằm ngoài runOnPinnedDb của handleRestApi.
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
                        // Bị từ chối quyền → 403 như lệnh đọc (RestQueryService: ACCOUNT_FORBIDDEN → làm mới snapshot)
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
                // uuid nằm trong đường dẫn (trước đây chỉ đọc query → luôn "Missing uuid"); body đọc xong ngoài
                // runOnPinnedDb → tự ghim DB; JSON hỏng → 400 (trước đây ném lỗi trong callback 'end')
                const uuid = pathname.split('/').pop() || '';
                this.readBody(req, (body) => {
                    let parsed: any = {};
                    try { parsed = body ? JSON.parse(body) : {}; } catch { return this.json(res, 400, { success: false, error: 'Body không hợp lệ' }); }
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
                    try { parsed = body ? JSON.parse(body) : {}; } catch { return this.json(res, 400, { success: false, error: 'Body không hợp lệ' }); }
                    try {
                        return this.json(res, 200, this.runOnPinnedDb(() => libraryHandlers.createFolder(employee, { ...params, ...parsed })));
                    } catch (err: any) {
                        return this.json(res, 500, { success: false, error: err.message });
                    }
                });
                return;
            }
            // Đổi tên thư mục (DataAccessor.renameLibraryFolder) — trước đây không có route
            if (method === 'PATCH' && pathname.match(/^\/api\/library\/folders\/\d+$/)) {
                const id = pathname.split('/').pop() || '';
                this.readBody(req, (body) => {
                    let parsed: any = {};
                    try { parsed = body ? JSON.parse(body) : {}; } catch { return this.json(res, 400, { success: false, error: 'Body không hợp lệ' }); }
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
            // GET /api/library/file|thumb/<uuid> được phục vụ ở đầu handleRestApi (xác thực + kiểm tra chủ item)

            return this.json(res, 404, { success: false, error: `Unknown endpoint: ${method} ${pathname}` });
            }); // end runOnPinnedDb
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Rest API error: ${err.message}`);
            this.json(res, 500, { success: false, error: err.message });
        }
    }

    /**
     * Lệnh ghi REST của nhân viên — POST/PUT/PATCH/DELETE /api/command/*.
     * Thứ tự: quyền tài khoản (employeeAccess) → quyền lệnh (restCommandPolicy: module, lệnh chỉ Boss, tài khoản nguồn /
     * đích) → handler IPC của Boss nếu lệnh có handler tương ứng (executeRestCommandViaIpc) → ghi DB trực tiếp
     * (executeRestCommandOnDb, trong DB đã ghim). Ghi xong phát CÙNG event như thao tác trên UI Boss để Boss và nhân viên
     * khác cập nhật ngay (trước đây nhiều lệnh REST ghi DB mà không phát gì, hoặc phát thiếu ownerZaloId).
     * Từ chối quyền → `{ success: false, …, status: 403 }` (router trả HTTP 403 như lệnh đọc).
     */
    private executeRestCommand(employee: any, pathname: string, params: any, _method?: string): Promise<any> {
        // Chữ ký giữ dạng `private executeRestCommand(` (không async): employeeRestContract.test dùng làm mốc cuối handleRestApi
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
            // ERP: bảng ErpRestRoutes → handler IPC erp:* với danh tính ERP của nhân viên (quyền ERP kiểm tra trước IPC)
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
            // Vừa ghi DB: bỏ cache GET (1.5 s) để lần đọc ngay sau (UI tải lại sau khi lưu) thấy dữ liệu mới
            this.restApiCache.clear();
        }
    }

    /** Gọi handler IPC của chính Boss (như UI Boss gọi). `_fromRelay`: handler không proxy tiếp. */
    private async invokeBossIpc(channel: string, params: any): Promise<any> {
        const { ipcMain } = require('electron');
        const handler: Function | undefined = (ipcMain as any)._invokeHandlers?.get(channel);
        if (!handler) return { success: false, error: `No handler for channel: ${channel}` };
        const result = await handler(null, { ...params, _fromRelay: true });
        return result ?? { success: false, error: `Handler ${channel} không trả kết quả` };
    }

    /**
     * ERP qua REST (GET /api/query/erp/*, lệnh /api/command/erp/*): route trong bảng ErpRestRoutes → ĐÚNG handler IPC
     * erp:* của Boss, chạy với danh tính ERP của nhân viên (ErpAuthContext.forEmployee + runAs: role / quyền riêng theo
     * hồ sơ ERP trên Boss — người làm không bao giờ lấy từ tham số). Quyền module 'erp' đã kiểm tra trước
     * (employeeAccess / restCommandPolicy); ở đây kiểm tra quyền ERP của route TRƯỚC khi vào IPC (withErpAuth kiểm tra lại
     * cùng action). Cùng service → event realtime phát đúng một lần như thao tác trên UI Boss; cùng phong bì
     * `{ success, ...trường, error, code }`; từ chối quyền → `code: 'permission_denied'` + HTTP 403.
     * Handler ERP đồng bộ (better-sqlite3): phần đọc / ghi DB chạy hết trong runOnPinnedDb trước lần `await` đầu tiên.
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
     * Tệp đính kèm task do nhân viên gửi (tạo / sửa task): chỉ file đã đính trên chính task này, hoặc file trong thư mục
     * media của Boss mà nhân viên được dùng (upload trước qua /api/media/upload) — cùng quy tắc đường dẫn với
     * /api/proxy/action. Trước đây REST nhận đường dẫn tuỳ ý: Boss chép BẤT KỲ file nào trên máy Boss vào
     * media/erp/tasks (mọi nhân viên tải được). Hợp lệ → đường dẫn đã chuẩn hoá (handler dùng đúng file vừa kiểm tra).
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

    /** Lệnh theo tài khoản mà không gửi zaloId (nhân viên được giao nhiều tài khoản → không đoán). */
    private static commandAccountRequired(): any {
        return { success: false, error: 'Thiếu tài khoản (zaloId) cho thao tác này', code: 'ACCOUNT_REQUIRED' };
    }

    /**
     * Chiến dịch của lệnh phải thuộc tài khoản được giao (và đúng zaloId nếu lệnh có gửi). `error` khác null = trả về
     * ngay. Trước đây chỉ theo id: đổi trạng thái / xoá liên hệ / nhân bản chiến dịch của tài khoản khác được; xoá
     * chiến dịch với zaloId của mình + id của người khác xoá sạch danh sách liên hệ của chiến dịch đó.
     */
    private requireCampaignOwner(campaignId: number, zaloId: string, assigned: readonly string[]): { owner: string; error: any } {
        const owner = this.campaignOwner(campaignId);
        if (!owner) return { owner: '', error: { success: false, error: 'Không tìm thấy chiến dịch' } };
        if (!assigned.includes(owner) || (zaloId && zaloId !== owner)) {
            return { owner: '', error: { success: false, error: 'Không có quyền với chiến dịch này', code: 'ACCOUNT_FORBIDDEN', status: 403 } };
        }
        return { owner, error: null };
    }

    /** Workflow đang có phải gắn toàn trang được giao (workflowPagesAllowed). null = được phép / chưa có workflow này. */
    private checkWorkflowPages(workflowId: string, assigned: readonly string[]): any | null {
        if (!workflowId) return null;
        const row: any = this.runOnPinnedDb((db) => db.getWorkflowById(workflowId));
        if (!row) return null;
        if (workflowPagesAllowed(workflowPageIds(row.page_ids, row.page_id), assigned)) return null;
        return { success: false, error: 'Workflow gắn trang không được giao cho bạn', code: 'ACCOUNT_FORBIDDEN', status: 403 };
    }

    /**
     * Lệnh REST có handler IPC tương ứng trên Boss → chạy đúng handler đó: cùng chuẩn hoá, kiểm tra, event và nạp lại
     * engine như UI Boss. Trước đây REST ghi thẳng DB: workflow lưu / bật tắt không nạp lại engine (chỉ có hiệu lực sau
     * khi khởi động lại Boss), tích hợp gọi hàm không tồn tại (IntegrationRegistry.getInstance → luôn lỗi), chiến dịch
     * chuyển "active" mà hàng đợi gửi không chạy, gắn nhãn không kích hoạt workflow "gắn nhãn", event cờ hội thoại thiếu
     * ownerZaloId (nhân viên khác không lưu được), cắt id sai vị trí (`split('/')[3]` = "conversations" / "labels" /
     * "workflows" / "integrations" → cờ, biệt danh, bật tắt ghi vào bản ghi tên đó).
     * undefined = không phải lệnh loại này (ghi DB trực tiếp ở executeRestCommandOnDb).
     */
    private async executeRestCommandViaIpc(employee: any, pathname: string, params: any, httpMethod: string): Promise<any | undefined> {
        const assigned: string[] = (employee.assigned_accounts || []).map(String);
        const zaloId = defaultCommandAccount(params, assigned);
        const isDelete = httpMethod === 'DELETE';
        const accountRequired = HttpRelayService.commandAccountRequired;

        // ── Hội thoại: cờ (tắt thông báo / mục Khác / @) + biệt danh ──
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
        // Hồ sơ liên hệ: handler chỉ phát db:contactProfileUpdated khi hồ sơ thật sự đổi (REST cũ phát mọi lần)
        // — PHẢI đứng trước route xoá (regex /conversations/<id> khớp cả "update-profile")
        if (pathname === '/api/command/conversations/update-profile') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('db:updateContactProfile', {
                zaloId, contactId: params.contactId, displayName: params.displayName, avatarUrl: params.avatarUrl,
                phone: params.phone, contactType: params.contactType, gender: params.gender, birthday: params.birthday,
                isBot: null, manualDetails: !!params.manualDetails,
            });
        }
        // Đánh dấu đã trả lời / bỏ đánh dấu hàng loạt (handler phát db:replyStateChanged như UI Boss) — trước regex xoá
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

        // ── Tin nhắn: đã đọc / xoá khỏi app (handler phát db:unreadChanged / event:delete như UI Boss) ──
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

        // ── Ghim hội thoại / tin đánh dấu / ghim tin nhắn ──
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
            return this.invokeBossIpc('db:pinMessage', { zaloId, threadId: String(params.threadId || ''), pin: params.pin });
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

        // ── Nhãn Local (định nghĩa dùng chung) + gắn nhãn hội thoại (kích hoạt workflow "gắn nhãn" như UI Boss) ──
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
            // Query string (DELETE) cho labelId dạng chuỗi — handler / event cần số như UI Boss
            const labelId = positiveInt(params.labelId);
            const threadId = String(params.threadId || '');
            if (!labelId || !threadId) return { success: false, error: 'Thiếu nhãn hoặc hội thoại' };
            return this.invokeBossIpc(isDelete ? 'db:removeLocalLabelFromThread' : 'db:assignLocalLabelToThread', {
                zaloId, labelId, threadId,
                threadType: params.threadType !== undefined ? Number(params.threadType) || 0 : undefined,
                labelText: params.labelText, labelColor: params.labelColor, labelEmoji: params.labelEmoji,
            });
        }

        // ── Tin nhắn nhanh local (theo tài khoản) ──
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
            // Chỉ có id: tin nhắn nhanh phải thuộc tài khoản được giao
            const id = positiveInt(qmFlagPath[0]);
            const owner = this.quickMessageOwner(id);
            if (owner && !assigned.includes(owner)) {
                return { success: false, error: 'Không có quyền truy cập tài khoản này', code: 'ACCOUNT_FORBIDDEN', status: 403 };
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

        // ── CRM: ghi chú ──
        if (pathname === '/api/command/crm/notes') {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('crm:saveNote', { zaloId, note: params.note || {} });
        }
        const notePath = commandPathParams(pathname, /^\/api\/command\/crm\/notes\/(\d+)$/);
        if (notePath && isDelete) {
            if (!zaloId) return accountRequired();
            return this.invokeBossIpc('crm:deleteNote', { zaloId, noteId: positiveInt(notePath[0]) });
        }

        // ── CRM: chiến dịch (kiểm tra kênh, chạy / dừng hàng đợi, event như UI Boss) ──
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
        // DataAccessor gọi /contacts/delete-all — route cũ chỉ có /contacts/all ("Unknown command")
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

        // ── Workflow (module workflow): chỉ workflow mà mọi trang thuộc tài khoản được giao ──
        if (pathname === '/api/command/workflows' && !isDelete) {
            const workflow = params.workflow || params;
            if (!workflowPagesAllowed(workflowPageIds(workflow?.pageIds, workflow?.pageId), assigned)) {
                return { success: false, error: 'Workflow gắn trang không được giao cho bạn', code: 'ACCOUNT_FORBIDDEN', status: 403 };
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

        // ── Tích hợp (module integration) — cấu hình cấp workspace ──
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

    /** Lệnh ghi thẳng DB Boss (đồng bộ; executeRestCommand gọi trong runOnPinnedDb). */
    private executeRestCommandOnDb(employee: any, pathname: string, params: any, httpMethod: string): any {
        const zaloId = defaultCommandAccount(params, employee.assigned_accounts);
        const db = DatabaseService.getInstance();
        const isDelete = httpMethod === 'DELETE';
        const accountRequired = HttpRelayService.commandAccountRequired;

        // Hồ sơ liên hệ / xoá hội thoại / đã đọc / xoá tin: chạy handler IPC (executeRestCommandViaIpc)

        // ── Nháp ── (cleanup TRƯỚC route theo threadId: trước đây "cleanup" bị coi là threadId → tạo nháp rỗng tên "cleanup")
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
        // Thông báo theo tài khoản (trước đây rơi vào route chung và ghi nhầm khoá "notif" rỗng)
        if (pathname === '/api/command/settings/notif') {
            if (!zaloId) return { success: false, error: 'Missing zaloId' };
            db.setSetting(`notifSettings_${zaloId}`, JSON.stringify(params.settings ?? {}));
            return { success: true };
        }
        // Một khoá: chỉ khoá trong allowlist — nhân viên không được sửa cài đặt của Boss
        if (pathname.match(/^\/api\/command\/settings\/[^/]+$/)) {
            const key = decodeURIComponent(pathname.split('/').pop() || '');
            if (!isEmployeeSettingKey(key)) {
                return { success: false, error: 'Không có quyền sửa cài đặt này', code: 'SETTING_FORBIDDEN' };
            }
            db.setSetting(key, params.value || '');
            return { success: true };
        }

        // ── Stickers (cache dùng chung) ──
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

        // ── CRM Tags (theo tài khoản) ──
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
        // Trước đây cắt parts[4]/parts[6] = "tags"/"contacts" → không bao giờ gỡ được thẻ nào
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
            // Chỉ thẻ của tài khoản này (trước đây xoá được thẻ của mọi tài khoản theo id)
            const tagId = positiveInt(tagPath[0]);
            const owned = db.queryOne<any>(`SELECT id FROM crm_tags WHERE id=? AND owner_zalo_id=?`, [tagId, zaloId]);
            if (!owned) return { success: false, error: 'Không tìm thấy thẻ' };
            db.run(`DELETE FROM crm_contact_tags WHERE tag_id=? AND owner_zalo_id=?`, [tagId, zaloId]);
            db.run(`DELETE FROM crm_tags WHERE id=? AND owner_zalo_id=?`, [tagId, zaloId]);
            EventBroadcaster.emit('crm:tagChanged', { action: 'delete', ownerZaloId: zaloId, tagId });
            return { success: true };
        }

        // ── Thẻ ngân hàng (theo tài khoản) ──
        if (pathname === '/api/command/bank-cards') {
            if (!zaloId) return accountRequired();
            const id = db.upsertBankCard(zaloId, { ...params.card, ...params });
            if (!(id > 0)) return { success: false, error: 'Không lưu được thẻ ngân hàng' };
            return { success: true, data: { id } };
        }
        const bankCardPath = commandPathParams(pathname, /^\/api\/command\/bank-cards\/(\d+)$/);
        if (bankCardPath && isDelete) {
            if (!zaloId) return accountRequired();
            db.deleteBankCard(zaloId, positiveInt(bankCardPath[0]));
            return { success: true };
        }

        // Proxy mạng (/api/command/proxies*, /api/command/accounts/proxy): chỉ Boss — checkRestCommand đã từ chối.

        // ── Tin nhắn — thu hồi, cảm xúc, đường dẫn media (đã đọc / xoá khỏi app: handler IPC) ──
        if (pathname === '/api/command/messages/mark-recalled') {
            if (!zaloId) return accountRequired();
            db.markMessageRecalled(zaloId, params.msgId, params.threadId ? String(params.threadId) : undefined);
            // event:undo đã được relay từ Zalo webhook — emit thêm để đồng bộ (threadId giúp UI cập nhật dòng hội thoại)
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

        // ── Bạn bè / lời mời kết bạn (cache theo tài khoản) ──
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

        // ── Thành viên nhóm (cache theo tài khoản) ──
        // DataAccessor.saveGroupMembers gọi POST /groups/members — trước đây không có route ("Unknown command")
        if (pathname === '/api/command/groups/members') {
            if (!zaloId) return accountRequired();
            if (!params.groupId) return { success: false, error: 'Thiếu groupId' };
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

        // ── Tài khoản — số điện thoại ──
        if (pathname === '/api/command/accounts/phone') {
            if (!zaloId) return accountRequired();
            db.updateAccountPhone(zaloId, params.phone || '');
            return { success: true };
        }

        // ── AI Assistant CRUD (module ai_assistant) — cùng hàm với ai:saveAssistant / ai:deleteAssistant ──
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

        // ERP (/api/command/erp/*): runRestCommand → executeErpRest (handler IPC erp:* + RBAC theo danh tính nhân viên)

        return { success: false, error: `Unknown command: ${httpMethod} ${pathname}` };
    }

    /** Max ms since last successful SSE write before considering connection stale */
    private static SSE_STALE_THRESHOLD_MS = 60_000;

    /**
     * Lệnh điều khiển cho đúng một nhân viên (kicked / snapshot / quyền / tài khoản được giao): Socket.IO nếu
     * nhân viên đang nối (kênh tức thời, không buffer), không thì SSE → callback LAN như cũ. Chỉ đi MỘT đường —
     * gửi cả hai thì renderer xử lý hai lần (vd tải lại hội thoại hai lần khi đổi tài khoản được giao).
     * Nhân viên bản mới không mở SSE nữa: trước đây lệnh chỉ tới được qua callback LAN, nhân viên qua tunnel không nhận.
     */
    private pushControlToEmployee(emp: RegisteredEmployee, channel: string, data: any): void {
        try {
            const sio = SocketIOService.getInstance();
            if (sio.isOnline(emp.employee_id)) {
                sio.emitToEmployee(emp.employee_id, channel, data);
                return;
            }
        } catch { /* rơi về SSE / callback */ }
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
    // TunnelService giám sát tunnel (tự chạy lại khi cloudflared chết, đổi cấu hình kiểu make-before-break);
    // relay chỉ nghe watch() của cổng mình: cập nhật trạng thái, phát relay:tunnelStatusUpdate, và khi địa chỉ
    // WAN khác lần chạy trước (relay_tunnel_last_url, sống qua khởi động lại app) thì báo BOSS + nhân viên.

    /** Bật tunnel theo cấu hình đã lưu. auto = tự bật (mở app / relay chạy lại): lỗi thì TunnelService tự thử lại. */
    public async startTunnel(options: { auto?: boolean } = {}): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
        if (!this.running) {
            return { success: false, error: 'Relay server chưa được bật' };
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
     * Áp dụng cấu hình tunnel mới khi đang chạy (vd chuyển sang Địa chỉ cố định) mà không ngắt nhân viên:
     * tunnel mới lên trước, nhân viên đang nối được báo địa chỉ mới qua tunnel cũ, tunnel cũ tắt sau ~10 s.
     * Tunnel mới lỗi → tunnel cũ giữ nguyên. Chưa chạy → bật bình thường.
     */
    public async restartTunnel(): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
        if (!this.running) {
            return { success: false, error: 'Relay server chưa được bật' };
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
            // Cloudflare tự động: tắt dịch vụ 'relay' (bỏ khỏi ingress); cloudflared vẫn chạy nếu còn dịch vụ khác
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

    /** "Tự bật tunnel khi mở app" (Cài đặt → Nhân viên → Kết nối, relay_tunnel_autostart = '1'). */
    private isTunnelAutoStart(): boolean {
        try {
            return DatabaseService.getInstance().getSetting(HttpRelayService.TUNNEL_AUTOSTART_KEY) === '1';
        } catch {
            return false;
        }
    }

    /** Một watcher bền cho tunnel của cổng relay; cổng đổi (relay bật lại cổng khác) → đăng ký lại. */
    private ensureTunnelWatcher(): void {
        if (this.tunnelWatchOff && this.tunnelWatchPort === this.port) return;
        this.tunnelWatchOff?.();
        this.tunnelWatchPort = this.port;
        this.tunnelWatchOff = TunnelService.watch(this.port, (url, info) => this.onTunnelChange(url, info));
    }

    private onTunnelChange(url: string | null, info: TunnelChangeInfo): void {
        // Cloudflare tự động: tunnel kiểu cũ của cổng (đang chờ tắt) không còn quyết định địa chỉ của relay
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

    // ─── Cloudflare tự động ───────────────────────────────────────────
    //
    // Chế độ 'cloudflare_auto': relay là dịch vụ 'relay' của tunnel cố định dùng chung (một cloudflared cho 9900 /
    // 9888 / 9889). Bật / tắt tunnel của relay = bật / tắt dịch vụ (chỉ đổi ingress). Địa chỉ mới lên (vd từ Quick
    // Tunnel sang tên miền riêng) → ghi nhận + báo nhân viên như khi đổi cấu hình (recordPublicUrl); tunnel kiểu cũ
    // của cổng giữ thêm TUNNEL_SWITCH_GRACE_MS cho nhân viên kịp chuyển rồi tắt.

    private async startCloudTunnel(cloud: CloudTunnelApi, options: { auto?: boolean }): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
        this.ensureCloudTunnelWatcher();
        this.tunnelAutoStarted = !!options.auto;
        try {
            // Tự bật (mở app / relay chạy lại) chỉ khi relay đang bật ở Cloudflare tự động — không tự bật hộ BOSS
            if (options.auto && !cloud.cloudTunnel.addressOf('relay').enabled) {
                return { success: false, error: 'Relay chưa bật trong Cloudflare tự động' };
            }
            await cloud.cloudTunnel.setServiceEnabled('relay', true);
            this.onCloudTunnelChange();
            const status = this.getTunnelStatus();
            if (status.active && status.tunnelUrl) {
                Logger.log(`[HttpRelayService] 🌐 Cloudflare tự động: ${status.tunnelUrl}`);
                return { success: true, tunnelUrl: status.tunnelUrl };
            }
            return { success: false, error: status.lastError || 'Địa chỉ Cloudflare chưa kết nối xong — đang tự thử lại' };
        } catch (err: any) {
            Logger.error(`[HttpRelayService] Cloudflare tunnel start error: ${err.message}`);
            EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
            return { success: false, error: err.message };
        }
    }

    /** RelayTunnelStatus từ địa chỉ 'relay' của tunnel dùng chung (luôn provider 'cloudflare_named', kind 'fixed'). */
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

    /** Nghe thay đổi của tunnel dùng chung (bật/tắt dịch vụ, tiến trình lên/xuống, đổi chế độ) — đăng ký một lần. */
    private ensureCloudTunnelWatcher(): void {
        if (this.cloudTunnelOff) return;
        try {
            const mod: CloudTunnelApi = require('../cloudflare/tunnel');
            this.cloudTunnelOff = mod.onCloudTunnelChange(() => this.onCloudTunnelChange());
        } catch { /* module Cloudflare không nạp được → chỉ có tunnel kiểu cũ */ }
    }

    private onCloudTunnelChange(): void {
        const cloud = cloudTunnelIfAuto();
        const wasCloud = this.cloudTunnelMode;
        this.cloudTunnelMode = !!cloud;
        if (!cloud) {
            // Rời chế độ Cloudflare tự động → trạng thái quay về tunnel kiểu cũ của cổng
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
        // Relay chưa chạy: chưa ghi nhận (lần chạy sau so lại với relay_tunnel_last_url)
        if (this.running || !url) this.cloudRelayUrl = url;
        this.tunnelUrl = url;
        this.tunnelActive = !!url;
        EventBroadcaster.emit('relay:tunnelStatusUpdate', this.getTunnelStatus());
    }

    /** Đã có địa chỉ Cloudflare tự động: tunnel kiểu cũ của relay giữ thêm một lúc (nhân viên kịp nhận địa chỉ mới) rồi tắt. */
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
     * So địa chỉ vừa lên với địa chỉ lần chạy trước (lưu DB). Khác → ghi nhận lần đổi (BOSS thấy "Địa chỉ cho
     * nhân viên đã đổi"), báo nhân viên còn nối được (LAN / tunnel cũ khi đổi cấu hình) qua Socket.IO, và
     * thông báo hệ thống cho BOSS nếu đổi ngoài ý muốn (tunnel chạy lại / mở app).
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
        // BOSS tự bấm bật / đổi cấu hình thì đã thấy ngay trong Cài đặt; chỉ báo hệ thống khi đổi "ngầm"
        if (reason === 'restart' || (reason === 'start' && this.tunnelAutoStarted)) this.showTunnelUrlChangedNotification(change);
    }

    /** Thông báo hệ thống cho BOSS (app có thể đang ẩn dưới khay): bấm để sao chép địa chỉ mới. */
    private showTunnelUrlChangedNotification(change: BossUrlChangedEvent): void {
        try {
            const { Notification, clipboard, BrowserWindow } = require('electron');
            if (!Notification?.isSupported?.()) return;
            const notification = new Notification({
                title: 'Địa chỉ cho nhân viên đã đổi',
                body: `${change.newUrl}\nNhấn để sao chép rồi gửi cho nhân viên làm việc từ xa.`,
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

    /** Đọc provider config (cloudflare mặc định, Cloudflare có tài khoản, hoặc ngrok static domain) từ DB. */
    private getTunnelOptions(): TunnelOptions {
        try {
            const db = DatabaseService.getInstance();
            const provider = (db.getSetting('relay_tunnel_provider') as TunnelProvider) || 'cloudflare';
            const { decryptSecret } = require('../api/secretBox');
            if (provider === 'ngrok') {
                return {
                    provider: 'ngrok',
                    // relayIpc lưu mã hoá (enc:/plain:); giá trị cũ dạng thô vẫn đọc được
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

    /** Chặn OS ngủ (idle sleep) khi relay chạy — nhân viên vẫn truy cập được. */
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

        // ─── Socket.IO (transport duy nhất) ──────────────────────
        // Buffer MỘT lần kèm người nhận (relayAudience.ts: tài khoản được giao — cùng assigned_accounts với kiểm tra
        // quyền REST; ERP gửi đích danh; dữ liệu chung workspace) → chỉ phát tới phòng của nhân viên được nhận.
        // Nhân viên offline → event ở buffer → catch-up (cùng quy tắc lọc) khi kết nối lại.
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
                // Socket.IO còn sống (client hiện tại dùng Socket.IO, không dùng SSE) → vẫn online
                try {
                    if (SocketIOService.getInstance().isOnline(empId)) {
                        emp.lastSeen = now;
                        continue;
                    }
                } catch { /* socket server chưa chạy */ }

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
                    // accounts.cookies lưu mã hoá (safeStorage) — đọc SQL trực tiếp nên phải tự giải mã
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
     * Id tài khoản của lệnh proxy Facebook / Telegram → accounts.zalo_id (dạng trong danh sách được giao). Facebook: handler
     * nhận cả id nội bộ fb_accounts.id (UUID) lẫn id Facebook thật (= accounts.zalo_id) → đổi UUID về facebook_id.
     */
    private canonicalProxyAccountId(channel: string, accountId: string): string {
        if (!channel.startsWith('fb:') || /^\d+$/.test(accountId)) return accountId;
        const fbAcc = this.runOnPinnedDb((db) => db.getFBAccount(accountId));
        return fbAcc?.facebook_id ? String(fbAcc.facebook_id) : accountId;
    }

    /**
     * Tài khoản có phiên đang chạy trên Boss, theo kênh: Zalo — ConnectionManager; Facebook — FacebookConnectionManager
     * (theo fb_accounts.id); Telegram cá nhân — listener MTProto; bot Telegram — đang nhận update. Trước đây snapshot nhân
     * viên tra ConnectionManager (chỉ có Zalo) cho mọi kênh → tài khoản Facebook / Telegram luôn "mất kết nối" ở máy nhân viên.
     */
    private isAccountSessionOnline(zaloId: string, channel?: string | null): boolean {
        try {
            if (channel === 'facebook') {
                const fbAcc = this.runOnPinnedDb((db) => db.getFBAccountByFacebookId(zaloId));
                const FacebookConnectionManager = require('../../utils/FacebookConnectionManager').default;
                return !!(fbAcc?.id && FacebookConnectionManager.get(fbAcc.id)?.isConnected());
            }
            if (channel === 'telegram_user') return !!require('../telegram/TelegramUserListener').isConnected(zaloId);
            if (channel === 'telegram_bot') return !!require('../telegram/TelegramBotChannelService').isBotPolling(zaloId);
        } catch {
            return false;
        }
        return ConnectionManager.isConnected(zaloId);
    }

    /**
     * Thư mục media của Boss: luôn theo default workspace (Boss), không theo workspace đang active — khi máy Boss
     * đang mở workspace nhân viên, getBaseDir() trỏ về media của workspace đó → Boss không thấy file của chính mình.
     */
    private getBossMediaBasePath(): string {
        try {
            const WorkspaceManager = require('../../utils/WorkspaceManager').default;
            const wm = WorkspaceManager.getInstance();
            const defaultWs = wm.getWorkspaceById('default');
            if (defaultWs && defaultWs.dbPath) {
                return path.join(path.dirname(wm.resolveDbPath(defaultWs.dbPath)), 'media');
            }
        } catch { /* dùng getBaseDir */ }
        try { return FileStorageService.getBaseDir?.() || ''; } catch { return ''; }
    }

    /** Thư mục media/<id>/ có phải tài khoản không (accounts.zalo_id: Zalo / Facebook / Telegram) → id chuẩn. */
    private lookupMediaAccountId(segment: string): string | null {
        const row = this.runOnPinnedDb((db) => db.queryOne<{ zalo_id: string }>(
            'SELECT zalo_id FROM accounts WHERE zalo_id = ? COLLATE NOCASE LIMIT 1', [segment]));
        return row?.zalo_id ? String(row.zalo_id) : null;
    }

    /** Đường dẫn file trong lệnh proxy: chỉ thư mục media của Boss, cùng quy tắc tài khoản với tải /api/media. */
    private proxyFilePathContext(employee: RegisteredEmployee): ProxyPathContext {
        const realpath = (p: string): string => {
            const abs = path.resolve(p);
            try { return fs.realpathSync.native(abs); } catch { /* thử bản JS */ }
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

    /** Item thư viện (_libraryUuid / _libraryUuids) phải thuộc trang nhân viên được dùng. Trả uuid bị từ chối, hoặc null. */
    private checkProxyLibraryItems(employee: RegisteredEmployee, params: any): string | null {
        const uuids: string[] = [];
        if (typeof params?._libraryUuid === 'string' && params._libraryUuid) uuids.push(params._libraryUuid);
        if (Array.isArray(params?._libraryUuids)) uuids.push(...params._libraryUuids.map(String).filter(Boolean));
        if (uuids.length === 0) return null;
        const LibraryService = require('../library/LibraryService').default;
        for (const uuid of uuids) {
            const item = this.runOnPinnedDb(() => LibraryService.getInstance().getItem(uuid));
            // Không thấy item: để luồng cũ xử lý (báo "không tìm thấy file") — không có file nào bị lộ
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
        // Realtime lọc theo danh sách mới ngay, kể cả socket của nhân viên chưa đăng ký lại (sau khi Boss khởi động)
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
     * Đọc body có giới hạn: nhiều endpoint đọc body TRƯỚC khi xác thực (login, heartbeat, proxy),
     * không giới hạn thì qua tunnel ai cũng làm đầy RAM được. Gộp Buffer rồi mới giải mã UTF-8
     * (cộng chuỗi theo chunk làm vỡ ký tự tiếng Việt nằm giữa hai chunk).
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

    /** Body tối đa cho route nhân viên (upload file đi đường multipart/JSON riêng). */
    static readonly MAX_BODY_BYTES = 50 * 1024 * 1024;
    /** Upload media của nhân viên (POST /api/media/upload): Zalo PC gửi tệp tối đa 1 GB. Ghi thẳng xuống đĩa. */
    static readonly MAX_MEDIA_UPLOAD_BYTES = 1024 * 1024 * 1024;
    /** Login/heartbeat: chỉ vài trăm byte JSON. */
    static readonly SMALL_BODY_BYTES = 256 * 1024;

    private json(res: http.ServerResponse, status: number, data: any): void {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    /** Cache-aware REST result - skips the synchronous better-sqlite3 query
     *  if a fresh cached response exists. This prevents main-thread blocking
     *  when the employee calls many GET endpoints after every message.
     *  Chạy trong runOnPinnedDb (DB của relay). Entry chỉ dùng lại khi DB CHƯA đổi từ lúc lưu: Boss ghim / gắn nhãn /
     *  tắt tiếng → ghi DB → phát event → nhân viên tải lại ngay — trước đây trong 1.5 s nhận lại giá trị CŨ đã cache và
     *  giữ sai tới event sau. Kết quả lỗi không được cache. */
    private getCachedRestResult(method: string, pathname: string, employeeId: string, fetchFn: () => any, params?: Record<string, any>): any {
        if (method !== 'GET') return fetchFn();
        // Khoá gồm cả tham số (zaloId…): trước đây chỉ theo pathname → tài khoản này nhận nhầm cờ/nhãn/ghim của tài khoản kia
        const cacheKey = restCacheKey(method, pathname, employeeId, params);
        const token = this.restCacheToken();
        const cached = this.restApiCache.get(cacheKey, token);
        if (cached !== undefined) return cached;
        const data = fetchFn();
        this.restApiCache.set(cacheKey, token, data);
        return data;
    }

    /**
     * Mốc thay đổi của DB đang phục vụ relay: total_changes() (ghi qua chính kết nối này — IPC Boss, lệnh nhân viên,
     * listener) + PRAGMA data_version (commit của kết nối KHÁC). Đổi ⇒ mọi entry cache hết hiệu lực. null (không đọc
     * được) ⇒ không cache — đúng trước, nhanh sau.
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

