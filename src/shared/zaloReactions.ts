/**
 * zaloReactions.ts — mã reaction Zalo (rIcon, vd ":>") → emoji hiển thị: MỘT bảng dùng chung cho renderer và main.
 *
 * Trước đây thanh chọn gửi "haha" bằng 😄 (EMOJI_TO_REACTION 😄 → HAHA = ":>") nhưng 3 nơi nhận reaction (useZaloEvents,
 * EventBroadcaster, HttpClientService) dịch ":>" thành 😆 → bản echo Zalo gửi lại của reaction vừa thả không khớp
 * reaction đã lưu → bị lưu thêm: thả 1 lần thành 2 (😄 + 😆 cùng một người).
 */

export const ZALO_REACTION_ICON_TO_EMOJI: Readonly<Record<string, string>> = {
  '/-heart': '❤️', '/-strong': '👍', ':>': '😄', ':o': '😮',
  ':-((': '😢', ':-h': '😡', ':-*': '😘', ":')": '😂',
  '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
  ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '🥱',
  '_()_': '🙏', '/-no': '🙅', '/-ok': '👌', '/-v': '✌️',
  '/-thanks': '🙏', '/-punch': '👊', ':-bye': '👋', ':((': '😭',
  ':))': '😁', '$-)': '🤑',
};

/** rIcon của Zalo → emoji (mã lạ giữ nguyên). */
export function zaloReactionIconToEmoji(icon: string): string {
  return ZALO_REACTION_ICON_TO_EMOJI[icon] || icon;
}

/** Emoji cũ đã lưu cho cùng một reaction Zalo (trước bản sửa, "haha" nhận về là 😆). */
const ZALO_REACTION_ALIASES: Readonly<Record<string, string>> = { '😆': '😄' };

export function normalizeZaloReactionEmoji(emoji: string): string {
  return ZALO_REACTION_ALIASES[emoji] || emoji;
}

export interface ZaloReactionEntry { total: number; users: Record<string, number> }

/**
 * Gộp bản ghi reaction Zalo bị tách đôi về emoji chuẩn. Cùng một người có ở cả 2 khoá = lần thả trong app + bản echo
 * của chính lần đó → lấy số lớn hơn (không cộng); người khác nhau → gộp chung. Không có khoá cũ → trả nguyên `data`.
 */
export function mergeZaloReactionAliases<T extends { total?: number; emoji: Record<string, ZaloReactionEntry> }>(data: T): T {
  const keys = Object.keys(data?.emoji || {});
  if (!keys.some((key) => ZALO_REACTION_ALIASES[key])) return data;
  const emoji: Record<string, ZaloReactionEntry> = {};
  for (const key of keys) {
    const entry = data.emoji[key];
    const target = normalizeZaloReactionEmoji(key);
    const users = entry?.users || {};
    const existing = emoji[target];
    if (!existing) {
      emoji[target] = { total: Number(entry?.total) || 0, users: { ...users } };
      continue;
    }
    for (const [uid, count] of Object.entries(users)) {
      existing.users[uid] = Math.max(existing.users[uid] || 0, Number(count) || 0);
    }
    const userSum = Object.values(existing.users).reduce((sum, count) => sum + count, 0);
    existing.total = userSum > 0 ? userSum : Math.max(existing.total, Number(entry?.total) || 0);
  }
  const total = Object.values(emoji).reduce((sum, entry) => sum + entry.total, 0);
  return { ...data, emoji, total };
}
