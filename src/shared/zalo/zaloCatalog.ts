/**
 * zaloCatalog.ts: Zalo Business product catalog (ZL-04, SRS Deplao): pure part shared by main + renderer + API.
 *
 * zca-js 2.2.0: getCatalogList / createCatalog / updateCatalog / deleteCatalog, getProductCatalogList /
 * createProductCatalog / updateProductCatalog / deleteProductCatalog (endpoint mdelete), uploadProductPhoto.
 * A zca-js bug: createProductCatalog / updateProductCatalog only upload `files` when files.length == 0, so photos are ignored;
 * Deplao always uploads photos with uploadProductPhoto and then passes product_photos (up to 5 URLs). Currency is fixed to "₫".
 */

import { tr, appLocale } from '../i18n';

export const ZALO_CATALOG_BASE_URL = 'https://catalog.zalo.me/';
export const ZALO_PRODUCT_MAX_PHOTOS = 5;
/** Sending several products at once: at least 2 s apart. */
export const ZALO_PRODUCT_SEND_GAP_MS = 2000;
export const ZALO_PRODUCT_NAME_MAX = 200;
export const ZALO_PRODUCT_DESCRIPTION_MAX = 2000;

export interface ZaloCatalog {
  id: string;
  name: string;
  isDefault: boolean;
  path: string;
  url: string;
  totalProduct: number;
  photo: string;
  createdAt: number;
}

export interface ZaloProduct {
  id: string;
  catalogId: string;
  name: string;
  /** Price as a numeric string, as Zalo stores it (e.g. "150000"). */
  price: string;
  currency: string;
  description: string;
  photos: string[];
  path: string;
  url: string;
  createdAt: number;
}

/** catalog.zalo.me link for a catalog / product (Zalo's relative path; a full URL is kept as is). */
export function zaloCatalogUrl(path: unknown): string {
  const value = String(path ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return ZALO_CATALOG_BASE_URL + value.replace(/^\/+/, '');
}

export function mapZaloCatalog(item: any): ZaloCatalog {
  return {
    id: String(item?.id ?? ''),
    name: String(item?.name ?? ''),
    isDefault: !!item?.isDefault,
    path: String(item?.path ?? ''),
    url: zaloCatalogUrl(item?.path),
    totalProduct: Number(item?.totalProduct) || 0,
    photo: String(item?.catalogPhoto ?? '') || '',
    createdAt: Number(item?.created_time) || 0,
  };
}

export function mapZaloProduct(item: any): ZaloProduct {
  return {
    id: String(item?.product_id ?? ''),
    catalogId: String(item?.catalog_id ?? ''),
    name: String(item?.product_name ?? ''),
    price: String(item?.price ?? ''),
    currency: String(item?.currency_unit ?? '₫') || '₫',
    description: String(item?.description ?? ''),
    photos: Array.isArray(item?.product_photos) ? item.product_photos.map(String).filter(Boolean) : [],
    path: String(item?.path ?? ''),
    url: zaloCatalogUrl(item?.path),
    createdAt: Number(item?.create_time) || 0,
  };
}

/** Price typed by the user ("150.000", "150,000 ₫") → numeric string Zalo stores ("150000"); empty / not a number → ''. */
export function normalizeProductPrice(input: unknown): string {
  const digits = String(input ?? '').replace(/[^\d]/g, '');
  return digits.replace(/^0+(?=\d)/, '');
}

/** "150.000 ₫"; a price that is not a number → keep the string as is. */
export function formatProductPrice(price: unknown, currency = '₫'): string {
  const raw = String(price ?? '').trim();
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) return raw;
  return `${Number(raw).toLocaleString(appLocale())} ${currency}`.trim();
}

/** Text line with the link when a product is sent to a conversation. */
export function productShareText(product: Pick<ZaloProduct, 'name' | 'price' | 'currency'>): string {
  const price = formatProductPrice(product.price, product.currency);
  return price ? `${product.name} — ${price}` : product.name;
}

/** Checks the product data before sending to Zalo; returns a Vietnamese error message or null. */
export function validateZaloProduct(input: { name?: unknown; price?: unknown; description?: unknown; photos?: unknown }): string | null {
  const name = String(input.name ?? '').trim();
  if (!name) return tr('Nhập tên sản phẩm');
  if (name.length > ZALO_PRODUCT_NAME_MAX) return tr('Tên sản phẩm tối đa {{ZALO_PRODUCT_NAME_MAX}} ký tự', { ZALO_PRODUCT_NAME_MAX });
  if (!normalizeProductPrice(input.price)) return tr('Nhập giá sản phẩm (chỉ số)');
  if (String(input.description ?? '').length > ZALO_PRODUCT_DESCRIPTION_MAX) return tr('Mô tả tối đa {{ZALO_PRODUCT_DESCRIPTION_MAX}} ký tự', { ZALO_PRODUCT_DESCRIPTION_MAX });
  const photos = Array.isArray(input.photos) ? input.photos : [];
  if (photos.length > ZALO_PRODUCT_MAX_PHOTOS) return tr('Tối đa {{ZALO_PRODUCT_MAX_PHOTOS}} ảnh mỗi sản phẩm', { ZALO_PRODUCT_MAX_PHOTOS });
  return null;
}
