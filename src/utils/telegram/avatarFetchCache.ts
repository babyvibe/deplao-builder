/**
 * avatarFetchCache.ts - Cache for avatar fetch attempts
 * 
 * Avoids calling the API over and over for contacts that have no avatar.
 * Cache for 24 hours before trying again.
 * Shared by TelegramUserListener and TelegramBotChannelService.
 */

/** Map: `${accountId}_${contactId}` → lastFetchTimestamp */
const fetchAttempts = new Map<string, number>();

/** Cache time: 24 hours (ms) */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum attempts before giving up permanently */
const MAX_ATTEMPTS = 3;

/** Map: `${accountId}_${contactId}` → attemptCount */
const attemptCounts = new Map<string, number>();

/**
 * Check whether to fetch the avatar for this contact.
 * Returns true if it should fetch, false if it is still in the cache or the attempts are used up.
 */
export function shouldFetchAvatar(accountId: string, contactId: string): boolean {
  const key = `${accountId}_${contactId}`;
  
  // Check the number of attempts
  const attempts = attemptCounts.get(key) || 0;
  if (attempts >= MAX_ATTEMPTS) return false; // Attempts used up, give up
  
  // Check the cache time
  const lastFetch = fetchAttempts.get(key);
  if (lastFetch && (Date.now() - lastFetch) < CACHE_TTL_MS) return false; // Still within the cache
  
  return true;
}

/**
 * Mark the avatar as fetched for this contact.
 */
export function markAvatarFetched(accountId: string, contactId: string): void {
  const key = `${accountId}_${contactId}`;
  fetchAttempts.set(key, Date.now());
  attemptCounts.set(key, (attemptCounts.get(key) || 0) + 1);
}

/**
 * Mark the avatar fetch as successful (resets the counter).
 */
export function markAvatarSuccess(accountId: string, contactId: string): void {
  const key = `${accountId}_${contactId}`;
  fetchAttempts.delete(key); // Clear the cache so it can be fetched again later if needed
  attemptCounts.delete(key);
}

/**
 * Reset the cache for one specific contact (used when the user clicks the "Cập nhật thông tin" (Update info) button).
 */
export function resetAvatarCache(accountId: string, contactId: string): void {
  const key = `${accountId}_${contactId}`;
  fetchAttempts.delete(key);
  attemptCounts.delete(key);
}

/**
 * Clear the whole cache (when needed).
 */
export function clearAvatarCache(): void {
  fetchAttempts.clear();
  attemptCounts.clear();
}
