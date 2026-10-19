/**
 * posWebhook — webhook của phần mềm bán hàng (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS): xác thực + chuẩn hoá thành
 * sự kiện của trigger "Khi phần mềm bán hàng gửi webhook" (trigger.posWebhook). Thuần (không Electron) để test.
 *
 * Khác webhook thanh toán (paymentWebhook.ts): BẮT BUỘC khoá xác thực — chưa đặt khoá trong Deplao hoặc chữ ký / token sai
 * thì từ chối (401) và không chạy workflow, vì workflow dùng dữ liệu này để nhắn khách, tạo vận đơn…
 *
 * KiotViet (kiotviet.vn → Public API → 2.11 Webhook): đăng ký bằng API POST /webhooks, Secret = chuỗi ngẫu nhiên ≥ 8 ký tự đã
 *   mã hoá Base64; KiotViet gửi `X-Hub-Signature` = HMAC-SHA256(body, Secret). Tài liệu không ghi dạng chữ ký → nhận hex hoặc
 *   base64, có / không "sha256=", khoá là chuỗi Base64 như đã đăng ký hoặc bytes sau giải mã. Body
 *   { Id, Attempt, Notifications: [{ Action, Data: [...] }] }, Id giữ nguyên qua các lần gửi lại. Trả 4xx thì KiotViet ngừng
 *   gửi tới địa chỉ đó (tài liệu vẫn yêu cầu 401 khi sai chữ ký).
 * Haravan (docs.haravan.com → Webhooks; github.com/Haravan/haravan-validate): `X-Haravan-Hmacsha256` =
 *   base64(HMAC-SHA256(body, secret)); secret = mã xác thực ở Cài đặt → Thông báo → Webhook (webhook riêng) hoặc Client
 *   Secret của app. Topic (orders/create…) ở header `X-Haravan-Topic`.
 * Sapo (support.sapo.vn/sapo-webhook, cùng cách Shopify; connector mona-software/monapay-sapo): `X-Sapo-Hmac-Sha256` =
 *   base64(HMAC-SHA256(body, API Secret của ứng dụng riêng)) → chưa đặt khoá riêng thì dùng ô API Secret. Topic ở header
 *   `X-Sapo-Topic`.
 * Nhanh.vn v3 (apidocs.nhanh.vn/v3/webhooks/webhooks): header `Authorization: <Webhooks verify token>` (token tự đặt);
 *   body { event, businessId, data } (data có thể là chuỗi JSON). `webhooksEnabled` là lượt kiểm tra → trả 200, không chạy
 *   workflow. Webhook v2 cũ để token trong body `webhooksVerifyToken` — vẫn nhận.
 * Pancake POS (docs.pancake.biz/pos/api → Cấu hình Webhook): không ký nội dung; khai báo Request Headers khi cấu hình webhook →
 *   Deplao đọc header `X-API-KEY` (hoặc Authorization) = khoá đã đặt. Body là đơn / khách hàng (object gốc) hoặc
 *   { data: { record } } (sản phẩm, tồn kho), không có tên sự kiện → suy từ dạng dữ liệu.
 * Nền tảng không gửi tên sự kiện thì thêm `?event=<tên>` vào địa chỉ nhận (vd. Sapo đăng ký mỗi topic một địa chỉ).
 */
import * as crypto from 'crypto';
import { WebhookHeaders, headerValue, safeEqual } from './paymentWebhook';

export type PosWebhookType = 'kiotviet' | 'haravan' | 'sapo' | 'nhanh' | 'pancake';
export const POS_WEBHOOK_TYPES: readonly PosWebhookType[] = ['kiotviet', 'haravan', 'sapo', 'nhanh', 'pancake'];

export function isPosWebhookType(type: unknown): type is PosWebhookType {
  return (POS_WEBHOOK_TYPES as readonly string[]).includes(String(type));
}

