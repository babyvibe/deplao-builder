/**
 * Đã đọc ở máy khác (Zalo trên điện thoại / Zalo PC, cùng tài khoản) → Deplao bỏ số chưa đọc của hội thoại.
 *
 * Zalo đẩy cmd 504 (chat riêng) / 524 (nhóm), subCmd 0, khoảng 1 giây sau khi hội thoại được đọc ở thiết bị khác:
 * `{ data: { clearUnreads: [{ idTo, isGroup, lastMsgId, ts, type }], msgs: [], groupMsgs: [] } }`. zca-js 2.2.0 bỏ qua
 * frame này (đề xuất sự kiện `unread_cleared`: RFS-ADRENO/zca-js#380, chưa gộp) nên Deplao đọc thẳng từ websocket như
 * control "syncmsgmb" (mobileSync/zcaMobileSync.ts). Chỉ `type: 0` là hội thoại thật (`type: 2` đi với idTo "-1").
 *
 * Frame này cũng tới sau khi chính Deplao gửi "đã xem" (liveReadSync): hội thoại đã đọc rồi → không đổi gì, không phát
 * event. Đánh dấu đã đọc ở đây KHÔNG gửi "đã xem" ngược lên Zalo (không vòng lặp).
 */
import Logger from '../../utils/Logger';
import { decodeWsEventData } from './mobileSync/zcaMobileSync';

export const CMD_CLEAR_UNREAD_USER = 504;
export const CMD_CLEAR_UNREAD_GROUP = 524;
/** Số tin mới nhất của hội thoại được xét khi đếm tin còn chưa đọc (như DatabaseService.markAsRead). */
export const ZALO_READ_SCOPE = 200;
/** Log chẩn đoán: tối đa chừng này dòng mỗi lần chạy app. */
const READ_LOG_LIMIT = 40;
let readLogs = 0;

export interface ZaloClearUnread {
  threadId: string;
  isGroup: boolean;
  /** Tin cuối đã đọc (msgId Zalo, có khi là cliMsgId); rỗng = đã đọc hết */
  lastMsgId: string;
}

/** Hội thoại đã đọc ở máy khác trong 1 frame websocket; frame khác → []. */
export function extractClearUnreads(frame: Buffer, cipherKey: string | null | undefined): ZaloClearUnread[] {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame[0] !== 1 || frame[3] !== 0) return [];
  const cmd = frame.readUInt16LE(1);
  if (cmd !== CMD_CLEAR_UNREAD_USER && cmd !== CMD_CLEAR_UNREAD_GROUP) return [];
  const text = frame.subarray(4).toString('utf8');
  if (!text || !text.includes('"data"')) return [];
  const decoded = decodeWsEventData(JSON.parse(text), cipherKey);
  const list: unknown = decoded?.data?.clearUnreads ?? decoded?.clearUnreads;
  if (!Array.isArray(list)) return [];
  const items: ZaloClearUnread[] = [];
  for (const raw of list) {
    if (Number(raw?.type) !== 0) continue; // type 2: idTo "-1", chưa rõ nghĩa
    const threadId = String(raw?.idTo ?? '').trim();
    if (!/^\d+$/.test(threadId) || /^0+$/.test(threadId)) continue;
    items.push({
      threadId,
      isGroup: cmd === CMD_CLEAR_UNREAD_GROUP || Number(raw?.isGroup) === 1,
      lastMsgId: String(raw?.lastMsgId ?? '').trim(),
    });
  }
  return items;
}

/**
 * Gắn listener phụ vào websocket hiện tại của `api.listener` (gắn lại sau mỗi lần `connected`), chỉ giải mã frame
 * cmd 504 / 524. Trả về hàm huỷ đăng ký.
 */
export function attachClearUnreadListener(api: any, onItems: (items: ZaloClearUnread[]) => void): () => void {
  const listener = api?.listener;
  if (!listener || typeof listener.on !== 'function') return () => {};

  let boundWs: any = null;
  const onFrame = (data: any) => {
    if (!Buffer.isBuffer(data) || data.length < 4 || data[0] !== 1) return;
    const cmd = data.readUInt16LE(1);
    if (cmd !== CMD_CLEAR_UNREAD_USER && cmd !== CMD_CLEAR_UNREAD_GROUP) return;
    try {
      const items = extractClearUnreads(data, listener.cipherKey);
      if (items.length) onItems(items);
    } catch (err: any) {
      Logger.warn(`[ZaloReadSync] Không đọc được frame đã đọc (cmd ${cmd}): ${err?.message}`);
    }
  };
  const bind = () => {
    const ws = listener.ws;
    if (!ws || ws === boundWs || typeof ws.on !== 'function') return;
    if (boundWs) boundWs.off?.('message', onFrame);
    boundWs = ws;
    ws.on('message', onFrame);
  };

  listener.on('connected', bind);
  bind();
  return () => {
    listener.off?.('connected', bind);
    boundWs?.off?.('message', onFrame);
    boundWs = null;
  };
}

const detachers = new Map<string, () => void>();

