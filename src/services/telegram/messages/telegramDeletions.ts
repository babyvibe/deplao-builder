/**
 * Tin Telegram bị xoá (thu hồi) → đánh dấu trong DB, giữ nội dung + loại gốc để còn "Xem lại".
 *
 * Phạm vi ID của Telegram:
 * - UpdateDeleteChannelMessages: ID theo từng kênh / siêu nhóm (`-100…`), sự kiện mang sẵn kênh.
 * - UpdateDeleteMessages: hộp tin chung của tài khoản (chat riêng + nhóm thường), ID duy nhất trong tài khoản. Cùng số
 *   ở một kênh `-100…` là bài khác hoàn toàn — không được đụng tới.
 *
 * Trước đây nhánh hộp tin chung không lọc hội thoại và lấy nội dung gốc từ hàng ĐẦU TIÊN trùng msg_id: tin chữ trong
 * chat riêng thành "ảnh" rỗng ([Hình ảnh]) và các bài kênh trùng số bị đánh dấu thu hồi oan.
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
 * Đánh dấu thu hồi các tin `messageIds`. `channelThreadId` (`-100…`) khi xoá trong kênh / siêu nhóm, bỏ trống với hộp
 * tin chung. Mỗi hàng giữ nội dung / loại gốc của CHÍNH nó. Trả về: hội thoại → các msg_id đã đánh dấu.
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
      // Telegram giữ nguyên `content` khi thu hồi → nội dung gốc = recalled_content (lần trước) hoặc content
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
