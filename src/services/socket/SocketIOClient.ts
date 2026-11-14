/**
 * SocketIOClient: Employee-side Socket.IO client.
 *
 * Replaces the SSE connection for real-time event delivery.
 * - Connects to the Boss Socket.IO server (attached to the same port, path /socket.io)
 * - Authenticates with a JWT token (handshake.auth)
 * - Transport errors (network loss, Boss turned off): Socket.IO reconnects by itself (backoff 1 s → 15 s)
 * - Boss REJECTS (middleware next(err)) or deliberately disconnects ('io server disconnect'): Socket.IO
 *   does NOT retry by itself → schedules the retry itself using SOCKET_RECONNECT_BACKOFF_MS (1/2/5/10/30 s...).
 *   Auth errors only (token expired / wrong, employee locked) → stop completely and report onAuthRejected
 *   (UI: "Phiên đăng nhập hết hạn - đăng nhập lại" = session expired, log in again) instead of looping forever.
 * - WebSocket blocked: tryAllTransports → falls back to HTTP long-polling within the same attempt
 *   (engine.io-client 6.6 does NOT try the next transport by default). A WebSocket that hangs / fails 2 times in a row
 *   → switch to polling-first (polling, then upgrade to WebSocket if possible).
 * - Catch-up (catchUpProtocol.ts): stores { bootId, lastSeqId } of the Boss stream; every connection sends 'catch-up' + ack.
 *   Boss replies reset (restarted: different bootId / buffer does not cover the gap) → jumps to Boss's current seqId and reports
 *   onResync ('boss-restart' / 'catchup-gap'). Old Boss builds (no bootId, no ack) → as before, a reconnect does a
 *   resync to be safe ('catchup-unverified').
 * - Forwards received events to the onEvent handler (HttpClientService.handlePushedEvent)
 *
 * Integration:
 *   HttpClientService.connect() → this.connect(bossUrl, token, { sinceTs })
 *   HttpClientService.disconnect() → this.disconnect()
 *   HttpClientService.handleWake() / heartbeat recovered → this.reconnectNow()
 */
import { io as socketIOClient, Socket } from 'socket.io-client';
import Logger from '../../utils/Logger';
import {
  backoffDelay,
  isAuthRejectionMessage,
  SOCKET_RECONNECT_BACKOFF_MS,
  type EmployeeResyncReason,
} from '../../shared/employee/employeeConnection';
import {
  applyCatchUpResult,
  buildCatchUpRequest,
  CATCH_UP_ACK_TIMEOUT_MS,
  initialClientSyncState,
  trackEnvelope,
  trackWatermark,
  type ClientSyncState,
} from './catchUpProtocol';

/** Catch-up state of ONE connection (one socket). */
interface PendingCatchUp {
  socket: Socket;
  timer: ReturnType<typeof setTimeout> | null;
  acked: boolean;
  /** Has a previous position (reconnect): an old Boss that cannot verify it → resync. */
  hadPosition: boolean;
  legacyHandled: boolean;
  /** ms offline before this connection (0 if not measured), sent with the resync. */
  gapMs: number;
}

export interface SocketStatusInfo {
  /** ms offline before this 'connect', only set on a RECONNECT (it has connected before). */
  gapMs?: number;
  /** Reason for 'disconnect' / the 'connect_error' message. */
  reason?: string;
}

const WEBSOCKET_FIRST = ['websocket', 'polling'];
const POLLING_FIRST = ['polling', 'websocket'];
/** Number of consecutive connection errors (WebSocket-first) before switching to polling-first. */
const TRANSPORT_FALLBACK_AFTER_ERRORS = 2;

/**
 * io(url) treats the path part of the URL as a NAMESPACE → a Boss URL with a sub-path (tunnel / reverse proxy
 * https://host/boss) would be rejected with "Invalid namespace". Connect to the origin and move the sub-path into `path`.
 * A URL without a sub-path → unchanged as before (origin + /socket.io).
 */