/** Mỗi instance zca-js mới của tài khoản (đăng nhập / kết nối lại): gỡ listener cũ, gắn listener mới. */
export function attachZaloReadElsewhere(zaloId: string, api: any, onItems: (items: ZaloClearUnread[]) => void): void {
  detachers.get(zaloId)?.();
  detachers.delete(zaloId);
  try {
    detachers.set(zaloId, attachClearUnreadListener(api, onItems));
  } catch (err: any) {
    Logger.warn(`[ZaloReadSync] ${zaloId}: không gắn được listener đã đọc: ${err?.message}`);
  }
}

export interface ZaloReadDb {
  queryOne<T>(sql: string, params?: any[]): T | undefined;
  run(sql: string, params?: any[]): void;
}

export interface ZaloReadResult {
  /** Số chưa đọc mới: chỉ có khi khác giá trị đang lưu. */
  unread?: number;
  /** Đã đọc hết nên tắt cờ @ của hội thoại. */
  mentionCleared: boolean;
}

/** Thời điểm tin đã đọc cuối (msg_id rồi cli_msg_id, chỉ mục riêng; channel = 'zalo' để dùng chỉ mục duy nhất). 0 = không thấy. */
function lastReadTimestamp(db: ZaloReadDb, ownerId: string, threadId: string, msgId: string): number {
  const byId = db.queryOne<{ timestamp: number | null }>(
    `SELECT timestamp FROM messages
     WHERE owner_zalo_id = ? AND msg_id = ? AND channel = 'zalo' AND CAST(thread_id AS TEXT) = ? LIMIT 1`,
    [ownerId, msgId, threadId],
  );
  if (Number(byId?.timestamp) > 0) return Number(byId!.timestamp);
  const byCli = db.queryOne<{ timestamp: number | null }>(
    `SELECT timestamp FROM messages
     WHERE owner_zalo_id = ? AND cli_msg_id = ? AND CAST(thread_id AS TEXT) = ? LIMIT 1`,
    [ownerId, msgId, threadId],
  );
  return Number(byCli?.timestamp) > 0 ? Number(byCli!.timestamp) : 0;
}

/**
 * Ghi "đã đọc ở máy khác" vào DB: số chưa đọc = tin NHẬN mới hơn tin đã đọc cuối (tin tới trong lúc / sau khi đọc), không
 * bao giờ tăng; không thấy tin đã đọc trong máy = đã đọc hết. Đọc hết → tin nhận gần nhất thành 'read', tắt cờ @.
 * Không đổi gì (hội thoại đã đọc rồi, vd frame dội lại sau "đã xem" của chính Deplao) → không ghi, người gọi không phát event.
 */
export function applyZaloClearUnread(db: ZaloReadDb, ownerId: string, item: ZaloClearUnread): ZaloReadResult {
  const result: ZaloReadResult = { mentionCleared: false };
  const contact = db.queryOne<{ unread_count: number | null; has_mention: number | null }>(
    `SELECT unread_count, has_mention FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
    [ownerId, item.threadId],
  );
  if (!contact) return result;

  let remaining = 0;
  const readTs = item.lastMsgId && item.lastMsgId !== '0' ? lastReadTimestamp(db, ownerId, item.threadId, item.lastMsgId) : 0;
  if (readTs) {
    const row = db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT is_sent, timestamp, msg_type FROM messages
         WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ?
       ) WHERE is_sent = 0 AND timestamp > ? AND COALESCE(msg_type, '') NOT IN ('system', 'chat.undo', 'recalled')`,
      [ownerId, item.threadId, ZALO_READ_SCOPE, readTs],
    );
    remaining = Math.max(0, Number(row?.n || 0));
  }

  const current = Math.max(0, Number(contact.unread_count || 0));
  const unread = Math.min(current, remaining);
  const unreadChanged = unread !== current;
  const clearMention = unread === 0 && Number(contact.has_mention || 0) !== 0;
  if (unreadChanged || clearMention) {
    db.run(
      `UPDATE contacts SET unread_count = ?${clearMention ? ', has_mention = 0' : ''} WHERE owner_zalo_id = ? AND contact_id = ?`,
      [unread, ownerId, item.threadId],
    );
    if (unread === 0) {
      db.run(
        `UPDATE messages SET status = 'read'
         WHERE id IN (SELECT id FROM messages WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ?)
           AND is_sent = 0 AND status != 'read'`,
        [ownerId, item.threadId, ZALO_READ_SCOPE],
      );
    }
    if (unreadChanged) result.unread = unread;
    result.mentionCleared = clearMention;
  }

  if (readLogs < READ_LOG_LIMIT) {
    readLogs++;
    Logger.log(`[ZaloReadSync] Đã đọc ở máy khác: account=${ownerId} ${item.isGroup ? 'nhóm' : 'chat'}=${item.threadId} `
      + `lastMsgId=${item.lastMsgId || '-'} chưa đọc ${current} → ${unread}${unreadChanged || clearMention ? '' : ' (không đổi)'}`);
  }
  return result;
}
