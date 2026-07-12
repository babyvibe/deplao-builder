/**
 * emojiUtils.ts - Constants và helpers cho emoji (Zalo codes, emoji categories, reaction mapping)
 * Dùng chung cho ChatWindow, MessageBubbles, MessageInput, và các component khác.
 */

/** Zalo text reaction codes → Unicode emoji (dùng để convert khi display) */
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

/** Chuyển đổi Zalo reaction code → Unicode emoji (dùng cho display) */
export function zaloCodeToEmoji(code: string): string {
  return ZALO_CODE_TO_EMOJI[code] ?? code;
}

/** Thay thế tất cả Zalo codes trong text bằng Unicode emoji */
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

/** Map Unicode emoji → Zalo reaction code (dùng khi gửi reaction) */
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
