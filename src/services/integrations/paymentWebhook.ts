/**
 * paymentWebhook — xác thực + chuẩn hoá webhook thanh toán Casso / SePay. Thuần (không Electron) để test được.
 *
 * Casso (developer.casso.vn → Thiết lập Webhook thủ công; mẫu chính thức github.com/CassoHQ/casso-webhook-v2-verify-signature):
 *   - Webhook V2: header `X-Casso-Signature: t=<ms>,v1=<hex>`, v1 = HMAC-SHA512(Key bảo mật, `${t}.${JSON body sắp khoá A→Z}`).
 *     Casso ký trên JSON đã sắp xếp lại chứ không phải bytes gốc (curl mẫu của Casso gửi body thụt lề mà chữ ký vẫn khớp bản
 *     gọn) → dựng lại đúng chuỗi đó; thử thêm dạng thoát ký tự ngoài ASCII như mẫu PHP / Python của Casso.
 *   - Webhook (cũ): header `secure-token` = Key bảo mật.
 *   - Body: V2 `data` là một object, bản cũ `data` là mảng; amount âm = tiền ra.
 * SePay (developer.sepay.vn → Xác thực webhook):
 *   - HMAC-SHA256: `X-SePay-Signature: sha256=<hex>` + `X-SePay-Timestamp: <giây>`, ký `${timestamp}.${body}` trên bytes gốc
 *     của body; lệch giờ tối đa 5 phút.
 *   - API Key: `Authorization: Apikey <key>`. OAuth 2.0 không hỗ trợ (Deplao không có token endpoint).
 *   - Body: một giao dịch; transferType 'in' | 'out', transferAmount luôn dương.
 * Đã đặt khoá trong Deplao → bắt buộc chữ ký / khoá hợp lệ. Chưa đặt → vẫn nhận (method 'none'), UI cảnh báo nên đặt khoá.
 */
import * as crypto from 'crypto';

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface WebhookRequest {
  /** Header của request (Node đã đổi tên header về chữ thường; vẫn so khớp không phân biệt hoa thường). */
  headers: WebhookHeaders;
  /** Body đúng từng byte nhận được — chữ ký SePay tính trên bytes này. */
  rawBody: Buffer;
  /** Body đã đọc (JSON hoặc form), {} khi rỗng. */
  body: any;
  /** Thời điểm nhận (ms) — test truyền vào. */
  now?: number;
}

export type WebhookAuthMethod = 'casso-signature' | 'casso-token' | 'sepay-signature' | 'sepay-apikey' | 'none';
export type WebhookRejectReason = 'missing_signature' | 'invalid_signature' | 'stale_timestamp' | 'unsupported_auth';

export type WebhookAuthResult =
  | { ok: true; method: WebhookAuthMethod }
  | { ok: false; reason: WebhookRejectReason; message: string };

/** Giao dịch đã chuẩn hoá — cùng dạng cho Casso và SePay (event 'integration:payment' → `payment`). */
export interface PaymentTransaction {
  /** id của Casso / SePay — không đổi qua các lần gửi lại, dùng chống trùng. */
  transactionId: string;
  /** Mã giao dịch phía ngân hàng. */
  reference: string;
  /** Số tiền (VNĐ), luôn dương — chiều nằm ở `direction`. */
  amount: number;
  direction: 'in' | 'out';
  /** Nội dung chuyển khoản. */
  description: string;
  /** SePay: mô tả đầy đủ từ ngân hàng (có thể rỗng); Casso: ''. */
  bankDescription: string;
  bankName: string;
  accountNumber: string;
  virtualAccount: string;
  counterAccountName: string;
  counterAccountNumber: string;
  counterBankName: string;
  transactionDate: string;
  /** SePay: mã thanh toán SePay nhận diện được ('' nếu không có). */
  code: string;
}

export interface ParsedPayment {
  tx: PaymentTransaction;
  /** Object giao dịch gốc của nhà cung cấp. */
  raw: any;
}

