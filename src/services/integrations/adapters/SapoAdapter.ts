import axios from 'axios';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';
import type { PosWebhookApi, RemoteWebhook } from '../posWebhookRegistration';
import { keepCustomerOrders, normalizeVnPhone } from '../posOrderOwnership';
import Logger from '../../../utils/Logger';
import { tr } from '../../../shared/i18n';

/**
 * Sapo (Sapo Web / Sapo Omnichannel): Admin REST API `https://{store}.mysapo.net/admin/*.json`.
 *
 * Docs: support.sapo.vn (cited below) now redirects to help.sapo.vn; the API reference moved to developers.sapo.vn and needs a
 * Sapo Partner login.
 *
 * Authentication (support.sapo.vn/ung-dung-rieng-private-apps, support.sapo.vn/oauth):
 *  - Private App: RECOMMENDED, no domain / Redirect URL needed: Sapo Web → Apps → "Ứng dụng riêng"
 *    → Create private app (grant Customers, Orders, Products) → API Key + API Secret → HTTP Basic Auth.
 *  - OAuth (Partner app): a permanent token after the authorize flow → header `X-Sapo-Access-Token`. Needs a Partner account
 *    + a Redirect URL registered in advance → only use it when a token is already available.
 * The adapter used to send ONLY X-Sapo-Access-Token and told users to get a "Token" from a menu that does not exist → users pasted the
 * API Secret of the private app → 401 "Sai Access Token" (wrong access token).
 *
 * Different from Shopify (Sapo is based on that model): products use `name` (no `title`), product names are filtered with `query`,
 * dates `created_on`/`modified_on`; the order list defaults to `status=open` (excludes archived / cancelled orders);
 * customer phone numbers are stored as +84…; order lines carry `variant_id` (the variant id, not the product id).
 */

// ─── Pure part (has tests: src/__tests__/integrations/sapoAdapter.test.ts) ─────────────────────────────────────────────

const SAPO_ROOT_DOMAIN = 'mysapo.net';

/**
 * Store name typed by the user → API host. Accepts "myshop", "myshop.mysapo.net", "https://myshop.mysapo.net/admin",
 * or a custom domain "shop.vn". Previously `${input}.mysapo.net` was concatenated directly: typing "myshop.mysapo.net" became
 * "myshop.mysapo.net.mysapo.net" → the *.mysapo.net certificate did not match → "SSL handshake failure" error.
 */
