/**
 * Tooltip — small portaled label shown after a hover/keyboard-focus delay.
 *
 * ```tsx
 * <Tooltip content="Ghim hội thoại" side="bottom">
 *   <Button variant="ghost" size="icon"><PinIcon className="w-4 h-4" /></Button>
 * </Tooltip>
 * ```
 *
 * Positioned next to the trigger with `getBoundingClientRect` (6px gap, flips to the opposite
 * side when there is no room, clamped to the viewport). Hides immediately on mouse leave, blur,
 * pointer down, Escape and scroll. Renders `children` alone when `content` is falsy.
 */
import React, { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

const GAP = 6;
const VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

interface TooltipPosition {
  top: number;
  left: number;
  side: TooltipSide;
}

function computePosition(trigger: DOMRect, width: number, height: number, side: TooltipSide): TooltipPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const roomTop = trigger.top - GAP - height >= VIEWPORT_MARGIN;
  const roomBottom = trigger.bottom + GAP + height <= vh - VIEWPORT_MARGIN;
  const roomLeft = trigger.left - GAP - width >= VIEWPORT_MARGIN;
  const roomRight = trigger.right + GAP + width <= vw - VIEWPORT_MARGIN;

  let resolved: TooltipSide = side;
  if (side === 'top' && !roomTop && roomBottom) resolved = 'bottom';
  else if (side === 'bottom' && !roomBottom && roomTop) resolved = 'top';
  else if (side === 'left' && !roomLeft && roomRight) resolved = 'right';
  else if (side === 'right' && !roomRight && roomLeft) resolved = 'left';

  let top: number;
  let left: number;
  switch (resolved) {
    case 'top':
      top = trigger.top - GAP - height;
      left = trigger.left + trigger.width / 2 - width / 2;
      break;
    case 'bottom':
      top = trigger.bottom + GAP;
      left = trigger.left + trigger.width / 2 - width / 2;
      break;
    case 'left':
      top = trigger.top + trigger.height / 2 - height / 2;
      left = trigger.left - GAP - width;
      break;
    default:
      top = trigger.top + trigger.height / 2 - height / 2;
      left = trigger.right + GAP;
  }

  return {
    top: Math.round(clamp(top, VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - height)),
    left: Math.round(clamp(left, VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - width)),
    side: resolved,
  };
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
export interface TooltipProps {
  content: React.ReactNode;
  side?: TooltipSide;
  /** Hover delay in ms before showing (default 300). */
  delay?: number;
  /** Classes for the tooltip bubble. */
  className?: string;
  /** Classes for the inline-flex wrapper around `children` (e.g. `w-full`). */
  wrapperClassName?: string;
  children: React.ReactNode;
}

export const Tooltip = forwardRef<HTMLSpanElement, TooltipProps>(function Tooltip(
  { content, side = 'top', delay = 300, className, wrapperClassName, children },
  ref,
) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);

  const setWrapperRef = useCallback(
    (node: HTMLSpanElement | null) => {
      wrapperRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLSpanElement | null>).current = node;
    },
    [ref],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setVisible(true);
    }, delay);
  }, [delay]);

  const hide = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  // Escape and any scroll hide the tooltip while it is visible.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    const onScroll = () => hide();
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [visible, hide]);

  if (!content) return <>{children}</>;

  return (
    <>
      <span
        ref={setWrapperRef}
        className={cn('inline-flex', wrapperClassName)}
        aria-describedby={visible ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onPointerDown={hide}
        onFocus={(e) => {
          // Only keyboard focus shows the tooltip; a mouse click already hides it on pointerdown.
          let keyboard = true;
          try {
            keyboard = (e.target as Element).matches(':focus-visible');
          } catch {
            /* selector unsupported → treat as keyboard focus */
          }
          if (keyboard) show();
        }}
        onBlur={hide}
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <TooltipBubble id={id} triggerRef={wrapperRef} side={side} className={className}>
            {content}
          </TooltipBubble>,
          document.body,
        )}
    </>
  );
});
Tooltip.displayName = 'Tooltip';

// ─── Bubble (mounted only while visible, so position state resets) ────────────
interface TooltipBubbleProps {
  id: string;
  triggerRef: React.RefObject<HTMLElement>;
  side: TooltipSide;
  className?: string;
  children: React.ReactNode;
}

function TooltipBubble({ id, triggerRef, side, className, children }: TooltipBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const next = computePosition(trigger.getBoundingClientRect(), bubble.offsetWidth, bubble.offsetHeight, side);
    setPosition((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.side === next.side ? prev : next,
    );
  }, [triggerRef, side, children]);

  return (
    <div
      ref={bubbleRef}
      id={id}
      role="tooltip"
      data-side={position?.side}
      className={cn(
        'pointer-events-none fixed z-[70] max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md',
        className,
      )}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? undefined : 'hidden',
      }}
    >
      {children}
    </div>
  );
}
