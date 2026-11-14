/**
 * posWebhook: webhooks from POS software (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS): verifies + normalizes them into
 * events for the trigger "When the sales software sends a webhook" (trigger.posWebhook). Pure (no Electron), for testing.
 *
 * Unlike payment webhooks (paymentWebhook.ts): a verification key is REQUIRED. If no key is set in Deplao, or the signature / token is wrong,
 * the request is rejected (401) and no workflow runs, because workflows use this data to message customers, create shipments...
 *
 * KiotViet (kiotviet.vn → Public API → 2.11 Webhook): registered with the API POST /webhooks, Secret = a random string of 8+ characters, Base64-encoded;
 *   KiotViet sends `X-Hub-Signature` = HMAC-SHA256(body, Secret). The docs do not state the signature format → accept hex or
 *   base64, with or without "sha256=", the key is the Base64 string as registered or the bytes after decoding. Body
 *   { Id, Attempt, Notifications: [{ Action, Data: [...] }] }, Id stays the same across resends. If we answer 4xx, KiotViet stops
 *   sending to that address (the docs still require 401 for a wrong signature).
 * Haravan (docs.haravan.com → Webhooks; github.com/Haravan/haravan-validate): `X-Haravan-Hmacsha256` =
 *   base64(HMAC-SHA256(body, secret)); secret = the verification code in Settings → Notifications → Webhook (a separate webhook) or the app's Client
 *   Secret. Topic (orders/create...) is in the header `X-Haravan-Topic`.
 * Sapo (support.sapo.vn/sapo-webhook, same approach as Shopify; connector mona-software/monapay-sapo): `X-Sapo-Hmac-Sha256` =
 *   base64(HMAC-SHA256(body, private app's API Secret)) → if no separate key is set, the API Secret field is used. Topic is in the header
 *   `X-Sapo-Topic`.
 * Nhanh.vn v3 (apidocs.nhanh.vn/v3/webhooks/webhooks): header `Authorization: <Webhooks verify token>` (a token you choose);
 *   body { event, businessId, data } (data may be a JSON string). `webhooksEnabled` is a test ping → returns 200, runs no
 *   workflow. The old webhook v2 puts the token in the body as `webhooksVerifyToken` - still accepted.
 * Pancake POS (docs.pancake.biz/pos/api → Webhook configuration): does not sign the content; declare Request Headers when configuring the webhook →
 *   Deplao reads the header `X-API-KEY` (or Authorization) = the key that was set. The body is an order / customer (raw object) or
 *   { data: { record } } (products, stock), with no event name → inferred from the data shape.
 * If the platform does not send an event name, add `?event=<name>` to the receiving address (e.g. Sapo registers one address per topic).
 */
import * as crypto from 'crypto';
import { WebhookHeaders, headerValue, safeEqual } from './paymentWebhook';
import { tr } from '../../shared/i18n';

export type PosWebhookType = 'kiotviet' | 'haravan' | 'sapo' | 'nhanh' | 'pancake';
export const POS_WEBHOOK_TYPES: readonly PosWebhookType[] = ['kiotviet', 'haravan', 'sapo', 'nhanh', 'pancake'];

export function isPosWebhookType(type: unknown): type is PosWebhookType {
  return (POS_WEBHOOK_TYPES as readonly string[]).includes(String(type));
}

/** Credential field holding the webhook verification key of the POS connection. */
export const POS_WEBHOOK_SECRET_FIELD = 'webhookSecret';

/** Key used to verify the webhook: the "Khoá xác thực webhook" field (webhook verification key); if Sapo has none set, the API Secret is used (Sapo signs with this key). */
export function posWebhookSecret(type: PosWebhookType, credentials: Record<string, any> | null | undefined): string {
  const own = String(credentials?.[POS_WEBHOOK_SECRET_FIELD] ?? '').trim();
  if (own) return own;
  return type === 'sapo' ? String(credentials?.apiSecret ?? '').trim() : '';
}

/** Data group of the event: the trigger's "Loại dữ liệu" (data type) filter. */
export type PosEntity = 'order' | 'invoice' | 'customer' | 'product' | 'inventory' | 'other';