export function normalizeSapoStoreHost(input: unknown): string {
  let host = String(input ?? '').trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');      // https://
  host = host.replace(/^[^@/]*@/, '');                     // user:pass@
  host = host.split(/[/?#]/)[0] || '';                    // /admin…
  host = host.replace(/:\d+$/, '').replace(/\.+$/, '');    // :443, trailing dot
  if (!host) throw new Error(tr('Thiếu tên cửa hàng Sapo (vd: myshop hoặc myshop.mysapo.net)'));
  const root = `.${SAPO_ROOT_DOMAIN}`;
  if (host === SAPO_ROOT_DOMAIN) throw new Error(tr('Tên cửa hàng Sapo không hợp lệ'));
  if (host.endsWith(root)) host = `${host.split('.')[0]}${root}`;   // myshop.mysapo.net(.mysapo.net)
  else if (!host.includes('.')) host = `${host}${root}`;
  const labels = host.split('.');
  if (labels.some((label) => !/^[a-z0-9-]+$/.test(label) || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error(tr('Tên cửa hàng Sapo không hợp lệ: "{{v1}}"', { v1: String(input) }));
  }
  return host;
}

export interface SapoCredentials { apiKey?: string; apiSecret?: string; accessToken?: string; storeDomain?: string }

/** Auth header: private app (Basic) if both the API Key + Secret are present, otherwise the OAuth token. */
export function sapoAuthHeaders(creds: SapoCredentials): Record<string, string> {
  const apiKey = String(creds.apiKey || '').trim();
  const apiSecret = String(creds.apiSecret || '').trim();
  const accessToken = String(creds.accessToken || '').trim();
  if (apiKey && apiSecret) {
    return { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, 'utf8').toString('base64')}` };
  }
  if (accessToken) return { 'X-Sapo-Access-Token': accessToken };
  if (apiKey || apiSecret) throw new Error(tr('Thiếu {{v1}} của ứng dụng riêng Sapo', { v1: (apiKey ? 'API Secret' : 'API Key') }));
  throw new Error(tr('Thiếu API Key + API Secret (Sapo Web → Ứng dụng → Ứng dụng riêng)'));
}

/** Vietnamese phone numbers normalized to the local form "0xxxxxxxxx" for comparison (Sapo stores "+84…", Zalo often has "84…" / "0…"). */
export { normalizeVnPhone };

/** Phone number forms to ask Sapo with (`query` matches as a string): local, +84, 84. */
export function phoneSearchVariants(value: unknown): string[] {
  const local = normalizeVnPhone(value);
  if (!local) return [];
  const variants = [local];
  if (local.startsWith('0') && local.length >= 10) variants.push(`+84${local.slice(1)}`, `84${local.slice(1)}`);
  return [...new Set(variants)];
}

const looksLikePhone = (keyword: string): boolean => /^[+\d][\d\s.()-]{7,}$/.test(keyword.trim());

/** Remove Vietnamese diacritics + lowercase (for comparing product / customer names). */
export function foldVietnamese(value: unknown): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();
}

/** Sapo customer "Họ Tên" (full name): first_name = given name, last_name = family name. */
export function sapoCustomerName(customer: any): string {
  const full = [customer?.last_name, customer?.first_name].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  return full || String(customer?.default_address?.name || customer?.name || '').trim();
}

function customerPhones(customer: any): string[] {
  const phones = [customer?.phone, customer?.default_address?.phone, ...(Array.isArray(customer?.addresses) ? customer.addresses.map((a: any) => a?.phone) : [])];
  return phones.map(normalizeVnPhone).filter(Boolean);
}

/** Customer matches the keyword: phone number (compared in normalized form), email (exact match), otherwise by name (accent-insensitive, contains). */
export function sapoCustomerMatches(customer: any, keyword: string): boolean {
  const kw = String(keyword || '').trim();
  if (!kw) return false;
  if (kw.includes('@')) return String(customer?.email || '').trim().toLowerCase() === kw.toLowerCase();
  if (looksLikePhone(kw)) {
    const target = normalizeVnPhone(kw);
    return !!target && customerPhones(customer).includes(target);
  }
  return foldVietnamese(sapoCustomerName(customer)).includes(foldVietnamese(kw));
}

/** Adds common fields (name, address) for the UI / workflow; keeps the original Sapo fields. */
export function normalizeSapoCustomer(customer: any): any {
  if (!customer || typeof customer !== 'object') return customer;
  const addr = customer.default_address || (Array.isArray(customer.addresses) ? customer.addresses[0] : null) || {};
  const address = [addr.address1, addr.ward, addr.district, addr.province || addr.city].map((s) => String(s ?? '').trim()).filter(Boolean).join(', ');
  return {
    ...customer,
    name: sapoCustomerName(customer),
    phone: customer.phone || addr.phone || '',
    address,
  };
}

const isDefaultVariantTitle = (title: unknown): boolean => !title || /^(default title|default|mặc định)$/i.test(String(title).trim());

/**
 * Sapo products → a list of "sellable items" (one row per variant): Sapo orders need `variant_id`, and price / stock /
 * SKU live on the variant. Keeps `id` = the product id and the original fields; adds `variation_id`/`variant_id`, `name`/`title`, price, stock.
 */
export function toSapoSellableItems(products: any[]): any[] {
  const items: any[] = [];
  for (const product of Array.isArray(products) ? products : []) {
    const productName = String(product?.name ?? product?.title ?? '').trim();
    const variants: any[] = Array.isArray(product?.variants) && product.variants.length ? product.variants : [null];
    for (const variant of variants) {
      const multi = variants.length > 1 && !isDefaultVariantTitle(variant?.title);
      const name = multi ? `${productName} - ${String(variant.title).trim()}` : productName;
      const image = (variant?.image_id && Array.isArray(product?.images) ? product.images.find((img: any) => img?.id === variant.image_id) : null)
        || product?.image || (Array.isArray(product?.images) ? product.images[0] : null) || null;
      items.push({
        ...product,
        name,
        title: name,
        product_id: product?.id,
        product_name: productName,
        variation_id: variant?.id ?? null,
        variant_id: variant?.id ?? null,
        variant_title: variant?.title ?? null,
        price: variant?.price ?? null,
        compare_at_price: variant?.compare_at_price ?? null,
        sku: variant?.sku ?? '',
        barcode: variant?.barcode ?? '',
        inventory_quantity: variant?.inventory_quantity ?? null,
        image,
        variants: variant ? [variant] : [],
      });
    }
  }
  return items;
}

/** Sapo webhook (support.sapo.vn/sapo-webhook: id, topic, address, format) → common shape. */
function toRemoteWebhook(webhook: any): RemoteWebhook {
  return {
    id: String(webhook?.id ?? ''),
    event: String(webhook?.topic ?? ''),
    url: String(webhook?.address ?? ''),
    active: true,
    description: String(webhook?.format ?? ''),
  };
}

// ─── Adapter ────────────────────────────────────────────────────────────────────────────────────────────

const PAGE_MAX = 250;
/** Scans the list when `query` is not supported / returns nothing: at most ~2500 customers / products. */
const SCAN_PAGES_MAX = 10;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export class SapoAdapter extends IntegrationAdapter implements PosWebhookApi {
  readonly type = 'sapo';
  readonly name = 'Sapo';

  constructor(config: IntegrationConfig) {
    super(config);
  }

  private get host(): string {
    return normalizeSapoStoreHost(this.config.credentials.storeDomain);
  }

  /** GET / POST to the Admin API; 429 (rate limit) and 502-504 are retried up to 2 times, respecting Retry-After. */
  private async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { params?: Record<string, any>; body?: any } = {}): Promise<any> {
    const url = `https://${this.host}/admin${path}`;
    const headers = {
      ...sapoAuthHeaders(this.config.credentials as SapoCredentials),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await axios.request({ method, url, headers, params: opts.params, data: opts.body, timeout: 20_000 });
        // Wrong store name: Sapo returns an HTML page (404, or a 200 login page) instead of JSON
        if (typeof res.data === 'string' && /<html/i.test(res.data)) {
          const err: any = new Error('NOT_JSON');
          err.response = { status: res.status, data: res.data, headers: res.headers };
          throw err;
        }
        return res.data;
      } catch (e: any) {
        const status = e?.response?.status;
        const retriable = (method === 'GET' || status === 429) && RETRY_STATUSES.has(status) && attempt < 2;
        if (!retriable) throw new Error(this.describeError(e));
        const retryAfter = Number(e?.response?.headers?.['retry-after']);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 1000 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  /** Error messages that are easy for users to understand (integration screen, workflow, chat panel). */
  private describeError(e: any): string {
    const status = e?.response?.status;
    const code = e?.code;
    let host = '';
    try { host = this.host; } catch (err: any) { return err?.message || tr('Thiếu tên cửa hàng Sapo'); }
    const html = typeof e?.response?.data === 'string' && /<html/i.test(e.response.data);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return tr('Không tìm thấy cửa hàng "{{host}}" - kiểm tra lại tên cửa hàng', { host });
    if (status === 404 && html) return tr('Không tìm thấy cửa hàng "{{host}}" trên Sapo - kiểm tra tên cửa hàng (phần trước .mysapo.net trong địa chỉ trang quản trị)', { host });
    if (status === 401) {
      return this.config.credentials.apiKey
        ? tr('Sai API Key / API Secret - mở lại ứng dụng riêng trong Sapo (Ứng dụng → Ứng dụng riêng) và chép lại')
        : tr('Access Token không hợp lệ - dùng API Key + API Secret của ứng dụng riêng (Sapo Web → Ứng dụng → Ứng dụng riêng)');
    }
    if (status === 403) return tr('Kết nối được nhưng ứng dụng riêng chưa được cấp quyền cho dữ liệu này (Khách hàng / Đơn hàng / Sản phẩm) - sửa quyền trong Sapo');
    if (status === 422) return tr('Sapo từ chối dữ liệu: {{v1}}', { v1: this.extractApiErrors(e?.response?.data) || tr('dữ liệu không hợp lệ') });
    if (status === 429) return tr('Sapo đang giới hạn tần suất gọi API - thử lại sau ít phút');
    if (code === 'ECONNABORTED' || /timeout/i.test(e?.message || '')) return tr('Kết nối tới Sapo bị timeout - kiểm tra mạng hoặc tường lửa');
    if (code === 'EPROTO' || /handshake|SSL|certificate|altname/i.test(e?.message || '')) {
      return tr('Lỗi SSL khi kết nối "{{host}}" - kiểm tra tên cửa hàng (chỉ cần "myshop" hoặc "myshop.mysapo.net"), proxy hoặc tường lửa', { host });
    }
    if (status) return tr('Sapo trả lỗi HTTP {{status}}{{v1}}', { status, v1: this.extractApiErrors(e?.response?.data) ? `: ${this.extractApiErrors(e.response.data)}` : '' });
    return tr('Lỗi kết nối Sapo: {{v1}}', { v1: e?.message || e });
  }

  private extractApiErrors(data: any): string {
    const errors = data?.errors ?? data?.error;
    if (!errors) return '';
    if (typeof errors === 'string') return errors;
    if (Array.isArray(errors)) return errors.join('; ');
    if (typeof errors === 'object') return Object.entries(errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ');
    return String(errors);
  }

  // ─── Webhook (support.sapo.vn/sapo-webhook) — posWebhookRegistration.ts ───

  /** GET /admin/webhooks.json (at most 250 per page). */
  async listWebhooks(): Promise<RemoteWebhook[]> {
    const data = await this.request('GET', '/webhooks.json', { params: { limit: 250 } });
    return (Array.isArray(data?.webhooks) ? data.webhooks : []).map(toRemoteWebhook);
  }

  /** POST /admin/webhooks.json { webhook: { topic, address, format } }: Sapo signs with the API Secret, there is no separate Secret. */
  async createWebhook(input: { event: string; url: string; description: string }): Promise<RemoteWebhook> {
    const data = await this.request('POST', '/webhooks.json', { body: { webhook: { topic: input.event, address: input.url, format: 'json' } } });
    return toRemoteWebhook(data?.webhook);
  }

  /** PUT /admin/webhooks/{id}.json { webhook: { id, address } }. */
  async updateWebhookUrl(id: string, url: string): Promise<RemoteWebhook> {
    const numericId = Number(id);
    const data = await this.request('PUT', `/webhooks/${encodeURIComponent(id)}.json`, {
      body: { webhook: { id: Number.isFinite(numericId) ? numericId : id, address: url } },
    });
    return toRemoteWebhook(data?.webhook);
  }

  /** DELETE /admin/webhooks/{id}.json. */
  async deleteWebhook(id: string): Promise<void> {
    await this.request('DELETE', `/webhooks/${encodeURIComponent(id)}.json`);
  }

  async testConnection(): Promise<TestResult> {
    try {
      normalizeSapoStoreHost(this.config.credentials.storeDomain);
      sapoAuthHeaders(this.config.credentials as SapoCredentials);
    } catch (e: any) {
      return { success: false, message: e.message };
    }
    try {
      const data = await this.request('GET', '/store.json');
      const name = data?.store?.name || data?.store?.domain || this.host;
      return { success: true, message: tr('Kết nối Sapo thành công - cửa hàng: {{name}}', { name }) };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  /**
   * Find customers by phone / email / name. The Customer API does not document a search parameter, but `query` works
   * (verified in the sapo-mcp project in real use). We still filter again on our side to be safe. No result → scan by since_id
   * (at most SCAN_PAGES_MAX pages × 250). Previously it only scanned the first 250 customers and compared phone numbers as typed (0… ≠ +84…).
   */
  private async findCustomers(keyword: string, limit: number): Promise<any[]> {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const found = new Map<string, any>();
    const take = (list: any[]) => {
      for (const c of list) if (c?.id != null && sapoCustomerMatches(c, kw)) found.set(String(c.id), c);
    };
    const queries = looksLikePhone(kw) ? phoneSearchVariants(kw) : [kw];
    for (const query of queries) {
      const data = await this.request('GET', '/customers.json', { params: { query, limit: PAGE_MAX } });
      take(data?.customers || []);
      if (found.size >= limit) break;
    }
    if (found.size === 0) {
      let sinceId: number | undefined;
      for (let page = 0; page < SCAN_PAGES_MAX && found.size < limit; page++) {
        const data = await this.request('GET', '/customers.json', { params: { limit: PAGE_MAX, ...(sinceId ? { since_id: sinceId } : {}) } });
        const list: any[] = data?.customers || [];
        take(list);
        if (list.length < PAGE_MAX) break;
        sinceId = list[list.length - 1]?.id;
        if (!sinceId) break;
      }
    }
    return [...found.values()].slice(0, limit).map(normalizeSapoCustomer);
  }

  /**
   * Orders of one customer, newest first. The result is filtered again by customer id (posOrderOwnership): if Sapo ignored
   * `customer_id` it would return the newest orders of the whole shop. Asks for at least 50 so the customer's orders are still
   * found when the filter is ignored; nothing left → the customer's last order (`last_order_id`) when known.
   */
  private async getOrdersForCustomer(customerId: string | number, limit: number, lastOrderId?: unknown): Promise<any[]> {
    const want = Math.min(Math.max(1, Number(limit) || 10), PAGE_MAX);
    const data = await this.request('GET', '/orders.json', {
      // status=any: by default Sapo only returns "open" orders, so a customer asking about completed / cancelled orders would not see them
      params: { customer_id: customerId, status: 'any', limit: Math.max(want, 50) },
    });
    const { orders, dropped } = keepCustomerOrders<any>(data?.orders || [], customerId, (o) => o?.customer?.id ?? o?.customer_id);
    if (dropped > 0) Logger.warn(`[SapoAdapter] /orders.json returned ${dropped} order(s) of other customers: customer_id filter ignored, filtered locally`);
    if (orders.length === 0 && lastOrderId) {
      try {
        const last = (await this.request('GET', `/orders/${encodeURIComponent(String(lastOrderId))}.json`))?.order;
        return keepCustomerOrders<any>(last ? [last] : [], customerId, (o) => o?.customer?.id ?? o?.customer_id).orders;
      } catch {
        return [];
      }
    }
    return orders.slice(0, want);
  }

  /** Products per page (+ name filter via Sapo's `query`), returns sellable items per variant. */
  private async listProducts(opts: { query?: string; limit: number; page: number }): Promise<{ products: any[]; hasNext: boolean }> {
    const limit = Math.min(Math.max(1, Number(opts.limit) || 20), PAGE_MAX);
    const params: Record<string, any> = { limit, page: Math.max(1, Number(opts.page) || 1) };
    if (opts.query) params.query = opts.query;
    const data = await this.request('GET', '/products.json', { params });
    const raw: any[] = data?.products || [];
    return { products: toSapoSellableItems(raw), hasNext: raw.length >= limit };
  }

  /** `query` only filters by name: SKU / barcode / accent-free name: scan the first pages and filter on our side. */
  private async scanProducts(keyword: string, limit: number): Promise<any[]> {
    const kw = foldVietnamese(keyword);
    const out: any[] = [];
    for (let page = 1; page <= SCAN_PAGES_MAX && out.length < limit; page++) {
      const data = await this.request('GET', '/products.json', { params: { limit: PAGE_MAX, page } });
      const raw: any[] = data?.products || [];
      for (const item of toSapoSellableItems(raw)) {
        const hay = [item.name, item.product_type, item.vendor, item.sku, item.barcode].map(foldVietnamese);
        if (hay.some((h) => h && h.includes(kw))) out.push(item);
      }
      if (raw.length < PAGE_MAX) break;
    }
    return out.slice(0, limit);
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'lookupCustomer': {
        const keyword = params.phone || params.email || params.query;
        if (!keyword) throw new Error(tr('Cần cung cấp SĐT hoặc email để tra cứu khách hàng'));
        const customers = await this.findCustomers(String(keyword), Number(params.limit) || 5);
        return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
      }

      case 'lookupOrder': {
        const limit = Number(params.limit) || 10;
        if (params.orderId) {
          const orderId = String(params.orderId).trim().replace(/^#/, '');
          if (!/^\d+$/.test(orderId)) throw new Error(tr('Mã đơn Sapo phải là ID số của đơn (xem trong địa chỉ trang chi tiết đơn)'));
          const data = await this.request('GET', `/orders/${orderId}.json`);
          const order = data?.order;
          return { order, orders: order ? [order] : [], found: !!order };
        }
        if (params.phone) {
          const customers = await this.findCustomers(String(params.phone), 1);
          const customer = customers[0];
          if (!customer) {
            return { orders: [], order: null, found: false, message: tr('Không tìm thấy khách hàng với SĐT này') };
          }
          const orders = await this.getOrdersForCustomer(customer.id, limit, customer.last_order_id);
          return { orders, order: orders[0] || null, found: orders.length > 0, customer };
        }
        if (params.customerId) {
          const orders = await this.getOrdersForCustomer(params.customerId, limit);
          return { orders, order: orders[0] || null, found: orders.length > 0 };
        }
        throw new Error(tr('Cần cung cấp orderId, customerId hoặc phone'));
      }

      case 'createOrder': {
        // Workflow order config as a JSON string (DEFAULT_CONFIGS 'sapo.createOrder')
        let order = params.order;
        if (typeof order === 'string') {
          try { order = JSON.parse(order); } catch { throw new Error(tr('Dữ liệu đơn hàng (order) không phải JSON hợp lệ')); }
        }
        if (!order || typeof order !== 'object') throw new Error(tr('Thiếu dữ liệu đơn hàng (order)'));
        if (!Array.isArray(order.line_items) || order.line_items.length === 0) throw new Error(tr('Đơn hàng cần ít nhất một sản phẩm (line_items)'));
        const data = await this.request('POST', '/orders.json', { body: { order } });
        return { order: data?.order, success: true };
      }

      case 'getProducts': {
        const { products, hasNext } = await this.listProducts({ limit: params.limit || 20, page: params.page || 1 });
        return { products, hasNext, page: Number(params.page) || 1 };
      }

      case 'lookupProduct': {
        const keyword = String(params.keyword ?? params.query ?? '').trim();
        const limit = Number(params.limit) || 10;
        const page = Number(params.page) || 1;
        if (!keyword) {
          const { products, hasNext } = await this.listProducts({ limit, page });
          return { products, found: products.length > 0, hasNext, page };
        }
        const { products, hasNext } = await this.listProducts({ query: keyword, limit, page });
        if (products.length > 0 || page > 1) return { products, found: products.length > 0, hasNext, page };
        const scanned = await this.scanProducts(keyword, limit);
        return { products: scanned, found: scanned.length > 0, hasNext: false, page };
      }

      case 'getInventory': {
        // Sapo has no /admin/inventory_items.json → stock lives on the variant (variants[].inventory_quantity)
        const limit = Math.min(Math.max(1, Number(params.limit) || 50), PAGE_MAX);
        const data = await this.request('GET', '/products.json', {
          params: { limit, page: Math.max(1, Number(params.page) || 1), fields: 'id,name,variants' },
        });
        const products: any[] = data?.products || [];
        const items = products.flatMap((p: any) =>
          (p.variants || []).map((v: any) => ({
            product_id: p.id,
            product_title: p.name,
            product_name: p.name,
            variant_id: v.id,
            variant_title: v.title,
            sku: v.sku,
            barcode: v.barcode,
            price: v.price,
            inventory_quantity: v.inventory_quantity ?? 0,
            inventory_policy: v.inventory_policy,
          })),
        );
        return { items };
      }

      default:
        throw new Error(tr('Sapo không hỗ trợ action: {{action}}', { action }));
    }
  }
}
