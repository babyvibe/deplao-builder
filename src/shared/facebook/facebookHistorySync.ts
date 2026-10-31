/**
 * Đồng bộ tin nhắn Facebook theo khoảng thời gian (popup giống "Đồng bộ tin nhắn từ điện thoại" của Zalo): tải lịch sử
 * từng hội thoại qua bridge (LightSpeed FetchMessagesTask, lùi theo mốc thời gian) cho tới khi phủ hết khoảng đã chọn —
 * không giới hạn số tin; mỗi trang lưu ngay. Kiểu trạng thái dùng chung main ↔ renderer + quy tắc thuần
 * (test: src/__tests__/facebook/facebookHistorySync.test.ts).
 */

export type FbHistorySyncStage = 'idle' | 'listing' | 'syncing' | 'completed' | 'failed' | 'cancelled';

/** ms; null = không giới hạn phía đó (fromTs null + toTs null = toàn bộ lịch sử). */
export interface FbHistorySyncRange {
  fromTs: number | null;
  toTs: number | null;
}

export interface FbHistorySyncStatus {
  /** Tài khoản Facebook (facebook_id = zalo_id trong danh sách tài khoản). */
  accountId: string;
  stage: FbHistorySyncStage;
  range: FbHistorySyncRange;
  message: string;
  error?: string;
  threadsTotal: number;
  threadsDone: number;
  currentThreadName?: string;
  /** Tin mới lưu vào máy (tin đã có không tính). */
  messagesSaved: number;
  /** Tin Facebook trả về trong khoảng đã chọn (kể cả tin đã có). */
  messagesReceived: number;
  /** Hội thoại mã hoá đầu cuối — Facebook không cho thiết bị mới đọc tin cũ. */
  skippedE2EE: number;
  failedThreads: number;
  startedAt: number;
  finishedAt?: number;
  /** Đang nghỉ (nhịp người dùng thật) tới thời điểm này, ms. */
  pausedUntil?: number;
  /** pace / reading / thread / list / break / long_break / budget / slowdown */
  pauseReason?: string;
}

export const FB_HISTORY_SYNC_EVENT = 'event:fbHistorySync';

const ACTIVE: FbHistorySyncStage[] = ['listing', 'syncing'];

export function isFbHistorySyncActive(status?: Pick<FbHistorySyncStatus, 'stage'> | null): boolean {
  return !!status && ACTIVE.includes(status.stage);
}

/** Mốc thời gian lưu lẫn giây (thread list GraphQL) và mili giây (bridge / tin nhắn) → luôn mili giây. */
export function activityMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** Hội thoại có hoạt động trong khoảng (không biết thời điểm → vẫn đồng bộ, an toàn hơn bỏ sót). */
export function threadActiveInRange(lastActivity: unknown, range: FbHistorySyncRange): boolean {
  const ms = activityMs(lastActivity);
  if (!ms) return true;
  return range.fromTs == null || ms >= range.fromTs;
}

/** Tin nằm trong khoảng đã chọn. */
export function messageInRange(timestampMs: unknown, range: FbHistorySyncRange): boolean {
  const ms = activityMs(timestampMs);
  if (!ms) return true;
  if (range.fromTs != null && ms < range.fromTs) return false;
  if (range.toTs != null && ms > range.toTs) return false;
  return true;
}

/**
 * Mã tin Messenger thường (LightSpeed / GraphQL: `mid.$…`) — mốc hợp lệ cho FetchMessagesTask. Mã tin E2EE (dạng số),
 * tin tạm (`temp_…`) không phải: Facebook không tìm được vị trí trong hội thoại.
 */
export function isLightSpeedMessageId(id: unknown): boolean {
  return /^mid\.\$./.test(String(id ?? ''));
}

/**
 * Sau một trang lịch sử: tải tiếp hay dừng. `count` = số tin trong trang (kể cả tin ngoài khoảng — khoảng kết thúc
 * trong quá khứ phải lùi qua các trang mới hơn). Dừng khi Facebook báo hết, trang rỗng, tin cũ nhất đã trước đầu khoảng
 * thời gian, hoặc mốc không lùi được (tránh lặp vô hạn khi Facebook trả lại đúng trang cũ).
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
