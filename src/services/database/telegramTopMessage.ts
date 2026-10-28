/** msg_id lớn nhất MTProto cấp được. Tin tạm cũ (gửi lạc quan) từng lấy Date.now() làm msg_id: vẫn là tin hợp lệ trên
 * máy nhưng không phải mã tin Telegram, không được làm mốc tải lịch sử. */
export const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;

/** Số tin mới nhất đọc để tìm mã tin Telegram lớn nhất của một hội thoại. */
export const TELEGRAM_TOP_SCAN_ROWS = 200;

const VALID_TELEGRAM_ID = `CAST(msg_id AS INTEGER) BETWEEN 1 AND ${MAX_TELEGRAM_MESSAGE_ID}`;

/**
 * Biểu thức SQL: mã tin Telegram lớn nhất đã lưu của một hội thoại (0 nếu chưa có). 4 tham số: owner, chat, owner, chat.
 *
 * MAX(msg_id) trên cả hội thoại phải đọc mọi tin của nó: dialog watch tính mốc này cho tới 100 kênh mỗi 30-45 s, đo trên
 * DB thật (28/10/2026) 1071 ms luồng chính mỗi lượt. Trong một hội thoại Telegram msg_id tăng theo thời gian, nên chỉ cần
 * 200 tin mới nhất (idx_messages_thread_cursor; `+channel` để SQLite không chọn idx_messages_channel): 58 ms mỗi lượt,
 * khớp 183/183 kênh. Kết quả chỉ có thể thấp hơn MAX thật (tải lại thừa vài tin, không bỏ sót). 200 tin mới nhất không có
 * mã hợp lệ nào (toàn tin tạm cũ) thì quét cả hội thoại như trước: COALESCE chỉ chạy truy vấn sau khi truy vấn trước NULL.
 */
export const TELEGRAM_TOP_MESSAGE_ID_SQL = `COALESCE(
    (SELECT MAX(CASE WHEN ${VALID_TELEGRAM_ID} THEN CAST(msg_id AS INTEGER) END) FROM (
        SELECT msg_id FROM messages
        WHERE owner_zalo_id = ? AND thread_id = ? AND +channel = 'telegram_user'
        ORDER BY timestamp DESC, msg_id DESC LIMIT ${TELEGRAM_TOP_SCAN_ROWS})),
    (SELECT MAX(CAST(msg_id AS INTEGER)) FROM messages
        WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user' AND ${VALID_TELEGRAM_ID}),
    0)`;

/** Tham số cho TELEGRAM_TOP_MESSAGE_ID_SQL. */
export function telegramTopMessageIdParams(ownerId: string, chatId: string): string[] {
  return [ownerId, chatId, ownerId, chatId];
}