export interface PosWebhookRequest {
  headers: WebhookHeaders;
  /** Body exactly as received, byte for byte: the HMAC signature is computed over these bytes. */
  rawBody: Buffer;
  /** Body that was read (JSON). */
  body: any;
}

export type PosWebhookAuth =
  | { ok: true; message: string }
  | { ok: false; reason: 'no_secret' | 'missing_signature' | 'invalid_signature'; message: string };

/** One event (an order / customer / product...) emitted to workflows: event 'integration:posWebhook'. */
export interface PosWebhookEvent {
  integrationType: PosWebhookType;
  /** Platform event name: order.update (KiotViet), orders/paid (Haravan, Sapo), orderUpdate (Nhanh.vn), orders (Pancake). */
  event: string;
  entity: PosEntity;
  /** Commonly used field, '' when the platform does not send it. */
  code: string;
  status: string;
  customerName: string;
  customerPhone: string;
  total: string;
  /** The platform's original record. */
  data: any;
  /** De-duplication key for when the platform resends the same event. */
  dedupeKey: string;
}

export interface ParsedPosWebhook {
  events: PosWebhookEvent[];
  /** A test ping from the platform (Nhanh.vn webhooksEnabled): returns 200, runs no workflow. */
  ping?: boolean;
}

// ─── Authentication ──────────────────────────────────────────────────────────

const NO_SECRET_MESSAGE = tr('Chưa đặt khoá xác thực webhook trong Deplao — webhook bị từ chối, không chạy workflow');

const rejected = (reason: 'missing_signature' | 'invalid_signature', message: string): PosWebhookAuth => ({ ok: false, reason, message });

function hmacSha256(key: Buffer, raw: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(raw).digest();
}

/** Value of the Authorization / X-API-KEY header, with the "Bearer " prefix removed. */
function tokenHeader(headers: WebhookHeaders, name: string): string {
  return headerValue(headers, name).replace(/^bearer\s+/i, '').trim();
}

function verifyKiotViet(req: PosWebhookRequest, secret: string): PosWebhookAuth {
  const header = headerValue(req.headers, 'x-hub-signature');
  if (!header) return rejected('missing_signature', tr('Thiếu header X-Hub-Signature — đăng ký webhook KiotViet kèm Secret'));
  const given = header.replace(/^sha256=/i, '').trim();
  const keys = [Buffer.from(secret, 'utf8')];
  // The Secret registered with KiotViet is a Base64 string → try the bytes after decoding as well
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(secret) && secret.length % 4 === 0) {
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length > 0) keys.push(decoded);
  }
  for (const key of keys) {
    const mac = hmacSha256(key, req.rawBody);
    if (safeEqual(mac.toString('hex'), given.toLowerCase()) || safeEqual(mac.toString('base64'), given)) {
      return { ok: true, message: tr('Đã nhận — chữ ký X-Hub-Signature hợp lệ') };
    }
  }
  return rejected('invalid_signature', tr('Chữ ký X-Hub-Signature không khớp Secret đã đăng ký với KiotViet'));
}

function verifyBase64Hmac(req: PosWebhookRequest, secret: string, header: string, label: string): PosWebhookAuth {
  const given = headerValue(req.headers, header);
  if (!given) return rejected('missing_signature', tr('Thiếu header {{label}}', { label }));
  const mac = hmacSha256(Buffer.from(secret, 'utf8'), req.rawBody).toString('base64');
  return safeEqual(mac, given)
    ? { ok: true, message: tr('Đã nhận — chữ ký {{label}} hợp lệ', { label }) }
    : rejected('invalid_signature', tr('Chữ ký {{label}} không khớp khoá xác thực', { label }));
}

function verifyNhanh(req: PosWebhookRequest, secret: string): PosWebhookAuth {
  const bodyToken = typeof req.body?.webhooksVerifyToken === 'string' ? req.body.webhooksVerifyToken.trim() : '';
  const token = tokenHeader(req.headers, 'authorization') || bodyToken;
  if (!token) return rejected('missing_signature', tr('Thiếu Webhooks verify token (header Authorization)'));
  return safeEqual(token, secret)
    ? { ok: true, message: tr('Đã nhận — Webhooks verify token hợp lệ') }
    : rejected('invalid_signature', tr('Webhooks verify token không khớp'));
}

