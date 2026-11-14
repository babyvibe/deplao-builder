/**
 * A reaction tapped in the app (already saved to the DB in handleReact). Zalo sends back an echo (isSelf) of that same reaction
 * to this session; before, the echo was saved too → every tap was counted +2 in the DB (reopening the conversation showed it doubled).
 * Counted per tap, so tapping quickly several times still matches each echo.
 */
const pending = new Map<string, { count: number; at: number }>();
const TTL_MS = 60_000;

const keyOf = (accountId: string, msgId: string, emoji: string) => `${accountId}|${msgId}|${emoji}`;

export function markLocalReaction(accountId: string, msgId: string, emoji: string): void {
  if (!accountId || !msgId || !emoji) return;
  const key = keyOf(accountId, String(msgId), emoji);
  const entry = pending.get(key);
  const now = Date.now();
  pending.set(key, { count: (entry && now - entry.at < TTL_MS ? entry.count : 0) + 1, at: now });
}

/** true if this echo matches one tap in the app (already saved) → do not save it again. */
export function consumeLocalReaction(accountId: string, msgId: string, emoji: string): boolean {
  const key = keyOf(accountId, String(msgId), emoji);
  const entry = pending.get(key);
  if (!entry) return false;
  if (Date.now() - entry.at >= TTL_MS) {
    pending.delete(key);
    return false;
  }
  if (entry.count <= 1) pending.delete(key);
  else pending.set(key, { count: entry.count - 1, at: entry.at });
  return true;
}
