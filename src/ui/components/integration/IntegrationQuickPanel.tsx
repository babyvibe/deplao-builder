/**
 * IntegrationQuickPanel — Side panel thao tác tích hợp nhanh
 * Hiển thị bên phải khung chat (giống ConversationInfo panel).
 * Cho phép tra cứu đơn, sản phẩm, vận chuyển, tạo đơn hàng... trực tiếp khi đang chat.
 * Nếu chưa cấu hình → hiện hướng dẫn + nút đi tới trang Tích hợp.
 */

import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import POSOrderPanel from './POSOrderPanel';
import { IS_DEV_BUILD } from "../../../configs/BuildConfig";

// ─── Pin icon emoji list ─────────────────────────────────────────────────────
const PIN_EMOJIS = [
  '🛒','📦','🔍','👤','📋','💳','🚚','📊','💰','🏪',
  '🟢','🍽️','⚡','🔗','🔌','⭐','📌','🏷️','💼','📱',
  '✅','🔔','📝','🎯','🔑','🗂️','💡','🔄','📈','🎁',
  '🤝','🏷️','🧾','🗃️','📲','💬','🔖','🧩','⚙️','🌐',
];

// ─── PinIconPicker ───────────────────────────────────────────────────────────
function PinIconPicker({ onSelect, onClose }: { onSelect: (icon: string) => void; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 bg-gray-850 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-50 p-3 w-56" onClick={e => e.stopPropagation()}>
      <p className="text-[11px] text-gray-400 mb-2 font-medium">📌 Chọn icon cho nút ghim:</p>
      <div className="grid grid-cols-8 gap-0.5">
        {PIN_EMOJIS.map(emoji => (
          <button key={emoji} onClick={() => onSelect(emoji)}
            className="w-6 h-6 flex items-center justify-center text-sm rounded-lg hover:bg-gray-700 transition-colors">
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}


// ─── Types ────────────────────────────────────────────────────────────────────

export interface SavedIntegration {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  connectedAt?: number;
}

interface ActionField {
  key: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'select';
  options?: { value: string; label: string }[];
  optional?: boolean;
}

interface QuickActionDef {
  action: string;
  label: string;
  icon: string;
  desc: string;
  fields: ActionField[];
}

// ─── Action definitions per integration type ─────────────────────────────────

const TYPE_META: Record<string, { icon: string; color: string; name: string }> = {
  kiotviet: { icon: '🛒', color: 'bg-orange-500', name: 'KiotViet' },
  haravan:  { icon: '🏪', color: 'bg-indigo-500', name: 'Haravan' },
  sapo:     { icon: '🟢', color: 'bg-emerald-500', name: 'Sapo' },
  ipos:     { icon: '🍽️', color: 'bg-rose-500', name: 'iPOS' },
  nhanh:    { icon: '⚡', color: 'bg-yellow-600', name: 'Nhanh.vn' },
  pancake:  { icon: '🥞', color: 'bg-amber-500', name: 'Pancake POS' },
  ghn:      { icon: '📦', color: 'bg-red-500', name: 'GHN Express' },
  ghtk:     { icon: '🚚', color: 'bg-blue-500', name: 'GHTK' },
  casso:    { icon: '💳', color: 'bg-green-600', name: 'Casso' },
  sepay:    { icon: '💰', color: 'bg-teal-600', name: 'SePay' },
};

const ACTIONS_BY_TYPE: Record<string, QuickActionDef[]> = {
  kiotviet: [
    {
      action: 'lookupCustomer', label: 'Tra cứu khách hàng', icon: '👤',
      desc: 'Tìm thông tin khách hàng theo SĐT',
      fields: [{ key: 'phone', label: 'Số điện thoại', placeholder: '0901234567' }],
    },
    {
      action: 'lookupOrder', label: 'Tra cứu đơn hàng', icon: '📋',
      desc: 'Tìm đơn hàng theo mã hoặc SĐT',
      fields: [
        { key: 'phone', label: 'SĐT khách hàng', placeholder: '0901234567', optional: true },
        { key: 'orderId', label: 'Mã đơn hàng', placeholder: '123456', optional: true },
      ],
    },
    {
      action: 'lookupProduct', label: 'Tìm sản phẩm', icon: '🔍',
      desc: 'Tìm sản phẩm theo tên hoặc mã SKU',
      fields: [
        { key: 'keyword', label: 'Tên hoặc mã SKU', placeholder: 'Áo thun...' },
      ],
    },
    {
      action: 'createOrder', label: 'Tạo đơn hàng', icon: '✏️',
      desc: 'Tạo đơn hàng mới trong KiotViet',
      fields: [],
    },
  ],
  haravan: [
    { action: 'lookupCustomer', label: 'Tra cứu khách hàng', icon: '👤', desc: 'Tìm theo SĐT',
      fields: [{ key: 'phone', label: 'Số điện thoại', placeholder: '0901234567' }] },
    { action: 'lookupOrder', label: 'Tra cứu đơn hàng', icon: '📋', desc: 'Tìm theo SĐT hoặc mã đơn',
      fields: [
        { key: 'phone', label: 'SĐT', placeholder: '0901234567', optional: true },
        { key: 'orderId', label: 'Mã đơn', placeholder: 'ID đơn', optional: true },
      ] },
    { action: 'lookupProduct', label: 'Tìm sản phẩm', icon: '🔍', desc: 'Tìm theo tên',
      fields: [{ key: 'keyword', label: 'Tên sản phẩm', placeholder: 'Áo...' }] },
    { action: 'createOrder', label: 'Tạo đơn hàng', icon: '✏️', desc: 'Tạo đơn hàng mới trong Haravan',
      fields: [] },
  ],
  sapo: [
    { action: 'lookupCustomer', label: 'Tra cứu khách hàng', icon: '👤', desc: 'Tìm theo SĐT',
      fields: [{ key: 'phone', label: 'Số điện thoại', placeholder: '0901234567' }] },
    { action: 'lookupOrder', label: 'Tra cứu đơn hàng', icon: '📋', desc: 'Tìm theo SĐT hoặc mã đơn',
      fields: [
        { key: 'phone', label: 'SĐT', placeholder: '0901234567', optional: true },
        { key: 'orderId', label: 'Mã đơn', placeholder: 'ID đơn', optional: true },
      ] },
    { action: 'lookupProduct', label: 'Tìm sản phẩm', icon: '🔍', desc: 'Tìm theo tên',
      fields: [{ key: 'keyword', label: 'Tên sản phẩm', placeholder: 'Áo...' }] },
    { action: 'createOrder', label: 'Tạo đơn hàng', icon: '✏️', desc: 'Tạo đơn hàng mới trong Sapo',
      fields: [] },
  ],
  ipos: [
    { action: 'lookupCustomer', label: 'Tra cứu khách hàng', icon: '👤', desc: 'Tìm theo SĐT',
      fields: [{ key: 'phone', label: 'Số điện thoại', placeholder: '0901234567' }] },
    { action: 'lookupOrder', label: 'Tra cứu hóa đơn', icon: '📋', desc: 'Tìm theo SĐT hoặc mã đơn',
      fields: [
        { key: 'phone', label: 'SĐT', placeholder: '0901234567', optional: true },
        { key: 'orderId', label: 'Mã hóa đơn', placeholder: 'ID hóa đơn', optional: true },
      ] },
    { action: 'lookupProduct', label: 'Tìm sản phẩm / món', icon: '🔍', desc: 'Tìm theo tên',
      fields: [{ key: 'keyword', label: 'Tên sản phẩm / món', placeholder: 'Cà phê...' }] },
    { action: 'createOrder', label: 'Tạo đơn / hóa đơn', icon: '✏️', desc: 'Tạo hóa đơn mới trong iPOS',
      fields: [] },
  ],
  nhanh: [
    { action: 'lookupCustomer', label: 'Tra cứu khách hàng', icon: '👤', desc: 'Tìm theo SĐT',
      fields: [{ key: 'phone', label: 'Số điện thoại', placeholder: '0901234567' }] },
    { action: 'lookupOrder', label: 'Tra cứu đơn hàng', icon: '📋', desc: 'Tìm theo SĐT hoặc mã đơn',
      fields: [
        { key: 'phone', label: 'SĐT', placeholder: '0901234567', optional: true },
        { key: 'orderId', label: 'Mã đơn', placeholder: 'ID đơn', optional: true },
      ] },
    { action: 'lookupProduct', label: 'Tìm sản phẩm', icon: '🔍', desc: 'Tìm theo tên hoặc mã',
      fields: [
        { key: 'keyword', label: 'Tên sản phẩm', placeholder: 'Sản phẩm...', optional: true },
        { key: 'code', label: 'Mã sản phẩm', placeholder: 'SP001', optional: true },
      ] },
    { action: 'createOrder', label: 'Tạo đơn hàng', icon: '✏️', desc: 'Tạo đơn hàng mới trong Nhanh.vn',
      fields: [] },
  ],
  pancake: [
    { action: 'lookupCustomer', label: 'Tra cứu khách hàng', icon: '👤', desc: 'Tìm theo SĐT',
      fields: [{ key: 'phone', label: 'Số điện thoại', placeholder: '0901234567' }] },
    { action: 'lookupOrder', label: 'Tra cứu đơn hàng', icon: '📋', desc: 'Tìm theo SĐT hoặc mã đơn',
      fields: [
        { key: 'phone', label: 'SĐT', placeholder: '0901234567', optional: true },
        { key: 'orderId', label: 'Mã đơn', placeholder: 'ID đơn', optional: true },
      ] },
    { action: 'lookupProduct', label: 'Tìm sản phẩm', icon: '🔍', desc: 'Tìm theo tên hoặc mã',
      fields: [
        { key: 'keyword', label: 'Từ khoá sản phẩm', placeholder: 'Sản phẩm...', optional: true },
        { key: 'code', label: 'Mã sản phẩm', placeholder: 'SP001', optional: true },
      ] },
    { action: 'createOrder', label: 'Tạo đơn hàng', icon: '✏️', desc: 'Tạo đơn hàng mới trong Pancake',
      fields: [] },
  ],
  ghn: [
    { action: 'getProvinces', label: 'Danh sách tỉnh/thành', icon: '🗺️', desc: 'Lấy master data tỉnh/thành GHN',
      fields: [] },
    { action: 'getDistricts', label: 'Danh sách quận/huyện', icon: '🏙️', desc: 'Lấy quận/huyện theo ProvinceID',
      fields: [{ key: 'provinceId', label: 'Province ID', placeholder: '201', type: 'number' }] },
    { action: 'getWards', label: 'Danh sách phường/xã', icon: '📍', desc: 'Lấy phường/xã theo DistrictID',
      fields: [{ key: 'districtId', label: 'District ID', placeholder: '1442', type: 'number' }] },
    { action: 'getServices', label: 'Dịch vụ khả dụng', icon: '🚛', desc: 'Lấy service GHN theo quận gửi / quận nhận',
      fields: [
        { key: 'fromDistrict', label: 'From District', placeholder: '1447', type: 'number' },
        { key: 'toDistrict', label: 'To District', placeholder: '1442', type: 'number' },
      ] },
    { action: 'getTracking', label: 'Tra cứu vận đơn', icon: '📦', desc: 'Tra cứu theo mã GHN',
      fields: [{ key: 'orderCode', label: 'Mã vận đơn GHN', placeholder: 'GHNXXXXX' }] },
    { action: 'calculateFee', label: 'Tính phí vận chuyển', icon: '💵', desc: 'Ước tính phí ship',
      fields: [
        { key: 'to_district_id', label: 'ID Quận nhận', placeholder: '1442', type: 'number' },
        { key: 'weight', label: 'Trọng lượng (gram)', placeholder: '500', type: 'number' },
        { key: 'service_type_id', label: 'Loại dịch vụ', type: 'select',
          options: [{ value: '2', label: '2 – Hàng nhẹ' }, { value: '5', label: '5 – Hàng nặng' }] },
      ] },
  ],
  ghtk: [
    { action: 'getTracking', label: 'Tra cứu vận đơn', icon: '🚚', desc: 'Tra cứu theo mã tracking',
      fields: [{ key: 'trackingCode', label: 'Mã tracking GHTK', placeholder: 'xxxxxxxxxxxxxx' }] },
    { action: 'calculateFee', label: 'Tính phí vận chuyển', icon: '💵', desc: 'Ước tính phí ship GHTK',
      fields: [
        { key: 'province', label: 'Tỉnh/TP nhận', placeholder: 'Hà Nội' },
        { key: 'district', label: 'Quận/Huyện nhận', placeholder: 'Hoàn Kiếm' },
        { key: 'weight', label: 'Trọng lượng (gram)', placeholder: '500', type: 'number' },
      ] },
  ],
  casso: [
    { action: 'getTransactions', label: 'Lịch sử giao dịch', icon: '💳', desc: 'Lấy giao dịch gần nhất',
      fields: [{ key: 'pageSize', label: 'Số giao dịch', placeholder: '10', type: 'number' }] },
  ],
  sepay: [
    { action: 'getTransactions', label: 'Lịch sử giao dịch', icon: '💰', desc: 'Lấy giao dịch gần nhất',
      fields: [{ key: 'limit', label: 'Số giao dịch', placeholder: '10', type: 'number' }] },
  ],
};

// ─── DEV MODE — Fake data for UI testing ──────────────────────────────────────

const DEV_MODE = IS_DEV_BUILD && false; // ← Đổi thành false khi deploy
const DEV_DEBUG = IS_DEV_BUILD;
const DEFAULT_PAGE_SIZE = 10;
const PAGED_ACTIONS = new Set(['lookupCustomer', 'lookupOrder', 'lookupProduct', 'getProducts']);

function safeJson(v: any): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v ?? ''); }
}

const FAKE_INTEGRATIONS: SavedIntegration[] = [
  { id: 'fake-kiotviet', type: 'kiotviet', name: 'KiotViet Shop', enabled: true, connectedAt: Date.now() - 86400000 },
  { id: 'fake-haravan',  type: 'haravan',  name: 'Haravan Store', enabled: true, connectedAt: Date.now() - 172800000 },
  { id: 'fake-sapo',     type: 'sapo',     name: 'Sapo POS',     enabled: true, connectedAt: Date.now() - 259200000 },
  { id: 'fake-ghn',      type: 'ghn',      name: 'GHN Express',  enabled: true, connectedAt: Date.now() - 345600000 },
  { id: 'fake-ghtk',     type: 'ghtk',     name: 'GHTK Ship',    enabled: true, connectedAt: Date.now() - 432000000 },
  { id: 'fake-casso',    type: 'casso',    name: 'Casso Bank',   enabled: true, connectedAt: Date.now() - 518400000 },
  { id: 'fake-sepay',    type: 'sepay',    name: 'SePay QR',     enabled: true, connectedAt: Date.now() - 604800000 },
  { id: 'fake-ipos',     type: 'ipos',     name: 'iPOS Quán',    enabled: true, connectedAt: Date.now() - 691200000 },
  { id: 'fake-nhanh',    type: 'nhanh',    name: 'Nhanh.vn',     enabled: true, connectedAt: Date.now() - 777600000 },
  { id: 'fake-pancake',  type: 'pancake',  name: 'Pancake POS',  enabled: true, connectedAt: Date.now() - 850000000 },
];

const FAKE_RESULTS: Record<string, Record<string, any>> = {
  lookupCustomer: {
    customers: [
      { id: 10234, name: 'Nguyễn Văn An', contactNumber: '0901234567', email: 'an.nguyen@gmail.com', orderCount: 15, address: '123 Lê Lợi, Q1, TP.HCM' },
      { id: 10235, name: 'Trần Thị Bình', contactNumber: '0912345678', email: 'binh.tran@yahoo.com', orderCount: 8, address: '45 Nguyễn Huệ, Q1, TP.HCM' },
      { id: 10236, name: 'Lê Hoàng Cường', contactNumber: '0923456789', email: 'cuong.le@outlook.com', orderCount: 23, address: '78 Hai Bà Trưng, Q3, TP.HCM' },
    ],
  },
  lookupOrder: {
    orders: [
      { id: 'ORD-2026001', code: 'ORD-2026001', customerName: 'Nguyễn Văn An', customerPhone: '0901234567', statusValue: 1, statusText: 'Hoàn thành', totalPayment: 1250000, createdDate: '2026-03-28', address: '123 Lê Lợi, Q1, TP.HCM',
        items: [{ name: 'Áo Thun Basic Cotton', code: 'SP001', quantity: 2, price: 199000 }, { name: 'Nón Bucket Unisex', code: 'SP005', quantity: 1, price: 150000 }, { name: 'Giày Sneaker Trắng', code: 'SP003', quantity: 1, price: 890000 }],
        paymentMethod: 'bank_transfer', shippingFee: 30000, discount: 217000, note: 'Giao giờ hành chính', trackingCode: 'GHN7P2A3B4' },
      { id: 'ORD-2026002', code: 'ORD-2026002', customerName: 'Trần Thị Bình', customerPhone: '0912345678', statusValue: 0, statusText: 'Đang xử lý', totalPayment: 890000, createdDate: '2026-03-29', address: '45 Nguyễn Huệ, Q1, TP.HCM',
        items: [{ name: 'Giày Sneaker Trắng', code: 'SP003', quantity: 1, price: 890000 }],
        paymentMethod: 'cod', shippingFee: 25000, discount: 0, note: '' },
      { id: 'ORD-2026003', code: 'ORD-2026003', customerName: 'Phạm Minh Đức', customerPhone: '0933456789', statusValue: 1, statusText: 'Hoàn thành', totalPayment: 2340000, createdDate: '2026-03-30', address: '90 Trần Hưng Đạo, Q5, TP.HCM',
        items: [{ name: 'Túi Xách Da Cao Cấp', code: 'SP004', quantity: 1, price: 1250000 }, { name: 'Đồng Hồ Classic Silver', code: 'SP006', quantity: 1, price: 2500000 }],
        paymentMethod: 'card', shippingFee: 0, discount: 1410000, note: 'VIP customer', trackingCode: 'GHTK9X8Y7Z' },
      { id: 'ORD-2026004', code: 'ORD-2026004', customerName: 'Lê Thị E', customerPhone: '0944567890', statusValue: 2, statusText: 'Đã hủy', totalPayment: 450000, createdDate: '2026-03-30', address: '12 Phạm Ngọc Thạch, Q3, TP.HCM',
        items: [{ name: 'Quần Jean Slim Fit', code: 'SP002', quantity: 1, price: 450000 }],
        paymentMethod: 'cod', shippingFee: 30000, discount: 30000, note: 'Khách đổi ý', cancelReason: 'Khách yêu cầu hủy' },
      { id: 'ORD-2026005', code: 'ORD-2026005', customerName: 'Võ Hoàng F', customerPhone: '0955678901', statusValue: 0, statusText: 'Chờ thanh toán', totalPayment: 3100000, createdDate: '2026-03-31', address: '55 Võ Văn Tần, Q3, TP.HCM',
        items: [{ name: 'Đồng Hồ Classic Silver', code: 'SP006', quantity: 1, price: 2500000 }, { name: 'Ví Da Nam Compact', code: 'SP011', quantity: 1, price: 245000 }, { name: 'Dây Chuyền Bạc 925', code: 'SP012', quantity: 1, price: 380000 }],
        paymentMethod: 'momo', shippingFee: 0, discount: 25000, note: 'Gói quà tặng' },
    ],
  },
  lookupProduct: {
    products: [
      { id: 'SP001', code: 'SP001', name: 'Áo Thun Basic Cotton', basePrice: 199000, onHand: 142 },
      { id: 'SP002', code: 'SP002', name: 'Quần Jean Slim Fit', basePrice: 450000, onHand: 67 },
      { id: 'SP003', code: 'SP003', name: 'Giày Sneaker Trắng', basePrice: 890000, onHand: 23 },
      { id: 'SP004', code: 'SP004', name: 'Túi Xách Da Cao Cấp', basePrice: 1250000, onHand: 8 },
      { id: 'SP005', code: 'SP005', name: 'Nón Bucket Unisex', basePrice: 150000, onHand: 210 },
      { id: 'SP006', code: 'SP006', name: 'Đồng Hồ Classic Silver', basePrice: 2500000, onHand: 5 },
      { id: 'SP007', code: 'SP007', name: 'Kính Mát Thời Trang', basePrice: 350000, onHand: 44 },
    ],
  },
  getTracking: {
    tracking: {
      order_code: 'GHN7P2A3B4',
      status: 'Đang giao hàng',
      status_text: 'Shipper đang trên đường giao',
      updated_date: '2026-03-31 14:30',
    },
    orderCode: 'GHN7P2A3B4',
    status: 'Đang giao hàng',
  },
  calculateFee: {
    fee: {
      total: 32500,
      service_fee: 25000,
      insurance_fee: 7500,
    },
  },
  getTransactions: {
    transactions: [
      { when: '2026-03-31 10:15', in: 1250000, description: 'CK tu NGUYEN VAN AN - Thanh toan don ORD-2026001' },
      { when: '2026-03-31 09:45', in: 890000, description: 'CK tu TRAN THI BINH - Mua hang online' },
      { when: '2026-03-30 16:20', in: 2340000, description: 'CK tu PHAM MINH DUC - Don hang ORD-2026003' },
      { when: '2026-03-30 11:00', in: 150000, description: 'CK tu LE THI E - Dat coc don hang' },
      { when: '2026-03-29 22:35', in: 5600000, description: 'CK tu VO HOANG F - Thanh toan don lon' },
    ],
  },
  createOrder: {
    success: true,
    order: { id: 'ORD-2026099', code: 'ORD-2026099' },
  },
};

function fakeExecute(_integrationId: string, action: string, _params: Record<string, any>): Promise<any> {
  return new Promise(resolve => {
    setTimeout(() => {
      const data = FAKE_RESULTS[action] || { message: 'Fake: Không có dữ liệu mẫu cho action này' };
      resolve({ success: true, data });
    }, 600 + Math.random() * 800);
  });
}

function firstNonEmptyString(...values: any[]): string {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstNonEmptyString(...value);
      if (nested) return nested;
      continue;
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function firstFiniteNumber(...values: any[]): number {
  for (const value of values) {
    if (value === '' || value == null) continue;
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

function compactJoin(parts: any[], separator = ', '): string {
  return parts
    .map(part => (typeof part === 'string' ? part.trim() : part))
    .filter(Boolean)
    .join(separator);
}

function formatLooseAddress(address: any): string {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();

  return firstNonEmptyString(
    address.fullAddress,
    address.full_address,
    address.address1,
    compactJoin([
      address.address,
      address.ward_name || address.ward || address.commune_name || address.commnue_name,
      address.district_name || address.district,
      address.province_name || address.province,
    ]),
  );
}

function normalizePhoneDisplay(phone: string): string {
  if (!phone) return phone;
  const digits = phone.startsWith('+') ? phone.slice(1) : phone;
  if (digits.startsWith('84') && digits.length >= 11) return '0' + digits.slice(2);
  return phone;
}

function extractPhoneValue(...values: any[]): string {
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      const nested = extractPhoneValue(...value);
      if (nested) return nested;
      continue;
    }
    if (typeof value === 'object') {
      const nested = extractPhoneValue(
        value.phone,
        value.phone_number,
        value.mobile,
        value.contactNumber,
        value.number,
      );
      if (nested) return nested;
      continue;
    }
    const text = firstNonEmptyString(value);
    if (text) return normalizePhoneDisplay(text);
  }
  return '';
}

function firstNonEmptyArray<T = any>(...values: any[]): T[] {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function normalizeCustomerForDisplay(customer: any) {
  const orderCount = Array.isArray(customer?.purchaseHistory)
    ? customer.purchaseHistory.length
    : customer?.orderCount ?? customer?.order_count ?? customer?.succeed_order_count ?? undefined;

  return {
    id: firstNonEmptyString(customer?.id, customer?.customerId, customer?.customer_id, customer?.fb_id),
    name: firstNonEmptyString(customer?.name, customer?.fullName, customer?.contactName, customer?.username) || '—',
    phone: extractPhoneValue(
      customer?.contactNumber,
      customer?.phone,
      customer?.mobile,
      customer?.phone_number,
      customer?.phone_numbers,
    ),
    email: firstNonEmptyString(customer?.email, customer?.emails),
    address: firstNonEmptyString(
      customer?.address,
      customer?.fullAddress,
      customer?.full_address,
      formatLooseAddress(customer?.shipping_address),
      formatLooseAddress(customer?.defaultAddress),
      formatLooseAddress(customer?.shop_customer_addresses?.[0]),
    ),
    orderCount,
    purchasedAmount: firstFiniteNumber(customer?.purchased_amount, customer?.total_amount, customer?.total_spent),
  };
}

function normalizeOrderItem(item: any) {
  const quantity = firstFiniteNumber(item?.quantity, item?.qty, item?.total_quantity, item?.item_quantity, item?.product_quantity, 1) || 1;
  const totalLinePrice = firstFiniteNumber(item?.total_price, item?.line_total, item?.amount, item?.sub_total);
  const directPrice = firstFiniteNumber(
    item?.price,
    item?.displaySalePrice,        // Nhanh.vn
    item?.priceAfterVAT,           // Nhanh.vn fallback
    item?.unit_price,
    item?.basePrice,
    item?.retail_price,
    item?.final_price,
    item?.item_price,
    item?.product_info?.price,
    item?.product_info?.retail_price,
  );
  const price = directPrice || (totalLinePrice > 0 ? totalLinePrice / quantity : 0);

  return {
    quantity,
    price,
    name: firstNonEmptyString(
      item?.name,
      item?.productName,
      item?.title,
      item?.fullName,
      item?.product_info?.name,
      item?.product_info?.title,
      item?.variation_info?.name,
      item?.variation_name,
      item?.product_name,
      item?.sku,
    ) || '—',
    code: firstNonEmptyString(
      item?.code,
      item?.sku,
      item?.barcode,
      item?.productCode,
      item?.product_info?.code,
      item?.product_info?.sku,
      item?.variation_id,
      item?.product_id,
    ),
  };
}

// ── Nhanh.vn numeric status codes ──────────────────────────────────────────
const NHANH_STATUS_MAP: Record<number, { text: string; color: string }> = {
  1:  { text: 'Mới',             color: 'bg-blue-900/50 text-blue-400' },
  3:  { text: 'Xác nhận',        color: 'bg-cyan-900/50 text-cyan-400' },
  5:  { text: 'Đang đóng gói',   color: 'bg-yellow-900/50 text-yellow-400' },
  7:  { text: 'Đóng gói xong',   color: 'bg-yellow-900/50 text-yellow-400' },
  9:  { text: 'Đang giao hàng',  color: 'bg-yellow-900/50 text-yellow-400' },
  11: { text: 'Giao thành công', color: 'bg-green-900/50 text-green-400' },
  13: { text: 'Hoàn tất',        color: 'bg-green-900/50 text-green-400' },
  15: { text: 'Đã hủy',          color: 'bg-red-900/50 text-red-400' },
  42: { text: 'Đã đóng gói',     color: 'bg-yellow-900/50 text-yellow-400' },
  54: { text: 'Chờ xác nhận',    color: 'bg-blue-900/50 text-blue-400' },
  59: { text: 'Trả hàng',        color: 'bg-orange-900/50 text-orange-400' },
  64: { text: 'Đã hủy',          color: 'bg-red-900/50 text-red-400' },
  68: { text: 'Đã hủy',          color: 'bg-red-900/50 text-red-400' },
  72: { text: 'Đã giao',         color: 'bg-green-900/50 text-green-400' },
};

function formatUnixTimestamp(ts: number | string | undefined): string {
  if (ts == null || ts === '') return '';
  const num = typeof ts === 'string' ? parseInt(ts, 10) : ts;
  if (!Number.isFinite(num) || num <= 0) return '';
  return new Date(num * 1000).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  completed: 'Hoàn thành',
  complete: 'Hoàn thành',
  delivered: 'Đã giao',
  shipping: 'Đang giao',
  delivering: 'Đang giao',
  pending: 'Đang xử lý',
  processing: 'Đang xử lý',
  unpaid: 'Chờ thanh toán',
  waiting_for_payment: 'Chờ thanh toán',
  cancelled: 'Đã hủy',
  canceled: 'Đã hủy',
  removed: 'Đã hủy',
  failed: 'Thất bại',
  draft: 'Nháp',
};

function normalizeOrderStatus(rawStatus: any, numericStatus: any): { text: string; color: string } {
  const rawText = firstNonEmptyString(rawStatus);
  const normalizedKey = rawText.toLowerCase();
  const text = rawText
    ? (ORDER_STATUS_LABELS[normalizedKey] || rawText)
    : numericStatus === 1
    ? 'Hoàn thành'
    : numericStatus === 2
    ? 'Đã hủy'
    : numericStatus === 0
    ? 'Đang xử lý'
    : numericStatus != null
    ? `#${numericStatus}`
    : '—';

  if (['completed', 'complete', 'delivered'].includes(normalizedKey) || numericStatus === 1) {
    return { text, color: 'bg-green-900/50 text-green-400' };
  }
  if (['cancelled', 'canceled', 'removed', 'failed'].includes(normalizedKey) || numericStatus === 2) {
    return { text, color: 'bg-red-900/50 text-red-400' };
  }
  if (['pending', 'processing', 'unpaid', 'waiting_for_payment', 'shipping', 'delivering', 'draft'].includes(normalizedKey) || numericStatus === 0) {
    return { text, color: 'bg-yellow-900/50 text-yellow-400' };
  }
  return { text, color: 'bg-gray-700 text-gray-400' };
}

function resolveOrderPaymentMethod(order: any): string {
  const explicit = firstNonEmptyString(order?.paymentMethod, order?.payment_method);
  if (explicit) return explicit;
  if (firstFiniteNumber(order?.charged_by_momo) > 0) return 'momo';
  if (firstFiniteNumber(order?.charged_by_card) > 0) return 'card';
  if (firstFiniteNumber(order?.charged_by_qrpay) > 0) return 'qrpay';
  if (firstFiniteNumber(order?.cash) > 0) return 'cash';
  if (firstFiniteNumber(order?.cod, order?.money_to_collect) > 0) return 'cod';
  return '';
}

function normalizeOrderForDisplay(order: any) {
  // ── Nhanh.vn nested structure detection ──────────────────────────────────
  if (order?.info != null && order.info?.id != null && order?.shippingAddress != null) {
    const info    = order.info;
    const addr    = order.shippingAddress;
    const payment = order.payment ?? {};
    const products: any[] = order.products || [];

    const nhanhStatus = NHANH_STATUS_MAP[info?.status as number];
    const statusResult = nhanhStatus ?? {
      text: info?.status != null ? `#${info.status}` : '—',
      color: 'bg-gray-700 text-gray-400',
    };

    const items = products.map(normalizeOrderItem);
    const customerName  = firstNonEmptyString(addr?.name);
    const customerPhone = firstNonEmptyString(addr?.mobile, addr?.phone);

    return {
      code: firstNonEmptyString(info?.id),
      statusText: statusResult.text,
      statusColor: statusResult.color,
      customerSummary: compactJoin([customerName, customerPhone], ' · '),
      items,
      itemCount: items.length,
      address: compactJoin([addr?.address, addr?.location]),
      trackingCode: '',
      trackingLink: firstNonEmptyString(info?.trackingUrl),
      orderLink: '',
      sourceName: '',
      sellerName: firstNonEmptyString(info?.packName, info?.customerCareName),
      deliveryPartner: '',
      moneyToCollect: firstFiniteNumber(payment?.codAmount),
      note: firstNonEmptyString(info?.note),
      cancelReason: '',
      payMethod: firstFiniteNumber(payment?.codAmount) > 0 ? 'cod' : '',
      shippingFee: firstFiniteNumber(payment?.shipFee),
      discount: firstFiniteNumber(payment?.discount?.amount),
      total: firstFiniteNumber(payment?.codAmount, payment?.businessPayment),
      createdDate: formatUnixTimestamp(info?.createdAt),
    };
  }

  // ── Generic / other platforms ─────────────────────────────────────────────
  const items = firstNonEmptyArray(order?.items, order?.orderDetails, order?.line_items, order?.invoiceDetails).map(normalizeOrderItem);
  const status = normalizeOrderStatus(order?.statusText || order?.status_name || order?.statusName || order?.status, order?.statusValue ?? (typeof order?.status === 'number' ? order.status : undefined));
  const customerName = firstNonEmptyString(
    order?.customerName,
    order?.bill_full_name,
    order?.customer?.name,
    order?.shipping_address?.full_name,
  );
  const customerPhone = extractPhoneValue(
    order?.customerPhone,
    order?.bill_phone_number,
    order?.customer?.contactNumber,
    order?.customer?.phone,
    order?.customer?.phone_numbers,
    order?.shipping_address?.phone_number,
    order?.shipping_address?.phone,
  );

  return {
    code: firstNonEmptyString(order?.code, order?.orderCode, order?.order_code, order?.id),
    statusText: status.text,
    statusColor: status.color,
    customerSummary: compactJoin([customerName, customerPhone], ' · '),
    items,
    itemCount: firstFiniteNumber(order?.items_length, order?.total_quantity, items.length),
    address: firstNonEmptyString(
      order?.address,
      order?.shipAddress,
      order?.customerAddress,
      formatLooseAddress(order?.shipping_address),
      formatLooseAddress(order?.shippingAddress),
    ),
    trackingCode: firstNonEmptyString(
      order?.trackingCode,
      order?.deliveryCode,
      order?.shippingTrackingCode,
      order?.partner?.tracking_code,
      order?.partner?.tracking_number,
    ),
    trackingLink: firstNonEmptyString(order?.tracking_link, order?.trackingLink, order?.partner?.tracking_link),
    orderLink: firstNonEmptyString(order?.order_link, order?.link),
    sourceName: firstNonEmptyString(order?.order_sources_name, order?.source_name, order?.sourceName),
    sellerName: firstNonEmptyString(order?.assigning_seller?.name, order?.sellerName, order?.saleName),
    deliveryPartner: firstNonEmptyString(order?.partner?.name, order?.partner?.delivery_name, order?.shippingCarrier, order?.carrierName),
    moneyToCollect: firstFiniteNumber(order?.money_to_collect, order?.cod),
    note: firstNonEmptyString(order?.note, order?.note_print, order?.description),
    cancelReason: firstNonEmptyString(order?.cancelReason, order?.returned_reason_name, order?.returned_reason),
    payMethod: resolveOrderPaymentMethod(order),
    shippingFee: firstFiniteNumber(order?.shippingFee, order?.shipping_fee, order?.orderDelivery?.price),
    discount: firstFiniteNumber(order?.discount, order?.total_discounts, order?.discountAmount, order?.total_discount),
    total: firstFiniteNumber(
      order?.totalPayment,
      order?.total_price_after_sub_discount,
      order?.total_price,
      order?.total,
      order?.calcTotalMoney,
      order?.money_to_collect,
    ),
    createdDate: firstNonEmptyString(order?.createdDate, order?.inserted_at, order?.created_at, order?.purchaseDate, order?.updated_at),
  };
}

function getPagedResultMeta(data: any, fallbackPage = 1, fallbackPageSize = DEFAULT_PAGE_SIZE) {
  const rows = firstNonEmptyArray(
    data?.customers,
    data?.orders,
    data?.products,
    data?.transactions,
    data?.data?.customers,
    data?.data?.orders,
    data?.data?.products,
  );
  const page = firstFiniteNumber(data?.page, fallbackPage) || fallbackPage;
  const pageSize = firstFiniteNumber(data?.pageSize, fallbackPageSize) || fallbackPageSize;
  const rawTotal = data?.total;
  const total = rawTotal == null || rawTotal === '' ? undefined : Number(rawTotal);
  const explicitHasNext = typeof data?.hasNext === 'boolean' ? data.hasNext : undefined;

  return {
    page,
    pageSize,
    total: Number.isFinite(total as number) ? total : undefined,
    hasNext: explicitHasNext ?? (rows.length >= pageSize && rows.length > 0),
  };
}

function normalizeProductForDisplay(product: any) {
  const nestedProduct = product?.product_info || product?.product || product?.item || {};
  return {
    image: firstNonEmptyString(
      product?.images?.avatar,          // Nhanh.vn: images.avatar (string)
      product?.images?.[0]?.url,
      product?.images?.[0]?.src,
      product?.image?.src,
      product?.image_url,
      product?.imageUrl,
      product?.image,
      product?.avatar,
      nestedProduct?.images?.[0]?.url,
      nestedProduct?.images?.[0]?.src,
      nestedProduct?.image_url,
      nestedProduct?.imageUrl,
      nestedProduct?.image,
      nestedProduct?.avatar,
      product?.smallImage,
      product?.thumbnail,
    ),
    price: firstFiniteNumber(
      product?.prices?.retail,           // Nhanh.vn: prices.retail
      product?.basePrice,
      product?.price,
      product?.retailPrice,
      product?.retail_price,
      product?.final_price,
      product?.variants?.[0]?.price,
      nestedProduct?.price,
      nestedProduct?.retailPrice,
      nestedProduct?.retail_price,
    ),
    stock: firstFiniteNumber(
      product?.inventory?.remain,        // Nhanh.vn: inventory.remain
      product?.onHand,
      product?.inventory_quantity,
      product?.stock,
      product?.remaining,
      product?.quantity,
      product?.available,
      nestedProduct?.onHand,
      nestedProduct?.inventory_quantity,
      nestedProduct?.stock,
      nestedProduct?.remaining,
    ),
    name: firstNonEmptyString(
      product?.name,
      product?.fullName,
      product?.productName,
      product?.title,
      product?.variation_name,
      product?.product_name,
      nestedProduct?.name,
      nestedProduct?.fullName,
      nestedProduct?.title,
    ) || '—',
    code: firstNonEmptyString(
      product?.code,
      product?.sku,
      product?.barcode,
      product?.display_id,
      product?.variation_id,
      product?.id,
      nestedProduct?.code,
      nestedProduct?.sku,
      nestedProduct?.id,
    ),
  };
}

// ─── OrderCard — expandable order detail ─────────────────────────────────────
function OrderCard({ o }: { o: any }) {
  const [expanded, setExpanded] = React.useState(false);
  const normalized = normalizeOrderForDisplay(o);

  const PAY_LABEL: Record<string, string> = {
    cod: 'COD', cash: 'Tiền mặt', bank_transfer: 'Chuyển khoản',
    card: 'Thẻ', momo: 'MoMo', zalopay: 'ZaloPay', vnpay: 'VNPay', qrpay: 'QRPay',
  };
  const hasDetail =
    normalized.items.length > 0 ||
    normalized.itemCount > 0 ||
    normalized.address ||
    normalized.trackingCode ||
    normalized.trackingLink ||
    normalized.orderLink ||
    normalized.note ||
    normalized.cancelReason ||
    normalized.payMethod ||
    normalized.shippingFee > 0 ||
    normalized.deliveryPartner ||
    normalized.sellerName ||
    normalized.sourceName ||
    normalized.moneyToCollect > 0;

  return (
    <div className="bg-gray-700/50 rounded-lg overflow-hidden border border-gray-600/30">
      {/* ── Header ── */}
      <button
        onClick={() => hasDetail && setExpanded(v => !v)}
        className={`w-full px-3 py-2 text-left ${hasDetail ? 'hover:bg-gray-700/60 transition-colors' : ''}`}
      >
        <div className="flex items-center justify-between mb-0.5">
          <p className="text-xs font-semibold text-white font-mono">#{normalized.code || '—'}</p>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${normalized.statusColor}`}>
            {normalized.statusText}
          </span>
        </div>
        <div className="flex items-center justify-between gap-1">
          <p className="text-[11px] text-gray-400 truncate">{normalized.customerSummary || '—'}</p>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="text-xs font-semibold text-blue-300">{normalized.total.toLocaleString('vi-VN')}đ</span>
            {hasDetail && (
              <svg className={`w-3 h-3 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            )}
          </div>
        </div>
        {normalized.createdDate && <p className="text-[10px] text-gray-600 mt-0.5">{normalized.createdDate}</p>}
      </button>

      {/* ── Expandable detail ── */}
      {expanded && (
        <div className="border-t border-gray-600/40 px-3 py-2 space-y-2 bg-gray-800/40">
          {/* Items list */}
          {(normalized.items.length > 0 || normalized.itemCount > 0) && (
            <div>
              <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide mb-1">
                Sản phẩm ({normalized.itemCount || normalized.items.length})
              </p>
              {normalized.items.length > 0 ? (
                <div className="space-y-1">
                  {normalized.items.map((item: any, j: number) => {
                    return (
                      <div key={j} className="flex items-start justify-between gap-2">
                        <div className="flex items-baseline gap-1 min-w-0 flex-1">
                          <span className="text-[11px] text-gray-500 flex-shrink-0">{item.quantity}×</span>
                          <span className="text-[11px] text-gray-200 leading-snug truncate">{item.name}</span>
                        </div>
                        <span className="text-[11px] text-gray-400 flex-shrink-0">
                          {(Number(item.price) * Number(item.quantity)).toLocaleString('vi-VN')}đ
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-gray-500">Có sản phẩm trong đơn nhưng API chưa trả chi tiết từng dòng.</p>
              )}
            </div>
          )}

          {/* Fee summary */}
          {(normalized.shippingFee > 0 || normalized.discount > 0) && (
            <div className="space-y-0.5 border-t border-gray-700/40 pt-1.5">
              {normalized.shippingFee > 0 && (
                <div className="flex justify-between">
                  <span className="text-[11px] text-gray-500">🚚 Phí ship:</span>
                  <span className="text-[11px] text-gray-300">+{normalized.shippingFee.toLocaleString('vi-VN')}đ</span>
                </div>
              )}
              {normalized.discount > 0 && (
                <div className="flex justify-between">
                  <span className="text-[11px] text-gray-500">🏷️ Giảm giá:</span>
                  <span className="text-[11px] text-orange-400">-{normalized.discount.toLocaleString('vi-VN')}đ</span>
                </div>
              )}
            </div>
          )}

          {/* Payment */}
          {normalized.payMethod && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500">💳</span>
              <span className="text-[11px] text-gray-300">{PAY_LABEL[normalized.payMethod] || normalized.payMethod}</span>
            </div>
          )}

          {normalized.moneyToCollect > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500">💰</span>
              <span className="text-[11px] text-gray-300">Thu hộ: {normalized.moneyToCollect.toLocaleString('vi-VN')}đ</span>
            </div>
          )}

          {(normalized.sourceName || normalized.sellerName || normalized.deliveryPartner) && (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {normalized.sourceName && <p className="text-[11px] text-gray-400">🌐 Nguồn: {normalized.sourceName}</p>}
              {normalized.sellerName && <p className="text-[11px] text-gray-400">🙋 Phụ trách: {normalized.sellerName}</p>}
              {normalized.deliveryPartner && <p className="text-[11px] text-gray-400">🚚 ĐVVC: {normalized.deliveryPartner}</p>}
            </div>
          )}

          {/* Address */}
          {normalized.address && (
            <div className="flex items-start gap-1.5">
              <span className="text-[10px] text-gray-500 mt-0.5 flex-shrink-0">📍</span>
              <p className="text-[11px] text-gray-400 leading-snug">{normalized.address}</p>
            </div>
          )}

          {/* Tracking */}
          {normalized.trackingCode && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 flex-shrink-0">📦</span>
              <span className="text-[11px] text-blue-400 font-mono">{normalized.trackingCode}</span>
            </div>
          )}

          {normalized.trackingLink && (
            <div className="flex items-start gap-1.5">
              <span className="text-[10px] text-gray-500 flex-shrink-0 mt-0.5">🔗</span>
              <p className="text-[11px] text-blue-400 break-all">{normalized.trackingLink}</p>
            </div>
          )}

          {normalized.orderLink && (
            <div className="flex items-start gap-1.5">
              <span className="text-[10px] text-gray-500 flex-shrink-0 mt-0.5">🧾</span>
              <p className="text-[11px] text-blue-400 break-all">{normalized.orderLink}</p>
            </div>
          )}

          {/* Note */}
          {normalized.note && (
            <div className="flex items-start gap-1.5">
              <span className="text-[10px] text-gray-500 flex-shrink-0 mt-0.5">📝</span>
              <p className="text-[11px] text-gray-400 italic leading-snug">{normalized.note}</p>
            </div>
          )}

          {/* Cancel reason */}
          {normalized.cancelReason && (
            <div className="flex items-start gap-1.5 bg-red-900/20 rounded-lg px-2 py-1.5">
              <span className="text-[10px] text-red-400 flex-shrink-0">✕</span>
              <p className="text-[11px] text-red-400 leading-snug">{normalized.cancelReason}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ProductCard — with image thumbnail ──────────────────────────────────────
function ProductCard({ p }: { p: any }) {
  const normalized = normalizeProductForDisplay(p);
  const img = normalized.image;
  const price = normalized.price;
  const stock = normalized.stock;
  const name  = normalized.name;
  const code  = normalized.code;

  return (
    <div className="bg-gray-700/50 rounded-lg px-2.5 py-2 flex items-center gap-2.5 border border-gray-600/30">
      {/* Image or fallback */}
      <div className="w-10 h-10 rounded-lg bg-gray-600 flex items-center justify-center flex-shrink-0 overflow-hidden border border-gray-600/40">
        {img
          ? <img src={img} alt={name} className="w-full h-full object-cover"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.textContent = '📦'; }} />
          : <span className="text-base">📦</span>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-white leading-snug truncate" title={name}>{name}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {code && <span className="text-[10px] text-gray-500">{code}</span>}
          {price != null && (
            <span className="text-[11px] text-blue-300 font-medium">{Number(price).toLocaleString('vi-VN')}đ</span>
          )}
          {stock != null && (
            <span className={`text-[10px] ${Number(stock) > 0 ? 'text-green-500' : 'text-red-400'}`}>
              kho: {stock}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Result Formatter ─────────────────────────────────────────────────────────

function formatResult(_action: string, data: any): React.ReactNode {
  if (!data) return <span className="text-gray-500 text-xs">Không có kết quả</span>;

  // Customers
  if (data.customers !== undefined) {
    const customers: any[] = data.customers || [];
    if (!customers.length) return <span className="text-yellow-400 text-xs">⚠️ Không tìm thấy khách hàng</span>;
    return (
      <div className="space-y-1.5">
        {customers.map((c: any, i: number) => {
          const customer = normalizeCustomerForDisplay(c);
          return (
            <div key={i} className="bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600/30">
              <p className="text-xs font-medium text-white">{customer.name}</p>
              <p className="text-[11px] text-gray-400">{compactJoin([customer.phone, customer.email], ' · ') || '—'}</p>
              <p className="text-[10px] text-gray-500">
                ID: {customer.id || '—'} · Đơn: {customer.orderCount ?? '—'}
                {customer.purchasedAmount > 0 ? ` · Mua: ${customer.purchasedAmount.toLocaleString('vi-VN')}đ` : ''}
              </p>
              {customer.address && <p className="text-[10px] text-gray-500 mt-1 leading-snug">📍 {customer.address}</p>}
            </div>
          );
        })}
      </div>
    );
  }

  // Orders — dùng OrderCard expandable
  if (data.orders !== undefined || data.order !== undefined) {
    const orders: any[] = firstNonEmptyArray(data.orders, data.data?.orders, data.result?.orders, data.response?.orders);
    const normalizedOrders = orders.length > 0 ? orders : (data.order ? [data.order] : []);
    if (!normalizedOrders.length) return <span className="text-yellow-400 text-xs">⚠️ Không tìm thấy đơn hàng</span>;
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] text-gray-500">Nhấn vào đơn để xem chi tiết ↓</p>
        {normalizedOrders.map((o: any, i: number) => <OrderCard key={i} o={o} />)}
      </div>
    );
  }

  // Products — dùng ProductCard có ảnh
  if (data.products !== undefined) {
    const products: any[] = data.products || [];
    if (!products.length) return <span className="text-yellow-400 text-xs">⚠️ Không tìm thấy sản phẩm</span>;
    return (
      <div className="space-y-1.5">
        {products.map((p: any, i: number) => <ProductCard key={i} p={p} />)}
      </div>
    );
  }

  // Provinces / Districts / Wards
  if (data.provinces !== undefined || data.districts !== undefined || data.wards !== undefined) {
    const rows: any[] = data.provinces || data.districts || data.wards || [];
    if (!rows.length) return <span className="text-yellow-400 text-xs">⚠️ Không có dữ liệu địa chỉ</span>;
    return (
      <div className="space-y-1.5">
        {rows.slice(0, 12).map((row: any, i: number) => (
          <div key={i} className="bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600/30">
            <p className="text-xs font-medium text-white">{row.ProvinceName || row.DistrictName || row.WardName || row.name || '—'}</p>
            <p className="text-[11px] text-gray-400 font-mono">
              ID: {row.ProvinceID || row.DistrictID || row.WardCode || row.id || '—'}
            </p>
          </div>
        ))}
        {rows.length > 12 && <p className="text-xs text-gray-500 text-center">+{rows.length - 12} mục khác</p>}
      </div>
    );
  }

  // Services
  if (data.services !== undefined) {
    const services: any[] = data.services || [];
    if (!services.length) return <span className="text-yellow-400 text-xs">⚠️ Không có dịch vụ phù hợp</span>;
    return (
      <div className="space-y-1.5">
        {services.map((svc: any, i: number) => (
          <div key={i} className="bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600/30">
            <p className="text-xs font-medium text-white">{svc.short_name || svc.name || `Service #${svc.service_id || i + 1}`}</p>
            <p className="text-[11px] text-gray-400 font-mono">
              service_id: {svc.service_id ?? '—'} · service_type_id: {svc.service_type_id ?? '—'}
            </p>
          </div>
        ))}
      </div>
    );
  }

  // Tracking
  if (data.tracking !== undefined) {
    const t = data.tracking || {};
    return (
      <div className="bg-gray-700/60 rounded-lg px-3 py-2 space-y-1">
        <p className="text-sm font-medium text-white">Mã: {t.order_code || t.label || data.orderCode || data.trackingCode || '—'}</p>
        <p className="text-xs text-blue-300">{data.status || t.status || t.status_text || '—'}</p>
        {(t.updated_date || data.updatedDate) && <p className="text-[11px] text-gray-400">Cập nhật: {t.updated_date || data.updatedDate}</p>}
      </div>
    );
  }

  // Transactions
  if (data.transactions !== undefined) {
    const txs: any[] = data.transactions || [];
    if (!txs.length) return <span className="text-yellow-400 text-xs">⚠️ Không có giao dịch</span>;
    return (
      <div className="space-y-1.5">
        {txs.slice(0, 5).map((tx: any, i: number) => (
          <div key={i} className="bg-gray-700/60 rounded-lg px-3 py-2">
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">{tx.when || tx.transactionDate || tx.created_at || '—'}</span>
              <span className={`text-xs font-medium ${(tx.in || tx.amount || 0) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                +{(tx.in || tx.amount || 0).toLocaleString('vi-VN')}đ
              </span>
            </div>
            <p className="text-[11px] text-gray-300 truncate">{tx.description || tx.memo || tx.content || '—'}</p>
          </div>
        ))}
      </div>
    );
  }

  // Fee
  if (data.fee !== undefined) {
    const f = data.fee;
    return (
      <div className="bg-gray-700/60 rounded-lg px-3 py-2 space-y-1">
        <p className="text-sm font-medium text-white">Phí dự kiến: {(f.total || f.fee || f.service_fee || 0).toLocaleString('vi-VN')}đ</p>
        {f.insurance_fee !== undefined && <p className="text-xs text-gray-400">Bảo hiểm: {f.insurance_fee.toLocaleString('vi-VN')}đ</p>}
      </div>
    );
  }

  // CreateOrder success
  if (data.success && data.order) {
    const o = data.order;
    return (
      <div className="bg-green-900/30 border border-green-700/40 rounded-lg px-3 py-2">
        <p className="text-sm font-medium text-green-300">✅ Tạo đơn thành công!</p>
        <p className="text-xs text-green-400">Mã đơn: {o.code || o.id || o.orderId || '—'}</p>
      </div>
    );
  }

  // Fallback
  return (
    <details className="text-xs">
      <summary className="text-gray-400 cursor-pointer hover:text-gray-200">Xem dữ liệu thô</summary>
      <pre className="bg-gray-900 rounded p-2 mt-1 overflow-x-auto text-green-300 text-[10px] max-h-40">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

// ─── Main Component — Side Panel ──────────────────────────────────────────────

interface Props {
  onClose: () => void;
  contextPhone?: string;
  contextName?: string;
}

export default function IntegrationQuickPanel({ onClose, contextPhone, contextName }: Props) {
  const { setView, pinnedIntegrationShortcuts, pinIntegrationShortcut, unpinIntegrationShortcut, integrationPanelTarget, setIntegrationPanelTarget } = useAppStore();
  const [integrations, setIntegrations] = useState<SavedIntegration[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);
  const [selectedIntegration, setSelectedIntegration] = useState<SavedIntegration | null>(null);
  const [selectedAction, setSelectedAction] = useState<QuickActionDef | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [resultMeta, setResultMeta] = useState<{ page: number; pageSize: number; total?: number; hasNext?: boolean } | null>(null);
  const [executedAction, setExecutedAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pin picker: stores `integrationId:action` key of which action's picker is open
  const [pinPickerKey, setPinPickerKey] = useState<string | null>(null);

  // Escape to close
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);

  // Load integrations
  useEffect(() => {
    if (DEV_MODE) {
      setIntegrations(FAKE_INTEGRATIONS);
      setSelectedIntegration(FAKE_INTEGRATIONS[0]);
      setLoadingIntegrations(false);
      return;
    }
    ipc.integration?.list().then(res => {
      if (res?.success) {
        const all = res.integrations || [];
        const connected = all.filter((i: any) => i.enabled && i.connectedAt);
        setIntegrations(connected);
        if (connected.length > 0) setSelectedIntegration(connected[0]);
      }
      setLoadingIntegrations(false);
    }).catch(() => setLoadingIntegrations(false));
  }, []);

  useEffect(() => {
    setSelectedAction(null); setParams({}); setResult(null); setResultMeta(null); setExecutedAction(null); setError(null);
  }, [selectedIntegration]);

  // ── Auto-navigate to target (from pinned shortcut click) ───────────────────
  useEffect(() => {
    if (!integrationPanelTarget || loadingIntegrations || !integrations.length) return;
    const intg = integrations.find(i => i.id === integrationPanelTarget.integrationId);
    if (intg) {
      setSelectedIntegration(intg);
      const actList = ACTIONS_BY_TYPE[intg.type] || [];
      const act = actList.find(a => a.action === integrationPanelTarget.action);
      if (act) setSelectedAction(act);
    }
    setIntegrationPanelTarget(null);
  }, [integrationPanelTarget, integrations, loadingIntegrations, setIntegrationPanelTarget]);

  useEffect(() => {
    if (!selectedAction) { setParams({}); return; }
    const pre: Record<string, string> = {};
    for (const f of selectedAction.fields) {
      if ((f.key === 'phone' || f.key === 'mobile') && contextPhone) pre[f.key] = contextPhone;
      else pre[f.key] = '';
    }
    setParams(pre);
    setResult(null); setResultMeta(null); setExecutedAction(null); setError(null);
  }, [selectedAction, contextPhone]);

  const getNestedError = useCallback((data: any, fallback: string): string | null => {
    if (!data || typeof data !== 'object') return null;
    if (data.success === false) return data.error || data.message || fallback;
    if (typeof data.error === 'string' && data.error.trim()) return data.error;
    return null;
  }, []);

  const buildDebugBlock = useCallback((action: string, actionParams: Record<string, any>, response?: any) => {
    if (!DEV_DEBUG || !selectedIntegration) return '';
    return `\n\n[DEBUG]\nIntegration: ${selectedIntegration.type}:${selectedIntegration.id}\nAction: ${action}\nParams: ${safeJson(actionParams)}\nResponse: ${safeJson(response)}`;
  }, [selectedIntegration]);

  const executeStrict = useCallback(async (action: string, actionParams: Record<string, any>, fallbackMessage: string) => {
    if (!selectedIntegration) throw new Error('Chua chon tich hop');

    const res = DEV_MODE
      ? await fakeExecute(selectedIntegration.id, action, actionParams)
      : await ipc.integration?.execute(selectedIntegration.id, action, actionParams);

    const nestedError = getNestedError(res?.data, fallbackMessage);
    if (DEV_DEBUG) {
      console.groupCollapsed(`[IntegrationQuickPanel] ${selectedIntegration.type}.${action}`);
      console.log('params:', actionParams);
      console.log('res:', res);
      if (nestedError) console.warn('nestedError:', nestedError);
      console.groupEnd();
    }
    if (!res?.success || nestedError) {
      const msg = res?.error || nestedError || fallbackMessage;
      throw new Error(msg + buildDebugBlock(action, actionParams, res));
    }

    return res;
  }, [selectedIntegration, getNestedError, buildDebugBlock]);

  const runAction = useCallback(async (pageOverride?: number) => {
    if (!selectedIntegration || !selectedAction) return;
    setExecuting(true);
    setResult(null);
    setError(null);

    try {
      const cleanParams: Record<string, any> = {};
      for (const f of selectedAction.fields) {
        const v = params[f.key] ?? '';
        if (v !== '') cleanParams[f.key] = f.type === 'number' ? Number(v) : v;
      }

      if (PAGED_ACTIONS.has(selectedAction.action)) {
        cleanParams.page = pageOverride ?? 1;
        cleanParams.limit = Number(cleanParams.limit ?? resultMeta?.pageSize ?? DEFAULT_PAGE_SIZE);
      }

      let actionToExecute = selectedAction.action;
      if (
        selectedIntegration.type === 'pancake' &&
        selectedAction.action === 'lookupProduct' &&
        !String(cleanParams.keyword ?? '').trim() &&
        !String(cleanParams.code ?? '').trim()
      ) {
        actionToExecute = 'getProducts';
      }

      const res = await executeStrict(actionToExecute, cleanParams, 'Thao tac that bai');
      if (DEV_DEBUG) {
        console.log('[IntegrationQuickPanel] execute success data:', res?.data);
      }
      setExecutedAction(actionToExecute);
      setResult(res?.data);
      setResultMeta(
        PAGED_ACTIONS.has(actionToExecute)
          ? getPagedResultMeta(res?.data || {}, cleanParams.page || 1, cleanParams.limit || DEFAULT_PAGE_SIZE)
          : null,
      );
    } catch (e: any) {
      const message = e?.message || 'Loi khong xac dinh';
      const debugBlock = DEV_DEBUG && selectedIntegration && selectedAction
        ? buildDebugBlock(selectedAction.action, params)
        : '';
      setResultMeta(null);
      setExecutedAction(null);
      setError(message.includes('[DEBUG]') ? message : message + debugBlock);
    }

    setExecuting(false);
  }, [selectedIntegration, selectedAction, params, resultMeta?.pageSize, executeStrict, buildDebugBlock]);

  const handleExecute = useCallback(async () => {
    await runAction(1);
  }, [runAction]);

  const handlePageChange = useCallback(async (nextPage: number) => {
    if (!selectedAction || !PAGED_ACTIONS.has(executedAction || selectedAction.action)) return;
    await runAction(Math.max(1, nextPage));
  }, [selectedAction, executedAction, runAction]);

  const handleBackToActions = useCallback(() => {
    setSelectedAction(null); setResult(null); setResultMeta(null); setExecutedAction(null); setError(null);
  }, []);

  const goToIntegrationPage = () => { onClose(); setView('integration'); };

  const actions = selectedIntegration ? (ACTIONS_BY_TYPE[selectedIntegration.type] || []) : [];
  const hasConnectedIntegrations = integrations.length > 0;
  const showSidebar = !selectedAction;

  return (
    <div className="h-full flex flex-col bg-gray-800 border-l border-gray-700 overflow-hidden" style={{ width: 330 }}>
        {/* ── Header ──────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700/60 flex-shrink-0 bg-gray-850">
          <div className="flex items-center gap-3">
            <span className="text-lg">🔌</span>
            <div>
              <p className="text-sm font-semibold text-white">Tích hợp nhanh</p>
              <p className="text-[11px] text-gray-500">
                {contextName ? <>Hội thoại: <span className="text-blue-400">{contextName}</span></> : 'Tra cứu đơn, sản phẩm, vận chuyển...'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={goToIntegrationPage}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-blue-400 transition-colors border border-gray-600"
              title="Mở trang cấu hình Tích hợp"
            >⚙️ Quản lý</button>
            <button onClick={onClose} className="text-gray-500 hover:text-blue-400 transition-colors p-1 rounded hover:bg-gray-700">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────── */}
        {loadingIntegrations ? (
          <div className="flex-1 flex items-center justify-center">
            <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        ) : !hasConnectedIntegrations ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gray-800 flex items-center justify-center text-3xl mb-4">🔌</div>
            <h3 className="text-base font-semibold text-white mb-2">Chưa có tích hợp nào được kết nối</h3>
            <p className="text-sm text-gray-400 max-w-sm mb-6 leading-relaxed">
              Hãy kết nối ít nhất một nền tảng (KiotViet, Haravan, GHN…) để sử dụng tính năng tra cứu nhanh tại đây.
            </p>
            <button
              onClick={goToIntegrationPage}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors"
            >
              🔌 Đi tới trang Tích hợp
            </button>
            <div className="mt-6 flex flex-wrap gap-2 justify-center">
              {Object.entries(TYPE_META).map(([type, meta]) => (
                <span key={type} className="flex items-center gap-1 px-2.5 py-1 bg-gray-800 rounded-lg text-xs text-gray-400 border border-gray-700/50">
                  <span className={`w-5 h-5 rounded ${meta.color} flex items-center justify-center text-[10px]`}>{meta.icon}</span>
                  {meta.name}
                </span>
              ))}
            </div>
          </div>
        ) : (
          /* ── Main layout — sidebar ẩn khi đã chọn action ──── */
          <div className="flex-1 flex min-h-0 overflow-hidden">

            {/* Left sidebar — icon-only compact list (ẩn khi đã chọn action) */}
            {showSidebar && (
              <div className="w-12 flex-shrink-0 border-r border-gray-700/60 bg-gray-900/80 flex flex-col items-center py-2 gap-1">
                {integrations.map(intg => {
                  const meta = TYPE_META[intg.type] || { icon: '🔌', color: 'bg-gray-600', name: intg.type };
                  const isActive = selectedIntegration?.id === intg.id;
                  return (
                    <div key={intg.id} className="relative">
                      <button
                        onClick={() => setSelectedIntegration(intg)}
                        title={intg.name}
                        className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg transition-all
                          ${isActive
                            ? `${meta.color} ring-2 ring-blue-400 ring-offset-1 ring-offset-gray-900`
                            : `${meta.color} opacity-60 hover:opacity-100`
                          }`}
                      >
                        {meta.icon}
                      </button>
                      {/* Green connected dot */}
                      <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-500 border-2 border-gray-900 block" />
                    </div>
                  );
                })}
                {/* Add integration */}
                <button
                  onClick={goToIntegrationPage}
                  title="Thêm tích hợp"
                  className="mt-auto w-9 h-9 rounded-xl flex items-center justify-center text-gray-600 hover:text-blue-400 hover:bg-gray-800 transition-colors text-lg"
                >
                  +
                </button>
              </div>
            )}

            {/* Right content — full width khi đã chọn action */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

              {/* ── Action grid (chưa chọn action) ─────────────── */}
              {selectedIntegration && !selectedAction && (
                <div className="flex-1 overflow-y-auto p-4">
                  <p className="text-xs text-gray-500 mb-3">
                    Chọn thao tác cho <span className="text-white font-medium">{selectedIntegration.name}</span>:
                  </p>
                  <div className="grid grid-cols-1 gap-2">
                    {actions.map(act => {
                      const pinKey = `${selectedIntegration.id}:${act.action}`;
                      const isPinned = pinnedIntegrationShortcuts.some(
                        s => s.integrationId === selectedIntegration.id && s.action === act.action
                      );
                      return (
                        <div key={act.action} className="relative group/act">
                          <button
                            onClick={() => setSelectedAction(act)}
                            className="w-full flex items-center gap-3 p-3 pr-10 rounded-xl bg-gray-800 hover:bg-gray-750 border border-gray-700/60 hover:border-blue-500/50 transition-all text-left"
                          >
                            <span className="text-xl flex-shrink-0">{act.icon}</span>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-200 group-hover/act:text-blue-400">{act.label}</p>
                              <p className="text-[11px] text-gray-500 leading-snug">{act.desc}</p>
                            </div>
                          </button>
                          {/* Pin button */}
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              if (isPinned) {
                                const s = pinnedIntegrationShortcuts.find(p => p.integrationId === selectedIntegration.id && p.action === act.action);
                                if (s) unpinIntegrationShortcut(s.id);
                              } else {
                                setPinPickerKey(pinKey);
                              }
                            }}
                            title={isPinned ? 'Gỡ ghim khỏi toolbar' : 'Ghim ra thanh toolbar'}
                            className={`absolute top-1/2 -translate-y-1/2 right-2.5 w-7 h-7 rounded-lg flex items-center justify-center text-sm transition-all
                              ${isPinned
                                ? 'text-yellow-400 bg-yellow-400/10 hover:bg-red-500/15 hover:text-red-400'
                                : 'text-gray-600 hover:text-yellow-400 hover:bg-yellow-400/10 opacity-0 group-hover/act:opacity-100'}`}
                          >
                            {isPinned ? '📌' : '📍'}
                          </button>
                          {/* Icon picker */}
                          {pinPickerKey === pinKey && (
                            <PinIconPicker
                              onSelect={icon => {
                                pinIntegrationShortcut({
                                  integrationId: selectedIntegration.id,
                                  integrationType: selectedIntegration.type,
                                  integrationName: selectedIntegration.name,
                                  action: act.action,
                                  actionLabel: act.label,
                                  icon,
                                });
                                setPinPickerKey(null);
                              }}
                              onClose={() => setPinPickerKey(null)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!actions.length && (
                    <p className="text-sm text-gray-500 text-center py-10">Chưa có thao tác nào cho {selectedIntegration.name}</p>
                  )}
                </div>
              )}

              {/* ── POS Order Creation Panel ────────────────────── */}
              {selectedIntegration && selectedAction && selectedAction.action === 'createOrder' && (
                <POSOrderPanel
                  integrationId={selectedIntegration.id}
                  integrationType={selectedIntegration.type}
                  integrationName={selectedIntegration.name}
                  onBack={handleBackToActions}
                  onExecuteSearch={async (action, searchParams) => {
                    return executeStrict(action, searchParams, 'Tra cuu san pham that bai');
                  }}
                  onSubmitOrder={async (orderData) => {
                    return executeStrict('createOrder', orderData, 'Tao don that bai');
                  }}
                  contextPhone={contextPhone}
                  contextName={contextName}
                />
              )}

              {/* ── Generic action execution form ──────────────── */}
              {selectedIntegration && selectedAction && selectedAction.action !== 'createOrder' && (
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {/* Back + action header */}
                  <div className="flex items-center gap-2">
                    <button onClick={handleBackToActions}
                      className="text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-gray-800">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="15 18 9 12 15 6"/>
                      </svg>
                    </button>
                    <div className="min-w-0 flex-1">
                      <span className="text-base font-semibold text-white">{selectedAction.icon} {selectedAction.label}</span>
                      <span className="text-[10px] text-gray-500 ml-2">({selectedIntegration.name})</span>
                    </div>
                    {/* Pin button in detail view */}
                    <div className="relative flex-shrink-0">
                      {(() => {
                        const detailPinKey = `${selectedIntegration.id}:${selectedAction.action}:detail`;
                        const isPinned = pinnedIntegrationShortcuts.some(
                          s => s.integrationId === selectedIntegration.id && s.action === selectedAction.action
                        );
                        return (
                          <>
                            <button
                              onClick={() => {
                                if (isPinned) {
                                  const s = pinnedIntegrationShortcuts.find(p => p.integrationId === selectedIntegration.id && p.action === selectedAction.action);
                                  if (s) unpinIntegrationShortcut(s.id);
                                } else {
                                  setPinPickerKey(detailPinKey);
                                }
                              }}
                              title={isPinned ? 'Gỡ ghim khỏi toolbar' : 'Ghim tính năng này ra thanh toolbar'}
                              className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm transition-colors
                                ${isPinned ? 'text-yellow-400 bg-yellow-400/10 hover:bg-red-500/15 hover:text-red-400' : 'text-gray-500 hover:text-yellow-400 hover:bg-yellow-400/10'}`}
                            >
                              {isPinned ? '📌' : '📍'}
                            </button>
                            {pinPickerKey === detailPinKey && (
                              <PinIconPicker
                                onSelect={icon => {
                                  pinIntegrationShortcut({
                                    integrationId: selectedIntegration.id,
                                    integrationType: selectedIntegration.type,
                                    integrationName: selectedIntegration.name,
                                    action: selectedAction.action,
                                    actionLabel: selectedAction.label,
                                    icon,
                                  });
                                  setPinPickerKey(null);
                                }}
                                onClose={() => setPinPickerKey(null)}
                              />
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Param fields */}
                  <div className="space-y-3">
                    {selectedAction.fields.map(field => (
                      <div key={field.key}>
                        <label className="block text-xs text-gray-400 mb-1.5 font-medium">
                          {field.label}
                          {field.optional && <span className="text-gray-600 font-normal ml-1">(tùy chọn)</span>}
                        </label>
                        {field.type === 'select' ? (
                          <select
                            value={params[field.key] || ''}
                            onChange={e => setParams(p => ({ ...p, [field.key]: e.target.value }))}
                            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                          >
                            {field.options?.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                          </select>
                        ) : (
                          <input
                            type={field.type === 'number' ? 'number' : 'text'}
                            value={params[field.key] || ''}
                            onChange={e => setParams(p => ({ ...p, [field.key]: e.target.value }))}
                            placeholder={field.placeholder}
                            onKeyDown={e => { if (e.key === 'Enter') handleExecute(); }}
                            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                            autoFocus={selectedAction.fields.indexOf(field) === 0}
                          />
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Execute */}
                  <button onClick={handleExecute} disabled={executing}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors">
                    {executing ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                        </svg>
                        Đang thực hiện...
                      </span>
                    ) : `${selectedAction.icon} Thực hiện`}
                  </button>

                  {/* Error */}
                  {error && (
                    <div className="bg-red-900/30 border border-red-700/50 rounded-xl px-4 py-3">
                      <p className="text-xs text-red-300">❌ {error}</p>
                    </div>
                  )}

                  {/* Result */}
                  {result !== null && !error && (
                    <div>
                      <p className="text-xs text-gray-500 mb-2 font-medium">📊 Kết quả:</p>
                      {formatResult(selectedAction.action, result)}
                      {resultMeta && PAGED_ACTIONS.has(executedAction || selectedAction.action) && (
                        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-gray-400">
                          <button
                            onClick={() => handlePageChange(resultMeta.page - 1)}
                            disabled={executing || resultMeta.page <= 1}
                            className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 disabled:opacity-40 hover:border-blue-500/40"
                          >
                            ← Trang trước
                          </button>
                          <span>
                            Trang {resultMeta.page}
                            {typeof resultMeta.total === 'number' ? ` · Tổng ~ ${resultMeta.total}` : ''}
                          </span>
                          <button
                            onClick={() => handlePageChange(resultMeta.page + 1)}
                            disabled={executing || !resultMeta.hasNext}
                            className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 disabled:opacity-40 hover:border-blue-500/40"
                          >
                            Trang sau →
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!selectedIntegration && (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-gray-500">← Chọn một tích hợp</p>
                </div>
              )}
            </div>
          </div>
        )}
    </div>
  );
}

