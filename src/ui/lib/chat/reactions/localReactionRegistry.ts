/**
 * Reaction vừa bấm trong app (đã lưu DB ngay ở handleReact). Zalo gửi lại bản echo (isSelf) của chính reaction đó
 * về phiên này; trước đây echo cũng được lưu → mỗi lần bấm bị +2 trong DB (mở lại hội thoại thấy gấp đôi).
 * Đếm theo số lần bấm để bấm nhanh nhiều lần vẫn khớp từng echo.
 */
const pending = new Map<string, { count: number; at: number }>();
const TTL_MS = 60_000;

const keyOf = (accountId: string, msgId: string, emoji: string) => `${accountId}|${msgId}|${emoji}`;

export function markLocalReaction(accountId: string, msgId: string, emoji: string): void {
  if (!accountId || !msgId || !emoji) return;
  const key = keyOf(accountId, String(msgId), emoji);
  const entry = pending.get(key);
  const now = Date.now();
  pending.set(key, { count: (entry && now - entry.at < TTL_MS ? entry.count : 0) + 1, at: now });
}

/** true nếu echo này ứng với 1 lần bấm trong app (đã lưu) → không lưu lại. */
export function consumeLocalReaction(accountId: string, msgId: string, emoji: string): boolean {
  const key = keyOf(accountId, String(msgId), emoji);
  const entry = pending.get(key);
  if (!entry) return false;
  if (Date.now() - entry.at >= TTL_MS) {
    pending.delete(key);
    return false;
  }
  if (entry.count <= 1) pending.delete(key);
  else pending.set(key, { count: entry.count - 1, at: entry.at });
  return true;
}
