"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GHTKAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const IntegrationAdapter_1 = require("../IntegrationAdapter");
/**
 * Giao Hàng Tiết Kiệm (GHTK) shipping adapter.
 * Credentials required: token
 * Docs: https://docs.giaohangtietkiem.vn/
 */
class GHTKAdapter extends IntegrationAdapter_1.IntegrationAdapter {
    constructor() {
        super(...arguments);
        this.type = 'ghtk';
        this.name = 'GHTK';
        this.BASE_URL = 'https://services.giaohangtietkiem.vn';
    }
    getHeaders() {
        return {
            Token: this.config.credentials.token,
            'Content-Type': 'application/json',
        };
    }
    async testConnection() {
        try {
            const res = await axios_1.default.get(`${this.BASE_URL}/services/balance`, {
                headers: this.getHeaders(),
                timeout: 10000,
            });
            if (res.data?.success) {
                const balance = res.data?.data?.balance ?? 0;
                return { success: true, message: `Kết nối GHTK thành công — Số dư: ${balance.toLocaleString('vi-VN')}đ` };
            }
            return { success: false, message: res.data?.message || 'Không thể kết nối GHTK' };
        }
        catch (e) {
            return { success: false, message: `Lỗi kết nối GHTK: ${e.response?.data?.message || e.message}` };
        }
    }
    async executeAction(action, params) {
        switch (action) {
            case 'createOrder': {
                const res = await axios_1.default.post(`${this.BASE_URL}/services/shipment/order`, params, { headers: this.getHeaders(), timeout: 15000 });
                if (!res.data?.success)
                    throw new Error(res.data?.message || 'Tạo đơn GHTK thất bại');
                return { order: res.data?.order || {} };
            }
            case 'getTracking': {
                const code = encodeURIComponent(params.trackingCode);
                const res = await axios_1.default.get(`${this.BASE_URL}/services/shipment/v2/${code}`, { headers: this.getHeaders(), timeout: 10000 });
                if (!res.data?.success)
                    throw new Error(res.data?.message || 'Không tìm thấy vận đơn');
                return { tracking: res.data?.order || {} };
            }
            case 'cancelOrder': {
                const code = encodeURIComponent(params.trackingCode);
                const res = await axios_1.default.post(`${this.BASE_URL}/services/shipment/cancel/${code}`, {}, { headers: this.getHeaders(), timeout: 10000 });
                return { success: !!res.data?.success, message: res.data?.message };
            }
            case 'calculateFee': {
                const res = await axios_1.default.post(`${this.BASE_URL}/services/shipment/fee`, params, { headers: this.getHeaders(), timeout: 10000 });
                return { fee: res.data?.fee || {} };
            }
            default:
                throw new Error(`GHTK không hỗ trợ action: ${action}`);
        }
    }
}
exports.GHTKAdapter = GHTKAdapter;
//# sourceMappingURL=GHTKAdapter.js.map