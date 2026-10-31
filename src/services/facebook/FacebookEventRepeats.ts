/**
 * MQTT và bridge LightSpeed cùng báo mỗi sự kiện của tin Facebook thường (tin, cảm xúc, thu hồi), cách nhau vài chục ms.
 * Tin mới chống lặp bằng DB (saveFBMessage). Cảm xúc và thu hồi không có hàng riêng nên chống lặp ở đây: cùng khoá, cùng
 * giá trị lặp lại trong REPEAT_WINDOW_MS là bản lặp, không ghi lại, không phát lại (workflow, sự kiện API chỉ chạy một
 * lần). Giá trị khác trạng thái trước đó (đổi / gỡ cảm xúc) vẫn qua.
 */

export const REPEAT_WINDOW_MS = 30_000;
const MAX_ENTRIES = 2000;

export function createRepeatFilter(windowMs: number = REPEAT_WINDOW_MS) {
  const last = new Map<string, { value: string; at: number }>();
  return {
    /** true = sự kiện mới (xử lý tiếp), false = bản lặp của sự kiện vừa báo. */
    accept(key: string, value: string, now: number = Date.now()): boolean {
      const prev = last.get(key);
      if (prev && prev.value === value && now - prev.at < windowMs) return false;
      last.set(key, { value, at: now });
      if (last.size > MAX_ENTRIES) {
        for (const [k, v] of last) if (now - v.at >= windowMs) last.delete(k);
      }
      return true;
    },
  };
}

export type RepeatFilter = ReturnType<typeof createRepeatFilter>;

/** Cảm xúc: khoá = tin + người (bỏ phần "@…" / ":…" của JID), giá trị = cảm xúc bỏ U+FE0F ("❤" = "❤️"), rỗng = gỡ. */
export function reactionRepeat(messageId: string, userId: string, emoji: string): { key: string; value: string } {
  return {
    key: `reaction|${messageId}|${String(userId || '').replace(/[@:].*$/, '')}`,
    value: String(emoji || '').replace(/\uFE0F/g, ''),
  };
}

/** Thu hồi: mỗi tin một lần. */
export function unsendRepeat(messageId: string): { key: string; value: string } {
  return { key: `unsend|${messageId}`, value: 'unsent' };
}
