import axios from 'axios';
import { IntegrationAdapter, TestResult } from '../IntegrationAdapter';

/**
 * Casso payment webhook adapter.
 * Credentials required: apiKey
 * Optional: secretKey (for webhook signature validation)
 * Docs: https://casso.vn/docs
 */
export class CassoAdapter extends IntegrationAdapter {
  readonly type = 'casso';
  readonly name = 'Casso';

  private getHeaders() {
    return { Authorization: `apikey ${this.config.credentials.apiKey}` };
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await axios.get('https://oauth.casso.vn/v2/userInfo', {
        headers: this.getHeaders(),
        timeout: 10000,
      });
      const name = res.data?.data?.fullname || res.data?.data?.business_name || 'Casso';
      return { success: true, message: `Kết nối Casso thành công — tài khoản: ${name}` };
    } catch (e: any) {
      return { success: false, message: `Lỗi kết nối Casso: ${e.response?.data?.error || e.message}` };
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'getTransactions': {
        const res = await axios.get('https://oauth.casso.vn/v2/transactions', {
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
        const res = await axios.get('https://oauth.casso.vn/v2/bank-acc/list', {
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
        const records: any[] = params.body?.data || (params.body ? [params.body] : []);
        return { valid: true, transactions: records };
      }

      default:
        throw new Error(`Casso không hỗ trợ action: ${action}`);
    }
  }
}

