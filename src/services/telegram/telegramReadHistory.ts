/**
 * telegramReadHistory.ts — update "đã đọc" của Telegram (MTProto), theo đúng chiều:
 *  - Inbox  (updateReadHistoryInbox / updateReadChannelInbox): MÌNH đã đọc tin đến của hội thoại tới max_id (trên điện
 *    thoại / app khác), kèm still_unread_count = số tin còn chưa đọc theo Telegram → số chưa đọc của hội thoại.
 *  - Outbox (updateReadHistoryOutbox / updateReadChannelOutbox): NGƯỜI KHÁC đã đọc tin mình gửi tới max_id → tin gửi
 *    thành 'read' ("✓ Đã xem").
 * Bản cũ xử lý ngược: khách đọc tin của mình thì số chưa đọc của mình bị xoá (nhóm thường: ai đọc cũng xoá), mình đọc
 * trên điện thoại thì không xoá mà lại gắn "đã xem" cho tin mình gửi; siêu nhóm / kênh (Channel) không được xử lý.
 * Không import GramJS: nhận object update (className) để test được.
 */

export type TelegramReadDirection = 'inbox' | 'outbox';

export interface TelegramReadUpdate {
  direction: TelegramReadDirection;
  /** Id hội thoại đã đánh dấu kiểu GramJS: user = 123, nhóm thường = -123, siêu nhóm / kênh = -100123. */
  chatId: string;
  maxId: number;
  /** Inbox: số tin còn chưa đọc theo Telegram. */
  stillUnreadCount?: number;
}

/** Số tin mới nhất của hội thoại được xét khi đổi trạng thái (như DatabaseService.markAsRead) — không quét cả hội thoại. */
export const TELEGRAM_READ_SCOPE = 200;

function channelChatId(channelId: unknown): string {
  if (channelId === null || channelId === undefined) return '';
  const id = String(channelId); // BigInteger / number / string
  return /^\d+$/.test(id) && id !== '0' ? `-100${id}` : '';
}

/** Update đã đọc → hướng + hội thoại; null nếu không phải update đã đọc / thiếu dữ liệu. */
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
  /** Inbox: số chưa đọc mới — chỉ có khi khác giá trị đang lưu. */
  unread?: number;
  /** Inbox: đã đọc hết nên tắt cờ @ của hội thoại. */
  mentionCleared: boolean;
}

/** Ghi update đã đọc vào DB. Hội thoại không đổi gì → không ghi contacts (người gọi không phát event). */
export function applyTelegramReadUpdate(db: TelegramReadDb, accountId: string, read: TelegramReadUpdate): TelegramReadResult {
  const result: TelegramReadResult = { mentionCleared: false };
  // Inbox: tin NHẬN tới max_id; Outbox: tin GỬI tới max_id (id tin Telegram chỉ duy nhất trong 1 hội thoại)
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
