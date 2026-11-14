/**
 * Automatically registers webhooks on KiotViet / Sapo pointing to Deplao's webhook receiving address (IntegrationRegistry, the
 * 'payments' service of the Internet address), so the trigger "When the sales software sends a webhook" works without a technical person.
 * Does not depend on Electron: the adapter (PosWebhookApi) and the credential store are passed in → tested with a fake API.
 *
 * KiotViet: the webhook is signed with the Secret sent at registration and can NOT be read back → use the saved Webhook Secret field (create + save it first
 *   if missing / not Base64), each registration removes the old Deplao webhook of the same type and creates it again to make sure
 *   the key matches. Webhooks from other systems are left alone.
 * Sapo: signed with the private app's API Secret (no separate Secret) → the webhook at the correct address is kept as is, an old address is
 *   edited (PUT), if none exists it is created. A connection using an OAuth Access Token must enter the Client Secret in the "Khoá xác thực webhook" field.
 */
import * as crypto from 'crypto';
import {
  WEBHOOK_EVENT_OPTIONS, WebhookOwnership, WebhookRegistrationType, classifyWebhook, deplaoWebhookUrl,
} from '../../shared/integrations/posWebhookTopics';
import { POS_WEBHOOK_SECRET_FIELD } from './posWebhook';
import { tr } from '../../shared/i18n';

/** Webhook on the platform, normalized (KiotViet type/url/isActive, Sapo topic/address). */
export interface RemoteWebhook {
  id: string;
  event: string;
  url: string;
  active: boolean;
  description: string;
}

/** The adapter part used for registration (KiotVietAdapter, SapoAdapter). */
export interface PosWebhookApi {
  listWebhooks(): Promise<RemoteWebhook[]>;
  createWebhook(input: { event: string; url: string; secret?: string; description: string }): Promise<RemoteWebhook>;
  /** Sapo: changes the address of an existing webhook. KiotViet has no such call → remove and create again. */
  updateWebhookUrl?(id: string, url: string): Promise<RemoteWebhook>;
  deleteWebhook(id: string): Promise<void>;
}

export function isPosWebhookApi(value: unknown): value is PosWebhookApi {
  const api = value as PosWebhookApi | null;
  return !!api && typeof api.listWebhooks === 'function' && typeof api.createWebhook === 'function' && typeof api.deleteWebhook === 'function';
}

/** Base address receiving webhooks (PaymentsTunnel): temporary = temporary address, changes on every restart. */
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
  /** Saves the credentials (IntegrationRegistry.saveConfig merges them with the old values). */
  saveCredentials(patch: Record<string, string>): void;
  /** Lets tests replace the random Secret. */
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

/** HTTP errors from KiotViet (responseStatus.message) / Sapo (errors) / network → a short sentence. */
export function registrationError(e: any): string {
  const data = e?.response?.data;
  const fromData = data?.responseStatus?.message || data?.message
    || (typeof data?.errors === 'string' ? data.errors : data?.errors ? JSON.stringify(data.errors) : '');
  const status = e?.response?.status;
  const text = String(fromData || e?.message || e || tr('Lỗi không xác định')).trim();
  return status && !text.includes(String(status)) ? `HTTP ${status}: ${text}` : text;
}

/** KiotViet: "mã bí mật ngẫu nhiên (8 ký tự trở lên), sau đó mã hoá các ký tự này bằng Base64" (a random secret of 8+ characters, then Base64-encoded). */
export function newKiotVietSecret(): string {
  return Buffer.from(crypto.randomBytes(24).toString('hex'), 'utf8').toString('base64');
}

