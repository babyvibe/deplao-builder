/**
 * emojiUtils.ts - Constants and helpers for emoji (Zalo codes, emoji categories, reaction mapping)
 * Shared by ChatWindow, MessageBubbles, MessageInput, and other components.
 */

/** Zalo text reaction codes → Unicode emoji (used to convert when displaying) */
export const ZALO_CODE_TO_EMOJI: Record<string, string> = {
  '/-heart':   '❤️',  '/-strong':  '👍',  ':>':       '😄',  ':o':       '😮',
  ':-((': '😢',  ':-h': '😡',  ':-*': '😘',  ":')": '😂',
  '/-shit': '💩',  '/-rose': '🌹',  '/-break': '💔',  '/-weak': '👎',
  ';xx': '😍',  ';-/': '😕',  ';-)': '😉',  '/-fade': '😶',
  '/-li': '☀️',  '/-bd': '🎂',  '/-bome': '💣',  '/-ok': '👌',
  '/-v': '✌️',  '/-thanks': '🤝',  '/-punch': '👊',  '/-share': '🔗',
  '_()_': '🙏',  '/-no': '🙅',  '/-bad': '👎',  '/-loveu': '🫶',
  '--b': '😞',  ':((': '😭',  'x-)': '😎',  '8-)': '🤓',
  ';-d': '😁',  'b-)': '😎',  ':--|': '😐',  'p-(': '😔',
  ':-bye': '👋',  '|-)': '😴',  ':wipe': '😅',  ':-dig': '🤔',
  '&-(': '😰',  ':handclap': '👏',  '>-|': '😠',  ';-x': '🤫',
  ':-o': '😲',  ';-s': '😳',  ';-a': '😨',  ':-<': '😢',
  ':))': '😂',  '$-)': '🤑',  '/-beer': '🍺',
  // Common text emoticons
  ':-)': '🙂',  ':)': '🙂',  ':-(': '😞',  ':(': '😞',
  ':-D': '😁',  ':D': '😁',  ':P': '😛',  ':p': '😛',
  ':-P': '😛',  ':O': '😲',  '>:(': '😠',  ":'(": '😢',
};

/**
 * Font stack of message text that should draw emoji in color (Telegram): the app's text fonts FIRST, color emoji fonts
 * after, so a symbol such as ❤ or ✈ without the emoji selector is drawn in color instead of the monochrome Segoe UI Symbol
 * (Windows). Emoji fonts must never come first: they also hold digits, "#", "*" and the space (keycap emoji), so on macOS
 * Apple Color Emoji drew wide digits and spaces while the letters fell back to a serif font.
 */
export const COLOR_EMOJI_TEXT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

/** Converts a Zalo reaction code → Unicode emoji (used for display) */
export function zaloCodeToEmoji(code: string): string {
  return ZALO_CODE_TO_EMOJI[code] ?? code;
}

/** Replaces all Zalo codes in the text with Unicode emoji */
export function convertZaloEmojis(text: string): string {
  if (!text) return text;
  const direct = ZALO_CODE_TO_EMOJI[text];
  if (direct) return direct;
  const sorted = Object.keys(ZALO_CODE_TO_EMOJI).sort((a, b) => b.length - a.length);
  let result = text;
  for (const code of sorted) {
    if (result.includes(code)) {
      result = result.split(code).join(ZALO_CODE_TO_EMOJI[code]);
    }
  }
  return result;
}

/** Map Unicode emoji → Zalo reaction code (used when sending a reaction) */
export const EMOJI_TO_REACTION: Record<string, string> = {
  '❤️': 'HEART', '👍': 'LIKE', '😄': 'HAHA', '😮': 'WOW', '😢': 'CRY', '😡': 'ANGRY',
  '😘': 'KISS', '😂': 'TEARS_OF_JOY', '💩': 'SHIT', '🌹': 'ROSE', '💔': 'BROKEN_HEART',
  '👎': 'DISLIKE', '😍': 'LOVE', '👌': 'OK', '✌️': 'PEACE', '🙏': 'PRAY',
  '😉': 'WINK', '😕': 'CONFUSED', '😁': 'BIG_SMILE', '👊': 'PUNCH', '👋': 'BYE',
  '🫶': 'LOVE_YOU', '😭': 'VERY_SAD', '😎': 'COOL', '🎂': 'BIRTHDAY',
};

/** Extended emoji categories for the emoji picker */
export const EMOJI_CATEGORIES: Record<string, string[]> = {
  'Phổ biến': ['😊', '😂', '❤️', '👍', '😮', '😢', '😡', '🔥', '👋', '🙏', '✌️', '😍', '😎', '🥰', '😜', '🤩', '😭', '🤗', '😇', '🤔', '😤', '🥳', '💪', '✅', '🎉', '💯', '🚀', '⭐', '🌈', '💙'],
  'Cảm xúc': ['😀', '😃', '😄', '😁', '😆', '🥹', '😅', '🤣', '🥲', '☺️', '😋', '😛', '😝', '🤑', '🤭', '🤫', '🤐', '🤨', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '🙂', '😌', '😔', '😪', '🤤', '😴'],
  'Trái tim': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '❤️‍🔥', '❤️‍🩹', '💑', '💏', '🫂', '💋', '🫶', '🤲', '🙌', '👏', '🤝'],
  'Tay & Cử chỉ': ['👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '💪', '🦾', '🙏', '✍️', '🤳', '💅', '🤌', '👌', '🫰'],
  'Động vật': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🦋', '🐌'],
  'Đồ ăn': ['🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍔', '🍕', '🌭', '🍟', '🍗', '🥩', '🍣', '🍜', '🍝', '🍰', '🎂', '🍩', '🍪', '☕', '🍺', '🥂'],
  'Hoạt động': ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎱', '🏓', '🏸', '🥊', '🎯', '🎮', '🎲', '🎭', '🎨', '🎬', '🎤', '🎧', '🎵', '🎹', '🥇', '🏆', '🏅', '🎖️', '🎗️', '🎟️', '🎪', '🎠', '🎡', '🎢'],
  'Du lịch': ['✈️', '🚗', '🚕', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🏍️', '🚲', '🛵', '🚀', '🛸', '🚁', '⛵', '🚢', '⛺', '🏠', '🏢', '🏰', '🗼', '🗽', '⛩️', '🕌', '🛕', '⛪'],
  'Đồ vật': ['⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💿', '📷', '📹', '🎥', '📞', '☎️', '📺', '📻', '🎙️', '⏰', '⏱️', '⏲️', '🕰️', '💡', '🔦', '🏮', '📦', '💰', '💳', '💎', '⚖️', '🔧', '🔨'],
  'Biểu tượng': ['✨', '⚡', '🌟', '💫', '💥', '💢', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️', '🗯️', '💭', '💤', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🔶', '🔷', '🔸', '🔹', '▶️', '⏩'],
};

/** Flat array of all emojis for backward compatibility */
export const QUICK_EMOJIS = Object.values(EMOJI_CATEGORIES).flat();