/** Ô credential chứa khoá xác thực webhook của kết nối POS. */
export const POS_WEBHOOK_SECRET_FIELD = 'webhookSecret';

/** Khoá dùng để xác thực webhook: ô "Khoá xác thực webhook"; Sapo chưa đặt thì dùng API Secret (Sapo ký bằng khoá này). */
export function posWebhookSecret(type: PosWebhookType, credentials: Record<string, any> | null | undefined): string {
  const own = String(credentials?.[POS_WEBHOOK_SECRET_FIELD] ?? '').trim();
  if (own) return own;
  return type === 'sapo' ? String(credentials?.apiSecret ?? '').trim() : '';
}

/** Nhóm dữ liệu của sự kiện — bộ lọc "Loại dữ liệu" của trigger. */
export type PosEntity = 'order' | 'invoice' | 'customer' | 'product' | 'inventory' | 'other';

export interface PosWebhookRequest {
  headers: WebhookHeaders;
  /** Body đúng từng byte nhận được — chữ ký HMAC tính trên bytes này. */
  rawBody: Buffer;
  /** Body đã đọc (JSON). */
  body: any;
}

export type PosWebhookAuth =
  | { ok: true; message: string }
  | { ok: false; reason: 'no_secret' | 'missing_signature' | 'invalid_signature'; message: string };

/** Một sự kiện (một đơn / khách / sản phẩm…) phát cho workflow — event 'integration:posWebhook'. */
export interface PosWebhookEvent {
  integrationType: PosWebhookType;
  /** Tên sự kiện của nền tảng: order.update (KiotViet), orders/paid (Haravan, Sapo), orderUpdate (Nhanh.vn), orders (Pancake). */
  event: string;
  entity: PosEntity;
  /** Trường hay dùng, '' khi nền tảng không gửi. */
  code: string;
  status: string;
  customerName: string;
  customerPhone: string;
  total: string;
  /** Bản ghi gốc của nền tảng. */
  data: any;
  /** Khoá chống trùng khi nền tảng gửi lại cùng sự kiện. */
  dedupeKey: string;
}

export interface ParsedPosWebhook {
  events: PosWebhookEvent[];
  /** Lượt kiểm tra của nền tảng (Nhanh.vn webhooksEnabled): trả 200, không chạy workflow. */
  ping?: boolean;
}

// ─── Xác thực ────────────────────────────────────────────────────────────────

const NO_SECRET_MESSAGE = 'Chưa đặt khoá xác thực webhook trong Deplao — webhook bị từ chối, không chạy workflow';

const rejected = (reason: 'missing_signature' | 'invalid_signature', message: string): PosWebhookAuth => ({ ok: false, reason, message });

function hmacSha256(key: Buffer, raw: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(raw).digest();
}

/** Giá trị header Authorization / X-API-KEY, bỏ tiền tố "Bearer ". */
function tokenHeader(headers: WebhookHeaders, name: string): string {
  return headerValue(headers, name).replace(/^bearer\s+/i, '').trim();
}

function verifyKiotViet(req: PosWebhookRequest, secret: string): PosWebhookAuth {
  const header = headerValue(req.headers, 'x-hub-signature');
  if (!header) return rejected('missing_signature', 'Thiếu header X-Hub-Signature — đăng ký webhook KiotViet kèm Secret');
  const given = header.replace(/^sha256=/i, '').trim();
  const keys = [Buffer.from(secret, 'utf8')];
  // Secret đăng ký với KiotViet là chuỗi Base64 → thử cả bytes sau giải mã
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(secret) && secret.length % 4 === 0) {
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length > 0) keys.push(decoded);
  }
  for (const key of keys) {
    const mac = hmacSha256(key, req.rawBody);
    if (safeEqual(mac.toString('hex'), given.toLowerCase()) || safeEqual(mac.toString('base64'), given)) {
      return { ok: true, message: 'Đã nhận — chữ ký X-Hub-Signature hợp lệ' };
    }
  }
  return rejected('invalid_signature', 'Chữ ký X-Hub-Signature không khớp Secret đã đăng ký với KiotViet');
}