/** Adapter nhận webhook có xác thực (Casso, SePay). */
export interface WebhookCapableAdapter {
  /** Đã đặt khoá bảo mật webhook trong Deplao chưa (chưa → nhận không xác thực, UI cảnh báo). */
  hasWebhookSecret(): boolean;
  verifyWebhook(req: WebhookRequest): WebhookAuthResult;
  parseWebhook(body: any): ParsedPayment[];
}

export function isWebhookCapable(adapter: unknown): adapter is WebhookCapableAdapter {
  const a = adapter as Partial<WebhookCapableAdapter> | null | undefined;
  return !!a
    && typeof a.hasWebhookSecret === 'function'
    && typeof a.verifyWebhook === 'function'
    && typeof a.parseWebhook === 'function';
}

/** Ô credential chứa khoá bảo mật webhook của từng loại tích hợp. */
export const WEBHOOK_SECRET_CREDENTIAL: Readonly<Record<string, string>> = { casso: 'secretKey', sepay: 'webhookSecretKey' };

/** Webhook thanh toán chỉ vài trăm byte — giới hạn để không ai đẩy body khổng lồ vào RAM qua địa chỉ Internet. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/** SePay khuyến nghị từ chối chữ ký lệch quá 5 phút (chống phát lại). */
export const SEPAY_MAX_SKEW_MS = 5 * 60_000;

export function headerValue(headers: WebhookHeaders, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return String(Array.isArray(value) ? value[0] ?? '' : value).trim();
  }
  return '';
}

/** So sánh không lộ thời gian; băm trước nên độ dài khác nhau cũng không thoát sớm. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function cleanSecret(secret: unknown): string {
  return typeof secret === 'string' ? secret.trim() : '';
}

function rejected(reason: WebhookRejectReason, message: string): WebhookAuthResult {
  return { ok: false, reason, message };
}

function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** json_encode (PHP) / json.dumps (Python) mặc định thoát ký tự ngoài ASCII thành mã 4 chữ số hex thường. */
function escapeNonAscii(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code > 0x7f ? '\\u' + code.toString(16).padStart(4, '0') : json[i];
  }
  return out;
}

function parseCassoSignature(header: string): { t: string; v1: string } | null {
  let t = '';
  let v1 = '';
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (name === 't') t = value;
    else if (name === 'v1') v1 = value.toLowerCase();
  }
  // v1 = HMAC-SHA512 dạng hex = 128 ký tự
  if (!/^[0-9]{1,16}$/.test(t) || !/^[0-9a-f]{128}$/.test(v1)) return null;
  // Mẫu của Casso parseInt(t) trước khi ghép chuỗi ký
  return { t: String(parseInt(t, 10)), v1 };
}

export function verifyCassoWebhook(req: WebhookRequest, secret: unknown): WebhookAuthResult {
  const key = cleanSecret(secret);
  if (!key) return { ok: true, method: 'none' };

  const signature = headerValue(req.headers, 'x-casso-signature');
  if (signature) {
    const parsed = parseCassoSignature(signature);
    if (!parsed) return rejected('invalid_signature', 'X-Casso-Signature sai định dạng (cần t=…,v1=…)');
    if (!req.body || typeof req.body !== 'object') return rejected('invalid_signature', 'Body webhook Casso không phải JSON');
    const json = JSON.stringify(sortKeysDeep(req.body));
    for (const candidate of new Set([json, escapeNonAscii(json)])) {
      const mac = crypto.createHmac('sha512', key).update(`${parsed.t}.${candidate}`, 'utf8').digest('hex');
      if (safeEqual(mac, parsed.v1)) return { ok: true, method: 'casso-signature' };
    }
    return rejected('invalid_signature', 'Chữ ký X-Casso-Signature không khớp Key bảo mật');
  }

  const token = headerValue(req.headers, 'secure-token');
  if (token) {
    return safeEqual(token, key)
      ? { ok: true, method: 'casso-token' }
      : rejected('invalid_signature', 'secure-token không khớp Key bảo mật');
  }
  return rejected('missing_signature', 'Thiếu chữ ký (X-Casso-Signature của Webhook V2 hoặc secure-token của Webhook cũ)');
}

