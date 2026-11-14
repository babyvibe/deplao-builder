/**
 * Link boundaries in the text of a message (shared by renderer + main): links are matched with a regex "up to whitespace", then the part that does not belong to the link is removed: punctuation at the end of the sentence, extra closing brackets (like GitHub / Telegram). Brackets that are balanced inside the link are kept. Examples: Shopee link "…-Samsung-Galaxy-A56-5G-(8GB-128GB)-Hàng-Chính-Hãng…", Wikipedia "…_(định_hướng)".
 */

/** Punctuation at the end of a link belongs to the sentence, not the link ("xem https://a.vn/x." / "…/x, nhé" / 'https://a.vn'). */
const URL_TRAILING_PUNCTUATION = '.,:;!?\'"*~…';
const URL_CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function countChar(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/** "(xem https://a.vn/x)." → "https://a.vn/x" (removes ")./"), "https://vi.wikipedia.org/wiki/A_(B)" stays as is. */
export function trimUrlEnd(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (URL_TRAILING_PUNCTUATION.includes(ch)) {
      end--;
      continue;
    }
    const opener = URL_CLOSING_BRACKETS[ch];
    if (opener) {
      const body = url.slice(0, end);
      if (countChar(body, ch) > countChar(body, opener)) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** Still a link after the tail is trimmed (not just "https://" / "www." left). */
export function isLinkableUrl(url: string): boolean {
  return !!url && !/^(?:https?:\/\/|www\.)$/i.test(url);
}
