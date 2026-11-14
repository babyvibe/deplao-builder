/**
 * Reaction button / chip at the bottom corner of the bubble, SHARED by the chat frame and the channel post comments, so reacting works the same
 * everywhere (before, the comments had their own button far from the message, and you had to click to open it).
 *
 * As in big apps: the button sits in the bottom corner, on the INSIDE of the chat frame (own messages → left corner, others' → right corner), shown on
 * hover over the message. Holding the mouse on the button for REACTION_PICKER_HOVER_DELAY_MS opens the picker (passing over it does not open it);
 * clicking opens it at once. Leaving the button / picker closes it after REACTION_PICKER_CLOSE_DELAY_MS. Once there are reactions, a chip is always shown in that corner
 * (Telegram: one chip per reaction; Zalo / Facebook: one combined chip). Clicking the chip shows who reacted.
 * The message row needs a `group/msg` class (the button shows and hides on hover), and the container holding the button must be `relative` (+ `mb-3` when there are reactions).
 */
import React from 'react';
import { displayReactionEmoji } from './ReactionComponents';
import { ReactionHoverPicker } from './ReactionPicker';
import { tr } from '../../../../../shared/i18n';

/** How long to hold the mouse on the "Thả cảm xúc" (React) button before the picker opens (passing over it does not open it). */
export const REACTION_PICKER_HOVER_DELAY_MS = 300;
/** How long after leaving the button / picker it closes (diagonal moves or slipping slightly outside do not close it right away). */
export const REACTION_PICKER_CLOSE_DELAY_MS = 250;

/** Which message the reaction picker is open for (one picker at a time) + the timers that open / close it on hover. */
export function useReactionHoverPicker() {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const openIdRef = React.useRef<string | null>(null);
  openIdRef.current = openId;
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /** On click: open immediately. */
  const open = React.useCallback((id: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    setOpenId(id);
  }, []);

  /** Mouse over the button / picker: if this message is open → keep it; another message → open after holding long enough. */
  const arm = React.useCallback((id: string, onOpen?: () => void) => {
    if (openIdRef.current === id) {
      // Back on the message that is open (diagonal move between button and picker): keep the picker
      if (closeTimer.current) clearTimeout(closeTimer.current);
      return;
    }
    // Another message: the picker that is open (if any) still closes on its timer; this message opens after holding long enough
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpenId(id);
      onOpen?.();
    }, REACTION_PICKER_HOVER_DELAY_MS);
  }, []);

  /** Mouse leaves: not held long enough → cancel, do not open; already open → close after a short while. */
  const scheduleClose = React.useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenId(null), REACTION_PICKER_CLOSE_DELAY_MS);
  }, []);

  /** Close immediately + cancel the timer (a reaction was selected or the conversation changed; the message was removed from the DOM, so there is no mouseleave). */
  const close = React.useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    setOpenId(null);
  }, []);

  React.useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  return { openId, open, arm, scheduleClose, close };
}

export interface MessageReactionCornerProps {
  isSent: boolean;
  /** Reaction → count */
  counts: Record<string, number>;
  /** Reaction I added (null = none) */
  myEmoji: string | null;
  /** chips = one chip per reaction (Telegram), summary = one combined chip with the top 3 reactions + total (Zalo / Facebook) */
  variant: 'chips' | 'summary';
  /** Reaction already drawn elsewhere (channel post: inside the post frame) → here only the 👍 button remains on hover */
  hideCounts?: boolean;
  pickerOpen: boolean;
  pickerEmojis: readonly string[];
  /** Mouse over the button / picker (timer to open) */
  onArm: () => void;
  /** Mouse leaves */
  onLeave: () => void;
  /** Click 👍: open the picker right away */
  onOpenPicker: () => void;
  /** Select on the picker (selecting my own reaction again = remove; the caller handles it) */
  onPick: (emoji: string) => void;
  /** Click a chip: see who reacted ('all' = combined chip) */
  onShowReactors: (emoji: string) => void;
}

export function MessageReactionCorner({
  isSent, counts, myEmoji, variant, hideCounts, pickerOpen, pickerEmojis, onArm, onLeave, onOpenPicker, onPick, onShowReactors,
}: MessageReactionCornerProps) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  const showCounts = entries.length > 0 && !hideCounts;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return (
    <div
      className={`absolute -bottom-4 ${pickerOpen ? 'z-30' : 'z-20'} transition-opacity duration-100${!showCounts ? ' opacity-0 group-hover/msg:opacity-100' : ''}${isSent ? ' left-1.5' : ' right-1.5'}`}
      onMouseEnter={onArm}
      onMouseLeave={onLeave}
    >
      {/* Picker: vertical row above / below the button depending on free space (as in Telegram), scrollable; clicking my own reaction again removes it */}
      {pickerOpen && (
        <ReactionHoverPicker emojis={pickerEmojis} myEmoji={myEmoji} align={isSent ? 'left' : 'right'} onPick={onPick} />
      )}
      {showCounts && variant === 'chips' ? (
        <div className="flex items-center gap-1 select-none">
          {entries.map(([emoji, count]) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onShowReactors(emoji)}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs shadow-sm transition-colors ${
                myEmoji === emoji
                  ? 'border-blue-600 bg-muted text-foreground hover:bg-accent'
                  : 'border-input bg-muted text-foreground hover:bg-accent'
              }`}
            >
              <span>{displayReactionEmoji(emoji)}</span>
              <span className="font-medium">{count}</span>
            </button>
          ))}
        </div>
      ) : showCounts ? (
        <button
          type="button"
          onClick={() => onShowReactors('all')}
          className="flex items-center gap-0.5 bg-muted hover:bg-accent border border-input rounded-full px-1.5 py-0.5 text-xs shadow-sm select-none transition-colors"
        >
          {entries.slice(0, 3).map(([emoji]) => <span key={emoji}>{displayReactionEmoji(emoji)}</span>)}
          {total > 1 && <span className="text-foreground/80 ml-0.5 text-[11px]">{total}</span>}
        </button>
      ) : (
        <button
          type="button"
          className="w-6 h-6 bg-card hover:bg-muted border border-input rounded-full flex items-center justify-center text-sm shadow-sm transition-colors"
          title={tr('Thả cảm xúc (bấm hoặc giữ chuột)')}
          onClick={onOpenPicker}
        >👍</button>
      )}
    </div>
  );
}
