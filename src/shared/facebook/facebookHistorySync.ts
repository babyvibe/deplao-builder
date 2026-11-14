/**
 * Facebook message sync by time range (popup like Zalo's "Đồng bộ tin nhắn từ điện thoại" (Sync messages from phone)): downloads the history
 * of each conversation via the bridge (LightSpeed FetchMessagesTask, stepping back by timestamp) until the selected range is fully covered,
 * with no limit on the number of messages; each page is saved right away. Status types shared by main ↔ renderer + pure rules
 * (test: src/__tests__/facebook/facebookHistorySync.test.ts).
 */

export type FbHistorySyncStage = 'idle' | 'listing' | 'syncing' | 'completed' | 'failed' | 'cancelled';

/** ms; null = no limit on that side (fromTs null + toTs null = the whole history). */
export interface FbHistorySyncRange {
  fromTs: number | null;
  toTs: number | null;
}

export interface FbHistorySyncStatus {
  /** Facebook account (facebook_id = zalo_id in the account list). */
  accountId: string;
  stage: FbHistorySyncStage;
  range: FbHistorySyncRange;
  message: string;
  error?: string;
  threadsTotal: number;
  threadsDone: number;
  currentThreadName?: string;
  /** New messages saved to the machine (messages already stored are not counted). */
  messagesSaved: number;
  /** Facebook messages returned for the selected range (including ones already stored). */
  messagesReceived: number;
  /** End-to-end encrypted conversation: Facebook does not let a new device read old messages. */
  skippedE2EE: number;
  failedThreads: number;
  startedAt: number;
  finishedAt?: number;
  /** Pausing (to mimic a real user's rhythm) until this time, in ms. */
  pausedUntil?: number;
  /** pace / reading / thread / list / break / long_break / budget / slowdown */
  pauseReason?: string;
}

export const FB_HISTORY_SYNC_EVENT = 'event:fbHistorySync';

const ACTIVE: FbHistorySyncStage[] = ['listing', 'syncing'];

export function isFbHistorySyncActive(status?: Pick<FbHistorySyncStatus, 'stage'> | null): boolean {
  return !!status && ACTIVE.includes(status.stage);
}

/** Timestamps come in seconds (thread list GraphQL) or milliseconds (bridge / messages) → always convert to milliseconds. */
export function activityMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** Conversation with activity in the range (unknown time → still synced, which is safer than missing it). */
export function threadActiveInRange(lastActivity: unknown, range: FbHistorySyncRange): boolean {
  const ms = activityMs(lastActivity);
  if (!ms) return true;
  return range.fromTs == null || ms >= range.fromTs;
}

/** Message within the selected range. */
export function messageInRange(timestampMs: unknown, range: FbHistorySyncRange): boolean {
  const ms = activityMs(timestampMs);
  if (!ms) return true;
  if (range.fromTs != null && ms < range.fromTs) return false;
  if (range.toTs != null && ms > range.toTs) return false;
  return true;
}

/**
 * Regular Messenger message IDs (LightSpeed / GraphQL: `mid.$…`) are valid anchors for FetchMessagesTask. E2EE message IDs (numeric)
 * and temporary messages (`temp_…`) are not: Facebook cannot find their position in the conversation.
 */
export function isLightSpeedMessageId(id: unknown): boolean {
  return /^mid\.\$./.test(String(id ?? ''));
}

/**
 * After one history page: keep loading or stop. `count` = number of messages in the page (including messages outside the range: a range that ends
 * in the past must step back through newer pages). Stop when Facebook reports no more, the page is empty, the oldest message is already before the start of the
 * time range, or the anchor cannot move back (avoids an endless loop when Facebook returns the same old page).
 */
export function nextHistoryAnchor(
  page: { count: number; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string },
  previous: { timestampMs: number; messageId: string },
  range: FbHistorySyncRange,
): { timestampMs: number; messageId: string } | null {
  if (!page.hasMoreBefore || page.count <= 0) return null;
  const minTs = activityMs(page.minTimestampMs);
  if (!minTs) return null;
  if (range.fromTs != null && minTs < range.fromTs) return null;
  const messageId = String(page.minMessageId || '');
  if (previous.timestampMs > 0 && minTs >= previous.timestampMs && messageId === previous.messageId) return null;
  return { timestampMs: minTs, messageId };
}

export function emptyFbHistorySyncStatus(accountId: string, range: FbHistorySyncRange = { fromTs: null, toTs: null }): FbHistorySyncStatus {
  return {
    accountId,
    stage: 'idle',
    range,
    message: '',
    threadsTotal: 0,
    threadsDone: 0,
    messagesSaved: 0,
    messagesReceived: 0,
    skippedE2EE: 0,
    failedThreads: 0,
    startedAt: 0,
  };
}
