/**
 * Lượt TỰ sửa ảnh Zalo của mỗi tin (bong bóng chat gọi file:repairImage khi ảnh lỗi).
 *
 * - Tối đa MAX_ZALO_AUTO_REPAIR lượt mỗi chu kỳ: file sửa xong vẫn không hiển thị được không làm bong bóng tải lại vô hạn.
 * - Hết lượt thì chờ ZALO_REPAIR_COOLDOWN_MS rồi mới cho chu kỳ mới. Trước đây bộ đếm giữ cả phiên app: 3 lần lỗi lúc
 *   mạng chập chờn (1,5 s và 3 s là hết) → mọi lần lỗi sau của tin đó hiện ngay "Không tải được ảnh" cho tới khi bấm
 *   Thử tải lại / mở lại app.
 * - Ảnh hiện được (onLoad) → xoá bộ đếm.
 */
export const MAX_ZALO_AUTO_REPAIR = 3;
export const ZALO_REPAIR_COOLDOWN_MS = 60_000;

const attempts = new Map<string, { count: number; at: number }>();

/** Lấy 1 lượt: số thứ tự lượt (1..MAX), null khi đã hết lượt của chu kỳ và chưa qua thời gian chờ. */
export function takeZaloRepairAttempt(key: string, now = Date.now()): number | null {
  const entry = attempts.get(key);
  if (entry && entry.count >= MAX_ZALO_AUTO_REPAIR && now - entry.at < ZALO_REPAIR_COOLDOWN_MS) return null;
  const count = entry && entry.count < MAX_ZALO_AUTO_REPAIR ? entry.count + 1 : 1;
  attempts.set(key, { count, at: now });
  return count;
}

/** Số lượt đã dùng trong chu kỳ hiện tại. */
export function zaloRepairAttemptsUsed(key: string): number {
  return attempts.get(key)?.count || 0;
}

export function resetZaloRepairAttempts(key: string): void {
  attempts.delete(key);
}

/** Chỉ dùng trong test. */
export function __resetZaloRepairBudget(): void {
  attempts.clear();
}
