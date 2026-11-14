/**
 * chatLoadFailures.ts: employee mode, the screens inside chat (Photo/Video · File · Link panel, the conversation's Local labels):
 * a failed read (DataAccessor returns `success: false`, see agents/REFERENCES/EMPLOYEE_MODE.md §2.2) KEEPS the data on screen
 * instead of turning it into an empty list, and does not stop the list or jump pages.
 * Pure (no store / IPC / DataAccessor). Test: src/__tests__/chat/conversations/chatLoadFailures.test.ts.
 */

/** Same condition as `isReadFailure` in DataAccessor (this module does not import DataAccessor so it stays pure). */
function isFailure(res: unknown): boolean {
  return !!res && typeof res === 'object' && (res as { success?: unknown }).success === false;
}

// ── Photo/Video · File · Link panel (MediaSection) ──────────────────────────────

export type MediaPanelTab = 'image' | 'file' | 'link';

/** One page of the panel, with the same shape that `nextConversationPaging` (DataAccessor) receives. */
export interface MediaPanelPage {
  success: boolean;
  error?: string;
  /** The rows the server returns (not filtering out rows that cannot be displayed): the offset of the next page = total rows received. */
  items: any[];
  /** A full page → there may be more pages. */
  hasMore: boolean;
}

/**
 * Normalizes the response of one page: getMediaMessages / getFileMessages → `messages` (REST also has `items`), getLinks →
 * `links`. An error (`success: false`, or no response because the call threw) → `success: false`, NOT "hết" (end of list).
 */
export function toMediaPanelPage(tab: MediaPanelTab, res: unknown, limit: number): MediaPanelPage {
  if (!res || typeof res !== 'object' || isFailure(res)) {
    const error = (res as { error?: unknown } | null | undefined)?.error;
    return { success: false, error: typeof error === 'string' && error ? error : undefined, items: [], hasMore: false };
  }
  const r = res as { messages?: unknown; items?: unknown; links?: unknown };
  const raw = tab === 'link' ? r.links : (r.messages ?? r.items);
  const items = Array.isArray(raw) ? raw : [];
  return { success: true, items, hasMore: items.length >= Math.max(1, Math.floor(limit) || 1) };
}

/** Key of one panel row (message: msg_id; link: id, or else msg_id + url). '' = unknown. */
export function mediaPanelRowKey(tab: MediaPanelTab, row: any): string {
  if (!row || typeof row !== 'object') return '';
  if (tab === 'link') {
    if (row.id !== undefined && row.id !== null && row.id !== '') return `l:${row.id}`;
    return row.url ? `l:${row.msg_id ?? ''}:${row.url}` : '';
  }
  return row.msg_id !== undefined && row.msg_id !== null && row.msg_id !== '' ? `m:${row.msg_id}` : '';
}

/**
 * Appends the next page to the current list and drops rows already there (new media arriving while scrolling shifts the offset → the next page
 * repeats a few of the last rows). Rows without a key are always added. Returns `prev` when no row could be added.
 */
export function appendMediaPanelRows(tab: MediaPanelTab, prev: any[], rows: any[]): any[] {
  if (!rows || !rows.length) return prev;
  const seen = new Set<string>();
  for (const row of prev) {
    const key = mediaPanelRowKey(tab, row);
    if (key) seen.add(key);
  }
  const added: any[] = [];
  for (const row of rows) {
    const key = mediaPanelRowKey(tab, row);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    added.push(row);
  }
  return added.length ? [...prev, ...added] : prev;
}

/**
 * The newest page reloaded (BOSS connection restored): adds the rows not yet there to the top (new media during the disconnect),
 * keeps what was already loaded. `added` = number of rows added → the offset of the next page goes up by that much. `gap`: when the whole page is
 * new rows, there may still be unloaded rows between this page and the old list → the caller reloads from the start.
 * Rows without a key are skipped (unknown whether they are already there). Returns `items === prev` when nothing is new.
 */
