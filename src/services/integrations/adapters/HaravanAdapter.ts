import axios from 'axios';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';
import { keepCustomerOrders } from '../posOrderOwnership';
import Logger from '../../../utils/Logger';
import { tr } from '../../../shared/i18n';

/** Haravan Omni API: one host for every shop, the token tells which shop. */
const HARAVAN_API_BASE = 'https://apis.haravan.com/com';
/** orders.json / products.json return at most 50 rows per call. */
const PAGE_MAX = 50;

const customerIdOf = (order: any): unknown => order?.customer?.id ?? order?.customer_id;

/**
 * Haravan POS adapter.
 * Credentials:
 *   - Private token (recommended): accessToken. Haravan admin → Ứng dụng → Ứng dụng riêng (Private apps) → Token, or
 *     Developer dashboard → the app → Private Token. Calls https://apis.haravan.com/com/*.json with `Authorization: Bearer`;
 *     no shop name needed.
 *   - Legacy private app: apiKey + password + retailerDomain, HTTP Basic on https://{shop}.myharavan.com/admin/*.json.
 *     No longer in Haravan's docs, kept only for shops that still have such an app.
 * Docs: https://docs.haravan.com/docs/omni-apis/
 */
export class HaravanAdapter extends IntegrationAdapter {
  readonly type = 'haravan';
  readonly name = 'Haravan';

  constructor(config: IntegrationConfig) {
    super(config);
  }

  private get usesLegacyAuth(): boolean {
    return !String(this.config.credentials.accessToken || '').trim();
  }

