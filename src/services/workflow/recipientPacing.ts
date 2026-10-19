/**
 * Giãn cách giữa các người nhận khi MỘT node gửi tin cho nhiều hội thoại (chọn nhiều hội thoại, hoặc "Danh sách hội
 * thoại động" từ "Chọn đối tượng nhận tin").
 *
 * Trước đây node lặp gửi liên tục — AccountSendQueue chỉ giãn cách giữa các LẦN CHẠY node — nên gửi hàng loạt Zalo /
 * Facebook bắn hàng trăm tin trong vài giây (dễ bị Zalo đánh dấu spam, Facebook bắt xác minh / checkpoint).
 * Giống chiến dịch CRM giãn cách từng liên hệ: chờ ngẫu nhiên trong một khoảng có mức tối thiểu. "Giãn cách gửi tối
 * thiểu / tối đa" của node chỉ làm chậm hơn, không nhanh hơn mức tối thiểu. Một người nhận (trả lời tự động) giữ
 * nguyên như cũ. Thuần — test: src/__tests__/recipientPacing.test.ts.
 */

/** Khoảng mặc định (giây) giữa hai người nhận; cũng là mức tối thiểu khi node đặt giãn cách thấp hơn. */
export const BULK_RECIPIENT_GAP_SECONDS = { min: 5, max: 10 } as const;

/** [min, max] mili-giây chờ sau mỗi người nhận của một node gửi hàng loạt. */
export function recipientGapRangeMs(cfg: { sendDelayMinSeconds?: unknown; sendDelayMaxSeconds?: unknown }): [number, number] {
  const cfgMin = Math.max(0, Number(cfg.sendDelayMinSeconds) || 0);
  const cfgMax = Math.max(cfgMin, Number(cfg.sendDelayMaxSeconds) || 0);
  // Cả khoảng của node thấp hơn mức tối thiểu (mặc định node mới 1–3 giây) → dùng khoảng mặc định
  if (cfgMax < BULK_RECIPIENT_GAP_SECONDS.min) {
    return [BULK_RECIPIENT_GAP_SECONDS.min * 1000, BULK_RECIPIENT_GAP_SECONDS.max * 1000];
  }
  const min = Math.max(BULK_RECIPIENT_GAP_SECONDS.min, cfgMin);
  return [min * 1000, Math.max(min, cfgMax) * 1000];
}
