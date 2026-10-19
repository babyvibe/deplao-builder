/**
 * Đăng ký webhook tự động trên KiotViet / Sapo trỏ về địa chỉ nhận webhook của Deplao (IntegrationRegistry, dịch vụ
 * 'payments' của địa chỉ Internet) — để trigger "Khi phần mềm bán hàng gửi webhook" chạy mà không cần người kỹ thuật.
 * Không phụ thuộc Electron: adapter (PosWebhookApi) và nơi lưu credential được truyền vào → test bằng API giả.
 *
 * KiotViet: webhook ký bằng Secret gửi lúc đăng ký và KHÔNG đọc lại được → dùng ô Webhook Secret đang lưu (tạo + lưu trước
 *   khi đăng ký nếu chưa có / không phải Base64), mỗi lần đăng ký gỡ webhook Deplao cũ cùng loại rồi tạo lại để chắc chắn
 *   khớp khoá. Webhook của hệ thống khác giữ nguyên.
 * Sapo: ký bằng API Secret của ứng dụng riêng (không có Secret riêng) → webhook đúng địa chỉ giữ nguyên, địa chỉ cũ thì
 *   sửa (PUT), chưa có thì tạo. Kết nối bằng Access Token OAuth phải tự nhập Client Secret vào ô Khoá xác thực webhook.
 */
import * as crypto from 'crypto';
import {
  WEBHOOK_EVENT_OPTIONS, WebhookOwnership, WebhookRegistrationType, classifyWebhook, deplaoWebhookUrl,
} from '../../shared/posWebhookTopics';
import { POS_WEBHOOK_SECRET_FIELD } from './posWebhook';

/** Webhook trên nền tảng, đã chuẩn hoá (KiotViet type/url/isActive, Sapo topic/address). */
export interface RemoteWebhook {
  id: string;
  event: string;
  url: string;
  active: boolean;
  description: string;
}

/** Phần adapter dùng để đăng ký (KiotVietAdapter, SapoAdapter). */
export interface PosWebhookApi {
  listWebhooks(): Promise<RemoteWebhook[]>;
  createWebhook(input: { event: string; url: string; secret?: string; description: string }): Promise<RemoteWebhook>;
  /** Sapo: đổi địa chỉ webhook có sẵn. KiotViet không có → gỡ rồi tạo lại. */
  updateWebhookUrl?(id: string, url: string): Promise<RemoteWebhook>;
  deleteWebhook(id: string): Promise<void>;
}

export function isPosWebhookApi(value: unknown): value is PosWebhookApi {
  const api = value as PosWebhookApi | null;
  return !!api && typeof api.listWebhooks === 'function' && typeof api.createWebhook === 'function' && typeof api.deleteWebhook === 'function';
}

/** Địa chỉ gốc nhận webhook (PaymentsTunnel) — temporary = địa chỉ tạm, đổi mỗi lần khởi động lại. */
export interface WebhookAddress {
  url: string | null;
  temporary: boolean;
}

export interface RegistrationContext {
  type: WebhookRegistrationType;
  integrationId: string;
  integrationName: string;
  credentials: Record<string, string>;
  api: PosWebhookApi;
  address: WebhookAddress;
  /** Lưu credential (IntegrationRegistry.saveConfig gộp với giá trị cũ). */
  saveCredentials(patch: Record<string, string>): void;
  /** Test thay được Secret ngẫu nhiên. */
  randomSecret?: () => string;
}

export interface ListedWebhook extends RemoteWebhook {
  ownership: WebhookOwnership;
}

export interface WebhookListResult {
  success: boolean;
  error?: string;
  address: string | null;
  temporary: boolean;
  webhooks: ListedWebhook[];
}

export interface WebhookRegisterResult extends WebhookListResult {
  created: string[];
  updated: string[];
  kept: string[];
  removed: number;
  errors: Array<{ event: string; message: string }>;
  notes: string[];
}

