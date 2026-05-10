import axios from 'axios';
import { IntegrationAdapter, TestResult } from '../IntegrationAdapter';

/**
 * GHN Express shipping adapter.
 * Credentials required: token, shopId
 * Optional: settings.environment = 'sandbox' | 'production'
 * Docs: https://api.ghn.vn/home/docs
 */
export class GHNAdapter extends IntegrationAdapter {
  readonly type = 'ghn';
  readonly name = 'GHN Express';

  private getTokenHeaders(): Record<string, string> {
    return {
      Token: this.config.credentials.token,
      'Content-Type': 'application/json',
    };
  }

  private getBaseUrl(): string {
    return this.config.settings?.environment === 'sandbox'
      ? 'https://dev-online-gateway.ghn.vn/shiip/public-api'
      : 'https://online-gateway.ghn.vn/shiip/public-api';
  }

  private getHeaders(): Record<string, string> {
    return {
      Token: this.config.credentials.token,
      ShopId: this.config.credentials.shopId,
      'Content-Type': 'application/json',
    };
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await axios.get(`${this.getBaseUrl()}/v2/shop/all`, {
        headers: { Token: this.config.credentials.token },
        timeout: 10000,
      });
      const count = res.data?.data?.shops?.length ?? 0;
      return { success: true, message: `Kết nối GHN thành công — ${count} shop` };
    } catch (e: any) {
      return { success: false, message: `Lỗi kết nối GHN: ${e.response?.data?.message || e.message}` };
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    const base = this.getBaseUrl();
    const headers = this.getHeaders();

    switch (action) {
      case 'createOrder': {
        const res = await axios.post(`${base}/v2/shipping-order/create`, params.order || params, {
          headers,
          timeout: 15000,
        });
        return { order: res.data?.data || {} };
      }

      case 'getTracking': {
        const res = await axios.post(
          `${base}/v2/shipping-order/detail`,
          { order_code: params.orderCode },
          { headers, timeout: 10000 },
        );
        return { tracking: res.data?.data || {} };
      }

      case 'cancelOrder': {
        const res = await axios.post(
          `${base}/v2/switch-status/cancel`,
          { order_codes: [params.orderCode] },
          { headers, timeout: 10000 },
        );
        return { success: true, data: res.data?.data };
      }

      case 'calculateFee': {
        const res = await axios.post(`${base}/v2/shipping-order/fee`, params, {
          headers,
          timeout: 10000,
        });
        return { fee: res.data?.data || {} };
      }

      case 'getProvinces': {
        const res = await axios.get(`${base}/master-data/province`, {
          headers: { Token: this.config.credentials.token },
          timeout: 10000,
        });
        return { provinces: res.data?.data || [] };
      }

      case 'getDistricts': {
        const res = await axios.get(`${base}/master-data/district`, {
          headers: this.getTokenHeaders(),
          params: { province_id: params.provinceId },
          timeout: 10000,
        });
        return { districts: res.data?.data || [] };
      }

      case 'getWards': {
        const districtId = Number(params.districtId ?? params.district_id);
        if (!districtId) throw new Error('Thiếu districtId để lấy phường/xã GHN');
        const res = await axios.post(
          `${base}/master-data/ward`,
          { district_id: districtId },
          {
            headers: this.getTokenHeaders(),
            timeout: 10000,
          },
        );
        return { wards: res.data?.data || [] };
      }

      case 'getServices': {
        const fromDistrict = Number(params.fromDistrict ?? params.from_district);
        const toDistrict = Number(params.toDistrict ?? params.to_district);
        const shopId = Number(params.shopId ?? params.shop_id ?? this.config.credentials.shopId);
        if (!fromDistrict || !toDistrict || !shopId) {
          throw new Error('Thiếu fromDistrict / toDistrict / shopId để lấy dịch vụ GHN');
        }
        const res = await axios.post(
          `${base}/v2/shipping-order/available-services`,
          {
            shop_id: shopId,
            from_district: fromDistrict,
            to_district: toDistrict,
          },
          {
            headers: this.getTokenHeaders(),
            timeout: 10000,
          },
        );
        return { services: res.data?.data || [] };
      }

      default:
        throw new Error(`GHN không hỗ trợ action: ${action}`);
    }
  }
}

