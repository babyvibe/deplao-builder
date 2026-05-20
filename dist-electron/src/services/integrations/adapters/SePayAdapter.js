"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SePayAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const IntegrationAdapter_1 = require("../IntegrationAdapter");
/**
 * SePay payment webhook adapter.
 * Credentials required: apiKey
 * Optional: webhookSecretKey
 * Docs: https://sepay.vn/tai-lieu-api.html
 */
class SePayAdapter extends IntegrationAdapter_1.IntegrationAdapter {
    constructor() {
        super(...arguments);
        this.type = 'sepay';
        this.name = 'SePay';
    }
    getHeaders() {
        return {
            Authorization: `Bearer ${this.config.credentials.apiKey}`,
            'Content-Type': 'application/json',
        };
    }
    async testConnection() {
        try {
            const res = await axios_1.default.get('https://my.sepay.vn/userapi/userinfo', {
                headers: this.getHeaders(),
                timeout: 10000,
            });
            if (res.data?.status === 200) {
                const name = res.data?.data?.fullname || 'SePay';
                return { success: true, message: `Kết nối SePay thành công — ${name}` };
            }
            return { success: false, message: res.data?.messages || 'Không thể kết nối SePay' };
        }
        catch (e) {
            return { success: false, message: `Lỗi kết nối SePay: ${e.response?.data?.messages || e.message}` };
        }
    }
    async executeAction(action, params) {
        switch (action) {
            case 'getTransactions': {
                const res = await axios_1.default.get('https://my.sepay.vn/userapi/transactions/list', {
                    headers: this.getHeaders(),
                    params: {
                        limit: params.limit || 20,
                        reference_number: params.reference,
                    },
                    timeout: 10000,
                });
                return { transactions: res.data?.transactions || [] };
            }
            case 'getBankAccounts': {
                const res = await axios_1.default.get('https://my.sepay.vn/userapi/accounts/list', {
                    headers: this.getHeaders(),
                    timeout: 10000,
                });
                return { accounts: res.data?.bankAccounts || [] };
            }
            case 'handleWebhook': {
                const { webhookSecretKey } = this.config.credentials;
                if (webhookSecretKey && params.checksum) {
                    const crypto = require('crypto');
                    const dataStr = JSON.stringify(params.body);
                    const computed = crypto.createHmac('sha256', webhookSecretKey).update(dataStr).digest('hex');
                    if (computed !== params.checksum) {
                        throw new Error('SePay webhook checksum không hợp lệ');
                    }
                }
                return { valid: true, transaction: params.body };
            }
            default:
                throw new Error(`SePay không hỗ trợ action: ${action}`);
        }
    }
}
exports.SePayAdapter = SePayAdapter;
//# sourceMappingURL=SePayAdapter.js.map