/**
 * platformOrderAdapters — Chuẩn hoá dữ liệu đơn hàng cho từng nền tảng POS
 *
 * Mỗi nền tảng có cấu trúc API khác nhau:
 * - KiotViet:  orderDetails[], customer{id, name, contactNumber}, branchId
 * - Haravan:   line_items[], customer{first_name, phone, email}, shipping_address{...}
 * - Sapo:      line_items[], customer{}, shipping_address{}, source_name
 * - iPOS:      invoiceDetails[], customerName, customerPhone, tableId
 * - Nhanh.vn:  info{}, channel{appOrderId}, shippingAddress{}, products[], payment{}
 * - Pancake:   customer{}, items[], shippingAddress{}, paymentMethod, note
 *
 * Adapter nhận generic OrderData → trả về object đúng format API từng nền tảng.
 */

import { getProvinceName, getDistrictName, getWardName, stripAdministrativePrefix } from './vnDivisions';

// ─── Generic Order Data (internal) ──────────────────────────────────────────

export interface GenericOrderData {
  branchId?: string | number;
  customer: {
    name: string;
    phone: string;
    email: string;
    provinceId: string;
    districtId: string;
    wardId: string;
    provinceName?: string;
    districtName?: string;
    wardName?: string;
    address: string; // số nhà, tên đường
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

// ─── KiotViet ───────────────────────────────────────────────────────────────
// Docs: https://www.kiotviet.vn/huong-dan-su-dung-api/
// POST /orders — body: { branchId, customerId?, orderDetails[], discount, totalPayment, ... }

function toKiotViet(data: GenericOrderData) {
  const provinceName = data.customer.provinceName || getProvinceName(data.customer.provinceId);
  const districtName = data.customer.districtName || getDistrictName(data.customer.provinceId, data.customer.districtId);
  const wardName = data.customer.wardName || getWardName(data.customer.provinceId, data.customer.districtId, data.customer.wardId);
  const fullAddress = [data.customer.address, wardName, districtName, provinceName].filter(Boolean).join(', ');
  const branchId = data.branchId != null && String(data.branchId).trim() !== ''
    ? Number(data.branchId)
    : undefined;

  return {
    ...(branchId != null && !Number.isNaN(branchId) ? { branchId } : {}),
    // Nếu không có customerId → KiotViet tự tạo khách từ thông tin bên dưới
    customerName: data.customer.name || 'Khách vãng lai',
    customerPhone: data.customer.phone || undefined,
    customerEmail: data.customer.email || undefined,
    customerAddress: fullAddress || undefined,
    orderDetails: data.items.map(item => ({
      productId: Number(item.productId) || item.productId,
      productCode: item.productCode,
      quantity: item.quantity,
      price: item.price,
      discount: item.discount,
      note: '',
    })),
    discount: data.discount,
    totalPayment: data.totalPayment,
    description: data.note || undefined,
    // KiotViet payment methods:
    // 1 = Tiền mặt, 2 = Chuyển khoản, 3 = Thẻ, 4 = COD
    payments: [{
      method: data.paymentMethod === 'cash' ? 1
        : data.paymentMethod === 'bank_transfer' ? 2
        : data.paymentMethod === 'card' ? 3
        : 4, // COD / default
      amount: data.totalPayment,
    }],
    // Delivery
    ...(data.shippingFee > 0 ? {
      orderDelivery: {
        deliveryCode: '',
        price: data.shippingFee,
        receiver: data.customer.name,
        contactNumber: data.customer.phone,
        address: fullAddress,
        locationName: provinceName,
        wardName,
        weight: 0,
      },
    } : {}),
  };
}

// ─── Haravan ────────────────────────────────────────────────────────────────
// Docs: https://docs.haravan.com/blogs/api
// POST /admin/orders.json — body: { order: { line_items[], customer{}, shipping_address{}, ... } }

function toHaravan(data: GenericOrderData) {
  const provinceName = data.customer.provinceName || getProvinceName(data.customer.provinceId);
  const districtName = data.customer.districtName || getDistrictName(data.customer.provinceId, data.customer.districtId);
  const wardName = data.customer.wardName || getWardName(data.customer.provinceId, data.customer.districtId, data.customer.wardId);

  // Haravan tách first_name / last_name
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
      shipping_lines: data.shippingFee > 0 ? [{
        title: 'Phí vận chuyển',
        price: data.shippingFee,
      }] : [],
      tags: 'deplaoapp',
      source_name: 'deplaoapp',
    },
  };
}

