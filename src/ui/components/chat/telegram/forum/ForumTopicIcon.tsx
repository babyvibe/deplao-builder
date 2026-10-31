/**
 * Biểu tượng chủ đề forum như Telegram: General = "#", chủ đề có emoji tuỳ chỉnh = emoji đó (ảnh tĩnh, tải khi hiện ra),
 * còn lại = bong bóng màu của chủ đề (iconColor) với chữ cái đầu của tên.
 */
import React from 'react';
import { cn } from '@/lib/cn';
import { HashIcon } from '@/components/common/icons';
import { StickerThumb } from '@/components/chat/telegram/stickers/TelegramStickerTile';
import { forumTopicColor, isGeneralForumTopic, type ForumTopicRow } from '../../../../../shared/telegram/forumTopics';

/** Pha màu với trắng (0..1) — nửa trên bong bóng sáng hơn, như Telegram. */
function lighten(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
  const r = mix((value >> 16) & 0xff);
  const g = mix((value >> 8) & 0xff);
  const b = mix(value & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function ForumTopicIcon({ accountId, topic, className }: {
  accountId: string;
  topic: Pick<ForumTopicRow, 'id' | 'title' | 'iconColor' | 'iconEmoji'>;
  className?: string;
}) {
  // useId của React 18 có dấu ":" — bỏ đi cho chắc khi tham chiếu url(#…)
  const gradientId = `tg-topic-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (isGeneralForumTopic(topic)) {
    return (
      <span aria-hidden className={cn('flex items-center justify-center text-muted-foreground', className)}>
        <HashIcon className="h-[72%] w-[72%]" />
      </span>
    );
  }
  if (topic.iconEmoji?.id) return <StickerThumb accountId={accountId} item={topic.iconEmoji} className={className} />;
  const color = forumTopicColor(topic.iconColor);
  const letter = Array.from(String(topic.title || '').trim())[0]?.toUpperCase() || '#';
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={lighten(color, 0.25)} />
          <stop offset="1" stopColor={color} />
        </linearGradient>
      </defs>
      {/* Bong bóng chat có đuôi bên trái phía dưới */}
      <path d="M12 2.5a9.5 9.5 0 1 1-4.86 17.66l-3.37 1.06a.6.6 0 0 1-.75-.75l1.06-3.37A9.5 9.5 0 0 1 12 2.5z" fill={`url(#${gradientId})`} />
      <text x="12" y="12.4" textAnchor="middle" dominantBaseline="central" fontSize="10.5" fontWeight="700" fill="#fff">{letter}</text>
    </svg>
  );
}