function verifyBase64Hmac(req: PosWebhookRequest, secret: string, header: string, label: string): PosWebhookAuth {
  const given = headerValue(req.headers, header);
  if (!given) return rejected('missing_signature', `Thiếu header ${label}`);
  const mac = hmacSha256(Buffer.from(secret, 'utf8'), req.rawBody).toString('base64');
  return safeEqual(mac, given)
    ? { ok: true, message: `Đã nhận — chữ ký ${label} hợp lệ` }
    : rejected('invalid_signature', `Chữ ký ${label} không khớp khoá xác thực`);
}

function verifyNhanh(req: PosWebhookRequest, secret: string): PosWebhookAuth {
  const bodyToken = typeof req.body?.webhooksVerifyToken === 'string' ? req.body.webhooksVerifyToken.trim() : '';
  const token = tokenHeader(req.headers, 'authorization') || bodyToken;
  if (!token) return rejected('missing_signature', 'Thiếu Webhooks verify token (header Authorization)');
  return safeEqual(token, secret)
    ? { ok: true, message: 'Đã nhận — Webhooks verify token hợp lệ' }
    : rejected('invalid_signature', 'Webhooks verify token không khớp');
}

function verifyPancake(req: PosWebhookRequest, secret: string): PosWebhookAuth {
  const token = tokenHeader(req.headers, 'x-api-key') || tokenHeader(req.headers, 'authorization');
  if (!token) return rejected('missing_signature', 'Thiếu header X-API-KEY — khai báo ở Request Headers khi cấu hình webhook Pancake');
  return safeEqual(token, secret)
    ? { ok: true, message: 'Đã nhận — header X-API-KEY hợp lệ' }
    : rejected('invalid_signature', 'Header X-API-KEY không khớp khoá xác thực');
}

/** Xác thực webhook POS. Chưa có khoá → từ chối (no_secret): webhook POS không bao giờ chạy workflow khi chưa xác thực được. */
export function verifyPosWebhook(type: PosWebhookType, req: PosWebhookRequest, secret: unknown): PosWebhookAuth {
  const key = typeof secret === 'string' ? secret.trim() : '';
  if (!key) return { ok: false, reason: 'no_secret', message: NO_SECRET_MESSAGE };
  switch (type) {
    case 'kiotviet': return verifyKiotViet(req, key);
    case 'haravan': return verifyBase64Hmac(req, key, 'x-haravan-hmacsha256', 'X-Haravan-Hmacsha256');
    case 'sapo': return verifyBase64Hmac(req, key, 'x-sapo-hmac-sha256', 'X-Sapo-Hmac-Sha256');
    case 'nhanh': return verifyNhanh(req, key);
    case 'pancake': return verifyPancake(req, key);
    default: return rejected('invalid_signature', 'Loại tích hợp không nhận webhook');
  }
}

// ─── Chuẩn hoá ───────────────────────────────────────────────────────────────

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return '';
}

/** Nhóm dữ liệu theo tên sự kiện (order.update, orders/paid, orderAdd, variations_warehouses…). */
export function posEntityOf(event: string): PosEntity {
  const e = event.toLowerCase();
  if (/invoice/.test(e)) return 'invoice';
  if (/order|fulfillment|refund|transaction/.test(e)) return 'order';
  if (/customer/.test(e)) return 'customer';
  if (/stock|inventory|warehouse/.test(e)) return 'inventory';
  if (/product|variation|pricebook|collection|categor/.test(e)) return 'product';
  return 'other';
}

