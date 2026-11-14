/**
 * platformOrderAdapters - normalizes order data for each POS platform
 *
 * Each platform has a different API structure:
 * - KiotViet:  orderDetails[], customer{id, name, contactNumber}, branchId
 * - Haravan:   line_items[], customer{first_name, phone, email}, shipping_address{...}
 * - Sapo:      line_items[], customer{}, shipping_address{}, source_name
 * - Nhanh.vn:  info{}, channel{appOrderId}, shippingAddress{}, products[], payment{}
 * - Pancake:   customer{}, items[], shippingAddress{}, paymentMethod, note
 *
 * An adapter takes generic OrderData → returns an object in the exact API format of each platform.
 */

import {
  getProvinceName, getDistrictName, getWardName, stripAdministrativePrefix,
  getProvinceNameV2, getWardNameV2,
} from './vnDivisions';
import { tr } from '../../../../shared/i18n';

// ─── Generic Order Data (internal) ──────────────────────────────────────────

/** 'new' = 2-level units after 01/07/2025 (province + ward, no district); 'old' = 3-level units. */
export type AddressModel = 'new' | 'old';

export interface GenericOrderData {
  branchId?: string | number;
  customer: {
    name: string;
    phone: string;
    email: string;
    /** Missing = 'old' (orders built before the 2-level data existed). */
    addressModel?: AddressModel;
    provinceId: string;
    /** Empty for a new (2-level) address. */
    districtId: string;
    wardId: string;
    provinceName?: string;
    districtName?: string;
    wardName?: string;
    address: string; // house number, street name
  };
  items: Array<{
    productId: string;
    productCode: string;
    productName: string;
    quantity: number;
    price: number;
    discount: number;
  }>;
  discount: number;
  shippingFee: number;
  totalPayment: number;
  paymentMethod: string;
  note: string;
}

/** Names of the picked address for either model + the full one-line address. */
function addressParts(customer: GenericOrderData['customer']) {
  const isNew = customer.addressModel === 'new';
  const provinceName = customer.provinceName
    || (isNew ? getProvinceNameV2(customer.provinceId) : getProvinceName(customer.provinceId));
  const districtName = isNew ? '' : (customer.districtName || getDistrictName(customer.provinceId, customer.districtId));
  const wardName = customer.wardName
    || (isNew ? getWardNameV2(customer.wardId) : getWardName(customer.provinceId, customer.districtId, customer.wardId));
  const fullAddress = [customer.address, wardName, districtName, provinceName].filter(Boolean).join(', ');
  return { isNew, provinceName, districtName, wardName, fullAddress };
}

// ─── KiotViet ───────────────────────────────────────────────────────────────
// Docs: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/ (2.5.3 Thêm mới đặt hàng)
// POST /orders - body: { branchId, customer{}, orderDetails[], discount, method, totalPayment, orderDelivery{} }

/** Paid when the order is created → KiotViet `method`; COD is paid later, so no payment is recorded. */
const KIOTVIET_PAID_METHOD: Record<string, string> = { cash: 'Cash', bank_transfer: 'Transfer', card: 'Card' };

function toKiotViet(data: GenericOrderData) {
  const address = addressParts(data.customer);
  const name = data.customer.name || tr('Khách vãng lai');
  const branchId = data.branchId != null && String(data.branchId).trim() !== ''
    ? Number(data.branchId)
    : undefined;
  const paidMethod = KIOTVIET_PAID_METHOD[data.paymentMethod];

  return {
    ...(branchId != null && !Number.isNaN(branchId) ? { branchId } : {}),
    // customer{} without an id: KiotViet creates the customer from these fields
    customer: {
      name,
      ...(data.customer.phone ? { contactNumber: data.customer.phone } : {}),
      ...(data.customer.email ? { email: data.customer.email } : {}),
      ...(address.fullAddress ? { address: address.fullAddress } : {}),
    },
    orderDetails: data.items.map(item => ({
      productId: Number(item.productId) || item.productId,
      productCode: item.productCode,
      quantity: item.quantity,
      price: item.price,
      discount: item.discount,
      note: '',
    })),
    discount: data.discount,
    description: data.note || undefined,
    // totalPayment = what the customer has already paid
    ...(paidMethod ? { method: paidMethod, totalPayment: data.totalPayment } : {}),
    // Delivery
    ...(data.shippingFee > 0 ? {
      orderDelivery: {
        price: data.shippingFee,
        receiver: name,
        contactNumber: data.customer.phone,
        address: address.fullAddress,
        wardName: address.wardName || undefined,
        // KiotViet "Khu vực" (locationId / locationName): KiotVietAdapter looks it up in GET /locations from these two
        provinceName: address.provinceName,
        areaName: address.isNew ? address.wardName : address.districtName,
      },
    } : {}),
  };
}

