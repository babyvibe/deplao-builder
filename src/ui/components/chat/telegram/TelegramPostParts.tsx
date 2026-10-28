/**
 * Các phần của bài đăng kênh Telegram vẽ như Telegram: cảm xúc nằm TRONG khung bài, chân bài (người đăng · 👁 lượt xem ·
 * đã sửa · giờ), thanh bình luận (ảnh người bình luận gần đây + "N bình luận" / "Để lại bình luận" + ›).
 */
import React from 'react';
import PeerInitials from '@/components/common/PeerInitials';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { displayReactionEmoji } from '../ReactionComponents';
import { formatBubbleTime, formatFullDateTime } from '../MessageTime';
import { formatTelegramPostCount } from '../telegramPostLayout';

/** Cảm xúc của bài: bấm = thả / gỡ cảm xúc đó (kênh không cho xem ai thả, như Telegram). */
export function TelegramPostReactions({ counts, myEmoji, onToggle }: {
  counts: Record<string, number>;
  myEmoji: string | null;
  onToggle: (emoji: string, mine: boolean) => void;
}) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3 pt-2">
      {entries.map(([emoji, count]) => {
        const mine = myEmoji === emoji;
        return (
          <button
            key={emoji}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(emoji, mine);
            }}
            title={mine ? 'Bỏ cảm xúc' : 'Thả cảm xúc này'}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors select-none ${
              mine ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-foreground hover:bg-primary/20'
            }`}
          >
            <span>{displayReactionEmoji(emoji)}</span>
            <span className="font-medium">{formatTelegramPostCount(count)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Chân bài như Telegram: người đăng, 👁 lượt xem, "đã sửa", giờ — dồn phải. */
export function TelegramPostFooter({ postAuthor, views, edited, timestamp }: {
  postAuthor?: string;
  views: number;
  edited?: boolean;
  timestamp?: number | string | null;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5 px-3 pb-1.5 pt-1 text-[11px] leading-4 text-subtle-foreground select-none">
      {postAuthor && <span className="min-w-0 truncate">{postAuthor}</span>}
      {views > 0 && (
        <span className="inline-flex shrink-0 items-center gap-0.5" title={`${views.toLocaleString('vi-VN')} lượt xem`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {formatTelegramPostCount(views)}
        </span>
      )}
      {edited && <span className="shrink-0">đã sửa</span>}
      <span className="shrink-0 cursor-default" title={formatFullDateTime(timestamp)}>{formatBubbleTime(timestamp)}</span>
    </div>
  );
}

/** Thanh bình luận cuối bài: bấm mở phần bình luận (nhóm thảo luận) ngay trong khung chat. */
export function TelegramPostCommentsBar({ count, repliers, peers, isSent, unread, onOpen }: {
  count: number;
  repliers: string[];
  peers: Record<string, { name: string; avatar: string }>;
  isSent?: boolean;
  /** Có bình luận mới từ lần đọc trước → chấm xanh (như Telegram) */
  unread?: boolean;
  onOpen: () => void;
}) {
  const ring = isSent ? 'ring-bubble-out' : 'ring-bubble-in';
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="flex w-full items-center gap-2 border-t border-foreground/10 px-3 py-2 text-left text-[13px] font-medium text-primary transition-colors hover:bg-foreground/[0.04]"
    >
      {repliers.length ? (
        <span className="flex shrink-0 -space-x-1.5">
          {repliers.slice(0, 3).map((id) => {
            const peer = peers[id];
            const avatar = peer?.avatar ? toLocalMediaUrl(peer.avatar) : '';
            return avatar ? (
              <img key={id} src={avatar} alt="" className={`h-6 w-6 rounded-full object-cover ring-2 ${ring}`} />
            ) : (
              <PeerInitials key={id} id={id} name={peer?.name || ''} single className={`h-6 w-6 text-[10px] ring-2 ${ring}`} />
            );
          })}
        </span>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
          <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
        </svg>
      )}
      <span className="min-w-0 flex-1 truncate">
        {count > 0 ? `${formatTelegramPostCount(count)} bình luận` : 'Để lại bình luận'}
      </span>
      {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" title="Có bình luận mới" aria-label="Có bình luận mới" />}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70" aria-hidden>
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </button>
  );
}
