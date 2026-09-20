/**
 * FacebookE2EEBridge.ts
 * Port từ Python _BridgeProcess class trong fbchat-v2 _listening_e2ee.py
 *
 * Quản lý Go bridge binary (fbchat-bridge-e2ee) qua child_process.spawn.
 * Giao tiếp qua JSON-RPC line-delimited stdin/stdout.
 *
 * Go bridge xử lý TOÀN BỘ crypto (Signal Protocol + Meta Labyrinth).
 * TypeScript layer chỉ quản lý process lifecycle + serialize/deserialize JSON-RPC.
 *
 * ── BUILD GO BRIDGE ─────────────────────────────────────────────────────────────
 * 1. Tạo thư mục bridge-e2ee/ ở project root:
 *    mkdir bridge-e2ee
 *    cd bridge-e2ee
 *
 * 2. Clone mautrix/meta (thư viện Go của Meta Messenger protocol):
 *    git clone https://github.com/mautrix/meta
 *    cd meta
 *
 * 3. Build binary:
 *    go mod tidy
 *    go build -o ../build/fbchat-bridge-e2ee.exe .
 *    cd ../..
 *
 * 4. Hoặc set biến môi trường để trỏ tới binary đã build sẵn:
 *    set FBCHAT_E2EE_BIN=C:\path\to\fbchat-bridge-e2ee.exe
 *
 * Yêu cầu: Go 1.24+, RAM ~300MB cho lần build đầu (Go module cache)
 * Binary sau build ~25-40MB, RAM runtime ~80-150MB.
 *
 * ── COOKIE ───────────────────────────────────────────────────────────────────────
 * Bridge cần Facebook cookie chứa ít nhất c_user + xs.
 * Các cookie khác (datr, fr, sb) là optional.
 * wd, presence là ephemeral do JavaScript set - KHÔNG cần.
 *
 * Tham khảo: https://github.com/m008v/fbchat-v2
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { FBJsonRpcEvent } from './FacebookTypes';
import { metricInc } from './FacebookMetrics';
import Logger from '../../utils/Logger';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Bridge protocol version we support */
const REQUIRED_PROTOCOL_VERSION = 2;

/** Allowed bridge versions (semver prefix match) */
const ALLOWED_BRIDGE_VERSIONS = ['2.3.1'];

/** Max single JSON frame size (encoded) — 40 MiB */
const MAX_JSON_FRAME_BYTES = 40 * 1024 * 1024;

/** Max decoded media bytes we accept from bridge */
const MAX_DECODED_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * Các bridge methods được hỗ trợ.
 * Tham chiếu: bridge-e2ee/main.go `handle()` switch statement.
 */