export function verifySePayWebhook(req: WebhookRequest, secret: unknown): WebhookAuthResult {
  // Người dùng có thể dán cả giá trị header "Apikey xxx"
  const key = cleanSecret(secret).replace(/^apikey\s+/i, '');
  if (!key) return { ok: true, method: 'none' };

  const signature = headerValue(req.headers, 'x-sepay-signature');
  if (signature) {
    const timestamp = headerValue(req.headers, 'x-sepay-timestamp');
    if (!/^[0-9]{1,12}$/.test(timestamp)) return rejected('invalid_signature', 'Thiếu X-SePay-Timestamp');
    const now = req.now ?? Date.now();
    if (Math.abs(now - Number(timestamp) * 1000) > SEPAY_MAX_SKEW_MS) {
      return rejected('stale_timestamp', 'X-SePay-Timestamp lệch quá 5 phút — kiểm tra đồng hồ máy');
    }
    const mac = crypto.createHmac('sha256', key).update(`${timestamp}.`, 'utf8').update(req.rawBody).digest('hex');
    const given = signature.replace(/^sha256=/i, '').trim().toLowerCase();
    return safeEqual(mac, given)
      ? { ok: true, method: 'sepay-signature' }
      : rejected('invalid_signature', 'Chữ ký X-SePay-Signature không khớp Secret Key');
  }

  const authorization = headerValue(req.headers, 'authorization');
  const apiKey = /^apikey\s+(.+)$/i.exec(authorization);
  if (apiKey) {
    return safeEqual(apiKey[1].trim(), key)
      ? { ok: true, method: 'sepay-apikey' }
      : rejected('invalid_signature', 'API Key trong header Authorization không khớp');
  }
  if (/^bearer\s/i.test(authorization)) {
    return rejected('unsupported_auth', 'Webhook SePay đang dùng OAuth 2.0 — hãy chọn HMAC-SHA256 hoặc API Key');
  }
  return rejected('missing_signature', 'Thiếu chữ ký (X-SePay-Signature hoặc Authorization: Apikey)');
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

const EMPTY_TX: PaymentTransaction = {
  transactionId: '', reference: '', amount: 0, direction: 'in', description: '', bankDescription: '', bankName: '',
  accountNumber: '', virtualAccount: '', counterAccountName: '', counterAccountNumber: '', counterBankName: '',
  transactionDate: '', code: '',
};

function cassoTransaction(item: any): PaymentTransaction | null {
  if (!item || typeof item !== 'object') return null;
  const amount = Number(item.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    ...EMPTY_TX,
    transactionId: str(item.id),
    reference: str(item.reference ?? item.tid),
    amount: Math.abs(amount),
    direction: amount < 0 ? 'out' : 'in',
    description: str(item.description),
    bankName: str(item.bankName),
    accountNumber: str(item.accountNumber ?? item.bank_sub_acc_id ?? item.subAccId),
    virtualAccount: str(item.virtualAccountNumber ?? item.virtualAccount),
    counterAccountName: str(item.counterAccountName ?? item.corresponsiveName),
    counterAccountNumber: str(item.counterAccountNumber ?? item.corresponsiveAccount),
    counterBankName: str(item.counterAccountBankName ?? item.corresponsiveBankName),
    transactionDate: str(item.transactionDateTime ?? item.when),
  };
}

/** Casso: V2 `data` = một giao dịch, Webhook cũ `data` = mảng; `error` khác 0 = không có giao dịch. */
export function parseCassoPayload(body: any): ParsedPayment[] {
  if (!body || typeof body !== 'object') return [];
  if (body.error !== undefined && body.error !== null && Number(body.error) !== 0) return [];
  const items = Array.isArray(body.data) ? body.data : body.data && typeof body.data === 'object' ? [body.data] : [];
  const out: ParsedPayment[] = [];
  for (const item of items) {
    const tx = cassoTransaction(item);
    if (tx) out.push({ tx, raw: item });
  }
  return out;
}

/** SePay: body là một giao dịch. */
export function parseSePayPayload(body: any): ParsedPayment[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const amount = Number(body.transferAmount ?? body.amount);
  if (!Number.isFinite(amount)) return [];
  const tx: PaymentTransaction = {
    ...EMPTY_TX,
    transactionId: str(body.id),
    reference: str(body.referenceCode),
    amount: Math.abs(amount),
    direction: str(body.transferType).toLowerCase() === 'out' || amount < 0 ? 'out' : 'in',
    description: str(body.content) || str(body.description),
    bankDescription: str(body.description),
    bankName: str(body.gateway),
    accountNumber: str(body.accountNumber),
    virtualAccount: str(body.subAccount),
    transactionDate: str(body.transactionDate),
    code: str(body.code),
  };
  return [{ tx, raw: body }];
}

/**
 * Giao dịch trong event 'integration:payment': bản đã chuẩn hoá (`payment`) hoặc — event cũ / nơi khác phát —
 * đọc từ `transaction` (SePay: transferAmount/transferType; còn lại: amount âm = tiền ra).
 */
export function paymentFromEvent(data: any): PaymentTransaction {
  const payment = data?.payment;
  if (payment && typeof payment === 'object' && typeof payment.amount === 'number') return { ...EMPTY_TX, ...payment };
  const tx = data?.transaction && typeof data.transaction === 'object' ? data.transaction : data || {};
  if (tx.transferAmount !== undefined || tx.transferType !== undefined) {
    const sepay = parseSePayPayload(tx)[0];
    if (sepay) return sepay.tx;
  }
  const amount = Number(tx.amount ?? tx.in ?? 0) || 0;
  return {
    ...EMPTY_TX,
    transactionId: str(tx.id ?? tx.transaction_id ?? tx.tid),
    reference: str(tx.reference ?? tx.tid),
    amount: Math.abs(amount),
    direction: amount < 0 ? 'out' : 'in',
    description: str(tx.description || tx.memo || tx.content),
    bankName: str(tx.bankName ?? tx.bank_name),
    accountNumber: str(tx.accountNumber ?? tx.bank_acc_id ?? tx.bank_sub_acc_id),
    transactionDate: str(tx.when ?? tx.transactionDateTime ?? tx.transactionDate ?? tx.created_at),
  };
}

/** Đọc body: JSON (mặc định) hoặc form-urlencoded (SePay cho chọn). Body hỏng → ném lỗi. */
export function parseWebhookBody(rawBody: Buffer, contentType = ''): any {
  const text = rawBody.toString('utf8').trim();
  if (!text) return {};
  if (/application\/x-www-form-urlencoded/i.test(contentType)) return Object.fromEntries(new URLSearchParams(text));
  return JSON.parse(text);
}

/** Gom body request, dừng khi vượt `maxBytes` (lỗi code 'BODY_TOO_LARGE'). */
export function readRequestBody(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        finish(Object.assign(new Error('Payload too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish(null);
    const onError = (error: Error) => finish(error);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/** Khoá đã gặp gần đây (TTL + giới hạn số lượng) — chống xử lý một giao dịch hai lần khi bị gửi lại / phát lại. */
export class RecentKeys {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly ttlMs = 48 * 3_600_000, private readonly maxEntries = 5_000) {}

  /** true = đã gặp trong TTL (bỏ qua); false = lần đầu (đã ghi nhớ). */
  seen(key: string, now = Date.now()): boolean {
    const expires = this.expiresAt.get(key);
    if (expires !== undefined && expires > now) return true;
    this.expiresAt.delete(key);
    this.expiresAt.set(key, now + this.ttlMs);
    while (this.expiresAt.size > this.maxEntries) {
      const oldest = this.expiresAt.keys().next().value;
      if (oldest === undefined) break;
      this.expiresAt.delete(oldest);
    }
    return false;
  }

  clear(): void {
    this.expiresAt.clear();
  }
}
