/**
 * The newest page of messages when a conversation opens: messages already in memory (chatStore) show at once, and the page read from the DB replaces the array only when
 * it really differs. Replacing it with a new array (even an identical one) redraws every message right after the conversation has just appeared.
 */

/** At most `limit` of the newest messages of the array, sorted old → new (keeps the array as it is if it is not longer). */
export function newestMessages<T>(messages: readonly T[], limit: number): readonly T[] {
  return messages.length > limit ? messages.slice(-limit) : messages;
}

/** A message being sent from this machine (optimistic copy, temp_ id). */
function isTempMessage(message: { msg_id?: unknown }): boolean {
  return String(message?.msg_id ?? '').startsWith('temp_');
}

/**
 * The newest page read again (connection to the Boss restored, a sync finished) merged into the messages in memory: the page's copy wins (recalls,
 * reactions, edits made meanwhile); older messages already loaded (scrolled up) and messages being sent (temp_) stay. A full page that is entirely
 * newer than memory may leave a gap between the two parts: then only the page and the messages being sent are kept.
 */
export function mergeNewestPage<T extends { msg_id?: unknown; timestamp?: unknown }>(
  cached: readonly T[],
  fresh: readonly T[],
  limit: number,
  compare: (a: T, b: T) => number,
): T[] {
  if (cached.length === 0) return [...fresh];
  const freshIds = new Set(fresh.map((message) => String(message.msg_id)));
  const newestCached = cached.reduce((max, message) => (isTempMessage(message) ? max : Math.max(max, Number(message.timestamp || 0))), 0);
  const oldestFresh = fresh.reduce((min, message) => Math.min(min, Number(message.timestamp || 0)), Number.POSITIVE_INFINITY);
  const kept = fresh.length >= limit && oldestFresh > newestCached
    ? cached.filter(isTempMessage)
    : cached.filter((message) => !freshIds.has(String(message.msg_id)));
  return [...kept, ...fresh].sort(compare);
}

/**
 * The in-memory array is identical to the page just read: same number of messages, same order, each message has the same set of columns, and every value is equal
 * (===). A message that carries extra state only kept in memory (sending, an attachment as an object...) → different → replaced as before.
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
