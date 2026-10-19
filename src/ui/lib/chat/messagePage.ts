/**
 * Trang tin mới nhất khi mở hội thoại: tin đã có trong bộ nhớ (chatStore) hiện ngay, trang đọc từ DB chỉ thay mảng khi
 * thật sự khác — thay bằng mảng mới (dù y hệt) làm vẽ lại toàn bộ tin ngay sau khi hội thoại vừa hiện.
 */

/** Tối đa `limit` tin mới nhất của mảng đã sắp cũ → mới (giữ nguyên mảng nếu không dài hơn). */
export function newestMessages<T>(messages: readonly T[], limit: number): readonly T[] {
  return messages.length > limit ? messages.slice(-limit) : messages;
}

/**
 * Mảng trong bộ nhớ trùng hệt trang vừa đọc: cùng số tin, cùng thứ tự, mỗi tin cùng tập cột và mọi giá trị bằng nhau
 * (===). Tin mang thêm trạng thái chỉ có ở bộ nhớ (đang gửi, đính kèm dạng object…) → khác → thay như trước.
 */
export function isSameMessagePage(current: readonly unknown[] | undefined, page: readonly unknown[]): boolean {
  if (!current || current.length !== page.length) return false;
  for (let i = 0; i < page.length; i++) {
    const a = current[i] as Record<string, unknown> | null;
    const b = page[i] as Record<string, unknown> | null;
    if (a === b) continue;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(b);
    if (Object.keys(a).length !== keys.length) return false;
    for (const key of keys) {
      if (a[key] !== b[key] || !(key in a)) return false;
    }
  }
  return true;
}
