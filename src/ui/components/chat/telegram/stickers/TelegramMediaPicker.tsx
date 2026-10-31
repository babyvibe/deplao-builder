/**
 * Bảng biểu cảm của ô nhập cho Telegram cá nhân — như Telegram: Emoji · Sticker · GIF trong một bảng. Nhớ tab dùng gần
 * nhất (mở lại bằng nút biểu cảm vào đúng tab đó). Sticker / GIF đồng bộ với tài khoản; bấm là gửi vào hội thoại đang
 * mở (đang trả lời tin nào thì gửi dạng trả lời).
 */
import React from 'react';
import { cn } from '@/lib/cn';
import {
  activeStickerTarget,
  openTelegramStickerSet,
  type TelegramStickerItem,
  type TelegramStickerSetInfo,
} from '@/lib/chat/telegram/telegramStickerStore';
import { TelegramStickerPanel } from './TelegramStickerPanel';
import { TelegramGifPanel } from './TelegramGifPanel';

export type TelegramPickerTab = 'emoji' | 'stickers' | 'gifs';

let lastTab: TelegramPickerTab = 'emoji';

/** Tab dùng gần nhất trong phiên (mặc định Emoji). */
export function lastTelegramPickerTab(): TelegramPickerTab {
  return lastTab;
}

const TABS: Array<{ value: TelegramPickerTab; label: string }> = [
  { value: 'emoji', label: 'Emoji' },
  { value: 'stickers', label: 'Sticker' },
  { value: 'gifs', label: 'GIF' },
];

export function TelegramMediaPicker({ accountId, initialTab, emoji, canSendMedia, onPick, onClose, anchorRef, className }: {
  accountId: string;
  initialTab: TelegramPickerTab;
  /** Nội dung tab Emoji (lưới emoji của ô nhập — chèn vào chữ đang soạn). */
  emoji: React.ReactNode;
  /** Không có quyền gửi (nhân viên thiếu quyền chat) → chỉ còn tab Emoji. */
  canSendMedia: boolean;
  onPick: (item: TelegramStickerItem) => void;
  onClose: () => void;
  /** Có → tự đóng khi bấm ra ngoài bảng và ngoài nút mở (bấm nút mở lần nữa = đóng). */
  anchorRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  const tabs = canSendMedia ? TABS : TABS.slice(0, 1);
  const [tab, setTab] = React.useState<TelegramPickerTab>(() => (tabs.some((item) => item.value === initialTab) ? initialTab : 'emoji'));
  const rootRef = React.useRef<HTMLDivElement>(null);

  const selectTab = (value: TelegramPickerTab) => {
    setTab(value);
    lastTab = value;
  };

  // onClose của nơi dùng là hàm mới mỗi lần render (ô nhập render lại mỗi phím gõ) → giữ qua ref, không đăng ký lại
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    if (!anchorRef) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // Popup bộ sticker mở từ bảng (portal ra body) không tính là bấm ra ngoài
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [anchorRef]);

  // Hàm ổn định cho 2 tab (memo) — gõ chữ khi bảng đang mở không dựng lại cả lưới sticker
  const onPickRef = React.useRef(onPick);
  onPickRef.current = onPick;
  const pick = React.useCallback((item: TelegramStickerItem) => onPickRef.current(item), []);

  const openSet = React.useCallback((set: TelegramStickerSetInfo) => {
    openTelegramStickerSet({
      accountId,
      target: activeStickerTarget(),
      ref: { id: set.id, accessHash: set.accessHash, ...(set.shortName ? { shortName: set.shortName } : {}) },
    });
  }, [accountId]);

  return (
    <div
      ref={rootRef}
      className={cn('flex h-[26rem] w-[22rem] flex-col overflow-hidden rounded-2xl border border-input bg-card shadow-2xl', className)}
      onMouseDown={(event) => {
        // Bấm nút trong bảng (tab, sticker, emoji) không lấy focus khỏi ô soạn tin — chèn emoji đúng chỗ con trỏ. Chỉ chặn
        // trên nút: ô tìm kiếm vẫn gõ được, kéo thanh cuộn vẫn được.
        if (event.target instanceof Element && event.target.closest('button,[role="button"]')) event.preventDefault();
      }}
    >
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Biểu cảm" className="flex shrink-0 items-center gap-1 border-b border-border px-2">
          {tabs.map((item) => {
            const active = item.value === tab;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(item.value)}
                className={cn(
                  'relative px-3 pb-2 pt-2.5 text-[13px] font-medium transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
                {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>
      )}
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'emoji' && <div className="h-full overflow-y-auto overscroll-contain p-2">{emoji}</div>}
        {tab === 'stickers' && <TelegramStickerPanel accountId={accountId} onPick={pick} onOpenSet={openSet} />}
        {tab === 'gifs' && <TelegramGifPanel accountId={accountId} onPick={pick} />}
      </div>
    </div>
  );
}