function verifyPancake(req: PosWebhookRequest, secret: string): PosWebhookAuth {
  const token = tokenHeader(req.headers, 'x-api-key') || tokenHeader(req.headers, 'authorization');
  if (!token) return rejected('missing_signature', tr('Thiếu header X-API-KEY — khai báo ở Request Headers khi cấu hình webhook Pancake'));
  return safeEqual(token, secret)
    ? { ok: true, message: tr('Đã nhận — header X-API-KEY hợp lệ') }
    : rejected('invalid_signature', tr('Header X-API-KEY không khớp khoá xác thực'));
}

/** Verifies a POS webhook. No key → rejected (no_secret): a POS webhook never runs a workflow until it can be verified. */
export function verifyPosWebhook(type: PosWebhookType, req: PosWebhookRequest, secret: unknown): PosWebhookAuth {
  const key = typeof secret === 'string' ? secret.trim() : '';
  if (!key) return { ok: false, reason: 'no_secret', message: NO_SECRET_MESSAGE };
  switch (type) {
    case 'kiotviet': return verifyKiotViet(req, key);
    case 'haravan': return verifyBase64Hmac(req, key, 'x-haravan-hmacsha256', 'X-Haravan-Hmacsha256');
    case 'sapo': return verifyBase64Hmac(req, key, 'x-sapo-hmac-sha256', 'X-Sapo-Hmac-Sha256');
    case 'nhanh': return verifyNhanh(req, key);
    case 'pancake': return verifyPancake(req, key);
    default: return rejected('invalid_signature', tr('Loại tích hợp không nhận webhook'));
  }
}

// ─── Normalization ───────────────────────────────────────────────────────────

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return '';
}

/** Data group by event name (order.update, orders/paid, orderAdd, variations_warehouses...). */
export function posEntityOf(event: string): PosEntity {
  const e = event.toLowerCase();
  if (/invoice/.test(e)) return 'invoice';
  if (/order|fulfillment|refund|transaction/.test(e)) return 'order';
  if (/customer/.test(e)) return 'customer';
  if (/stock|inventory|warehouse/.test(e)) return 'inventory';
  if (/product|variation|pricebook|collection|categor/.test(e)) return 'product';
  return 'other';
}

/** Nhanh.vn order status (numeric code): same table as Quick integration. */
const NHANH_ORDER_STATUS: Record<number, string> = {
  1: 'Mới', 3: 'Xác nhận', 5: 'Đang đóng gói', 7: 'Đóng gói xong', 9: 'Đang giao hàng', 11: 'Giao thành công',
  13: 'Hoàn tất', 15: 'Đã hủy', 42: 'Đã đóng gói', 54: 'Chờ xác nhận', 59: 'Trả hàng', 64: 'Đã hủy', 68: 'Đã hủy', 72: 'Đã giao',
};

function personName(person: any): string {
  if (!person || typeof person !== 'object') return '';
  return first(person.name, [person.first_name, person.last_name].map(str).filter(Boolean).join(' '), person.full_name);
}

type Fields = Pick<PosWebhookEvent, 'code' | 'status' | 'customerName' | 'customerPhone' | 'total'>;

/** KiotViet: capitalized field names (Code, StatusValue, CustomerName, ContactNumber, Total...). */
function kiotVietFields(d: any, entity: PosEntity): Fields {
  return {
    code: first(d?.Code, d?.Id),
    status: first(d?.StatusValue, d?.Status),
    customerName: first(d?.CustomerName, entity === 'customer' ? d?.Name : '', d?.InvoiceDelivery?.Receiver),
    customerPhone: first(d?.ContactNumber, d?.InvoiceDelivery?.ContactNumber),
    total: first(d?.Total),
  };
}

