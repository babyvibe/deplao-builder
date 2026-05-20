"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NhanhAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const IntegrationAdapter_1 = require("../IntegrationAdapter");
/**
 * Nhanh.vn Open API v3 adapter.
 * Credentials required: appId, businessId, accessToken (from open.nhanh.vn)
 * Docs: https://open.nhanh.vn/
 * NOTE: v3.0 uses the POS domain, versioned paths, raw Authorization header,
 * and appId/businessId in the query string.
 */
class NhanhAdapter extends IntegrationAdapter_1.IntegrationAdapter {
    constructor(config) {
        super(config);
        this.type = 'nhanh';
        this.name = 'Nhanh.vn';
        this.BASE_URL = 'https://pos.open.nhanh.vn/v3.0';
    }
    getAppId() {
        return String(this.config.credentials.appId || '').trim();
    }
    getHeaders() {
        const accessToken = String(this.config.credentials.accessToken || '').trim();
        if (!accessToken)
            throw new Error('Thiếu Access Token Nhanh.vn');
        return {
            Authorization: accessToken.replace(/^Bearer\s+/i, ''),
            'Content-Type': 'application/json',
        };
    }
    getBusinessId() {
        return String(this.config.credentials.businessId || '').trim();
    }
    buildUrl(endpoint) {
        const appId = this.getAppId();
        const businessId = this.getBusinessId();
        if (!appId)
            throw new Error('Thiếu App ID Nhanh.vn');
        if (!businessId)
            throw new Error('Thiếu Business ID Nhanh.vn');
        const query = new URLSearchParams({
            appId,
            businessId,
        });
        return `${this.BASE_URL}/${endpoint}?${query.toString()}`;
    }
    async apiPost(endpoint, data = {}) {
        try {
            const res = await axios_1.default.post(this.buildUrl(endpoint), data, {
                headers: this.getHeaders(),
                timeout: 15000,
            });
            return res.data;
        }
        catch (e) {
            // Extract readable error from Nhanh API response body when axios throws on 4xx/5xx
            if (e.response?.data) {
                const errData = e.response.data;
                const msg = this.formatApiError(errData.messages ?? errData.message, e.message);
                throw new Error(msg);
            }
            throw e;
        }
    }
    unwrapList(data) {
        if (Array.isArray(data))
            return data;
        if (Array.isArray(data?.data))
            return data.data;
        if (Array.isArray(data?.items))
            return data.items;
        if (data && typeof data === 'object')
            return Object.values(data);
        return [];
    }
    formatApiError(messages, fallback) {
        if (!messages)
            return fallback;
        if (typeof messages === 'string')
            return messages;
        if (Array.isArray(messages))
            return messages.join('; ');
        if (typeof messages === 'object') {
            const parts = Object.entries(messages).map(([k, v]) => `${k}: ${v}`);
            return parts.length > 0 ? parts.join('; ') : fallback;
        }
        return String(messages) || fallback;
    }
    assertSuccess(res, fallbackMessage) {
        if (res?.code === 1)
            return;
        throw new Error(this.formatApiError(res?.messages ?? res?.message, fallbackMessage));
    }
    async testConnection() {
        try {
            const res = await this.apiPost('product/list', {
                filters: {},
                paginator: { size: 1 },
            });
            if (res?.code === 1) {
                const products = this.unwrapList(res?.data);
                const name = products[0]?.name || `Business ${this.getBusinessId()}`;
                return { success: true, message: `Kết nối Nhanh.vn (API v3) thành công — cửa hàng: ${name}` };
            }
            return { success: false, message: this.formatApiError(res?.messages, 'Kết nối Nhanh.vn thất bại') };
        }
        catch (e) {
            return { success: false, message: `Lỗi kết nối Nhanh.vn: ${e.response?.data?.messages || e.message}` };
        }
    }
    async executeAction(action, params) {
        switch (action) {
            case 'lookupCustomer': {
                const res = await this.apiPost('customer/list', {
                    filters: {
                        mobile: params.phone,
                    },
                    paginator: {
                        size: 5,
                    },
                });
                this.assertSuccess(res, 'Tra cứu khách hàng Nhanh.vn thất bại');
                const customers = this.unwrapList(res?.data);
                return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
            }
            case 'lookupOrder': {
                const filters = {};
                // Nhanh v3 order/list filter structure (from docs):
                // - ids: array of order IDs
                // - shippingAddress.mobile: customer phone (nested!)
                // - shippingAddress.id: customer ID
                if (params.orderId)
                    filters.ids = [params.orderId];
                if (params.phone)
                    filters.shippingAddress = { mobile: params.phone };
                const res = await this.apiPost('order/list', {
                    filters,
                    paginator: {
                        size: 10,
                        page: params.page || 1,
                    },
                });
                this.assertSuccess(res, 'Tra cứu đơn hàng Nhanh.vn thất bại');
                const orders = this.unwrapList(res?.data);
                return { orders, order: orders[0] || null, found: orders.length > 0 };
            }
            case 'createOrder': {
                // params is the structured v3 payload from platformOrderAdapters.toNhanh
                // (nested: info, channel, shippingAddress, products, payment)
                // appId & businessId are already in the query string via buildUrl — do NOT add to body.
                // Accept both direct payload and wrapped { order } from workflow callers.
                const payload = params?.order && typeof params.order === 'object' ? params.order : params;
                const res = await this.apiPost('order/add', payload);
                if (res.code === 1) {
                    return { order: res.data, orderId: res.data?.id, success: true };
                }
                throw new Error(this.formatApiError(res.messages ?? res.message, 'Tạo đơn hàng Nhanh.vn thất bại'));
            }
            case 'getProducts':
            case 'lookupProduct': {
                const filters = {};
                if (params.keyword)
                    filters.name = params.keyword;
                if (params.code)
                    filters.code = params.code;
                const res = await this.apiPost('product/list', {
                    filters,
                    paginator: {
                        size: params.limit || 10,
                    },
                });
                this.assertSuccess(res, 'Tra cứu sản phẩm Nhanh.vn thất bại');
                const products = this.unwrapList(res?.data);
                return { products, found: products.length > 0 };
            }
            case 'updateOrderStatus': {
                const res = await this.apiPost('order/edit', {
                    id: params.orderId,
                    statusCode: params.statusCode,
                });
                return { success: res.code === 1, message: this.formatApiError(res.messages, '') };
            }
            default:
                throw new Error(`Nhanh.vn không hỗ trợ action: ${action}`);
        }
    }
}
exports.NhanhAdapter = NhanhAdapter;
//# sourceMappingURL=NhanhAdapter.js.map