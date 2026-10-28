/**
 * Quy tắc thuần cho đồng bộ "đã đọc" lên nền tảng (liveReadSync): người dùng có đang ở máy không, chờ bao lâu, tin nào
 * dùng làm mốc "đã xem" của Zalo và payload gửi đi. Không import store / IPC để test được trực tiếp.
 */

/** Có thao tác chuột / phím trong khoảng này mới coi là đang xem màn hình (bỏ máy đi thì không báo đã đọc thay). */
export const PRESENCE_WINDOW_MS = 60_000;
/** Tin mới vào hội thoại đang mở: chờ chút để gom cả loạt tin thành một lần báo. */
export const LIVE_READ_DELAY_MS = 800;
/** Người dùng quay lại thao tác (sau khi focus lại / ngồi im): báo gần như ngay. */
export const PRESENCE_RESUME_DELAY_MS = 300;

/** Mỗi hội thoại tối đa một lần báo đã đọc trong khoảng này (Telegram mỗi lần là 1–3 lệnh MTProto). */
const MIN_READ_INTERVAL_MS: Record<string, number> = {
  zalo: 1_500,
  facebook: 2_000,
  telegram_user: 3_000,
};

/** Tin không phải tin thật của nền tảng (Deplao tự sinh / đã thu hồi) — không dùng làm mốc "đã xem". */
const NOT_SEEABLE_TYPES = new Set(['system', 'recalled', 'undo', 'deleted']);

export interface ReadThreadRef {
  accountId: string;
  threadId: string;
  /** 0 = 1:1, 1 = nhóm */
  threadType: number;
  /** Telegram forum: topic đang mở (activeTopicId) — null với hội thoại thường */
  topicId?: string | null;
}

/** Một tin nhận được (của người khác) dùng làm mốc đã đọc. */
export interface IncomingRef {
  msgId: string;
  cliMsgId?: string;
  senderId: string;
  msgType?: string;
  ts?: number;
}

/** Dòng tin tối thiểu (DB / store) để chọn mốc. */
export interface ReadRow {
  msg_id?: string | null;
  cli_msg_id?: string | null;
  sender_id?: string | null;
  msg_type?: string | null;
  timestamp?: number | null;
  is_sent?: number | null;
}

/** Kênh có API báo đã đọc (Telegram Bot không có trạng thái đọc trên nền tảng). */
export function supportsPlatformRead(channel: string | undefined): boolean {
  return channel === 'zalo' || channel === 'facebook' || channel === 'telegram_user';
}

export function minReadIntervalMs(channel: string | undefined): number {
  return MIN_READ_INTERVAL_MS[channel || ''] ?? 2_000;
}

export function isUserPresent(now: number, lastInputAt: number, windowMs = PRESENCE_WINDOW_MS): boolean {
  return lastInputAt > 0 && now - lastInputAt <= windowMs;
}

/** Thời gian chờ trước lần báo tới: ít nhất `baseDelay`, và không sớm hơn lần báo trước + khoảng tối thiểu của kênh. */
export function readSyncDelay(now: number, lastSyncAt: number, minIntervalMs: number, baseDelay: number): number {
  const throttleUntil = lastSyncAt > 0 ? lastSyncAt + minIntervalMs : 0;
  return Math.max(baseDelay, throttleUntil - now, 0);
}

function isIncomingRow(row: ReadRow, ownUid: string): boolean {
  const msgId = String(row.msg_id || '');
  const sender = String(row.sender_id || '');
  if (!msgId || msgId.startsWith('temp_')) return false;
  if (Number(row.is_sent) === 1) return false;
  if (!sender || sender === '0' || (ownUid && sender === ownUid)) return false;
  return !NOT_SEEABLE_TYPES.has(String(row.msg_type || ''));
}

/**
 * Tin nhận được mới nhất (bỏ tin của mình, tin hệ thống / đã thu hồi, tin tạm chưa có id). Thứ tự `rows` tuỳ ý (DB trả
 * mới → cũ, store cũ → mới); cùng mốc thời gian thì lấy dòng đứng sau trong mảng.
 */
export function newestIncoming(rows: ReadonlyArray<ReadRow> | null | undefined, ownUid: string): IncomingRef | null {
  let best: ReadRow | null = null;
  let bestTs = -Infinity;
  for (const row of rows || []) {
    if (!isIncomingRow(row, ownUid)) continue;
    const ts = Number(row.timestamp) || 0;
    if (!best || ts >= bestTs) {
      best = row;
      bestTs = ts;
    }
  }
  if (!best) return null;
  return {
    msgId: String(best.msg_id),
    cliMsgId: best.cli_msg_id ? String(best.cli_msg_id) : undefined,
    senderId: String(best.sender_id),
    msgType: best.msg_type ? String(best.msg_type) : undefined,
    ts: Number(best.timestamp) || undefined,
  };
}

/** Tin nào mới hơn (theo thời gian; không có thời gian thì tin đến sau thắng). */
export function newerIncoming(current: IncomingRef | null | undefined, next: IncomingRef): IncomingRef {
  if (!current) return next;
  return (Number(next.ts) || 0) >= (Number(current.ts) || 0) ? next : current;
}

/**
 * Payload một tin cho zca-js sendSeenEvent. zca-js lấy hội thoại 1:1 từ `uidFrom` (phải là người gửi = khách, không phải
 * mình) và nhóm từ `idTo` (= id nhóm); người nhận của tin 1:1 là chính mình — Zalo ghi "0" (trước đây gửi id khách).
 */
export function zaloSeenPayload(target: IncomingRef, ref: ReadThreadRef) {
  return {
    msgId: target.msgId,
    cliMsgId: target.cliMsgId || target.msgId,
    uidFrom: target.senderId,
    idTo: ref.threadType === 1 ? ref.threadId : '0',
    msgType: target.msgType || 'webchat',
    st: 0,
    at: 0,
    cmd: 0,
    ts: target.ts || Date.now(),
  };
}
