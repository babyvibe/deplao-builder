"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CassoAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const IntegrationAdapter_1 = require("../IntegrationAdapter");
/**
 * Casso payment webhook adapter.
 * Credentials required: apiKey
 * Optional: secretKey (for webhook signature validation)
 * Docs: https://casso.vn/docs
 */
class CassoAdapter extends IntegrationAdapter_1.IntegrationAdapter {
    constructor() {
        super(...arguments);
        this.type = 'casso';
        this.name = 'Casso';
    }
    getHeaders() {
        return { Authorization: `apikey ${this.config.credentials.apiKey}` };
    }
    async testConnection() {
        try {
            const res = await axios_1.default.get('https://oauth.casso.vn/v2/userInfo', {
                headers: this.getHeaders(),
                timeout: 10000,
            });
            const name = res.data?.data?.fullname || res.data?.data?.business_name || 'Casso';
            return { success: true, message: `Kết nối Casso thành công — tài khoản: ${name}` };
        }
        catch (e) {
            return { success: false, message: `Lỗi kết nối Casso: ${e.response?.data?.error || e.message}` };
        }
    }
    async executeAction(action, params) {
        switch (action) {
            case 'getTransactions': {
                const res = await axios_1.default.get('https://oauth.casso.vn/v2/transactions', {
                    headers: this.getHeaders(),
                    params: {
                        page: params.page || 1,
                        pageSize: params.pageSize || 20,
                        fromDate: params.fromDate,
                        toDate: params.toDate,
                    },
                    timeout: 10000,
                });
                return { transactions: res.data?.data?.records || [], total: res.data?.data?.totalCount || 0 };
            }
            case 'getBankAccounts': {
                const res = await axios_1.default.get('https://oauth.casso.vn/v2/bank-acc/list', {
                    headers: this.getHeaders(),
                    timeout: 10000,
                });
                return { accounts: res.data?.data?.records || [] };
            }
            case 'handleWebhook': {
                // Validate HMAC signature if secretKey is configured
                const { secretKey } = this.config.credentials;
                if (secretKey && params.signature) {
                    const crypto = require('crypto');
                    const computed = crypto.createHmac('sha256', secretKey)
                        .update(JSON.stringify(params.body)).digest('hex');
                    if (computed !== params.signature) {
                        throw new Error('Webhook signature không hợp lệ');
                    }
                }
                const records = params.body?.data || (params.body ? [params.body] : []);
                return { valid: true, transactions: records };
            }
            default:
                throw new Error(`Casso không hỗ trợ action: ${action}`);
        }
    }
}
exports.CassoAdapter = CassoAdapter;
//# sourceMappingURL=CassoAdapter.js.map