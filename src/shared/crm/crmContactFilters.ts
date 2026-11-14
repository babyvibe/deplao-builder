/**
 * Filters for the CRM contact list: Zalo label, Local label, Has phone number, Has note, Gender, Birthday.
 *
 * Runs in `DatabaseService.getCRMContacts` BEFORE the page is cut, so the total, the paging and "Xuất CSV" (Export CSV) count all
 * contacts matching the filters. Before, CRMPage filtered only the page being loaded (200 rows): contacts on other pages never
 * matched, the total became the row count of the page (the paging bar disappeared), and Export CSV ignored the filters.
 *
 * Zalo labels only exist in the renderer (fetched from the Zalo API, not stored in the DB), so the renderer sends the conversation list of each label along.
 * Pure (no DB, no React). Test: src/__tests__/crm/crmContactFilters.test.ts.
 */
import { localDayKey } from '../analytics/localTimeBuckets';

export type CRMGenderFilter = 'all' | 'male' | 'female' | 'unknown';
export type CRMBirthdayFilter = 'all' | 'has_birthday' | 'no_birthday' | 'today' | 'this_week' | 'this_month';

export interface CRMContactFilters {
  /** Each item = the conversation list of ONE selected Zalo label; a contact must belong to all of them. */
  zaloLabelConversations?: string[][];
  /** Selected Local labels; a contact must have all of them. */
  localLabelIds?: number[];
  hasPhone?: boolean;
  hasNotes?: boolean;
  gender?: CRMGenderFilter;
  birthday?: CRMBirthdayFilter;
  /** "Hôm nay" (today) date by the viewer's machine ('YYYY-MM-DD'), used for Today / This week / This month; missing → the date of the querying machine. */
  today?: string;
}

/** The columns of one getCRMContacts row that the filter reads. */
export interface CRMFilterRow {
  contact_id: string;
  contact_type?: string | null;
  phone?: string | null;
  gender?: number | null;
  birthday?: string | null;
}

export interface CRMFilterLookups {
  /** Local labels assigned to the conversation `contactId`. */
  localLabelsOf?: (contactId: string) => Iterable<number> | undefined;
  /** Number of CRM notes of the contact. */
  noteCountOf?: (contactId: string) => number;
}

/** Filter state of the Contacts page (crmStore). */
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

/** Filter sent to getCRMContacts from the Contacts page state; `undefined` when nothing is filtered. */
export function buildCRMContactFilters(
  state: CRMFilterState,
  zaloLabels: ReadonlyArray<{ id: number; conversations?: readonly string[] | null }>,
  now: Date = new Date(),
): CRMContactFilters | undefined {
  const filters: CRMContactFilters = {};
  if (state.filterLabelIds.length > 0) {
    // Label not loaded / deleted → empty list → no contact matches (same as the old filter)
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

/** "DD/MM" of a birthday in DD/MM/YYYY form (accepts a 1-digit day / month); null if it cannot be read. */
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

/** Today = same day/month; This week = the 7 days from today; This month = same month. */
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

/** Filter function for one contact row; null when there is no filter. */
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
      // Zalo labels store groups with the prefix "g" (e.g. "g4579…"), but contact_id does not have it
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