/** Trạng thái đơn Nhanh.vn (mã số) — cùng bảng với Tích hợp nhanh. */
const NHANH_ORDER_STATUS: Record<number, string> = {
  1: 'Mới', 3: 'Xác nhận', 5: 'Đang đóng gói', 7: 'Đóng gói xong', 9: 'Đang giao hàng', 11: 'Giao thành công',
  13: 'Hoàn tất', 15: 'Đã hủy', 42: 'Đã đóng gói', 54: 'Chờ xác nhận', 59: 'Trả hàng', 64: 'Đã hủy', 68: 'Đã hủy', 72: 'Đã giao',
};

function personName(person: any): string {
  if (!person || typeof person !== 'object') return '';
  return first(person.name, [person.first_name, person.last_name].map(str).filter(Boolean).join(' '), person.full_name);
}

type Fields = Pick<PosWebhookEvent, 'code' | 'status' | 'customerName' | 'customerPhone' | 'total'>;

/** KiotViet: tên trường viết hoa (Code, StatusValue, CustomerName, ContactNumber, Total…). */
function kiotVietFields(d: any, entity: PosEntity): Fields {
  return {
    code: first(d?.Code, d?.Id),
    status: first(d?.StatusValue, d?.Status),
    customerName: first(d?.CustomerName, entity === 'customer' ? d?.Name : '', d?.InvoiceDelivery?.Receiver),
    customerPhone: first(d?.ContactNumber, d?.InvoiceDelivery?.ContactNumber),
    total: first(d?.Total),
  };
}

/** Haravan / Sapo (dạng Shopify): name (#1001), financial_status / fulfillment_status, total_price, địa chỉ, customer. */
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

/** Nhanh.vn v3: đơn { info: { id, status }, shippingAddress: { name, mobile }, payment }, khách hàng { name, mobile }. */
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

/** Pancake POS: đơn (bill_full_name, bill_phone_number, status_name, total_price), khách (name, phone_numbers). */
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

/** Pancake không gửi tên sự kiện: suy từ dạng dữ liệu (đơn / khách hàng / { data: { record } } sản phẩm, tồn kho). */
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
  /** Tên sự kiện đặt qua `?event=` ở địa chỉ nhận (khi nền tảng không gửi). */
  eventOverride?: string;
}

const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Haravan / Sapo không gửi topic (thiếu header, không có ?event=) → đoán theo dạng dữ liệu. */
function shopifyLikeEntity(body: any): PosEntity {
  if (Array.isArray(body?.line_items)) return 'order';
  if (body?.orders_count !== undefined) return 'customer';
  if (Array.isArray(body?.variants)) return 'product';
  return 'other';
}

/**
 * Body webhook → các sự kiện cho workflow (KiotViet gửi nhiều bản ghi trong một lần → mỗi bản ghi một sự kiện).
 * Khoá chống trùng = loại + tên sự kiện + id lần gửi (header webhook id của Haravan / Sapo nếu có) hoặc băm SHA-256 của body;
 * KiotViet: Id + băm từng bản ghi (lần gửi lại chỉ đổi Attempt).
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
        // Action có thể kèm id cửa hàng (order.update.<retailerId>) → bỏ phần số cuối
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
      // Lượt kiểm tra khi bật webhook trong ứng dụng Nhanh.vn — chỉ cần trả 200
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

// ─── Bộ lọc trigger ──────────────────────────────────────────────────────────

/** So khớp không phân biệt hoa / thường; NFC để chữ có dấu gõ trong Deplao khớp dữ liệu nền tảng (dựng sẵn / tổ hợp). */
const fold = (value: unknown): string => String(value ?? '').normalize('NFC').toLowerCase();

function textList(value: unknown): string[] {
  return fold(value).split(',').map(part => part.trim()).filter(Boolean);
}

/**
 * Bộ lọc của trigger "Khi phần mềm bán hàng gửi webhook": nền tảng, kết nối cụ thể, loại dữ liệu, tên sự kiện chứa,
 * trạng thái chứa (nhiều từ cách nhau dấu phẩy = khớp một trong các từ, không phân biệt hoa / thường). Trống = không lọc.
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
