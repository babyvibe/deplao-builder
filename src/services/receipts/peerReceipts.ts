/**
 * Status of MY messages in a conversation (like Telegram ✓ / ✓✓; Zalo, Facebook: sent / delivered / seen).
 *
 * Every channel reports it as "up to here": the other side has received / seen up to message X. The MARK of the conversation is stored in contacts
 * (peer_delivered_ts, peer_read_ts in ms; Telegram peer_read_max_id = a message id, compared by id because Telegram message ids increase
 * within a conversation), only moves forward, then event:receipt is emitted so the chat window updates the ticks right away. A sent message with a time ≤ the mark =
 * delivered / seen. Groups: one member who has seen it counts as seen (like Telegram).
 *
 *  - Zalo (zca-js): seen_messages / delivered_messages → recordZaloReceipt
 *  - Telegram: updateReadHistoryOutbox / updateReadChannelOutbox + the dialog's read_outbox_max_id
 *  - Facebook: delivered notice (MQTT deliveredReceipt, E2EE receipt) / read (bridge readReceipt, MQTT ReadReceipt)
 */
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

/** Diagnostic log for Zalo delivered / seen events: at most this many lines per app run. */
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
 * Writes the delivered / seen marks of a conversation (only moves forward; seen ⇒ delivered). If something changed → emits event:receipt
 * { zaloId, threadId, deliveredTs, readTs, readMaxId } and returns the new state; no change / no conversation → null.
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
 * Latest time (ms) of the messages with the ids in the list, in this conversation. Runs every time the platform reports delivered / seen,
 * so it must look them up through the message-code indexes:
 *  - msg_id: uses all 4 columns of the unique index (msg_id, owner_zalo_id, channel, thread_id) → 0.01 ms;
 *  - not found → cli_msg_id for each id (idx_messages_cli, LIMIT 1, no MAX).
 * Measured on a real DB on 29/10/2026 (a conversation of ~100k messages): without `channel` SQLite scans the conversation index (10-30 ms), the
 * cli_msg_id IN + MAX form scans the whole conversation (50-200 ms), adding CAST(thread_id) to the MAX form scans the whole account (up to 3 s).
 * Not found → 0.
 */
export function messageTimestampById(
  ownerId: string,
  threadId: string,
  msgIds: Array<string | number | null | undefined>,
  channel: 'zalo' | 'telegram_user' | 'telegram_bot' | 'facebook',
): number {
  const db = DatabaseService.getInstance();
  const thread = String(threadId ?? '');
  const ids = [...new Set(msgIds.map((id) => String(id ?? '').trim()).filter((id) => id && id !== '0'))].slice(0, 50);
  if (!db || !ownerId || !thread || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const byId = db.queryOne<{ ts: number | null }>(
    `SELECT MAX(timestamp) AS ts FROM messages
     WHERE owner_zalo_id = ? AND msg_id IN (${placeholders}) AND channel = ? AND thread_id = ?`,
    [ownerId, ...ids, channel, thread],
  );
  const ts = num(byId?.ts);
  if (ts) return ts;
  let latest = 0;
  for (const id of ids) {
    const byCli = db.queryOne<{ timestamp: number | null }>(
      `SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND CAST(thread_id AS TEXT) = ? LIMIT 1`,
      [ownerId, id, thread],
    );
    latest = Math.max(latest, num(byCli?.timestamp));
  }
  return latest;
}

/**
 * Zalo (zca-js 2.x): `seen_messages` (UserSeenMessage { threadId = idTo, data: { msgId, realMsgId } } / GroupSeenMessage
 * { threadId = groupId, data: { msgId, seenUids } }) and `delivered_messages` ({ threadId, data: { msgId, realMsgId, seen,
 * deliveredUids, seenUids, mSTs } }). Events from my own account (other devices) are skipped.
 */
export function recordZaloReceipt(ownerId: string, event: any, kind: 'read' | 'delivered'): PeerReceiptState | null {
  if (!event || event.isSelf) return null;
  const threadId = String(event.threadId || event.data?.groupId || event.data?.idTo || '');
  const data = event.data || {};
  if (!threadId) return null;
  let ts = messageTimestampById(ownerId, threadId, [data.msgId, data.realMsgId], 'zalo');
  // Message not on this machine: the time Zalo sent with the delivered notice (ms)
  if (!ts && kind === 'delivered' && num(data.mSTs) > 1e12) ts = num(data.mSTs);
  const seen = kind === 'read' || Number(data.seen) === 1 || (Array.isArray(data.seenUids) && data.seenUids.length > 0);
  // Diagnostics: did Zalo send "đã xem" (seen) at all / does the id match a message on this machine (the ✓✓ tick depends on this)
  if ((seen || !ts) && zaloReceiptLogs < ZALO_RECEIPT_LOG_LIMIT) {
    zaloReceiptLogs++;
    Logger.log(`[ZaloReceipt] ${kind}${seen ? ' (seen)' : ''} account=${ownerId} thread=${threadId} msgId=${data.msgId ?? '-'} realMsgId=${data.realMsgId ?? '-'} matchedTs=${ts || 0}`);
  }
  if (!ts) return null;
  return recordPeerReceipt(ownerId, threadId, seen ? { readTs: ts } : { deliveredTs: ts });
}
