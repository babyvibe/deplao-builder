/**
 * Contact search for the workflow contact picker (main process + tests).
 *
 * The picker used to load every contact of an account over IPC and render them all. The main
 * process now filters, ranks and pages them: search is accent-insensitive ("duong" finds "Dương"),
 * counts per type follow the search, and only one page crosses IPC.
 */

export type PickerContactType = 'user' | 'group';

export interface PickerContactRow {
  contact_id: string;
  display_name?: string | null;
  alias?: string | null;
  avatar_url?: string | null;
  phone?: string | null;
  contact_type?: string | null;
  is_friend?: number | null;
  last_message_time?: number | null;
}

export interface PickerContact {
  id: string;
  /** Alias (tên gợi nhớ) when set, else the display name. */
  name: string;
  /** Display name when it differs from the alias shown as `name`. */
  originalName?: string;
  avatar?: string;
  phone?: string;
  type: PickerContactType;
  isFriend: boolean;
  /** last_message_time (ms), 0 = never. */
  lastActivity: number;
}

export interface PickerSearchOptions {
  search?: string;
  type?: PickerContactType | 'all';
  limit?: number;
  offset?: number;
  /** Look these ids up (selected items), ignoring search / type / paging. */
  ids?: string[];
}

export interface PickerSearchResult {
  items: PickerContact[];
  /** Matches of the current type filter (for paging). */
  total: number;
  /** Matches of the search per type (for the tabs). */
  counts: { all: number; user: number; group: number };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Lowercase, without Vietnamese accents (đ → d), trimmed. */
export function foldVietnamese(text: unknown): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

export function toPickerContact(row: PickerContactRow): PickerContact {
  const isGroup = row.contact_type === 'group';
  const id = String(row.contact_id);
  const alias = String(row.alias ?? '').trim();
  const display = String(row.display_name ?? '').trim();
  return {
    id,
    name: alias || display || (isGroup ? `Nhóm ${id}` : `Người dùng ${id}`),
    originalName: alias && display && alias !== display ? display : undefined,
    avatar: row.avatar_url || undefined,
    phone: row.phone || undefined,
    type: isGroup ? 'group' : 'user',
    isFriend: row.contact_type === 'friend' || Number(row.is_friend) === 1,
    lastActivity: Number(row.last_message_time) || 0,
  };
}

function countByType(contacts: PickerContact[]): PickerSearchResult['counts'] {
  let group = 0;
  for (const contact of contacts) if (contact.type === 'group') group++;
  return { all: contacts.length, user: contacts.length - group, group };
}

/**
 * Relevance of `contact` for the folded query `q` (0 = no match). Exact id > exact name > name
 * prefix > word prefix > substring (name / original name) > digits in phone / id.
 */
function matchScore(contact: PickerContact, q: string, digits: string): number {
  if (contact.id === q) return 100;
  const name = foldVietnamese(contact.name);
  if (name === q) return 90;
  if (name.startsWith(q)) return 80;
  if (name.split(/\s+/).some(word => word.startsWith(q))) return 70;
  if (name.includes(q) || foldVietnamese(contact.originalName).includes(q)) return 60;
  if (digits.length >= 3) {
    const phoneDigits = String(contact.phone ?? '').replace(/\D/g, '');
    if (phoneDigits.includes(digits) || contact.id.includes(digits)) return 50;
  }
  return 0;
}

export function searchPickerContacts(rows: PickerContactRow[], opts: PickerSearchOptions = {}): PickerSearchResult {
  const contacts = rows.filter(row => row && row.contact_id).map(toPickerContact);

  if (Array.isArray(opts.ids) && opts.ids.length > 0) {
    const wanted = new Set(opts.ids.map(String));
    const items = contacts.filter(contact => wanted.has(contact.id));
    return { items, total: items.length, counts: countByType(items) };
  }

  const q = foldVietnamese(opts.search);
  const digits = q.replace(/\D/g, '');
  const matched: Array<{ contact: PickerContact; score: number }> = [];
  for (const contact of contacts) {
    const score = q ? matchScore(contact, q, digits) : 1;
    if (score > 0) matched.push({ contact, score });
  }

  const counts = countByType(matched.map(entry => entry.contact));
  const type = opts.type === 'user' || opts.type === 'group' ? opts.type : 'all';
  const filtered = type === 'all' ? matched : matched.filter(entry => entry.contact.type === type);
  filtered.sort((a, b) =>
    b.score - a.score
    || b.contact.lastActivity - a.contact.lastActivity
    || a.contact.name.localeCompare(b.contact.name, 'vi'));

  const requested = Math.floor(Number(opts.limit));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
  const start = Math.max(0, Math.floor(Number(opts.offset) || 0));
  return {
    items: filtered.slice(start, start + limit).map(entry => entry.contact),
    total: filtered.length,
    counts,
  };
}
