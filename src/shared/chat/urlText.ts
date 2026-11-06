/**
 * Ranh giới link trong chữ của tin (dùng chung renderer + main): link bắt bằng regex "tới khoảng trắng" rồi bỏ phần cuối
 * không thuộc link — dấu câu cuối câu, ngoặc đóng thừa (như GitHub / Telegram). Ngoặc đủ cặp nằm trong link vẫn giữ:
 * link Shopee "…-Samsung-Galaxy-A56-5G-(8GB-128GB)-Hàng-Chính-Hãng…", Wikipedia "…_(định_hướng)".
 */

/** Dấu câu đứng cuối link là của câu, không phải của link ("xem https://a.vn/x." / "…/x, nhé" / 'https://a.vn'). */
const URL_TRAILING_PUNCTUATION = '.,:;!?\'"*~…';
const URL_CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function countChar(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/** "(xem https://a.vn/x)." → "https://a.vn/x" (bỏ ")." ), "https://vi.wikipedia.org/wiki/A_(B)" giữ nguyên. */
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

/** Còn là link sau khi cắt đuôi (không chỉ còn "https://" / "www."). */
export function isLinkableUrl(url: string): boolean {
  return !!url && !/^(?:https?:\/\/|www\.)$/i.test(url);
}
