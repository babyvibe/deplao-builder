/**
 * Read on another device (Zalo on the phone / Zalo PC, same account) → Deplao removes the unread count of the conversation.
 *
 * Zalo pushes cmd 504 (1-1 chat) / 524 (group), subCmd 0, about 1 second after the conversation is read on another device:
 * `{ data: { clearUnreads: [{ idTo, isGroup, lastMsgId, ts, type }], msgs: [], groupMsgs: [] } }`. zca-js 2.2.0 ignores this
 * frame (a proposed `unread_cleared` event: RFS-ADRENO/zca-js#380, not merged yet), so Deplao reads it directly from the websocket, like the
 * "syncmsgmb" control (mobileSync/zcaMobileSync.ts). Only `type: 0` is a real conversation (`type: 2` goes with idTo "-1").
 *
 * This frame also arrives after Deplao itself sends "đã xem" (read) (liveReadSync): the conversation is already read, so nothing changes and no
 * event is emitted. Marking as read here does NOT send "đã xem" back to Zalo (no loop).
 */
import Logger from '../../utils/Logger';
import { decodeWsEventData } from './mobileSync/zcaMobileSync';

export const CMD_CLEAR_UNREAD_USER = 504;
export const CMD_CLEAR_UNREAD_GROUP = 524;
/** The newest message of the conversation considered when counting unread messages (same as DatabaseService.markAsRead). */
export const ZALO_READ_SCOPE = 200;
/** Diagnostic log: at most this many lines per app run. */
const READ_LOG_LIMIT = 40;
let readLogs = 0;

export interface ZaloClearUnread {
  threadId: string;
  isGroup: boolean;
  /** Last read message (Zalo msgId, sometimes the cliMsgId); empty = everything has been read */
  lastMsgId: string;
}

/** Conversations read on another device in one websocket frame; other frames → []. */
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
    if (Number(raw?.type) !== 0) continue; // type 2: idTo "-1", meaning not yet clear
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
 * Attach an extra listener to the current websocket of `api.listener` (re-attached after every `connected`), decoding only
 * cmd 504 / 524 frames. Returns the unsubscribe function.
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

/** For each new zca-js instance of the account (login / reconnect): remove the old listener, then attach a new one. */
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
  /** New unread count: only when it differs from the stored value. */
  unread?: number;
  /** All read, so the @ flag of the conversation is turned off. */
  mentionCleared: boolean;
}

/** Time of the last read message (msg_id, then cli_msg_id, separate indexes; channel = 'zalo' to use the unique index). 0 = not found. */
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
 * Writes "read on another device" to the DB: the unread count = RECEIVED messages newer than the last read message (messages that arrived during / after reading). It
 * never increases. If the last read message is not found on the machine, everything is read. When everything is read → the latest received message becomes 'read', and the @ flag is turned off.
 * Nothing changes (the conversation is already read, e.g. an echo of Deplao's own "đã xem" (read)) → nothing is written, and the caller emits no event.
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
