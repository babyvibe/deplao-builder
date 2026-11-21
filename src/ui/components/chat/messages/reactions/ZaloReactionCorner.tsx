/**
 * Zalo message reactions working like Zalo (checked on Zalo Web), on the OUTER bottom corner of the message, the same place as
 * Telegram's reaction button: bottom right of others' messages (right after the send time), bottom left of yours (they sit on
 * the right of the chat), the summary on the inner side of the button:
 * - the reaction button: an outline 👍 until you react, then your latest reaction. Clicking it adds that reaction again: Zalo
 *   counts every tap (+1). A message nobody reacted to shows it only when the mouse rests on the message (200 ms).
 * - holding the mouse on the button opens Zalo's horizontal bar 👍 ❤️ 😆 😮 😭 😡; once you reacted it ends with ✕, which
 *   removes ALL your reactions on that message (Zalo has no other way to take one back).
 * - left of the button: the summary, up to 3 kinds (most first) and the total, also when it is 1. Clicking it shows who reacted.
 * Without reactions the button sits on the frame's edge right after the send time; with the summary both sit just under the
 * frame, so the summary never covers the send time (bottom-right inside the frame).
 */
import React from 'react';
import { CloseIcon, ThumbsUpIcon } from '@/components/common/icons';
import { displayReactionEmoji } from './ReactionComponents';
import { REACTION_BUTTON_REVEAL_CLASS } from './MessageReactionCorner';
import { tr } from '../../../../../shared/i18n';

/** Zalo's summary shows at most 3 kinds of reaction. */
export const ZALO_SUMMARY_KINDS = 3;

/** Summary of a message's reactions: the kinds given most (up to 3) and the total of every tap. */
export function zaloReactionSummary(counts: Record<string, number>): { top: string[]; total: number } {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  return {
    top: entries.slice(0, ZALO_SUMMARY_KINDS).map(([emoji]) => emoji),
    total: entries.reduce((sum, [, count]) => sum + count, 0),
  };
}

/** Free room around the button decides where the bar opens: up (default) or down, right-aligned (default) or left-aligned. */
export function placeZaloReactionBar(
  room: { above: number; left: number },
  bar: { width: number; height: number },
  edgeGap = 8,
): { side: 'above' | 'below'; align: 'right' | 'left' } {
  return {
    side: room.above >= bar.height + edgeGap ? 'above' : 'below',
    align: room.left >= bar.width + edgeGap ? 'right' : 'left',
  };
}

