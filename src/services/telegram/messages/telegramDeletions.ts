/**
 * Telegram message deleted (unsent / recalled) → marked in the DB, keeping its content + original type so "Xem lại" (View again) is still possible.
 *
 * Telegram's ID scope:
 * - UpdateDeleteChannelMessages: IDs per channel / supergroup (`-100…`); the event already carries the channel.
 * - UpdateDeleteMessages: the account's common inbox (private chats + normal groups), IDs unique within the account. The same number
 *   in a `-100…` channel is a completely different post; it must not be touched.
 *
 * Previously the common-inbox branch did not filter by conversation and took the original content from the FIRST row with a matching msg_id: text messages in
 * a private chat became an empty image message ("[Hình ảnh]" (Image)), and channel posts with the same number were wrongly marked as recalled.
 */

export interface TelegramDeletionDb {
  query<T = any>(sql: string, params?: any[]): T[];
  run(sql: string, params?: any[]): unknown;
}

interface DeletedRow {
  id: number;
  thread_id: string;
  content: string | null;
  msg_type: string | null;
  recalled_content: string | null;
  recalled_msg_type: string | null;
}

/**
 * Marks the messages `messageIds` as recalled. `channelThreadId` (`-100…`) when deleting in a channel / supergroup; left empty for the
 * common inbox. Each row keeps the content / original type of ITS OWN. Returns: conversation → the msg_ids that were marked.
 */
export function markTelegramMessagesDeleted(
  db: TelegramDeletionDb,
  accountId: string,
  messageIds: Array<string | number>,
  channelThreadId?: string,
  log?: (line: string) => void,
): Map<string, string[]> {
  const deletedByThread = new Map<string, string[]>();
  for (const id of messageIds) {
    const msgId = String(id);
    const rows = channelThreadId
      ? db.query<DeletedRow>(
        `SELECT id, thread_id, content, msg_type, recalled_content, recalled_msg_type FROM messages
         WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [msgId, accountId, channelThreadId],
      )
      : db.query<DeletedRow>(
        `SELECT id, thread_id, content, msg_type, recalled_content, recalled_msg_type FROM messages
         WHERE msg_id = ? AND owner_zalo_id = ? AND channel = 'telegram_user' AND thread_id NOT LIKE '-100%'`,
        [msgId, accountId],
      );
    for (const row of rows) {
      // Telegram keeps `content` unchanged on recall → original content = recalled_content (from last time) or content
      const recalledContent = row.recalled_content || row.content || null;
      const recalledMsgType = row.recalled_msg_type || (row.msg_type !== 'recalled' ? row.msg_type : null);
      log?.(`[TelegramUserListener] Recall msg ${msgId} in ${row.thread_id}: content="${String(recalledContent || '').slice(0, 100)}" type=${recalledMsgType || '-'}`);
      db.run(
        `UPDATE messages SET msg_type = 'recalled', status = 'recalled', is_recalled = 1,
         recalled_content = CASE WHEN recalled_content IS NULL OR recalled_content = '' THEN ? ELSE recalled_content END,
         recalled_msg_type = CASE WHEN recalled_msg_type IS NULL OR recalled_msg_type = '' THEN ? ELSE recalled_msg_type END
         WHERE id = ?`,
        [recalledContent, recalledMsgType, row.id],
      );
      const threadId = String(row.thread_id);
      const ids = deletedByThread.get(threadId) || [];
      ids.push(msgId);
      deletedByThread.set(threadId, ids);
    }
  }
  return deletedByThread;
}
