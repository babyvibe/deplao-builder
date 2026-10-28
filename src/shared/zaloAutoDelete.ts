/**
 * zaloAutoDelete.ts — tự xoá tin nhắn trên Zalo (ZL-05, SRS Deplao): phần thuần dùng chung main + renderer.
 *
 * zca-js 2.2.0: updateAutoDeleteChat(ttl: ChatTTL, threadId, type) với ChatTTL (ms) = 0 | 1 ngày | 7 ngày | 14 ngày;
 * getAutoDeleteChat() → { convers: [{ destId, isGroup, ttl, createdAt }] } (chỉ hội thoại đang bật).
 * Zalo xoá tin trên các thiết bị Zalo; Deplao luôn giữ nguyên tin đã lưu trên máy.
 */

export const ZALO_AUTO_DELETE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Tắt' },
  { value: 86_400_000, label: '1 ngày' },
  { value: 604_800_000, label: '7 ngày' },
  { value: 1_209_600_000, label: '14 ngày' },
];

export const ZALO_AUTO_DELETE_NOTE = 'Zalo sẽ tự xoá tin nhắn mới sau thời gian này trên điện thoại và Zalo PC của mọi người trong hội thoại. Deplao vẫn giữ nguyên tin nhắn trên máy này.';

/** Chỉ nhận đúng 4 giá trị Zalo hỗ trợ. */
export function isZaloAutoDeleteTtl(value: unknown): value is number {
  return ZALO_AUTO_DELETE_OPTIONS.some((option) => option.value === value);
}

/** Nhãn của một TTL (ms): giá trị chuẩn theo bảng, giá trị lạ (máy khác đặt) → "N ngày" / "N giờ". */
export function zaloAutoDeleteLabel(ttl: number | null | undefined): string {
  const value = Number(ttl) || 0;
  const known = ZALO_AUTO_DELETE_OPTIONS.find((option) => option.value === value);
  if (known) return known.label;
  if (value % 86_400_000 === 0) return `${value / 86_400_000} ngày`;
  return `${Math.max(1, Math.round(value / 3_600_000))} giờ`;
}

/** Nhãn của tin đã quá hạn tự xoá: Zalo đã xoá trên thiết bị Zalo, Deplao vẫn giữ nội dung (FR-ZL05.6). */
export const ZALO_TTL_EXPIRED_LABEL = 'Đã tự xoá trên Zalo';

/** Sự kiện xoá / thu hồi của Zalo có thể tới sớm hơn mốc hết hạn một chút (lệch giờ máy). */
export const ZALO_TTL_EXPIRY_GRACE_MS = 60_000;

/** Mốc Zalo tự xoá tin (ms); 0 = tin không hẹn tự xoá hoặc thiếu giờ gửi. */
export function zaloTtlExpiresAt(sentAt: number | string | null | undefined, ttl: number | null | undefined): number {
  const start = Number(sentAt) || 0;
  const life = Number(ttl) || 0;
  return start > 0 && life > 0 ? start + life : 0;
}

/** Tin đã quá hạn tự xoá trên Zalo; `graceMs` cho sự kiện tới sớm. */
export function isZaloTtlExpired(
  sentAt: number | string | null | undefined, ttl: number | null | undefined, now: number = Date.now(), graceMs: number = 0,
): boolean {
  const at = zaloTtlExpiresAt(sentAt, ttl);
  return at > 0 && now + graceMs >= at;
}

/** Hội thoại đang bật tự xoá từ getAutoDeleteChat: id → ttl (ms). Bỏ dòng thiếu id hoặc ttl ≤ 0. */
export function zaloAutoDeleteMap(res: any): Map<string, number> {
  const out = new Map<string, number>();
  const list = Array.isArray(res?.convers) ? res.convers : [];
  for (const item of list) {
    const id = String(item?.destId ?? '').trim();
    const ttl = Number(item?.ttl) || 0;
    if (id && ttl > 0) out.set(id, ttl);
  }
  return out;
}
