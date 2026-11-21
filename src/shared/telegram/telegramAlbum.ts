/**
 * Helpers for Telegram albums (messages.SendMultiMedia / sendMediaGroup).
 *
 * A Telegram album holds at most 10 media items and only photos / videos can be grouped; anything else has to be
 * sent as its own message. Shared by the composer adapters so every multi-image send (picker, paste, drop, forward)
 * goes out as ONE album instead of a message per photo.
 */

/** Telegram's hard limit for one album. */
export const TELEGRAM_ALBUM_MAX = 10;

const TELEGRAM_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'jfif', 'heic']);

/** True when the file can ride in an album as a photo. */
export function isTelegramImagePath(filePath: string): boolean {
  const ext = (String(filePath ?? '').split('.').pop() || '').toLowerCase();
  return TELEGRAM_IMAGE_EXTENSIONS.has(ext);
}

/** `msgId` out of a `buildQuotePayload` JSON string (the album replies to it). */
export function quoteMsgId(quote?: string | null): string | undefined {
  if (!quote) return undefined;
  try {
    const parsed = typeof quote === 'string' ? JSON.parse(quote) : (quote as any);
    return parsed?.msgId || parsed?.msg_id || undefined;
  } catch {
    return undefined;
  }
}

/** Split a list into album-sized chunks (keeps the original order). */
export function chunkForAlbum<T>(items: readonly T[], max = TELEGRAM_ALBUM_MAX): T[][] {
  const size = Math.max(1, Math.floor(max) || TELEGRAM_ALBUM_MAX);
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
