/**
 * Tìm tin nhắn (ô tìm kiếm của danh sách hội thoại, máy nhân viên qua REST, Public API) — dùng chung cho
 * DatabaseService.searchMessages và test.
 *
 * Số liệu đo trên DB thật (1,6 triệu tin, tài khoản lớn nhất 1,36 triệu, 10/2026):
 *  - Cách cũ: FTS5 khớp nguyên từ + ORDER BY timestamp trên MỌI dòng khớp ("anh" ≈ 0,6–0,8 s), và khi FTS ra 0 kết
 *    quả (gõ dở, gõ sai, từ hiếm) thì LIKE '%…%' quét cả bảng ≈ 16–30 s — đồng bộ trên tiến trình chính của Electron,
 *    cả app đứng.
 *  - Cách mới: FTS5 theo tiền tố, lấy ≤ MESSAGE_SEARCH_FTS_CANDIDATES dòng khớp mới nhất theo rowid (≈ thứ tự lưu)
 *    rồi mới xếp theo thời gian → ≤ 20 ms; không khớp thì LIKE chỉ trên MESSAGE_SEARCH_RECENT_SCAN tin gần nhất.
 */

/** Số tin trả về tối đa (giữ như trước). */
export const MESSAGE_SEARCH_LIMIT = 100;
/** Số dòng khớp FTS mới nhất (theo rowid) được xét trước khi xếp theo thời gian. */
export const MESSAGE_SEARCH_FTS_CANDIDATES = 300;
/** Không có FTS / FTS không khớp: LIKE chỉ trên chừng này tin gần nhất của tài khoản (không quét cả bảng). */
export const MESSAGE_SEARCH_RECENT_SCAN = 10_000;

const MAX_TOKENS = 8;
const MAX_TOKEN_LENGTH = 64;
/** Số chữ d / đ tối đa được thử cả hai cách viết trong một từ (2^3 = 8 biến thể). */
const MAX_D_POSITIONS = 3;

/** Các biến thể d / đ của một từ: unicode61 bỏ dấu (à → a, ơ → o) nhưng giữ đ, nên gõ không dấu "don" phải thử "đon". */
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
 * Từ khoá người dùng gõ → truy vấn FTS5 cho bảng messages_fts (tokenizer unicode61):
 *  - tách theo mọi ký tự không phải chữ / số (dấu câu, ký tự đặc biệt của cú pháp FTS5, emoji) → không lỗi cú pháp;
 *  - mỗi từ đặt trong "…" và tìm theo tiền tố ("xin ch" khớp "xin chào" khi đang gõ dở), các từ nối bằng AND;
 *  - từ có d / đ thử cả hai cách viết ("don hang" khớp "Đơn hàng").
 * Trả null khi không còn từ nào để tìm qua FTS.
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
