/**
 * triggerFilters.ts
 *
 * Pure helpers for the extended trigger / audience filters of the Workflow Engine.
 * Does NOT import Electron, DB or zca-js → can be used in the main process and unit-tested directly
 * (src/__tests__/workflow/workflowTriggerFilters.test.ts).
 *
 * Every config key is optional: when it is missing / empty / at a neutral value, the filter has NO effect
 * → old workflows run exactly as before.
 *
 *  - ID list (excludeSenderIds / excludeThreadIds / includeThreadIds / excludeIds): a JSON array from the contact
 *    picker '["1","2"]', a single id '1234', ids separated by commas / new lines, or a real array.
 *    The trigger filter reads the RAW config (template not rendered yet) → items containing "{{" are ignored.
 *  - Thread lists of the message triggers: includeThreadIds (empty = every chat, else only those chats) and
 *    excludeThreadIds; an id in both lists is excluded (isThreadAllowed).
 *  - Active hours: { mode: 'always' | 'inside' | 'outside', start: 'HH:mm', end: 'HH:mm', days: number[] }
 *    computed in Vietnam time (UTC+7, no DST); days by getDay(): 0 = Sunday … 6 = Saturday.
 *  - senderRole: 'all' | 'owner' | 'deputy' | 'admins' | 'members'.
 *  - cooldownMinutes: number of minutes ≥ 0 (0 = off).
 */

export type ZaloGroupRole = 'owner' | 'deputy' | 'member';

export type ActiveHoursMode = 'always' | 'inside' | 'outside';

export interface ActiveHoursConfig {
  mode?: ActiveHoursMode;
  start?: string;
  end?: string;
  days?: number[];
}

/** The Zalo message type groups supported by the messageTypes filter. */
export const ZALO_MESSAGE_KINDS = ['text', 'image', 'sticker', 'file', 'voice', 'video', 'link', 'other'] as const;
export type ZaloMessageKind = typeof ZALO_MESSAGE_KINDS[number];

// ─── ID list ──────────────────────────────────────────────────────────────────

const ID_SEPARATORS = /[,;\r\n]+/;
const TEMPLATE_SEGMENT = /\{\{[\s\S]*?\}\}/g;

function idFromEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'number') return Number.isFinite(entry) ? String(entry) : '';
  if (typeof entry === 'bigint') return entry.toString();
  if (entry && typeof entry === 'object') {
    // Just in case: an array of objects (e.g. items of logic.forEachContact): { id | threadId | userId | uid }
    const obj = entry as Record<string, unknown>;
    const id = obj.id ?? obj.threadId ?? obj.userId ?? obj.uid;
    return typeof id === 'string' || typeof id === 'number' ? String(id).trim() : '';
  }
  return '';
}

function splitIdText(text: string): string[] {
  return text
    // A {{ ... }} segment may contain commas → keep the whole segment so that the item is skipped entirely
    .replace(TEMPLATE_SEGMENT, segment => segment.replace(/[,;\r\n]/g, ' '))
    .split(ID_SEPARATORS)
    // Broken JSON / has bare numbers ('[1, "2"') → strip the square brackets and the quotes around each item
    .map(token => token.trim().replace(/^[\s["']+|[\s\]"']+$/g, ''));
}

function collectIdEntries(value: unknown, depth: number): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(idFromEntry);
  if (typeof value === 'number' || typeof value === 'bigint') return [idFromEntry(value)];
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  // Only JSON.parse when it looks like an array / JSON string: a Zalo uid of ~19 digits would lose precision
  // if it were parsed into a number ('8123456789012345678' → 8123456789012345000).
  if (depth < 2 && (text.startsWith('[') || text.startsWith('"'))) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && !parsed.some(item => typeof item === 'number')) return parsed.map(idFromEntry);
      if (typeof parsed === 'string') return collectIdEntries(parsed, depth + 1);
    } catch {
      /* not valid JSON → split by the separators below */
    }
  }
  return splitIdText(text);
}

/**
 * Normalize an "ID list" to an array of ids (trimmed non-empty strings, no duplicates, order kept).
 * Accepts: a JSON array '["1","2"]', a single id '1234', '1, 2' / '1\n2', a real array, '' / undefined.
 * Items containing "{{" (template not rendered yet) are ignored.
 */
