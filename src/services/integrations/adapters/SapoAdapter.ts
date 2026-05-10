import axios from 'axios';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';

/**
 * Sapo POS adapter.
 * Credentials required: apiKey, secretKey, storeDomain (e.g. "myshop" for myshop.mysapo.net)
 * Docs: https://developers.sapo.vn/
 */
export class SapoAdapter extends IntegrationAdapter {
  readonly type = 'sapo';
  readonly name = 'Sapo';

  constructor(config: IntegrationConfig) {
    super(config);
  }

  private getBaseUrl(): string {
    const { storeDomain } = this.config.credentials;
    if (!storeDomain) throw new Error('Thiếu storeDomain (tên store Sapo)');
    return `https://${storeDomain}.mysapo.net`;
  }

  private getHeaders() {
    const { apiKey, secretKey } = this.config.credentials;
    if (!apiKey || !secretKey) throw new Error('Thiếu API Key hoặc Secret Key Sapo');
    const token = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
    return {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async apiGet(path: string, params?: Record<string, any>): Promise<any> {
    const res = await axios.get(`${this.getBaseUrl()}${path}`, {
      headers: this.getHeaders(),
      params,
      timeout: 15000,
    });
    return res.data;
  }

  private async apiPost(path: string, body: any): Promise<any> {
    const res = await axios.post(`${this.getBaseUrl()}${path}`, body, {
      headers: this.getHeaders(),
      timeout: 15000,
    });
    return res.data;
  }

  async testConnection(): Promise<TestResult> {
    try {
      const data = await this.apiGet('/admin/store.json');
      const name = data?.store?.name || data?.store?.domain || 'Sapo Store';
      return { success: true, message: `Kết nối Sapo thành công — store: ${name}` };
    } catch (e: any) {
      return { success: false, message: `Lỗi kết nối Sapo: ${e.response?.data?.errors || e.message}` };
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'lookupCustomer': {
        const data = await this.apiGet('/admin/customers.json', {
          query: params.phone || params.email || params.query,
          limit: 5,
          page: 1,
        });
        const customers: any[] = data.customers || [];
        return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
      }

      case 'lookupOrder': {
        if (params.orderId) {
          const data = await this.apiGet(`/admin/orders/${params.orderId}.json`);
          const order = data.order;
          return { order, orders: order ? [order] : [], found: !!order };
        }
        const data = await this.apiGet('/admin/orders.json', {
          status: 'any',
          limit: 10,
          page: 1,
          ...(params.phone ? { phone: params.phone } : {}),
        });
        const orders: any[] = data.orders || [];
        return { orders, order: orders[0] || null, found: orders.length > 0 };
      }

      case 'createOrder': {
        const data = await this.apiPost('/admin/orders.json', { order: params.order });
        return { order: data.order, success: true };
      }

      case 'getProducts': {
        const data = await this.apiGet('/admin/products.json', {
          limit: params.limit || 20,
          page: 1,
        });
        return { products: data.products || [] };
      }

      case 'getInventory': {
        const data = await this.apiGet('/admin/inventory_items.json', { limit: 20 });
        return { items: data.inventory_items || [] };
      }

      case 'lookupProduct': {
        const data = await this.apiGet('/admin/products.json', {
          title: params.keyword,
          limit: params.limit || 10,
          page: 1,
        });
        const products: any[] = data.products || [];
        return { products, found: products.length > 0 };
      }

      default:
        throw new Error(`Sapo không hỗ trợ action: ${action}`);
    }
  }
}
