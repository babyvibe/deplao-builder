/**
 * SocketIOService: Boss-side Socket.IO server.
 *
 * Attaches to the existing HTTP server (port 9900) at path /socket.io.
 * - An employee authenticates with the token from handshake.auth
 * - Each employee joins their own room emp:{employeeId} AFTER 'catch-up' is handled (the replay finishes before joining the room →
 *   replayed events and live events do not duplicate or come out of order)
 * - Every event is buffered ONCE (EventBuffer) with its audience (relayAudience.ts), then sent only to the rooms of the employees
 *   who may receive it: assigned accounts (same assigned_accounts source as the REST permission checks), events addressed to a specific employee,
 *   or the workspace's shared data
 * - Catch-up (catchUpProtocol.ts): the employee sends 'catch-up' { lastSeqId, bootId } → Boss replays the missed part (filtered per
 *   employee, with a limit) or reports a reset (Boss restarted / buffer not large enough) so the employee resyncs
 * - Every attach = a new stream (new bootId, seqId larger than the previous stream)
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
   * The employee's assigned accounts: same source as the REST permission checks (HttpRelayService: RegisteredEmployee
   * .assigned_accounts). undefined = the employee is not registered → use the list read when the socket authenticated.
   */
  resolveAssignedAccounts?: (employeeId: string) => readonly string[] | undefined;
}

const EMPLOYEE_ROOM_PREFIX = 'emp:';
/** Every client sends 'catch-up' right after connecting; as a fallback for a client that does not send it → it still joins the room after this delay. */
const CATCH_UP_JOIN_FALLBACK_MS = 5_000;

function employeeRoom(employeeId: string): string {
  return `${EMPLOYEE_ROOM_PREFIX}${employeeId}`;
}

/** Waits this long before Boss disconnects the socket (kick / revoke), so 'relay:kicked' is delivered to the client first. */
const DISCONNECT_FLUSH_DELAY_MS = 1_000;

