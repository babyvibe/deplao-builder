/**
 * Telegram message reactions laid out and working like Telegram: one chip per reaction INSIDE the message frame, on its last
 * line (the send time sits at the end of that line); for stickers / photos without a frame, right below. The chip you chose
 * is filled with the accent colour. Clicking a chip adds that reaction or removes it (Telegram keeps one reaction per person,
 * a new one replaces the old). In a private chat or a group, a reaction given by at most 3 people who are all known shows
 * their small pictures instead of the number (channels are anonymous: numbers only).
 */
import React from 'react';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { displayReactionEmoji } from './ReactionComponents';
import { formatTelegramPostCount } from '../../telegram/posts/telegramPostLayout';
import { sameReaction } from '@/lib/chat/reactions/reactionChoices';
import { tr } from '../../../../../shared/i18n';

/** Telegram shows reactors' pictures instead of the count up to this many people. */
export const TELEGRAM_CHIP_MAX_AVATARS = 3;

export interface TelegramReactionEntry { total: number; users: Record<string, number> }

export interface TelegramReactionChip {
  emoji: string;
  count: number;
  mine: boolean;
  /** Reactors shown as pictures (empty = show the count). */
  reactorIds: string[];
}

/**
 * Chips of one message, most given first. `showAvatars`: private chat / group (not a channel). Pictures only when every
 * reactor of that reaction is known (Telegram returns a few recent reactors with the counts).
 */
export function telegramReactionChips(
  emoji: Record<string, TelegramReactionEntry>,
  myId: string | null | undefined,
  showAvatars: boolean,
): TelegramReactionChip[] {
  return Object.entries(emoji || {})
    .filter(([, entry]) => Number(entry?.total) > 0)
    .sort((a, b) => Number(b[1].total) - Number(a[1].total))
    .map(([key, entry]) => {
      const count = Number(entry.total) || 0;
      const reactorIds = Object.keys(entry.users || {}).filter((uid) => Number(entry.users[uid]) > 0);
      const asAvatars = showAvatars && count <= TELEGRAM_CHIP_MAX_AVATARS && reactorIds.length === count;
      return {
        emoji: key,
        count,
        mine: !!myId && Number(entry.users?.[myId]) > 0,
        reactorIds: asAvatars ? reactorIds : [],
      };
    });
}

export interface ReactionPeer { name: string; avatarUrl: string }

function ReactorPicture({ id, peerOf }: { id: string; peerOf: (id: string) => ReactionPeer }) {
  const [broken, setBroken] = React.useState(false);
  const peer = peerOf(id);
  const common = 'h-[1.125rem] w-[1.125rem] rounded-full ring-1 ring-card';
  return peer.avatarUrl && !broken
    ? <img src={peer.avatarUrl} alt="" title={peer.name} className={`${common} object-cover`} onError={() => setBroken(true)} draggable={false} />
    : <PeerInitials id={id} name={peer.name} fallback="?" className={`${common} text-[8px]`} title={peer.name} />;
}

export function TelegramReactionChips({ chips, peerOf, onToggle, className = '', trailingSpacerClass }: {
  chips: readonly TelegramReactionChip[];
  peerOf: (id: string) => ReactionPeer;
  onToggle: (emoji: string, mine: boolean) => void;
  className?: string;
  /** Inside the frame: keep room at the end of the line for the send time (same width as on a text line). */
  trailingSpacerClass?: string;
}) {
  if (!chips.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} data-telegram-reactions="">
      {chips.map((chip) => (
        <button
          key={chip.emoji}
          type="button"
          data-reaction-chip={chip.emoji}
          data-mine={chip.mine ? '' : undefined}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(chip.emoji, chip.mine);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          title={chip.mine ? tr('Bỏ cảm xúc') : tr('Thả cảm xúc này')}
          className={`flex h-6 items-center gap-1 rounded-full px-2 text-xs transition-colors select-none ${
            // A clear tint + edge so the chips stand out on dark bubbles too (a 10 % tint vanished in the dark theme)
            chip.mine ? 'bg-primary text-primary-foreground' : 'bg-primary/20 text-foreground ring-1 ring-inset ring-primary/35 hover:bg-primary/30'
          }`}
        >
          <span className="leading-none">{displayReactionEmoji(chip.emoji)}</span>
          {chip.reactorIds.length > 0 ? (
            <span className="flex -space-x-1">
              {chip.reactorIds.map((id) => <ReactorPicture key={id} id={id} peerOf={peerOf} />)}
            </span>
          ) : (
            <span className="font-medium tabular-nums">{formatTelegramPostCount(chip.count)}</span>
          )}
        </button>
      ))}
      {trailingSpacerClass && <span aria-hidden="true" className={`inline-block h-4 ${trailingSpacerClass} select-none`} />}
    </div>
  );
}

/** Your reaction on a Telegram message (Telegram keeps one per person). */
export function myTelegramReaction(emoji: Record<string, TelegramReactionEntry> | undefined, myId: string | null | undefined): string | null {
  if (!myId) return null;
  return Object.entries(emoji || {}).find(([, entry]) => Number(entry?.users?.[myId]) > 0)?.[0] || null;
}

/** Clicking the reaction button / double-clicking the message: the quick reaction, or remove it when it is already yours. */
export function quickReactionAction(quick: string, mine: string | null): 'add' | 'remove' {
  return sameReaction(quick, mine) ? 'remove' : 'add';
}
