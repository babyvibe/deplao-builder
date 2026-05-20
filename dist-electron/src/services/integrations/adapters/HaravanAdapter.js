"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HaravanAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const IntegrationAdapter_1 = require("../IntegrationAdapter");
/**
 * Haravan POS adapter.
 * Credentials:
 *   - Modern (khuyên dùng): accessToken, retailerDomain
 *   - Legacy private app:   apiKey, password, retailerDomain
 * Docs: https://docs.haravan.com/
 */
class HaravanAdapter extends IntegrationAdapter_1.IntegrationAdapter {
    constructor(config) {
        super(config);
        this.type = 'haravan';
        this.name = 'Haravan';
    }
    getBaseUrl() {
        const { retailerDomain } = this.config.credentials;
        if (!retailerDomain)
            throw new Error('Thiếu retailerDomain (tên shop Haravan)');
        // Cho phép user nhập cả "myshop" lẫn "myshop.myharavan.com"
        const domain = retailerDomain.includes('.') ? retailerDomain : `${retailerDomain}.myharavan.com`;
        return `https://${domain}`;
    }
    getHeaders() {
        const { accessToken, apiKey, password } = this.config.credentials;
        // Ưu tiên dùng access token (OAuth / Custom App) — đúng chuẩn Haravan docs
        if (accessToken) {
            return {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            };
        }
        // Fallback: Legacy private app (apiKey:password Basic Auth)
        if (!apiKey || !password)
            throw new Error('Thiếu Access Token hoặc API Key + Password Haravan');
        const token = Buffer.from(`${apiKey}:${password}`).toString('base64');
        return {
            Authorization: `Basic ${token}`,
            'Content-Type': 'application/json',
        };
    }
    async apiGet(path, params) {
        const res = await axios_1.default.get(`${this.getBaseUrl()}${path}`, {
            headers: this.getHeaders(),
            params,
            timeout: 15000,
        });
        return res.data;
    }
    async apiPost(path, body) {
        const res = await axios_1.default.post(`${this.getBaseUrl()}${path}`, body, {
            headers: this.getHeaders(),
            timeout: 15000,
        });
        return res.data;
    }
    async testConnection() {
        try {
            const data = await this.apiGet('/admin/shop.json');
            const shopName = data?.shop?.name || data?.shop?.domain || 'Haravan Shop';
            return { success: true, message: `Kết nối Haravan thành công — shop: ${shopName}` };
        }
        catch (e) {
            return { success: false, message: `Lỗi kết nối Haravan: ${e.response?.data?.errors || e.message}` };
        }
    }
    async executeAction(action, params) {
        switch (action) {
            case 'lookupCustomer': {
                const data = await this.apiGet('/admin/customers/search.json', {
                    query: params.phone || params.email || params.query,
                    limit: 5,
                });
                const customers = data.customers || [];
                return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
            }
            case 'lookupOrder': {
                if (params.orderId) {
                    const data = await this.apiGet(`/admin/orders/${params.orderId}.json`);
                    const order = data.order;
                    return { order, orders: order ? [order] : [], found: !!order };
                }
                if (params.customerId) {
                    // Tra cứu trực tiếp bằng customer_id
                    const data = await this.apiGet('/admin/orders.json', {
                        status: 'any',
                        customer_id: params.customerId,
                        limit: params.limit || 10,
                    });
                    const orders = data.orders || [];
                    return { orders, order: orders[0] || null, found: orders.length > 0 };
                }
                if (params.phone) {
                    // Haravan /admin/orders.json KHÔNG hỗ trợ param `phone` —
                    // phải lookup customer trước → lấy customer id → query orders
                    const custData = await this.apiGet('/admin/customers/search.json', {
                        query: params.phone,
                        limit: 1,
                    });
                    const customer = (custData.customers || [])[0];
                    if (!customer) {
                        return { orders: [], found: false, message: 'Không tìm thấy khách hàng với SĐT này' };
                    }
                    const data = await this.apiGet('/admin/orders.json', {
                        status: 'any',
                        customer_id: customer.id,
                        limit: params.limit || 10,
                    });
                    const orders = data.orders || [];
                    return { orders, order: orders[0] || null, found: orders.length > 0, customer };
                }
                throw new Error('Cần cung cấp orderId, customerId hoặc phone');
            }
            case 'createOrder': {
                const data = await this.apiPost('/admin/orders.json', { order: params.order });
                return { order: data.order, success: true };
            }
            case 'getProducts': {
                const data = await this.apiGet('/admin/products.json', { limit: params.limit || 20 });
                return { products: data.products || [] };
            }
            case 'lookupProduct': {
                // Haravan /admin/products.json?title=X chỉ exact match —
                // nên lấy nhiều hơn rồi client-side filter partial match
                const limit = params.limit || 50;
                const data = await this.apiGet('/admin/products.json', {
                    limit,
                });
                const keyword = (params.keyword || '').toLowerCase().trim();
                let products = data.products || [];
                if (keyword) {
                    products = products.filter((p) => (p.title || '').toLowerCase().includes(keyword) ||
                        (p.handle || '').toLowerCase().includes(keyword) ||
                        (p.product_type || '').toLowerCase().includes(keyword) ||
                        (p.variants || []).some((v) => (v.sku || '').toLowerCase().includes(keyword) ||
                            (v.barcode || '').toLowerCase().includes(keyword)));
                }
                return { products, found: products.length > 0 };
            }
            default:
                throw new Error(`Haravan không hỗ trợ action: ${action}`);
        }
    }
}
exports.HaravanAdapter = HaravanAdapter;
//# sourceMappingURL=HaravanAdapter.js.map