// ─── Haravan ────────────────────────────────────────────────────────────────
// Docs: https://docs.haravan.com/docs/omni-apis/orders/
// POST https://apis.haravan.com/com/orders.json - body: { order: { line_items[], customer{}, shipping_address{}, ... } }

function toHaravan(data: GenericOrderData) {
  const { provinceName, districtName, wardName } = addressParts(data.customer);

  // Haravan splits first_name / last_name
  const nameParts = (data.customer.name || 'Khách vãng lai').split(' ');
  const lastName = nameParts.pop() || '';
  const firstName = nameParts.join(' ') || lastName;

  return {
    order: {
      line_items: data.items.map(item => ({
        variant_id: item.productId,
        title: item.productName,
        quantity: item.quantity,
        price: item.price,
        total_discount: item.discount,
      })),
      customer: {
        first_name: firstName,
        last_name: lastName,
        phone: data.customer.phone || undefined,
        email: data.customer.email || undefined,
      },
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        phone: data.customer.phone || undefined,
        address1: data.customer.address || undefined,
        ward: wardName || undefined,
        district: districtName || undefined,
        province: provinceName || undefined,
        country: 'Vietnam',
        country_code: 'VN',
      },
      total_discounts: data.discount,
      note: data.note || undefined,
      // Haravan financial_status:
      financial_status: data.paymentMethod === 'cod' ? 'pending' : 'paid',
      // COD orders use Haravan's COD gateway (docs: "Create an order with gateway is COD")
      ...(data.paymentMethod === 'cod' ? { is_cod_gateway: true } : {}),
      shipping_lines: data.shippingFee > 0 ? [{
        title: tr('Phí vận chuyển'),
        price: data.shippingFee,
      }] : [],
      tags: 'deplaoapp',
      source_name: 'deplaoapp',
    },
  };
}

// ─── Sapo ───────────────────────────────────────────────────────────────────
// Docs: support.sapo.vn/phuong-thuc-post-cua-order-phan-2 — POST /admin/orders.json { order: {...} }
// - line_items: { variant_id, quantity } (the VARIANT id: POS takes the variation_id that SapoAdapter returns) or a free line
//   { title, price, quantity } when there is no id
// - address: first_name / last_name / name (no full_name); payment status: financial_status
// - discount: discount_codes (no discount_amount on the line / total_discount when creating)

/** "Nguyễn Văn An" → last_name "Nguyễn Văn", first_name "An" (same as Sapo customers). */
function splitVietnameseName(full: string): { first_name: string; last_name: string } {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first_name: parts[0] || '', last_name: '' };
  return { first_name: parts[parts.length - 1], last_name: parts.slice(0, -1).join(' ') };
}