function socketEndpoint(bossUrl: string): { url: string; path: string } {
  try {
    const parsed = new URL(bossUrl);
    const basePath = parsed.pathname.replace(/\/+$/, '');
    return { url: `${parsed.protocol}//${parsed.host}`, path: `${basePath}/socket.io` };
  } catch {
    return { url: bossUrl, path: '/socket.io' };
  }
}

class SocketIOClient {
  private socket: Socket | null = null;
  private bossUrl = '';
  private token = '';
  private workspaceId = '';

  /** Catch-up position: the Boss stream (bootId) + the last seqId received in that stream. */
  private sync: ClientSyncState = initialClientSyncState();
  /** Boss time (ms) when registered through the heartbeat: the FIRST connection asks for events to be replayed from here (covers the gap between the REST load and joining the room). */
  private freshSinceTs: number | undefined;
  private catchUp: PendingCatchUp | null = null;

  /** Transport order for the next open (switches to polling-first when WebSocket cannot get through). */
  private transports: string[] = [...WEBSOCKET_FIRST];
  private connectErrorsInRow = 0;
  /** Has connected successfully with the current configuration before → later ones are reconnects. */
  private hasConnected = false;
  /** When the connection was lost (0 = connecting / not lost). */
  private disconnectedAt = 0;

  /** Manual reconnect (after Boss rejected / disconnected): Socket.IO does not do this by itself. */
  private manualAttempt = 0;
  private manualTimer: ReturnType<typeof setTimeout> | null = null;
  /** true = does not reconnect by itself (never connected, disconnected, or auth rejected). */
  private stopped = true;

  /** Callback when an event is received from Boss */
  private onEvent: ((channel: string, data: any) => void) | null = null;
  /** Callback when the connection state changes */
  private onStatusChange: ((connected: boolean, info?: SocketStatusInfo) => void) | null = null;
  /** Callback when Boss rejects the token: login is needed again, the client has stopped. */
  private onAuthRejected: ((message: string) => void) | null = null;
  /** Callback when catch-up cannot replay what was missed → everything must be reloaded (employee:resync). */
  private onResync: ((reason: EmployeeResyncReason, gapMs: number) => void) | null = null;

  /**
   * Connects (fresh) to the Boss Socket.IO server: resets the catch-up position, the transport order and the backoff schedule.
   * `sinceTs` = Boss time at registration (the heartbeat ts): the first connection only asks for events replayed from this time.
   * Socket.IO automatically:
   * - Ping/pong to detect a lost connection
   * - Auto-reconnect with exponential backoff on transport errors
   * - Buffers events while reconnecting
   */
  public connect(bossUrl: string, token: string, options: { sinceTs?: number } = {}): void {
    this.disconnect();
    this.bossUrl = bossUrl;
    this.token = token;
    this.sync = initialClientSyncState();
    this.freshSinceTs = typeof options.sinceTs === 'number' && Number.isFinite(options.sinceTs) && options.sinceTs > 0
      ? options.sinceTs
      : undefined;
    this.transports = [...WEBSOCKET_FIRST];
    this.connectErrorsInRow = 0;
    this.hasConnected = false;
    this.disconnectedAt = 0;
    this.manualAttempt = 0;
    this.stopped = false;
    this.open();
  }

