/**
 * telegramReadReceipts.ts: the "Seen" status of Telegram messages (pure part, with tests).
 *  - Groups / supergroups: messages.getMessageReadParticipants → [{ userId, date }]. Telegram only returns it for messages I SENT, in groups
 *    with at most chat_read_mark_size_threshold members (default 100) and within chat_read_mark_expire_period (7 days).
 *  - Private chat: messages.getOutboxReadDate → the time the other side read it (unless they or I hide the read time).
 */

import { tr } from '../../../shared/i18n';

export type ReadReceiptUnavailableReason = 'too_big' | 'too_old' | 'privacy' | 'not_read' | 'error';

/** Telegram error → reason + message text (in Vietnamese). */
export function mapReadReceiptError(err: unknown): { reason: ReadReceiptUnavailableReason; message: string } {
  const code = String((err as any)?.errorMessage || (err as any)?.message || err || '');
  if (code.includes('CHAT_TOO_BIG')) return { reason: 'too_big', message: tr('Nhóm đông thành viên - Telegram không cho xem ai đã xem') };
  if (code.includes('MSG_TOO_OLD') || code.includes('MESSAGE_TOO_OLD')) {
    return { reason: 'too_old', message: tr('Tin đã quá 7 ngày - Telegram không còn lưu ai đã xem') };
  }
  if (code.includes('YOUR_PRIVACY_RESTRICTED')) {
    return { reason: 'privacy', message: tr('Bạn đang ẩn thời gian đã xem nên không xem được của người khác') };
  }
  if (code.includes('USER_PRIVACY_RESTRICTED')) return { reason: 'privacy', message: tr('Người nhận ẩn thời gian đã xem') };
  if (code.includes('MESSAGE_NOT_READ_YET')) return { reason: 'not_read', message: tr('Chưa xem') };
  return { reason: 'error', message: code || tr('Không lấy được danh sách đã xem') };
}

function idString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && typeof (value as any).valueOf === 'function') {
    const inner = (value as any).valueOf();
    if (inner !== value) return idString(inner);
  }
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : '';
}

/**
 * Result of getMessageReadParticipants (new layer: ReadParticipantDate { userId, date }; old layer: a list of ids) → a list of
 * { userId, date (ms) } without duplicates, the most recent viewer first.
 */
export function normalizeReadParticipants(raw: unknown): Array<{ userId: string; date: number }> {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const byUser = new Map<string, number>();
  for (const item of list) {
    const isObject = !!item && typeof item === 'object' && 'userId' in (item as any);
    const userId = idString(isObject ? (item as any).userId : item);
    if (!userId) continue;
    const date = isObject ? Math.max(0, Number((item as any).date || 0)) * 1000 : 0;
    byUser.set(userId, Math.max(byUser.get(userId) ?? 0, date));
  }
  return [...byUser.entries()].map(([userId, date]) => ({ userId, date })).sort((a, b) => b.date - a.date);
}
