import React from 'react';

/**
 * Floating date marker at the top of the chat window while the user scrolls (like Telegram): shows the day of the messages being viewed, hidden 3 s after
 * scrolling stops. It reads the date markers in the message flow (`[data-day-label]`, 1 element per day), so it is cheap; the state lives in this
 * component only → scrolling does not re-render the message list. It is not shown when the app scrolls by itself (new messages, restoring the position) and
 * when that same date marker is already at the top of the window (avoids 2 labels stacked on each other).
 */
const HIDE_AFTER_MS = 3000;
const USER_SCROLL_WINDOW_MS = 1200;
const NAV_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);

export default function StickyDayPill({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const [label, setLabel] = React.useState('');
  const [scrolling, setScrolling] = React.useState(false);
  const [inlineAtTop, setInlineAtTop] = React.useState(false);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let lastInputAt = 0;
    const markInput = () => { lastInputAt = Date.now(); };
    const onKey = (event: KeyboardEvent) => { if (NAV_KEYS.has(event.key)) markInput(); };

    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top;
      const separators = container.querySelectorAll<HTMLElement>('[data-day-label]');
      let current = '';
      let atTop = false;
      for (let index = 0; index < separators.length; index++) {
        const separator = separators[index];
        const offset = separator.getBoundingClientRect().top - top;
        if (offset <= 12) current = separator.dataset.dayLabel || current;
        if (offset >= -6 && offset <= 44) atTop = true;
        if (offset > 44) break;
      }
      if (!current && separators.length > 0) current = separators[0].dataset.dayLabel || '';
      setLabel((previous) => (previous === current ? previous : current));
      setInlineAtTop((previous) => (previous === atTop ? previous : atTop));
    };

    const onScroll = () => {
      if (Date.now() - lastInputAt > USER_SCROLL_WINDOW_MS) return;
      if (!frame) frame = requestAnimationFrame(measure);
      setScrolling(true);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setScrolling(false), HIDE_AFTER_MS);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', markInput, { passive: true });
    container.addEventListener('touchstart', markInput, { passive: true });
    container.addEventListener('touchmove', markInput, { passive: true });
    container.addEventListener('mousedown', markInput, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (hideTimer) clearTimeout(hideTimer);
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', markInput);
      container.removeEventListener('touchstart', markInput);
      container.removeEventListener('touchmove', markInput);
      container.removeEventListener('mousedown', markInput);
      window.removeEventListener('keydown', onKey);
    };
  }, [containerRef]);

  const visible = scrolling && !!label && !inlineAtTop;
  return (
    // h-0 + sticky: stuck to the top of the scroll area, takes no space in the message flow. overflow-anchor:none, so it must not be used as the
    // scroll anchor of the chat window (keeps the position when loading older messages, anchored on the message rows)
    // items-start: with a 0-height box and the default stretch, the label gets pulled to 0 height: the background becomes a thin line and the text overflows
    <div className="sticky top-0 z-20 h-0 flex justify-center items-start pointer-events-none [overflow-anchor:none]" aria-hidden={!visible}>
      {/* Floats above bubbles / photos → an almost solid background (95%), the same tone as the date marker in the message flow, the theme's standard text color (the old transparent background mixed with
          the content behind it in both themes). Background / border colors are fixed values: the light theme mapping does not change them wrongly. */}
      <span
        className={`mt-2 text-[11px] font-medium text-foreground bg-[rgb(196_200_207/0.95)] dark:bg-[rgb(52_55_61/0.95)] border border-[rgb(0_0_0/0.06)] dark:border-[rgb(255_255_255/0.08)] shadow-sm px-2.5 py-0.5 rounded-full transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
      >
        {label}
      </span>
    </div>
  );
}
