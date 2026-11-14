/**
 * Telegram-style letter avatar for a person / conversation without a photo: 2 letters (first word + last word, emoji removed) on a color strip by
 * id, the same color as that person's name in messages, everywhere in every channel (conversation list, chat window header, members…).
 * The size + font size are passed by the caller through className (e.g. "w-10 h-10 text-sm").
 */
import React from 'react';
import { nameInitial, peerColorIndex, peerInitials } from '@/lib/chat/messages/peerStyle';

export interface PeerInitialsProps {
  /** User / conversation id (decides the color); missing → color by name */
  id?: string | number | null;
  name?: string | null;
  className?: string;
  title?: string;
  /** Text when the name is empty */
  fallback?: string;
  /** Very small image (≤ 20px): 1 letter so it is easier to read */
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
