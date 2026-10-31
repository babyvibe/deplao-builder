import { strippedPhotoToJpg } from 'telegram/Utils';

/**
 * Thông tin phụ của media Telegram lưu trong messages.attachments (không gọi mạng).
 *
 * - Link preview (MessageMediaWebPage): GramJS `message.photo / .video / .document` trả media CỦA TRANG, nên tin link được lưu
 *   như ảnh / video. Gắn thêm `source: 'webpage'` + tên trang, tiêu đề, mô tả để renderer vẽ thẻ như Telegram. Không bao
 *   giờ dùng khoá `url` (renderer đọc attachments[].url làm nguồn ảnh) — URL trang nằm ở `page_url`.
 * - Video: Api.Document không có w / h / duration — các giá trị đó ở DocumentAttributeVideo (trước đây luôn lưu 0).
 * - Ảnh bìa mờ (PhotoStrippedSize, vài trăm byte có sẵn trong tin) → data URL JPEG để hiện khi video chưa tải.
 */

const MAX_DESCRIPTION = 600;

export function telegramWebpageMeta(media: any): Record<string, string> {
  if (media?.className !== 'MessageMediaWebPage') return {};
  const webpage = media?.webpage || {};
  if (webpage.className && webpage.className !== 'WebPage') return {};
  return {
    source: 'webpage',
    page_url: String(webpage.url || ''),
    site_name: String(webpage.siteName || ''),
    title: String(webpage.title || ''),
    description: String(webpage.description || '').slice(0, MAX_DESCRIPTION),
  };
}

export function telegramVideoAttributes(document: any): { duration: number; width: number; height: number } {
  const attribute = (document?.attributes || []).find((item: any) => item?.className === 'DocumentAttributeVideo');
  return {
    duration: Number(attribute?.duration || 0),
    width: Number(attribute?.w || 0),
    height: Number(attribute?.h || 0),
  };
}

export function telegramStrippedThumb(document: any): string {
  const stripped = (document?.thumbs || []).find((thumb: any) =>
    thumb?.className === 'PhotoStrippedSize' && thumb?.bytes?.length > 3);
  if (!stripped) return '';
  try {
    return `data:image/jpeg;base64,${strippedPhotoToJpg(Buffer.from(stripped.bytes)).toString('base64')}`;
  } catch {
    return '';
  }
}
