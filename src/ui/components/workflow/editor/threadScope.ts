/**
 * threadScope.ts: pure rules of ThreadScopeField ("Chat / nhóm áp dụng" of the message triggers), kept free of React
 * and IPC so tests can import them. Two config keys, one mode:
 *  - 'all'     → includeThreadIds and excludeThreadIds empty (no filter, as before);
 *  - 'include' → includeThreadIds: only these chats start the workflow;
 *  - 'exclude' → excludeThreadIds (the former "Loại trừ hội thoại / nhóm" field).
 */

export type ThreadScope = 'all' | 'include' | 'exclude';
export type ThreadListKey = 'includeThreadIds' | 'excludeThreadIds';

export const THREAD_LIST_KEY: Record<Exclude<ThreadScope, 'all'>, ThreadListKey> = {
  include: 'includeThreadIds',
  exclude: 'excludeThreadIds',
};

/** true when a picker value (JSON array string, a single id or a real array) holds at least one id. */
export function hasPickedIds(value: unknown): boolean {
  const filled = (items: unknown[]) => items.some(item => String(item ?? '').trim() !== '');
  if (Array.isArray(value)) return filled(value);
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return filled(parsed);
  } catch {
    /* a single plain id */
  }
  return true;
}

/** Mode shown for a saved config: a non-empty include list wins, then a non-empty exclude list. */
export function threadScopeOf(config: Record<string, any>): ThreadScope {
  if (hasPickedIds(config.includeThreadIds)) return 'include';
  if (hasPickedIds(config.excludeThreadIds)) return 'exclude';
  return 'all';
}

/** The contact picker works on strings: a real array (e.g. set through API v1) becomes its JSON form. */
export function threadListValue(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => String(item)));
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Config changes for choosing `next` while the saved lists show `saved`, only keys that really change: the picked
 * chats move to the other key; 'all' clears the filled keys.
 */
export function threadScopePatch(config: Record<string, any>, saved: ThreadScope, next: ThreadScope): Record<string, string> {
  const patch: Record<string, string> = {};
  if (next === 'all') {
    for (const key of Object.values(THREAD_LIST_KEY)) if (hasPickedIds(config[key])) patch[key] = '';
    return patch;
  }
  if (saved === 'all' || saved === next) return patch;
  patch[THREAD_LIST_KEY[next]] = threadListValue(config[THREAD_LIST_KEY[saved]]);
  patch[THREAD_LIST_KEY[saved]] = '';
  return patch;
}
