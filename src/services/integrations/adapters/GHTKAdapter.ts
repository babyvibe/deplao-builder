import axios from 'axios';
import { IntegrationAdapter, TestResult } from '../IntegrationAdapter';

/**
 * Giao Hàng Tiết Kiệm (GHTK) shipping adapter.
 * Credentials required: token
 * Docs: https://docs.giaohangtietkiem.vn/
 */
export class GHTKAdapter extends IntegrationAdapter {
  readonly type = 'ghtk';
  readonly name = 'GHTK';

  private readonly BASE_URL = 'https://services.giaohangtietkiem.vn';

  private getHeaders(): Record<string, string> {
    return {
      Token: this.config.credentials.token,
      'Content-Type': 'application/json',
    };
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await axios.get(`${this.BASE_URL}/services/balance`, {
        headers: this.getHeaders(),
        timeout: 10000,
      });
      if (res.data?.success) {
        const balance = res.data?.data?.balance ?? 0;
        return { success: true, message: `Kết nối GHTK thành công — Số dư: ${balance.toLocaleString('vi-VN')}đ` };
      }
      return { success: false, message: res.data?.message || 'Không thể kết nối GHTK' };
    } catch (e: any) {
      return { success: false, message: `Lỗi kết nối GHTK: ${e.response?.data?.message || e.message}` };
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
        if (!res.data?.success) throw new Error(res.data?.message || 'Tạo đơn GHTK thất bại');
        return { order: res.data?.order || {} };
      }

      case 'getTracking': {
        const code = encodeURIComponent(params.trackingCode);
        const res = await axios.get(
          `${this.BASE_URL}/services/shipment/v2/${code}`,
          { headers: this.getHeaders(), timeout: 10000 },
        );
        if (!res.data?.success) throw new Error(res.data?.message || 'Không tìm thấy vận đơn');
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
        const res = await axios.post(
          `${this.BASE_URL}/services/shipment/fee`,
          params,
          { headers: this.getHeaders(), timeout: 10000 },
        );
        return { fee: res.data?.fee || {} };
      }

      default:
        throw new Error(`GHTK không hỗ trợ action: ${action}`);
    }
  }
}

