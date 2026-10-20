/**
 * Trạng thái tin MÌNH gửi theo hội thoại (như Telegram ✓ / ✓✓; Zalo, Facebook: đã gửi / đã nhận / đã xem).
 *
 * Mọi kênh báo theo kiểu "tới đây": người kia đã nhận / đã xem đến tin X. Lưu MỐC của hội thoại trong contacts
 * (peer_delivered_ts, peer_read_ts — ms; Telegram peer_read_max_id — id tin, so theo id vì id tin Telegram tăng dần
 * trong một hội thoại), chỉ tiến lên, rồi phát event:receipt để khung chat đổi dấu ngay. Tin gửi có thời điểm ≤ mốc =
 * đã nhận / đã xem. Nhóm: một người đã xem là tính đã xem (như Telegram).
 *
 *  - Zalo (zca-js): seen_messages / delivered_messages → recordZaloReceipt
 *  - Telegram: updateReadHistoryOutbox / updateReadChannelOutbox + read_outbox_max_id của dialog
 *  - Facebook: thông báo đã nhận (MQTT deliveredReceipt, E2EE receipt) / đã đọc (bridge readReceipt, MQTT ReadReceipt)
 */
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

/** Log chẩn đoán sự kiện đã nhận / đã xem của Zalo: tối đa chừng này dòng mỗi lần chạy app. */
const ZALO_RECEIPT_LOG_LIMIT = 40;
let zaloReceiptLogs = 0;

export interface PeerReceiptUpdate {
  deliveredTs?: number;
  readTs?: number;
  readMaxId?: number;
}

export interface PeerReceiptState {
  deliveredTs: number;
  readTs: number;
  readMaxId: number;
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Ghi mốc đã nhận / đã xem của hội thoại (chỉ tiến lên; đã xem ⇒ đã nhận). Có thay đổi → phát event:receipt
 * { zaloId, threadId, deliveredTs, readTs, readMaxId } và trả về trạng thái mới; không đổi / không có hội thoại → null.
 */
export function recordPeerReceipt(ownerId: string, threadId: string, update: PeerReceiptUpdate): PeerReceiptState | null {
  const db = DatabaseService.getInstance();
  if (!db || !ownerId || !threadId) return null;
  const readTs = num(update.readTs);
  const deliveredTs = Math.max(num(update.deliveredTs), readTs);
  const readMaxId = num(update.readMaxId);
  if (!deliveredTs && !readTs && !readMaxId) return null;

  const row = db.queryOne<{ peer_delivered_ts: number | null; peer_read_ts: number | null; peer_read_max_id: number | null }>(
    `SELECT peer_delivered_ts, peer_read_ts, peer_read_max_id FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
    [ownerId, threadId],
  );
  if (!row) return null;
  const current: PeerReceiptState = {
    deliveredTs: num(row.peer_delivered_ts),
    readTs: num(row.peer_read_ts),
    readMaxId: num(row.peer_read_max_id),
  };
  const next: PeerReceiptState = {
    deliveredTs: Math.max(current.deliveredTs, deliveredTs, readTs),
    readTs: Math.max(current.readTs, readTs),
    readMaxId: Math.max(current.readMaxId, readMaxId),
  };
  if (next.deliveredTs === current.deliveredTs && next.readTs === current.readTs && next.readMaxId === current.readMaxId) {
    return null;
  }
  db.run(
    `UPDATE contacts SET peer_delivered_ts = ?, peer_read_ts = ?, peer_read_max_id = ? WHERE owner_zalo_id = ? AND contact_id = ?`,
    [next.deliveredTs, next.readTs, next.readMaxId, ownerId, threadId],
  );
  EventBroadcaster.emit('event:receipt', { zaloId: ownerId, threadId, ...next });
  return next;
}

/**
 * Thời điểm (ms) mới nhất của các tin có id trong danh sách, ở hội thoại này (msg_id, rồi cli_msg_id — hai lần tra theo
 * chỉ mục riêng: dạng "msg_id = ? OR cli_msg_id = ?" quét cả tài khoản). Không thấy → 0.
 */
export function messageTimestampById(ownerId: string, threadId: string, msgIds: Array<string | number | null | undefined>): number {
  const db = DatabaseService.getInstance();
  const ids = [...new Set(msgIds.map((id) => String(id ?? '').trim()).filter((id) => id && id !== '0'))].slice(0, 50);
  if (!db || !ownerId || !threadId || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const byId = db.queryOne<{ ts: number | null }>(
    `SELECT MAX(timestamp) AS ts FROM messages WHERE owner_zalo_id = ? AND msg_id IN (${placeholders}) AND thread_id = ?`,
    [ownerId, ...ids, threadId],
  );
  const ts = num(byId?.ts);
  if (ts) return ts;
  const byCli = db.queryOne<{ ts: number | null }>(
    `SELECT MAX(timestamp) AS ts FROM messages WHERE owner_zalo_id = ? AND cli_msg_id IN (${placeholders}) AND thread_id = ?`,
    [ownerId, ...ids, threadId],
  );
  return num(byCli?.ts);
}

/**
 * Zalo (zca-js 2.x): `seen_messages` (UserSeenMessage { threadId = idTo, data: { msgId, realMsgId } } / GroupSeenMessage
 * { threadId = groupId, data: { msgId, seenUids } }) và `delivered_messages` ({ threadId, data: { msgId, realMsgId, seen,
 * deliveredUids, seenUids, mSTs } }). Sự kiện của chính mình (máy khác) bỏ qua.
 */
export function recordZaloReceipt(ownerId: string, event: any, kind: 'read' | 'delivered'): PeerReceiptState | null {
  if (!event || event.isSelf) return null;
  const threadId = String(event.threadId || event.data?.groupId || event.data?.idTo || '');
  const data = event.data || {};
  if (!threadId) return null;
  let ts = messageTimestampById(ownerId, threadId, [data.msgId, data.realMsgId]);
  // Tin chưa có trong máy: thời điểm tin Zalo gửi kèm thông báo đã nhận (ms)
  if (!ts && kind === 'delivered' && num(data.mSTs) > 1e12) ts = num(data.mSTs);
  const seen = kind === 'read' || Number(data.seen) === 1 || (Array.isArray(data.seenUids) && data.seenUids.length > 0);
  // Chẩn đoán: Zalo có gửi "đã xem" không / id có khớp tin trong máy không (ô dấu ✓✓ dựa vào đây)
  if ((seen || !ts) && zaloReceiptLogs < ZALO_RECEIPT_LOG_LIMIT) {
    zaloReceiptLogs++;
    Logger.log(`[ZaloReceipt] ${kind}${seen ? ' (seen)' : ''} account=${ownerId} thread=${threadId} msgId=${data.msgId ?? '-'} realMsgId=${data.realMsgId ?? '-'} matchedTs=${ts || 0}`);
  }
  if (!ts) return null;
  return recordPeerReceipt(ownerId, threadId, seen ? { readTs: ts } : { deliveredTs: ts });
}
