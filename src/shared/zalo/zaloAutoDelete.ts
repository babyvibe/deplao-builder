/**
 * zaloAutoDelete.ts: auto-delete messages on Zalo (ZL-05, SRS Deplao): pure part shared by main + renderer.
 *
 * zca-js 2.2.0: updateAutoDeleteChat(ttl: ChatTTL, threadId, type) with ChatTTL (ms) = 0 | 1 day | 7 days | 14 days;
 * getAutoDeleteChat() → { convers: [{ destId, isGroup, ttl, createdAt }] } (only conversations where it is turned on).
 * Zalo deletes messages on the Zalo devices; Deplao always keeps the messages stored on the machine.
 */

import { tr } from '../i18n';

export const ZALO_AUTO_DELETE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: tr('Tắt') },
  { value: 86_400_000, label: tr('1 ngày') },
  { value: 604_800_000, label: tr('7 ngày') },
  { value: 1_209_600_000, label: tr('14 ngày') },
];

export const ZALO_AUTO_DELETE_NOTE = tr('Zalo sẽ tự xoá tin nhắn mới sau thời gian này trên điện thoại và Zalo PC của mọi người trong hội thoại. Deplao vẫn giữ nguyên tin nhắn trên máy này.');

/** Accepts only the 4 values Zalo supports. */
export function isZaloAutoDeleteTtl(value: unknown): value is number {
  return ZALO_AUTO_DELETE_OPTIONS.some((option) => option.value === value);
}

/** Label of a TTL (ms): standard value from the table; unknown value (set on another machine) → "N ngày" / "N giờ" (N days / N hours). */
export function zaloAutoDeleteLabel(ttl: number | null | undefined): string {
  const value = Number(ttl) || 0;
  const known = ZALO_AUTO_DELETE_OPTIONS.find((option) => option.value === value);
  if (known) return known.label;
  if (value % 86_400_000 === 0) return tr('{{v1}} ngày', { v1: value / 86_400_000 });
  return tr('{{v1}} giờ', { v1: Math.max(1, Math.round(value / 3_600_000)) });
}

/** Label for a message past its auto-delete time: Zalo has deleted it on the Zalo devices, Deplao still keeps the content (FR-ZL05.6). */
export const ZALO_TTL_EXPIRED_LABEL = tr('Đã tự xoá trên Zalo');

/** Zalo's delete / recall event can arrive a little before the expiry time (machine clock skew). */
export const ZALO_TTL_EXPIRY_GRACE_MS = 60_000;

/** Time at which Zalo auto-deletes the message (ms); 0 = the message has no auto-delete scheduled or the send time is missing. */
export function zaloTtlExpiresAt(sentAt: number | string | null | undefined, ttl: number | null | undefined): number {
  const start = Number(sentAt) || 0;
  const life = Number(ttl) || 0;
  return start > 0 && life > 0 ? start + life : 0;
}

/** A message past its auto-delete time on Zalo; `graceMs` allows for an early event. */
export function isZaloTtlExpired(
  sentAt: number | string | null | undefined, ttl: number | null | undefined, now: number = Date.now(), graceMs: number = 0,
): boolean {
  const at = zaloTtlExpiresAt(sentAt, ttl);
  return at > 0 && now + graceMs >= at;
}

/** Conversations with auto-delete on, from getAutoDeleteChat: id → ttl (ms). Drops rows missing the id or with ttl ≤ 0. */
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
