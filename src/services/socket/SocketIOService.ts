/**
 * SocketIOService - Boss-side Socket.IO server.
 *
 * Attaches to the existing HTTP server (port 9900) at path /socket.io.
 * - Employee authenticates via token from handshake.auth
 * - Each employee joins their own room emp:{employeeId} — SAU khi xử lý 'catch-up' (phát lại xong mới vào phòng →
 *   phần phát lại và event trực tiếp không trùng / đảo thứ tự)
 * - Mỗi event được buffer MỘT lần (EventBuffer) kèm audience (relayAudience.ts) rồi chỉ phát tới phòng của nhân viên
 *   được nhận: tài khoản được giao (cùng nguồn assigned_accounts với kiểm tra quyền REST), event gửi đích danh,
 *   hoặc dữ liệu chung của workspace
 * - Catch-up (catchUpProtocol.ts): employee gửi 'catch-up' { lastSeqId, bootId } → Boss phát lại phần đã lỡ (lọc theo
 *   nhân viên, có giới hạn) hoặc báo reset (Boss khởi động lại / buffer không đủ) để employee resync
 * - Mỗi lần attach = luồng mới (bootId mới, seqId lớn hơn luồng trước)
 *
 * Room lifecycle (Socket.IO dynamic rooms):
 * - Room created automatically on first socket.join()
 * - Room destroyed when last socket leaves
 * - No pre-creation needed by Boss
 *
 * Integration:
 *   HttpRelayService.start() → this.attach(httpServer, { resolveAssignedAccounts })
 *   HttpRelayService.relayEventToEmployees() → this.publish(channel, data)
 *   HttpRelayService.updateEmployeeRooms() → this.updateEmployeeAccess(employeeId, zaloIds)
 */
import * as http from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import EventBuffer, { type BufferedEvent } from './EventBuffer';
import {
  addressedAudience,
  canReceiveRelayEvent,
  classifyRelayEvent,
  isEphemeralRelayChannel,
  normalizeAccountList,
  type RelayAudience,
} from './relayAudience';
import {
  CATCH_UP_PROTOCOL,
  planCatchUp,
  SEQ_WATERMARK_EVERY,
  toEnvelope,
  type CatchUpPlan,
  type CatchUpResult,
  type EventEnvelope,
  type SeqWatermark,
} from './catchUpProtocol';
import Logger from '../../utils/Logger';
import EmployeeService from '../employee/EmployeeService';
import { socketRejectionMessage } from '../employee/employeeTokenPolicy';

export interface SocketIOAttachOptions {
  /**
   * Tài khoản được giao của nhân viên — cùng nguồn với kiểm tra quyền REST (HttpRelayService: RegisteredEmployee
   * .assigned_accounts). undefined = nhân viên chưa đăng ký → dùng danh sách đọc lúc socket xác thực.
   */
  resolveAssignedAccounts?: (employeeId: string) => readonly string[] | undefined;
}

const EMPLOYEE_ROOM_PREFIX = 'emp:';
/** Client nào cũng gửi 'catch-up' ngay khi nối; phòng hờ client không gửi → vẫn vào phòng sau ngần này. */
const CATCH_UP_JOIN_FALLBACK_MS = 5_000;

function employeeRoom(employeeId: string): string {
  return `${EMPLOYEE_ROOM_PREFIX}${employeeId}`;
}

/** Chờ ngần này trước khi Boss ngắt socket (kick / thu hồi) — 'relay:kicked' vừa phát kịp tới client. */
const DISCONNECT_FLUSH_DELAY_MS = 1_000;

/** Nhân viên của socket: namespace nhân viên (socket.data.employeeId) hoặc /v1 (API) đăng nhập bằng JWT nhân viên. */
function socketEmployeeId(socket: Socket): string {
  const data = socket.data as { employeeId?: unknown; principal?: { kind?: unknown; id?: unknown } } | undefined;
  if (typeof data?.employeeId === 'string' && data.employeeId) return data.employeeId;
  const principal = data?.principal;
  if (principal?.kind === 'employee' && typeof principal.id === 'string') return principal.id;
  return '';
}

class SocketIOService {
  private static instance: SocketIOService;
  private io: SocketIOServer | null = null;
  private running = false;

