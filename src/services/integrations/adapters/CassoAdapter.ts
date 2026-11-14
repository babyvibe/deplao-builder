import axios from 'axios';
import { IntegrationAdapter, TestResult } from '../IntegrationAdapter';
import {
  ParsedPayment, WebhookAuthResult, WebhookCapableAdapter, WebhookRequest, parseCassoPayload, parseWebhookBody,
  verifyCassoWebhook,
} from '../paymentWebhook';
import { tr } from '../../../shared/i18n';

/**
 * Casso payment webhook adapter.
 * Credentials required: apiKey
 * Optional: secretKey = the "Key bảo mật" (security key) of the Webhook V2 integration (or the old Webhook). With a key → webhooks must have a valid signature.
 * Docs: https://developer.casso.vn
 */
export class CassoAdapter extends IntegrationAdapter implements WebhookCapableAdapter {
  readonly type = 'casso';
  readonly name = 'Casso';

  hasWebhookSecret(): boolean {
    return !!String(this.config.credentials.secretKey || '').trim();
  }

  verifyWebhook(req: WebhookRequest): WebhookAuthResult {
    return verifyCassoWebhook(req, this.config.credentials.secretKey);
  }

  parseWebhook(body: any): ParsedPayment[] {
    return parseCassoPayload(body);
  }

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
      return { success: true, message: tr('Kết nối Casso thành công - tài khoản: {{name}}', { name }) };
    } catch (e: any) {
      return { success: false, message: tr('Lỗi kết nối Casso: {{v1}}', { v1: e.response?.data?.error || e.message }) };
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
        // Same as the webhook server: params.headers + params.rawBody (the original body string); if a key is set, a valid signature is required.
        const rawBody = Buffer.from(typeof params.rawBody === 'string' ? params.rawBody : JSON.stringify(params.body ?? {}), 'utf8');
        const body = parseWebhookBody(rawBody);
        const auth = this.verifyWebhook({ headers: params.headers || {}, rawBody, body });
        if (auth.ok === false) throw new Error(tr('Webhook Casso không hợp lệ: {{message}}', { message: auth.message }));
        return { valid: true, verified: auth.method !== 'none', transactions: this.parseWebhook(body).map(p => p.raw) };
      }

      default:
        throw new Error(tr('Casso không hỗ trợ action: {{action}}', { action }));
    }
  }
}

