/**
 * bankCardCache: temporarily keeps the bank card data when sending, so the UI can display it nicely.
 *
 * Flow:
 *  1. BankCardModal calls cacheSentBankCard() BEFORE sending to the API
 *  2. The webhook echo comes back → BankCardBubble calls getCachedBankCard() to get the data
 *  3. Renders its own UI instead of using an iframe / img
 */

export interface BankCardData {
  binBank: number;
  bankName: string;
  numAccBank: string;
  nameAccBank: string;
  /** Timestamp when sent, used for matching + cleanup */
  sentAt: number;
}

// Cache: key = `${ownerZaloId}:${threadId}` → array of recent sent cards (LIFO)
const cache = new Map<string, BankCardData[]>();

/** Saves the bank card data when sending */
export function cacheSentBankCard(ownerZaloId: string, threadId: string, data: Omit<BankCardData, 'sentAt'>): void {
  const key = `${ownerZaloId}:${threadId}`;
  const list = cache.get(key) || [];
  list.push({ ...data, sentAt: Date.now() });
  // Keep at most 20 entries, delete the old ones
  if (list.length > 20) list.splice(0, list.length - 20);
  cache.set(key, list);
}

/**
 * Finds the cached bank card data for the message just sent.
 * Matches by threadId + the closest timestamp (within 30 seconds).
 * Consume = remove it from the cache after reading it.
 */
export function getCachedBankCard(ownerZaloId: string, threadId: string, msgTimestamp: number): BankCardData | null {
  const key = `${ownerZaloId}:${threadId}`;
  const list = cache.get(key);
  if (!list || list.length === 0) return null;

  // Find the closest entry within 60s
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = list.length - 1; i >= 0; i--) {
    const diff = Math.abs(msgTimestamp - list[i].sentAt);
    if (diff < 60000 && diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0) {
    const data = list[bestIdx];
    list.splice(bestIdx, 1); // consume
    if (list.length === 0) cache.delete(key);
    return data;
  }

  return null;
}

/** Clean up entries older than 5 minutes */
export function cleanupBankCardCache(): void {
  const now = Date.now();
  for (const [key, list] of cache.entries()) {
    const filtered = list.filter(e => now - e.sentAt < 300000);
    if (filtered.length === 0) cache.delete(key);
    else cache.set(key, filtered);
  }
}

// Automatic cleanup every 2 minutes
setInterval(cleanupBankCardCache, 120000);

