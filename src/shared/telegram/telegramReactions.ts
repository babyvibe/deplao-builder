/**
 * Telegram reactions (standard emoji, not including Premium custom emoji). Telegram accepts EXACTLY the strings in its list:
 * no U+FE0F variant character (the heart is "❤", not "❤️"); sending another variant → REACTION_INVALID.
 */

/** Default list (Telegram's order), used when the conversation's real list could not be fetched yet. */
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
  /** Admin allows only some reactions (in the order the admin picks). */
  | { kind: 'some'; emoticons: string[] };

export interface TelegramReactionCatalog {
  /** messages.getAvailableReactions: Telegram's order. */
  available: Array<{ emoticon: string; premium?: boolean; inactive?: boolean }>;
  /** messages.getTopReactions: the account's own most-used reactions, in order. */
  top: string[];
  chat: TelegramChatReactions;
  isPremium: boolean;
}

/**
 * Reactions usable in the conversation, most-used first (like the Telegram menu): conversation has reactions off → []; admin picks
 * some → exactly those reactions; otherwise → the standard list, without Premium-only types when the account has no Premium.
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
