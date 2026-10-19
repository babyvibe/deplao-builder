/**
 * SocketIOClient - Employee-side Socket.IO client.
 *
 * Replaces the SSE connection for real-time event delivery.
 * - Connects to Boss Socket.IO server (attach to same port, path /socket.io)
 * - Authenticates via JWT token (handshake.auth)
 * - Lỗi transport (mất mạng, Boss tắt): Socket.IO tự reconnect (backoff 1 s → 15 s)
 * - Boss TỪ CHỐI (middleware next(err)) hoặc chủ động ngắt ('io server disconnect'): Socket.IO
 *   KHÔNG tự thử lại → tự lên lịch theo SOCKET_RECONNECT_BACKOFF_MS (1/2/5/10/30 s…).
 *   Riêng lỗi xác thực (token hết hạn / sai, nhân viên bị khoá) → dừng hẳn và báo onAuthRejected
 *   (UI: "Phiên đăng nhập hết hạn — đăng nhập lại") thay vì lặp vô hạn.
 * - WebSocket bị chặn: tryAllTransports → rơi xuống HTTP long-polling ngay trong lần thử
 *   (engine.io-client 6.6 mặc định KHÔNG thử transport kế tiếp). WebSocket treo / lỗi 2 lần liên
 *   tiếp → đổi sang polling-first (polling rồi upgrade WebSocket nếu được).
 * - Catch-up (catchUpProtocol.ts): lưu { bootId, lastSeqId } của luồng Boss; mỗi lần nối gửi 'catch-up' + ack.
 *   Boss trả reset (khởi động lại — bootId khác / buffer không phủ đủ) → nhảy tới seqId hiện tại của Boss và báo
 *   onResync ('boss-restart' / 'catchup-gap'). Boss bản cũ (không bootId, không ack) → như cũ, kết nối lại thì
 *   resync cho chắc ('catchup-unverified').
 * - Forwards received events to the onEvent handler (HttpClientService.handlePushedEvent)
 *
 * Integration:
 *   HttpClientService.connect() → this.connect(bossUrl, token, { sinceTs })
 *   HttpClientService.disconnect() → this.disconnect()
 *   HttpClientService.handleWake() / heartbeat hồi phục → this.reconnectNow()
 */
import { io as socketIOClient, Socket } from 'socket.io-client';
import Logger from '../../utils/Logger';
import {
  backoffDelay,
  isAuthRejectionMessage,
  SOCKET_RECONNECT_BACKOFF_MS,
  type EmployeeResyncReason,
} from '../../shared/employeeConnection';
import {
  applyCatchUpResult,
  buildCatchUpRequest,
  CATCH_UP_ACK_TIMEOUT_MS,
  initialClientSyncState,
  trackEnvelope,
  trackWatermark,
  type ClientSyncState,
} from './catchUpProtocol';

/** Catch-up của MỘT lần nối (một socket). */
interface PendingCatchUp {
  socket: Socket;
  timer: ReturnType<typeof setTimeout> | null;
  acked: boolean;
  /** Yêu cầu có vị trí cũ (kết nối lại) — Boss cũ không kiểm chứng được thì resync. */
  hadPosition: boolean;
  legacyHandled: boolean;
  /** ms mất kết nối trước lần nối này (0 nếu không đo được) — kèm theo resync. */
  gapMs: number;
}

export interface SocketStatusInfo {
  /** ms mất kết nối trước lần 'connect' này — chỉ có khi là kết nối LẠI (đã từng nối trước đó). */
  gapMs?: number;
  /** Lý do 'disconnect' / thông điệp 'connect_error'. */
  reason?: string;
}

const WEBSOCKET_FIRST = ['websocket', 'polling'];
const POLLING_FIRST = ['polling', 'websocket'];
/** Số lỗi kết nối liên tiếp (WebSocket-first) trước khi chuyển sang polling-first. */
const TRANSPORT_FALLBACK_AFTER_ERRORS = 2;