// ─── Sapo ───────────────────────────────────────────────────────────────────
// Docs: https://developers.sapo.vn/
// POST /admin/orders.json — body: { order: { line_items[], customer_id?, shipping_address{}, ... } }

function toSapo(data: GenericOrderData) {
  const provinceName = data.customer.provinceName || getProvinceName(data.customer.provinceId);
  const districtName = data.customer.districtName || getDistrictName(data.customer.provinceId, data.customer.districtId);
  const wardName = data.customer.wardName || getWardName(data.customer.provinceId, data.customer.districtId, data.customer.wardId);
  const fullAddress = [data.customer.address, wardName, districtName, provinceName].filter(Boolean).join(', ');

  return {
    order: {
      line_items: data.items.map(item => ({
        product_id: item.productId,
        variant_id: item.productId,
        title: item.productName,
        quantity: item.quantity,
        price: item.price,
        discount_amount: item.discount,
      })),
      billing_address: {
        full_name: data.customer.name || 'Khách vãng lai',
        phone: data.customer.phone || undefined,
        email: data.customer.email || undefined,
        address1: data.customer.address || undefined,
        ward: wardName || undefined,
        district: districtName || undefined,
        province: provinceName || undefined,
        country: 'Việt Nam',
      },
      shipping_address: {
        full_name: data.customer.name || 'Khách vãng lai',
        phone: data.customer.phone || undefined,
        address1: data.customer.address || undefined,
        full_address: fullAddress || undefined,
        ward: wardName || undefined,
        district: districtName || undefined,
        province: provinceName || undefined,
        country: 'Việt Nam',
      },
      total_discount: data.discount,
      note: data.note || undefined,
      source_name: 'deplaoapp',
      // Sapo payment: payment_status pending|paid
      payment_status: data.paymentMethod === 'cod' ? 'pending' : 'paid',
      fulfillment_status: null, // chưa giao
      shipping_lines: data.shippingFee > 0 ? [{
        title: 'Phí ship',
        price: data.shippingFee,
      }] : undefined,
    },
  };
}

// ─── iPOS ───────────────────────────────────────────────────────────────────
// Docs: iPOS POS API — tạo hóa đơn bán hàng
// POST /api/invoices — body: { invoice: { details[], customerName, ... } }

function toIPOS(data: GenericOrderData) {
  const provinceName = data.customer.provinceName || getProvinceName(data.customer.provinceId);
  const districtName = data.customer.districtName || getDistrictName(data.customer.provinceId, data.customer.districtId);
  const wardName = data.customer.wardName || getWardName(data.customer.provinceId, data.customer.districtId, data.customer.wardId);
  const fullAddress = [data.customer.address, wardName, districtName, provinceName].filter(Boolean).join(', ');

  return {
    invoice: {
      invoiceType: 1, // 1 = Bán hàng, 2 = Trả hàng
      details: data.items.map(item => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
        discountAmount: item.discount,
        amount: item.price * item.quantity - item.discount,
      })),
      customerName: data.customer.name || 'Khách vãng lai',
      customerPhone: data.customer.phone || undefined,
      customerEmail: data.customer.email || undefined,
      customerAddress: fullAddress || undefined,
      totalAmount: data.totalPayment,
      discountAmount: data.discount,
      // iPOS paymentMethod: CASH, BANK, CARD, MOMO, ZALOPAY, COD
      paymentMethod: data.paymentMethod === 'cash' ? 'CASH'
        : data.paymentMethod === 'bank_transfer' ? 'BANK'
        : data.paymentMethod === 'card' ? 'CARD'
        : data.paymentMethod === 'momo' ? 'MOMO'
        : data.paymentMethod === 'zalopay' ? 'ZALOPAY'
        : 'COD',
      note: data.note || undefined,
      deliveryFee: data.shippingFee || undefined,
    },
  };
}

