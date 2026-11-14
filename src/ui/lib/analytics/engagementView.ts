/**
 * Shows the received / seen / replied metrics (shared/analytics/messageEngagement): per-channel note text and percentage
 * format. Used on the campaign screen, CRM → Overview and Reports (Messages, Campaigns).
 */
import type { EngagementCounts } from '../../../shared/analytics/messageEngagement';
import { tr } from '../../../shared/i18n';

/** "62%" or "-" when there is no data (channel does not report / not sent yet). */
export function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? '—' : `${rate}%`;
}

/** Rounded percentage; null when the denominator is 0. */
export function ratePercent(part: number | null | undefined, whole: number | null | undefined): number | null {
  const total = Number(whole) || 0;
  return total > 0 ? Math.round(((Number(part) || 0) / total) * 100) : null;
}

/** The three rates of one counter: received / received base, seen / sent, replied / sent. */
export function engagementPercents(counts: Partial<EngagementCounts> | null | undefined): { delivered: number | null; seen: number | null; replied: number | null } {
  return {
    delivered: ratePercent(counts?.delivered, counts?.deliveredBase),
    seen: ratePercent(counts?.seen, counts?.sent),
    replied: ratePercent(counts?.replied, counts?.sent),
  };
}

/**
 * Short note for the channels in the data (once per channel). `sendsMessage = false`: the campaign only sends friend requests / group
 * invites → only "đã phản hồi" (replied) is shown.
 */
export function engagementNotes(channels: ReadonlyArray<string | null | undefined>, options: { sendsMessage?: boolean } = {}): string[] {
  if (options.sendsMessage === false) return [tr('Chiến dịch không gửi tin nhắn: chỉ tính khách có nhắn lại.')];
  const set = new Set(channels.map((channel) => String(channel || 'zalo')));
  const notes = [tr('Khách trả lời cũng tính là đã xem. Deplao cần đang mở để nhận báo đã nhận / đã xem.')];
  if (set.has('zalo')) notes.push(tr('Zalo chỉ báo "đã xem" khi người nhận bật trạng thái Đã xem.'));
  if (set.has('telegram_user')) notes.push(tr('Telegram không báo "đã nhận".'));
  if (set.has('telegram_bot')) notes.push(tr('Telegram Bot không báo đã nhận / đã xem: chỉ tính khách trả lời.'));
  return notes;
}
