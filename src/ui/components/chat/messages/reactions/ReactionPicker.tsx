import React from 'react';
import { displayReactionEmoji } from './ReactionComponents';
import { sameReaction } from '@/lib/chat/reactions/reactionChoices';

/** Hiện tối đa 6 reaction: đủ 6 loại của mọi kênh, Telegram cuộn phần còn lại. */
const VISIBLE_COUNT = 6;
/** Thấp nhất vẫn dùng được (2 reaction + cuộn). */
const MIN_VISIBLE = 2;
/** Chừa giữa thanh và mép khung chat (header phía trên / ô soạn tin phía dưới). */
const EDGE_GAP = 8;

/**
 * Kích thước thật của thanh: ô reaction, khe giữa 2 ô, đệm + viền trên dưới của thanh, đệm nối thanh với nút (`pb-1.5` /
 * `pt-1.5`). Đều theo rem nên to lên khi tăng cỡ chữ của app (12 - 24 px). Trước đây chiều cao cố định 210 px (đúng cỡ
 * chữ 16 px) nên chữ to hơn là reaction thứ 6 bị cắt nửa.
 */
export interface ReactionPickerMetrics { item: number; gap: number; chrome: number; bridge: number }

/** Cỡ chữ mặc định 16 px: ô 32, khe 2, đệm 2 × 4 + viền 2 × 1, nối 6. */
export const DEFAULT_REACTION_PICKER_METRICS: ReactionPickerMetrics = { item: 32, gap: 2, chrome: 10, bridge: 6 };

/** Cao vừa khít `count` reaction trọn vẹn. */
export function reactionPickerHeight(count: number, metrics: ReactionPickerMetrics = DEFAULT_REACTION_PICKER_METRICS): number {
  const rows = Math.max(0, count);
  return Math.ceil(metrics.chrome + rows * metrics.item + Math.max(0, rows - 1) * metrics.gap);
}

/** Đo thanh đang vẽ; chưa có ô nào (render tĩnh trong test) → cỡ mặc định. */
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
 * Thanh chọn mở lên hay xuống, cao bao nhiêu. Thuần, để test. `spaceAbove` / `spaceBelow`: từ nút tới mép trên / dưới
 * khung chat. Phía trên đủ chỗ (hoặc rộng hơn phía dưới) → lên, ngược lại → xuống. Luôn cao tròn số reaction: tối đa 6,
 * chật thì bớt (ít nhất 2) và cuộn phần còn lại, không reaction nào bị cắt nửa.
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
 * Thanh chọn reaction khi giữ chuột / bấm nút reaction của tin: hàng DỌC sát nút (như Telegram) — chuột đi thẳng,
 * không phải lia ngang qua cả dãy (dễ trượt ra là mất). Mặc định mọc LÊN; tin sát mép trên khung chat (không đủ chỗ, bị
 * header che) thì mọc XUỐNG. Nhiều reaction thì cuộn trong thanh; reaction gần nút nhất là reaction đầu của kênh (thứ tự
 * chung mọi kênh, xem reactionChoices). Bấm lại reaction đang chọn = gỡ. Đệm `pb-1.5` / `pt-1.5` trong suốt nối liền
 * thanh với nút.
 */
export function ReactionHoverPicker({ emojis, myEmoji, align, onPick }: {
  emojis: readonly string[];
  myEmoji: string | null;
  align: 'left' | 'right';
  onPick: (emoji: string) => void;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // Hiện tối đa 6 reaction (còn lại cuộn); vừa khoảng trống thực tế trên / dưới nút trong khung chat
  const [layout, setLayout] = React.useState<{ side: 'above' | 'below'; maxHeight: number }>(
    () => ({ side: 'above', maxHeight: reactionPickerHeight(Math.min(emojis.length, VISIBLE_COUNT)) }),
  );
  React.useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const list = listRef.current;
    const anchor = wrapper?.parentElement; // khối chứa nút reaction (thanh chọn là con absolute của nó)
    if (!wrapper || !list || !anchor || emojis.length === 0) return;
    const scroller = anchor.closest('.overflow-y-auto') as HTMLElement | null;
    // Đo một lần mỗi lần mở: ô / khe / đệm đổi theo cỡ chữ của app
    const metrics = measureReactionPicker(wrapper, list);
    const measure = () => {
      const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const button = anchor.getBoundingClientRect();
      const next = placeReactionPicker(button.top - bounds.top, bounds.bottom - button.bottom, emojis.length, metrics);
      setLayout(prev => (prev.side === next.side && prev.maxHeight === next.maxHeight ? prev : next));
    };
    measure();
    // Khung chat cuộn / đổi cỡ khi thanh đang mở (tin mới tới, tải tin cũ…) → đo lại, không để header / ô soạn tin cắt mất
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
        aria-label="Thả cảm xúc"
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
              title={mine ? 'Bấm lần nữa để gỡ' : emoji}
              className={`group/react flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[1.1875rem] leading-none hover:bg-muted ${mine ? 'bg-muted ring-1 ring-primary' : ''}`}
            >
              {/* Rê chuột: phóng to emoji, không phóng cả ô (ô to ra bị mép thanh cuộn cắt mất) */}
              <span className="transition-transform group-hover/react:scale-125">{displayReactionEmoji(emoji)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Lưới đầy đủ reaction của hội thoại (menu chuột phải → mở rộng), như Telegram. */
export function ReactionGrid({ emojis, myEmoji, onPick }: {
  emojis: readonly string[];
  myEmoji: string | null;
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="grid max-h-[18rem] grid-cols-8 gap-0.5 overflow-y-auto overscroll-contain p-2" role="menu" aria-label="Tất cả cảm xúc">
      {emojis.map((emoji) => {
        const mine = sameReaction(emoji, myEmoji);
        return (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            onClick={() => onPick(emoji)}
            title={mine ? 'Bấm lần nữa để gỡ' : emoji}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-[22px] leading-none transition-transform hover:scale-110 hover:bg-muted ${mine ? 'bg-muted ring-1 ring-primary' : ''}`}
          >
            {displayReactionEmoji(emoji)}
          </button>
        );
      })}
    </div>
  );
}
