/**
 * ChannelBadge.tsx - Shows the channel badge (Zalo / Facebook Messenger / Telegram) on avatars, contact cards, etc.
 * The Facebook channel is Messenger chat: it shows the Messenger logo on Messenger's gradient.
 */

import React, { useId } from 'react';
import { Channel, getChannelColor, getChannelLabel } from '../../../../configs/channels/channelConfig';
import { isZalo, isTelegram, isFacebook } from '@/lib/channels/channelHelper';

/** Messenger's logo gradient, behind the white Messenger glyph (badges, account pictures without a photo). */
export const MESSENGER_GRADIENT = 'radial-gradient(circle at 20% 100%, #0099FF 0%, #A033FF 60%, #FF5280 90%, #FF7061 100%)';

/** The Messenger glyph: speech bubble with the lightning bolt cut out (Simple Icons "messenger", CC0). */
const MESSENGER_PATH = 'M.001 11.639C.001 4.949 5.241 0 12.001 0S24 4.95 24 11.639c0 6.689-5.24 11.638-12 11.638-1.21 0-2.38-.16-3.47-.46a.96.96 0 00-.64.05l-2.39 1.05a.96.96 0 01-1.35-.85l-.07-2.14a.97.97 0 00-.32-.68A11.39 11.389 0 01.002 11.64zm8.32-2.19l-3.52 5.6c-.35.53.32 1.139.82.75l3.79-2.87c.26-.2.6-.2.87 0l2.8 2.1c.84.63 2.04.4 2.6-.48l3.52-5.6c.35-.53-.32-1.13-.82-.75l-3.79 2.87c-.25.2-.6.2-.86 0l-2.8-2.1a1.8 1.8 0 00-2.61.48z';

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

/** Icon of the Facebook Messenger channel: the white Messenger glyph, drawn on MESSENGER_GRADIENT. */
export function FacebookIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path fill="#FFFFFF" fillRule="evenodd" d={MESSENGER_PATH} />
    </svg>
  );
}

/** The Messenger logo in its colours (gradient bubble, white bolt), for big channel cards on a plain background. */
export function MessengerLogo({ size = 32 }: { size?: number }) {
  const gradientId = `messenger-logo-${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <defs>
        <radialGradient id={gradientId} cx="0.2" cy="1" r="1.2">
          <stop offset="0" stopColor="#0099FF" />
          <stop offset="0.6" stopColor="#A033FF" />
          <stop offset="0.9" stopColor="#FF5280" />
          <stop offset="1" stopColor="#FF7061" />
        </radialGradient>
      </defs>
      <path fill={`url(#${gradientId})`} fillRule="evenodd" d={MESSENGER_PATH} />
    </svg>
  );
}

export function TelegramIcon({ size = 10 }: { size?: number }) {
  return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="#ffffff">
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
      </svg>
  );
}

export default function ChannelBadge({ channel, size = 'md', className = '' }: Props) {
  const color = getChannelColor(channel);
  const sizeClass = SIZE_MAP[size];
  const iconSize = ICON_SIZE[size];

  const renderIcon = () => {
    if (isZalo(channel)) return <ZaloIcon size={iconSize} />;
    if (isTelegram(channel)) return <TelegramIcon size={iconSize} />;
    return <FacebookIcon size={iconSize} />;
  };

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full border border-border ${sizeClass} ${className}`}
      style={isFacebook(channel) ? { background: MESSENGER_GRADIENT } : { backgroundColor: color }}
      title={getChannelLabel(channel as Channel)}
    >
      {renderIcon()}
    </span>
  );
}

/** Positioned badge for avatars - absolute bottom-right */
export function ChannelBadgeOverlay({ channel, size = 'xs' }: Props) {
  return (
    <ChannelBadge
      channel={channel}
      size={size}
      className="absolute -bottom-0.5 -right-0.5"
    />
  );
}

