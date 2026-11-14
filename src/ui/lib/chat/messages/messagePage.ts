/**
 * The newest page of messages when a conversation opens: messages already in memory (chatStore) show at once, and the page read from the DB replaces the array only when
 * it really differs. Replacing it with a new array (even an identical one) redraws every message right after the conversation has just appeared.
 */

/** At most `limit` of the newest messages of the array, sorted old → new (keeps the array as it is if it is not longer). */
export function newestMessages<T>(messages: readonly T[], limit: number): readonly T[] {
  return messages.length > limit ? messages.slice(-limit) : messages;
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
