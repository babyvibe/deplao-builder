/**
 * paymentWebhook: verifies + normalizes Casso / SePay payment webhooks. Pure (no Electron), so it can be tested.
 *
 * Casso (developer.casso.vn → manual Webhook setup; official sample github.com/CassoHQ/casso-webhook-v2-verify-signature):
 *   - Webhook V2: header `X-Casso-Signature: t=<ms>,v1=<hex>`, v1 = HMAC-SHA512(Security key, `${t}.${JSON body with keys sorted A→Z}`).
 *     Casso signs the re-sorted JSON, not the original bytes (Casso's curl sample sends an indented body but the signature still matches the
 *     compact form) → rebuild exactly that string; also try the non-ASCII escaped form, as in Casso's PHP / Python samples.
 *   - Webhook (old): header `secure-token` = Security key.
 *   - Body: V2 `data` is an object, the old version's `data` is an array; a negative amount = money out.
 * SePay (developer.sepay.vn → Webhook authentication):
 *   - HMAC-SHA256: `X-SePay-Signature: sha256=<hex>` + `X-SePay-Timestamp: <seconds>`, signed over `${timestamp}.${body}` using the raw bytes
 *     of the body; clock skew up to 5 minutes.
 *   - API Key: `Authorization: Apikey <key>`. OAuth 2.0 is not supported (Deplao has no token endpoint).
 *   - Body: one transaction; transferType 'in' | 'out', transferAmount is always positive.
 * Once a key is set in Deplao → a valid signature / key is required. Not set → still accepted (method 'none'), the UI warns to set a key.
 */
import * as crypto from 'crypto';
import { tr } from '../../shared/i18n';

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface WebhookRequest {
  /** Request headers (Node has lowercased the header names; matching is still case-insensitive). */
  headers: WebhookHeaders;
  /** Body exactly as received, byte for byte: the SePay signature is computed over these bytes. */
  rawBody: Buffer;
  /** Body that was read (JSON or form), {} when empty. */
  body: any;
  /** Time of receipt (ms), passed in by tests. */
  now?: number;
}

export type WebhookAuthMethod = 'casso-signature' | 'casso-token' | 'sepay-signature' | 'sepay-apikey' | 'none';
export type WebhookRejectReason = 'missing_signature' | 'invalid_signature' | 'stale_timestamp' | 'unsupported_auth';

export type WebhookAuthResult =
  | { ok: true; method: WebhookAuthMethod }
  | { ok: false; reason: WebhookRejectReason; message: string };

/** Normalized transaction: the same shape for Casso and SePay (event 'integration:payment' → `payment`). */
export interface PaymentTransaction {
  /** Casso / SePay id: unchanged across resends, used for de-duplication. */
  transactionId: string;
  /** Transaction code on the bank side. */
  reference: string;
  /** Amount (VND), always positive: the direction is in `direction`. */
  amount: number;
  direction: 'in' | 'out';
  /** Transfer description. */
  description: string;
  /** SePay: full description from the bank (may be empty); Casso: ''. */
  bankDescription: string;
  bankName: string;
  accountNumber: string;
  virtualAccount: string;
  counterAccountName: string;
  counterAccountNumber: string;
  counterBankName: string;
  transactionDate: string;
  /** SePay: the SePay payment code it recognized ('' if none). */
  code: string;
}

export interface ParsedPayment {
  tx: PaymentTransaction;
  /** The provider's original transaction object. */
  raw: any;
}

/** Adapter that receives authenticated webhooks (Casso, SePay). */
export interface WebhookCapableAdapter {
  /** Whether a webhook security key is set in Deplao (not set → accepted without verification, the UI warns). */
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

/** Credential field holding the webhook security key of each integration type. */
export const WEBHOOK_SECRET_CREDENTIAL: Readonly<Record<string, string>> = { casso: 'secretKey', sepay: 'webhookSecretKey' };

/** Payment webhooks are only a few hundred bytes: the limit stops anyone from pushing a huge body into RAM through the Internet address. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/** SePay recommends rejecting signatures more than 5 minutes off (anti-replay). */
export const SEPAY_MAX_SKEW_MS = 5 * 60_000;

export function headerValue(headers: WebhookHeaders, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return String(Array.isArray(value) ? value[0] ?? '' : value).trim();
  }
  return '';
}

/** Constant-time comparison; hashed first, so different lengths do not exit early. */
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

/** json_encode (PHP) / json.dumps (Python) escape non-ASCII characters by default as lowercase 4-digit hex codes. */
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
  // v1 = HMAC-SHA512 in hex = 128 characters
  if (!/^[0-9]{1,16}$/.test(t) || !/^[0-9a-f]{128}$/.test(v1)) return null;
  // Casso's sample calls parseInt(t) before building the signed string
  return { t: String(parseInt(t, 10)), v1 };
}

