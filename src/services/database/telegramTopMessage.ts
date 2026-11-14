/** The largest msg_id MTProto can issue. Old temporary messages (optimistic sends) once used Date.now() as msg_id: they are still valid messages on
 * the machine but not Telegram message ids, so they must not be used as the history-loading mark. */
export const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;

/** Number of the newest messages read to find the largest Telegram message id of a conversation. */
export const TELEGRAM_TOP_SCAN_ROWS = 200;

const VALID_TELEGRAM_ID = `CAST(msg_id AS INTEGER) BETWEEN 1 AND ${MAX_TELEGRAM_MESSAGE_ID}`;

/**
 * SQL expression: the largest Telegram message id saved for a conversation (0 if none). 4 parameters: owner, chat, owner, chat.
 *
 * MAX(msg_id) over the whole conversation would have to read every message in it: the dialog watch computes this mark for up to 100 channels every 30-45 s, measured on a
 * real DB (28/10/2026) at 1071 ms of main thread per pass. In a Telegram conversation msg_id increases over time, so the 200
 * newest messages are enough (idx_messages_thread_cursor; `+channel` so SQLite does not pick idx_messages_channel): 58 ms per pass,
 * matches 183/183 channels. The result can only be lower than the real MAX (a few extra messages are reloaded, none are missed). If the 200
 * newest messages have no valid id (only old temporary messages), the whole conversation is scanned as before: COALESCE only runs the second query after the first returns NULL.
 */
export const TELEGRAM_TOP_MESSAGE_ID_SQL = `COALESCE(
    (SELECT MAX(CASE WHEN ${VALID_TELEGRAM_ID} THEN CAST(msg_id AS INTEGER) END) FROM (
        SELECT msg_id FROM messages
        WHERE owner_zalo_id = ? AND thread_id = ? AND +channel = 'telegram_user'
        ORDER BY timestamp DESC, msg_id DESC LIMIT ${TELEGRAM_TOP_SCAN_ROWS})),
    (SELECT MAX(CAST(msg_id AS INTEGER)) FROM messages
        WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user' AND ${VALID_TELEGRAM_ID}),
    0)`;

/** Parameters for TELEGRAM_TOP_MESSAGE_ID_SQL. */
export function telegramTopMessageIdParams(ownerId: string, chatId: string): string[] {
  return [ownerId, chatId, ownerId, chatId];
}