  /** Buffer catch-up (5000 event gần nhất, mỗi event MỘT lần kèm audience) — luồng mới mỗi lần attach. */
  private eventBuffer = new EventBuffer<RelayAudience>();

  /** Track online employees (Socket.IO connection, đã vào phòng) */
  private onlineEmployees = new Set<string>();

  private resolveAssigned: ((employeeId: string) => readonly string[] | undefined) | null = null;
  /** Tài khoản được giao đọc lúc socket xác thực — dự phòng khi nhân viên chưa đăng ký ở HttpRelayService. */
  private socketAssigned = new Map<string, string[]>();
  /** seqId cuối cùng đã gửi (event hoặc mốc 'seq') tới từng nhân viên — biết khi nào cần gửi mốc. */
  private lastSentSeq = new Map<string, number>();

  /** Server Socket.IO đang chạy (Public API v1 gắn namespace /v1 vào đây). */
  public getServer(): SocketIOServer | null {
    return this.io;
  }

  public static getInstance(): SocketIOService {
    if (!SocketIOService.instance) {
      SocketIOService.instance = new SocketIOService();
    }
    return SocketIOService.instance;
  }

  /**
   * Attach Socket.IO vào HTTP server hiện tại.
   * Gọi từ HttpRelayService.start() sau khi tạo httpServer.
   */
  public attach(httpServer: http.Server, options: SocketIOAttachOptions = {}): void {
    if (this.running) {
      Logger.log('[SocketIOService] Already attached');
      return;
    }

    // Luồng mới: event lúc relay tắt không được buffer → nhân viên phải biết (bootId khác) để resync
    this.eventBuffer.reset();
    this.resolveAssigned = options.resolveAssignedAccounts ?? null;
    this.socketAssigned.clear();
    this.lastSentSeq.clear();

    this.io = new SocketIOServer(httpServer, {
      path: '/socket.io',
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      // Ping/pong 25s, timeout 30s → phát hiện mất kết nối trong ~55s
      // Timeout 30s (tăng từ 20s) để tránh false disconnect trên tunnel
      pingInterval: 25000,
      pingTimeout: 30000,
      // WebSocket ưu tiên, fallback HTTP polling nếu WS bị firewall chặn
      transports: ['websocket', 'polling'],
      // Giảm memory unused
      maxHttpBufferSize: 1e6, // 1MB
    });

    // ─── Auth middleware ────────────────────────────────────────────
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Missing auth token'));
      }