export function prependMediaPanelRows(
  tab: MediaPanelTab,
  prev: any[],
  rows: any[],
  limit: number,
): { items: any[]; added: number; gap: boolean } {
  const seen = new Set<string>();
  for (const row of prev) {
    const key = mediaPanelRowKey(tab, row);
    if (key) seen.add(key);
  }
  const fresh: any[] = [];
  for (const row of rows || []) {
    const key = mediaPanelRowKey(tab, row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(row);
  }
  const full = (rows || []).length >= Math.max(1, Math.floor(limit) || 1);
  return {
    items: fresh.length ? [...fresh, ...prev] : prev,
    added: fresh.length,
    gap: prev.length > 0 && full && fresh.length === rows.length,
  };
}

// ── Local labels of the open conversation (ChatHeader, MessageInput) ───────────────

export interface ThreadLocalLabelsState<L> {
  /** Accounts of the `labels` catalog (null = not loaded for any account yet). */
  labelsAccountId: string | null;
  labels: L[];
  /** Conversation (threadLabelsKey) of `threadLabelIds` (null = not loaded). */
  threadKey: string | null;
  /** IDs of the Local labels attached to the conversation. */
  threadLabelIds: Set<number>;
  /** The latest load had a failed part → show "Thử lại" (Retry). */
  failed: boolean;
}

const NO_LABELS: never[] = [];
const NO_LABEL_IDS: Set<number> = new Set();

/** No conversation / account yet (or just reset). Shared: do not edit `threadLabelIds` directly. */
export const EMPTY_THREAD_LOCAL_LABELS: ThreadLocalLabelsState<never> = Object.freeze({
  labelsAccountId: null,
  labels: NO_LABELS,
  threadKey: null,
  threadLabelIds: NO_LABEL_IDS,
  failed: false,
}) as ThreadLocalLabelsState<never>;

export function threadLabelsKey(accountId: string, threadId: string): string {
  return `${accountId}\u0001${threadId}`;
}

/** Local labels that are on, ordered by sort_order then name (the order on the label bar of the input / header). */
export function sortActiveLocalLabels<L = any>(raw: unknown): L[] {
  const list: any[] = Array.isArray(raw) ? raw : [];
  return list
    .filter((l: any) => (l?.is_active ?? 1) === 1)
    .sort((a: any, b: any) => {
      const sa = Number(a?.sort_order ?? 0);
      const sb = Number(b?.sort_order ?? 0);
      if (sa !== sb) return sa - sb;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    }) as L[];
}

/** IDs of the labels from getThreadLocalLabels (`labels: [{ id }]`). */
export function toLabelIdSet(raw: unknown): Set<number> {
  const list: any[] = Array.isArray(raw) ? raw : [];
  return new Set(list.map((l: any) => Number(l?.id)));
}

/**
 * State after one load of the conversation's Local labels. `labels` / `threadLabelIds` = null when the matching read failed:
 * keep the old data if it is the same account (label catalog) / the same conversation (attached labels); if different → empty = "chưa biết" (unknown)
 * (do not take the labels of the previous conversation and assign them to this one). Returns `prev` when nothing changed (React skips the render).
 */
export function nextThreadLocalLabels<L>(
  prev: ThreadLocalLabelsState<L>,
  accountId: string,
  threadId: string,
  labels: L[] | null,
  threadLabelIds: Set<number> | null,
): ThreadLocalLabelsState<L> {
  const key = threadLabelsKey(accountId, threadId);
  const sameAccount = prev.labelsAccountId === accountId;
  const sameThread = prev.threadKey === key;
  const next: ThreadLocalLabelsState<L> = {
    labelsAccountId: labels || sameAccount ? accountId : null,
    labels: labels ?? (sameAccount ? prev.labels : NO_LABELS),
    threadKey: threadLabelIds || sameThread ? key : null,
    threadLabelIds: threadLabelIds ?? (sameThread ? prev.threadLabelIds : NO_LABEL_IDS),
    failed: !labels || !threadLabelIds,
  };
  return next.labelsAccountId === prev.labelsAccountId && next.labels === prev.labels
    && next.threadKey === prev.threadKey && next.threadLabelIds === prev.threadLabelIds && next.failed === prev.failed
    ? prev
    : next;
}
