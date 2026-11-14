/**
 * readReceipts.ts: "Đã xem" (Seen by) for a Telegram message in the right-click menu (as in Telegram Desktop: "10 đã xem" (10 seen) + the list).
 * Telegram only returns this for messages I SENT, within 7 days (chat_read_mark_expire_period); a group also has a member limit
 * (main reports too_big). Broadcast channels only have view counts, no list.
 */

import { tr } from '../../../../shared/i18n';

export const READ_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether to ask "ai đã xem" (who has seen it) for this message (avoids calling Telegram for a message that surely has no data). */
export function canQueryTelegramReadReceipts(
  msg: any,
  opts: { isSent: boolean; isChannelPost: boolean; recalled?: boolean; now?: number },
): boolean {
  if (!msg || msg.channel !== 'telegram_user' || !opts.isSent || opts.isChannelPost || opts.recalled) return false;
  if (!/^\d+$/.test(String(msg.msg_id ?? ''))) return false;        // message being sent (temporary id)
  if (msg.msg_type === 'system' || !msg.thread_id) return false;
  const timestamp = Number(msg.timestamp || 0);
  const now = opts.now ?? Date.now();
  return timestamp > 0 && now - timestamp <= READ_RECEIPT_MAX_AGE_MS;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "hôm nay lúc 10:13" (today at 10:13) / "hôm qua lúc 17:48" (yesterday at 17:48) / "15/10 lúc 09:00" / "15/10/2025 lúc 09:00" (machine time). */
export function formatReadTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const today = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  if (ms >= startOfToday) return tr('hôm nay lúc {{time}}', { time });
  if (ms >= startOfYesterday) return tr('hôm qua lúc {{time}}', { time });
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  return date.getFullYear() === today.getFullYear() ? tr('{{day}} lúc {{time}}', { day, time }) : tr('{{day}}/{{v1}} lúc {{time}}', { day, v1: date.getFullYear(), time });
}
