import * as http from 'http';
import { app, safeStorage } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import { IntegrationAdapter, IntegrationConfig } from './IntegrationAdapter';
import { KiotVietAdapter } from './adapters/KiotVietAdapter';
import { CassoAdapter } from './adapters/CassoAdapter';
import { SePayAdapter } from './adapters/SePayAdapter';
import { GHNAdapter } from './adapters/GHNAdapter';
import { GHTKAdapter } from './adapters/GHTKAdapter';
import { HaravanAdapter } from './adapters/HaravanAdapter';
import { SapoAdapter } from './adapters/SapoAdapter';
import { NhanhAdapter } from './adapters/NhanhAdapter';
import { PancakeAdapter } from './adapters/PancakeAdapter';
import { TelegramBotAdapter } from './adapters/TelegramBotAdapter';
import {
  MAX_WEBHOOK_BODY_BYTES, RecentKeys, WEBHOOK_SECRET_CREDENTIAL, WebhookAuthMethod, WebhookCapableAdapter, WebhookHeaders,
  WebhookRequest, headerValue, isWebhookCapable, parseWebhookBody, readRequestBody,
} from './paymentWebhook';
import { PosWebhookType, isPosWebhookType, parsePosWebhook, posWebhookSecret, verifyPosWebhook } from './posWebhook';
import {
  RegistrationContext, WebhookAddress, WebhookListResult, WebhookRegisterResult, isPosWebhookApi, listPosWebhooks,
  registerPosWebhooks, removePosWebhook,
} from './posWebhookRegistration';
import { isWebhookRegistrationType } from '../../shared/integrations/posWebhookTopics';

/** Map of active adapter instances (integrationId → adapter) */
const adapterInstances = new Map<string, IntegrationAdapter>();

/** Webhook HTTP server */
let webhookServer: http.Server | null = null;
let webhookPort = 9888;

/** Một lần nhận / từ chối webhook (chỉ RAM) — trang tích hợp hiện để người dùng biết webhook có bị từ chối không. */
export interface WebhookEventInfo {
  at: number;
  message: string;
  /** Lần nhận: cách xác thực ('none' = chưa đặt khoá bảo mật). */
  method?: WebhookAuthMethod;
  /** Lần từ chối: lý do (missing_signature, invalid_signature, stale_timestamp, unsupported_auth, no_secret, disabled). */
  reason?: string;
}

/** Trạng thái webhook của kết nối Casso / SePay / phần mềm bán hàng (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake) trong listConfigs(). */
export interface IntegrationWebhookInfo {
  secretConfigured: boolean;
  lastAccepted?: WebhookEventInfo;
  lastRejected?: WebhookEventInfo;
}

export interface WebhookHttpResult {
  status: number;
  body: Record<string, any>;
}

const webhookStatus = new Map<string, { lastAccepted?: WebhookEventInfo; lastRejected?: WebhookEventInfo }>();
/** Giao dịch đã phát (Casso / SePay gửi lại khi lỗi, admin phát lại thủ công) — mỗi giao dịch chỉ chạy workflow một lần. */
const seenTransactions = new RecentKeys();
/** Sự kiện POS đã phát (nền tảng gửi lại khi Deplao trả lời chậm / lỗi) — mỗi đơn / khách / sản phẩm chỉ chạy workflow một lần. */
const seenPosEvents = new RecentKeys();

const ACCEPTED_MESSAGES: Record<WebhookAuthMethod, string> = {
  'casso-signature': 'Đã nhận — chữ ký Webhook V2 hợp lệ',
  'casso-token': 'Đã nhận — secure-token hợp lệ (Webhook cũ)',
  'sepay-signature': 'Đã nhận — chữ ký HMAC-SHA256 hợp lệ',
  'sepay-apikey': 'Đã nhận — API Key hợp lệ',
  none: 'Đã nhận — không kiểm tra chữ ký (chưa đặt khoá bảo mật)',
};

