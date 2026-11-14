import React from 'react';
import { displayReactionEmoji } from './ReactionComponents';
import { sameReaction } from '@/lib/chat/reactions/reactionChoices';
import { tr } from '../../../../../shared/i18n';

/** Show up to 6 reactions: all 6 types of every channel; Telegram scrolls the rest. */
const VISIBLE_COUNT = 6;
/** Minimum still usable (2 reactions + scroll). */
const MIN_VISIBLE = 2;
/** Keep a gap between the bar and the chat frame edge (header above / compose box below). */
const EDGE_GAP = 8;

/**
 * Real size of the bar: reaction cells, gap between cells, padding + top/bottom border of the bar, padding joining the bar to the button (`pb-1.5` /
 * `pt-1.5`). All in rem, so it grows when the app font size grows (12-24 px). Before, the height was a fixed 210 px (exactly the
 * 16 px font), so with a larger font the 6th reaction was cut in half.
 */
export interface ReactionPickerMetrics { item: number; gap: number; chrome: number; bridge: number }

/** Default font size 16 px: cell 32, gap 2, padding 2 × 4 + border 2 × 1, join 6. */
export const DEFAULT_REACTION_PICKER_METRICS: ReactionPickerMetrics = { item: 32, gap: 2, chrome: 10, bridge: 6 };

/** Height that fits exactly `count` full reactions. */
export function reactionPickerHeight(count: number, metrics: ReactionPickerMetrics = DEFAULT_REACTION_PICKER_METRICS): number {
  const rows = Math.max(0, count);
  return Math.ceil(metrics.chrome + rows * metrics.item + Math.max(0, rows - 1) * metrics.gap);
}

/** Measure the bar being drawn; if no cells exist yet (static render in tests) → default size. */
export function measureReactionPicker(wrapper: HTMLElement, list: HTMLElement): ReactionPickerMetrics {
  const item = (list.firstElementChild as HTMLElement | null)?.offsetHeight || 0;
  if (!item) return DEFAULT_REACTION_PICKER_METRICS;
  const px = (value: string | undefined) => parseFloat(value || '') || 0;
  const listStyle = getComputedStyle(list);
  const wrapperStyle = getComputedStyle(wrapper);
  return {
    item,
    gap: px(listStyle.rowGap),
    chrome: px(listStyle.paddingTop) + px(listStyle.paddingBottom) + px(listStyle.borderTopWidth) + px(listStyle.borderBottomWidth),
    bridge: Math.max(px(wrapperStyle.paddingTop), px(wrapperStyle.paddingBottom)),
  };
}

/**
 * Whether the picker opens up or down, and how tall it is. Pure, for testing. `spaceAbove` / `spaceBelow`: from the button to the top / bottom edge of the
 * chat frame. If there is more room above (or more than below) → up, otherwise → down. Always a whole number of reactions tall: at most 6;
 * when tight it shrinks (at least 2) and scrolls the rest, so no reaction is cut in half.
 */
export function placeReactionPicker(
  spaceAbove: number,
  spaceBelow: number,
  count: number,
  metrics: ReactionPickerMetrics = DEFAULT_REACTION_PICKER_METRICS,
): { side: 'above' | 'below'; maxHeight: number } {
  const reserve = EDGE_GAP + metrics.bridge;
  const above = Math.max(0, Math.floor(spaceAbove - reserve));
  const below = Math.max(0, Math.floor(spaceBelow - reserve));
  const shown = Math.min(count, VISIBLE_COUNT);
  const side = above >= reactionPickerHeight(shown, metrics) || above >= below ? 'above' : 'below';
  const room = side === 'above' ? above : below;
  const fits = Math.floor((room - metrics.chrome + metrics.gap) / (metrics.item + metrics.gap));
  return { side, maxHeight: reactionPickerHeight(Math.min(shown, Math.max(MIN_VISIBLE, fits)), metrics) };
}