export function isBase64Secret(value: string): boolean {
  return value.length >= 12 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

const NO_ADDRESS = tr('Chưa bật địa chỉ nhận webhook — bật "Thanh toán, tích hợp" ở Cài đặt → Internet & Cloud → Địa chỉ Internet rồi thử lại');

function listed(ctx: RegistrationContext, webhooks: RemoteWebhook[]): ListedWebhook[] {
  return webhooks.map(w => ({ ...w, ownership: classifyWebhook(ctx.type, w, ctx.integrationId, ctx.address.url) }));
}

function emptyRegister(ctx: RegistrationContext, error: string): WebhookRegisterResult {
  return {
    success: false, error, address: ctx.address.url, temporary: ctx.address.temporary, webhooks: [],
    created: [], updated: [], kept: [], removed: 0, errors: [], notes: [],
  };
}

/** Webhooks currently on the platform + which of them belong to Deplao (correct / old address). */
export async function listPosWebhooks(ctx: RegistrationContext): Promise<WebhookListResult> {
  const base = { address: ctx.address.url, temporary: ctx.address.temporary };
  try {
    return { success: true, ...base, webhooks: listed(ctx, await ctx.api.listWebhooks()) };
  } catch (e: any) {
    return { success: false, error: tr('Không đọc được danh sách webhook: {{v1}}', { v1: registrationError(e) }), ...base, webhooks: [] };
  }
}

/** Verification key before registration (KiotViet: the saved Base64 Secret; Sapo: API Secret / Client Secret). */
function prepareSecret(ctx: RegistrationContext, notes: string[]): { secret?: string; error?: string } {
  const stored = String(ctx.credentials[POS_WEBHOOK_SECRET_FIELD] || '').trim();
  if (ctx.type === 'kiotviet') {
    if (isBase64Secret(stored)) return { secret: stored };
    const secret = (ctx.randomSecret || newKiotVietSecret)();
    // Save BEFORE registering: the first webhook KiotViet sends can then be verified
    ctx.saveCredentials({ [POS_WEBHOOK_SECRET_FIELD]: secret });
    notes.push(stored
      ? tr('Ô Webhook Secret không phải chuỗi Base64 KiotViet yêu cầu — đã tạo Secret mới và lưu vào kết nối')
      : tr('Đã tạo Webhook Secret và lưu vào kết nối'));
    return { secret };
  }
  const apiKey = String(ctx.credentials.apiKey || '').trim();
  const apiSecret = String(ctx.credentials.apiSecret || '').trim();
  if (apiKey && apiSecret) {
    // Private app: Sapo signs with the API Secret; if a separate key field is used, Deplao rejects every webhook
    if (stored && stored !== apiSecret) {
      ctx.saveCredentials({ [POS_WEBHOOK_SECRET_FIELD]: apiSecret });
      notes.push(tr('Sapo ký webhook bằng API Secret của ứng dụng riêng — đã đặt Khoá xác thực webhook = API Secret'));
    }
    return {};
  }
  if (!stored) {
    return { error: tr('Kết nối Sapo bằng Access Token OAuth: nhập Client Secret của ứng dụng vào ô Khoá xác thực webhook (Sapo ký webhook bằng khoá đó), bấm Cập nhật rồi đăng ký lại') };
  }
  return {};
}

/**
 * Registers the selected events pointing to <address>/webhook/<connection id>. Each event is handled separately: an error in one event does not
 * block the others (errors). Webhooks from other systems are not touched.
 */
export async function registerPosWebhooks(ctx: RegistrationContext, events: readonly string[]): Promise<WebhookRegisterResult> {
  const base = ctx.address.url;
  if (!base) return emptyRegister(ctx, NO_ADDRESS);
  if (!/^https:\/\//i.test(base)) return emptyRegister(ctx, tr('Địa chỉ nhận webhook phải là https:// (đang là {{base}})', { base }));
  const allowed = new Set(WEBHOOK_EVENT_OPTIONS[ctx.type].map(option => option.value));
  const wanted = [...new Set((events || []).map(String))].filter(event => allowed.has(event));
  if (!wanted.length) return emptyRegister(ctx, tr('Chọn ít nhất một loại sự kiện'));

  const notes: string[] = [];
  const prepared = prepareSecret(ctx, notes);
  if (prepared.error) return emptyRegister(ctx, prepared.error);

  let remote: RemoteWebhook[];
  try {
    remote = await ctx.api.listWebhooks();
  } catch (e: any) {
    return { ...emptyRegister(ctx, tr('Không đọc được danh sách webhook: {{v1}}', { v1: registrationError(e) })), notes };
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
      // Duplicates (registered several times / several old addresses): each event keeps only one Deplao webhook
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

/** Removes one webhook (the integration page asks again before removing a webhook that is not Deplao's). */
export async function removePosWebhook(ctx: RegistrationContext, webhookId: string): Promise<WebhookListResult> {
  const fail = (error: string): WebhookListResult => ({ success: false, error, address: ctx.address.url, temporary: ctx.address.temporary, webhooks: [] });
  let remote: RemoteWebhook[];
  try {
    remote = await ctx.api.listWebhooks();
  } catch (e: any) {
    return fail(tr('Không đọc được danh sách webhook: {{v1}}', { v1: registrationError(e) }));
  }
  const target = remote.find(w => w.id === String(webhookId ?? ''));
  if (!target) return { ...fail(tr('Không tìm thấy webhook — có thể đã được gỡ')), webhooks: listed(ctx, remote) };
  try {
    await ctx.api.deleteWebhook(target.id);
  } catch (e: any) {
    return { ...fail(tr('Không gỡ được webhook: {{v1}}', { v1: registrationError(e) })), webhooks: listed(ctx, remote) };
  }
  return listPosWebhooks(ctx);
}
