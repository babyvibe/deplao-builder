import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import {
  getProvinces, getDistricts, getWards,
  getProvinceName, getDistrictName, getWardName,
  type Division,
} from './vnDivisions';
import { adaptOrderForPlatform, type GenericOrderData } from './platformOrderAdapters';
import { IS_DEV_BUILD } from '../../../configs/BuildConfig';

/**
 * POSOrderPanel — Giao diện tạo đơn hàng POS đầy đủ
 * Flow mới: 1 màn hình duy nhất
 * - Thông tin khách + địa chỉ là bắt buộc
 * - Chọn sản phẩm, chỉnh giỏ hàng, phí/ghi chú và submit ngay trên cùng màn hình
 * - Dữ liệu tỉnh/huyện/xã lấy từ hanhchinhVN qua `vnDivisions`
 */

export interface POSProduct {
  id: string;
  code: string;
  name: string;
  basePrice: number;
  onHand: number;
  image?: string;
}

export interface CartItem {
  product: POSProduct;
  quantity: number;
  price: number;
  discount: number;
}

interface Props {
  integrationId: string;
  integrationType: string;
  integrationName: string;
  onBack: () => void;
  onExecuteSearch: (action: string, params: Record<string, any>) => Promise<any>;
  onSubmitOrder: (orderData: any) => Promise<any>;
  contextPhone?: string;
  contextName?: string;
}

function normalizePhoneDisplay(phone: string | undefined | null): string {
  if (!phone) return '';
  const digits = phone.startsWith('+') ? phone.slice(1) : phone;
  if (digits.startsWith('84') && digits.length >= 11) return '0' + digits.slice(2);
  return phone;
}

