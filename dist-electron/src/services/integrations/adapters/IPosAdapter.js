"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPosAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const IntegrationAdapter_1 = require("../IntegrationAdapter");
/**
 * iPOS Vietnam (iPos.vn) adapter — F&B / Retail POS
 * Credentials required: apiKey, storeCode
 * Docs: https://developer.ipos.vn/
 */
class IPosAdapter extends IntegrationAdapter_1.IntegrationAdapter {
    constructor(config) {
        super(config);
        this.type = 'ipos';
        this.name = 'iPOS';
        this.BASE_URL = 'https://api.ipos.vn/api/v1';
    }
    getHeaders() {
        const { apiKey } = this.config.credentials;
        if (!apiKey)
            throw new Error('Thiếu API Key iPOS');
        return {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        };
    }
    getStoreCode() {
        return this.config.credentials.storeCode || '';
    }
    async apiGet(path, params) {
        const res = await axios_1.default.get(`${this.BASE_URL}${path}`, {
            headers: this.getHeaders(),
            params: { store_code: this.getStoreCode(), ...params },
            timeout: 15000,
        });
        return res.data;
    }
    async apiPost(path, body) {
        const res = await axios_1.default.post(`${this.BASE_URL}${path}`, body, {
            headers: this.getHeaders(),
            timeout: 15000,
        });
        return res.data;
    }
    async testConnection() {
        try {
            const data = await this.apiGet('/store/info');
            const name = data?.data?.name || data?.data?.store_name || 'iPOS';
            return { success: true, message: `Kết nối iPOS thành công — cửa hàng: ${name}` };
        }
        catch (e) {
            return { success: false, message: `Lỗi kết nối iPOS: ${e.response?.data?.message || e.message}` };
        }
    }
    async executeAction(action, params) {
        switch (action) {
            case 'lookupCustomer': {
                const data = await this.apiGet('/customers', {
                    phone: params.phone,
                    page: 1,
                    per_page: 5,
                });
                const customers = data.data?.items || data.data || [];
                return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
            }
            case 'lookupOrder': {
                if (params.orderId) {
                    const data = await this.apiGet(`/orders/${params.orderId}`);
                    const order = data.data;
                    return { order, orders: order ? [order] : [], found: !!order };
                }
                const data = await this.apiGet('/orders', {
                    phone: params.phone,
                    page: 1,
                    per_page: 10,
                });
                const orders = data.data?.items || data.data || [];
                return { orders, order: orders[0] || null, found: orders.length > 0 };
            }
            case 'createOrder': {
                // Accept both direct payload and wrapped { order } payload from workflow/runtime callers.
                const payload = params?.order && typeof params.order === 'object' ? params.order : params;
                const data = await this.apiPost('/invoices', payload);
                return { order: data.data, success: true };
            }
            case 'getProducts': {
                const data = await this.apiGet('/products', {
                    page: 1,
                    per_page: params.limit || 20,
                });
                return { products: data.data?.items || data.data || [] };
            }
            case 'lookupProduct': {
                const data = await this.apiGet('/products', {
                    keyword: params.keyword,
                    page: 1,
                    per_page: params.limit || 10,
                });
                const products = data.data?.items || data.data || [];
                return { products, found: products.length > 0 };
            }
            case 'getRevenue': {
                const data = await this.apiGet('/reports/revenue', {
                    from_date: params.fromDate,
                    to_date: params.toDate,
                });
                return { revenue: data.data };
            }
            default:
                throw new Error(`iPOS không hỗ trợ action: ${action}`);
        }
    }
}
exports.IPosAdapter = IPosAdapter;
//# sourceMappingURL=IPosAdapter.js.map