/**
 * workflowText.ts: text helpers of workflow nodes. Pure, covered by src/__tests__/workflow/workflowText.test.ts.
 */

const EDGE_PUNCTUATION = /^[\s"'“”‘’«»`*_.:;,!?()[\]{}-]+|[\s"'“”‘’«»`*_.:;,!?()[\]{}-]+$/g;

/** Lower case, inner spaces collapsed, outer spaces / quotes / punctuation removed (accents kept): for loose comparisons. */
export function looseText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCTUATION, '')
    .trim();
}

/**
 * The category an AI classifier meant: the exact name, then loose equality ("Hỏi giá." → "Hỏi giá"), then the only category
 * whose name appears in the answer ("Danh mục: hỏi giá"). Ambiguous or nothing → '' (the caller keeps the raw answer).
 */
export function matchCategory(answer: unknown, categories: string[]): string {
  const raw = String(answer ?? '').trim();
  const list = (Array.isArray(categories) ? categories : []).map(c => String(c ?? '').trim()).filter(Boolean);
  if (!raw || !list.length) return '';
  const exact = list.find(c => c === raw);
  if (exact) return exact;
  const loose = looseText(raw);
  const equal = list.find(c => looseText(c) === loose);
  if (equal) return equal;
  const contained = list.filter(c => loose.includes(looseText(c)));
  if (contained.length === 1) return contained[0];
  if (contained.length > 1) {
    // "giá" and "hỏi giá" both appear: the longest name wins when it contains the others
    const longest = contained.reduce((a, b) => (looseText(b).length > looseText(a).length ? b : a));
    if (contained.every(c => looseText(longest).includes(looseText(c)))) return longest;
  }
  return '';
}

/** Numbers first, then times ("08:30"), then text (Vietnamese order): used by "Lớn hơn" / "Nhỏ hơn". */
export function compareConditionValues(left: string, right: string): number {
  const ln = Number(left);
  const rn = Number(right);
  if (left.trim() !== '' && right.trim() !== '' && !Number.isNaN(ln) && !Number.isNaN(rn)) return ln - rn;
  const parseTime = (s: string): number | null => {
    const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10) : null;
  };
  const lt = parseTime(left);
  const rt = parseTime(right);
  if (lt !== null && rt !== null) return lt - rt;
  return left.localeCompare(right, 'vi');
}

/**
 * Condition of "Rẽ nhánh Đúng/Sai" (logic.if) and "Dừng workflow nếu..." (logic.stopIf).
 * contains_any: one of the comma-separated words, ignoring case. in_list: equal to one of the comma-separated values (the whole
 * value, ignoring case and outer spaces), for lists of IDs where "contains" would also accept a longer ID.
 * Old template names stay accepted: matches_any = contains_any,
 * matches = regex (workflows installed from those templates never reached their "true" branch before). Unknown → false.
 */
export function evaluateCondition(leftValue: unknown, operator: unknown, rightValue: unknown): boolean {
  const left = String(leftValue ?? '');
  const right = String(rightValue ?? '');
  switch (String(operator || 'equals')) {
    case 'equals':       return left === right;
    case 'not_equals':   return left !== right;
    case 'contains':     return left.includes(right);
    case 'not_contains': return !left.includes(right);
    case 'contains_any':
    case 'matches_any': {
      const haystack = left.toLowerCase();
      return right.split(',').map(word => word.trim().toLowerCase()).filter(Boolean).some(word => haystack.includes(word));
    }
    case 'in_list': {
      const value = left.trim().toLowerCase();
      return right.split(',').map(item => item.trim().toLowerCase()).filter(Boolean).some(item => item === value);
    }
    case 'starts_with':  return left.startsWith(right);
    case 'ends_with':    return left.endsWith(right);
    case 'greater_than': return compareConditionValues(left, right) > 0;
    case 'less_than':    return compareConditionValues(left, right) < 0;
    case 'is_empty':     return left.trim() === '';
    case 'not_empty':    return left.trim() !== '';
    case 'regex':
    case 'matches':
      try { return new RegExp(right, 'i').test(left); } catch { return false; }
    default:
      return false;
  }
}

/** "/donhang@ShopBot 0901 234 567" → command "donhang", args "0901 234 567". */
const BOT_COMMAND_RE = /^\/([A-Za-z][\w-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/;

/** Text is a Telegram bot command ("/start", "/start@ShopBot", "/donhang 0901…"). */
export function isBotCommandText(text: unknown): boolean {
  return BOT_COMMAND_RE.test(String(text ?? '').trim());
}

/** Command name (lower case, without "/" and "@bot") and the text after it. Not a command → empty strings. */
export function parseBotCommand(text: unknown): { command: string; args: string } {
  const match = BOT_COMMAND_RE.exec(String(text ?? '').trim());
  return match ? { command: match[1].toLowerCase(), args: (match[2] || '').trim() } : { command: '', args: '' };
}

/** Locale of text a workflow sends to customers: the node's choice, Vietnamese by default (never the app UI language). */
export function workflowLocale(value: unknown): string {
  const v = String(value ?? '').trim();
  if (!v) return 'vi-VN';
  try {
    return Intl.getCanonicalLocales(v)[0] || 'vi-VN';
  } catch {
    return 'vi-VN';
  }
}