function formatVND(n: number): string {
  return n.toLocaleString('vi-VN') + 'đ';
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

function normalizeProduct(raw: any, platform: string): POSProduct {
  const nestedProduct = raw?.product_info || raw?.product || raw?.item || {};

  let image: string;
  if (platform === 'kiotviet') {
    image = raw.images?.[0]?.url || raw.image || '';
  } else if (platform === 'haravan') {
    image = raw.image?.src || raw.images?.[0]?.src || raw.featured_image || '';
  } else if (platform === 'sapo') {
    image = raw.image?.src || raw.images?.[0]?.src || '';
  } else if (platform === 'ipos') {
    image = raw.image_url || raw.image || raw.thumbnail || '';
  } else if (platform === 'nhanh') {
    image = raw.images?.avatar || raw.image || raw.imageUrl || raw.smallImage || raw.images?.[0] || '';
  } else if (platform === 'pancake') {
    image = firstNonEmptyString(
      raw.image,
      raw.image_url,
      raw.imageUrl,
      raw.avatar,
      raw.images?.[0]?.url,
      raw.images?.[0]?.src,
      raw.images?.[0],
      nestedProduct.image,
      nestedProduct.image_url,
      nestedProduct.imageUrl,
      nestedProduct.avatar,
      nestedProduct.images?.[0]?.url,
      nestedProduct.images?.[0]?.src,
      nestedProduct.images?.[0],
    );
  } else {
    image = raw.image || raw.image_url || raw.imageUrl || raw.thumbnail || '';
  }

  const basePrice = firstFiniteNumber(
    raw.prices?.retail,          // Nhanh.vn: prices.retail
    raw.basePrice,
    raw.price,
    raw.retailPrice,
    raw.retail_price,
    raw.final_price,
    raw.sale_price,
    raw.variants?.[0]?.price,
    nestedProduct.basePrice,
    nestedProduct.price,
    nestedProduct.retail_price,
    nestedProduct.retailPrice,
  );
  const onHand = firstFiniteNumber(
    raw.inventory?.remain,       // Nhanh.vn: inventory.remain
    raw.onHand,
    raw.inventory_quantity,
    raw.stock,
    raw.remaining,
    raw.quantity,
    raw.available,
    raw.inventory,
    raw.total_on_hand,
    nestedProduct.onHand,
    nestedProduct.inventory_quantity,
    nestedProduct.stock,
    nestedProduct.remaining,
  );

  const id = firstNonEmptyString(
    raw.variation_id,
    raw.id,
    raw.productId,
    raw.product_id,
    raw.item_id,
    raw.sku,
    raw.code,
    raw.barcode,
  );
  const code = firstNonEmptyString(
    raw.code,
    raw.sku,
    raw.barcode,
    raw.productCode,
    raw.display_id,
    nestedProduct.code,
    nestedProduct.sku,
    id,
  );
  const name = firstNonEmptyString(
    raw.name,
    raw.fullName,
    raw.title,
    raw.productName,
    raw.product_name,
    raw.variation_name,
    nestedProduct.name,
    nestedProduct.fullName,
    nestedProduct.title,
    code,
  );

  return {
    id,
    code,
    name,
    basePrice,
    onHand,
    image,
  };
}

export default function POSOrderPanel({
  integrationId,
  integrationType,
  integrationName,
  onBack,
  onExecuteSearch,
  onSubmitOrder,
  contextPhone,
  contextName,
}: Props) {
  const DEV_DEBUG = IS_DEV_BUILD;

  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<POSProduct[]>([]);
  const [searchPage, setSearchPage] = useState(1);
  const [searchMeta, setSearchMeta] = useState<{ page: number; pageSize: number; total?: number; hasNext?: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [defaultBranchId, setDefaultBranchId] = useState<string>('');

  const [custName, setCustName] = useState(contextName || '');
  const [custPhone, setCustPhone] = useState(normalizePhoneDisplay(contextPhone) || '');
  const [custEmail, setCustEmail] = useState('');
  const [custAddress, setCustAddress] = useState('');
  const [provinceId, setProvinceId] = useState('');
  const [districtId, setDistrictId] = useState('');
  const [wardId, setWardId] = useState('');
  const [provinces, setProvinces] = useState<Division[]>(() => getProvinces());
  const [districts, setDistricts] = useState<Division[]>([]);
  const [wards, setWards] = useState<Division[]>([]);

  const [note, setNote] = useState('');
  const [orderDiscount, setOrderDiscount] = useState(0);
  const [shippingFee, setShippingFee] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('cod');
  const [submitting, setSubmitting] = useState(false);
  const [orderResult, setOrderResult] = useState<any>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);

  useEffect(() => {
    let active = true;

    const loadInitialData = async () => {
      if (integrationId) {
        try {
          const integrationRes = await ipc.integration?.get(integrationId);
          const branchId = integrationRes?.integration?.settings?.defaultBranchId;
          if (active && branchId != null && String(branchId).trim() !== '') {
            setDefaultBranchId(String(branchId));
          }
        } catch {
          // keep silent — branch remains optional
        }
      }
      if (active) setProvinces(getProvinces());
    };

    loadInitialData();
    return () => { active = false; };
  }, [integrationId]);

  useEffect(() => {
    let active = true;
    setDistrictId('');
    setWardId('');
    setWards([]);

    if (!provinceId) {
      setDistricts([]);
      return () => { active = false; };
    }

    if (active) setDistricts(getDistricts(provinceId));
    return () => { active = false; };
  }, [provinceId]);

  useEffect(() => {
    let active = true;
    setWardId('');

    if (!districtId) {
      setWards([]);
      return () => { active = false; };
    }

    if (active) setWards(getWards(provinceId, districtId));
    return () => { active = false; };
  }, [districtId, provinceId]);

  const selectedProvinceName = useMemo(() => {
    return provinces.find(p => p.id === provinceId)?.name || getProvinceName(provinceId);
  }, [provinces, provinceId]);

  const selectedDistrictName = useMemo(() => {
    return districts.find(d => d.id === districtId)?.name || getDistrictName(provinceId, districtId);
  }, [districts, districtId, provinceId]);

  const selectedWardName = useMemo(() => {
    return wards.find(w => w.id === wardId)?.name || getWardName(provinceId, districtId, wardId);
  }, [wards, wardId, provinceId, districtId]);

  const trimmedSearchQuery = searchQuery.trim();
  const isBrowsingAllProducts = trimmedSearchQuery.length === 0;

  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return searchResults;
    const q = searchQuery.toLowerCase();
    return searchResults.filter(
      p => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q),
    );
  }, [searchQuery, searchResults]);

  const handleSearch = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const query = searchQuery.trim();
      const pageSize = 20;
      const preferredAction = query ? 'lookupProduct' : 'getProducts';
      const preferredParams = query
        ? { keyword: query, limit: pageSize, page: searchPage }
        : { limit: pageSize, page: searchPage };

      let res: any;
      if (preferredAction === 'getProducts') {
        try {
          res = await onExecuteSearch(preferredAction, preferredParams);
        } catch {
          res = await onExecuteSearch('lookupProduct', { keyword: '', limit: pageSize, page: searchPage });
        }
      } else {
        res = await onExecuteSearch(preferredAction, preferredParams);
      }

      if (DEV_DEBUG) {
        console.groupCollapsed(`[POSOrderPanel] ${preferredAction} (${integrationType})`);
        console.log('query:', query);
        console.log('page:', searchPage);
        console.log('res:', res);
        console.groupEnd();
      }

      const rawData = res?.data ?? res;
      const rawProducts: any[] | null = rawData?.products ?? rawData?.data ?? res?.products ?? null;
      if (Array.isArray(rawProducts)) {
        const page = Number(rawData?.page ?? res?.page ?? searchPage);
        const resolvedPageSize = Number(rawData?.pageSize ?? res?.pageSize ?? pageSize);
        const totalRaw = rawData?.total ?? res?.total;
        const total = totalRaw === '' || totalRaw == null ? undefined : Number(totalRaw);
        const backendHasNext = rawData?.hasNext ?? res?.hasNext;
        const inferredHasNext = typeof backendHasNext === 'boolean'
          ? Boolean(backendHasNext)
          : rawProducts.length >= resolvedPageSize && rawProducts.length > 0;

        setSearchResults(rawProducts.map(p => normalizeProduct(p, integrationType)));
        setSearchMeta({
          page,
          pageSize: resolvedPageSize,
          total: Number.isFinite(total as number) ? total : undefined,
          hasNext: inferredHasNext,
        });
      } else {
        setSearchResults([]);
        setSearchMeta(null);
      }
    } catch (e: any) {
      const msg = e?.message || 'Tra cuu san pham that bai';
      if (DEV_DEBUG) console.error('[POSOrderPanel] lookupProduct error:', e);
      setSearchError(msg);
      setSearchResults([]);
      setSearchMeta(null);
    }
    setSearching(false);
  }, [searchQuery, searchPage, onExecuteSearch, integrationType, DEV_DEBUG]);

  useEffect(() => {
    setSearchPage(1);
  }, [searchQuery]);

  useEffect(() => {
    const t = setTimeout(handleSearch, 400);
    return () => clearTimeout(t);
  }, [handleSearch]);

  const addToCart = useCallback((product: POSProduct) => {
    setCart(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item =>
          item.product.id === product.id
            ? { ...item, quantity: Math.min(item.quantity + 1, Math.max(product.onHand, item.quantity + 1)) }
            : item,
        );
      }
      return [...prev, { product, quantity: 1, price: product.basePrice, discount: 0 }];
    });
  }, []);

  const updateQuantity = useCallback((productId: string, delta: number) => {
    setCart(prev =>
      prev
        .map(item => {
          if (item.product.id !== productId) return item;
          const maxQty = item.product.onHand > 0 ? item.product.onHand : item.quantity + Math.max(delta, 0);
          return { ...item, quantity: Math.max(0, Math.min(item.quantity + delta, maxQty)) };
        })
        .filter(item => item.quantity > 0),
    );
  }, []);

  const updateItemPrice = useCallback((productId: string, price: number) => {
    setCart(prev => prev.map(item =>
      item.product.id === productId ? { ...item, price: Math.max(0, price) } : item,
    ));
  }, []);

  const removeFromCart = useCallback((productId: string) => {
    setCart(prev => prev.filter(item => item.product.id !== productId));
  }, []);

  const clearAll = useCallback(() => {
    setCart([]);
    setCustName(contextName || '');
    setCustPhone(normalizePhoneDisplay(contextPhone) || '');
    setCustEmail('');
    setCustAddress('');
    setProvinceId('');
    setDistrictId('');
    setWardId('');
    setNote('');
    setOrderDiscount(0);
    setShippingFee(0);
    setPaymentMethod('cod');
    setOrderResult(null);
    setOrderError(null);
    setShowValidation(false);
  }, [contextPhone, contextName]);

  const totalItems = useMemo(() => cart.reduce((s, i) => s + i.quantity, 0), [cart]);
  const subtotal = useMemo(() => cart.reduce((s, i) => s + i.price * i.quantity - i.discount, 0), [cart]);
  const grandTotal = useMemo(() => Math.max(0, subtotal - orderDiscount + shippingFee), [subtotal, orderDiscount, shippingFee]);

  const displayAddress = useMemo(() => {
    return [custAddress, selectedWardName, selectedDistrictName, selectedProvinceName].filter(Boolean).join(', ');
  }, [custAddress, selectedWardName, selectedDistrictName, selectedProvinceName]);

  const missingRequiredFields = useMemo(() => {
    const missing: string[] = [];
    if (!custName.trim()) missing.push('Tên khách hàng');
    if (!custPhone.trim()) missing.push('Số điện thoại');
    if (!provinceId) missing.push('Tỉnh/Thành phố');
    if (!districtId) missing.push('Quận/Huyện');
    if (!wardId) missing.push('Phường/Xã');
    if (!custAddress.trim()) missing.push('Số nhà, tên đường');
    return missing;
  }, [custName, custPhone, provinceId, districtId, wardId, custAddress]);

  const canSubmitOrder = missingRequiredFields.length === 0 && cart.length > 0;

  const handleSubmitOrder = useCallback(async () => {
    setShowValidation(true);
    if (!canSubmitOrder) {
      if (cart.length === 0) {
        setOrderError('Vui lòng chọn ít nhất 1 sản phẩm trước khi tạo đơn');
      } else {
        setOrderError(`Vui lòng nhập đầy đủ: ${missingRequiredFields.join(', ')}`);
      }
      return;
    }

    setSubmitting(true);
    setOrderError(null);
    setOrderResult(null);
    try {
      const generic: GenericOrderData = {
        customer: {
          name: custName || 'Khách vãng lai',
          phone: custPhone,
          email: custEmail,
          provinceId,
          districtId,
          wardId,
          provinceName: selectedProvinceName,
          districtName: selectedDistrictName,
          wardName: selectedWardName,
          address: custAddress,
        },
        branchId: defaultBranchId || undefined,
        items: cart.map(item => ({
          productId: item.product.id,
          productCode: item.product.code,
          productName: item.product.name,
          quantity: item.quantity,
          price: item.price,
          discount: item.discount,
        })),
        discount: orderDiscount,
        shippingFee,
        totalPayment: grandTotal,
        paymentMethod,
        note,
      };

      const platformData = adaptOrderForPlatform(integrationType, generic);
      if (DEV_DEBUG) {
        console.groupCollapsed(`[POSOrderPanel] createOrder (${integrationType})`);
        console.log('payload:', platformData);
        console.groupEnd();
      }

      const res = await onSubmitOrder(platformData);
      if (DEV_DEBUG) {
        console.groupCollapsed(`[POSOrderPanel] createOrder response (${integrationType})`);
        console.log('res:', res);
        console.groupEnd();
      }

      if (res?.success) {
        setOrderResult(res.data || res);
      } else {
        setOrderError(res?.error || 'Tạo đơn thất bại');
      }
    } catch (e: any) {
      setOrderError(e?.message || 'Lỗi không xác định');
    }
    setSubmitting(false);
  }, [canSubmitOrder, cart, custName, custPhone, custEmail, provinceId, districtId, wardId, selectedProvinceName, selectedDistrictName, selectedWardName, custAddress, defaultBranchId, orderDiscount, shippingFee, grandTotal, paymentMethod, note, integrationType, onSubmitOrder, DEV_DEBUG, missingRequiredFields]);

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors';
  const selectCls = inputCls + ' appearance-none';
  const labelCls = 'block text-xs text-gray-400 mb-1 font-medium';

  if (orderResult) {
    return (
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 flex-shrink-0 border-b border-gray-700/60">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-gray-800" title="Quay lại">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <div className="min-w-0 flex-1">
            <span className="text-sm font-semibold text-white">✏️ Tạo đơn hàng</span>
            <span className="text-[10px] text-gray-500 ml-2">({integrationName})</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
            <div className="w-14 h-14 rounded-full bg-green-900/30 flex items-center justify-center text-2xl mb-3 border border-green-700/40">✅</div>
            <h3 className="text-base font-semibold text-green-300 mb-1">Tạo đơn thành công!</h3>
            <p className="text-sm text-gray-400 mb-1">Mã đơn: <span className="text-white font-mono font-bold">{orderResult.order?.code || orderResult.order?.id || 'N/A'}</span></p>
            <p className="text-[10px] text-gray-500 mb-1">Nền tảng: {integrationName} ({integrationType})</p>
            <p className="text-sm text-blue-300 font-semibold mb-4">{formatVND(grandTotal)}</p>
            <div className="flex gap-2">
              <button onClick={clearAll} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors">✏️ Tạo đơn mới</button>
              <button onClick={onBack} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm font-medium rounded-xl transition-colors">← Quay lại</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 flex-shrink-0 border-b border-gray-700/60">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-gray-800" title="Quay lại">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-white">✏️ Tạo đơn hàng</span>
          <span className="text-[10px] text-gray-500 ml-2">({integrationName})</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div className="bg-gray-800 rounded-xl border border-gray-700/60 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">👤 Thông tin khách hàng & địa chỉ</p>
              <p className="text-[11px] text-gray-500 mt-1">Tên, số điện thoại và địa chỉ giao hàng là bắt buộc.</p>
            </div>
          </div>

          {showValidation && missingRequiredFields.length > 0 && (
            <div className="bg-red-900/20 border border-red-700/40 rounded-lg px-3 py-2">
              <p className="text-[11px] text-red-300">❌ Thiếu thông tin: {missingRequiredFields.join(', ')}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Tên khách hàng <span className="text-red-400">*</span></label>
              <input value={custName} onChange={e => setCustName(e.target.value)} placeholder="Nguyễn Văn A" className={inputCls} autoFocus />
            </div>
            <div>
              <label className={labelCls}>Số điện thoại <span className="text-red-400">*</span></label>
              <input value={custPhone} onChange={e => setCustPhone(e.target.value)} placeholder="0901234567" className={inputCls} type="tel" />
            </div>
          </div>

          <div>
            <label className={labelCls}>Tỉnh/Thành phố <span className="text-red-400">*</span></label>
            <select value={provinceId} onChange={e => setProvinceId(e.target.value)} className={selectCls}>
              <option value="">— Tỉnh/Thành —</option>
              {provinces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Quận/Huyện <span className="text-red-400">*</span></label>
              <select value={districtId} onChange={e => setDistrictId(e.target.value)} className={selectCls} disabled={!provinceId}>
                <option value="">— Quận/Huyện —</option>
                {districts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Phường/Xã <span className="text-red-400">*</span></label>
              <select value={wardId} onChange={e => setWardId(e.target.value)} className={selectCls} disabled={!districtId}>
                <option value="">— Phường/Xã —</option>
                {wards.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Số nhà, tên đường <span className="text-red-400">*</span></label>
            <input value={custAddress} onChange={e => setCustAddress(e.target.value)} placeholder="123 Lê Lợi" className={inputCls} />
          </div>

          {displayAddress && (
            <div className="bg-gray-900/50 rounded-lg px-3 py-2 border border-gray-700/40">
              <p className="text-[10px] text-gray-500 mb-0.5">📍 Địa chỉ đầy đủ:</p>
              <p className="text-xs text-blue-300">{displayAddress}</p>
            </div>
          )}
        </div>

        <div className="bg-gray-800 rounded-xl border border-gray-700/60 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">📦 Sản phẩm & giỏ hàng
                <span className="text-[10px] px-2 py-1 ml-2 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">{totalItems}</span>
              </p>
              <p className="text-[11px] text-gray-500 mt-1">Toàn bộ thao tác chọn sản phẩm nằm trên cùng một màn hình.</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="relative">
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Tìm sản phẩm theo tên hoặc mã..."
                className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors" />
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
              {searching && (
                <svg className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              )}
            </div>
            <p className="text-[10px] text-gray-500">
              {isBrowsingAllProducts
                ? 'Đang hiển thị danh sách toàn bộ sản phẩm. Dùng nút phân trang bên dưới để xem thêm.'
                : `Đang lọc theo từ khoá: “${trimmedSearchQuery}”`}
            </p>
          </div>

          {searchError && (
            <div className="bg-red-900/30 border border-red-700/50 rounded-xl px-3 py-2">
              <p className="text-[11px] text-red-300">❌ {searchError}</p>
            </div>
          )}

          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {filteredProducts.length === 0 ? (
              <div className="text-center py-8"><p className="text-sm text-gray-500">Không tìm thấy sản phẩm</p></div>
            ) : filteredProducts.map(product => {
              const inCart = cart.find(i => i.product.id === product.id);
              return (
                <div key={product.id} onClick={() => addToCart(product)}
                  className={`flex items-center gap-2.5 p-2 rounded-xl border transition-all cursor-pointer group ${
                    inCart ? 'bg-blue-600/10 border-blue-500/30' : 'bg-gray-900 border-gray-700/60 hover:border-blue-500/40'}`}>
                  <div className="w-10 h-10 rounded-lg bg-gray-700 flex items-center justify-center text-base flex-shrink-0 overflow-hidden border border-gray-600/40">
                    {product.image
                      ? <img src={product.image} alt={product.name} className="w-full h-full object-cover"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.textContent = '📦'; }} />
                      : <span>📦</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white truncate group-hover:text-blue-300">{product.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-gray-500">{product.code}</span>
                      <span className="text-[10px] text-gray-600">·</span>
                      <span className={`text-[10px] ${product.onHand > 0 ? 'text-green-500' : 'text-red-400'}`}>Kho: {product.onHand}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs font-semibold text-blue-300">{formatVND(product.basePrice)}</p>
                    {inCart && <span className="text-[10px] font-bold text-blue-400 bg-blue-600/20 px-1 py-0.5 rounded-full">x{inCart.quantity}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {searchMeta && (searchPage > 1 || searchMeta.hasNext) && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
              <button
                onClick={() => setSearchPage(p => Math.max(1, p - 1))}
                disabled={searchPage <= 1 || searching}
                className="px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 disabled:opacity-40 hover:border-blue-500/40"
              >
                ← Trang trước
              </button>
              <span>
                Trang {searchMeta.page}
                {typeof searchMeta.total === 'number' ? ` · Tổng ~ ${searchMeta.total}` : ''}
              </span>
              <button
                onClick={() => setSearchPage(p => p + 1)}
                disabled={!searchMeta.hasNext || searching}
                className="px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 disabled:opacity-40 hover:border-blue-500/40"
              >
                Trang sau →
              </button>
            </div>
          )}

          {cart.length > 0 && (
            <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/40">
                <p className="text-xs font-semibold text-gray-400">🛒 Giỏ hàng ({totalItems})</p>
                <span className="text-xs font-bold text-blue-300">{formatVND(subtotal)}</span>
              </div>
              <div className="max-h-56 overflow-y-auto divide-y divide-gray-700/30">
                {cart.map(item => (
                  <div key={item.product.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="w-8 h-8 rounded bg-gray-700 flex items-center justify-center text-xs flex-shrink-0 overflow-hidden border border-gray-600/30">
                      {item.product.image
                        ? <img src={item.product.image} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                        : '📦'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{item.product.name}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <div className="flex items-center bg-gray-950 rounded border border-gray-700">
                          <button onClick={() => updateQuantity(item.product.id, -1)} className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-white text-[11px] font-bold">−</button>
                          <span className="w-5 text-center text-[11px] text-white font-semibold">{item.quantity}</span>
                          <button onClick={() => updateQuantity(item.product.id, 1)} disabled={item.product.onHand > 0 && item.quantity >= item.product.onHand}
                            className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-white text-[11px] font-bold disabled:opacity-30">+</button>
                        </div>
                        <span className="text-[10px] text-gray-500">×</span>
                        <input type="number" value={item.price} onChange={e => updateItemPrice(item.product.id, Number(e.target.value))}
                          className="w-20 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-white text-right focus:outline-none focus:border-blue-500" />
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-medium text-blue-300">{formatVND(item.price * item.quantity)}</p>
                      <button onClick={() => removeFromCart(item.product.id)} className="text-[10px] text-gray-600 hover:text-red-400 transition-colors mt-0.5">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="bg-gray-800 rounded-xl border border-gray-700/60 p-4 space-y-3">
          <p className="text-sm font-semibold text-white">⚙️ Thanh toán & ghi chú</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>🚚 Phí vận chuyển</label>
              <div className="flex items-center gap-1">
                <input type="number" value={shippingFee || ''} onChange={e => setShippingFee(Math.max(0, Number(e.target.value)))} placeholder="0" className={inputCls + ' text-right'} />
                <span className="text-[10px] text-gray-500">đ</span>
              </div>
            </div>
            <div>
              <label className={labelCls}>🏷️ Giảm giá đơn</label>
              <div className="flex items-center gap-1">
                <input type="number" value={orderDiscount || ''} onChange={e => setOrderDiscount(Math.max(0, Number(e.target.value)))} placeholder="0" className={inputCls + ' text-right text-orange-400'} />
                <span className="text-[10px] text-gray-500">đ</span>
              </div>
            </div>
          </div>
          <div>
            <label className={labelCls}>💳 Phương thức thanh toán</label>
            <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className={selectCls}>
              <option value="cod">COD – Thanh toán khi nhận hàng</option>
              <option value="bank_transfer">Chuyển khoản ngân hàng</option>
              <option value="cash">Tiền mặt tại cửa hàng</option>
              <option value="card">Thẻ (VISA/Master)</option>
              <option value="momo">Ví MoMo</option>
              <option value="zalopay">ZaloPay</option>
              <option value="vnpay">VNPay</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>📝 Ghi chú</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Ghi chú cho đơn hàng..." rows={2} className={inputCls + ' resize-none'} />
          </div>
        </div>

        <div className="bg-gray-800/80 rounded-xl border border-gray-700/60 px-4 py-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">✅ Xác nhận đơn hàng</p>
            <span className="text-[10px] px-2 py-1 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">{integrationName}</span>
          </div>
          <div className="text-xs text-gray-400 space-y-1">
            <p>👤 {custName || '—'} {custPhone ? `· ${custPhone}` : ''}</p>
            <p>📍 {displayAddress || 'Chưa có địa chỉ đầy đủ'}</p>
            <p>📦 {totalItems} sản phẩm trong giỏ</p>
          </div>
          <div className="space-y-1 border-t border-gray-700/40 pt-2">
            <div className="flex justify-between text-xs"><span className="text-gray-500">Tạm tính ({totalItems} SP):</span><span className="text-gray-300">{formatVND(subtotal)}</span></div>
            {shippingFee > 0 && <div className="flex justify-between text-xs"><span className="text-gray-500">Phí vận chuyển:</span><span className="text-gray-300">+{formatVND(shippingFee)}</span></div>}
            {orderDiscount > 0 && <div className="flex justify-between text-xs"><span className="text-orange-400">Giảm giá:</span><span className="text-orange-400">-{formatVND(orderDiscount)}</span></div>}
            <div className="flex justify-between text-sm font-semibold pt-1 border-t border-gray-700/40">
              <span className="text-white">💰 Tổng thanh toán:</span><span className="text-blue-300">{formatVND(grandTotal)}</span>
            </div>
          </div>

          {orderError && (
            <div className="bg-red-900/30 border border-red-700/50 rounded-xl px-4 py-3">
              <p className="text-xs text-red-300">❌ {orderError}</p>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={handleSubmitOrder} disabled={submitting || !canSubmitOrder}
              className="flex-1 py-3 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors">
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  Đang tạo đơn...
                </span>
              ) : `✅ Tạo đơn hàng · ${formatVND(grandTotal)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
