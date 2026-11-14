/**
 * posLookupGuard.ts: workflow node that looks up customers / orders on a POS (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake).
 *
 * The phone / order code fields of these nodes are often variables ({{ $trigger.fromPhone }}, message content…), so they can render empty:
 * the customer has no saved phone, or the trigger has no number (payment, appointment…). Calling the API with an empty condition makes some platforms return an
 * UNFILTERED list: Pancake / Nhanh.vn return the newest orders of the whole shop; KiotViet / Nhanh.vn / Pancake return any customer → and the
 * workflow answers the customer with someone else's order / information. With a missing condition → the API is not called and "không tìm thấy" (not found)
 * is returned with the reason (the workflow's "not found" branch still runs).
 */

import { tr } from '../../shared/i18n';

export type PosLookupKind = 'customer' | 'order';

/** 'pancake.lookupOrder' → { platform: 'pancake', kind: 'order' }; other nodes → null. */
export function posLookupNode(type: string): { platform: string; kind: PosLookupKind } | null {
  const m = /^(kiotviet|haravan|sapo|nhanh|pancake)\.lookup(Customer|Order)$/.exec(String(type || ''));
  if (!m) return null;
  return { platform: m[1], kind: m[2] === 'Order' ? 'order' : 'customer' };
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** Lookup condition after rendering: phone number, and the order code for order lookups. No condition → null. */
export function posLookupQuery(kind: PosLookupKind, cfg: Record<string, any>): { phone: string; orderId: string } | null {
  const phone = text(cfg?.phone);
  const orderId = kind === 'order' ? text(cfg?.orderId) : '';
  return phone || orderId ? { phone, orderId } : null;
}

export const EMPTY_POS_LOOKUP_REASON: Record<PosLookupKind, string> = {
  customer: tr('Không tra cứu: số điện thoại trống (khách chưa lưu SĐT hoặc biến không có giá trị). Tra cứu không điều kiện sẽ trả về khách hàng khác.'),
  order: tr('Không tra cứu: số điện thoại và mã đơn đều trống (khách chưa lưu SĐT hoặc biến không có giá trị). Tra cứu không điều kiện sẽ trả về đơn của khách khác.'),
};

/**
 * Sender's phone number in the format Vietnamese sales software usually stores: remove spaces / dots / dashes, "+84…" / "84…" (Telegram
 * stores numbers without the + sign) → "0…". Foreign numbers keep their digits; empty → ''.
 */
export function vietnamLocalPhone(raw: unknown): string {
  const cleaned = String(raw ?? '').trim().replace(/[\s().-]/g, '');
  if (!cleaned) return '';
  const vn = /^\+?84(\d{9,10})$/.exec(cleaned);
  if (vn) return `0${vn[1].replace(/^0+/, '')}`;
  return cleaned;
}

/** "không tìm thấy" (not found) result, in the same shape as the node's real result (found = false). */
export function refusedPosLookup(kind: PosLookupKind): Record<string, any> {
  return kind === 'order'
    ? { orders: [], order: null, found: false, skipped: true, reason: EMPTY_POS_LOOKUP_REASON.order }
    : { customers: [], firstCustomer: null, found: false, skipped: true, reason: EMPTY_POS_LOOKUP_REASON.customer };
}
