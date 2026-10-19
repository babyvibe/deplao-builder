/**
 * Bộ lọc danh sách liên hệ CRM: Nhãn Zalo, Nhãn Local, Có SĐT, Có ghi chú, Giới tính, Sinh nhật.
 *
 * Chạy trong `DatabaseService.getCRMContacts` TRƯỚC khi cắt trang, nên tổng số, phân trang và "Xuất CSV" tính trên
 * toàn bộ liên hệ khớp bộ lọc. Trước đây CRMPage lọc ngay trên trang đang tải (200 dòng): liên hệ ở trang khác không
 * bao giờ khớp, tổng thành số dòng của trang (mất thanh phân trang) và Xuất CSV bỏ qua bộ lọc.
 *
 * Nhãn Zalo chỉ có ở renderer (lấy từ API Zalo, không lưu DB) → renderer gửi kèm danh sách hội thoại của từng nhãn.
 * Thuần (không DB, không React) — test: src/__tests__/crmContactFilters.test.ts.
 */
import { localDayKey } from './localTimeBuckets';

export type CRMGenderFilter = 'all' | 'male' | 'female' | 'unknown';
export type CRMBirthdayFilter = 'all' | 'has_birthday' | 'no_birthday' | 'today' | 'this_week' | 'this_month';

export interface CRMContactFilters {
  /** Mỗi phần tử = danh sách hội thoại của MỘT nhãn Zalo đã chọn; liên hệ phải thuộc tất cả các nhãn. */
  zaloLabelConversations?: string[][];
  /** Nhãn Local đã chọn; liên hệ phải có tất cả. */
  localLabelIds?: number[];
  hasPhone?: boolean;
  hasNotes?: boolean;
  gender?: CRMGenderFilter;
  birthday?: CRMBirthdayFilter;
  /** "Hôm nay" theo máy người xem ('YYYY-MM-DD') cho Hôm nay / Tuần này / Tháng này; thiếu → ngày của máy truy vấn. */
  today?: string;
}

/** Các cột của một dòng getCRMContacts mà bộ lọc đọc. */
export interface CRMFilterRow {
  contact_id: string;
  contact_type?: string | null;
  phone?: string | null;
  gender?: number | null;
  birthday?: string | null;
}

export interface CRMFilterLookups {
  /** Nhãn Local đang gán cho hội thoại `contactId`. */
  localLabelsOf?: (contactId: string) => Iterable<number> | undefined;
  /** Số ghi chú CRM của liên hệ. */
  noteCountOf?: (contactId: string) => number;
}

/** Trạng thái bộ lọc của trang Liên hệ (crmStore). */
export interface CRMFilterState {
  filterLabelIds: readonly number[];
  filterLocalLabelIds: readonly number[];
  filterContactTypes: readonly string[];
  filterGender: CRMGenderFilter;
  filterBirthday: CRMBirthdayFilter;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

export function hasCRMContactFilters(filters: CRMContactFilters | null | undefined): boolean {
  if (!filters) return false;
  return !!(filters.zaloLabelConversations?.length || filters.localLabelIds?.length || filters.hasPhone || filters.hasNotes
    || (filters.gender && filters.gender !== 'all') || (filters.birthday && filters.birthday !== 'all'));
}

/** Bộ lọc gửi cho getCRMContacts từ trạng thái trang Liên hệ; `undefined` khi không lọc gì. */
export function buildCRMContactFilters(
  state: CRMFilterState,
  zaloLabels: ReadonlyArray<{ id: number; conversations?: readonly string[] | null }>,
  now: Date = new Date(),
): CRMContactFilters | undefined {
  const filters: CRMContactFilters = {};
  if (state.filterLabelIds.length > 0) {
    // Nhãn chưa tải / đã xoá → danh sách rỗng → không liên hệ nào khớp (như bộ lọc cũ)
    filters.zaloLabelConversations = state.filterLabelIds.map(id =>
      (zaloLabels.find(label => label.id === id)?.conversations || []).map(String));
  }
  if (state.filterLocalLabelIds.length > 0) filters.localLabelIds = [...state.filterLocalLabelIds];
  if (state.filterContactTypes.includes('has_phone')) filters.hasPhone = true;
  if (state.filterContactTypes.includes('has_notes')) filters.hasNotes = true;
  if (state.filterGender !== 'all') filters.gender = state.filterGender;
  if (state.filterBirthday !== 'all') {
    filters.birthday = state.filterBirthday;
    filters.today = localDayKey(now.getTime());
  }
  return hasCRMContactFilters(filters) ? filters : undefined;
}

function dateFromKey(key: string | undefined, fallback: Date): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : fallback;
}

