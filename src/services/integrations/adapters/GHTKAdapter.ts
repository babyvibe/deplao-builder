import axios from 'axios';
import { IntegrationAdapter, TestResult } from '../IntegrationAdapter';
import { tr } from '../../../shared/i18n';

/**
 * GHTK (Giao Hàng Tiết Kiệm) shipping adapter.
 * Credentials: token (customer site → Thông tin shop → Cấu hình API), partnerCode (optional): shop code / partner code sent
 * as `X-Client-Source`, which every API page of the current docs lists next to `Token`.
 * Docs: https://api.ghtk.vn/docs/submit-order/logistic-overview
 *  - Addresses: ward + province are required, district is optional (2-level units after 01/07/2025 are accepted).
 *  - Fee: GET /services/shipment/fee with the parameters in the query string.
 *  - Connection check: /services/authenticated.
 */
export class GHTKAdapter extends IntegrationAdapter {
  readonly type = 'ghtk';
  readonly name = 'GHTK';

  private readonly BASE_URL = 'https://services.giaohangtietkiem.vn';

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Token: this.config.credentials.token,
      'Content-Type': 'application/json',
    };
    const partnerCode = String(this.config.credentials.partnerCode ?? '').trim();
    if (partnerCode) headers['X-Client-Source'] = partnerCode;
    return headers;
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await axios.get(`${this.BASE_URL}/services/authenticated`, {
        headers: this.getHeaders(),
        timeout: 10000,
      });
      if (res.data?.success) return { success: true, message: tr('Kết nối GHTK thành công') };
      return { success: false, message: res.data?.message || tr('Không thể kết nối GHTK') };
    } catch (e: any) {
      // A wrong token answers 403 with an empty body
      if (e.response?.status === 403) return { success: false, message: tr('Lỗi kết nối GHTK: {{v1}}', { v1: tr('Token không hợp lệ hoặc thiếu quyền') }) };
      return { success: false, message: tr('Lỗi kết nối GHTK: {{v1}}', { v1: e.response?.data?.message || e.message }) };
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'createOrder': {
        const res = await axios.post(
          `${this.BASE_URL}/services/shipment/order`,
          params,
          { headers: this.getHeaders(), timeout: 15000 },
        );
        if (!res.data?.success) throw new Error(res.data?.message || tr('Tạo đơn GHTK thất bại'));
        return { order: res.data?.order || {} };
      }

      case 'getTracking': {
        const code = encodeURIComponent(params.trackingCode);
        const res = await axios.get(
          `${this.BASE_URL}/services/shipment/v2/${code}`,
          { headers: this.getHeaders(), timeout: 10000 },
        );
        if (!res.data?.success) throw new Error(res.data?.message || tr('Không tìm thấy vận đơn'));
        return { tracking: res.data?.order || {} };
      }

      case 'cancelOrder': {
        const code = encodeURIComponent(params.trackingCode);
        const res = await axios.post(
          `${this.BASE_URL}/services/shipment/cancel/${code}`,
          {},
          { headers: this.getHeaders(), timeout: 10000 },
        );
        return { success: !!res.data?.success, message: res.data?.message };
      }

      case 'calculateFee': {
        // Empty values are left out: GHTK reads "" as a given (wrong) value
        const query: Record<string, any> = {};
        for (const [key, value] of Object.entries(params || {})) {
          if (value !== undefined && value !== null && String(value).trim() !== '') query[key] = value;
        }
        const res = await axios.get(`${this.BASE_URL}/services/shipment/fee`, {
          headers: this.getHeaders(),
          params: query,
          timeout: 10000,
        });
        if (res.data?.success === false) throw new Error(res.data?.message || tr('Tính phí GHTK thất bại'));
        return { fee: res.data?.fee || {} };
      }

      default:
        throw new Error(tr('GHTK không hỗ trợ action: {{action}}', { action }));
    }
  }
}
