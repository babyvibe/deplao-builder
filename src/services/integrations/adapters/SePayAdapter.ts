import axios from 'axios';
import { IntegrationAdapter, TestResult } from '../IntegrationAdapter';
import {
  ParsedPayment, WebhookAuthResult, WebhookCapableAdapter, WebhookRequest, parseSePayPayload, parseWebhookBody,
  verifySePayWebhook,
} from '../paymentWebhook';
import { tr } from '../../../shared/i18n';

/**
 * SePay payment webhook adapter.
 * Credentials required: apiKey
 * Optional: webhookSecretKey = Secret Key (HMAC-SHA256, recommended) or the API Key chosen in the Security step of the SePay webhook.
 * With a key → the webhook must carry a valid signature / key.
 * Docs: https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc
 */
export class SePayAdapter extends IntegrationAdapter implements WebhookCapableAdapter {
  readonly type = 'sepay';
  readonly name = 'SePay';

  hasWebhookSecret(): boolean {
    return !!String(this.config.credentials.webhookSecretKey || '').trim();
  }

  verifyWebhook(req: WebhookRequest): WebhookAuthResult {
    return verifySePayWebhook(req, this.config.credentials.webhookSecretKey);
  }

  parseWebhook(body: any): ParsedPayment[] {
    return parseSePayPayload(body);
  }

  private getHeaders() {
    return {
      Authorization: `Bearer ${this.config.credentials.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await axios.get('https://my.sepay.vn/userapi/userinfo', {
        headers: this.getHeaders(),
        timeout: 10000,
      });
      if (res.data?.status === 200) {
        const name = res.data?.data?.fullname || 'SePay';
        return { success: true, message: tr('Kết nối SePay thành công - {{name}}', { name }) };
      }
      return { success: false, message: res.data?.messages || tr('Không thể kết nối SePay') };
    } catch (e: any) {
      return { success: false, message: tr('Lỗi kết nối SePay: {{v1}}', { v1: e.response?.data?.messages || e.message }) };
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'getTransactions': {
        const res = await axios.get('https://my.sepay.vn/userapi/transactions/list', {
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
        const res = await axios.get('https://my.sepay.vn/userapi/accounts/list', {
          headers: this.getHeaders(),
          timeout: 10000,
        });
        return { accounts: res.data?.bankAccounts || [] };
      }

      case 'handleWebhook': {
        // Same as the webhook server: params.headers + params.rawBody (the original body string; the HMAC signature is computed over exactly these bytes).
        const rawBody = Buffer.from(typeof params.rawBody === 'string' ? params.rawBody : JSON.stringify(params.body ?? {}), 'utf8');
        const body = parseWebhookBody(rawBody);
        const auth = this.verifyWebhook({ headers: params.headers || {}, rawBody, body });
        if (auth.ok === false) throw new Error(tr('Webhook SePay không hợp lệ: {{message}}', { message: auth.message }));
        return { valid: true, verified: auth.method !== 'none', transaction: body };
      }

      default:
        throw new Error(tr('SePay không hỗ trợ action: {{action}}', { action }));
    }
  }
}