/**
 * Reaction picker when holding the mouse / clicking a message's reaction button: a VERTICAL column right next to the button (as in Telegram), so the mouse moves straight,
 * not sideways across the whole row (easy to slip off = lost). Opens UP by default; a message at the top edge of the chat frame (no room, covered by the
 * header) opens DOWN. With many reactions it scrolls inside the bar; the reaction nearest the button is the first one of the channel (the common order for all channels,
 * see reactionChoices). Clicking the selected reaction again = remove. The transparent `pb-1.5` / `pt-1.5` padding joins the bar to the button.
 */
export function ReactionHoverPicker({ emojis, myEmoji, align, onPick }: {
  emojis: readonly string[];
  myEmoji: string | null;
  align: 'left' | 'right';
  onPick: (emoji: string) => void;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // Show up to 6 reactions (the rest scroll); fits the real space above / below the button in the chat frame
  const [layout, setLayout] = React.useState<{ side: 'above' | 'below'; maxHeight: number }>(
    () => ({ side: 'above', maxHeight: reactionPickerHeight(Math.min(emojis.length, VISIBLE_COUNT)) }),
  );
  React.useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const list = listRef.current;
    const anchor = wrapper?.parentElement; // the container of the reaction button (the picker is an absolute child of it)
    if (!wrapper || !list || !anchor || emojis.length === 0) return;
    const scroller = anchor.closest('.overflow-y-auto') as HTMLElement | null;
    // Measured once per open: cell / gap / padding depend on the app font size
    const metrics = measureReactionPicker(wrapper, list);
    const measure = () => {
      const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const button = anchor.getBoundingClientRect();
      const next = placeReactionPicker(button.top - bounds.top, bounds.bottom - button.bottom, emojis.length, metrics);
      setLayout(prev => (prev.side === next.side && prev.maxHeight === next.maxHeight ? prev : next));
    };
    measure();
    // The chat frame scrolls / resizes while the bar is open (new message arrives, older messages load…) → measure again, so the header / compose box does not cover it
    let frame = 0;
    const remeasure = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure);
    return () => {
      target.removeEventListener('scroll', remeasure);
      window.removeEventListener('resize', remeasure);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [emojis.length]);
  if (emojis.length === 0) return null;
  const below = layout.side === 'below';
  return (
    <div
      ref={wrapperRef}
      className={`absolute z-30 ${below ? 'top-full pt-1.5' : 'bottom-full pb-1.5'} ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      <div
        ref={listRef}
        className={`flex w-10 ${below ? 'flex-col' : 'flex-col-reverse'} items-center gap-0.5 overflow-y-auto overscroll-contain rounded-full border border-input bg-card py-1 shadow-2xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
        style={{ maxHeight: layout.maxHeight }}
        role="menu"
        aria-label={tr('Thả cảm xúc')}
        data-side={layout.side}
      >
        {emojis.map((emoji) => {
          const mine = sameReaction(emoji, myEmoji);
          return (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              onClick={() => onPick(emoji)}
              title={mine ? tr('Bấm lần nữa để gỡ') : emoji}
              className={`group/react flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[1.1875rem] leading-none hover:bg-muted ${mine ? 'bg-muted ring-1 ring-primary' : ''}`}
            >
              {/* Hover: enlarge the emoji, not the whole cell (an enlarged cell gets cut by the edge of the scrolling bar) */}
              <span className="transition-transform group-hover/react:scale-125">{displayReactionEmoji(emoji)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Full reaction grid for the conversation (right-click menu → expand), as in Telegram. */
export function ReactionGrid({ emojis, myEmoji, onPick }: {
  emojis: readonly string[];
  myEmoji: string | null;
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="grid max-h-[18rem] grid-cols-8 gap-0.5 overflow-y-auto overscroll-contain p-2" role="menu" aria-label={tr('Tất cả cảm xúc')}>
      {emojis.map((emoji) => {
        const mine = sameReaction(emoji, myEmoji);
        return (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            onClick={() => onPick(emoji)}
            title={mine ? tr('Bấm lần nữa để gỡ') : emoji}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-[22px] leading-none transition-transform hover:scale-110 hover:bg-muted ${mine ? 'bg-muted ring-1 ring-primary' : ''}`}
          >
            {displayReactionEmoji(emoji)}
          </button>
        );
      })}
    </div>
  );
}
