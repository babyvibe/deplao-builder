/**
 * Encrypted Messenger chats whose older messages stopped loading with "E2EE" in this session: the chat window shows the
 * Messenger PIN bar for them (FacebookEncryptedHistoryBar). A registry plus an event, so a bar mounted after the stop
 * still knows.
 */
export const FB_ENCRYPTED_HISTORY_LOCKED = 'deplao:fbEncryptedHistoryLocked';

const locked = new Set<string>();
const keyOf = (accountId: string, threadId: string) => `${accountId}:${threadId}`;

export function markEncryptedHistoryLocked(accountId: string, threadId: string): void {
  const key = keyOf(accountId, threadId);
  if (locked.has(key)) return;
  locked.add(key);
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FB_ENCRYPTED_HISTORY_LOCKED, { detail: { accountId, threadId } }));
  }
}

export function isEncryptedHistoryLocked(accountId: string, threadId: string): boolean {
  return locked.has(keyOf(accountId, threadId));
}

/** Unlocked with the PIN: every chat of the account can load its old messages now. */
export function clearEncryptedHistoryLocks(accountId: string): void {
  for (const key of Array.from(locked)) if (key.startsWith(`${accountId}:`)) locked.delete(key);
}
