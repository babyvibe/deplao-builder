/**
 * Message search (the search box of the conversation list, employee machines through REST, Public API), shared by
 * DatabaseService.searchMessages and the tests.
 *
 * Measured on a real DB (1.6 million messages, the largest account 1.36 million, 10/2026):
 *  - Old way: FTS5 exact-word match + ORDER BY timestamp over EVERY matching row ("anh" ≈ 0.6-0.8 s). When FTS returns 0 results (partial typing, typos, rare words),
 *    LIKE '%…%' scans the whole table ≈ 16-30 s. It runs on Electron's main process, so the whole app freezes.
 *  - New way: FTS5 by prefix, takes ≤ MESSAGE_SEARCH_FTS_CANDIDATES of the newest matching rows by rowid (≈ storage order),
 *    and only then sorts them by time → ≤ 20 ms. With no match, LIKE only runs on the MESSAGE_SEARCH_RECENT_SCAN newest messages.
 */

/** Maximum number of messages returned (kept as before). */
export const MESSAGE_SEARCH_LIMIT = 100;
/** Number of the newest FTS matching rows (by rowid) examined before sorting by time. */
export const MESSAGE_SEARCH_FTS_CANDIDATES = 300;
/** No FTS / FTS has no match: LIKE only runs on this many of the account's newest messages (not a scan of the whole table). */
export const MESSAGE_SEARCH_RECENT_SCAN = 10_000;

const MAX_TOKENS = 8;
const MAX_TOKEN_LENGTH = 64;
/** Max number of "d" / "đ" characters that are tried in both spellings within one word (2^3 = 8 variants). */
const MAX_D_POSITIONS = 3;

/** The "d" / "đ" variants of a word: unicode61 drops diacritics ("à" → "a", "ơ" → "o") but keeps "đ", so typing "don" without accents must also try "đon". */
function dVariants(token: string): string[] {
  const positions: number[] = [];
  for (let i = 0; i < token.length && positions.length < MAX_D_POSITIONS; i += 1) {
    if (token[i] === 'd' || token[i] === 'đ') positions.push(i);
  }
  if (!positions.length) return [token];
  const out = new Set<string>();
  for (let mask = 0; mask < 1 << positions.length; mask += 1) {
    const chars = token.split('');
    positions.forEach((pos, bit) => { chars[pos] = mask & (1 << bit) ? 'đ' : 'd'; });
    out.add(chars.join(''));
  }
  return [...out];
}

/**
 * Keywords typed by the user → FTS5 query for the messages_fts table (unicode61 tokenizer):
 *  - split on every character that is not a letter / digit (punctuation, FTS5 syntax special characters, emoji), so there are no syntax errors;
 *  - each word goes inside "…" and is matched by prefix ("xin ch" matches "xin chào" while typing), and the words are joined with AND;
 *  - a word with "d" / "đ" tries both spellings ("don hang" matches "Đơn hàng").
 * Returns null when no words are left to search through FTS.
 */
export function buildMessageFtsQuery(text: string): string | null {
  const tokens = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map(token => token.slice(0, MAX_TOKEN_LENGTH));
  if (!tokens.length) return null;
  return tokens
    .map((token) => {
      const variants = dVariants(token).map(v => `"${v}"*`);
      return variants.length === 1 ? variants[0] : `(${variants.join(' OR ')})`;
    })
    .join(' AND ');
}
