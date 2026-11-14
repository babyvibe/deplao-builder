import axios from 'axios';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';
import type { PosWebhookApi, RemoteWebhook } from '../posWebhookRegistration';
import { keepCustomerOrders } from '../posOrderOwnership';
import { matchProvinceArea } from '../vnPlaceNames';
import Logger from '../../../utils/Logger';
import { tr } from '../../../shared/i18n';

/** KiotViet "Khu vực" list (GET /locations) rarely changes: cached per adapter instance. */
const LOCATIONS_TTL_MS = 24 * 60 * 60 * 1000;

/** KiotViet webhook (Public API 2.11: id, type, url, isActive, description) → common shape. */
function toRemoteWebhook(webhook: any): RemoteWebhook {
  return {
    id: String(webhook?.id ?? webhook?.Id ?? ''),
    event: String(webhook?.type ?? webhook?.Type ?? ''),
    url: String(webhook?.url ?? webhook?.Url ?? ''),
    active: (webhook?.isActive ?? webhook?.IsActive) !== false,
    description: String(webhook?.description ?? webhook?.Description ?? ''),
  };
}

/**
 * KiotViet POS adapter.
 * Credentials required: clientId, clientSecret, retailerName
 * Docs: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/
 */
export class KiotVietAdapter extends IntegrationAdapter implements PosWebhookApi {
  readonly type = 'kiotviet';
  readonly name = 'KiotViet';

  private accessToken?: string;
  private tokenExpiry = 0;
  private locationsCache?: { at: number; list: Array<{ id: number; name: string }> };