      try {
        const empService = EmployeeService.getInstance();
        // Chữ ký + hạn + nhân viên còn bật + chưa bị thu hồi (kick / khoá / đổi mật khẩu / đổi khoá ký)
        const payload = empService.validateToken(token);

        if (!payload?.valid || !payload.employee_id) {
          // Khớp isAuthRejectionMessage của client → dừng hẳn, báo "phiên hết hạn"; lỗi DB phía Boss → client thử lại
          return next(new Error(socketRejectionMessage(payload?.reason)));
        }

        const employee = empService.getEmployeeById(payload.employee_id);
        if (!employee || !employee.is_active) {
          return next(new Error(socketRejectionMessage('inactive')));
        }

        // Attach employee data to socket for use in connection handler
        socket.data.employeeId = employee.employee_id;
        socket.data.displayName = employee.display_name;
        socket.data.assignedAccounts = normalizeAccountList(employee.assigned_accounts);
        next();
      } catch (err: any) {
        Logger.warn(`[SocketIOService] Auth error: ${err.message}`);
        next(new Error('Authentication failed'));
      }
    });

    // ─── Connection handler ──────────────────────────────────────────
    this.io.on('connection', (socket) => this.handleConnection(socket));

    this.running = true;
    Logger.log(`[SocketIOService] ✅ Socket.IO server attached to HTTP server (bootId=${this.eventBuffer.bootId}, seq từ ${this.eventBuffer.headSeqId + 1})`);
  }

  private handleConnection(socket: Socket): void {
    const employeeId: string = socket.data.employeeId;
    const displayName: string = socket.data.displayName || employeeId;
    if (Array.isArray(socket.data.assignedAccounts)) {
      this.socketAssigned.set(employeeId, socket.data.assignedAccounts);
    }
    Logger.log(`[SocketIOService] 🟢 ${displayName} connected (socket=${socket.id})`);

    // Vào phòng riêng SAU khi catch-up phát lại xong — Socket.IO tự tạo room nếu chưa tồn tại
    let joined = false;
    const joinRoom = () => {
      if (joined || !socket.connected) return;
      joined = true;
      socket.join(employeeRoom(employeeId));
      this.onlineEmployees.add(employeeId);
    };
    const joinFallback = setTimeout(() => {
      if (joined) return;
      Logger.warn(`[SocketIOService] ${displayName} không gửi catch-up sau ${CATCH_UP_JOIN_FALLBACK_MS / 1000}s — vào phòng không phát lại`);
      this.lastSentSeq.set(employeeId, this.eventBuffer.headSeqId);
      joinRoom();
    }, CATCH_UP_JOIN_FALLBACK_MS);

    // ── Catch-up: client mới { proto, lastSeqId, bootId, sinceTs } + ack; client cũ { lastSeqId } ──
    socket.on('catch-up', (payload: unknown, ack?: unknown) => {
      clearTimeout(joinFallback);
      const reply = typeof ack === 'function' ? (ack as (result: CatchUpResult) => void) : null;
      this.handleCatchUp(socket, employeeId, displayName, payload, reply, joinRoom);
    });

    // ── Disconnect ──────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      clearTimeout(joinFallback);
      this.onlineEmployees.delete(employeeId);
      // Socket.IO tự động rời room khi disconnect
      Logger.log(`[SocketIOService] 🔴 ${displayName} disconnected (reason=${reason})`);

      // Nếu còn socket khác cùng employeeId thì vẫn online
      const remainingSockets = this.io?.sockets.adapter.rooms.get(employeeRoom(employeeId));
      if (remainingSockets && remainingSockets.size > 0) {
        this.onlineEmployees.add(employeeId); // vẫn còn socket khác
      }
    });

    // ── Error ───────────────────────────────────────────────────
    socket.on('error', (err) => {
      Logger.warn(`[SocketIOService] Socket error for ${displayName}: ${err.message}`);
    });
  }

  /**
   * Phát lại phần đã lỡ (chỉ event nhân viên này được nhận), vào phòng, rồi trả ack — cùng một lượt đồng bộ nên
   * không event trực tiếp nào chen giữa phần phát lại và ack.
   */
  private handleCatchUp(
    socket: Socket,
    employeeId: string,
    displayName: string,
    payload: unknown,
    reply: ((result: CatchUpResult) => void) | null,
    joinRoom: () => void,
  ): void {
    const assigned = this.assignedAccountsFor(employeeId);
    const accept = (event: BufferedEvent<RelayAudience>) => canReceiveRelayEvent(event.audience, employeeId, assigned);
    let plan: CatchUpPlan<RelayAudience> | null = null;
    try {
      plan = planCatchUp(payload, !!reply, this.eventBuffer, accept, Date.now());
    } catch (err: any) {
      Logger.warn(`[SocketIOService] Catch-up error for ${displayName}: ${err?.message || err}`);
    }

    const bootId = this.eventBuffer.bootId;
    let sent = 0;
    for (const event of plan?.events ?? []) {
      try {
        socket.emit('event', toEnvelope(event, bootId));
        sent++;
      } catch (err: any) {
        Logger.warn(`[SocketIOService] Catch-up emit ${event.channel} lỗi: ${err?.message || err}`);
      }
    }

    joinRoom();
    this.lastSentSeq.set(employeeId, this.eventBuffer.headSeqId);

    if (reply) {
      const result: CatchUpResult = plan?.result ?? {
        // planCatchUp lỗi → client resync cho chắc
        proto: CATCH_UP_PROTOCOL,
        mode: 'reset',
        reason: 'catchup-gap',
        bootId,
        headSeqId: this.eventBuffer.headSeqId,
        replayed: 0,
      };
      try {
        reply(result);
      } catch (err: any) {
        Logger.warn(`[SocketIOService] Catch-up ack lỗi: ${err?.message || err}`);
      }
    }

    if (!plan) return;
    const since = plan.request.lastSeqId;
    if (plan.mode === 'reset') {
      Logger.log(`[SocketIOService] Catch-up ${displayName}: ${plan.reason === 'boss-restart' ? 'luồng khác (Boss đã khởi động lại)' : 'buffer không phủ đủ'}`
        + ` — không phát lại, nhân viên resync (lastSeqId=${since}, head=${this.eventBuffer.headSeqId}, oldest=${this.eventBuffer.oldestSeqId})`);
    } else if (sent > 0 || plan.truncated) {
      Logger.log(`[SocketIOService] Catch-up ${displayName}: phát lại ${sent} event (${plan.mode}${plan.modern ? '' : ', client cũ'}`
        + `${plan.truncated ? ', vượt giới hạn — chỉ gửi mới nhất' : ''}, lastSeqId=${since}, buffer=${this.eventBuffer.size})`);
    }
  }

  /**
   * Phát một event relay: buffer MỘT lần kèm audience rồi gửi tới phòng của nhân viên được nhận.
   * Nhân viên offline (không có socket trong phòng) → event vẫn ở buffer → catch-up khi kết nối lại.
   * Không throw.
   */
  public publish(channel: string, data: any): void {
    if (!this.io || !this.running) return;
    let audience: RelayAudience;
    try {
      audience = classifyRelayEvent(channel, data);
    } catch (err: any) {
      Logger.warn(`[SocketIOService] classify ${channel} lỗi: ${err?.message || err}`);
      return;
    }
    this.dispatch(channel, data, audience);
  }

  /**
   * Gửi event tới ĐÚNG một nhân viên (buffer như publish, audience = nhân viên đó).
   * Không throw dù employee không tồn tại / offline.
   */
  public emitToEmployee(employeeId: string, channel: string, data: any): void {
    if (!this.io || !this.running || !employeeId) return;
    this.dispatch(channel, data, addressedAudience(employeeId));
  }

  /** Tài khoản được giao vừa đổi (Boss gán lại) — dùng cho nhân viên chưa đăng ký ở HttpRelayService. */
  public updateEmployeeAccess(employeeId: string, accounts: readonly string[]): void {
    if (!employeeId || !this.socketAssigned.has(employeeId)) return;
    this.socketAssigned.set(employeeId, normalizeAccountList(accounts));
  }

  private dispatch(channel: string, data: any, audience: RelayAudience): void {
    if (audience.kind === 'nobody') return;
    // Event tức thời (typing): phát trực tiếp, không buffer / không seqId
    const event = isEphemeralRelayChannel(channel) ? null : this.eventBuffer.push(channel, data, audience);
    try {
      this.deliverLive(channel, data, audience, event);
    } catch (err: any) {
      Logger.warn(`[SocketIOService] publish ${channel} lỗi: ${err?.message || err}`);
    }
  }

  private deliverLive(channel: string, data: any, audience: RelayAudience, event: BufferedEvent<RelayAudience> | null): void {
    const io = this.io;
    if (!io) return;
    const bootId = this.eventBuffer.bootId;
    const targets: string[] = [];
    const watermarks: string[] = [];
    for (const employeeId of this.joinedEmployeeIds()) {
      if (canReceiveRelayEvent(audience, employeeId, this.assignedAccountsFor(employeeId))) {
        targets.push(employeeRoom(employeeId));
        if (event) this.lastSentSeq.set(employeeId, event.seqId);
      } else if (event && event.seqId - (this.lastSentSeq.get(employeeId) ?? 0) >= SEQ_WATERMARK_EVERY) {
        // Nhân viên ít event: báo mốc để vị trí của họ không tụt xa đầu buffer (tránh resync oan khi kết nối lại)
        watermarks.push(employeeRoom(employeeId));
        this.lastSentSeq.set(employeeId, event.seqId);
      }
    }
    if (targets.length > 0) {
      // Một lần encode cho mọi phòng đích
      const envelope: EventEnvelope = event ? toEnvelope(event, bootId) : { channel, data, bootId };
      io.to(targets).emit('event', envelope);
    }
    if (event && watermarks.length > 0) {
      const watermark: SeqWatermark = { bootId, seqId: event.seqId };
      io.to(watermarks).emit('seq', watermark);
    }
  }

  /** Nhân viên có socket đã vào phòng (đã catch-up). */
  private joinedEmployeeIds(): string[] {
    const rooms = this.io?.sockets.adapter.rooms;
    if (!rooms) return [];
    const ids: string[] = [];
    for (const [roomId, sockets] of rooms) {
      if (roomId.startsWith(EMPLOYEE_ROOM_PREFIX) && sockets.size > 0) ids.push(roomId.slice(EMPLOYEE_ROOM_PREFIX.length));
    }
    return ids;
  }

  /** Danh sách hiện hành: nhân viên đã đăng ký (nguồn của kiểm tra quyền REST) → không thì danh sách lúc xác thực. */
  private assignedAccountsFor(employeeId: string): readonly string[] {
    if (this.resolveAssigned) {
      try {
        const accounts = this.resolveAssigned(employeeId);
        if (accounts) return accounts;
      } catch { /* dùng danh sách lúc xác thực */ }
    }
    return this.socketAssigned.get(employeeId) ?? [];
  }

  /**
   * Kiểm tra employee có đang online qua Socket.IO không
   */
  public isOnline(employeeId: string): boolean {
    if (!this.io) return false;
    const room = this.io.sockets.adapter.rooms.get(employeeRoom(employeeId));
    return !!(room && room.size > 0);
  }

  /**
   * Đếm số employee đang online
   */
  public getOnlineCount(): number {
    return this.joinedEmployeeIds().length;
  }

  /** Nhân viên có socket đã vào phòng (đang nhận realtime). */
  public getOnlineEmployeeIds(): string[] {
    return this.joinedEmployeeIds();
  }

  /**
   * Ngắt mọi socket của một nhân viên sau `delayMs` — kick / khoá / xoá / đổi mật khẩu, gọi SAU khi đã thu hồi token
   * (client tự nối lại sẽ bị bắt tay từ chối). Không chỉ phòng emp:{id}: gồm cả socket chưa catch-up xong và socket /v1
   * (API) đăng nhập bằng JWT của nhân viên. Chỉ ngắt socket đang có lúc gọi — socket nối trong lúc chờ đã qua bắt tay
   * sau khi thu hồi, tức token mới (đăng nhập lại) → giữ. Trả về số socket sẽ ngắt.
   */
  public disconnectEmployee(employeeId: string, delayMs = DISCONNECT_FLUSH_DELAY_MS): number {
    if (!employeeId) return 0;
    return this.disconnectMatching((id) => id === employeeId, delayMs, `nhân viên ${employeeId}`);
  }

  /** Ngắt mọi socket nhân viên (Đăng xuất tất cả — gọi SAU khi đã đổi khoá ký). */
  public disconnectAllEmployees(delayMs = DISCONNECT_FLUSH_DELAY_MS): number {
    return this.disconnectMatching(() => true, delayMs, 'mọi nhân viên');
  }

  private disconnectMatching(match: (employeeId: string) => boolean, delayMs: number, label: string): number {
    const io = this.io;
    if (!io) return 0;
    const targets: Socket[] = [];
    for (const nsp of io._nsps.values()) {
      for (const socket of nsp.sockets.values()) {
        const employeeId = socketEmployeeId(socket);
        if (employeeId && match(employeeId)) targets.push(socket);
      }
    }
    if (targets.length === 0) return 0;
    const run = () => {
      let closed = 0;
      for (const socket of targets) {
        if (!socket.connected) continue;
        try {
          socket.disconnect(true);
          closed++;
        } catch { /* ignore */ }
      }
      if (closed > 0) Logger.log(`[SocketIOService] Đã ngắt ${closed} socket của ${label}`);
    };
    if (delayMs > 0) setTimeout(run, delayMs);
    else run();
    return targets.length;
  }

  /**
   * Dừng server
   */
  public stop(): void {
    if (this.io) {
      this.io.close();
      this.io = null;
    }
    this.running = false;
    this.onlineEmployees.clear();
    this.socketAssigned.clear();
    this.lastSentSeq.clear();
    this.resolveAssigned = null;
    // Giải phóng buffer; lần attach sau là luồng mới (bootId mới)
    this.eventBuffer.reset();
    Logger.log('[SocketIOService] Stopped');
  }

  /** Chỉ dùng cho test */
  public _getBuffer(): EventBuffer<RelayAudience> { return this.eventBuffer; }
}

export default SocketIOService;