// ─── Nhanh.vn ───────────────────────────────────────────────────────────────
// Docs: https://open.nhanh.vn/
// POST /v3.0/order/add?appId=&businessId= — body: nested v3 structure
// appId & businessId go in query string (handled by NhanhAdapter.buildUrl)

function toNhanh(data: GenericOrderData) {
  const provinceName = data.customer.provinceName || getProvinceName(data.customer.provinceId);
  const districtName = data.customer.districtName || getDistrictName(data.customer.provinceId, data.customer.districtId);
  const wardName = data.customer.wardName || getWardName(data.customer.provinceId, data.customer.districtId, data.customer.wardId);
  const fullAddress = [data.customer.address, wardName, districtName, provinceName].filter(Boolean).join(', ');

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
      type: 1, // 1 = Giao hàng tận nhà (bắt buộc theo Nhanh v3)
      ...(data.note ? { description: data.note } : {}),
    },
    // channel.appOrderId = unique order ID on our side (Nhanh deduplicates by appId + appOrderId)
    channel: {
      appOrderId: `DEPLAO-${Date.now()}`,
      sourceName: 'deplaoapp',
    },
    shippingAddress: {
      name: data.customer.name || 'Khách vãng lai',
      mobile: data.customer.phone || undefined,
      ...(data.customer.email ? { email: data.customer.email } : {}),
      address: fullAddress || undefined,
      // cityId / districtId / wardId are Nhanh's own IDs — not available from our division data
      // Pass address as free-text only (all fields optional except name + mobile)
      locationVersion: 'v1',
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
// Generic payload used by PancakeAdapter default createOrder action.

function toPancake(data: GenericOrderData) {
  const provinceDisplayName = data.customer.provinceName || getProvinceName(data.customer.provinceId);
  const districtDisplayName = data.customer.districtName || getDistrictName(data.customer.provinceId, data.customer.districtId);
  const wardName = data.customer.wardName || getWardName(data.customer.provinceId, data.customer.districtId, data.customer.wardId);
  const provinceName = provinceDisplayName ? stripAdministrativePrefix(provinceDisplayName, 'province') : '';
  const districtName = districtDisplayName ? stripAdministrativePrefix(districtDisplayName, 'district') : '';
  const fullAddress = [data.customer.address, wardName, districtName || districtDisplayName, provinceName || provinceDisplayName].filter(Boolean).join(', ');

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
      address: data.customer.address || undefined,
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

export type PlatformType = 'kiotviet' | 'haravan' | 'sapo' | 'ipos' | 'nhanh' | 'pancake';

const ADAPTERS: Record<PlatformType, (data: GenericOrderData) => any> = {
  kiotviet: toKiotViet,
  haravan: toHaravan,
  sapo: toSapo,
  ipos: toIPOS,
  nhanh: toNhanh,
  pancake: toPancake,
};

/**
 * Chuyển đổi GenericOrderData → format chuẩn API của từng nền tảng.
 * Trả về object sẵn sàng POST lên API.
 */
export function adaptOrderForPlatform(platform: string, data: GenericOrderData): any {
  const adapter = ADAPTERS[platform as PlatformType];
  if (!adapter) {
    // Fallback: gửi nguyên generic data cho nền tảng chưa hỗ trợ
    console.warn(`[adaptOrderForPlatform] No adapter for platform "${platform}", using generic data`);
    return data;
  }
  return adapter(data);
}

/** Danh sách nền tảng có hỗ trợ tạo đơn */
export const SUPPORTED_ORDER_PLATFORMS: PlatformType[] = ['kiotviet', 'haravan', 'sapo', 'ipos', 'nhanh', 'pancake'];

/** Tên hiển thị cho payment method theo nền tảng */
export function getPaymentMethodLabel(method: string): string {
  const MAP: Record<string, string> = {
    cod: 'COD – Thanh toán khi nhận hàng',
    bank_transfer: 'Chuyển khoản ngân hàng',
    cash: 'Tiền mặt tại cửa hàng',
    card: 'Thẻ (VISA/Master)',
    momo: 'Ví MoMo',
    zalopay: 'ZaloPay',
    vnpay: 'VNPay',
  };
  return MAP[method] || method;
}

