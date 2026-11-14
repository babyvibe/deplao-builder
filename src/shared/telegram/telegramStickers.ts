/** Telegram sticker / GIF: shared data type for main ↔ renderer (sticker / GIF table, sticker set popup). */

export type TelegramStickerFormat = 'webp' | 'tgs' | 'webm' | 'gif' | 'image';

export interface TelegramStickerItem {
  /** Document id (64-bit, decimal string), sent / downloaded by this id. */
  id: string;
  emoji: string;
  format: TelegramStickerFormat;
  width: number;
  height: number;
  /** Sticker set container (not present for GIFs). */
  setId?: string;
  setAccessHash?: string;
  setShortName?: string;
}

export interface TelegramStickerSetRef {
  id?: string;
  accessHash?: string;
  shortName?: string;
}

export interface TelegramStickerSetInfo {
  id: string;
  accessHash: string;
  shortName: string;
  title: string;
  count: number;
  /** Added to the account (shown in the sticker table in every Telegram app). */
  installed: boolean;
  archived: boolean;
}

/** Sticker set with a few representative stickers (search results / trending sets). */
export interface TelegramCoveredStickerSet extends TelegramStickerSetInfo {
  covers: TelegramStickerItem[];
}

/** Type of the downloaded file used for drawing: static image, Lottie (.tgs), video (.webm sticker / .mp4 GIF). */
export type TelegramStickerFileKind = 'image' | 'tgs' | 'video';
