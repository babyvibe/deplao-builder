/**
 * Đã trả lời / chưa trả lời của một hội thoại — dùng chung main (DatabaseService.getContactsFiltered → cột `is_replied`)
 * và renderer (cập nhật khi có tin mới, mở hội thoại, bộ lọc "Chưa trả lời").
 *
 * Quy tắc: theo tin THẬT mới nhất của hội thoại — của mình (gửi từ app hay máy khác) = đã trả lời (1), của người kia =
 * chưa trả lời (0), chưa có tin thật = không rõ (null). Thông báo hệ thống, bản tin OA, tin mẫu của Trang, tin đã xoá
 * không tính. "Chưa trả lời" chỉ áp cho hội thoại 1:1: trong nhóm, tin cuối của người khác không phải câu hỏi chờ mình.
 *
 * Đánh dấu đã trả lời (tay / hàng loạt, không cần gửi tin): contacts.reply_marked_at = thời điểm tin mới nhất lúc đánh
 * dấu — tin của người kia tới SAU mốc này thì hội thoại tự thành "chưa trả lời" lại.
 *
 * Trước đây trạng thái chỉ nằm trong bộ nhớ (mở lại app là mất), tin cũ tải bù / tin hệ thống cũng đổi trạng thái, và
 * bộ lọc "Chưa trả lời" thực chất là "chưa đọc".
 */

/** Loại tin không cho biết ai đang chờ ai. */
export const REPLY_STATE_IGNORED_MSG_TYPES: readonly string[] = [
  'system', 'chat.webcontent', 'chat.webcontent.v2', 'fb.template', 'deleted',
];

const IGNORED = new Set(REPLY_STATE_IGNORED_MSG_TYPES);

export function countsForReplyState(msgType: unknown): boolean {
  return !IGNORED.has(String(msgType ?? ''));
}

/**
 * Cột SQL cho bảng contacts (tên `alias`): đã trả lời theo tin thật mới nhất của hội thoại — 1 / 0, NULL khi chưa có tin
 * thật. `withMarked`: bảng có cột reply_marked_at (đánh dấu đã trả lời tay) — tin cũ hơn / bằng mốc tính là đã trả lời.
 * Tra theo chỉ mục messages(owner_zalo_id, thread_id, timestamp): ~10 ms cho trang 200 hội thoại.
 */
export function contactReplyStateSql(alias = 'contacts', withMarked = true): string {
  const types = REPLY_STATE_IGNORED_MSG_TYPES.map((type) => `'${type}'`).join(', ');
  const state = withMarked
    ? `CASE WHEN m.is_sent = 1 OR m.timestamp <= COALESCE(${alias}.reply_marked_at, 0) THEN 1 ELSE 0 END`
    : 'm.is_sent';
  return `(SELECT ${state} FROM messages m
    WHERE m.owner_zalo_id = ${alias}.owner_zalo_id AND m.thread_id = ${alias}.contact_id
      AND COALESCE(m.msg_type, '') NOT IN (${types})
    ORDER BY m.timestamp DESC LIMIT 1)`;
}

/** Hội thoại 1:1 mà tin thật mới nhất là của người kia. */
export function isUnrepliedConversation(contact: { is_replied?: number | null; contact_type?: string | null } | null | undefined): boolean {
  return !!contact && contact.is_replied === 0 && contact.contact_type !== 'group';
}

/** Đang "đã trả lời" chỉ nhờ đánh dấu tay (tin cuối vẫn của người kia) → cho "Đánh dấu chưa trả lời". */
export function isManuallyMarkedReplied(contact: { is_replied?: number | null; reply_marked_at?: number | null } | null | undefined): boolean {
  return !!contact && contact.is_replied === 1 && Number(contact.reply_marked_at) > 0;
}

/**
 * Trạng thái theo các tin đã tải (cũ → mới hay mới → cũ đều được): 1 / 0 / null khi chưa có tin thật. `markedAt`:
 * mốc đánh dấu đã trả lời tay (reply_marked_at) — tin của người kia không mới hơn mốc này tính là đã trả lời.
 */
export function replyStateFromMessages(
  messages: ReadonlyArray<{ msg_id?: string | number | null; msg_type?: string | null; is_sent?: number | boolean | null; timestamp?: number | string | null }> | null | undefined,
  markedAt?: number | null,
): 0 | 1 | null {
  let latest: { ts: number; sent: boolean } | null = null;
  for (const message of messages || []) {
    if (!message) continue;
    const id = String(message.msg_id ?? '');
    if (id.startsWith('temp_') || id.startsWith('retry_')) continue; // đang gửi: tính khi đã gửi xong
    if (!countsForReplyState(message.msg_type)) continue;
    const ts = Number(message.timestamp) || 0;
    if (!latest || ts >= latest.ts) latest = { ts, sent: message.is_sent === 1 || message.is_sent === true };
  }
  if (!latest) return null;
  if (latest.sent) return 1;
  const marked = Number(markedAt) || 0;
  return marked > 0 && latest.ts <= marked ? 1 : 0;
}

/**
 * Tin vừa đến có đổi trạng thái không: chỉ tin thật, mới nhất của hội thoại (tin cũ tải bù / lịch sử không đổi trạng
 * thái — trước đây bù tin của người kia sau khi mình đã trả lời làm hội thoại thành "chưa trả lời").
 */
export function replyStateForIncoming(
  message: { msgType?: unknown; timestamp?: unknown; isSelf?: boolean; silent?: boolean },
  currentLastMessageTime: unknown,
): 0 | 1 | undefined {
  if (message.silent || !countsForReplyState(message.msgType)) return undefined;
  const ts = Number(message.timestamp) || 0;
  const current = Number(currentLastMessageTime) || 0;
  if (ts > 0 && current > 0 && ts < current) return undefined;
  return message.isSelf ? 1 : 0;
}