export function parseIdList(value: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of collectIdEntries(value, 0)) {
    if (!id || id.includes('{{') || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** true when `id` (compared as a trimmed string) is in the ID list `list`. Empty id → false. */
export function isExcludedId(list: unknown, id: unknown): boolean {
  if (id === null || id === undefined) return false;
  const needle = String(id).trim();
  if (!needle) return false;
  return parseIdList(list).includes(needle);
}

/** true when the ID list has at least one entry, usable or not (a "{{ … }}" item counts): '' / '[]' / undefined → false. */
export function hasIdListEntries(value: unknown): boolean {
  return collectIdEntries(value, 0).some(entry => entry !== '');
}

/**
 * Thread allow / deny lists of the message triggers (includeThreadIds / excludeThreadIds).
 *  - excludeThreadIds: the listed threads never trigger; it wins, so an id in both lists is excluded.
 *  - includeThreadIds: empty / missing = no effect; otherwise only the listed threads trigger. A list with entries
 *    but no usable id (only "{{ … }}" templates) lets nothing through: an allow-list never turns into "everyone".
 */
export function isThreadAllowed(includeList: unknown, excludeList: unknown, threadId: unknown): boolean {
  if (isExcludedId(excludeList, threadId)) return false;
  if (!hasIdListEntries(includeList)) return true;
  const needle = threadId === null || threadId === undefined ? '' : String(threadId).trim();
  return needle !== '' && parseIdList(includeList).includes(needle);
}

// ─── Active hours ─────────────────────────────────────────────────────────────

const VN_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const STRICT_HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:mm' (00:00-23:59, exactly 2 digits for the hour) → minutes since midnight; wrong format → null. */
function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = STRICT_HH_MM.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** days → set of 0..6; missing / empty / no valid value → null (= every day). */
function parseActiveDays(value: unknown): Set<number> | null {
  if (!Array.isArray(value)) return null;
  const days = new Set<number>();
  for (const item of value) {
    const day = typeof item === 'number' ? item : (typeof item === 'string' && item.trim() !== '' ? Number(item) : NaN);
    if (Number.isInteger(day) && day >= 0 && day <= 6) days.add(day);
  }
  return days.size > 0 ? days : null;
}

/**
 * true when the trigger is ALLOWED to fire at the time `nowMs`.
 *  - cfg missing / invalid / mode 'always' / wrong time format → true (no filtering).
 *  - 'inside'  → only when now ∈ [start, end) on a selected day.
 *  - 'outside' → only when NOT inside that window.
 * start > end: the window crosses midnight and belongs to the start day (Mon 22:00-06:00 = Mon 22:00 → Tue 06:00).
 * start === end: the whole day.
 */
export function isWithinActiveHours(cfg: unknown, nowMs: number): boolean {
  let config: unknown = cfg;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return true; }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return true;
  const { mode, start, end, days } = config as Record<string, unknown>;
  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (normalizedMode !== 'inside' && normalizedMode !== 'outside') return true;
  const startMin = parseClockMinutes(start);
  const endMin = parseClockMinutes(end);
  if (startMin === null || endMin === null) return true;

  const allowedDays = parseActiveDays(days);
  const isDayAllowed = (day: number) => !allowedDays || allowedDays.has(day);

  // Vietnam time is computed arithmetically from the epoch, independent of the machine's timezone
  const vnNow = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + VN_UTC_OFFSET_MS);
  const today = vnNow.getUTCDay();
  const minuteOfDay = vnNow.getUTCHours() * 60 + vnNow.getUTCMinutes();

  let inWindow: boolean;
  if (startMin === endMin) {
    inWindow = isDayAllowed(today);
  } else if (startMin < endMin) {
    inWindow = isDayAllowed(today) && minuteOfDay >= startMin && minuteOfDay < endMin;
  } else if (minuteOfDay >= startMin) {
    inWindow = isDayAllowed(today);                 // the part before midnight of today's window
  } else if (minuteOfDay < endMin) {
    inWindow = isDayAllowed((today + 6) % 7);       // the part after midnight of yesterday's window
  } else {
    inWindow = false;
  }
  return normalizedMode === 'inside' ? inWindow : !inWindow;
}

// ─── Zalo message type ────────────────────────────────────────────────────────

const ZALO_MSG_TYPE_KIND = new Map<string, ZaloMessageKind>([
  ['webchat', 'text'],
  ['chat.photo', 'image'], ['photo', 'image'], ['image', 'image'], ['chat.gif', 'image'],
  ['chat.sticker', 'sticker'], ['sticker', 'sticker'],
  ['share.file', 'file'],
  ['chat.voice', 'voice'], ['voice', 'voice'], ['audio', 'voice'],
  ['chat.video.msg', 'video'], ['video', 'video'],
  ['share.link', 'link'], ['chat.link', 'link'],
]);

/** content.action of a chat.recommended message (object or JSON string). */
function recommendedAction(content: unknown): string {
  let value: unknown = content;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return ''; }
  }
  const action = value && typeof value === 'object' ? (value as { action?: unknown }).action : undefined;
  return typeof action === 'string' ? action.trim().toLowerCase() : '';
}