function noteWebhook(integrationId: string, kind: 'lastAccepted' | 'lastRejected', info: WebhookEventInfo): void {
  const entry = webhookStatus.get(integrationId) || {};
  entry[kind] = info;
  webhookStatus.set(integrationId, entry);
}

function webhookReply(status: number, body: Record<string, any>): WebhookHttpResult {
  return { status, body };
}

/**
 * Webhook phần mềm bán hàng (posWebhook.ts): BẮT BUỘC khoá xác thực — chưa đặt khoá, thiếu / sai chữ ký → 401, không chạy
 * workflow. Hợp lệ → mỗi đơn / khách / sản phẩm phát 'integration:posWebhook' (trigger "Khi phần mềm bán hàng gửi webhook")
 * một lần; `?event=` ở địa chỉ nhận đặt tên sự kiện khi nền tảng không gửi.
 */
function processPosWebhook(
  candidates: IntegrationConfig[],
  input: { url?: string; headers: WebhookHeaders; rawBody: Buffer },
  pathname: string,
  body: any,
  now: number,
): WebhookHttpResult {
  const request = { headers: input.headers, rawBody: input.rawBody, body };
  let accepted: { cfg: IntegrationConfig; type: PosWebhookType; message: string } | null = null;
  const rejections: Array<{ cfg: IntegrationConfig; reason: string; message: string }> = [];
  for (const cfg of candidates) {
    const type = cfg.type as PosWebhookType;
    const auth = verifyPosWebhook(type, request, posWebhookSecret(type, cfg.credentials));
    if (auth.ok === false) {
      rejections.push({ cfg, reason: auth.reason, message: auth.message });
      continue;
    }
    accepted = { cfg, type, message: auth.message };
    break;
  }
  if (!accepted) {
    for (const r of rejections) noteWebhook(r.cfg.id, 'lastRejected', { at: now, reason: r.reason, message: r.message });
    Logger.warn(`[WebhookServer] Từ chối webhook ${pathname.slice(0, 80)}: ${rejections.map(r => r.message).join('; ')}`);
    return webhookReply(401, { success: false, error: 'Invalid or missing webhook signature' });
  }

  const { cfg, type } = accepted;
  let eventOverride = '';
  try { eventOverride = new URL(input.url || '/', 'http://127.0.0.1').searchParams.get('event') || ''; } catch { /* không có ?event= */ }
  const parsed = parsePosWebhook(type, { ...request, eventOverride });
  let emitted = 0;
  let duplicates = 0;
  for (const event of parsed.events) {
    if (seenPosEvents.seen(`${cfg.id}:${event.dedupeKey}`, now)) {
      duplicates++;
      continue;
    }
    const { dedupeKey: _dedupeKey, ...payload } = event;
    EventBroadcaster.emit('integration:posWebhook', { ...payload, integrationId: cfg.id, integrationName: cfg.name, verified: true, receivedAt: now });
    emitted++;
  }
  EventBroadcaster.emit('integration:webhook', { integrationId: cfg.id, integrationType: cfg.type, url: pathname, payload: body, verified: true });
  const summary = parsed.ping
    ? 'lượt kiểm tra khi bật webhook'
    : `${emitted} sự kiện mới${duplicates ? `, ${duplicates} trùng (bỏ qua)` : ''}`;
  noteWebhook(cfg.id, 'lastAccepted', { at: now, message: `${accepted.message} — ${summary}` });
  Logger.log(`[WebhookServer] ${cfg.type} ${cfg.id}: ${summary}`);
  return webhookReply(200, { success: true });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function createAdapter(config: IntegrationConfig): IntegrationAdapter {
  switch (config.type) {
    case 'kiotviet': return new KiotVietAdapter(config);
    case 'casso':    return new CassoAdapter(config);
    case 'sepay':    return new SePayAdapter(config);
    case 'ghn':      return new GHNAdapter(config);
    case 'ghtk':     return new GHTKAdapter(config);
    case 'haravan':  return new HaravanAdapter(config);
    case 'sapo':     return new SapoAdapter(config);
    case 'nhanh':    return new NhanhAdapter(config);
    case 'pancake':  return new PancakeAdapter(config);
    case 'telegram_bot': return new TelegramBotAdapter(config);
    default:
      throw new Error(`Loại integration không hỗ trợ: ${config.type}`);
  }
}

// ─── Credential encryption/decryption ────────────────────────────────────────

function encryptCredentials(creds: Record<string, string>): string {
  try {
    if (!safeStorage.isEncryptionAvailable()) return JSON.stringify(creds);
    const encrypted = safeStorage.encryptString(JSON.stringify(creds));
    return encrypted.toString('base64');
  } catch {
    return JSON.stringify(creds);
  }
}

function decryptCredentials(raw: string): Record<string, string> {
  try {
    // Try safeStorage first
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const buf = Buffer.from(raw, 'base64');
        return JSON.parse(safeStorage.decryptString(buf));
      } catch { /* fall through to JSON parse */ }
    }
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Database helpers ─────────────────────────────────────────────────────────

function dbListAll(): IntegrationConfig[] {
  const rows = DatabaseService.getInstance().getIntegrations();
  return rows.map(rowToConfig);
}

function rowToConfig(row: any): IntegrationConfig {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled === 1,
    credentials: decryptCredentials(row.credentials_encrypted || '{}'),
    settings: tryParse(row.settings, {}),
    connectedAt: row.connected_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tryParse(s: string, fallback: any): any {
  try { return JSON.parse(s); } catch { return fallback; }
}

function isMaskedSecret(v: any): boolean {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  return trimmed === '••••' || trimmed === 'â€¢â€¢â€¢â€¢';
}

// ─── Integration Registry ─────────────────────────────────────────────────────

export const IntegrationRegistry = {

  /** Initialize: load all enabled integrations & start webhook server */
  initialize(): void {
    this.loadAdapters();
    this.startWebhookServer();
    Logger.log(`[IntegrationRegistry] Initialized - ${adapterInstances.size} adapters loaded`);
  },

  loadAdapters(): void {
    adapterInstances.clear();
    const configs = dbListAll();
    for (const cfg of configs) {
      if (!cfg.enabled) continue;
      try {
        const adapter = createAdapter(cfg);
        adapterInstances.set(cfg.id, adapter);
      } catch (e: any) {
        Logger.warn(`[IntegrationRegistry] Cannot load adapter ${cfg.id} (${cfg.type}): ${e.message}`);
      }
    }
  },

  /**
   * List all integration configs (credentials stripped). Casso / SePay và phần mềm bán hàng kèm `webhook`: đã đặt khoá
   * chưa + lần nhận / từ chối gần nhất.
   */
  listConfigs(): Array<Omit<IntegrationConfig, 'credentials'> & { webhook?: IntegrationWebhookInfo }> {
    return dbListAll().map(({ credentials, ...rest }) => {
      const secretField = WEBHOOK_SECRET_CREDENTIAL[rest.type];
      let secretConfigured: boolean;
      if (secretField) secretConfigured = !!String(credentials?.[secretField] || '').trim();
      else if (isPosWebhookType(rest.type)) secretConfigured = !!posWebhookSecret(rest.type, credentials);
      else return rest;
      return { ...rest, webhook: { secretConfigured, ...webhookStatus.get(rest.id) } };
    });
  },

  /** Get single config (with credentials masked for security) */
  getConfig(id: string): IntegrationConfig | null {
    const rows = DatabaseService.getInstance().getIntegrations();
    const row = rows.find((r: any) => r.id === id);
    if (!row) return null;
    const cfg = rowToConfig(row);
    // Mask credential values: keep keys but replace values with '••••'
    const masked: Record<string, string> = {};
    for (const k of Object.keys(cfg.credentials)) {
      masked[k] = cfg.credentials[k] ? '••••' : '';
    }
    return { ...cfg, credentials: masked };
  },

  /** Get config with real decrypted credentials (only for service-side use) */
  getConfigWithCredentials(id: string): IntegrationConfig | null {
    const rows = DatabaseService.getInstance().getIntegrations();
    const row = rows.find((r: any) => r.id === id);
    if (!row) return null;
    return rowToConfig(row);
  },

  /** Save (create or update) an integration config */
  saveConfig(config: Partial<IntegrationConfig> & { credentials: Record<string, string> }): string {
    const now = Date.now();
    const id = config.id || uuidv4();
    const existing = config.id ? this.getConfigWithCredentials(config.id) : null;
    const mergedCredentials: Record<string, string> = { ...(existing?.credentials || {}) };

    // Merge credentials safely: blank/masked values keep old credential
    for (const [k, rawVal] of Object.entries(config.credentials || {})) {
      const val = typeof rawVal === 'string' ? rawVal.trim() : rawVal;
      if (val === '' || val === undefined || val === null || isMaskedSecret(val)) continue;
      mergedCredentials[k] = String(rawVal);
    }

    const encryptedCreds = encryptCredentials(mergedCredentials);
    DatabaseService.getInstance().upsertIntegration({
      id,
      type: config.type || existing?.type || '',
      name: config.name || existing?.name || '',
      enabled: config.enabled !== false ? 1 : 0,
      credentials_encrypted: encryptedCreds,
      settings: JSON.stringify(config.settings || existing?.settings || {}),
      connected_at: config.connectedAt || existing?.connectedAt || null,
      created_at: config.createdAt || existing?.createdAt || now,
      updated_at: now,
    });
    DatabaseService.getInstance().save();

    // Reload adapter
    const fullConfig = this.getConfigWithCredentials(id);
    if (fullConfig?.enabled) {
      try {
        const adapter = createAdapter(fullConfig);
        adapterInstances.set(id, adapter);
      } catch { adapterInstances.delete(id); }
    } else {
      adapterInstances.delete(id);
    }

    return id;
  },

  /** Delete integration */
  deleteConfig(id: string): void {
    DatabaseService.getInstance().deleteIntegration(id);
    DatabaseService.getInstance().save();
    adapterInstances.delete(id);
    webhookStatus.delete(id);
  },

  /** Toggle enabled state */
  toggleEnabled(id: string, enabled: boolean): void {
    DatabaseService.getInstance().toggleIntegration(id, enabled);
    DatabaseService.getInstance().save();
    const cfg = this.getConfigWithCredentials(id);
    if (!cfg) return;
    if (enabled) {
      try {
        const adapter = createAdapter(cfg);
        adapterInstances.set(id, adapter);
      } catch { adapterInstances.delete(id); }
    } else {
      adapterInstances.delete(id);
    }
  },

  /** Test connection for a given integration id */
  async testConnection(id: string): Promise<{ success: boolean; message: string }> {
    const cfg = this.getConfigWithCredentials(id);
    if (!cfg) return { success: false, message: 'Integration không tồn tại' };
    try {
      const adapter = createAdapter(cfg);
      const result = await adapter.testConnection();
      if (result.success) {
        // Update connected_at timestamp
        DatabaseService.getInstance().markIntegrationConnected(id, Date.now());
        DatabaseService.getInstance().save();
        // Reload adapter instance
        adapterInstances.set(id, adapter);
      }
      return result;
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  },

  /** Execute action on a specific integration */
  async executeAction(id: string, action: string, params: Record<string, any>): Promise<any> {
    const adapter = adapterInstances.get(id);
    if (!adapter) {
      // Try creating on the fly
      const cfg = this.getConfigWithCredentials(id);
      if (!cfg) throw new Error(`Integration ${id} không tồn tại`);
      const fresh = createAdapter(cfg);
      adapterInstances.set(id, fresh);
      return fresh.executeAction(action, params);
    }
    return adapter.executeAction(action, params);
  },

  /** Execute action by type (uses first enabled adapter of that type) */
  async executeActionByType(type: string, action: string, params: Record<string, any>): Promise<any> {
    for (const [id, adapter] of adapterInstances) {
      if (adapter.type === type && adapter.isEnabled()) {
        return adapter.executeAction(action, params);
      }
    }
    throw new Error(`Không có integration ${type} nào đang kết nối`);
  },

  getWebhookPort(): number {
    return webhookPort;
  },

  /**
   * Đăng ký webhook tự động (KiotViet / Sapo, posWebhookRegistration.ts): bối cảnh cho một kết nối đang bật. `address` =
   * địa chỉ nhận webhook hiện tại (IPC đọc từ PaymentsTunnel). Lưu khoá (Secret KiotViet…) qua saveConfig — gộp credential cũ.
   */
  webhookRegistrationContext(id: string, address: WebhookAddress): RegistrationContext | { error: string } {
    const cfg = this.getConfigWithCredentials(id);
    if (!cfg) return { error: 'Integration không tồn tại' };
    if (!isWebhookRegistrationType(cfg.type)) return { error: 'Chỉ KiotViet và Sapo đăng ký webhook tự động được' };
    if (!cfg.enabled) return { error: 'Kết nối đang tắt — bật "Kích hoạt" rồi bấm Cập nhật trước' };
    let adapter: unknown = null;
    try { adapter = createAdapter(cfg); } catch (e: any) { return { error: e?.message || 'Không tạo được kết nối' }; }
    if (!isPosWebhookApi(adapter)) return { error: 'Kết nối này chưa hỗ trợ đăng ký webhook' };
    return {
      type: cfg.type,
      integrationId: cfg.id,
      integrationName: cfg.name,
      credentials: cfg.credentials,
      api: adapter,
      address,
      saveCredentials: (patch: Record<string, string>) => {
        this.saveConfig({ id: cfg.id, type: cfg.type, name: cfg.name, enabled: cfg.enabled, settings: cfg.settings, credentials: patch });
      },
    };
  },

  async listPosWebhooks(id: string, address: WebhookAddress): Promise<WebhookListResult> {
    const ctx = this.webhookRegistrationContext(id, address);
    if ('error' in ctx) return { success: false, error: ctx.error, address: address.url, temporary: address.temporary, webhooks: [] };
    return listPosWebhooks(ctx);
  },

  async registerPosWebhooks(id: string, events: string[], address: WebhookAddress): Promise<WebhookRegisterResult> {
    const ctx = this.webhookRegistrationContext(id, address);
    if ('error' in ctx) {
      return {
        success: false, error: ctx.error, address: address.url, temporary: address.temporary, webhooks: [],
        created: [], updated: [], kept: [], removed: 0, errors: [], notes: [],
      };
    }
    const result = await registerPosWebhooks(ctx, events);
    Logger.log(`[IntegrationRegistry] Đăng ký webhook ${ctx.type} ${id}: tạo ${result.created.length}, sửa ${result.updated.length}, giữ ${result.kept.length}, gỡ ${result.removed}, lỗi ${result.errors.length}`);
    return result;
  },

  async removePosWebhook(id: string, webhookId: string, address: WebhookAddress): Promise<WebhookListResult> {
    const ctx = this.webhookRegistrationContext(id, address);
    if ('error' in ctx) return { success: false, error: ctx.error, address: address.url, temporary: address.temporary, webhooks: [] };
    return removePosWebhook(ctx, webhookId);
  },

  /**
   * Xử lý một request tới /webhook/{integrationId | loại} (body đã đọc xong) — tách khỏi HTTP để test.
   * Chỉ kết nối đang bật. Casso / SePay phải qua verifyWebhook của adapter (đã đặt khoá → bắt buộc chữ ký hợp lệ);
   * mỗi giao dịch tiền vào phát 'integration:payment' đúng một lần (chống trùng theo id giao dịch).
   * Phần mềm bán hàng: processPosWebhook (luôn cần khoá xác thực) → 'integration:posWebhook'.
   */
  processWebhook(input: { method?: string; url?: string; headers: WebhookHeaders; rawBody: Buffer; now?: number }): WebhookHttpResult {
    if (String(input.method || '').toUpperCase() !== 'POST') return webhookReply(405, { success: false, error: 'Method not allowed' });
    const now = input.now ?? Date.now();

    let pathname = '/';
    try { pathname = new URL(input.url || '/', 'http://127.0.0.1').pathname; } catch { /* giữ '/' */ }
    const parts = pathname.split('/').filter(Boolean);
    let route = '';
    try { route = parts.length === 2 && parts[0] === 'webhook' ? decodeURIComponent(parts[1]) : ''; } catch { route = ''; }
    if (!route) return webhookReply(404, { success: false, error: 'Not found' });

    const configs = dbListAll();
    const byId = configs.find(c => c.id === route);
    if (byId && !byId.enabled) {
      noteWebhook(byId.id, 'lastRejected', { at: now, reason: 'disabled', message: 'Kết nối đang tắt (Kích hoạt) — webhook bị bỏ qua' });
      return webhookReply(404, { success: false, error: 'Integration not found or disabled' });
    }
    const candidates = byId ? [byId] : configs.filter(c => c.type === route && c.enabled);
    if (!candidates.length) {
      Logger.warn(`[WebhookServer] Không có kết nối đang bật cho /webhook/${route.slice(0, 64)}`);
      return webhookReply(404, { success: false, error: 'Integration not found or disabled' });
    }

    let body: any;
    try {
      body = parseWebhookBody(input.rawBody, headerValue(input.headers, 'content-type'));
    } catch {
      return webhookReply(400, { success: false, error: 'Invalid body' });
    }

    const payments: Array<{ cfg: IntegrationConfig; adapter: WebhookCapableAdapter }> = [];
    for (const cfg of candidates) {
      let adapter: unknown = null;
      try { adapter = createAdapter(cfg); } catch { /* loại không còn hỗ trợ */ }
      if (isWebhookCapable(adapter)) payments.push({ cfg, adapter });
    }
    if (!payments.length) {
      const pos = candidates.filter(c => isPosWebhookType(c.type));
      if (pos.length) return processPosWebhook(pos, input, pathname, body, now);
      // Vận chuyển (GHN / GHTK)…: chưa có cơ chế xác thực webhook — giữ hành vi cũ, chỉ phát sự kiện chung (không trigger nào dùng).
      const cfg = candidates[0];
      EventBroadcaster.emit('integration:webhook', { integrationId: cfg.id, integrationType: cfg.type, url: pathname, payload: body, verified: false });
      return webhookReply(200, { success: true });
    }

    const req: WebhookRequest = { headers: input.headers, rawBody: input.rawBody, body, now };
    let accepted: { cfg: IntegrationConfig; adapter: WebhookCapableAdapter; method: WebhookAuthMethod } | null = null;
    const rejections: Array<{ cfg: IntegrationConfig; reason: string; message: string }> = [];
    for (const { cfg, adapter } of payments) {
      const auth = adapter.verifyWebhook(req);
      if (auth.ok === false) {
        rejections.push({ cfg, reason: auth.reason, message: auth.message });
        continue;
      }
      // Route theo loại có nhiều kết nối: ưu tiên kết nối có khoá khớp chữ ký hơn kết nối chưa đặt khoá
      if (!accepted || (accepted.method === 'none' && auth.method !== 'none')) accepted = { cfg, adapter, method: auth.method };
      if (auth.method !== 'none') break;
    }
    if (!accepted) {
      for (const r of rejections) noteWebhook(r.cfg.id, 'lastRejected', { at: now, reason: r.reason, message: r.message });
      Logger.warn(`[WebhookServer] Từ chối webhook /webhook/${route.slice(0, 64)}: ${rejections.map(r => r.message).join('; ')}`);
      return webhookReply(401, { success: false, error: 'Invalid or missing webhook signature' });
    }

    const { cfg, adapter, method } = accepted;
    const verified = method !== 'none';
    let emitted = 0;
    let duplicates = 0;
    let outgoing = 0;
    for (const { tx, raw } of adapter.parseWebhook(body)) {
      // "Khi nhận thanh toán" chỉ dành cho tiền vào
      if (tx.direction !== 'in') { outgoing++; continue; }
      // id "0" = giao dịch thử (nút Gọi thử / Gửi thử) — không chống trùng
      if (tx.transactionId && tx.transactionId !== '0' && seenTransactions.seen(`${cfg.type}:${tx.transactionId}`, now)) {
        duplicates++;
        continue;
      }
      EventBroadcaster.emit('integration:payment', {
        integrationId: cfg.id,
        integrationType: cfg.type,
        transaction: raw,
        payment: tx,
        verified,
        raw: body,
      });
      emitted++;
    }
    EventBroadcaster.emit('integration:webhook', { integrationId: cfg.id, integrationType: cfg.type, url: pathname, payload: body, verified });
    noteWebhook(cfg.id, 'lastAccepted', { at: now, method, message: ACCEPTED_MESSAGES[method] });
    Logger.log(`[WebhookServer] ${cfg.type} ${cfg.id}: ${method} — ${emitted} giao dịch mới, ${duplicates} trùng, ${outgoing} tiền ra`);
    return webhookReply(200, { success: true });
  },

  /** Request HTTP của webhook server: chỉ POST, body tối đa MAX_WEBHOOK_BODY_BYTES (đọc nguyên bytes), rồi processWebhook. */
  handleWebhookHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const send = (result: WebhookHttpResult, close = false): void => {
      if (res.headersSent) return;
      res.writeHead(result.status, { 'Content-Type': 'application/json', ...(close ? { Connection: 'close' } : {}) });
      res.end(JSON.stringify(result.body));
    };
    if (req.method !== 'POST') {
      req.resume();
      send(webhookReply(405, { success: false, error: 'Method not allowed' }));
      return;
    }
    const tooLarge = webhookReply(413, { success: false, error: 'Payload too large' });
    if (Number(req.headers['content-length']) > MAX_WEBHOOK_BODY_BYTES) {
      send(tooLarge, true);
      return;
    }
    readRequestBody(req, MAX_WEBHOOK_BODY_BYTES).then(rawBody => {
      let result: WebhookHttpResult;
      try {
        result = this.processWebhook({ method: req.method, url: req.url, headers: req.headers, rawBody });
      } catch (e: any) {
        Logger.error(`[WebhookServer] Error: ${e?.message || e}`);
        result = webhookReply(500, { success: false, error: 'Internal error' });
      }
      send(result);
    }, (e: any) => {
      send(e?.code === 'BODY_TOO_LARGE' ? tooLarge : webhookReply(400, { success: false, error: 'Bad request' }), true);
    });
  },

  /** Start embedded HTTP server to receive webhooks */
  startWebhookServer(port?: number): void {
    if (webhookServer) return;
    webhookPort = port || 9888;

    webhookServer = http.createServer((req, res) => this.handleWebhookHttp(req, res));
    // Địa chỉ Internet trỏ vào cổng này: không giữ kết nối gửi header / body nhỏ giọt
    webhookServer.headersTimeout = 10_000;
    webhookServer.requestTimeout = 15_000;

    webhookServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        Logger.warn(`[WebhookServer] Port ${webhookPort} in use - trying ${webhookPort + 1}`);
        webhookPort += 1;
        webhookServer?.close();
        webhookServer = null;
        this.startWebhookServer(webhookPort);
      } else {
        Logger.error(`[WebhookServer] Error: ${err.message}`);
      }
    });

    webhookServer.listen(webhookPort, '127.0.0.1', () => {
      Logger.log(`[WebhookServer] Listening on http://127.0.0.1:${webhookPort}`);
    });
  },

  stopWebhookServer(): void {
    webhookServer?.close();
    webhookServer = null;
  },
};

export default IntegrationRegistry;


