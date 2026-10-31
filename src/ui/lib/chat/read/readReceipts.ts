/**
 * readReceipts.ts — "Đã xem" của tin Telegram ở menu chuột phải (như Telegram Desktop: "10 đã xem" + danh sách).
 * Telegram chỉ trả cho tin MÌNH gửi, trong 7 ngày (chat_read_mark_expire_period); nhóm còn giới hạn số thành viên
 * (main báo too_big). Kênh phát tin chỉ có lượt xem, không có danh sách.
 */

export const READ_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Có nên hỏi "ai đã xem" cho tin này không (tránh gọi Telegram cho tin chắc chắn không có dữ liệu). */
export function canQueryTelegramReadReceipts(
  msg: any,
  opts: { isSent: boolean; isChannelPost: boolean; recalled?: boolean; now?: number },
): boolean {
  if (!msg || msg.channel !== 'telegram_user' || !opts.isSent || opts.isChannelPost || opts.recalled) return false;
  if (!/^\d+$/.test(String(msg.msg_id ?? ''))) return false;        // tin đang gửi (id tạm)
  if (msg.msg_type === 'system' || !msg.thread_id) return false;
  const timestamp = Number(msg.timestamp || 0);
  const now = opts.now ?? Date.now();
  return timestamp > 0 && now - timestamp <= READ_RECEIPT_MAX_AGE_MS;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "hôm nay lúc 10:13" / "hôm qua lúc 17:48" / "15/10 lúc 09:00" / "15/10/2025 lúc 09:00" (giờ máy). */
export function formatReadTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const today = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  if (ms >= startOfToday) return `hôm nay lúc ${time}`;
  if (ms >= startOfYesterday) return `hôm qua lúc ${time}`;
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  return date.getFullYear() === today.getFullYear() ? `${day} lúc ${time}` : `${day}/${date.getFullYear()} lúc ${time}`;
}
