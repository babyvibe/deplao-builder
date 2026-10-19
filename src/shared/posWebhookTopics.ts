/**
 * Loại sự kiện Deplao đăng ký giúp trên KiotViet / Sapo (Tích hợp → trang nền tảng → "Đăng ký webhook tự động") và quy
 * tắc địa chỉ nhận. Thuần — renderer (ô chọn sự kiện, danh sách webhook) và main (services/integrations/posWebhookRegistration.ts).
 *
 * KiotViet (kiotviet.vn → Public API → 2.11 Webhook): Type = order.update, invoice.update, customer.update / delete,
 *   product.update / delete, stock.update, pricebook(detail).update / delete, category.update / delete, branch.update / delete.
 *   Không có màn hình quản trị webhook — chỉ đăng ký được qua API (POST / GET / DELETE /webhooks).
 * Sapo (support.sapo.vn/sapo-webhook): topic = orders/create, orders/updated, orders/paid, orders/cancelled, orders/fulfilled,
 *   orders/partially_fulfilled, orders/delete, customers/create | update | delete…, products/create | update | delete,
 *   fulfillments/create | update, refunds/create… (GET / POST / PUT / DELETE /admin/webhooks.json).
 */

export type WebhookRegistrationType = 'kiotviet' | 'sapo';

export interface WebhookEventOption {
  value: string;
  label: string;
  /** Chọn sẵn khi mở trang. */
  defaultOn?: boolean;
}

export const WEBHOOK_EVENT_OPTIONS: Readonly<Record<WebhookRegistrationType, readonly WebhookEventOption[]>> = {
  kiotviet: [
    { value: 'order.update', label: 'Đặt hàng: tạo, sửa, đổi trạng thái', defaultOn: true },
    { value: 'invoice.update', label: 'Hoá đơn: tạo, sửa, giao hàng', defaultOn: true },
    { value: 'customer.update', label: 'Khách hàng: thêm, sửa' },
    { value: 'customer.delete', label: 'Khách hàng: xoá' },
    { value: 'product.update', label: 'Hàng hoá: thêm, sửa' },
    { value: 'product.delete', label: 'Hàng hoá: xoá' },
    { value: 'stock.update', label: 'Tồn kho thay đổi' },
  ],
  sapo: [
    { value: 'orders/create', label: 'Đơn hàng mới', defaultOn: true },
    { value: 'orders/paid', label: 'Đơn đã thanh toán', defaultOn: true },
    { value: 'orders/updated', label: 'Đơn được cập nhật' },
    { value: 'orders/cancelled', label: 'Đơn bị huỷ' },
    { value: 'orders/fulfilled', label: 'Đơn đã giao đủ hàng' },
    { value: 'fulfillments/update', label: 'Vận chuyển cập nhật' },
    { value: 'customers/create', label: 'Khách hàng mới' },
    { value: 'customers/update', label: 'Khách hàng được cập nhật' },
    { value: 'products/update', label: 'Sản phẩm được cập nhật' },
  ],
};

export function isWebhookRegistrationType(type: unknown): type is WebhookRegistrationType {
  return type === 'kiotviet' || type === 'sapo';
}

export function defaultWebhookEvents(type: WebhookRegistrationType): string[] {
  return WEBHOOK_EVENT_OPTIONS[type].filter(option => option.defaultOn).map(option => option.value);
}

/** Tên dễ đọc của một sự kiện (sự kiện ngoài danh sách → giữ tên gốc). */
export function webhookEventLabel(type: WebhookRegistrationType, event: string): string {
  return WEBHOOK_EVENT_OPTIONS[type].find(option => option.value === event)?.label || event;
}

function parseUrl(value: unknown): URL | null {
  try { return new URL(String(value ?? '').trim()); } catch { return null; }
}

const trimPath = (path: string): string => path.replace(/\/+$/, '');

/**
 * Địa chỉ Deplao đăng ký cho một sự kiện: <địa chỉ gốc>/webhook/<id kết nối>. Sapo thêm `?event=<topic>` để tên sự kiện
 * không phụ thuộc header topic (IntegrationRegistry đọc `?event=` ghi đè).
 */
export function deplaoWebhookUrl(type: WebhookRegistrationType, baseUrl: string, integrationId: string, event: string): string {
  const url = `${String(baseUrl || '').trim().replace(/\/+$/, '')}/webhook/${encodeURIComponent(integrationId)}`;
  return type === 'sapo' ? `${url}?event=${encodeURIComponent(event)}` : url;
}

/** Cùng địa chỉ: giao thức, host (không phân biệt hoa thường), đường dẫn (bỏ "/" cuối) và `?event=`. */
export function sameWebhookUrl(a: string, b: string): boolean {
  const x = parseUrl(a);
  const y = parseUrl(b);
  if (!x || !y) return false;
  return x.protocol === y.protocol
    && x.host.toLowerCase() === y.host.toLowerCase()
    && trimPath(x.pathname) === trimPath(y.pathname)
    && (x.searchParams.get('event') || '') === (y.searchParams.get('event') || '');
}

/**
 * Webhook trên nền tảng so với kết nối Deplao này:
 *  - current: đúng địa chỉ Deplao sẽ đăng ký bây giờ;
 *  - stale: của Deplao nhưng địa chỉ cũ (địa chỉ tạm đã đổi, thiếu ?event=…) — /webhook/<id kết nối> ở bất kỳ host nào,
 *    hoặc /webhook/<loại> trên chính địa chỉ hiện tại;
 *  - other: hệ thống khác (hoặc Deplao ở máy khác).
 */
export type WebhookOwnership = 'current' | 'stale' | 'other';

export function classifyWebhook(
  type: WebhookRegistrationType,
  webhook: { url: string; event: string },
  integrationId: string,
  baseUrl: string | null,
): WebhookOwnership {
  if (baseUrl && sameWebhookUrl(webhook.url, deplaoWebhookUrl(type, baseUrl, integrationId, webhook.event))) return 'current';
  const url = parseUrl(webhook.url);
  if (!url) return 'other';
  let path = trimPath(url.pathname);
  try { path = decodeURIComponent(path); } catch { /* giữ nguyên */ }
  if (path === `/webhook/${integrationId}`) return 'stale';
  const base = baseUrl ? parseUrl(baseUrl) : null;
  if (base && base.host.toLowerCase() === url.host.toLowerCase() && path === `/webhook/${type}`) return 'stale';
  return 'other';
}

/** Webhook trong danh sách của trang tích hợp (IPC integration:listWebhooks / registerWebhooks / removeWebhook). */
export interface PosWebhookView {
  id: string;
  event: string;
  url: string;
  active: boolean;
  description: string;
  ownership: WebhookOwnership;
}

export interface PosWebhookListResponse {
  success: boolean;
  error?: string;
  /** Địa chỉ gốc nhận webhook (null = chưa bật "Thanh toán, tích hợp"). */
  address?: string | null;
  /** Địa chỉ tạm — đổi mỗi lần khởi động lại, phải đăng ký lại. */
  temporary?: boolean;
  webhooks: PosWebhookView[];
}
