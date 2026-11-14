/**
 * employeeRestRead.ts: the pure part of the employee REST READ path on Boss (HttpRelayService.handleRestApi +
 * RestApiHandlers). No DB / electron imports, so it can be tested directly.
 *
 *  - parseRestQueryParams: query string → params (JSON values `[...]`/`{...}` are parsed, EXCEPT free text typed by the user)
 *  - RestReadCache: short-lived read cache, expires as soon as the DB changes (change marker), only successful results are cached
 *  - toConversationItem / toMessageItem: full DB rows like the IPC path (+ the old normalized fields for old builds)
 *  - labelsVisibleToAccounts / ownedByAccounts / workflowVisibleToAccounts: only data of the assigned accounts
 *  - workflowRowToDto / maskProxyRow: same shape as IPC, no secrets exposed
 */

import { normalizeChannel } from '../../configs/channels/channelConfig';

// ── Query params ───────────────────────────────────────────────────────────────

/**
 * Parameters that are text typed by the user (search, phone numbers...): keep the string as is. Previously "[1,2]" / "{a}" typed in the search box
 * were parsed into an array / object, and the handler then searched wrongly.
 */
export const RAW_TEXT_QUERY_PARAMS: ReadonlySet<string> = new Set(['search', 'q', 'query', 'keyword', 'phone']);

/** `?a=1&ids=["x"]` → `{ a: '1', ids: ['x'] }`. Values that look like a JSON object/array are parsed (RestQueryService sends arrays/objects as JSON). */
export function parseRestQueryParams(queryString: string): Record<string, any> {
  const params: Record<string, any> = {};
  const search = new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString);
  for (const [key, value] of search) {
    if (!RAW_TEXT_QUERY_PARAMS.has(key)
      && ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']')))) {
      try { params[key] = JSON.parse(value); continue; } catch { /* not JSON → keep the string */ }
    }
    params[key] = value;
  }
  return params;
}

// ── Read cache (Boss) ───────────────────────────────────────────────────────────

/** Cache key: method + path + params (internal `_…` keys removed, sorted) + employee. */
export function restCacheKey(method: string, pathname: string, employeeId: string, params?: Record<string, any> | null): string {
  const query = params
    ? Object.keys(params).filter(k => !k.startsWith('_')).sort().map(k => `${k}=${JSON.stringify(params[k])}`).join('&')
    : '';
  return `${method}:${pathname}?${query}:${employeeId}`;
}

interface RestCacheEntry { data: any; ts: number; token: string }

/**
 * Caches REST read results for a few seconds (employees re-request labels / pins / flags after EVERY message, which blocks the main thread).
 * An entry is only used when it has the SAME DB change marker (`token`, see HttpRelayService.restCacheToken) AND is still within the TTL:
 * realtime events are always sent AFTER the DB write, so a reload right after an event never gets a value from before the change.
 * No marker (null) → no cache. Only successful results are stored (`success !== false`).
 */
export class RestReadCache {
  private readonly entries = new Map<string, RestCacheEntry>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  get(key: string, token: string | null, now = Date.now()): any | undefined {
    if (!token) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.token !== token || now - entry.ts >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, token: string | null, data: any, now = Date.now()): void {
    if (!token || data === undefined || data === null || (typeof data === 'object' && data.success === false)) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { data, ts: now, token });
    if (this.entries.size > 50) this.prune(now);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.ts >= this.ttlMs) this.entries.delete(key);
    }
    // Still too many (many employees × params within the same TTL): drop the oldest entry (Map keeps insertion order)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

// ── Row shape (same as the IPC path) ───────────────────────────────────────────

/**
 * Conversations: ALL columns like IPC getContactsFiltered (channel, is_in_others, mute_until, is_forum, telegram_*...),
 * previously only a fixed column list, so employee mode lacked the channel / Telegram topic / flags. The old normalized fields
 * keep their values so employees on old builds read them as before.
 */