  constructor(config: IntegrationConfig) {
    super(config);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const { clientId, clientSecret } = this.config.credentials;
    if (!clientId || !clientSecret) throw new Error(tr('Thiếu clientId hoặc clientSecret'));

    const res = await axios.post(
      'https://id.kiotviet.vn/connect/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scopes: 'PublicApi.Access',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 },
    );
    this.accessToken = res.data.access_token;
    this.tokenExpiry = Date.now() + (Number(res.data.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken!;
  }

  private async apiGet(path: string, params?: Record<string, any>): Promise<any> {
    const token = await this.getAccessToken();
    const { retailerName } = this.config.credentials;
    if (!retailerName) throw new Error(tr('Thiếu retailerName (tên gian hàng KiotViet)'));
    const res = await axios.get(`https://public.kiotapi.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Retailer: retailerName },
      params,
      timeout: 12000,
    });
    return res.data;
  }

  private async apiPost(path: string, body: any): Promise<any> {
    const token = await this.getAccessToken();
    const { retailerName } = this.config.credentials;
    const res = await axios.post(`https://public.kiotapi.com${path}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        Retailer: retailerName,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    return res.data;
  }

  private async apiDelete(path: string): Promise<any> {
    const token = await this.getAccessToken();
    const { retailerName } = this.config.credentials;
    const res = await axios.delete(`https://public.kiotapi.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Retailer: retailerName },
      timeout: 15000,
    });
    return res.data;
  }

  // ─── Webhook (Public API 2.11) — posWebhookRegistration.ts ────────────────

  /** GET /webhooks: { total, pageSize (≤ 100), data }. */
  async listWebhooks(): Promise<RemoteWebhook[]> {
    const pageSize = 100;
    const webhooks: RemoteWebhook[] = [];
    for (let page = 0; page < 5; page++) {
      const data = await this.apiGet('/webhooks', { pageSize, currentItem: page * pageSize });
      const items: any[] = Array.isArray(data?.data) ? data.data : [];
      webhooks.push(...items.map(toRemoteWebhook));
      const total = Number(data?.total);
      if (items.length < pageSize || !Number.isFinite(total) || webhooks.length >= total) break;
    }
    return webhooks;
  }

  /** POST /webhooks { Webhook: { Type, Url, IsActive, Description, Secret } }: Secret is a Base64-encoded string. */
  async createWebhook(input: { event: string; url: string; secret?: string; description: string }): Promise<RemoteWebhook> {
    const data = await this.apiPost('/webhooks', {
      Webhook: { Type: input.event, Url: input.url, IsActive: true, Description: input.description, Secret: input.secret },
    });
    return toRemoteWebhook(data);
  }

  /** DELETE /webhooks/{id}. */
  async deleteWebhook(id: string): Promise<void> {
    await this.apiDelete(`/webhooks/${encodeURIComponent(id)}`);
  }

  /** All "Khu vực" entries ({ id, name: "Hà Nội - Quận Ba Đình" }), paged by 100, de-duplicated by id. */
  private async listLocations(): Promise<Array<{ id: number; name: string }>> {
    if (this.locationsCache && Date.now() - this.locationsCache.at < LOCATIONS_TTL_MS) return this.locationsCache.list;
    const pageSize = 100;
    const byId = new Map<string, { id: number; name: string }>();
    for (let page = 0; page < 60; page++) {
      const data = await this.apiGet('/locations', { pageSize, currentItem: page * pageSize });
      const items: any[] = Array.isArray(data?.data) ? data.data : [];
      const before = byId.size;
      for (const item of items) if (item?.id != null) byId.set(String(item.id), { id: item.id, name: String(item.name ?? '') });
      const total = Number(data?.total);
      // Stop on a short page, when the total is reached, or when the API ignored paging (no new id)
      if (items.length < pageSize || byId.size === before || (Number.isFinite(total) && byId.size >= total)) break;
    }
    const list = [...byId.values()];
    this.locationsCache = { at: Date.now(), list };
    return list;
  }

  /**
   * orderDelivery from the order panel carries `provinceName` + `areaName` (district for an old address, ward for a new one)
   * instead of a KiotViet "Khu vực": look the area up in GET /locations and send its id + exact name. No sure match → no
   * area at all (the full address text is still in `address`). An orderDelivery without these hints is sent unchanged.
   */
  private async resolveDeliveryLocation(delivery: any): Promise<any> {
    if (!delivery || typeof delivery !== 'object') return delivery;
    const { provinceName, areaName, ...rest } = delivery;
    if (provinceName === undefined && areaName === undefined) return delivery;
    if (rest.locationId) return rest;
    try {
      const match = matchProvinceArea(await this.listLocations(), provinceName, areaName);
      if (match) return { ...rest, locationId: match.id, locationName: match.name };
    } catch (e: any) {
      Logger.warn(`[KiotVietAdapter] GET /locations failed, order sent without an area: ${e?.message || e}`);
    }
    const { locationName: _unmatched, ...withoutArea } = rest;
    return withoutArea;
  }

  /** Orders of one customer: `customerIds` (the only customer filter KiotViet documents) + a check on our side. */
  private async ordersOfCustomer(customerId: unknown, page: number, pageSize: number) {
    const data = await this.apiGet('/orders', {
      customerIds: String(customerId),
      currentItem: (page - 1) * pageSize,   // offset 0-based
      pageSize,
      orderBy: 'createdDate',
      orderDirection: 'Desc',
    });
    const { orders, dropped } = keepCustomerOrders<any>(data?.data || [], customerId, (o) => o?.customerId);
    if (dropped > 0) {
      Logger.warn(`[KiotVietAdapter] /orders returned ${dropped} order(s) of other customers: customer filter ignored, filtered locally`);
      return { orders, page, pageSize, total: undefined, hasNext: false };
    }
    return { orders, ...this.buildPagedMeta(data, page, pageSize) };
  }

  async testConnection(): Promise<TestResult> {
    try {
      await this.getAccessToken();
      // GET /branches is documented (Public API 2.7); there is no /retailer endpoint
      await this.apiGet('/branches', { pageSize: 1 });
      const retailer = this.config.credentials.retailerName || 'KiotViet';
      return { success: true, message: tr('Kết nối KiotViet thành công - gian hàng: {{retailer}}', { retailer }) };
    } catch (e: any) {
      return { success: false, message: tr('Lỗi kết nối KiotViet: {{v1}}', { v1: e.response?.data?.message || e.message }) };
    }
  }

  private buildPagedMeta(data: any, page: number, pageSize: number) {
    const total = Number(
      data?.total ?? data?.totalCount ?? data?.totalRecord ?? data?.totalRecords ?? data?.count ?? 0,
    );
    return {
      page,
      pageSize,
      total: total > 0 ? total : undefined,
      hasNext: total > 0 ? page * pageSize < total : undefined,
    };
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'lookupCustomer': {
        const page = Number(params.page || 1);
        const pageSize = Number(params.limit || 5);
        const data = await this.apiGet('/customers', {
          contactNumber: params.phone,
          currentItem: (page - 1) * pageSize,   // offset 0-based
          pageSize,
        });
        const customers = data.data || [];
        return { customers, ...this.buildPagedMeta(data, page, pageSize) };
      }
      case 'lookupOrder': {
        if (params.orderId) {
          // Numeric id → /orders/{id}; an order code such as "DH000123" (what customers type) → /orders/code/{code}
          const key = String(params.orderId).trim().replace(/^#/, '');
          const path = /^\d+$/.test(key) ? `/orders/${key}` : `/orders/code/${encodeURIComponent(key)}`;
          const data = await this.apiGet(path);
          return { order: data };
        } else if (params.customerId) {
          // Look up directly by customerId
          return this.ordersOfCustomer(params.customerId, Number(params.page || 1), Number(params.limit || 10));
        } else if (params.phone) {
          // KiotViet /orders does NOT support contactNumber -
          // look up the customer first → get the customerId → query orders
          const custData = await this.apiGet('/customers', {
            contactNumber: params.phone,
            currentItem: 0,
            pageSize: 1,
          });
          const customer = (custData.data || [])[0];
          if (!customer) {
            return { orders: [], total: 0, message: tr('Không tìm thấy khách hàng với SĐT này') };
          }
          const result = await this.ordersOfCustomer(customer.id, Number(params.page || 1), Number(params.limit || 10));
          return { ...result, customer };
        }
        throw new Error(tr('Cần cung cấp orderId, customerId hoặc phone'));
      }
      case 'createOrder': {
        // Accept both direct payload and wrapped { order } payload from workflow/runtime callers.
        const payload = { ...(params?.order && typeof params.order === 'object' ? params.order : params) };
        if (payload.orderDelivery) payload.orderDelivery = await this.resolveDeliveryLocation(payload.orderDelivery);
        const data = await this.apiPost('/orders', payload);
        return { order: data, success: true };
      }
      case 'lookupProduct': {
        const page = Number(params.page || 1);
        const pageSize = Number(params.limit || 10);
        const code = String(params.code ?? '').trim();
        if (code) {
          // /products has no code filter: GET /products/code/{code} (Public API 2.4)
          try {
            const product = await this.apiGet(`/products/code/${encodeURIComponent(code)}`);
            const products = product && typeof product === 'object' && product.id != null ? [product] : [];
            return { products, found: products.length > 0, page: 1, pageSize, total: products.length, hasNext: false };
          } catch (e: any) {
            if (e?.response?.status === 404 || e?.response?.status === 400) return { products: [], found: false, page: 1, pageSize, total: 0, hasNext: false };
            throw e;
          }
        }
        const data = await this.apiGet('/products', {
          name: params.keyword,                    // KiotViet uses `name`, not `searchTerms`
          currentItem: (page - 1) * pageSize,      // offset 0-based
          pageSize,
          orderBy: 'id',
          orderDirection: 'Desc',
        });
        const products: any[] = data.data || [];
        return { products, found: products.length > 0, ...this.buildPagedMeta(data, page, pageSize) };
      }
      default:
        throw new Error(tr('KiotViet không hỗ trợ action: {{action}}', { action }));
    }
  }
}

