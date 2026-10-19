import { localDayKey } from '../../../shared/localTimeBuckets';

/**
 * Tin HIỂN THỊ đầu tiên của mỗi ngày lịch (máy) → nơi đặt mốc ngày "Hôm nay / Hôm qua / 15/10" (1 lần / ngày, như
 * Telegram). `isSkipped`: tin không có hàng riêng (ảnh / sticker / poll đã gộp vào tin đầu nhóm) — bỏ qua, nếu không
 * album vắt qua nửa đêm làm mất mốc của ngày mới.
 */
export function getDayStartIds(
  messages: ReadonlyArray<{ msg_id: string; timestamp: number | string }>,
  isSkipped: (msgId: string) => boolean = () => false,
): Set<string> {
  const ids = new Set<string>();
  let lastDay = '';
  for (const message of messages) {
    if (isSkipped(message.msg_id)) continue;
    const day = localDayKey(Number(message.timestamp) || 0);
    if (day !== lastDay) {
      ids.add(message.msg_id);
      lastDay = day;
    }
  }
  return ids;
}