export function ZaloReactionBar({ emojis, canRemove, onPick, onRemove }: {
  emojis: readonly string[];
  /** You have reactions on this message: the bar ends with ✕. */
  canRemove: boolean;
  onPick: (emoji: string) => void;
  onRemove: () => void;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [layout, setLayout] = React.useState<{ side: 'above' | 'below'; align: 'right' | 'left' }>({ side: 'above', align: 'right' });
  React.useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const anchor = wrapper?.parentElement; // the box of the reaction button
    if (!wrapper || !anchor) return;
    const scroller = anchor.closest('.overflow-y-auto') as HTMLElement | null;
    const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, left: 0 };
    const button = anchor.getBoundingClientRect();
    const next = placeZaloReactionBar(
      { above: button.top - bounds.top, left: button.right - bounds.left },
      { width: wrapper.offsetWidth, height: wrapper.offsetHeight },
    );
    setLayout((prev) => (prev.side === next.side && prev.align === next.align ? prev : next));
  }, [canRemove]);
  const below = layout.side === 'below';
  return (
    <div
      ref={wrapperRef}
      className={`absolute z-30 ${below ? 'top-full pt-1.5' : 'bottom-full pb-1.5'} ${layout.align === 'right' ? 'right-0' : 'left-0'}`}
      data-side={layout.side}
    >
      <div role="menu" aria-label={tr('Thả cảm xúc')} className="flex items-center gap-0.5 rounded-full border border-input bg-card px-1.5 py-1 shadow-2xl">
        {emojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            data-reaction={emoji}
            onClick={() => onPick(emoji)}
            title={displayReactionEmoji(emoji)}
            className="group/react flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-muted"
          >
            <span className="text-[1.375rem] leading-none transition-transform group-hover/react:scale-125">{displayReactionEmoji(emoji)}</span>
          </button>
        ))}
        {canRemove && (
          <button
            type="button"
            role="menuitem"
            data-zalo-reaction-remove=""
            onClick={onRemove}
            title={tr('Gỡ cảm xúc của bạn')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}

export interface ZaloReactionCornerProps {
  /** Your message (right side of the chat): the button sits on its left edge. */
  isSent: boolean;
  /** Reaction → total taps */
  counts: Record<string, number>;
  /** Your latest reaction on this message (null = none): shown on the button, sent again when it is clicked. */
  myEmoji: string | null;
  barOpen: boolean;
  /** Zalo's bar, in Zalo's order. */
  emojis: readonly string[];
  /** Mouse over the button / bar (the bar opens after holding) */
  onArm: () => void;
  onLeave: () => void;
  /** Click the button: add the reaction shown on it. */
  onQuick: () => void;
  /** Pick on the bar: +1 of that reaction. */
  onPick: (emoji: string) => void;
  /** ✕: remove all your reactions on this message. */
  onRemoveMine: () => void;
  /** Click the summary: who reacted. */
  onShowReactors: () => void;
}

export function ZaloReactionCorner({
  isSent, counts, myEmoji, barOpen, emojis, onArm, onLeave, onQuick, onPick, onRemoveMine, onShowReactors,
}: ZaloReactionCornerProps) {
  const { top, total } = zaloReactionSummary(counts);
  // Reacted message: summary + button always shown; otherwise the button only while the mouse rests on the message
  const buttonShown = total > 0 || barOpen;
  // Same corner as Telegram (16 px past the outer edge); with the summary, just under the frame (the time stays visible).
  // Your messages: the button outermost on the left, the summary to its right (row reversed)
  const side = isSent ? '-left-4 flex-row-reverse' : '-right-4';
  return (
    <div className={`absolute ${side} ${total > 0 ? '-bottom-[1.375rem]' : '-bottom-2'} flex items-center gap-1 select-none ${barOpen ? 'z-30' : 'z-20'}`} data-zalo-reactions="">
      {total > 0 && (
        <button
          type="button"
          data-zalo-reaction-summary=""
          onClick={onShowReactors}
          title={tr('Xem ai đã thả cảm xúc')}
          className="flex h-[1.375rem] items-center gap-0.5 rounded-full border border-input bg-card px-1.5 text-xs leading-none shadow-sm transition-colors hover:bg-muted"
        >
          {top.map((emoji) => <span key={emoji}>{displayReactionEmoji(emoji)}</span>)}
          <span className="ml-0.5 text-[11px] tabular-nums text-foreground/80">{total}</span>
        </button>
      )}
      <div className="relative" onMouseEnter={onArm} onMouseLeave={onLeave}>
        {barOpen && <ZaloReactionBar emojis={emojis} canRemove={!!myEmoji} onPick={onPick} onRemove={onRemoveMine} />}
        <button
          type="button"
          data-zalo-reaction-button=""
          onClick={onQuick}
          title={tr('Thả cảm xúc (giữ chuột để chọn)')}
          className={`flex h-[1.375rem] w-[1.375rem] items-center justify-center rounded-full border border-input bg-card text-muted-foreground shadow-sm hover:bg-muted ${
            buttonShown ? 'transition-opacity' : REACTION_BUTTON_REVEAL_CLASS
          }`}
        >
          {myEmoji
            ? <span className="text-[0.8125rem] leading-none">{displayReactionEmoji(myEmoji)}</span>
            : <ThumbsUpIcon className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