export function toConversationItem(c: any): any {
  return {
    ...c,
    contact_id: c?.contact_id,
    owner_zalo_id: c?.owner_zalo_id || '',
    display_name: c?.display_name || '',
    avatar_url: c?.avatar_url || '',
    last_message: c?.last_message || '',
    last_message_time: c?.last_message_time || 0,
    last_message_type: c?.last_message_type || 'text',
    unread_count: c?.unread_count || 0,
    is_group: c?.is_group ? 1 : 0,
    is_muted: c?.is_muted ? 1 : 0,
    is_pinned: false, // the client checks this itself (local pin)
    is_friend: c?.is_friend ? 1 : 0,
    contact_type: c?.contact_type || 0,
    alias: c?.alias || '',
    phone: c?.phone || '',
    gender: c?.gender ?? null,
    birthday: c?.birthday ?? null,
  };
}

/**
 * Messages: ALL columns like IPC db:getMessages (thread_type, status, channel, reply_to_id, is_edited, edit_history,
 * inline_buttons, media_expired...) + the old normalized fields.
 */
export function toMessageItem(m: any): any {
  return {
    ...m,
    msg_id: m?.msg_id,
    cli_msg_id: m?.cli_msg_id,
    thread_id: m?.thread_id,
    owner_zalo_id: m?.owner_zalo_id,
    msg_type: m?.msg_type,
    content: m?.content,
    timestamp: m?.timestamp,
    is_sent: m?.is_sent ? 1 : 0,
    is_recalled: m?.is_recalled ? 1 : 0,
    is_self: m?.is_self ? 1 : 0,
    sender_id: m?.sender_id || '',
    sender_name: m?.sender_name || '',
    reactions: m?.reactions || null,
    attachments: m?.attachments || null,
    local_paths: m?.local_paths || null,
    handled_by_employee: m?.handled_by_employee || null,
    quote_data: m?.quote_data || null,
    topic_id: m?.topic_id || null,
  };
}

// ── Filter by assigned accounts ───────────────────────────────────────────────

function idList(value: unknown): string[] {
  return String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Local labels when NO account is passed (Settings → Labels): shared labels (empty page_ids) + labels attached to at least one
 * assigned account. Previously Boss returned the labels of the FIRST assigned account, so the second account's own labels disappeared.
 */
export function labelsVisibleToAccounts<T extends { page_ids?: unknown }>(labels: T[], accountIds: readonly string[]): T[] {
  const allowed = new Set(accountIds.map(String));
  return (labels || []).filter((label) => {
    const pages = idList(label?.page_ids);
    return pages.length === 0 || pages.some(id => allowed.has(id));
  });
}

/** Row owned by an assigned account (row with no owner = shared → kept). */
export function ownedByAccounts<T extends Record<string, any>>(rows: T[], accountIds: readonly string[], key = 'owner_zalo_id'): T[] {
  const allowed = new Set(accountIds.map(String));
  return (rows || []).filter((row) => {
    const owner = String(row?.[key] ?? '');
    return !owner || allowed.has(owner);
  });
}

/** workflows table row → `Workflow` shape of IPC workflow:list (pageIds array, nodes/edges parsed, enabled boolean). */
export function workflowRowToDto(r: any): any {
  const pageIdsRaw = String(r?.page_ids || r?.page_id || '');
  const pageIds = idList(pageIdsRaw);
  const parse = (raw: unknown) => {
    if (Array.isArray(raw)) return raw;
    try { const v = JSON.parse(String(raw || '[]')); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  return {
    id: r?.id,
    name: r?.name,
    description: r?.description || '',
    enabled: r?.enabled === 1 || r?.enabled === true,
    channel: normalizeChannel(r?.channel ? String(r.channel) : undefined),
    pageId: pageIds[0] || '',
    pageIds,
    nodes: parse(r?.nodes_json ?? r?.nodes),
    edges: parse(r?.edges_json ?? r?.edges),
    createdAt: r?.created_at ?? r?.createdAt,
    updatedAt: r?.updated_at ?? r?.updatedAt,
  };
}

/** Same as workflowIpc (employee): shared workflows (not attached to a page) or attached to at least one assigned account. */
export function workflowVisibleToAccounts(wf: { pageIds?: string[] }, accountIds: readonly string[]): boolean {
  const pages = wf?.pageIds || [];
  if (pages.length === 0) return true;
  const allowed = new Set(accountIds.map(String));
  return pages.some(id => allowed.has(String(id)));
}

/** Proxy: never send the password to an employee machine. */
export function maskProxyRow<T extends Record<string, any>>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  return { ...row, password: row.password ? '***' : '' };
}
