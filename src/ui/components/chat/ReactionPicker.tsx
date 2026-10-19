import React from 'react';
import { displayReactionEmoji } from './ReactionComponents';
import { sameReaction } from '@/lib/chat/reactionChoices';

/** Hiện 6 reaction — đủ 6 loại của Zalo / Facebook, Telegram cuộn phần còn lại: 6 × 32 px + 5 khe 2 px + đệm 2 × 4 px. */
const VISIBLE_COUNT = 6;
const VISIBLE_HEIGHT = VISIBLE_COUNT * 32 + (VISIBLE_COUNT - 1) * 2 + 8;

/** Chừa giữa thanh và mép khung chat (header phía trên / ô soạn tin phía dưới) + đệm nối `pb-1.5` / `pt-1.5` (6 px). */
const EDGE_GAP = 8 + 6;
/** Thấp nhất vẫn dùng được (2 reaction + cuộn). */
const MIN_HEIGHT = 72;

function pickerHeight(count: number): number {
  return Math.min(VISIBLE_HEIGHT, count * 32 + Math.max(0, count - 1) * 2 + 8);
}

/** Thanh chọn mở lên hay xuống: phía trên đủ chỗ (hoặc rộng hơn phía dưới) → lên, ngược lại → xuống. Thuần — để test. */
export function placeReactionPicker(spaceAbove: number, spaceBelow: number, wanted: number): { side: 'above' | 'below'; maxHeight: number } {
  const above = Math.max(0, Math.floor(spaceAbove));
  const below = Math.max(0, Math.floor(spaceBelow));
  const side = above >= wanted || above >= below ? 'above' : 'below';
  const room = side === 'above' ? above : below;
  return { side, maxHeight: Math.max(MIN_HEIGHT, Math.min(wanted, room)) };
}

/**
 * Thanh chọn reaction khi giữ chuột / bấm nút reaction của tin: hàng DỌC sát nút (như Telegram) — chuột đi thẳng,
 * không phải lia ngang qua cả dãy (dễ trượt ra là mất). Mặc định mọc LÊN; tin sát mép trên khung chat (không đủ chỗ, bị
 * header che) thì mọc XUỐNG. Nhiều reaction thì cuộn trong thanh; reaction gần nút nhất là cái hay dùng nhất. Bấm lại
 * reaction đang chọn = gỡ. Đệm `pb-1.5` / `pt-1.5` trong suốt nối liền thanh với nút.
 */
export function ReactionHoverPicker({ emojis, myEmoji, align, onPick }: {
  emojis: readonly string[];
  myEmoji: string | null;
  align: 'left' | 'right';
  onPick: (emoji: string) => void;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  // Hiện 6 reaction (còn lại cuộn); vừa khoảng trống thực tế trên / dưới nút trong khung chat
  const [layout, setLayout] = React.useState<{ side: 'above' | 'below'; maxHeight: number }>({ side: 'above', maxHeight: VISIBLE_HEIGHT });
  React.useLayoutEffect(() => {
    const anchor = wrapperRef.current?.parentElement; // khối chứa nút reaction (thanh chọn là con absolute của nó)
    if (!anchor || emojis.length === 0) return;
    const scroller = anchor.closest('.overflow-y-auto') as HTMLElement | null;
    const wanted = pickerHeight(emojis.length);
    const measure = () => {
      const bounds = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const button = anchor.getBoundingClientRect();
      const next = placeReactionPicker(button.top - bounds.top - EDGE_GAP, bounds.bottom - button.bottom - EDGE_GAP, wanted);
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
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[19px] leading-none transition-transform hover:scale-125 hover:bg-muted ${mine ? 'bg-muted ring-1 ring-primary' : ''}`}
            >
              {displayReactionEmoji(emoji)}
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
