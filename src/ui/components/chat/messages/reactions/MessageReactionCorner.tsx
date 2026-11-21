/**
 * Reaction button / chip at the bottom corner of the bubble for Telegram and Facebook, SHARED by the chat frame and the channel post comments, so
 * reacting works the same everywhere. Zalo has its own corner laid out like Zalo (ZaloReactionCorner).
 *
 * Like Telegram Desktop: the button sits in the bottom corner, on the INSIDE of the chat frame (own messages → left corner, others' → right corner), shown on
 * hover over the message. Telegram: the button shows the account's quick reaction and clicking sends it (`onQuick`); holding the mouse on it for
 * REACTION_PICKER_HOVER_DELAY_MS opens the picker (passing over it does not open it). Without `onQuick` clicking opens the picker at once.
 * Leaving the button / picker closes it after REACTION_PICKER_CLOSE_DELAY_MS. Telegram chats draw their reaction chips inside the message
 * (TelegramReactionChips, `hideCounts` here); Facebook: one combined chip in this corner, clicking it shows who reacted.
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

/**
 * A reaction button that only shows while the mouse rests on the message: it fades in 200 ms after the mouse arrives (passing
 * over a message does not flash it, like the picker that waits for a hover hold) and hides at once. While hidden it does not
 * catch the mouse, so it never blocks the message underneath it.
 */
export const REACTION_BUTTON_REVEAL_CLASS =
  'opacity-0 pointer-events-none transition-opacity duration-100 group-hover/msg:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:delay-200';

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
  /** Telegram: the button shows the account's quick reaction and clicking it sends it at once (holding still opens the picker). */
  quickEmoji?: string;
  onQuick?: () => void;
  /**
   * 'corner' (default): pinned to the bubble's bottom corner on the inner side. 'time': Telegram, on the OUTER edge of the
   * message at the bottom, straddling the frame's edge: right of others' messages (right after the send time), left of yours
   * (they sit on the right of the chat), so it covers neither the chips inside the message nor the time.
   */
  placement?: 'corner' | 'time';
}

export function MessageReactionCorner({
  isSent, counts, myEmoji, variant, hideCounts, pickerOpen, pickerEmojis, onArm, onLeave, onOpenPicker, onPick, onShowReactors,
  quickEmoji, onQuick, placement = 'corner',
}: MessageReactionCornerProps) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  const atTime = placement === 'time';
  const showCounts = entries.length > 0 && !hideCounts && !atTime;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  // With reaction chips the block sits in the flow inside the message column, so many reaction types WRAP within
  // the bubble width instead of running past the right edge of the window (the old absolute row had no max width).
  // Only the hover 👍 button stays pinned to the bubble corner.
  const inFlow = showCounts;
  // Outer edge at the bottom (a little below the send time), 8 px inside and 16 px outside the frame: right of others' messages
  // (the time ends 10 px inside the right edge, they never overlap), left of yours
  const rootClass = atTime
    ? `absolute -bottom-2 ${isSent ? '-left-4' : '-right-4'} ${pickerOpen ? 'z-30' : 'z-20'} ${REACTION_BUTTON_REVEAL_CLASS}`
    : `${inFlow ? 'relative mt-1 min-w-0 max-w-full' : 'absolute -bottom-4'} ${pickerOpen ? 'z-30' : 'z-20'}${!showCounts ? ` ${REACTION_BUTTON_REVEAL_CLASS}` : ' transition-opacity duration-100'}${
      inFlow
        ? (isSent ? ' self-start' : ' self-end')
        : (isSent ? ' left-1.5' : ' right-1.5')
    }`;
  // The column opens on the button and leans away from the message (outer edge: right of others' messages, left of yours)
  const pickerAlign = atTime ? (isSent ? 'right' : 'left') : (isSent ? 'left' : 'right');
  return (
    <div
      className={rootClass}
      data-reaction-placement={placement}
      onMouseEnter={onArm}
      onMouseLeave={onLeave}
    >
      {/* Picker: vertical row above / below the button depending on free space (as in Telegram), scrollable; clicking my own reaction again removes it */}
      {pickerOpen && (
        <ReactionHoverPicker emojis={pickerEmojis} myEmoji={myEmoji} align={pickerAlign} onPick={onPick} />
      )}
      {showCounts && variant === 'chips' ? (
        <div className={`flex flex-wrap items-center gap-1 select-none min-w-0 max-w-full ${isSent ? 'justify-start' : 'justify-end'}`}>
          {entries.map(([emoji, count]) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onShowReactors(emoji)}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs shadow-sm transition-colors ${
                myEmoji === emoji
                  ? 'border-primary bg-primary/20 text-foreground hover:bg-primary/30'
                  : 'border-primary bg-primary/10 text-foreground hover:bg-primary/20'
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
          className="flex items-center gap-0.5 bg-primary/10 hover:bg-primary/20 border border-primary rounded-full px-1.5 py-0.5 text-xs shadow-sm select-none transition-colors"
        >
          {entries.slice(0, 3).map(([emoji]) => <span key={emoji}>{displayReactionEmoji(emoji)}</span>)}
          {total > 1 && <span className="text-foreground/80 ml-0.5 text-[11px]">{total}</span>}
        </button>
      ) : (
        <button
          type="button"
          data-reaction-button=""
          className="w-6 h-6 bg-card hover:bg-muted border border-input rounded-full flex items-center justify-center text-sm shadow-sm transition-colors"
          title={onQuick
            ? tr('Thả {{emoji}} (giữ chuột để chọn cảm xúc khác)', { emoji: displayReactionEmoji(quickEmoji || '👍') })
            : tr('Thả cảm xúc (bấm hoặc giữ chuột)')}
          onClick={onQuick || onOpenPicker}
        >{displayReactionEmoji(onQuick ? quickEmoji || '👍' : '👍')}</button>
      )}
    </div>
  );
}