/** Lỗi HTTP của KiotViet (responseStatus.message) / Sapo (errors) / mạng → câu ngắn. */
export function registrationError(e: any): string {
  const data = e?.response?.data;
  const fromData = data?.responseStatus?.message || data?.message
    || (typeof data?.errors === 'string' ? data.errors : data?.errors ? JSON.stringify(data.errors) : '');
  const status = e?.response?.status;
  const text = String(fromData || e?.message || e || 'Lỗi không xác định').trim();
  return status && !text.includes(String(status)) ? `HTTP ${status}: ${text}` : text;
}

/** KiotViet: "mã bí mật ngẫu nhiên (8 ký tự trở lên), sau đó mã hoá các ký tự này bằng Base64". */
export function newKiotVietSecret(): string {
  return Buffer.from(crypto.randomBytes(24).toString('hex'), 'utf8').toString('base64');
}

export function isBase64Secret(value: string): boolean {
  return value.length >= 12 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

const NO_ADDRESS = 'Chưa bật địa chỉ nhận webhook — bật "Thanh toán, tích hợp" ở Cài đặt → Internet & Đám mây → Địa chỉ Internet rồi thử lại';

function listed(ctx: RegistrationContext, webhooks: RemoteWebhook[]): ListedWebhook[] {
  return webhooks.map(w => ({ ...w, ownership: classifyWebhook(ctx.type, w, ctx.integrationId, ctx.address.url) }));
}

function emptyRegister(ctx: RegistrationContext, error: string): WebhookRegisterResult {
  return {
    success: false, error, address: ctx.address.url, temporary: ctx.address.temporary, webhooks: [],
    created: [], updated: [], kept: [], removed: 0, errors: [], notes: [],
  };
}

/** Webhook đang có trên nền tảng + webhook nào là của Deplao (đúng / cũ địa chỉ). */
export async function listPosWebhooks(ctx: RegistrationContext): Promise<WebhookListResult> {
  const base = { address: ctx.address.url, temporary: ctx.address.temporary };
  try {
    return { success: true, ...base, webhooks: listed(ctx, await ctx.api.listWebhooks()) };
  } catch (e: any) {
    return { success: false, error: `Không đọc được danh sách webhook: ${registrationError(e)}`, ...base, webhooks: [] };
  }
}

/** Khoá xác thực trước khi đăng ký (KiotViet: Secret Base64 đã lưu; Sapo: API Secret / Client Secret). */
function prepareSecret(ctx: RegistrationContext, notes: string[]): { secret?: string; error?: string } {
  const stored = String(ctx.credentials[POS_WEBHOOK_SECRET_FIELD] || '').trim();
  if (ctx.type === 'kiotviet') {
    if (isBase64Secret(stored)) return { secret: stored };
    const secret = (ctx.randomSecret || newKiotVietSecret)();
    // Lưu TRƯỚC khi đăng ký: webhook đầu tiên KiotViet gửi tới đã xác thực được
    ctx.saveCredentials({ [POS_WEBHOOK_SECRET_FIELD]: secret });
    notes.push(stored
      ? 'Ô Webhook Secret không phải chuỗi Base64 KiotViet yêu cầu — đã tạo Secret mới và lưu vào kết nối'
      : 'Đã tạo Webhook Secret và lưu vào kết nối');
    return { secret };
  }
  const apiKey = String(ctx.credentials.apiKey || '').trim();
  const apiSecret = String(ctx.credentials.apiSecret || '').trim();
  if (apiKey && apiSecret) {
    // Ứng dụng riêng: Sapo ký bằng API Secret — ô khoá riêng khác đi thì mọi webhook bị Deplao từ chối
    if (stored && stored !== apiSecret) {
      ctx.saveCredentials({ [POS_WEBHOOK_SECRET_FIELD]: apiSecret });
      notes.push('Sapo ký webhook bằng API Secret của ứng dụng riêng — đã đặt Khoá xác thực webhook = API Secret');
    }
    return {};
  }
  if (!stored) {
    return { error: 'Kết nối Sapo bằng Access Token OAuth: nhập Client Secret của ứng dụng vào ô Khoá xác thực webhook (Sapo ký webhook bằng khoá đó), bấm Cập nhật rồi đăng ký lại' };
  }
  return {};
}

/**
 * Đăng ký các sự kiện đã chọn trỏ về <địa chỉ>/webhook/<id kết nối>. Mỗi sự kiện xử lý riêng — lỗi một sự kiện không
 * chặn các sự kiện khác (errors). Webhook của hệ thống khác không bị đụng tới.
 */
export async function registerPosWebhooks(ctx: RegistrationContext, events: readonly string[]): Promise<WebhookRegisterResult> {
  const base = ctx.address.url;
  if (!base) return emptyRegister(ctx, NO_ADDRESS);
  if (!/^https:\/\//i.test(base)) return emptyRegister(ctx, `Địa chỉ nhận webhook phải là https:// (đang là ${base})`);
  const allowed = new Set(WEBHOOK_EVENT_OPTIONS[ctx.type].map(option => option.value));
  const wanted = [...new Set((events || []).map(String))].filter(event => allowed.has(event));
  if (!wanted.length) return emptyRegister(ctx, 'Chọn ít nhất một loại sự kiện');

  const notes: string[] = [];
  const prepared = prepareSecret(ctx, notes);
  if (prepared.error) return emptyRegister(ctx, prepared.error);

  let remote: RemoteWebhook[];
  try {
    remote = await ctx.api.listWebhooks();
  } catch (e: any) {
    return { ...emptyRegister(ctx, `Không đọc được danh sách webhook: ${registrationError(e)}`), notes };
  }

  const result: WebhookRegisterResult = { ...emptyRegister(ctx, ''), success: true, error: undefined, notes };
  const ownership = (w: RemoteWebhook) => classifyWebhook(ctx.type, w, ctx.integrationId, base);
  const description = `Deplao - ${ctx.integrationName || ctx.type}`.slice(0, 100);
  for (const event of wanted) {
    const url = deplaoWebhookUrl(ctx.type, base, ctx.integrationId, event);
    const mine = remote.filter(w => w.event === event && ownership(w) !== 'other');
    try {
      if (ctx.type === 'kiotviet') {
        for (const w of mine) {
          await ctx.api.deleteWebhook(w.id);
          result.removed++;
        }
        await ctx.api.createWebhook({ event, url, secret: prepared.secret, description });
        result.created.push(event);
        continue;
      }
      const current = mine.find(w => ownership(w) === 'current');
      const target = current || mine[0];
      if (current) {
        result.kept.push(event);
      } else if (target && ctx.api.updateWebhookUrl) {
        await ctx.api.updateWebhookUrl(target.id, url);
        result.updated.push(event);
      } else {
        await ctx.api.createWebhook({ event, url, description });
        result.created.push(event);
      }
      // Bản trùng (đăng ký nhiều lần / nhiều địa chỉ cũ): mỗi sự kiện chỉ giữ một webhook của Deplao
      for (const w of mine) {
        if (w === target) continue;
        await ctx.api.deleteWebhook(w.id);
        result.removed++;
      }
    } catch (e: any) {
      result.errors.push({ event, message: registrationError(e) });
    }
  }
  result.success = result.errors.length === 0;
  if (!result.success) result.error = result.errors.map(item => `${item.event}: ${item.message}`).join('; ');
  try {
    result.webhooks = listed(ctx, await ctx.api.listWebhooks());
  } catch {
    result.webhooks = [];
  }
  return result;
}

/** Gỡ một webhook (trang tích hợp hỏi lại trước khi gỡ webhook không phải của Deplao). */
export async function removePosWebhook(ctx: RegistrationContext, webhookId: string): Promise<WebhookListResult> {
  const fail = (error: string): WebhookListResult => ({ success: false, error, address: ctx.address.url, temporary: ctx.address.temporary, webhooks: [] });
  let remote: RemoteWebhook[];
  try {
    remote = await ctx.api.listWebhooks();
  } catch (e: any) {
    return fail(`Không đọc được danh sách webhook: ${registrationError(e)}`);
  }
  const target = remote.find(w => w.id === String(webhookId ?? ''));
  if (!target) return { ...fail('Không tìm thấy webhook — có thể đã được gỡ'), webhooks: listed(ctx, remote) };
  try {
    await ctx.api.deleteWebhook(target.id);
  } catch (e: any) {
    return { ...fail(`Không gỡ được webhook: ${registrationError(e)}`), webhooks: listed(ctx, remote) };
  }
  return listPosWebhooks(ctx);
}