/** The socket's employee: the employee namespace (socket.data.employeeId) or /v1 (API) logged in with an employee JWT. */
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

  /** Catch-up buffer (the latest 5000 events, each stored ONCE with its audience): a new stream on every attach. */
  private eventBuffer = new EventBuffer<RelayAudience>();

  /** Track online employees (Socket.IO connection, joined the room) */
  private onlineEmployees = new Set<string>();

  private resolveAssigned: ((employeeId: string) => readonly string[] | undefined) | null = null;
  /** Assigned accounts read when the socket authenticated: a fallback when the employee is not registered in HttpRelayService. */
  private socketAssigned = new Map<string, string[]>();
  /** Last seqId sent to each employee (an event or a 'seq' mark) → knows when a mark needs to be sent. */
  private lastSentSeq = new Map<string, number>();

  /** The running Socket.IO server (the Public API v1 attaches the /v1 namespace here). */
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
   * Attaches Socket.IO to the current HTTP server.
   * Called from HttpRelayService.start() after httpServer is created.
   */
  public attach(httpServer: http.Server, options: SocketIOAttachOptions = {}): void {
    if (this.running) {
      Logger.log('[SocketIOService] Already attached');
      return;
    }

    // New stream: events while the relay was off were not buffered → employees must know (different bootId) to resync
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
      // Ping/pong 25 s, timeout 30 s → detects a lost connection within ~55 s
      // Timeout 30 s (raised from 20 s) to avoid false disconnects over a tunnel
      pingInterval: 25000,
      pingTimeout: 30000,
      // WebSocket first, fall back to HTTP polling if a firewall blocks WS
      transports: ['websocket', 'polling'],
      // Reduce unused memory
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
        // Signature + expiry + employee still enabled + not revoked (kick / lock / password change / signing key change)
        const payload = empService.validateToken(token);

        if (!payload?.valid || !payload.employee_id) {
          // Matches the client's isAuthRejectionMessage → stop completely and report "phiên hết hạn" (session expired); a Boss-side DB error → the client retries
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

    // Join the private room AFTER the catch-up replay finishes: Socket.IO creates the room if it does not exist yet
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

    // ── Catch-up: new client { proto, lastSeqId, bootId, sinceTs } + ack; old client { lastSeqId } ──
    socket.on('catch-up', (payload: unknown, ack?: unknown) => {
      clearTimeout(joinFallback);
      const reply = typeof ack === 'function' ? (ack as (result: CatchUpResult) => void) : null;
      this.handleCatchUp(socket, employeeId, displayName, payload, reply, joinRoom);
    });

    // ── Disconnect ──────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      clearTimeout(joinFallback);
      this.onlineEmployees.delete(employeeId);
      // Socket.IO leaves the room automatically on disconnect
      Logger.log(`[SocketIOService] 🔴 ${displayName} disconnected (reason=${reason})`);

      // If another socket with the same employeeId is still connected, the employee stays online
      const remainingSockets = this.io?.sockets.adapter.rooms.get(employeeRoom(employeeId));
      if (remainingSockets && remainingSockets.size > 0) {
        this.onlineEmployees.add(employeeId); // another socket still exists
      }
    });

    // ── Error ───────────────────────────────────────────────────
    socket.on('error', (err) => {
      Logger.warn(`[SocketIOService] Socket error for ${displayName}: ${err.message}`);
    });
  }

  /**
   * Replays the missed part (only events this employee may receive), joins the room, then returns the ack: one sync pass, so
   * no live event slips in between the replayed part and the ack.
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
        // planCatchUp failed → the client resyncs to be safe
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
   * Emits a relay event: buffers it ONCE with its audience, then sends it to the room of each employee who may receive it.
   * An employee who is offline (no socket in the room) → the event stays in the buffer → caught up on reconnect.
   * Does not throw.
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
   * Sends an event to EXACTLY one employee (buffered like publish, audience = that employee).
   * Does not throw even if the employee does not exist / is offline.
   */
  public emitToEmployee(employeeId: string, channel: string, data: any): void {
    if (!this.io || !this.running || !employeeId) return;
    this.dispatch(channel, data, addressedAudience(employeeId));
  }

  /** An assigned account has just changed (Boss reassigned it): used for employees not registered in HttpRelayService. */
  public updateEmployeeAccess(employeeId: string, accounts: readonly string[]): void {
    if (!employeeId || !this.socketAssigned.has(employeeId)) return;
    this.socketAssigned.set(employeeId, normalizeAccountList(accounts));
  }

  private dispatch(channel: string, data: any, audience: RelayAudience): void {
    if (audience.kind === 'nobody') return;
    // Instant events (typing): sent live, not buffered / no seqId
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
        // Employees with few events: send a mark so their position does not fall far behind the head of the buffer (avoids a false resync on reconnect)
        watermarks.push(employeeRoom(employeeId));
        this.lastSentSeq.set(employeeId, event.seqId);
      }
    }
    if (targets.length > 0) {
      // Encode once for every target room
      const envelope: EventEnvelope = event ? toEnvelope(event, bootId) : { channel, data, bootId };
      io.to(targets).emit('event', envelope);
    }
    if (event && watermarks.length > 0) {
      const watermark: SeqWatermark = { bootId, seqId: event.seqId };
      io.to(watermarks).emit('seq', watermark);
    }
  }

  /** Employees whose socket has joined the room (caught up). */
  private joinedEmployeeIds(): string[] {
    const rooms = this.io?.sockets.adapter.rooms;
    if (!rooms) return [];
    const ids: string[] = [];
    for (const [roomId, sockets] of rooms) {
      if (roomId.startsWith(EMPLOYEE_ROOM_PREFIX) && sockets.size > 0) ids.push(roomId.slice(EMPLOYEE_ROOM_PREFIX.length));
    }
    return ids;
  }

  /** Current list: the registered employees (the source of the REST permission checks) → otherwise the list read at authentication. */
  private assignedAccountsFor(employeeId: string): readonly string[] {
    if (this.resolveAssigned) {
      try {
        const accounts = this.resolveAssigned(employeeId);
        if (accounts) return accounts;
      } catch { /* use the list read at authentication */ }
    }
    return this.socketAssigned.get(employeeId) ?? [];
  }

  /**
   * Checks whether an employee is currently online through Socket.IO
   */
  public isOnline(employeeId: string): boolean {
    if (!this.io) return false;
    const room = this.io.sockets.adapter.rooms.get(employeeRoom(employeeId));
    return !!(room && room.size > 0);
  }

  /**
   * Counts the employees currently online
   */
  public getOnlineCount(): number {
    return this.joinedEmployeeIds().length;
  }

  /** Employees whose socket has joined the room (receiving realtime events). */
  public getOnlineEmployeeIds(): string[] {
    return this.joinedEmployeeIds();
  }

  /**
   * Disconnects all sockets of one employee after `delayMs`: kick / lock / delete / password change. Called AFTER the token has been revoked
   * (a client that reconnects by itself is rejected at the handshake). Not only the emp:{id} room: it includes sockets that have not finished catch-up and /v1
   * (API) sockets logged in with the employee's JWT. Only disconnects the sockets that exist at the time of the call: a socket connected during the wait passed the handshake
   * after the revoke, so it carries the new token (logged in again) → kept. Returns the number of sockets that will be disconnected.
   */
  public disconnectEmployee(employeeId: string, delayMs = DISCONNECT_FLUSH_DELAY_MS): number {
    if (!employeeId) return 0;
    return this.disconnectMatching((id) => id === employeeId, delayMs, `nhân viên ${employeeId}`);
  }

  /** Disconnects all employee sockets ("Đăng xuất tất cả" = log out everywhere; called AFTER the signing key has been changed). */
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
   * Stops the server
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
    // Free the buffer; the next attach is a new stream (new bootId)
    this.eventBuffer.reset();
    Logger.log('[SocketIOService] Stopped');
  }

  /** For tests only */
  public _getBuffer(): EventBuffer<RelayAudience> { return this.eventBuffer; }
}

export default SocketIOService;