/** "DD/MM" của ngày sinh dạng DD/MM/YYYY (chấp nhận ngày / tháng một chữ số); null nếu không đọc được. */
function birthdayDayMonth(birthday: string | null | undefined): string | null {
  if (!birthday) return null;
  const parts = String(birthday).split('/');
  if (parts.length < 2) return null;
  const day = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isInteger(day) || !Number.isInteger(month) || day < 1 || month < 1) return null;
  return `${pad2(day)}/${pad2(month)}`;
}

function dayMonthKey(date: Date): string {
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}`;
}

/** Hôm nay = cùng ngày/tháng; Tuần này = 7 ngày từ hôm nay; Tháng này = cùng tháng. */
export function birthdayMatcher(
  filter: CRMBirthdayFilter | undefined,
  today: Date,
): ((birthday: string | null | undefined) => boolean) | null {
  switch (filter) {
    case 'has_birthday': return birthday => !!birthday;
    case 'no_birthday': return birthday => !birthday;
    case 'today': {
      const key = dayMonthKey(today);
      return birthday => birthdayDayMonth(birthday) === key;
    }
    case 'this_week': {
      const keys = new Set<string>();
      for (let i = 0; i < 7; i++) {
        keys.add(dayMonthKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)));
      }
      return birthday => {
        const key = birthdayDayMonth(birthday);
        return !!key && keys.has(key);
      };
    }
    case 'this_month': {
      const month = pad2(today.getMonth() + 1);
      return birthday => birthdayDayMonth(birthday)?.slice(3) === month;
    }
    default: return null;
  }
}

function genderMatches(filter: CRMGenderFilter, gender: unknown): boolean {
  const value = gender === null || gender === undefined || gender === '' ? null : Number(gender);
  if (filter === 'male') return value === 0;
  if (filter === 'female') return value === 1;
  if (filter === 'unknown') return value === null;
  return true;
}

/** Hàm lọc một dòng liên hệ; null khi không có bộ lọc nào. */
export function createCRMContactFilter(
  filters: CRMContactFilters | null | undefined,
  lookups: CRMFilterLookups = {},
  now: Date = new Date(),
): ((row: CRMFilterRow) => boolean) | null {
  if (!filters || !hasCRMContactFilters(filters)) return null;
  const labelSets = (filters.zaloLabelConversations || []).map(list => new Set((list || []).map(String)));
  const localIds = (filters.localLabelIds || []).map(Number).filter(Number.isFinite);
  const gender = filters.gender && filters.gender !== 'all' ? filters.gender : null;
  const birthday = birthdayMatcher(filters.birthday, dateFromKey(filters.today, now));
  return (row) => {
    const id = String(row.contact_id ?? '');
    if (labelSets.length > 0) {
      // Nhãn Zalo lưu nhóm với tiền tố "g" (vd "g4579…"), contact_id thì không
      const groupKey = row.contact_type === 'group' ? `g${id}` : null;
      if (!labelSets.every(set => set.has(id) || (groupKey !== null && set.has(groupKey)))) return false;
    }
    if (localIds.length > 0) {
      const own = new Set(Array.from(lookups.localLabelsOf?.(id) ?? [], Number));
      if (!localIds.every(labelId => own.has(labelId))) return false;
    }
    if (filters.hasPhone && !row.phone) return false;
    if (filters.hasNotes && !((lookups.noteCountOf?.(id) ?? 0) > 0)) return false;
    if (gender && !genderMatches(gender, row.gender)) return false;
    if (birthday && !birthday(row.birthday)) return false;
    return true;
  };
}
