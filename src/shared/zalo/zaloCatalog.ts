/**
 * zaloCatalog.ts — danh mục sản phẩm Zalo Business (ZL-04, SRS Deplao): phần thuần dùng chung main + renderer + API.
 *
 * zca-js 2.2.0: getCatalogList / createCatalog / updateCatalog / deleteCatalog, getProductCatalogList /
 * createProductCatalog / updateProductCatalog / deleteProductCatalog (endpoint mdelete), uploadProductPhoto.
 * Lỗi của zca-js: createProductCatalog / updateProductCatalog chỉ tải `files` khi files.length == 0 → ảnh bị bỏ qua;
 * Deplao luôn tải ảnh bằng uploadProductPhoto rồi truyền product_photos (tối đa 5 URL). Tiền tệ cố định "₫".
 */

export const ZALO_CATALOG_BASE_URL = 'https://catalog.zalo.me/';
export const ZALO_PRODUCT_MAX_PHOTOS = 5;
/** Gửi nhiều sản phẩm một lần: cách nhau ít nhất 2 s (quyết định Q8). */
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
  /** Giá dạng chuỗi số như Zalo lưu (vd "150000"). */
  price: string;
  currency: string;
  description: string;
  photos: string[];
  path: string;
  url: string;
  createdAt: number;
}

/** Link catalog.zalo.me của danh mục / sản phẩm (path tương đối của Zalo; URL đầy đủ giữ nguyên). */
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

/** Giá người dùng gõ ("150.000", "150,000 ₫") → chuỗi số Zalo lưu ("150000"); rỗng / không phải số → ''. */
export function normalizeProductPrice(input: unknown): string {
  const digits = String(input ?? '').replace(/[^\d]/g, '');
  return digits.replace(/^0+(?=\d)/, '');
}

/** "150.000 ₫"; giá không phải số → giữ nguyên chuỗi. */
export function formatProductPrice(price: unknown, currency = '₫'): string {
  const raw = String(price ?? '').trim();
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) return raw;
  return `${Number(raw).toLocaleString('vi-VN')} ${currency}`.trim();
}

/** Dòng chữ kèm link khi gửi sản phẩm vào hội thoại. */
export function productShareText(product: Pick<ZaloProduct, 'name' | 'price' | 'currency'>): string {
  const price = formatProductPrice(product.price, product.currency);
  return price ? `${product.name} — ${price}` : product.name;
}

/** Kiểm dữ liệu sản phẩm trước khi gửi Zalo; trả câu lỗi tiếng Việt hoặc null. */
export function validateZaloProduct(input: { name?: unknown; price?: unknown; description?: unknown; photos?: unknown }): string | null {
  const name = String(input.name ?? '').trim();
  if (!name) return 'Nhập tên sản phẩm';
  if (name.length > ZALO_PRODUCT_NAME_MAX) return `Tên sản phẩm tối đa ${ZALO_PRODUCT_NAME_MAX} ký tự`;
  if (!normalizeProductPrice(input.price)) return 'Nhập giá sản phẩm (chỉ số)';
  if (String(input.description ?? '').length > ZALO_PRODUCT_DESCRIPTION_MAX) return `Mô tả tối đa ${ZALO_PRODUCT_DESCRIPTION_MAX} ký tự`;
  const photos = Array.isArray(input.photos) ? input.photos : [];
  if (photos.length > ZALO_PRODUCT_MAX_PHOTOS) return `Tối đa ${ZALO_PRODUCT_MAX_PHOTOS} ảnh mỗi sản phẩm`;
  return null;
}