function toSapo(data: GenericOrderData) {
  const { provinceName, districtName, wardName } = addressParts(data.customer);
  const name = data.customer.name || tr('Khách vãng lai');
  const { first_name, last_name } = splitVietnameseName(name);
  const address = {
    first_name,
    last_name: last_name || undefined,
    name,
    phone: data.customer.phone || undefined,
    address1: data.customer.address || undefined,
    ward: wardName || undefined,
    district: districtName || undefined,
    province: provinceName || undefined,
    city: provinceName || undefined,
    country: 'Vietnam',
    country_code: 'VN',
  };
  const totalDiscount = data.items.reduce((sum, item) => sum + (Number(item.discount) || 0), 0) + (Number(data.discount) || 0);
  const hasCustomer = !!(data.customer.phone || data.customer.email);

  return {
    order: {
      line_items: data.items.map(item => {
        const variantId = Number(item.productId);
        return Number.isFinite(variantId) && variantId > 0
          ? { variant_id: variantId, quantity: item.quantity, price: item.price, title: item.productName }
          : { title: item.productName || item.productCode || tr('Sản phẩm'), price: item.price, quantity: item.quantity };
      }),
      // Link the order to a customer (Sapo matches / creates the customer by phone number or email); previously the order had no customer
      customer: hasCustomer ? {
        first_name,
        last_name: last_name || undefined,
        phone: data.customer.phone || undefined,
        email: data.customer.email || undefined,
      } : undefined,
      email: data.customer.email || undefined,
      billing_address: address,
      shipping_address: address,
      discount_codes: totalDiscount > 0 ? [{ code: 'DEPLAO', amount: totalDiscount, type: 'fixed_amount' }] : undefined,
      note: data.note || undefined,
      tags: 'deplaoapp',
      source_name: 'deplaoapp',
      financial_status: data.paymentMethod === 'cod' ? 'pending' : 'paid',
      shipping_lines: data.shippingFee > 0 ? [{
        title: tr('Phí vận chuyển'),
        price: data.shippingFee,
      }] : undefined,
    },
  };
}

// ─── Nhanh.vn ───────────────────────────────────────────────────────────────
// Docs: https://apidocs.nhanh.vn/v3/order/add
// POST /v3.0/order/add?appId=&businessId= - body: nested v3 structure
// appId & businessId go in query string (handled by NhanhAdapter.buildUrl)

function toNhanh(data: GenericOrderData) {
  const { isNew, fullAddress } = addressParts(data.customer);

  // Nhanh v3: products is an array of { id (int), price, quantity, discount? }
  const products = data.items.map(item => {
    const p: Record<string, any> = {
      id: Number(item.productId) || item.productId,
      price: item.price,
      quantity: item.quantity,
    };
    if (item.discount > 0) p.discount = item.discount;
    return p;
  });

  const result: Record<string, any> = {
    info: {
      type: 1, // 1 = Home delivery (required by Nhanh v3)
      ...(data.note ? { description: data.note } : {}),
    },
    // channel.appOrderId = unique order ID on our side (Nhanh deduplicates by appId + appOrderId)
    channel: {
      appOrderId: `DEPLAO-${Date.now()}`,
      sourceName: 'deplaoapp',
    },
    shippingAddress: {
      name: data.customer.name || tr('Khách vãng lai'),
      mobile: data.customer.phone || undefined,
      ...(data.customer.email ? { email: data.customer.email } : {}),
      address: fullAddress || undefined,
      // cityId / districtId / wardId are Nhanh's own IDs - not available from our division data
      // Pass address as free-text only (all fields optional except name + mobile)
      // v2 = 2-level address (province + ward), v1 = old 3-level address
      locationVersion: isNew ? 'v2' : 'v1',
    },
    products,
  };

  // Payment block
  const payment: Record<string, any> = {};
  if (data.discount > 0) {
    payment.discountAmount = data.discount;
    payment.discountType = 'cash';
  }
  if (data.paymentMethod === 'bank_transfer' && data.totalPayment > 0) {
    payment.transferAmount = data.totalPayment;
  }
  if (Object.keys(payment).length > 0) {
    result.payment = payment;
  }

  // Basic carrier / shipping fee (no carrier account required)
  if (data.shippingFee > 0) {
    result.carrier = {
      customerShipFee: data.shippingFee,
    };
  }

  return result;
}

