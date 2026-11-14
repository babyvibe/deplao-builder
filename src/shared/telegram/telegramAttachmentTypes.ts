/**
 * Telegram presentation info stored together in messages.attachments but NOT photos / videos / files: channel posts,
 * albums, custom emoji, @mentions, forward sources. Every place that looks for the "first media file" or decides whether to download media
 * must skip these types. Previously each place listed them on its own (missing telegram_mention → a photo with an @name caption picked the
 * mention card as its media, and a text message with @name still tried to download media).
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
