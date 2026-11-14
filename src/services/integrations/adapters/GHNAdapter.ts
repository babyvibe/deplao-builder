import axios from 'axios';
import { IntegrationAdapter, TestResult } from '../IntegrationAdapter';
import { tr } from '../../../shared/i18n';

/**
 * GHN address model for one address block (to_ / from_ / return_), per developer.ghn.vn → Create Order:
 * the block is sent by name (ward + province, plus district for an old address) and `is_new_<block>_address` tells GHN
 * which scheme it is: true = the 2-level units after 01/07/2025 (no district), false (GHN's default) = old 3-level units.
 * When the flag is missing it is inferred: ward + province names without a district name → new address. A new address
 * carries no district, so old district / ward ids left in the order are removed (they would contradict the names).
 */
function withAddressModel(order: Record<string, any>, prefix: 'to' | 'from' | 'return'): void {
  const flag = `is_new_${prefix}_address`;
  if (order[flag] === undefined && order[`${prefix}_ward_name`] && order[`${prefix}_province_name`]) {
    order[flag] = !order[`${prefix}_district_name`];
  }
  if (order[flag] === true) {
    delete order[`${prefix}_district_name`];
    delete order[`${prefix}_district_id`];
    delete order[`${prefix}_ward_code`];
  }
}

/** Order body for POST /v2/shipping-order/create with the address flags set (pure, tested). */
export function prepareGhnOrder(order: Record<string, any>): Record<string, any> {
  const out = { ...(order || {}) };
  withAddressModel(out, 'to');
  withAddressModel(out, 'from');
  withAddressModel(out, 'return');
  return out;
}

/**
 * GHN Express shipping adapter.
 * Credentials required: token, shopId
 * Optional: settings.environment = 'sandbox' | 'production'
 * Docs: https://developer.ghn.vn/en/docs/getting-started/overview
 *  - Create order: by names + is_new_to_address (2-level units after 01/07/2025); the district-id fields are legacy.
 *  - Fee / available services: still district + ward codes (legacy master data: /master-data/province|district|ward).
 *  - New master data (2-level): /v3/master-data/province/all, /v3/master-data/ward/all-by-province-id.
 */
export class GHNAdapter extends IntegrationAdapter {
  readonly type = 'ghn';
  readonly name = 'GHN Express';

  private getBaseUrl(): string {
    return this.config.settings?.environment === 'sandbox'
      ? 'https://dev-online-gateway.ghn.vn/shiip/public-api'
      : 'https://online-gateway.ghn.vn/shiip/public-api';
  }

  /** Token + ShopId (when set): every endpoint except Get Shop lists ShopId as a required header. */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Token: this.config.credentials.token,
      'Content-Type': 'application/json',
    };
    const shopId = String(this.config.credentials.shopId ?? '').trim();
    if (shopId) headers.ShopId = shopId;
    return headers;
  }

  async testConnection(): Promise<TestResult> {
    try {
      const res = await axios.get(`${this.getBaseUrl()}/v2/shop/all`, {
        headers: { Token: this.config.credentials.token },
        timeout: 10000,
      });
      const count = res.data?.data?.shops?.length ?? 0;
      return { success: true, message: tr('Kết nối GHN thành công - {{count}} shop', { count }) };
    } catch (e: any) {
      return { success: false, message: tr('Lỗi kết nối GHN: {{v1}}', { v1: e.response?.data?.message || e.message }) };
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    const base = this.getBaseUrl();
    const headers = this.getHeaders();

    switch (action) {
      case 'createOrder': {
        const res = await axios.post(`${base}/v2/shipping-order/create`, prepareGhnOrder(params.order || params), {
          headers,
          timeout: 15000,
        });
        return { order: res.data?.data || {} };
      }

      case 'getTracking': {
        // Order Info: GET with the tracking code in the query string
        const res = await axios.get(`${base}/v2/shipping-order/detail`, {
          headers,
          params: { order_code: params.orderCode },
          timeout: 10000,
        });
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

      // ─── Legacy 3-level master data (fee / available services still use these ids) ───
      case 'getProvinces': {
        const res = await axios.get(`${base}/master-data/province`, { headers, timeout: 10000 });
        return { provinces: res.data?.data || [] };
      }

      case 'getDistricts': {
        const res = await axios.get(`${base}/master-data/district`, {
          headers,
          params: { province_id: params.provinceId },
          timeout: 10000,
        });
        return { districts: res.data?.data || [] };
      }

      case 'getWards': {
        const districtId = Number(params.districtId ?? params.district_id);
        if (!districtId) throw new Error(tr('Thiếu districtId để lấy phường/xã GHN'));
        const res = await axios.get(`${base}/master-data/ward`, {
          headers,
          params: { district_id: districtId },
          timeout: 10000,
        });
        return { wards: res.data?.data || [] };
      }

      // ─── New 2-level master data: names to use in createOrder with is_new_to_address ───
      case 'getProvincesNew': {
        const res = await axios.get(`${base}/v3/master-data/province/all`, { headers, timeout: 10000 });
        return { provinces: res.data?.data || [] };
      }

      case 'getWardsNew': {
        const provinceId = Number(params.provinceId ?? params.province_id);
        if (!provinceId) throw new Error(tr('Thiếu provinceId (ID tỉnh kiểu mới) để lấy phường/xã GHN'));
        const res = await axios.get(`${base}/v3/master-data/ward/all-by-province-id`, {
          headers,
          // the largest province has fewer than 200 wards: one call is enough
          params: { province_id: provinceId, limit: 200 },
          timeout: 10000,
        });
        // An unknown province id answers HTTP 200 with data = null
        return { wards: res.data?.data || [] };
      }

      case 'getServices': {
        const fromDistrict = Number(params.fromDistrict ?? params.from_district);
        const toDistrict = Number(params.toDistrict ?? params.to_district);
        const shopId = Number(params.shopId ?? params.shop_id ?? this.config.credentials.shopId);
        if (!fromDistrict || !toDistrict || !shopId) {
          throw new Error(tr('Thiếu fromDistrict / toDistrict / shopId để lấy dịch vụ GHN'));
        }
        const res = await axios.post(
          `${base}/v2/shipping-order/available-services`,
          {
            shop_id: shopId,
            from_district: fromDistrict,
            to_district: toDistrict,
          },
          { headers, timeout: 10000 },
        );
        return { services: res.data?.data || [] };
      }

      default:
        throw new Error(tr('GHN không hỗ trợ action: {{action}}', { action }));
    }
  }
}
