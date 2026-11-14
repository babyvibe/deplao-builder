/**
 * Number of AUTOMATIC Zalo photo repairs per message (the chat bubble calls file:repairImage when a photo fails).
 *
 * - At most MAX_ZALO_AUTO_REPAIR attempts per cycle: a file that still cannot be displayed after repair does not make the bubble reload forever.
 * - When attempts run out, wait ZALO_REPAIR_COOLDOWN_MS before starting a new cycle. Previously the counter lasted the whole app session: 3 failures while the
 *   network was flaky (1.5 s and 3 s were enough) → every later failure of that message immediately showed "Không tải được ảnh" (could not load the photo) until the user clicked
 *   Retry download or reopened the app.
 * - Photo displayed (onLoad) → clears the counter.
 */
export const MAX_ZALO_AUTO_REPAIR = 3;
export const ZALO_REPAIR_COOLDOWN_MS = 60_000;

const attempts = new Map<string, { count: number; at: number }>();

/** Take 1 attempt: the attempt number (1..MAX), or null when this cycle's attempts are used up and the wait time has not passed yet. */
export function takeZaloRepairAttempt(key: string, now = Date.now()): number | null {
  const entry = attempts.get(key);
  if (entry && entry.count >= MAX_ZALO_AUTO_REPAIR && now - entry.at < ZALO_REPAIR_COOLDOWN_MS) return null;
  const count = entry && entry.count < MAX_ZALO_AUTO_REPAIR ? entry.count + 1 : 1;
  attempts.set(key, { count, at: now });
  return count;
}

/** Number of attempts used in the current cycle. */
export function zaloRepairAttemptsUsed(key: string): number {
  return attempts.get(key)?.count || 0;
}

export function resetZaloRepairAttempts(key: string): void {
  attempts.delete(key);
}

/** Test only. */
export function __resetZaloRepairBudget(): void {
  attempts.clear();
}
