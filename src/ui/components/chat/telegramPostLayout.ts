/**
 * Bài đăng kênh Telegram vẽ như Telegram: khung bài cố định chiều rộng, ảnh / video / album rộng hết khung (sát mép trên),
 * chữ ở dưới có khoảng đệm, cảm xúc trong khung, chân bài (người đăng · lượt xem · đã sửa · giờ), thanh bình luận.
 * Ảnh / video dọc: khung không hẹp lại theo ảnh — hai bên lấp bằng chính ảnh làm mờ, chữ có chỗ rộng (trước đây khung
 * co theo ảnh dọc nên chữ dồn thành cột hẹp).
 */
import React from 'react';

/** true = đang vẽ bên trong bài đăng kênh (media rộng hết khung, không khung / giờ riêng). */
export const TelegramPostLayoutContext = React.createContext(false);

/** Chiều rộng tối đa của khung bài. */
export const TELEGRAM_POST_MAX_WIDTH = '30rem';
/** Chiều rộng khung bài (CSS): tối đa 30rem, không vượt cột chat. */
export const TELEGRAM_POST_WIDTH = `min(${TELEGRAM_POST_MAX_WIDTH}, 100%)`;

/** Ảnh / video cao hơn tỉ lệ này (rộng / cao) thì lấp hai bên bằng ảnh mờ thay vì cao vô hạn. */
export const TELEGRAM_POST_MIN_ASPECT = 0.9;

/** Tỉ lệ khung media trong bài: theo media, nhưng không cao quá TELEGRAM_POST_MIN_ASPECT. */
export function telegramPostMediaAspect(width?: number | null, height?: number | null): { box: number; letterbox: boolean } {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const aspect = w > 0 && h > 0 ? w / h : 4 / 3;
  const box = Math.max(aspect, TELEGRAM_POST_MIN_ASPECT);
  return { box, letterbox: aspect < box - 0.01 };
}

/**
 * Số gọn đúng như Telegram Desktop (Lang::FormatCountToShort): dưới 10 000 giữ nguyên ("1166"), từ 10 000 → K, từ
 * 1 000 000 → M, một chữ số thập phân CẮT (không làm tròn): 12 399 → "12.3K", 10 050 → "10K", 2 150 000 → "2.1M".
 */
export function formatTelegramPostCount(value: number): string {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  const shorten = (divider: number, suffix: string) => {
    const tenths = Math.floor(n / (divider / 10));
    const whole = Math.floor(tenths / 10);
    const fraction = tenths % 10;
    return fraction ? `${whole}.${fraction}${suffix}` : `${whole}${suffix}`;
  };
  if (n >= 1_000_000) return shorten(1_000_000, 'M');
  if (n >= 10_000) return shorten(1_000, 'K');
  return String(n);
}

export interface TelegramPostMetaLike {
  postAuthor: string;
  views: number;
  comments: number;
  discussionChannelId: string;
  recentRepliers?: string[];
  commentsMaxId?: number;
  commentsReadMaxId?: number;
}

export interface TelegramPostStatsView {
  /** Tin mở phần bình luận (album: tin mang số bình luận). */
  postId: string;
  postAuthor: string;
  views: number;
  comments: number;
  recentRepliers: string[];
  /** Kênh có nhóm thảo luận → hiện thanh bình luận (kể cả 0 bình luận: "Để lại bình luận"). */
  hasDiscussion: boolean;
  /**
   * Có bình luận mới từ lần đọc trước (chấm xanh trên thanh bình luận, như Telegram). Chưa từng mở phần bình luận
   * (Telegram không gửi mốc đã đọc) thì không tính là chưa đọc.
   */
  unread: boolean;
}

/**
 * Số liệu một bài (album = nhiều tin): lượt xem lớn nhất, bình luận lấy ở tin mang thông tin bình luận — Telegram chỉ gắn
 * số bình luận vào một tin của album, trước đây đọc tin đầu album nên lệch / mất số bình luận.
 */
export function pickTelegramPostStats(items: Array<{ msgId: string; meta: TelegramPostMetaLike | null }>): TelegramPostStatsView | null {
  const posts = items.filter((item): item is { msgId: string; meta: TelegramPostMetaLike } => !!item.meta && !!item.msgId);
  if (!posts.length) return null;
  let chosen = posts.find((item) => item.meta.discussionChannelId) || posts[0];
  for (const item of posts) {
    if (item.meta.comments > chosen.meta.comments) chosen = item;
  }
  return {
    postId: String(chosen.msgId),
    postAuthor: posts.map((item) => item.meta.postAuthor).find(Boolean) || '',
    views: Math.max(...posts.map((item) => Number(item.meta.views) || 0)),
    comments: Math.max(0, Number(chosen.meta.comments) || 0),
    recentRepliers: (chosen.meta.recentRepliers || []).filter(Boolean).slice(0, 3),
    hasDiscussion: posts.some((item) => !!item.meta.discussionChannelId || item.meta.comments > 0),
    unread: (Number(chosen.meta.commentsReadMaxId) || 0) > 0
      && (Number(chosen.meta.commentsMaxId) || 0) > (Number(chosen.meta.commentsReadMaxId) || 0),
  };
}