  /** Creates a new socket with the current config, KEEPS the position (bootId + lastSeqId) for catch-up. */
  private open(): void {
    this.closeSocket();
    if (this.stopped || !this.bossUrl) return;

    Logger.log(`[SocketIOClient] Connecting to ${this.bossUrl} (${this.transports[0]} first)...`);

    const endpoint = socketEndpoint(this.bossUrl);
    const socket = socketIOClient(endpoint.url, {
      path: endpoint.path,
      auth: { token: this.token },
      // Prefer WebSocket, fall back to polling for tunnels / proxies that block the upgrade
      transports: [...this.transports],
      // engine.io-client 6.6: without this flag a WebSocket error gives up, without trying polling
      tryAllTransports: true,
      // Auto-reconnect (transport errors)
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      timeout: 20000,
      // Each open is a separate Manager: fully closed on a manual reconnect
      forceNew: true,
    });
    this.socket = socket;

    // ─── Connected ───────────────────────────────────────────────
    socket.on('connect', () => {
      if (this.socket !== socket) return;
      const gapMs = this.hasConnected && this.disconnectedAt ? Date.now() - this.disconnectedAt : undefined;
      this.hasConnected = true;
      this.disconnectedAt = 0;
      this.connectErrorsInRow = 0;
      this.manualAttempt = 0;
      const transport = (socket.io as any)?.engine?.transport?.name || '?';
      Logger.log(`[SocketIOClient] 🟢 Connected to ${this.bossUrl} (id=${socket.id}, transport=${transport}`
        + `${gapMs !== undefined ? `, mất kết nối ${Math.round(gapMs / 1000)}s` : ''})`);
      this.onStatusChange?.(true, gapMs !== undefined ? { gapMs } : undefined);

      // Catch-up: asks again for events missed while offline (Boss only replays the employee's own part; reset → resync)
      this.startCatchUp(socket, gapMs ?? 0);
    });

    // ─── Events from Boss ──────────────────────────────────────────
    socket.on('event', (payload: { seqId?: number; channel: string; data: any; bootId?: string }) => {
      if (this.socket !== socket) return;
      if (!payload || !payload.channel) return;

      // Track the position (bootId + seqId): events are always forwarded as before
      const tracked = trackEnvelope(this.sync, payload);
      this.sync = tracked.state;
      if (tracked.legacy) {
        this.noteLegacyBoss(socket, 'event không có bootId');
      } else if (tracked.streamChanged) {
        Logger.warn(`[SocketIOClient] Event thuộc luồng Boss khác (bootId=${payload.bootId}) — resync`);
        this.onResync?.('boss-restart', this.catchUp?.gapMs ?? 0);
      }

      // Forward to the handler (handlePushedEvent in HttpClientService)
      this.onEvent?.(payload.channel, payload.data);
    });

    // ─── seqId marks (employees with few events): old Boss builds do not send these ─────
    socket.on('seq', (watermark: unknown) => {
      if (this.socket !== socket) return;
      this.sync = trackWatermark(this.sync, watermark);
    });

    // ─── Disconnected ───────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return;
      if (!this.disconnectedAt) this.disconnectedAt = Date.now();
      // The ack of this connection will not arrive any more (Socket.IO dropped it): do not wait for the timeout and wrongly conclude "Boss cũ"
      this.clearCatchUp();
      Logger.log(`[SocketIOClient] 🔴 Disconnected from ${this.bossUrl}: ${reason}`);
      this.onStatusChange?.(false, { reason });
      // Boss disconnected on purpose → Socket.IO does not reconnect by itself
      if (reason === 'io server disconnect') this.scheduleManualReconnect('Boss ngắt kết nối');
    });

    // ─── Connect error ──────────────────────────────────────────
    socket.on('connect_error', (err: any) => {
      if (this.socket !== socket) return;
      if (!this.disconnectedAt) this.disconnectedAt = Date.now();
      const message = String(err?.message || err || 'connect_error');
      this.onStatusChange?.(false, { reason: message });

      if (!socket.active) {
        // Boss middleware rejected it (CONNECT_ERROR) → Socket.IO does not retry by itself.
        if (isAuthRejectionMessage(message)) {
          Logger.warn(`[SocketIOClient] Boss từ chối xác thực: ${message} — dừng kết nối lại, cần đăng nhập lại`);
          this.stop();
          this.onAuthRejected?.(message);
          return;
        }
        Logger.warn(`[SocketIOClient] Boss từ chối kết nối: ${message}`);
        this.scheduleManualReconnect(`Boss từ chối: ${message}`);
        return;
      }

      // Transport error → Socket.IO reconnects by itself. Only logs the first time + every 10 times so the log does not flood.
      this.connectErrorsInRow++;
      if (this.connectErrorsInRow === 1 || this.connectErrorsInRow % 10 === 0) {
        Logger.warn(`[SocketIOClient] Connection error (#${this.connectErrorsInRow}): ${message}`);
      }
      // WebSocket keeps hanging / being blocked → polling first (upgrade to WebSocket later if possible)
      if (this.connectErrorsInRow >= TRANSPORT_FALLBACK_AFTER_ERRORS && this.transports[0] === 'websocket') {
        this.transports = [...POLLING_FIRST];
        try { (socket.io.opts as any).transports = [...this.transports]; } catch { /* ignore */ }
        Logger.warn(`[SocketIOClient] WebSocket lỗi ${this.connectErrorsInRow} lần liên tiếp — chuyển sang HTTP long-polling trước`);
      }
    });

    // ─── Error ──────────────────────────────────────────────────
    socket.on('error', (err: any) => {
      Logger.warn(`[SocketIOClient] Error: ${err?.message || err}`);
    });
  }

  /** Schedules reopening the socket per SOCKET_RECONNECT_BACKOFF_MS (attempt resets on 'connect'). */
  private scheduleManualReconnect(reason: string): void {
    if (this.stopped || this.manualTimer) return;
    const delay = backoffDelay(this.manualAttempt, SOCKET_RECONNECT_BACKOFF_MS);
    this.manualAttempt++;
    Logger.log(`[SocketIOClient] Kết nối lại sau ${delay / 1000}s (lần ${this.manualAttempt}, ${reason})`);
    this.manualTimer = setTimeout(() => {
      this.manualTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearManualTimer(): void {
    if (this.manualTimer) {
      clearTimeout(this.manualTimer);
      this.manualTimer = null;
    }
  }

  // ─── Catch-up ──────────────────────────────────────────────────

  /**
   * Sends 'catch-up' { proto, lastSeqId, bootId, sinceTs? } with an ack. A new Boss replays the missed part first and only then acks
   * (the ack arrives AFTER the replayed events); an old Boss only reads lastSeqId and never acks.
   */
  private startCatchUp(socket: Socket, gapMs: number): void {
    this.clearCatchUp();
    const request = buildCatchUpRequest(this.sync, this.freshSinceTs);
    const pending: PendingCatchUp = {
      socket,
      timer: null,
      acked: false,
      hadPosition: request.lastSeqId > 0 || !!request.bootId,
      legacyHandled: false,
      gapMs,
    };
    this.catchUp = pending;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (this.socket !== socket || this.catchUp !== pending || pending.acked) return;
      this.handleLegacyBoss(pending, `không có phản hồi catch-up sau ${CATCH_UP_ACK_TIMEOUT_MS / 1000}s`);
    }, CATCH_UP_ACK_TIMEOUT_MS);
    socket.emit('catch-up', request, (result: unknown) => this.handleCatchUpResult(pending, result));
  }

  private handleCatchUpResult(pending: PendingCatchUp, result: unknown): void {
    // A late ack (after it was treated as an old Boss) still applies, as long as it is still the current socket
    if (this.socket !== pending.socket || this.catchUp !== pending) return;
    pending.acked = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const applied = applyCatchUpResult(this.sync, result);
    if (!applied.valid) {
      this.handleLegacyBoss(pending, 'ack catch-up không hợp lệ');
      return;
    }
    this.sync = applied.state;
    if (applied.resync) {
      Logger.warn(`[SocketIOClient] Catch-up: ${applied.resync === 'boss-restart' ? 'Boss đã khởi động lại' : 'Boss không còn đủ event để phát lại'}`
        + ` — bỏ phần đã lỡ, tải lại toàn bộ (seq=${applied.state.lastSeqId})`);
      this.onResync?.(applied.resync, pending.gapMs);
      return;
    }
    const replayed = Number((result as { replayed?: unknown } | null)?.replayed) || 0;
    if (replayed > 0) Logger.log(`[SocketIOClient] Catch-up: nhận lại ${replayed} event đã lỡ`);
  }

  /** An event without bootId while waiting for the ack → old Boss build (no need to wait for the timeout). */
  private noteLegacyBoss(socket: Socket, why: string): void {
    const pending = this.catchUp;
    if (!pending || pending.socket !== socket || pending.acked) return;
    this.handleLegacyBoss(pending, why);
  }

  /** Old Boss build: catch-up by seqId as before; on reconnect the missed part cannot be verified → resync. */
  private handleLegacyBoss(pending: PendingCatchUp, why: string): void {
    if (pending.legacyHandled) return;
    pending.legacyHandled = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    Logger.warn(`[SocketIOClient] Boss không xác nhận catch-up (${why}) — Boss bản cũ hoặc mạng chậm`
      + `${pending.hadPosition ? ': không kiểm chứng được phần đã lỡ → tải lại toàn bộ' : ''}`);
    if (pending.hadPosition) this.onResync?.('catchup-unverified', pending.gapMs);
  }

  private clearCatchUp(): void {
    const pending = this.catchUp;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    this.catchUp = null;
  }

  /** Closes the current socket (emits no event), does not change the stopped state. */
  private closeSocket(): void {
    this.clearCatchUp();
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    try {
      socket.removeAllListeners();
      socket.close();
    } catch { /* ignore */ }
  }

  /**
   * Cancels the pending backoff and reopens the socket right away (machine woke from sleep, network is back, heartbeat recovered).
   * Keeps the catch-up position → replays the missed part. Does nothing if already stopped (disconnect / session expired).
   */
  public reconnectNow(reason = 'manual'): void {
    if (this.stopped || !this.bossUrl) return;
    this.clearManualTimer();
    Logger.log(`[SocketIOClient] Kết nối lại ngay (${reason})`);
    this.open();
  }

  /** Stops completely (no automatic reconnect) but keeps the catch-up position: used when Boss rejects the token. */
  public stop(): void {
    this.stopped = true;
    this.clearManualTimer();
    this.closeSocket();
  }

  /**
   * Disconnect
   */
  public disconnect(): void {
    this.stop();
    this.sync = initialClientSyncState();
    this.freshSinceTs = undefined;
    this.hasConnected = false;
    this.disconnectedAt = 0;
    this.manualAttempt = 0;
    this.connectErrorsInRow = 0;
  }

  /**
   * Checks the connection state
   */
  public isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Connecting or retrying by itself (Socket.IO backoff / manual schedule); false if it gave up / stopped. */
  public isRecovering(): boolean {
    if (this.stopped) return false;
    return !!this.manualTimer || !!this.socket?.active;
  }

  // ─── Callbacks ────────────────────────────────────────────────

  public setOnEvent(cb: (channel: string, data: any) => void): void {
    this.onEvent = cb;
  }

  public setOnStatusChange(cb: (connected: boolean, info?: SocketStatusInfo) => void): void {
    this.onStatusChange = cb;
  }

  public setOnAuthRejected(cb: ((message: string) => void) | null): void {
    this.onAuthRejected = cb;
  }

  /** Catch-up could not replay the missed part (Boss restarted / buffer not large enough / old Boss) → resync needed. */
  public setOnResync(cb: ((reason: EmployeeResyncReason, gapMs: number) => void) | null): void {
    this.onResync = cb;
  }

  public setWorkspaceId(id: string): void {
    this.workspaceId = id;
  }

  /** Current catch-up position (diagnostics / log). */
  public getSyncState(): ClientSyncState {
    return { ...this.sync };
  }

  /** Resets the catch-up position (used when reconnecting everything): the next connection is a fresh one. */
  public resetSeqId(): void {
    this.sync = initialClientSyncState();
    this.freshSinceTs = undefined;
  }
}

export default SocketIOClient;