/** Haravan / Sapo (Shopify style): name (#1001), financial_status / fulfillment_status, total_price, address, customer. */
function shopifyLikeFields(d: any, entity: PosEntity): Fields {
  const order = entity === 'order';
  return {
    code: first(order ? d?.name : '', d?.order_number, d?.id),
    status: order
      ? [d?.financial_status, d?.fulfillment_status].map(str).filter(Boolean).join(' / ') || first(d?.status, d?.cancelled_at ? 'cancelled' : '')
      : first(d?.state, d?.status),
    customerName: entity === 'customer'
      ? personName(d)
      : first(personName(d?.shipping_address), personName(d?.billing_address), personName(d?.customer)),
    customerPhone: first(d?.phone, d?.shipping_address?.phone, d?.billing_address?.phone, d?.customer?.phone),
    total: first(d?.total_price),
  };
}

/** Nhanh.vn v3: order { info: { id, status }, shippingAddress: { name, mobile }, payment }, customer { name, mobile }. */
function nhanhFields(d: any): Fields {
  const info = d?.info && typeof d.info === 'object' ? d.info : d;
  const statusCode = Number(info?.status);
  return {
    code: first(info?.id, d?.id),
    status: Number.isFinite(statusCode) && NHANH_ORDER_STATUS[statusCode] ? NHANH_ORDER_STATUS[statusCode] : first(info?.statusName, info?.status),
    customerName: first(d?.shippingAddress?.name, d?.customer?.name, d?.name),
    customerPhone: first(d?.shippingAddress?.mobile, d?.shippingAddress?.phone, d?.customer?.mobile, d?.mobile),
    total: first(d?.payment?.businessPayment, d?.payment?.codAmount, d?.payment?.totalAmount),
  };
}

/** Pancake POS: order (bill_full_name, bill_phone_number, status_name, total_price), customer (name, phone_numbers). */
function pancakeFields(d: any): Fields {
  return {
    code: first(d?.id, d?.system_id),
    status: first(d?.status_name, d?.status),
    customerName: first(d?.bill_full_name, d?.shipping_address?.full_name, d?.customer?.name, d?.name),
    customerPhone: first(
      d?.bill_phone_number, d?.shipping_address?.phone_number,
      Array.isArray(d?.phone_numbers) ? d.phone_numbers[0] : d?.phone_numbers, d?.phone_number,
    ),
    total: first(d?.total_price_after_sub_discount, d?.total_price),
  };
}

/** Pancake does not send an event name: inferred from the data shape (order / customer / { data: { record } } for products and stock). */
function pancakeShape(body: any): { event: string; entity: PosEntity; data: any } {
  const record = body?.data?.record;
  if (record && typeof record === 'object') {
    const inventory = record.variation_id !== undefined && (record.remain_quantity !== undefined || record.warehouse_id !== undefined);
    return inventory
      ? { event: 'variations_warehouses', entity: 'inventory', data: record }
      : { event: 'products', entity: 'product', data: record };
  }
  if (body && typeof body === 'object' && (body.items !== undefined || body.bill_phone_number !== undefined || body.system_id !== undefined)) {
    return { event: 'orders', entity: 'order', data: body };
  }
  if (body && typeof body === 'object' && (body.phone_numbers !== undefined || body.customer_id !== undefined || body.reward_point !== undefined)) {
    return { event: 'customers', entity: 'customer', data: body };
  }
  return { event: '', entity: 'other', data: body };
}

function parseJsonMaybe(value: unknown): any {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try { return JSON.parse(text); } catch { return value; }
}

export interface ParsePosWebhookInput extends PosWebhookRequest {
  /** Event name set through `?event=` on the receiving address (when the platform does not send one). */
  eventOverride?: string;
}

const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Haravan / Sapo did not send a topic (header missing, no ?event=) → guessed from the data shape. */
function shopifyLikeEntity(body: any): PosEntity {
  if (Array.isArray(body?.line_items)) return 'order';
  if (body?.orders_count !== undefined) return 'customer';
  if (Array.isArray(body?.variants)) return 'product';
  return 'other';
}

/**
 * Webhook body → events for workflows (KiotViet sends several records in one call → one event per record).
 * De-duplication key = type + event name + send id (the Haravan / Sapo webhook id header, if present) or the SHA-256 hash of the body;
 * KiotViet: Id + a hash of each record (a resend only changes Attempt).
 */
