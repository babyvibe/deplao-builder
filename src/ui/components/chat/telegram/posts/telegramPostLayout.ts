/**
 * Telegram-style channel post: fixed-width frame, photo / video / album filling the frame edge to edge (flush with the top),
 * text below with padding, reactions inside the frame, post footer (author · views · edited · time), comment bar.
 * Portrait photo / video: the frame does not narrow to the image. Both sides are filled with the blurred image itself, and the text gets room
 * (before, the frame shrank to the portrait image, so the text was squeezed into a narrow column).
 */
import React from 'react';

/** true = currently drawing inside a channel post (media fills the frame, no separate frame or time). */
export const TelegramPostLayoutContext = React.createContext(false);

/** Maximum width of the post frame. */
export const TELEGRAM_POST_MAX_WIDTH = '30rem';
/** Post frame width (CSS): max 30rem, not wider than the chat column. */
export const TELEGRAM_POST_WIDTH = `min(${TELEGRAM_POST_MAX_WIDTH}, 100%)`;

/** Photos / videos taller than this ratio (width / height) get a blurred image on both sides instead of growing infinitely tall. */
export const TELEGRAM_POST_MIN_ASPECT = 0.9;

/** Media frame ratio in a post: follows the media, but never taller than TELEGRAM_POST_MIN_ASPECT. */
export function telegramPostMediaAspect(width?: number | null, height?: number | null): { box: number; letterbox: boolean } {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const aspect = w > 0 && h > 0 ? w / h : 4 / 3;
  const box = Math.max(aspect, TELEGRAM_POST_MIN_ASPECT);
  return { box, letterbox: aspect < box - 0.01 };
}

/**
 * Compact numbers exactly as Telegram Desktop does (Lang::FormatCountToShort): below 10 000 kept as is ("1166"), from 10 000 → K, from
 * 1 000 000 → M, one decimal digit TRUNCATED (not rounded): 12 399 → "12.3K", 10 050 → "10K", 2 150 000 → "2.1M".
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
  /** Message that opens the comments (album: the message that carries the comment count). */
  postId: string;
  postAuthor: string;
  views: number;
  comments: number;
  recentRepliers: string[];
  /** Channel with a discussion group → show the comment bar (even with 0 comments: "Để lại bình luận" (Leave a comment)). */
  hasDiscussion: boolean;
  /**
   * New comments since the last read (green dot on the comment bar, like Telegram). If the comments were never opened
   * (Telegram does not send a read mark), they do not count as unread.
   */
  unread: boolean;
}

/**
 * Stats of one post (album = several messages): the highest view count, and comments read from the message that carries the comment info. Telegram
 * attaches the comment count to only one message of an album. Before, the first message of the album was read, so the count was off or lost.
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