/**
 * io(url) coi phần path của URL là NAMESPACE → Boss URL có sub-path (tunnel / reverse proxy
 * https://host/boss) sẽ bị từ chối "Invalid namespace". Kết nối tới origin, gộp sub-path vào `path`.
 * URL không có sub-path → giữ nguyên như cũ (origin + /socket.io).
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

  /** Vị trí catch-up: luồng Boss (bootId) + seqId cuối cùng đã nhận trong luồng đó. */
  private sync: ClientSyncState = initialClientSyncState();
  /** Giờ Boss (ms) lúc đăng ký qua heartbeat — lần nối ĐẦU xin phát lại event từ đây (phủ khe tải REST ↔ vào phòng). */
  private freshSinceTs: number | undefined;
  private catchUp: PendingCatchUp | null = null;

  /** Thứ tự transport cho lần mở kế tiếp (đổi sang polling-first khi WebSocket không qua được). */
  private transports: string[] = [...WEBSOCKET_FIRST];
  private connectErrorsInRow = 0;
  /** Đã từng 'connect' thành công với cấu hình hiện tại → các lần sau là kết nối lại. */
  private hasConnected = false;
  /** Thời điểm bắt đầu mất kết nối (0 = đang nối / chưa mất). */
  private disconnectedAt = 0;

  /** Reconnect thủ công (sau khi Boss từ chối / ngắt) — Socket.IO không tự làm. */
  private manualAttempt = 0;
  private manualTimer: ReturnType<typeof setTimeout> | null = null;
  /** true = không tự kết nối lại (chưa connect, đã disconnect, hoặc bị từ chối xác thực). */
  private stopped = true;

  /** Callback khi nhận event từ Boss */
  private onEvent: ((channel: string, data: any) => void) | null = null;
  /** Callback khi trạng thái kết nối thay đổi */
  private onStatusChange: ((connected: boolean, info?: SocketStatusInfo) => void) | null = null;
  /** Callback khi Boss từ chối token — cần đăng nhập lại, client đã dừng. */
  private onAuthRejected: ((message: string) => void) | null = null;
  /** Callback khi catch-up không phát lại được phần đã lỡ → cần tải lại toàn bộ (employee:resync). */
  private onResync: ((reason: EmployeeResyncReason, gapMs: number) => void) | null = null;

  /**
   * Kết nối (mới) đến Boss Socket.IO server — reset vị trí catch-up, thứ tự transport và lịch backoff.
   * `sinceTs` = giờ Boss lúc đăng ký (ts của heartbeat) — lần nối đầu chỉ xin phát lại event từ thời điểm này.
   * Socket.IO tự động:
   * - Ping/pong để phát hiện mất kết nối
   * - Auto-reconnect với exponential backoff khi lỗi transport
   * - Buffer events trong quá trình reconnect
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

  /** Tạo socket mới với cấu hình hiện tại — GIỮ vị trí (bootId + lastSeqId) để catch-up. */
  private open(): void {
    this.closeSocket();
    if (this.stopped || !this.bossUrl) return;

    Logger.log(`[SocketIOClient] Connecting to ${this.bossUrl} (${this.transports[0]} first)...`);

    const endpoint = socketEndpoint(this.bossUrl);
    const socket = socketIOClient(endpoint.url, {
      path: endpoint.path,
      auth: { token: this.token },
      // Ưu tiên WebSocket, fallback polling cho tunnel / proxy chặn upgrade
      transports: [...this.transports],
      // engine.io-client 6.6: thiếu cờ này thì WebSocket lỗi là bỏ cuộc, không thử polling
      tryAllTransports: true,
      // Auto-reconnect (lỗi transport)
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      timeout: 20000,
      // Mỗi lần mở là một Manager riêng — đóng sạch khi reconnect thủ công
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

      // Catch-up: xin lại event đã lỡ khi offline (Boss chỉ phát lại phần của mình; reset → resync)
      this.startCatchUp(socket, gapMs ?? 0);
    });

    // ─── Event từ Boss ──────────────────────────────────────────
    socket.on('event', (payload: { seqId?: number; channel: string; data: any; bootId?: string }) => {
      if (this.socket !== socket) return;
      if (!payload || !payload.channel) return;

      // Theo dõi vị trí (bootId + seqId) — event luôn được chuyển tiếp như cũ
      const tracked = trackEnvelope(this.sync, payload);
      this.sync = tracked.state;
      if (tracked.legacy) {
        this.noteLegacyBoss(socket, 'event không có bootId');
      } else if (tracked.streamChanged) {
        Logger.warn(`[SocketIOClient] Event thuộc luồng Boss khác (bootId=${payload.bootId}) — resync`);
        this.onResync?.('boss-restart', this.catchUp?.gapMs ?? 0);
      }

      // Forward đến handler (handlePushedEvent trong HttpClientService)
      this.onEvent?.(payload.channel, payload.data);
    });

    // ─── Mốc seqId (nhân viên ít event) — Boss cũ không gửi ─────
    socket.on('seq', (watermark: unknown) => {
      if (this.socket !== socket) return;
      this.sync = trackWatermark(this.sync, watermark);
    });

    // ─── Disconnected ───────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return;
      if (!this.disconnectedAt) this.disconnectedAt = Date.now();
      // Ack của lần nối này sẽ không đến nữa (Socket.IO bỏ) — đừng để hết giờ rồi kết luận nhầm "Boss cũ"
      this.clearCatchUp();
      Logger.log(`[SocketIOClient] 🔴 Disconnected from ${this.bossUrl}: ${reason}`);
      this.onStatusChange?.(false, { reason });
      // Boss chủ động ngắt → Socket.IO không tự reconnect
      if (reason === 'io server disconnect') this.scheduleManualReconnect('Boss ngắt kết nối');
    });

    // ─── Connect error ──────────────────────────────────────────
    socket.on('connect_error', (err: any) => {
      if (this.socket !== socket) return;
      if (!this.disconnectedAt) this.disconnectedAt = Date.now();
      const message = String(err?.message || err || 'connect_error');
      this.onStatusChange?.(false, { reason: message });

      if (!socket.active) {
        // Middleware của Boss từ chối (CONNECT_ERROR) → Socket.IO không tự thử lại.
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

      // Lỗi transport → Socket.IO tự reconnect. Chỉ log lần đầu + mỗi 10 lần để Nhật ký không ngập.
      this.connectErrorsInRow++;
      if (this.connectErrorsInRow === 1 || this.connectErrorsInRow % 10 === 0) {
        Logger.warn(`[SocketIOClient] Connection error (#${this.connectErrorsInRow}): ${message}`);
      }
      // WebSocket treo / bị chặn liên tục → polling trước (upgrade WebSocket sau nếu được)
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

  /** Lên lịch mở lại socket theo SOCKET_RECONNECT_BACKOFF_MS (attempt reset khi 'connect'). */
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
   * Gửi 'catch-up' { proto, lastSeqId, bootId, sinceTs? } kèm ack. Boss mới phát lại phần đã lỡ rồi mới ack
   * (ack đến SAU event phát lại); Boss cũ chỉ đọc lastSeqId và không bao giờ ack.
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
    // Ack muộn (sau khi đã coi là Boss cũ) vẫn áp dụng — miễn còn là socket hiện tại
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

  /** Event không có bootId trong lúc chờ ack → Boss bản cũ (không cần chờ hết giờ). */
  private noteLegacyBoss(socket: Socket, why: string): void {
    const pending = this.catchUp;
    if (!pending || pending.socket !== socket || pending.acked) return;
    this.handleLegacyBoss(pending, why);
  }

  /** Boss bản cũ: catch-up theo seqId như trước; kết nối lại thì không kiểm chứng được phần đã lỡ → resync. */
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

  /** Đóng socket hiện tại (không phát event) — không đổi trạng thái stopped. */
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
   * Bỏ backoff đang chờ và mở lại socket ngay (máy ngủ dậy, mạng có lại, heartbeat hồi phục).
   * Giữ vị trí catch-up → phát lại phần đã lỡ. Không làm gì nếu đã dừng (disconnect / hết hạn phiên).
   */
  public reconnectNow(reason = 'manual'): void {
    if (this.stopped || !this.bossUrl) return;
    this.clearManualTimer();
    Logger.log(`[SocketIOClient] Kết nối lại ngay (${reason})`);
    this.open();
  }

  /** Dừng hẳn (không tự kết nối lại) nhưng giữ vị trí catch-up — dùng khi Boss từ chối token. */
  public stop(): void {
    this.stopped = true;
    this.clearManualTimer();
    this.closeSocket();
  }

  /**
   * Ngắt kết nối
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
   * Kiểm tra trạng thái kết nối
   */
  public isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Đang nối hoặc đang tự thử lại (Socket.IO backoff / lịch thủ công) — false nếu đã bỏ cuộc / dừng. */
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

  /** Catch-up không phát lại được phần đã lỡ (Boss khởi động lại / buffer không đủ / Boss cũ) → cần resync. */
  public setOnResync(cb: ((reason: EmployeeResyncReason, gapMs: number) => void) | null): void {
    this.onResync = cb;
  }

  public setWorkspaceId(id: string): void {
    this.workspaceId = id;
  }

  /** Vị trí catch-up hiện tại (chẩn đoán / log). */
  public getSyncState(): ClientSyncState {
    return { ...this.sync };
  }

  /** Reset vị trí catch-up (dùng khi reconnect toàn bộ) — lần nối sau là kết nối mới. */
  public resetSeqId(): void {
    this.sync = initialClientSyncState();
    this.freshSinceTs = undefined;
  }
}

export default SocketIOClient;
