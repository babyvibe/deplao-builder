/**
 * Hiển thị chỉ số đã nhận / đã xem / đã phản hồi (shared/analytics/messageEngagement): chữ ghi chú theo kênh và định
 * dạng tỷ lệ. Dùng ở màn chiến dịch, CRM → Tổng quan và Báo cáo (Tin nhắn, Chiến dịch).
 */
import type { EngagementCounts } from '../../../shared/analytics/messageEngagement';

/** "62%" hoặc "—" khi không có số liệu (kênh không báo / chưa gửi). */
export function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? '—' : `${rate}%`;
}

/** Phần trăm làm tròn; null khi mẫu số 0. */
export function ratePercent(part: number | null | undefined, whole: number | null | undefined): number | null {
  const total = Number(whole) || 0;
  return total > 0 ? Math.round(((Number(part) || 0) / total) * 100) : null;
}

/** Ba tỷ lệ của một bộ đếm: đã nhận / mẫu số đã nhận, đã xem / đã gửi, đã phản hồi / đã gửi. */
export function engagementPercents(counts: Partial<EngagementCounts> | null | undefined): { delivered: number | null; seen: number | null; replied: number | null } {
  return {
    delivered: ratePercent(counts?.delivered, counts?.deliveredBase),
    seen: ratePercent(counts?.seen, counts?.sent),
    replied: ratePercent(counts?.replied, counts?.sent),
  };
}

/**
 * Ghi chú ngắn cho các kênh có trong số liệu (mỗi kênh một lần). `sendsMessage = false`: chiến dịch chỉ kết bạn / mời
 * nhóm → chỉ có "đã phản hồi".
 */
export function engagementNotes(channels: ReadonlyArray<string | null | undefined>, options: { sendsMessage?: boolean } = {}): string[] {
  if (options.sendsMessage === false) return ['Chiến dịch không gửi tin nhắn: chỉ tính khách có nhắn lại.'];
  const set = new Set(channels.map((channel) => String(channel || 'zalo')));
  const notes = ['Khách trả lời cũng tính là đã xem. Deplao cần đang mở để nhận báo đã nhận / đã xem.'];
  if (set.has('zalo')) notes.push('Zalo chỉ báo "đã xem" khi người nhận bật trạng thái Đã xem.');
  if (set.has('telegram_user')) notes.push('Telegram không báo "đã nhận".');
  if (set.has('telegram_bot')) notes.push('Telegram Bot không báo đã nhận / đã xem: chỉ tính khách trả lời.');
  return notes;
}
