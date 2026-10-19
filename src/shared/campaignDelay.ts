/**
 * Giãn cách giữa hai liên hệ của chiến dịch CRM.
 *
 * CRMQueueService không bao giờ gửi hai liên hệ cách nhau dưới `CAMPAIGN_MIN_CONTACT_DELAY_SECONDS` (chống spam).
 * Màn tạo / sửa chiến dịch và màn chi tiết dùng cùng hằng số: trước đây ô "Tùy chỉnh khoảng" cho chọn từ 5 giây
 * trong khi queue vẫn chờ 30 giây.
 */
export const CAMPAIGN_MIN_CONTACT_DELAY_SECONDS = 30;

/** Khoảng [min, max] giây queue thực sự dùng: min ≥ mức tối thiểu, max ≥ min. */
export function effectiveContactDelayRange(minSeconds: number, maxSeconds: number): [number, number] {
  const min = Math.max(CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, Number(minSeconds) || 0);
  const max = Math.max(min, Number(maxSeconds) || 0);
  return [min, max];
}
