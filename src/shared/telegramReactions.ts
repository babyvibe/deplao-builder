/**
 * Reaction Telegram (emoji chuẩn, không gồm custom emoji Premium). Telegram nhận ĐÚNG chuỗi trong danh sách của nó —
 * không có ký tự biến thể U+FE0F (tim là "❤", không phải "❤️"); gửi biến thể khác → REACTION_INVALID.
 */

/** Danh sách mặc định (thứ tự của Telegram) khi chưa lấy được danh sách thật của hội thoại. */
export const DEFAULT_TELEGRAM_REACTIONS: readonly string[] = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
];

export function normalizeTelegramReaction(emoji: string): string {
  return String(emoji || '').replace(/\uFE0F/g, '');
}

export type TelegramChatReactions =
  | { kind: 'all' }
  | { kind: 'none' }
  /** Admin chỉ cho phép một số reaction (theo thứ tự admin chọn). */
  | { kind: 'some'; emoticons: string[] };

export interface TelegramReactionCatalog {
  /** messages.getAvailableReactions — thứ tự của Telegram. */
  available: Array<{ emoticon: string; premium?: boolean; inactive?: boolean }>;
  /** messages.getTopReactions — reaction hay dùng của chính tài khoản, theo thứ tự. */
  top: string[];
  chat: TelegramChatReactions;
  isPremium: boolean;
}

/**
 * Reaction dùng được trong hội thoại, hay dùng trước (như menu Telegram): hội thoại tắt reaction → []; admin chọn
 * một số → đúng các reaction đó; còn lại → danh sách chuẩn, bỏ loại Premium khi tài khoản không có Premium.
 */
export function orderTelegramReactions(catalog: TelegramReactionCatalog): string[] {
  if (catalog.chat.kind === 'none') return [];
  const usable = catalog.available
    .filter((reaction) => reaction.emoticon && !reaction.inactive && (catalog.isPremium || !reaction.premium))
    .map((reaction) => reaction.emoticon);
  const allowed = catalog.chat.kind === 'some'
    ? catalog.chat.emoticons
    : (usable.length > 0 ? usable : [...DEFAULT_TELEGRAM_REACTIONS]);
  const allowedSet = new Set(allowed);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const emoticon of [...catalog.top, ...allowed]) {
    if (!allowedSet.has(emoticon) || seen.has(emoticon)) continue;
    seen.add(emoticon);
    ordered.push(emoticon);
  }
  return ordered;
}