/** zca-js msgData.msgType → text | image | sticker | file | voice | video | link | other. */
export function classifyZaloMessageType(msgType: unknown, content: unknown): ZaloMessageKind {
  const type = msgType === null || msgType === undefined ? '' : String(msgType).trim().toLowerCase();
  // chat.recommended also carries links, contact cards (recommened.user / .vip) and call logs
  // (recommened.calltime / .misscall) → only "link" when the action is link
  if (type === 'chat.recommended' || type === 'chat.recommend') {
    const action = recommendedAction(content);
    return action === 'recommened.link' || action === 'recommended.link' ? 'link' : 'other';
  }
  if (type) return ZALO_MSG_TYPE_KIND.get(type) ?? 'other';
  // Payload has no msgType (old event / relay): string content = text message
  return typeof content === 'string' ? 'text' : 'other';
}

/**
 * Text of a Zalo message for the keyword filter, read like flattenTriggerData ($trigger.content): content.msg, else
 * content.title (a link card keeps the typed text there: "/lenh https://…"), else a link card's href.
 */
export function zaloMessageText(content: unknown, msgType?: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const obj = content as Record<string, unknown>;
  const pick = (value: unknown) => (typeof value === 'string' ? value : '');
  const text = pick(obj.msg) || pick(obj.title);
  if (text) return text;
  const type = msgType === null || msgType === undefined ? '' : String(msgType).trim().toLowerCase();
  return type === 'chat.recommended' || type === 'chat.link' ? pick(obj.href) : '';
}

/** messageTypes from the config → array of types (lowercase, no duplicates); empty / 'all' = no filtering. */
export function normalizeMessageTypes(value: unknown): string[] {
  const types = parseIdList(value).map(type => type.toLowerCase());
  return types.includes('all') ? [] : [...new Set(types)];
}

// ─── Mentions ─────────────────────────────────────────────────────────────────

/**
 * true when the mentions list (zca-js TMention[]) @mentions the account `accountId`
 * or @All (type === 1 or uid === '-1').
 */
export function mentionsAccount(mentions: unknown, accountId: string): boolean {
  let list: unknown = mentions;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return false; }
  }
  if (!Array.isArray(list)) return false;
  const self = accountId === null || accountId === undefined ? '' : String(accountId).trim();
  return list.some(item => {
    if (!item || typeof item !== 'object') return false;
    const mention = item as Record<string, unknown>;
    const uid = mention.uid === null || mention.uid === undefined ? '' : String(mention.uid).trim();
    if (Number(mention.type) === 1 || uid === '-1') return true;   // @All
    return self !== '' && uid === self;
  });
}

// ─── Sender role ──────────────────────────────────────────────────────────────

function normalizeSenderRole(senderRole: unknown): string {
  return typeof senderRole === 'string' ? senderRole.trim().toLowerCase() : '';
}

/** true when senderRole takes effect (not missing / empty / 'all') → the role must be looked up, and personal messages are excluded. */
export function hasSenderRoleFilter(senderRole: unknown): boolean {
  const role = normalizeSenderRole(senderRole);
  return role !== '' && role !== 'all';
}

/** Normalize a Zalo uid: trim + remove the version suffix "_0" ("123_0" → "123"), as getGroupInfo sometimes returns it. */
export function normalizeZaloUid(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/_\d+$/, '');
}

/** Sender's role in the group: creatorId → owner, adminIds → deputy, everything else → member. */
export function resolveZaloGroupRole(senderId: unknown, creatorId: unknown, adminIds: readonly unknown[] | null | undefined): ZaloGroupRole {
  const sender = normalizeZaloUid(senderId);
  if (!sender) return 'member';
  if (sender === normalizeZaloUid(creatorId)) return 'owner';
  return (adminIds || []).some(id => normalizeZaloUid(id) === sender) ? 'deputy' : 'member';
}

/**
 * Role matrix: all → every role; owner → group owner; deputy → group deputy;
 * admins → owner or deputy; members → regular members. Unknown value → no match.
 */
export function isRoleAllowed(role: ZaloGroupRole, senderRole: string): boolean {
  switch (normalizeSenderRole(senderRole)) {
    case '':
    case 'all': return true;
    case 'owner': return role === 'owner';
    case 'deputy': return role === 'deputy';
    case 'admins': return role === 'owner' || role === 'deputy';
    case 'members': return role === 'member';
    default: return false;
  }
}

// ─── Cooldown ─────────────────────────────────────────────────────────────────

/** cooldownMinutes → milliseconds; missing / ≤ 0 / not a number → 0 (off). */
export function parseCooldownMs(value: unknown): number {
  const minutes = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60 * 1000) : 0;
}

/** true when the last run (`lastRunAt`) is still inside the cooldown at `nowMs`. */
export function isCooldownActive(lastRunAt: number | undefined, nowMs: number, cooldownMs: number): boolean {
  if (lastRunAt === undefined || !(cooldownMs > 0)) return false;
  return nowMs - lastRunAt < cooldownMs;
}