export function parsePosWebhook(type: PosWebhookType, input: ParsePosWebhookInput): ParsedPosWebhook {
  const body = input.body;
  const override = str(input.eventOverride);
  const bodyHash = digest(input.rawBody);
  const make = (event: string, entityHint: PosEntity | null, data: any, fields: Fields, key: string): PosWebhookEvent => ({
    integrationType: type,
    event,
    entity: entityHint || posEntityOf(event),
    ...fields,
    data,
    dedupeKey: `${type}:${event}:${key}`,
  });

  switch (type) {
    case 'kiotviet': {
      const notifications: any[] = Array.isArray(body?.Notifications) ? body.Notifications : [];
      const delivery = first(body?.Id);
      const events: PosWebhookEvent[] = [];
      for (const note of notifications) {
        // The action may include a store id (order.update.<retailerId>) → drop the trailing number
        const event = override || str(note?.Action).replace(/\.\d+$/, '');
        const entity = posEntityOf(event);
        const items: any[] = Array.isArray(note?.Data) ? note.Data : note?.Data !== undefined ? [note.Data] : [];
        for (const item of items) {
          const data = item && typeof item === 'object' ? item : { Id: item };
          events.push(make(event, entity, data, kiotVietFields(data, entity), `${delivery}:${digest(JSON.stringify(data))}`));
        }
      }
      return { events };
    }
    case 'haravan':
    case 'sapo': {
      const header = type === 'haravan' ? 'x-haravan-topic' : 'x-sapo-topic';
      const event = override || first(headerValue(input.headers, header), body?.topic);
      const entity = event ? posEntityOf(event) : shopifyLikeEntity(body);
      const delivery = first(headerValue(input.headers, type === 'haravan' ? 'x-haravan-webhook-id' : 'x-sapo-webhook-id')) || bodyHash;
      return { events: [make(event, entity, body, shopifyLikeFields(body, entity), delivery)] };
    }
    case 'nhanh': {
      // The test ping when webhooks are enabled in the Nhanh.vn app: just return 200
      if (str(body?.event) === 'webhooksEnabled') return { events: [], ping: true };
      const event = override || str(body?.event);
      const data = parseJsonMaybe(body?.data);
      const items: any[] = Array.isArray(data) ? data : [data ?? {}];
      return {
        events: items.map((item, i) => {
          const record = item && typeof item === 'object' ? item : { id: item };
          return make(event, null, record, nhanhFields(record), `${bodyHash}:${i}`);
        }),
      };
    }
    case 'pancake': {
      const shape = pancakeShape(body);
      const event = override || shape.event;
      return { events: [make(event, override ? null : shape.entity, shape.data, pancakeFields(shape.data), bodyHash)] };
    }
    default:
      return { events: [] };
  }
}

// ─── Trigger filters ─────────────────────────────────────────────────────────

/** Case-insensitive matching; NFC so that accented text typed in Deplao matches the platform data (precomposed / combining forms). */
const fold = (value: unknown): string => String(value ?? '').normalize('NFC').toLowerCase();

function textList(value: unknown): string[] {
  return fold(value).split(',').map(part => part.trim()).filter(Boolean);
}

/**
 * Filters of the trigger "When the sales software sends a webhook": platform, specific connection, data type, event name contains,
 * status contains (several words separated by commas = matches any one of them, case-insensitive). Empty = no filter.
 */
export function matchesPosWebhookTrigger(cfg: Record<string, any> | null | undefined, event: Record<string, any> | null | undefined): boolean {
  const c = cfg || {};
  const e = event || {};
  if (c.integrationType && c.integrationType !== 'all' && e.integrationType !== c.integrationType) return false;
  if (c.integrationId && e.integrationId !== c.integrationId) return false;
  if (c.entity && c.entity !== 'all' && e.entity !== c.entity) return false;
  const events = textList(c.eventContains);
  if (events.length && !events.some(word => fold(e.event).includes(word))) return false;
  const statuses = textList(c.statusContains);
  if (statuses.length && !statuses.some(word => fold(e.status).includes(word))) return false;
  return true;
}
