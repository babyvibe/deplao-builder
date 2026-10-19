/**
 * Giờ gửi hiển thị trong tin nhắn — dùng chung cho mọi loại tin để đồng nhất.
 *  - BubbleTime: dòng giờ nhỏ ở cuối bong bóng / caption / thẻ (file, link, danh thiếp…).
 *  - MediaTimeBadge: giờ nổi góc dưới phải trên ảnh/album/video/sticker KHÔNG có caption
 *    (đặt trong một phần tử `relative`).
 */
import React from 'react';

export function formatBubbleTime(timestamp?: number | string | null): string {
  const n = Number(timestamp);
  if (!n || !Number.isFinite(n)) return '';
  return new Date(n).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export function BubbleTime({ timestamp, className = '' }: { timestamp?: number | string | null; className?: string }) {
  const t = formatBubbleTime(timestamp);
  if (!t) return null;
  return (
    <div className={`mt-1 text-[11px] leading-none text-subtle-foreground select-none ${className}`}>{t}</div>
  );
}

export function MediaTimeBadge({ timestamp, className = '' }: { timestamp?: number | string | null; className?: string }) {
  const t = formatBubbleTime(timestamp);
  if (!t) return null;
  return (
    <span
      className={`pointer-events-none absolute bottom-1.5 right-1.5 z-[1] rounded-full bg-black/45 px-1.5 py-[3px] text-[11px] leading-none text-white select-none ${className}`}
    >
      {t}
    </span>
  );
}
