/**
 * Thông tin trình bày Telegram lưu chung trong messages.attachments nhưng KHÔNG phải ảnh / video / file: bài đăng kênh,
 * album, emoji tuỳ chỉnh, @nhắc tên, nguồn chuyển tiếp. Mọi chỗ tìm "tệp media đầu tiên" hoặc quyết định có tải media
 * không phải bỏ qua các loại này. Trước đây mỗi nơi tự liệt kê (thiếu telegram_mention → ảnh có chú thích @tên lấy nhầm
 * thẻ nhắc tên làm media, tin chữ có @tên vẫn thử tải media).
 */
export const TELEGRAM_META_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'telegram_post',
  'telegram_grouped_media',
  'custom_emoji',
  'telegram_mention',
  'telegram_forward',
]);

export function isTelegramMetaAttachment(attachment: unknown): boolean {
  return !!attachment && typeof attachment === 'object'
    && TELEGRAM_META_ATTACHMENT_TYPES.has(String((attachment as { type?: unknown }).type || ''));
}
