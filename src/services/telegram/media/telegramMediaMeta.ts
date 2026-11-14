import { strippedPhotoToJpg } from 'telegram/Utils';

/**
 * Extra info of Telegram media stored in messages.attachments (no network call).
 *
 * - Link preview (MessageMediaWebPage): GramJS `message.photo / .video / .document` returns the PAGE's media, so a link message is saved
 *   like an image / video. Adds `source: 'webpage'` + page name, title, description so the renderer draws a card like Telegram. Never
 *   use the `url` key (the renderer reads attachments[].url as the image source); the page URL is in `page_url`.
 * - Video: Api.Document has no w / h / duration; those values are in DocumentAttributeVideo (previously always saved as 0).
 * - Blurred cover (PhotoStrippedSize, a few hundred bytes available in the message) → JPEG data URL shown while the video is not yet downloaded.
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
