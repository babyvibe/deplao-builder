/**
 * ChannelBadge.tsx — Hiển thị badge kênh (Zalo / Facebook) trên avatar, contact card, etc.
 */

import React from 'react';
import { Channel, getChannelColor } from '../../../configs/channelConfig';

interface Props {
  channel: Channel;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

const SIZE_MAP = {
  xs: 'w-3.5 h-3.5',
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
};

const ICON_SIZE = {
  xs: 8,
  sm: 10,
  md: 12,
};

export function ZaloIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <path d="M80,18v44c0,5-2,9.5-5.3,12.8C71.4,78,66.9,80,62,80H18C8.1,80,0,71.9,0,62V18C0,8.1,8.1,0,18,0h44C71.9,0,80,8.1,80,18z" fill="#2B6AFF"/>
      <path d="M80,18v44c0,5-2,9.5-5.3,12.8H33c-9.9,0-18-8.1-18-18V13.9C15,8.3,17.6,3.3,21.6,0H62C71.9,0,80,8.1,80,18z" fill="#FFFFFF"/>
      <path d="M37.5,58l23.1-33.3v-0.3h-21v-9.1h35.2v6.3L52.2,54.5v0.3h23v9.1H37.5V58z" fill="#2B6AFF"/>
    </svg>
  );
}

export function FacebookIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path fill="#FFFFFF" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>
  );
}

export function TelegramIcon({ size = 10 }: { size?: number }) {
  return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
      </svg>
  );
}

export default function ChannelBadge({ channel, size = 'sm', className = '' }: Props) {
  const color = getChannelColor(channel);
  const sizeClass = SIZE_MAP[size];
  const iconSize = ICON_SIZE[size];

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border border-[#1a1d27] ${sizeClass} ${className}`}
      style={{ backgroundColor: color }}
      title={channel === 'zalo' ? 'Zalo' : 'Facebook'}
    >
      {channel === 'zalo'
        ? <ZaloIcon size={iconSize} />
        : <FacebookIcon size={iconSize} />
      }
    </span>
  );
}

/** Positioned badge for avatars — absolute bottom-right */
export function ChannelBadgeOverlay({ channel, size = 'xs' }: Props) {
  return (
    <ChannelBadge
      channel={channel}
      size={size}
      className="absolute -bottom-0.5 -right-0.5"
    />
  );
}