export const BRIDGE_METHODS = [
  'hello',
  'newClient',
  'connect',
  'connectE2EE',
  'isConnected',
  'disconnect',
  'sendMessage',
  'sendE2EEMessage',
  'sendE2EEReaction',
  'sendE2EESticker',
  'sendE2EEVideo',
  'sendE2EEAudio',
  'sendE2EEImage',
  'sendE2EEDocument',
  'downloadE2EEAttachment',
  'sendReaction',
  'sendImage',
  'sendFile',
  'sendTypingIndicator',
  'sendE2EETyping',
  'markRead',
  'editMessage',
  'unsendMessage',
  'editE2EEMessage',
  'unsendE2EEMessage',
  'startNativeLogin',
  'submitNativeLogin',
  'cancelNativeLogin',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BridgeHello {
  protocolVersion: number;
  bridgeVersion: string;
  capabilities: string[];
  maxDecodedMediaBytes: number;
}

export interface NativeLoginField {
  id: string;
  name: string;
  description?: string;
  type: 'username' | 'password' | 'phone_number' | 'email' | '2fa_code' | 'token' | 'url' | 'domain' | 'select' | 'captcha_code' | string;
  default_value?: string;
  pattern?: string;
  min_length?: number;
  max_length?: number;
  options?: string[];
}

export interface NativeLoginStep {
  type: 'user_input' | 'display_and_wait' | string;
  step_id: string;
  instructions: string;
  user_input?: {
    fields: NativeLoginField[];
    attachments?: Array<{ content?: string; info?: { mimetype?: string } }>;
  };
  display_and_wait?: { can_cancel?: boolean };
}

export interface NativeLoginResult {
  complete: boolean;
  step?: NativeLoginStep;
  cookies?: Record<string, string>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

export class BridgeNotReadyError extends BridgeError {
  constructor() {
    super('E2EE bridge chưa được khởi tạo - gọi connect() trước.');
    this.name = 'BridgeNotReadyError';
  }
}

export class BridgeHandshakeError extends BridgeError {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeHandshakeError';
  }
}

// ─── Main Class ───────────────────────────────────────────────────────────────

export interface BridgeEvents {
  event: (evt: FBJsonRpcEvent['event']) => void;
  closed: (code: number | null) => void;
  error: (err: Error) => void;
}

export class FacebookE2EEBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private binaryPath: string;
  private pending = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>();
  private idCounter = 1;
  private closed = false;
  /** Close is in progress: reject new work but still permit the final disconnect RPC. */
  private closing = false;
  private buffer = '';
  /** Generation counter — incremented on each spawn. Stale responses from old generation are discarded. */
  private generation = 0;
  /** Serial write queue — ensures stdin.write() calls are serialized */
  private writeQueue: Array<(done: () => void) => void> = [];
  private writing = false;
  /** Validated hello response from bridge */
  private helloData: BridgeHello | null = null;

  // ─── Static helpers ────────────────────────────────────────────────────────
  // Bridge Go struct expects threadId as int64, not string.
  // Facebook thread IDs là số, parse sang number để JSON serialize đúng.
  private static toIntThreadId(threadId: string): number {
    const n = parseInt(String(threadId), 10);
    return isNaN(n) ? (threadId as any) : n;
  }

  // ─── Static Init ───────────────────────────────────────────────────────────
  // TypeScript 5.9+ strict check: EventEmitter constructor(options?) conflicts
  // với constructor(binaryPath). Dùng builder pattern để tránh.
  static create(binaryPath: string): FacebookE2EEBridge {
    const bridge = new FacebookE2EEBridge();
    bridge.binaryPath = binaryPath;
    return bridge;
  }

  // Private constructor - chỉ dùng qua create() để tránh TS 5.9 EventEmitter conflict
  private constructor() { super(); }


  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Khởi động Go bridge child process và reader loop.
   */
  public spawn(): void {
    // Cho phép spawn mới nếu process cũ đã bị kill hoặc null
    if (this.process && !this.process.killed) {
      Logger.warn('[FBE2EEBridge] Already spawned with alive process');
      return;
    }
    // Cleanup process cũ đã chết
    if (this.process) {
      this.process.removeAllListeners();
      this.process = null;
    }

    // Increment generation — stale responses/events from old gen are discarded
    this.generation++;
    this.helloData = null;
    this.idCounter = 1;
    this.pending.clear();
    this.buffer = '';
    this.closing = false;

    Logger.log(`[FBE2EEBridge] Spawning: ${this.binaryPath} (gen=${this.generation})`);

    this.process = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.closed = false;
    const spawnedProcess = this.process;
    const spawnedGeneration = this.generation;

    // ─── Stdout reader (brace-counting JSON parser) ─────────────────────
    //
    // Không dùng split('\n') vì Windows pipe có thể chunk data ở bất kỳ
    // vị trí nào - kể cả giữa JSON value. Split theo \n sẽ cắt hỏng JSON
    // nếu chunk boundary không trùng với \n boundary.
    //
    // Giải pháp: đếm { và } (đúng chuẩn JSON string escape) để tách
    // các JSON objects hoàn chỉnh, bất kể chunk boundary ở đâu.
    //
    this.process.stdout?.on('data', (chunk: Buffer) => {
      if (this.process !== spawnedProcess || this.generation !== spawnedGeneration) return;
      this.buffer += chunk.toString('utf8');
      // Cap buffer at 40MB — MAX_JSON_FRAME_BYTES is the hard limit per frame.
      // Bridge errors could produce unbounded output → OOM.
      if (this.buffer.length > MAX_JSON_FRAME_BYTES) {
        Logger.warn(`[FBE2EEBridge] Buffer exceeded ${MAX_JSON_FRAME_BYTES} bytes; closing bridge`);
        this.buffer = '';
        // Reject all pending. The service receives `closed` and owns restart/backoff.
        for (const [, p] of this.pending) {
          p.reject(new BridgeError('Buffer overflow'));
        }
        this.pending.clear();
        void this.close();
        return;
      }

      let depth = 0;
      let start = -1;
      let inString = false;
      let escaped = false;

      for (let i = 0; i < this.buffer.length; i++) {
        const ch = this.buffer[i];

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === '{') {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0 && start >= 0) {
            // Complete JSON object found
            const jsonStr = this.buffer.slice(start, i + 1);
            try {
              const msg = JSON.parse(jsonStr);
              this.processMessage(msg, spawnedGeneration);
              // Remove processed content - keep remaining buffer
              this.buffer = this.buffer.slice(i + 1);
              // Reset loop state for the rest of the buffer
              depth = 0;
              start = -1;
              inString = false;
              escaped = false;
              i = -1; // loop increments to 0, restart scan from buffer start
              continue;
            } catch {
              // False positive: } xuat hien ngoai string context
              // KHONG discard buffer - keep for next chunk
              Logger.warn(`[FBE2EEBridge] Invalid/incomplete JSON frame (offset=${i}, buffer=${this.buffer.length}b)`);
              break;
            }
          }
        }
      }

      // Keep incomplete data (after last complete JSON) in buffer
      if (start >= 0) {
        this.buffer = this.buffer.slice(start);
      } else if (this.buffer.length > 0 && depth === 0) {
        // All JSONs processed, buffer contains only trailing text
        this.buffer = '';
      }
    });

    // ─── Stdout end → bridge exited ─────────────────────────────────────
    this.process.stdout?.on('end', () => {
      if (this.process !== spawnedProcess || this.generation !== spawnedGeneration) return;
      Logger.log('[FBE2EEBridge] stdout ended');
      // Drain any remaining data in buffer
      if (this.buffer.trim()) {
        try {
          const msg = JSON.parse(this.buffer.trim());
          this.processMessage(msg, spawnedGeneration);
        } catch { /* ignore - incomplete */ }
        this.buffer = '';
      }
      this.onProcessExited(spawnedProcess?.exitCode ?? null, spawnedGeneration, spawnedProcess);
    });

    // ─── Stderr forward (debug + file) ────────────────────────────────
    this.process.stderr?.on('data', (chunk: Buffer) => {
      if (this.process !== spawnedProcess || this.generation !== spawnedGeneration) return;
      const text = chunk.toString('utf8').trim();
      if (text) {
        Logger.log(`[FBE2EEBridge:stderr] ${text.length} bytes`);
      }
    });

    // ─── Process exit ──────────────────────────────────────────────────
    this.process.on('exit', (code) => {
      if (this.process !== spawnedProcess || this.generation !== spawnedGeneration) return;
      Logger.log(`[FBE2EEBridge] Process exited with code ${code}`);
      this.onProcessExited(code, spawnedGeneration, spawnedProcess);
    });

    this.process.on('error', (err) => {
      if (this.process !== spawnedProcess || this.generation !== spawnedGeneration) return;
      Logger.error(`[FBE2EEBridge] Process error: ${err.message}`);
      this.emit('error', err);
      this.onProcessExited(null, spawnedGeneration, spawnedProcess);
    });
  }

  /**
   * Đọc từng message từ stdout → phân loại response vs event
   */
  private processMessage(msg: any, generation: number): void {
    if (generation !== this.generation) {
      metricInc('fb_bridge_generation_stale_event');
      return;
    }
    // Async event (has `event` key, no `id`)
    if (msg.event) {
      const evt = msg as FBJsonRpcEvent;
      this.emit('event', evt.event);
      return;
    }

    // Response (has `id` key)
    if (typeof msg.id === 'number') {
      const id = msg.id;
      const pending = this.pending.get(id);
      if (!pending) {
        Logger.warn(`[FBE2EEBridge] No pending request for id=${id}`);
        return;
      }
      this.pending.delete(id);

      if (msg.ok === true) {
        pending.resolve(msg.data ?? {});
      } else {
        pending.reject(new BridgeError(msg.error || 'Unknown bridge error'));
      }
      return;
    }

    Logger.warn(`[FBE2EEBridge] Unknown message format (keys=${Object.keys(msg || {}).slice(0, 8).join(',')})`);
  }

  private onProcessExited(code: number | null, generation: number, process: ChildProcess | null): void {
    if (generation !== this.generation || process !== this.process) return;
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    this.process = null;
    this.writeQueue = [];
    this.writing = false;

    // Drain tất cả pending requests - bridge đã chết
    for (const [, pending] of this.pending) {
      pending.reject(new BridgeError(`Bridge exited (code=${code})`));
    }
    this.pending.clear();

    this.emit('closed', code);
  }

  // ─── JSON-RPC Call ────────────────────────────────────────────────────────

  /**
   * Gửi một JSON-RPC request đến Go bridge và chờ response.
   * Port từ Python `_BridgeProcess.call()`
   *
   * @param method  Tên method (phải match case trong main.go)
   * @param params  Parameters object (serialized as JSON)
   * @param timeout Timeout ms (default 120s)
   * @returns Response data từ bridge
   * @throws BridgeError nếu bridge trả lỗi hoặc timeout
   */
  public async call(
    method: BridgeMethod | string,
    params?: any,
    timeout: number = 120000,
  ): Promise<any> {
    if (this.closed || (this.closing && method !== 'disconnect') || !this.process || this.process.killed) {
      throw new BridgeNotReadyError();
    }

    const id = this.idCounter++;
    const gen = this.generation;
    const processAtCall = this.process;
    const request = { id, method, ...(params !== undefined ? { params } : {}) };

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`Bridge call timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pending.set(id, {
        resolve: (data: any) => {
          // Generation check: discard response from old generation
          if (gen !== this.generation) {
            metricInc('fb_bridge_generation_stale_event');
            Logger.warn(`[FBE2EEBridge] Stale response gen=${gen} current=${this.generation} method=${method} - discarding`);
            return;
          }
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err: Error) => {
          if (gen !== this.generation) return;
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        // Serial write queue — serialize stdin.write to prevent interleaving
        this.enqueueWrite((done) => {
          if (this.closed || this.process !== processAtCall || !processAtCall || processAtCall.killed) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new BridgeNotReadyError());
            done();
            return;
          }
          if (!processAtCall.stdin) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new BridgeNotReadyError());
            done();
            return;
          }
          const line = JSON.stringify(request) + '\n';
          processAtCall.stdin.write(line, 'utf8', (err) => {
            if (err) {
              clearTimeout(timer);
              this.pending.delete(id);
              reject(new BridgeError(`Bridge stdin write error: ${err.message}`));
            }
            done();
          });
        });
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError(`Bridge call serialization error: ${err.message}`));
      }
    });
  }

  /**
   * Serialize stdin.write() calls through a queue.
   * Prevents interleaving when multiple call() happen concurrently.
   */
  private enqueueWrite(fn: (done: () => void) => void): void {
    this.writeQueue.push(fn);
    if (!this.writing) {
      this.drainWriteQueue();
    }
  }

  private drainWriteQueue(): void {
    if (this.writeQueue.length === 0) {
      this.writing = false;
      return;
    }
    this.writing = true;
    const next = this.writeQueue.shift()!;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.drainWriteQueue();
    };
    try {
      next(done);
    } catch {
      done();
    }
  }

  // ─── Hello Handshake ────────────────────────────────────────────────────────

  /**
   * Phase 2: Hello handshake — call BEFORE newClient.
   * Validates protocol version, bridge version, capabilities, and limits.
   * Must be called after spawn() and before newClient().
   * @throws BridgeHandshakeError if hello fails or bridge is incompatible
   */
  public async hello(timeout: number = 10000): Promise<BridgeHello> {
    const data = await this.call('hello', undefined, timeout);

    // Validate required fields
    if (!data || typeof data !== 'object') {
      throw new BridgeHandshakeError('Hello returned invalid data');
    }

    const hello: BridgeHello = {
      protocolVersion: data.protocolVersion ?? 0,
      bridgeVersion: data.bridgeVersion ?? 'unknown',
      capabilities: data.capabilities ?? [],
      maxDecodedMediaBytes: data.maxDecodedMediaBytes ?? 0,
    };

    // Validate protocol version
    if (hello.protocolVersion !== REQUIRED_PROTOCOL_VERSION) {
      throw new BridgeHandshakeError(
        `Incompatible protocol version: bridge=${hello.protocolVersion} required=${REQUIRED_PROTOCOL_VERSION}`
      );
    }

    // Validate bridge version
    if (!ALLOWED_BRIDGE_VERSIONS.some(v => hello.bridgeVersion.startsWith(v))) {
      throw new BridgeHandshakeError(
        `Unknown bridge version: ${hello.bridgeVersion} (allowed: ${ALLOWED_BRIDGE_VERSIONS.join(', ')})`
      );
    }

    // Validate capabilities
    const requiredCaps = [
      'connectE2EE', 'sendMessage', 'sendE2EEMessage', 'mediaLocalPath',
      'sendTypingIndicator', 'sendE2EETyping', 'markRead',
      'editMessage', 'unsendMessage', 'editE2EEMessage', 'unsendE2EEMessage',
    ];
    const missing = requiredCaps.filter(c => !hello.capabilities.includes(c));
    if (missing.length > 0) {
      throw new BridgeHandshakeError(
        `Missing required capabilities: ${missing.join(', ')}`
      );
    }

    // Validate media limit
    if (hello.maxDecodedMediaBytes > 0 && hello.maxDecodedMediaBytes !== MAX_DECODED_MEDIA_BYTES) {
      Logger.warn(`[FBE2EEBridge] Bridge maxDecodedMediaBytes=${hello.maxDecodedMediaBytes} != expected=${MAX_DECODED_MEDIA_BYTES}`);
    }

    this.helloData = hello;
    Logger.log(`[FBE2EEBridge] Hello OK: protocol=${hello.protocolVersion} version=${hello.bridgeVersion} caps=${hello.capabilities.join(',')}`);
    return hello;
  }

  /** Get validated hello data (null if hello not yet called) */
  public getHello(): BridgeHello | null {
    return this.helloData;
  }

  // ─── Connection Sequence ──────────────────────────────────────────────────

  /**
   * Khởi tạo client mới trong bridge
   */
  public async newClient(config: {
    cookies: Record<string, string>;
    platform?: string;
    logLevel?: string;
    e2eeMemoryOnly?: boolean;
    devicePath?: string;
    deviceData?: string;
  }, timeout: number = 30000): Promise<{ deviceData?: string }> {
    return this.call('newClient', {
      cookies: config.cookies,
      platform: config.platform || 'facebook',
      logLevel: config.logLevel || 'none',
      e2eeMemoryOnly: config.e2eeMemoryOnly ?? true,
      ...(config.devicePath ? { devicePath: config.devicePath } : {}),
      ...(config.deviceData ? { deviceData: config.deviceData } : {}),
    }, timeout);
  }

  /** Start fbchat-v2's interactive Messenger Lite credential login flow. */
  public async startNativeLogin(proxyUrl?: string): Promise<NativeLoginResult> {
    return this.call('startNativeLogin', proxyUrl ? { proxyUrl } : {}, 120000);
  }

  /** Submit only the fields requested by the last native login step. */
  public async submitNativeLogin(input: Record<string, string>): Promise<NativeLoginResult> {
    return this.call('submitNativeLogin', { input }, 120000);
  }

  public async cancelNativeLogin(): Promise<void> {
    await this.call('cancelNativeLogin', {}, 5000);
  }

  /**
   * Login handshake (non-E2EE)
   * Bridge may respond with { ok: true } without data - handle gracefully.
   * @returns User info (id, name) or empty if not provided
   */
  public async connect(timeout: number = 120000): Promise<{ user?: { id: string; name?: string } }> {
    const result = await this.call('connect', undefined, timeout);
    // Bridge may respond with just { ok: true } and no data field
    return (result as any) || {};
  }

  /**
   * E2EE identity pairing
   */
  public async connectE2EE(timeout: number = 60000): Promise<void> {
    await this.call('connectE2EE', undefined, timeout);
  }

  /**
   * Kiểm tra trạng thái kết nối
   */
  public async isConnected(): Promise<{ connected: boolean; e2eeConnected: boolean }> {
    return this.call('isConnected');
  }

  /**
   * Gửi tin nhắn E2EE mã hóa
   */
  public async sendE2EEMessage(params: {
    chatJid: string;
    text: string;
    replyToId?: string;
    replyToSenderJid?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendE2EEMessage', {
      chatJid: params.chatJid,
      text: params.text,
      replyToId: params.replyToId || '',
      replyToSenderJid: params.replyToSenderJid || '',
    });
  }

  /**
   * Gửi reaction cho tin nhắn E2EE 1:1
   */
  public async sendE2EEReaction(params: {
    chatJid: string;
    messageId: string;
    senderJid: string;
    emoji: string;
  }): Promise<any> {
    return this.call('sendE2EEReaction', {
      chatJid: params.chatJid,
      messageId: params.messageId,
      senderJid: params.senderJid || '',
      emoji: params.emoji,
    });
  }

  /**
   * Gửi sticker trong chat E2EE 1:1
   */
  public async sendE2EESticker(params: {
    chatJid: string;
    stickerId: string;
  }): Promise<any> {
    return this.call('sendE2EESticker', params);
  }

  /**
   * Gửi ảnh qua E2EE 1:1
   */
  public async sendE2EEImage(params: {
    chatJid: string;
    imagePath: string;
    caption?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendE2EEImage', {
      chatJid: params.chatJid,
      imagePath: params.imagePath,
      caption: params.caption || '',
    });
  }

  /**
   * Gửi video qua E2EE 1:1
   */
  public async sendE2EEVideo(params: {
    chatJid: string;
    videoPath: string;
    caption?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendE2EEVideo', {
      chatJid: params.chatJid,
      videoPath: params.videoPath,
      caption: params.caption || '',
    });
  }

  /**
   * Gửi audio qua E2EE 1:1
   */
  public async sendE2EEAudio(params: {
    chatJid: string;
    audioPath: string;
    mimeType?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendE2EEAudio', {
      chatJid: params.chatJid,
      audioPath: params.audioPath,
      mimeType: params.mimeType || '',
    });
  }

  /**
   * Gửi tài liệu/file qua E2EE 1:1
   */
  public async sendE2EEDocument(params: {
    chatJid: string;
    filePath: string;
    fileName?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendE2EEDocument', {
      chatJid: params.chatJid,
      filePath: params.filePath,
      fileName: params.fileName || '',
    });
  }

  /**
   * Tải xuống và giải mã E2EE media attachment (ảnh/video/audio/file)
   * Trả về bytes đã giải mã dưới dạng base64
   */
  public async downloadE2EEAttachment(params: {
    directPath: string;
    mediaKey: string;
    mediaSha256: string;
    mediaEncSha256: string;
    mediaType: string;
    mimeType: string;
    fileSize: number;
  }): Promise<{ data: string; mimeType: string; fileSize: number }> {
    return this.call('downloadE2EEAttachment', params);
  }

  /**
   * Gửi tin nhắn text vào group (non-E2EE)
   */
  public async sendMessage(params: {
    threadId: string;
    text: string;
    replyToId?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendMessage', {
      threadId: FacebookE2EEBridge.toIntThreadId(params.threadId),
      text: params.text,
      replyToId: params.replyToId || '',
    });
  }

  /**
   * Gửi reaction vào group (non-E2EE)
   */
  public async sendReaction(params: {
    threadId: string;
    messageId: string;
    emoji: string;
  }): Promise<any> {
    return this.call('sendReaction', {
      threadId: FacebookE2EEBridge.toIntThreadId(params.threadId),
      messageId: params.messageId,
      emoji: params.emoji,
    });
  }

  /**
   * Gửi ảnh vào group (non-E2EE)
   */
  public async sendImage(params: {
    threadId: string;
    imagePath: string;
    caption?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendImage', {
      threadId: FacebookE2EEBridge.toIntThreadId(params.threadId),
      imagePath: params.imagePath,
      caption: params.caption || '',
    });
  }

  /**
   * Gửi file vào group (non-E2EE)
   */
  public async sendFile(params: {
    threadId: string;
    filePath: string;
    fileName?: string;
  }): Promise<{ messageId?: string; timestampMs?: number }> {
    return this.call('sendFile', {
      threadId: FacebookE2EEBridge.toIntThreadId(params.threadId),
      filePath: params.filePath,
      fileName: params.fileName || '',
    });
  }

  // ─── Phase 6: Typing & Mark Read ──────────────────────────────────────────

  /**
   * Gửi typing indicator (normal group)
   */
  public async sendTypingIndicator(params: {
    threadId: string;
    isTyping: boolean;
    isGroup?: boolean;
    threadType?: number;
  }): Promise<void> {
    await this.call('sendTypingIndicator', {
      threadId: FacebookE2EEBridge.toIntThreadId(params.threadId),
      isTyping: params.isTyping,
      isGroup: params.isGroup ?? false,
      threadType: params.threadType ?? 0,
    });
  }

  /**
   * Gửi typing indicator cho E2EE 1:1
   */
  public async sendE2EETyping(params: {
    chatJid: string;
    isTyping: boolean;
  }): Promise<void> {
    await this.call('sendE2EETyping', {
      chatJid: params.chatJid,
      isTyping: params.isTyping,
    });
  }

  /**
   * Đánh dấu thread đã đọc trên Facebook server
   */
  public async markRead(params: {
    threadId: string;
    watermarkTs?: number;
  }): Promise<void> {
    await this.call('markRead', {
      threadId: FacebookE2EEBridge.toIntThreadId(params.threadId),
      watermarkTs: params.watermarkTs || Date.now(),
    });
  }

  /** Edit a normal (non-E2EE) message. */
  public async editMessage(params: { messageId: string; newText: string }): Promise<void> {
    await this.call('editMessage', params);
  }

  /** Unsend a normal (non-E2EE) message. */
  public async unsendMessage(params: { messageId: string }): Promise<void> {
    await this.call('unsendMessage', params);
  }

  /**
   * Chỉnh sửa tin nhắn E2EE
   */
  public async editE2EEMessage(params: {
    chatJid: string;
    messageId: string;
    newText: string;
  }): Promise<void> {
    await this.call('editE2EEMessage', {
      chatJid: params.chatJid,
      messageId: params.messageId,
      newText: params.newText,
    });
  }

  /**
   * Thu hồi tin nhắn E2EE
   */
  public async unsendE2EEMessage(params: {
    chatJid: string;
    messageId: string;
  }): Promise<void> {
    await this.call('unsendE2EEMessage', {
      chatJid: params.chatJid,
      messageId: params.messageId,
    });
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  /**
   * Graceful shutdown: gửi disconnect → đóng stdin → kill sau 5s
   */
  public async close(): Promise<void> {
    if (this.closed || this.closing || !this.process) return;
    this.closing = true;

    // Stop accepting new writes
    this.writeQueue = [];
    this.writing = false;

    // Reject existing work before issuing the one permitted final RPC.
    for (const [, pending] of this.pending) {
      pending.reject(new BridgeError('Bridge closed'));
    }
    this.pending.clear();

    // Try graceful disconnect
    try {
      await this.call('disconnect', undefined, 5000);
    } catch {
      // ignore - bridge may already be dead
    }

    // Close stdin, give process 5s to exit gracefully
    try { this.process.stdin?.end(); } catch {}
    const proc = this.process;

    const forceKill = setTimeout(() => {
      if (!proc.killed) {
        Logger.warn('[FBE2EEBridge] Force killing bridge process');
        proc.kill('SIGKILL');
      }
    }, 5000);

    proc.on('exit', () => {
      clearTimeout(forceKill);
      if (this.process === proc) {
        this.process = null;
      }
      Logger.log('[FBE2EEBridge] Process exited after close');
    });

    Logger.log('[FBE2EEBridge] Close requested - waiting for process exit');
  }

  /**
   * Kiểm tra bridge process còn sống
   */
  public isAlive(): boolean {
    return !this.closed && !!this.process && !this.process.killed;
  }
}

export default FacebookE2EEBridge;