  /** Legacy host for the API Key + Password mode: accepts "myshop", "myshop.myharavan.com" or a full URL. */
  private legacyHost(): string {
    const raw = String(this.config.credentials.retailerDomain || '').trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split(/[/?#]/)[0];
    if (!raw) throw new Error(tr('Thiếu tên shop Haravan (cần khi dùng API Key + Password)'));
    return raw.includes('.') ? raw : `${raw}.myharavan.com`;
  }

  /** Base URL + auth header: private token → Omni API; otherwise the legacy Basic auth. */
  private endpoint(): { base: string; headers: Record<string, string> } {
    const { accessToken, apiKey, password } = this.config.credentials;
    const token = String(accessToken || '').trim().replace(/^Bearer\s+/i, '');
    if (token) {
      return { base: HARAVAN_API_BASE, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
    }
    if (!apiKey || !password) throw new Error(tr('Thiếu Access Token hoặc API Key + Password Haravan'));
    const basic = Buffer.from(`${apiKey}:${password}`).toString('base64');
    return { base: `https://${this.legacyHost()}/admin`, headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' } };
  }

  private async apiGet(path: string, params?: Record<string, any>): Promise<any> {
    const { base, headers } = this.endpoint();
    const res = await axios.get(`${base}${path}`, { headers, params, timeout: 15000 });
    return res.data;
  }

  private async apiPost(path: string, body: any): Promise<any> {
    const { base, headers } = this.endpoint();
    const res = await axios.post(`${base}${path}`, body, { headers, timeout: 15000 });
    return res.data;
  }

  /** Haravan `errors` is a string, a list or { field: [messages] }. */
  private describeError(e: any): string {
    const errors = e?.response?.data?.errors ?? e?.response?.data?.error;
    if (typeof errors === 'string' && errors) return errors;
    if (Array.isArray(errors) && errors.length) return errors.join('; ');
    if (errors && typeof errors === 'object') {
      const text = Object.entries(errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ');
      if (text) return text;
    }
    const status = e?.response?.status;
    if (status === 401) return tr('Token không hợp lệ hoặc đã bị thu hồi');
    if (status === 403) return tr('Token chưa được cấp quyền cho dữ liệu này');
    return e?.message || String(e);
  }

  async testConnection(): Promise<TestResult> {
    try {
      const data = await this.apiGet('/shop.json');
      const shopName = data?.shop?.name || data?.shop?.domain || 'Haravan Shop';
      if (this.usesLegacyAuth) {
        return { success: true, message: tr('Kết nối Haravan thành công - shop: {{shopName}}. Cách API Key + Password đã cũ, nên đổi sang Private Token', { shopName }) };
      }
      return { success: true, message: tr('Kết nối Haravan thành công - shop: {{shopName}}', { shopName }) };
    } catch (e: any) {
      return { success: false, message: tr('Lỗi kết nối Haravan: {{v1}}', { v1: this.describeError(e) }) };
    }
  }

  /**
   * Orders of one customer, newest first. Haravan documents no customer filter on orders.json: `customer_id` is still sent
   * (older shops honour it) and the newest 50 orders are filtered by customer id on our side (posOrderOwnership).
   */
  private async ordersOfCustomer(customerId: unknown, limit: number): Promise<any[]> {
    const want = Math.min(Math.max(1, Number(limit) || 10), PAGE_MAX);
    const data = await this.apiGet('/orders.json', { status: 'any', customer_id: customerId, limit: PAGE_MAX, order: 'created_at desc' });
    const { orders, dropped } = keepCustomerOrders<any>(data?.orders || [], customerId, customerIdOf);
    if (dropped > 0) Logger.warn(`[HaravanAdapter] orders.json returned ${dropped} order(s) of other customers: customer_id ignored, filtered locally`);
    return orders.slice(0, want);
  }

  /** The customer's last order (`last_order_id` on the customer record), when the order list has none of theirs. */
  private async lastOrderOf(customerId: unknown, lastOrderId: unknown): Promise<any[]> {
    if (!lastOrderId) return [];
    try {
      const order = (await this.apiGet(`/orders/${encodeURIComponent(String(lastOrderId))}.json`))?.order;
      return keepCustomerOrders<any>(order ? [order] : [], customerId, customerIdOf).orders;
    } catch {
      return [];
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'lookupCustomer': {
        const data = await this.apiGet('/customers/search.json', {
          query: params.phone || params.email || params.query,
          limit: 5,
        });
        const customers: any[] = data.customers || [];
        return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
      }

      case 'lookupOrder': {
        const limit = Number(params.limit) || 10;
        if (params.orderId) {
          const data = await this.apiGet(`/orders/${encodeURIComponent(String(params.orderId).trim().replace(/^#/, ''))}.json`);
          const order = data.order;
          return { order, orders: order ? [order] : [], found: !!order };
        }

        if (params.customerId) {
          let orders = await this.ordersOfCustomer(params.customerId, limit);
          if (orders.length === 0) {
            const customer = (await this.apiGet(`/customers/${encodeURIComponent(String(params.customerId))}.json`).catch(() => null))?.customer;
            orders = await this.lastOrderOf(params.customerId, customer?.last_order_id);
          }
          return { orders, order: orders[0] || null, found: orders.length > 0 };
        }

        if (params.phone) {
          // orders.json cannot search by phone: find the customer first → their orders
          const custData = await this.apiGet('/customers/search.json', {
            query: params.phone,
            limit: 1,
          });
          const customer = (custData.customers || [])[0];
          if (!customer) {
            return { orders: [], found: false, message: tr('Không tìm thấy khách hàng với SĐT này') };
          }
          let orders = await this.ordersOfCustomer(customer.id, limit);
          if (orders.length === 0) orders = await this.lastOrderOf(customer.id, customer.last_order_id);
          return { orders, order: orders[0] || null, found: orders.length > 0, customer };
        }

        throw new Error(tr('Cần cung cấp orderId, customerId hoặc phone'));
      }

      case 'createOrder': {
        let order = params.order;
        if (typeof order === 'string') {
          try { order = JSON.parse(order); } catch { throw new Error(tr('Dữ liệu đơn hàng (order) không phải JSON hợp lệ')); }
        }
        try {
          const data = await this.apiPost('/orders.json', { order });
          return { order: data.order, success: true };
        } catch (e: any) {
          throw new Error(this.describeError(e));
        }
      }

      case 'getProducts': {
        const data = await this.apiGet('/products.json', { limit: Math.min(Number(params.limit) || 20, PAGE_MAX) });
        return { products: data.products || [] };
      }

      case 'lookupProduct': {
        // products.json?title=X is an exact match only: fetch a page and filter partial matches on our side
        const data = await this.apiGet('/products.json', {
          limit: Math.min(Number(params.limit) || PAGE_MAX, PAGE_MAX),
        });
        const keyword = (params.keyword || '').toLowerCase().trim();
        let products: any[] = data.products || [];
        if (keyword) {
          products = products.filter((p: any) =>
            (p.title || '').toLowerCase().includes(keyword) ||
            (p.handle || '').toLowerCase().includes(keyword) ||
            (p.product_type || '').toLowerCase().includes(keyword) ||
            (p.variants || []).some((v: any) =>
              (v.sku || '').toLowerCase().includes(keyword) ||
              (v.barcode || '').toLowerCase().includes(keyword),
            ),
          );
        }
        return { products, found: products.length > 0 };
      }

      default:
        throw new Error(tr('Haravan không hỗ trợ action: {{action}}', { action }));
    }
  }
}
