/**
 * Event types Deplao registers for you on KiotViet / Sapo (Integrations → platform page → "Đăng ký webhook tự động" (Register webhooks automatically)) and the
 * rules for the receiving address. Pure: used by the renderer (event picker, webhook list) and main (services/integrations/posWebhookRegistration.ts).
 *
 * KiotViet (kiotviet.vn → Public API → 2.11 Webhook): Type = order.update, invoice.update, customer.update / delete,
 *   product.update / delete, stock.update, pricebook(detail).update / delete, category.update / delete, branch.update / delete.
 *   There is no webhook admin screen: webhooks can only be registered through the API (POST / GET / DELETE /webhooks).
 * Sapo (support.sapo.vn/sapo-webhook): topic = orders/create, orders/updated, orders/paid, orders/cancelled, orders/fulfilled,
 *   orders/partially_fulfilled, orders/delete, customers/create | update | delete…, products/create | update | delete,
 *   fulfillments/create | update, refunds/create… (GET / POST / PUT / DELETE /admin/webhooks.json).
 */

import { tr } from '../i18n';

export type WebhookRegistrationType = 'kiotviet' | 'sapo';

export interface WebhookEventOption {
  value: string;
  label: string;
  /** Preselected when the page opens. */
  defaultOn?: boolean;
}

export const WEBHOOK_EVENT_OPTIONS: Readonly<Record<WebhookRegistrationType, readonly WebhookEventOption[]>> = {
  kiotviet: [
    { value: 'order.update', label: tr('Đặt hàng: tạo, sửa, đổi trạng thái'), defaultOn: true },
    { value: 'invoice.update', label: tr('Hoá đơn: tạo, sửa, giao hàng'), defaultOn: true },
    { value: 'customer.update', label: tr('Khách hàng: thêm, sửa') },
    { value: 'customer.delete', label: tr('Khách hàng: xoá') },
    { value: 'product.update', label: tr('Hàng hoá: thêm, sửa') },
    { value: 'product.delete', label: tr('Hàng hoá: xoá') },
    { value: 'stock.update', label: tr('Tồn kho thay đổi') },
  ],
  sapo: [
    { value: 'orders/create', label: tr('Đơn hàng mới'), defaultOn: true },
    { value: 'orders/paid', label: tr('Đơn đã thanh toán'), defaultOn: true },
    { value: 'orders/updated', label: tr('Đơn được cập nhật') },
    { value: 'orders/cancelled', label: tr('Đơn bị huỷ') },
    { value: 'orders/fulfilled', label: tr('Đơn đã giao đủ hàng') },
    { value: 'fulfillments/update', label: tr('Vận chuyển cập nhật') },
    { value: 'customers/create', label: tr('Khách hàng mới') },
    { value: 'customers/update', label: tr('Khách hàng được cập nhật') },
    { value: 'products/update', label: tr('Sản phẩm được cập nhật') },
  ],
};

export function isWebhookRegistrationType(type: unknown): type is WebhookRegistrationType {
  return type === 'kiotviet' || type === 'sapo';
}

export function defaultWebhookEvents(type: WebhookRegistrationType): string[] {
  return WEBHOOK_EVENT_OPTIONS[type].filter(option => option.defaultOn).map(option => option.value);
}

/** Readable name of an event (an event outside the list keeps its original name). */
export function webhookEventLabel(type: WebhookRegistrationType, event: string): string {
  return WEBHOOK_EVENT_OPTIONS[type].find(option => option.value === event)?.label || event;
}

function parseUrl(value: unknown): URL | null {
  try { return new URL(String(value ?? '').trim()); } catch { return null; }
}

const trimPath = (path: string): string => path.replace(/\/+$/, '');

/**
 * The address Deplao registers for an event: <base address>/webhook/<connection id>. Sapo adds `?event=<topic>` so the event name
 * does not depend on the topic header (IntegrationRegistry reads the `?event=` override).
 */
export function deplaoWebhookUrl(type: WebhookRegistrationType, baseUrl: string, integrationId: string, event: string): string {
  const url = `${String(baseUrl || '').trim().replace(/\/+$/, '')}/webhook/${encodeURIComponent(integrationId)}`;
  return type === 'sapo' ? `${url}?event=${encodeURIComponent(event)}` : url;
}

/** Same address: protocol, host (case-insensitive), path (trailing "/" removed) and `?event=`. */
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
 * Webhook on the platform compared with this Deplao connection:
 *  - current: exactly the address Deplao will register now;
 *  - stale: belongs to Deplao but the address is old (the temporary address has changed, or ?event=… is missing): /webhook/<connection id> on any host,
 *    or /webhook/<type> on the current address itself;
 *  - other: another system (or Deplao on another machine).
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
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  if (path === `/webhook/${integrationId}`) return 'stale';
  const base = baseUrl ? parseUrl(baseUrl) : null;
  if (base && base.host.toLowerCase() === url.host.toLowerCase() && path === `/webhook/${type}`) return 'stale';
  return 'other';
}

/** Webhooks in the integration page's list (IPC integration:listWebhooks / registerWebhooks / removeWebhook). */
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
  /** Base address that receives webhooks (null = "Thanh toán, tích hợp" (Payments, integrations) not turned on). */
  address?: string | null;
  /** Temporary address: changes on every restart, must be registered again. */
  temporary?: boolean;
  webhooks: PosWebhookView[];
}