export function verifyCassoWebhook(req: WebhookRequest, secret: unknown): WebhookAuthResult {
  const key = cleanSecret(secret);
  if (!key) return { ok: true, method: 'none' };

  const signature = headerValue(req.headers, 'x-casso-signature');
  if (signature) {
    const parsed = parseCassoSignature(signature);
    if (!parsed) return rejected('invalid_signature', tr('X-Casso-Signature sai định dạng (cần t=…,v1=…)'));
    if (!req.body || typeof req.body !== 'object') return rejected('invalid_signature', tr('Body webhook Casso không phải JSON'));
    const json = JSON.stringify(sortKeysDeep(req.body));
    for (const candidate of new Set([json, escapeNonAscii(json)])) {
      const mac = crypto.createHmac('sha512', key).update(`${parsed.t}.${candidate}`, 'utf8').digest('hex');
      if (safeEqual(mac, parsed.v1)) return { ok: true, method: 'casso-signature' };
    }
    return rejected('invalid_signature', tr('Chữ ký X-Casso-Signature không khớp Key bảo mật'));
  }

  const token = headerValue(req.headers, 'secure-token');
  if (token) {
    return safeEqual(token, key)
      ? { ok: true, method: 'casso-token' }
      : rejected('invalid_signature', tr('secure-token không khớp Key bảo mật'));
  }
  return rejected('missing_signature', tr('Thiếu chữ ký (X-Casso-Signature của Webhook V2 hoặc secure-token của Webhook cũ)'));
}

export function verifySePayWebhook(req: WebhookRequest, secret: unknown): WebhookAuthResult {
  // The user may paste the whole header value "Apikey xxx"
  const key = cleanSecret(secret).replace(/^apikey\s+/i, '');
  if (!key) return { ok: true, method: 'none' };

  const signature = headerValue(req.headers, 'x-sepay-signature');
  if (signature) {
    const timestamp = headerValue(req.headers, 'x-sepay-timestamp');
    if (!/^[0-9]{1,12}$/.test(timestamp)) return rejected('invalid_signature', tr('Thiếu X-SePay-Timestamp'));
    const now = req.now ?? Date.now();
    if (Math.abs(now - Number(timestamp) * 1000) > SEPAY_MAX_SKEW_MS) {
      return rejected('stale_timestamp', tr('X-SePay-Timestamp lệch quá 5 phút — kiểm tra đồng hồ máy'));
    }
    const mac = crypto.createHmac('sha256', key).update(`${timestamp}.`, 'utf8').update(req.rawBody).digest('hex');
    const given = signature.replace(/^sha256=/i, '').trim().toLowerCase();
    return safeEqual(mac, given)
      ? { ok: true, method: 'sepay-signature' }
      : rejected('invalid_signature', tr('Chữ ký X-SePay-Signature không khớp Secret Key'));
  }

  const authorization = headerValue(req.headers, 'authorization');
  const apiKey = /^apikey\s+(.+)$/i.exec(authorization);
  if (apiKey) {
    return safeEqual(apiKey[1].trim(), key)
      ? { ok: true, method: 'sepay-apikey' }
      : rejected('invalid_signature', tr('API Key trong header Authorization không khớp'));
  }
  if (/^bearer\s/i.test(authorization)) {
    return rejected('unsupported_auth', tr('Webhook SePay đang dùng OAuth 2.0 — hãy chọn HMAC-SHA256 hoặc API Key'));
  }
  return rejected('missing_signature', tr('Thiếu chữ ký (X-SePay-Signature hoặc Authorization: Apikey)'));
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

/** Casso: V2 `data` = one transaction, old Webhook `data` = array; `error` non-zero = no transaction. */
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

/** SePay: the body is one transaction. */
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
 * Transaction in the 'integration:payment' event: the normalized version (`payment`), or, for old events / other emitters,
 * read from `transaction` (SePay: transferAmount/transferType; otherwise: a negative amount = money out).
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

/** Reads the body: JSON (default) or form-urlencoded (SePay lets you choose). A broken body → throws. */
export function parseWebhookBody(rawBody: Buffer, contentType = ''): any {
  const text = rawBody.toString('utf8').trim();
  if (!text) return {};
  if (/application\/x-www-form-urlencoded/i.test(contentType)) return Object.fromEntries(new URLSearchParams(text));
  return JSON.parse(text);
}

/** Collects the request body, stops when `maxBytes` is exceeded (error code 'BODY_TOO_LARGE'). */
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

/** Keys seen recently (TTL + a size limit): prevents processing one transaction twice when it is resent / replayed. */
export class RecentKeys {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly ttlMs = 48 * 3_600_000, private readonly maxEntries = 5_000) {}

  /** true = already seen within the TTL (skip); false = first time (now remembered). */
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
