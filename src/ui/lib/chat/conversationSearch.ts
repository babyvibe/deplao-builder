/**
 * Lọc liên hệ / bạn bè trong ô tìm kiếm của danh sách hội thoại (GlobalSearchPanel).
 *
 * Trước đây mỗi lần gõ, mỗi liên hệ gọi matchQuery trên 4 trường và mỗi lần lại chuẩn hoá Unicode cả tên lẫn từ khoá
 * (tới 16 lần normalize NFC / NFD + regex cho một liên hệ, cộng danh sách bạn bè). Nay khoá tìm kiếm của từng dòng tính
 * MỘT lần khi danh sách đổi (buildSearchIndex trong useMemo), từ khoá bỏ dấu một lần, so bằng includes.
 * Khớp rộng hơn cách cũ: bỏ dấu cả đ → d ("duc" khớp "Đức") như ô tìm thành viên nhóm (deplao_fold).
 */
import { foldSearchText } from '../../../shared/searchFold';

const ZERO_WIDTH = /[\u200b-\u200f\uFEFF]/g;
/** Ngăn các trường trong một khoá: ký tự không gõ được nên từ khoá không khớp vắt qua hai trường. */
const FIELD_SEPARATOR = '\u0001';

/** Bỏ dấu (cả đ → d), chữ thường, bỏ ký tự rỗng (zero-width), gộp khoảng trắng — dùng cho cả khoá và từ khoá. */
export function foldForSearch(value: unknown): string {
  if (value === null || value === undefined) return '';
  return foldSearchText(String(value).replace(ZERO_WIDTH, '').replace(/\s+/g, ' '));
}

/** Khoá tìm kiếm của một dòng từ các trường (tên gợi nhớ, tên, SĐT, mã…). */
export function searchKeyOf(fields: ReadonlyArray<unknown>): string {
  return fields.map(foldForSearch).join(FIELD_SEPARATOR);
}

export interface SearchIndexEntry<T> {
  item: T;
  key: string;
}

/**
 * Khoá đã tính theo từng đối tượng (mỗi hàm lấy trường một bộ nhớ riêng). Store cập nhật kiểu bất biến
 * (chatStore.updateContact thay đối tượng của đúng hội thoại đổi), nên khi một tin mới làm danh sách đổi tham chiếu,
 * chỉ hội thoại vừa đổi phải tính lại khoá — không tính lại cả ~2.000 dòng (~27 ms) mỗi tin trong lúc đang tìm.
 */
const keyCaches = new WeakMap<object, WeakMap<object, string>>();

function cachedKeyOf<T>(item: T, fieldsOf: (item: T) => ReadonlyArray<unknown>, cache: WeakMap<object, string>): string {
  if (typeof item !== 'object' || item === null) return searchKeyOf(fieldsOf(item));
  let key = cache.get(item as unknown as object);
  if (key === undefined) {
    key = searchKeyOf(fieldsOf(item));
    cache.set(item as unknown as object, key);
  }
  return key;
}

/** Tính sẵn khoá của cả danh sách — gọi trong useMemo theo danh sách, không theo từ khoá. */
export function buildSearchIndex<T>(items: readonly T[], fieldsOf: (item: T) => ReadonlyArray<unknown>): SearchIndexEntry<T>[] {
  let cache = keyCaches.get(fieldsOf);
  if (!cache) {
    cache = new WeakMap();
    keyCaches.set(fieldsOf, cache);
  }
  const index: SearchIndexEntry<T>[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) index[i] = { item: items[i], key: cachedKeyOf(items[i], fieldsOf, cache) };
  return index;
}

/** Các dòng có khoá chứa từ khoá đã bỏ dấu (foldForSearch); từ khoá rỗng → không dòng nào. */
export function filterSearchIndex<T>(index: readonly SearchIndexEntry<T>[], needle: string): T[] {
  if (!needle) return [];
  const out: T[] = [];
  for (const entry of index) if (entry.key.includes(needle)) out.push(entry.item);
  return out;
}

/** Một dòng có khớp từ khoá (đã bỏ dấu) không — cho danh sách nhỏ (kết quả tìm phía Boss). */
export function matchesSearch(fields: ReadonlyArray<unknown>, needle: string): boolean {
  return !!needle && searchKeyOf(fields).includes(needle);
}

/** Trường dùng để tìm của một hội thoại / liên hệ. */
export const contactSearchFields = (c: any): unknown[] => [c?.alias, c?.display_name, c?.phone, c?.contact_id];
/** Trường dùng để tìm của một người bạn (bảng friends). */
export const friendSearchFields = (f: any): unknown[] => [f?.displayName, f?.phoneNumber, f?.userId];

/** Tin nhắn: từ khoá dưới chừng này ký tự (vd 1 chữ cái) chỉ lọc danh bạ, không gọi DB. */
export const MESSAGE_SEARCH_MIN_LENGTH = 2;
/** Chờ ngừng gõ rồi mới tìm tin nhắn (truy vấn DB nay ≤ ~20 ms nên chờ ngắn hơn 300 ms cũ). */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 200;
