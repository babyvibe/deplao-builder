import axios from 'axios';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';

/**
 * KiotViet POS adapter.
 * Credentials required: clientId, clientSecret, retailerName
 * Docs: https://developer.kiotviet.vn/
 */
export class KiotVietAdapter extends IntegrationAdapter {
  readonly type = 'kiotviet';
  readonly name = 'KiotViet';

  private accessToken?: string;
  private tokenExpiry = 0;

  constructor(config: IntegrationConfig) {
    super(config);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const { clientId, clientSecret } = this.config.credentials;
    if (!clientId || !clientSecret) throw new Error('Thiếu clientId hoặc clientSecret');

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
    if (!retailerName) throw new Error('Thiếu retailerName (tên gian hàng KiotViet)');
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

  async testConnection(): Promise<TestResult> {
    try {
      await this.getAccessToken();
      const info = await this.apiGet('/retailer');
      const retailer = info?.RetailerName || info?.retailerName || 'KiotViet';
      return { success: true, message: `Kết nối KiotViet thành công — gian hàng: ${retailer}` };
    } catch (e: any) {
      return { success: false, message: `Lỗi kết nối KiotViet: ${e.response?.data?.message || e.message}` };
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
          const data = await this.apiGet(`/orders/${params.orderId}`);
          return { order: data };
        } else if (params.customerId) {
          // Tra cứu trực tiếp bằng customerId
          const page = Number(params.page || 1);
          const pageSize = Number(params.limit || 10);
          const data = await this.apiGet('/orders', {
            customerId: params.customerId,
            currentItem: (page - 1) * pageSize,   // offset 0-based
            pageSize,
            orderBy: 'createdDate',
            orderDirection: 'Desc',
          });
          const orders = data.data || [];
          return { orders, ...this.buildPagedMeta(data, page, pageSize) };
        } else if (params.phone) {
          // KiotViet /orders KHÔNG hỗ trợ contactNumber —
          // phải lookup customer trước → lấy customerId → query orders
          const custData = await this.apiGet('/customers', {
            contactNumber: params.phone,
            currentItem: 0,
            pageSize: 1,
          });
          const customer = (custData.data || [])[0];
          if (!customer) {
            return { orders: [], total: 0, message: 'Không tìm thấy khách hàng với SĐT này' };
          }
          const page = Number(params.page || 1);
          const pageSize = Number(params.limit || 10);
          const data = await this.apiGet('/orders', {
            customerId: customer.id,
            currentItem: (page - 1) * pageSize,   // offset 0-based
            pageSize,
            orderBy: 'createdDate',
            orderDirection: 'Desc',
          });
          const orders = data.data || [];
          return { orders, customer, ...this.buildPagedMeta(data, page, pageSize) };
        }
        throw new Error('Cần cung cấp orderId, customerId hoặc phone');
      }
      case 'createOrder': {
        // Accept both direct payload and wrapped { order } payload from workflow/runtime callers.
        const payload = params?.order && typeof params.order === 'object' ? params.order : params;
        const data = await this.apiPost('/orders', payload);
        return { order: data, success: true };
      }
      case 'lookupProduct': {
        const page = Number(params.page || 1);
        const pageSize = Number(params.limit || 10);
        const data = await this.apiGet('/products', {
          name: params.keyword,                    // KiotViet dùng `name`, không phải `searchTerms`
          code: params.code,
          currentItem: (page - 1) * pageSize,      // offset 0-based
          pageSize,
          orderBy: 'id',
          orderDirection: 'Desc',
        });
        const products: any[] = data.data || [];
        return { products, found: products.length > 0, ...this.buildPagedMeta(data, page, pageSize) };
      }
      default:
        throw new Error(`KiotViet không hỗ trợ action: ${action}`);
    }
  }
}

