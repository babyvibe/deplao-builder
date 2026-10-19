/**
 * posLookupGuard.ts — node workflow tra cứu khách hàng / đơn hàng trên POS (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake).
 *
 * Ô SĐT / mã đơn của các node này thường là biến ({{ $trigger.fromPhone }}, nội dung tin…) nên có thể render ra rỗng:
 * khách chưa lưu SĐT, trigger không có số (thanh toán, lịch hẹn…). Gọi API với điều kiện rỗng thì vài nền tảng trả danh
 * sách KHÔNG lọc — Pancake / Nhanh.vn: đơn mới nhất của cả shop; KiotViet / Nhanh.vn / Pancake: khách hàng bất kỳ — và
 * workflow trả lời khách bằng đơn / thông tin của người khác. Thiếu điều kiện → không gọi API, trả "không tìm thấy"
 * kèm lý do (nhánh "không tìm thấy" của workflow vẫn chạy được).
 */

export type PosLookupKind = 'customer' | 'order';

/** 'pancake.lookupOrder' → { platform: 'pancake', kind: 'order' }; node khác → null. */
export function posLookupNode(type: string): { platform: string; kind: PosLookupKind } | null {
  const m = /^(kiotviet|haravan|sapo|nhanh|pancake)\.lookup(Customer|Order)$/.exec(String(type || ''));
  if (!m) return null;
  return { platform: m[1], kind: m[2] === 'Order' ? 'order' : 'customer' };
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** Điều kiện tra cứu sau khi render: SĐT, và mã đơn với tra cứu đơn hàng. Không có điều kiện nào → null. */
export function posLookupQuery(kind: PosLookupKind, cfg: Record<string, any>): { phone: string; orderId: string } | null {
  const phone = text(cfg?.phone);
  const orderId = kind === 'order' ? text(cfg?.orderId) : '';
  return phone || orderId ? { phone, orderId } : null;
}

export const EMPTY_POS_LOOKUP_REASON: Record<PosLookupKind, string> = {
  customer: 'Không tra cứu: số điện thoại trống (khách chưa lưu SĐT hoặc biến không có giá trị). Tra cứu không điều kiện sẽ trả về khách hàng khác.',
  order: 'Không tra cứu: số điện thoại và mã đơn đều trống (khách chưa lưu SĐT hoặc biến không có giá trị). Tra cứu không điều kiện sẽ trả về đơn của khách khác.',
};

/**
 * SĐT người gửi ở dạng phần mềm bán hàng Việt Nam hay lưu: bỏ khoảng trắng / dấu chấm / gạch, "+84…" / "84…" (Telegram
 * lưu số không có dấu +) → "0…". Số nước ngoài giữ nguyên chữ số; rỗng → ''.
 */
export function vietnamLocalPhone(raw: unknown): string {
  const cleaned = String(raw ?? '').trim().replace(/[\s().-]/g, '');
  if (!cleaned) return '';
  const vn = /^\+?84(\d{9,10})$/.exec(cleaned);
  if (vn) return `0${vn[1].replace(/^0+/, '')}`;
  return cleaned;
}

/** Kết quả "không tìm thấy" cùng dạng với kết quả thật của node (found = false). */
export function refusedPosLookup(kind: PosLookupKind): Record<string, any> {
  return kind === 'order'
    ? { orders: [], order: null, found: false, skipped: true, reason: EMPTY_POS_LOOKUP_REASON.order }
    : { customers: [], firstCustomer: null, found: false, skipped: true, reason: EMPTY_POS_LOOKUP_REASON.customer };
}
