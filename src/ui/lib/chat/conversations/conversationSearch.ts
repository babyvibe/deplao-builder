/**
 * Filters contacts / friends in the search box of the conversation list (GlobalSearchPanel).
 *
 * Previously, on every keystroke, each contact called matchQuery on 4 fields and normalized the Unicode of both the name and the keyword again
 * (up to 16 NFC / NFD normalizations + regex per contact, plus the friend list). Now each row's search key is computed ONCE when the list changes (buildSearchIndex in useMemo), the keyword is folded once, and matched with includes.
 * Matches more widely than before: accents are removed and "đ" → "d" too ("duc" matches "Đức"), like the group member search box (deplao_fold).
 */
import { foldSearchText } from '../../../../shared/chat/searchFold';

const ZERO_WIDTH = /[\u200b-\u200f\uFEFF]/g;
/** Separates the fields in one key: characters that cannot be typed, so a keyword does not match across two fields. */
const FIELD_SEPARATOR = '\u0001';

/** Removes accents ("đ" → "d" too), lowercase, drops zero-width characters, collapses spaces: used for both the key and the keyword. */
export function foldForSearch(value: unknown): string {
  if (value === null || value === undefined) return '';
  return foldSearchText(String(value).replace(ZERO_WIDTH, '').replace(/\s+/g, ' '));
}

/** Search key of one row from its fields (memo name, name, phone, code…). */
export function searchKeyOf(fields: ReadonlyArray<unknown>): string {
  return fields.map(foldForSearch).join(FIELD_SEPARATOR);
}

export interface SearchIndexEntry<T> {
  item: T;
  key: string;
}

/**
 * Keys are computed per object (each function gets its own memory for the fields). The store updates immutably
 * (chatStore.updateContact replaces the object of the conversation that changed), so when a new message makes the list change reference,
 * only the conversation that changed has to recompute its key, not all ~2,000 rows (~27 ms) for every message while searching.
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

/** Computes the keys for the whole list in advance: called in useMemo by the list, not by the keyword. */
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

/** Rows whose key contains the folded keyword (foldForSearch); an empty keyword → no rows. */
export function filterSearchIndex<T>(index: readonly SearchIndexEntry<T>[], needle: string): T[] {
  if (!needle) return [];
  const out: T[] = [];
  for (const entry of index) if (entry.key.includes(needle)) out.push(entry.item);
  return out;
}

/** Whether one row matches the (folded) keyword: for a small list (results of the Boss-side search). */
export function matchesSearch(fields: ReadonlyArray<unknown>, needle: string): boolean {
  return !!needle && searchKeyOf(fields).includes(needle);
}

/** Fields used for searching a conversation / contact. */
export const contactSearchFields = (c: any): unknown[] => [c?.alias, c?.display_name, c?.phone, c?.contact_id];
/** Fields used for searching a friend (friends table). */
export const friendSearchFields = (f: any): unknown[] => [f?.displayName, f?.phoneNumber, f?.userId];

/** Messages: a keyword shorter than this many characters (e.g. 1 letter) only filters the contacts, it does not query the DB. */
export const MESSAGE_SEARCH_MIN_LENGTH = 2;
/** Wait for typing to stop before searching messages (the DB query now takes ≤ ~20 ms, so this waits less than the old 300 ms). */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 200;