// ─── Pancake POS ─────────────────────────────────────────────────────────────
// Docs: https://pos.pancake.vn/developers/api/en/order (POST /shops/{SHOP_ID}/orders)
// shipping_address.address is parsed by Pancake into province / district / commune ids when province_id is empty,
// so it carries the whole address (street, ward, district for an old address, province).

function toPancake(data: GenericOrderData) {
  const {
    provinceName: provinceDisplayName, districtName: districtDisplayName, wardName, fullAddress,
  } = addressParts(data.customer);
  const provinceName = provinceDisplayName ? stripAdministrativePrefix(provinceDisplayName, 'province') : '';
  const districtName = districtDisplayName ? stripAdministrativePrefix(districtDisplayName, 'district') : '';

  const items = data.items.map(item => {
    const id = String(item.productId || '').trim();
    const base: any = {
      quantity: item.quantity,
      discount_each_product: item.discount || 0,
      note: '',
    };
    // PRODUCT_SKU vs internal ID may vary by shop config; keep both hints when possible.
    if (/^\d+$/.test(id)) {
      base.variation_id = id;
      base.product_id = id;
    } else {
      base.product_id = id || item.productCode;
    }
    return base;
  });

  const totalMoney = Math.max(0, data.totalPayment || 0);

  return {
    bill_full_name: data.customer.name || 'Khach vang lai',
    bill_phone_number: data.customer.phone || undefined,
    bill_email: data.customer.email || undefined,
    shipping_address: {
      full_name: data.customer.name || 'Khach vang lai',
      phone_number: data.customer.phone || undefined,
      address: fullAddress || data.customer.address || undefined,
      fullAddress: fullAddress || undefined,
      full_address: fullAddress || undefined,
      district_name: districtName || undefined,
      province_name: provinceName || undefined,
      commune_name: wardName || undefined,
      commnue_name: wardName || undefined,
      ward_name: wardName || undefined,
    },
    items,
    shipping_fee: data.shippingFee || 0,
    total_discount: data.discount || 0,
    total_price: totalMoney,
    cod: data.paymentMethod === 'cod' ? totalMoney : 0,
    cash: data.paymentMethod === 'cash' ? totalMoney : 0,
    account: (data.paymentMethod === 'bank_transfer' || data.paymentMethod === 'card') ? totalMoney : 0,
    note: data.note || undefined,
    order_sources: ['deplaoapp'],
  };
}

// ─── Public Adapter ─────────────────────────────────────────────────────────

export type PlatformType = 'kiotviet' | 'haravan' | 'sapo' | 'nhanh' | 'pancake';

const ADAPTERS: Record<PlatformType, (data: GenericOrderData) => any> = {
  kiotviet: toKiotViet,
  haravan: toHaravan,
  sapo: toSapo,
  nhanh: toNhanh,
  pancake: toPancake,
};

/**
 * Converts GenericOrderData → the standard API format of each platform.
 * Returns an object ready to POST to the API.
 */
export function adaptOrderForPlatform(platform: string, data: GenericOrderData): any {
  const adapter = ADAPTERS[platform as PlatformType];
  if (!adapter) {
    // Fallback: send the generic data unchanged for platforms not supported yet
    console.warn(`[adaptOrderForPlatform] No adapter for platform "${platform}", using generic data`);
    return data;
  }
  return adapter(data);
}

/** Platforms that support creating orders */
export const SUPPORTED_ORDER_PLATFORMS: PlatformType[] = ['kiotviet', 'haravan', 'sapo', 'nhanh', 'pancake'];

/** Display names of payment methods per platform */
export function getPaymentMethodLabel(method: string): string {
  const MAP: Record<string, string> = {
    cod: tr('COD – Thanh toán khi nhận hàng'),
    bank_transfer: tr('Chuyển khoản ngân hàng'),
    cash: tr('Tiền mặt tại cửa hàng'),
    card: tr('Thẻ (VISA/Master)'),
    momo: tr('Ví MoMo'),
    zalopay: 'ZaloPay',
    vnpay: 'VNPay',
  };
  return MAP[method] || method;
}

