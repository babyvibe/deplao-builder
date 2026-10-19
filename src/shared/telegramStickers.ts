/** Sticker / GIF Telegram — kiểu dữ liệu dùng chung main ↔ renderer (bảng sticker / GIF, popup bộ sticker). */

export type TelegramStickerFormat = 'webp' | 'tgs' | 'webm' | 'gif' | 'image';

export interface TelegramStickerItem {
  /** Document id (64 bit, chuỗi thập phân) — gửi / tải theo id này. */
  id: string;
  emoji: string;
  format: TelegramStickerFormat;
  width: number;
  height: number;
  /** Bộ chứa sticker (không có với GIF). */
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
  /** Đã thêm vào tài khoản (hiện trong bảng sticker ở mọi app Telegram). */
  installed: boolean;
  archived: boolean;
}

/** Bộ sticker kèm vài sticker đại diện (kết quả tìm / bộ thịnh hành). */
export interface TelegramCoveredStickerSet extends TelegramStickerSetInfo {
  covers: TelegramStickerItem[];
}

/** Loại file đã tải về để vẽ: ảnh tĩnh, Lottie (.tgs), video (.webm sticker / .mp4 GIF). */
export type TelegramStickerFileKind = 'image' | 'tgs' | 'video';
