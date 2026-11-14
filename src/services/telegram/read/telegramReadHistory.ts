/**
 * telegramReadHistory.ts: Telegram (MTProto) "read" updates, in the correct direction:
 *  - Inbox (updateReadHistoryInbox / updateReadChannelInbox): I have read the incoming messages of the conversation up to max_id (on the phone /
 *    another app), with still_unread_count = the number of messages still unread according to Telegram → the conversation's unread count.
 *  - Outbox (updateReadHistoryOutbox / updateReadChannelOutbox): THE OTHER SIDE has read my sent messages up to max_id → the sent messages become
 *    'read' ("✓ Đã xem" (seen)).
 * The old code did it the other way round: when a customer read my messages, MY unread count was cleared (in normal groups, anyone reading cleared it), and when I
 * read on the phone it cleared nothing but marked my sent messages "đã xem" (seen); supergroups / channels (Channel) were not handled.
 * Does not import GramJS: it takes the update objects (className) so it can be tested.
 */

export type TelegramReadDirection = 'inbox' | 'outbox';

export interface TelegramReadUpdate {
  direction: TelegramReadDirection;
  /** Conversation id marked the GramJS way: user = 123, normal group = -123, supergroup / channel = -100123. */
  chatId: string;
  maxId: number;
  /** Inbox: the number of messages still unread according to Telegram. */
  stillUnreadCount?: number;
}

/** The newest message of the conversation considered when changing state (like DatabaseService.markAsRead): the whole conversation is not scanned. */
export const TELEGRAM_READ_SCOPE = 200;

function channelChatId(channelId: unknown): string {
  if (channelId === null || channelId === undefined) return '';
  const id = String(channelId); // BigInteger / number / string
  return /^\d+$/.test(id) && id !== '0' ? `-100${id}` : '';
}

/** Read update → direction + conversation; null if it is not a read update or data is missing. */
export function parseTelegramReadUpdate(update: any, peerToChatId: (peer: any) => string): TelegramReadUpdate | null {
  let direction: TelegramReadDirection;
  let chatId: string;
  switch (update?.className) {
    case 'UpdateReadHistoryInbox':
      direction = 'inbox';
      chatId = update.peer ? peerToChatId(update.peer) : '';
      break;
    case 'UpdateReadHistoryOutbox':
      direction = 'outbox';
      chatId = update.peer ? peerToChatId(update.peer) : '';
      break;
    case 'UpdateReadChannelInbox':
      direction = 'inbox';
      chatId = channelChatId(update.channelId);
      break;
    case 'UpdateReadChannelOutbox':
      direction = 'outbox';
      chatId = channelChatId(update.channelId);
      break;
    default:
      return null;
  }
  const maxId = Number(update.maxId);
  if (!chatId || !Number.isFinite(maxId) || maxId <= 0) return null;
  const read: TelegramReadUpdate = { direction, chatId, maxId };
  if (direction === 'inbox') {
    const still = Number(update.stillUnreadCount);
    if (Number.isFinite(still) && still >= 0) read.stillUnreadCount = Math.floor(still);
  }
  return read;
}

export interface TelegramReadDb {
  queryOne<T>(sql: string, params?: any[]): T | undefined;
  run(sql: string, params?: any[]): void;
}

export interface TelegramReadResult {
  /** Inbox: the new unread count, only when it differs from the stored value. */
  unread?: number;
  /** Inbox: everything read, so turn off the conversation's @ flag. */
  mentionCleared: boolean;
}

/** Write the read update to the DB. A conversation that changes nothing is not written to contacts (the caller does not emit an event). */
export function applyTelegramReadUpdate(db: TelegramReadDb, accountId: string, read: TelegramReadUpdate): TelegramReadResult {
  const result: TelegramReadResult = { mentionCleared: false };
  // Inbox: messages RECEIVED up to max_id; Outbox: messages SENT up to max_id (a Telegram message id is unique only within one conversation)
  db.run(
    `UPDATE messages SET status = 'read'
     WHERE id IN (SELECT id FROM messages WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ?)
       AND channel = 'telegram_user' AND is_sent = ? AND CAST(msg_id AS INTEGER) <= ? AND status != 'read'`,
    [accountId, read.chatId, TELEGRAM_READ_SCOPE, read.direction === 'outbox' ? 1 : 0, read.maxId],
  );
  if (read.direction === 'outbox') return result;

  const contact = db.queryOne<{ unread_count: number | null; has_mention: number | null }>(
    `SELECT unread_count, has_mention FROM contacts
     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [accountId, read.chatId],
  );
  if (!contact) return result;
  const unread = read.stillUnreadCount ?? 0;
  const unreadChanged = Number(contact.unread_count || 0) !== unread;
  const clearMention = unread === 0 && Number(contact.has_mention || 0) !== 0;
  if (!unreadChanged && !clearMention) return result;
  db.run(
    `UPDATE contacts SET unread_count = ?${clearMention ? ', has_mention = 0' : ''}
     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [unread, accountId, read.chatId],
  );
  if (unreadChanged) result.unread = unread;
  result.mentionCleared = clearMention;
  return result;
}
