/**
 * posOrderOwnership.ts: keeps only the orders that really belong to the customer a POS lookup asked about.
 *
 * Several POS APIs silently drop a filter they do not support and then return the newest orders of the whole shop:
 *  - KiotViet `/orders` only knows `customerIds` / `customerCode` (Deplao used to send `customerId`);
 *  - Haravan documents no customer filter on `orders.json` (`customer_id` may be ignored);
 *  - Pancake `search` also matches order notes, so a phone number written in another order's note matches too.
 * A workflow would then answer a customer with someone else's order (name, address, phone), so every
 * "orders of customer X" result is checked again here. Pure: covered by src/__tests__/integrations/posOrderOwnership.test.ts.
 */

/** Vietnamese phone in the local "0…" form, for comparison: "+84 90-123", "8490123…", "090.123…" → "090123…". */
export function normalizeVnPhone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('84') && digits.length >= 11 && digits.length <= 12) return `0${digits.slice(2)}`;
  return digits;
}

export interface OwnedOrders<T> {
  /** Orders that belong to the customer, in the original order. */
  orders: T[];
  /** How many orders were removed: > 0 means the platform ignored the filter (paging and totals are unreliable then). */
  dropped: number;
}

function idText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * Orders whose customer id equals `customerId` (compared as text, so 123 matches "123").
 * Orders without a customer id are removed too: an order of a walk-in customer is never "this customer's order".
 */
export function keepCustomerOrders<T>(orders: T[], customerId: unknown, readCustomerId: (order: T) => unknown): OwnedOrders<T> {
  const list = Array.isArray(orders) ? orders : [];
  const target = idText(customerId);
  if (!target) return { orders: [], dropped: list.length };
  const kept = list.filter((order) => idText(readCustomerId(order)) === target);
  return { orders: kept, dropped: list.length - kept.length };
}

/** Orders that carry `phone` in one of their phone fields (compared in the local "0…" form). */
export function keepPhoneOrders<T>(orders: T[], phone: unknown, readPhones: (order: T) => unknown[]): OwnedOrders<T> {
  const list = Array.isArray(orders) ? orders : [];
  const target = normalizeVnPhone(phone);
  if (!target) return { orders: [], dropped: list.length };
  const kept = list.filter((order) => (readPhones(order) || []).some((value) => normalizeVnPhone(value) === target));
  return { orders: kept, dropped: list.length - kept.length };
}
