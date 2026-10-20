/**
 * Ảnh đại diện chữ kiểu Telegram cho người / hội thoại chưa có ảnh: 2 chữ (từ đầu + từ cuối, bỏ emoji) trên dải màu theo
 * id — cùng màu với tên người đó trong tin nhắn, ở mọi kênh và mọi nơi (danh sách hội thoại, đầu khung chat, thành viên…).
 * Kích thước + cỡ chữ do nơi dùng truyền qua className (vd "w-10 h-10 text-sm").
 */
import React from 'react';
import { nameInitial, peerColorIndex, peerInitials } from '@/lib/chat/peerStyle';

export interface PeerInitialsProps {
  /** id người dùng / hội thoại (quyết định màu); thiếu → màu theo tên */
  id?: string | number | null;
  name?: string | null;
  className?: string;
  title?: string;
  /** Chữ khi tên rỗng */
  fallback?: string;
  /** Ảnh rất nhỏ (≤ 20px): 1 chữ cho dễ đọc */
  single?: boolean;
  style?: React.CSSProperties;
}

export default function PeerInitials({ id, name, className = '', title, fallback = '?', single = false, style }: PeerInitialsProps) {
  const color = peerColorIndex(id, name) ?? 5;
  return (
    <div
      title={title}
      style={style}
      className={`chat-peer-${color} chat-peer-avatar rounded-full flex items-center justify-center font-semibold leading-none select-none flex-shrink-0 ${className}`}
    >
      {(single ? '' : peerInitials(name)) || nameInitial(name, fallback)}
    </div>
  );
}
