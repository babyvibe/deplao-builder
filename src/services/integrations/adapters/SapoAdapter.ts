import axios from 'axios';
import https from 'https';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';

/**
 * Sapo POS adapter.
 * Credentials required: accessToken, storeDomain (e.g. "myshop" for myshop.mysapo.net)
 * Auth: OAuth2 — access_token lấy từ SAPO Admin, gửi qua header X-Sapo-Access-Token
 * Docs: https://support.sapo.vn/gioi-thieu-api
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
    const { accessToken } = this.config.credentials;
    if (!accessToken) throw new Error('Thiếu Access Token Sapo');
    return {
      'X-Sapo-Access-Token': accessToken,
      'Content-Type': 'application/json',
    };
  }

  /** Custom HTTPS Agent để tránh lỗi SSL handshake với SAPO server */
  private getHttpsAgent() {
    const crypto = require('crypto');
    let secureOptions = 0;
    // Chỉ set flag nếu constant tồn tại (OpenSSL). Bỏ qua nếu không (BoringSSL/Electron).
    try {
      if (typeof crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION === 'number') {
        secureOptions |= crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;
      }
    } catch (_) { /* BoringSSL: constant không tồn tại */ }

    return new https.Agent({
      rejectUnauthorized: true,
      // BoringSSL trên Electron không handle renegotiation tốt với keepAlive.
      // Tắt keepAlive để mỗi request tạo handshake mới → tránh renegotiation.
      keepAlive: false,
      // Cipher suite tương thích với Cloudflare và BoringSSL, ưu tiên TLS 1.2
      ciphers: [
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305',
        'DHE-RSA-AES128-GCM-SHA256',
        'DHE-RSA-AES256-GCM-SHA384',
      ].join(':'),
      honorCipherOrder: true,
      ecdhCurve: 'auto',
      secureOptions,
    });
  }

  private getAxiosConfig() {
    return {
      headers: this.getHeaders(),
      timeout: 15000,
      httpsAgent: this.getHttpsAgent(),
    };
  }

  private async apiGet(path: string, params?: Record<string, any>): Promise<any> {
    const res = await axios.get(`${this.getBaseUrl()}${path}`, {
      ...this.getAxiosConfig(),
      params,
    });
    return res.data;
  }

  private async apiPost(path: string, body: any): Promise<any> {
    const res = await axios.post(`${this.getBaseUrl()}${path}`, body, {
      ...this.getAxiosConfig(),
    });
    return res.data;
  }

  async testConnection(): Promise<TestResult> {
    try {
      // Validate credentials trước khi gọi API
      const { storeDomain, accessToken } = this.config.credentials;
      if (!storeDomain) return { success: false, message: 'Thiếu tên store (subdomain) — VD: ten-cua-hang' };
      if (!accessToken) return { success: false, message: 'Thiếu Access Token — lấy từ SAPO Admin → Cài đặt → Phát triển → API' };

      const data = await this.apiGet('/admin/store.json');
      const name = data?.store?.name || data?.store?.domain || 'Sapo Store';
      return { success: true, message: `Kết nối Sapo thành công — store: ${name}` };
    } catch (e: any) {
      // Phân loại lỗi
      const isTlsError = e.code === 'EPROTO' || e.message?.includes('handshake') || e.message?.includes('SSL');
      const isDnsError = e.code === 'ENOTFOUND' || e.message?.includes('ENOTFOUND');
      const isTimeout = e.code === 'ECONNABORTED' || e.message?.includes('timeout');
      const isAuthError = e.response?.status === 401 || e.response?.status === 403;

      if (isTlsError) {
        const hint = e.message?.includes('BoringSSL') || e.message?.includes('third_party')
          ? 'Phần mềm đang chạy trên Electron (BoringSSL). Thử tắt tường lửa / VPN, hoặc kiểm tra proxy.'
          : '';
        return { success: false, message: `Lỗi SSL/TLS — Kiểm tra storeDomain "${this.config.credentials.storeDomain}" có đúng không. Chi tiết: ${e.message}. ${hint}`.trim() };
      }
      if (isDnsError) {
        return { success: false, message: `Không tìm thấy domain "${this.config.credentials.storeDomain}.mysapo.net" — kiểm tra lại tên store` };
      }
      if (isTimeout) {
        return { success: false, message: `Kết nối tới Sapo bị timeout — kiểm tra mạng hoặc tường lửa` };
      }
      if (isAuthError) {
        return { success: false, message: `Sai Access Token hoặc token hết hạn — kiểm tra lại token trong SAPO Admin` };
      }

      return { success: false, message: `Lỗi kết nối Sapo: ${e.response?.data?.errors || e.message}` };
    }
  }

  /**
   * Tìm khách hàng theo SĐT hoặc email.
   * SAPO Customer API KHÔNG hỗ trợ search param — phải fetch rồi filter client-side.
   */
  private async findCustomers(keyword: string, limit: number): Promise<any[]> {
    const data = await this.apiGet('/admin/customers.json', {
      fields: 'id,first_name,last_name,email,phone,default_address,addresses,note,tags',
      limit: 250, // max SAPO cho phép
      page: 1,
    });
    const all: any[] = data.customers || [];
    const kw = keyword.toLowerCase().trim();

    // Filter: match phone hoặc email
    return all
      .filter(c => {
        if (c.email?.toLowerCase() === kw) return true;
        if (c.phone?.replace(/[\s.-]/g, '') === kw.replace(/[\s.-]/g, '')) return true;
        // Check default_address.phone
        if (c.default_address?.phone?.replace(/[\s.-]/g, '') === kw.replace(/[\s.-]/g, '')) return true;
        // Check all addresses
        if (c.addresses?.some((a: any) => a.phone?.replace(/[\s.-]/g, '') === kw.replace(/[\s.-]/g, ''))) return true;
        return false;
      })
      .slice(0, limit);
  }

  /**
   * Filter sản phẩm theo keyword (title).
   * SAPO Product API KHÔNG hỗ trợ param title — phải fetch rồi filter client-side.
   */
  private async filterProducts(keyword: string, limit: number): Promise<any[]> {
    const data = await this.apiGet('/admin/products.json', {
      fields: 'id,title,images,product_type,variants',
      limit: 250,
      page: 1,
    });
    const all: any[] = data.products || [];
    const kw = keyword.toLowerCase().trim();
    if (!kw) return all.slice(0, limit);

    return all
      .filter(p =>
        (p.title || '').toLowerCase().includes(kw) ||
        (p.product_type || '').toLowerCase().includes(kw) ||
        (p.variants || []).some((v: any) =>
          (v.sku || '').toLowerCase().includes(kw) ||
          (v.barcode || '').toLowerCase().includes(kw),
        )
      )
      .slice(0, limit);
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'lookupCustomer': {
        const keyword = params.phone || params.email || params.query;
        if (!keyword) throw new Error('Cần cung cấp SĐT hoặc email để tra cứu khách hàng');
        const customers = await this.findCustomers(keyword, params.limit || 5);
        return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
      }

      case 'lookupOrder': {
        if (params.orderId) {
          const data = await this.apiGet(`/admin/orders/${params.orderId}.json`);
          const order = data.order;
          return { order, orders: order ? [order] : [], found: !!order };
        }

        // Tra cứu theo SĐT: lookup customer → lấy customerId → query orders
        if (params.phone) {
          const customers = await this.findCustomers(params.phone, 1);
          const customer = customers[0];
          if (!customer) {
            return { orders: [], order: null, found: false, message: 'Không tìm thấy khách hàng với SĐT này' };
          }
          const data = await this.apiGet('/admin/orders.json', {
            customer_id: customer.id,
            limit: params.limit || 10,
          });
          const orders: any[] = data.orders || [];
          return { orders, order: orders[0] || null, found: orders.length > 0, customer };
        }

        // Tra cứu theo customerId
        if (params.customerId) {
          const data = await this.apiGet('/admin/orders.json', {
            customer_id: params.customerId,
            limit: params.limit || 10,
          });
          const orders: any[] = data.orders || [];
          return { orders, order: orders[0] || null, found: orders.length > 0 };
        }

        throw new Error('Cần cung cấp orderId, customerId hoặc phone');
      }

      case 'createOrder': {
        const data = await this.apiPost('/admin/orders.json', { order: params.order });
        return { order: data.order, success: true };
      }

      case 'getProducts': {
        const data = await this.apiGet('/admin/products.json', {
          fields: 'id,title,images,product_type,variants',
          limit: params.limit || 20,
          page: 1,
        });
        return { products: data.products || [] };
      }

      case 'getInventory': {
        // SAPO KHÔNG có endpoint /admin/inventory_items.json
        // Thay vào đó, đọc inventory_quantity từ variants của products
        const data = await this.apiGet('/admin/products.json', {
          fields: 'id,title,variants',
          limit: params.limit || 50,
          page: 1,
        });
        const products: any[] = data.products || [];
        // Flatten variants → items với thông tin tồn kho
        const items = products.flatMap((p: any) =>
          (p.variants || []).map((v: any) => ({
            product_id: p.id,
            product_title: p.title,
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

      case 'lookupProduct': {
        if (!params.keyword) throw new Error('Cần cung cấp keyword để tìm sản phẩm');
        const products = await this.filterProducts(params.keyword, params.limit || 10);
        return { products, found: products.length > 0 };
      }

      default:
        throw new Error(`Sapo không hỗ trợ action: ${action}`);
    }
  }
}
