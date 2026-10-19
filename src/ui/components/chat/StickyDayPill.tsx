import React from 'react';

/**
 * Mốc ngày nổi ở đầu khung chat khi người dùng cuộn (như Telegram): cho biết đang xem tin của ngày nào, ẩn sau 3 s
 * ngừng cuộn. Đọc mốc ngày trong luồng tin (`[data-day-label]`, 1 phần tử / ngày) nên rẻ; state nằm riêng trong
 * component này → cuộn không làm render lại danh sách tin. Không hiện khi app tự cuộn (tin mới, khôi phục vị trí) và
 * khi chính mốc ngày đó đang nằm ngay đầu khung (tránh 2 nhãn chồng nhau).
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
    // h-0 + sticky: dính ở đầu vùng cuộn, không chiếm chỗ trong luồng tin. overflow-anchor:none — không được làm điểm
    // neo cuộn của khung chat (giữ vị trí khi tải tin cũ dựa vào neo trên các hàng tin)
    // items-start: khung cao 0 mà để mặc định stretch thì nhãn bị kéo về cao 0 — nền thành vạch mỏng, chữ tràn ra ngoài
    <div className="sticky top-0 z-20 h-0 flex justify-center items-start pointer-events-none [overflow-anchor:none]" aria-hidden={!visible}>
      {/* Trôi trên bubble / ảnh → nền gần như đặc (95%), cùng tông mốc ngày giữa luồng tin, chữ màu chuẩn của theme (nền trong suốt cũ lẫn vào
          nội dung phía sau ở cả 2 theme). Màu nền / viền là giá trị cố định: lớp ánh xạ theme sáng không đổi màu sai. */}
      <span
        className={`mt-2 text-[11px] font-medium text-foreground bg-[rgb(196_200_207/0.95)] dark:bg-[rgb(52_55_61/0.95)] border border-[rgb(0_0_0/0.06)] dark:border-[rgb(255_255_255/0.08)] shadow-sm px-2.5 py-0.5 rounded-full transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
      >
        {label}
      </span>
    </div>
  );
}
