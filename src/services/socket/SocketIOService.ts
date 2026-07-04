/**
 * SocketIOService - Boss-side Socket.IO server.
 *
 * Attaches to the existing HTTP server (port 9900) at path /socket.io.
 * - Employee authenticates via token from handshake.auth
 * - Each employee joins their own room emp:{employeeId}
 * - All events are pushed to EventBuffer before emit (no miss guarantee)
 * - On reconnect, employee sends 'catch-up' { lastSeqId } → replay missed events
 *
 * Room lifecycle (Socket.IO dynamic rooms):
 * - Room created automatically on first socket.join()
 * - Room destroyed when last socket leaves
 * - No pre-creation needed by Boss
 *
 * Integration:
 *   HttpRelayService.start() → this.attach(httpServer)
 *   HttpRelayService.relayEventToEmployees() → this.emitToEmployee(empId, channel, data)
 */
import * as http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import EventBuffer from './EventBuffer';
import Logger from '../../utils/Logger';
import EmployeeService from '../employee/EmployeeService';
import WorkspaceManager from '../../utils/WorkspaceManager';

interface SocketIOEmployee {
  employeeId: string;
  socketId: string;
  connectedAt: number;
}

class SocketIOService {
  private static instance: SocketIOService;
  private io: SocketIOServer | null = null;
  private running = false;

  /** In-memory buffer cho catch-up (5000 event gần nhất) */
  private eventBuffer = new EventBuffer();

  /** Track online employees (Socket.IO connection) */
  private onlineEmployees = new Set<string>();

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
  public attach(httpServer: http.Server): void {
    if (this.running) {
      Logger.log('[SocketIOService] Already attached');
      return;
    }

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
        const payload = empService.validateToken(token);

        if (!payload || !payload.employee_id) {
          return next(new Error('Invalid token'));
        }

        const employee = empService.getEmployeeById(payload.employee_id);
        if (!employee || !employee.is_active) {
          return next(new Error('Employee not found or inactive'));
        }

        // Attach employee data to socket for use in connection handler
        socket.data.employeeId = employee.employee_id;
        socket.data.displayName = employee.display_name;
        next();
      } catch (err: any) {
        Logger.warn(`[SocketIOService] Auth error: ${err.message}`);
        next(new Error('Authentication failed'));
      }
    });

    // ─── Connection handler ──────────────────────────────────────────
    this.io.on('connection', (socket) => {
      const employeeId: string = socket.data.employeeId;
      const displayName: string = socket.data.displayName || employeeId;

      // Join room riêng - Socket.IO tự động tạo room nếu chưa tồn tại
      socket.join(`emp:${employeeId}`);

      // Track online
      this.onlineEmployees.add(employeeId);
      Logger.log(`[SocketIOService] 🟢 ${displayName} connected (socket=${socket.id})`);

      // ── Catch-up: employee gửi lastSeqId → replay buffer ────────
      socket.on('catch-up', ({ lastSeqId }: { lastSeqId?: number }) => {
        const since = lastSeqId || 0;
        const events = this.eventBuffer.getSince(since);
        let sent = 0;
        for (const ev of events) {
          socket.emit('event', {
            seqId: ev.seqId,
            channel: ev.channel,
            data: ev.data,
          });
          sent++;
        }
        if (sent > 0) {
          Logger.log(`[SocketIOService] Catch-up: sent ${sent}/${this.eventBuffer.size} events to ${displayName} (lastSeqId=${since})`);
        }
      });

      // ── Disconnect ──────────────────────────────────────────────
      socket.on('disconnect', (reason) => {
        this.onlineEmployees.delete(employeeId);
        // Socket.IO tự động rời room khi disconnect
        Logger.log(`[SocketIOService] 🔴 ${displayName} disconnected (reason=${reason})`);

        // Nếu còn socket khác cùng employeeId thì vẫn online
        const remainingSockets = this.io?.sockets.adapter.rooms.get(`emp:${employeeId}`);
        if (remainingSockets && remainingSockets.size > 0) {
          this.onlineEmployees.add(employeeId); // vẫn còn socket khác
        }
      });

      // ── Error ───────────────────────────────────────────────────
      socket.on('error', (err) => {
        Logger.warn(`[SocketIOService] Socket error for ${displayName}: ${err.message}`);
      });
    });

    this.running = true;
    Logger.log('[SocketIOService] ✅ Socket.IO server attached to HTTP server');
  }

  /**
   * Gửi event đến 1 employee qua Socket.IO.
   * - Event luôn được push vào EventBuffer trước (đảm bảo không miss)
   * - Nếu employee offline (room rỗng) → no-op, event vẫn ở buffer → catch-up sau
   * - Không throw exception dù employee không tồn tại
   */
  public emitToEmployee(employeeId: string, channel: string, data: any): void {
    if (!this.io || !this.running) return;

    // 1. Buffer trước → đảm bảo không miss dù offline
    const seqId = this.eventBuffer.push(channel, data);

    // 2. Emit vào room của employee
    //    Nếu room rỗng (offline) → no-op, event vẫn ở buffer
    try {
      this.io.to(`emp:${employeeId}`).emit('event', {
        seqId,
        channel,
        data,
      });
    } catch (err: any) {
      Logger.warn(`[SocketIOService] emitToEmployee error: ${err.message}`);
    }
  }

  /**
   * Kiểm tra employee có đang online qua Socket.IO không
   */
  public isOnline(employeeId: string): boolean {
    if (!this.io) return false;
    const room = this.io.sockets.adapter.rooms.get(`emp:${employeeId}`);
    return !!(room && room.size > 0);
  }

  /**
   * Employee đã từng connect Socket.IO (kể cả hiện tại đang offline).
   * Nếu true → employee đã update app có SocketIOClient → skip SSE fallback
   * (tránh half-open socket mất event).
   * Nếu false → employee cũ chưa update → vẫn gửi SSE.
   */
  /**
   * Đếm số employee đang online
   */
  public getOnlineCount(): number {
    if (!this.io) return 0;
    let count = 0;
    // Duyệt rooms có prefix emp:
    for (const [roomId, sockets] of this.io.sockets.adapter.rooms) {
      if (roomId.startsWith('emp:') && sockets.size > 0) count++;
    }
    return count;
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
    Logger.log('[SocketIOService] Stopped');
  }

  /** Chỉ dùng cho test */
  public _getBuffer(): EventBuffer { return this.eventBuffer; }
}

export default SocketIOService;
