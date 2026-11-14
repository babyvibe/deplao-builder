/**
 * Emoji panel of the input box for personal Telegram accounts, like Telegram: Emoji · Sticker · GIF in one panel. Remembers the last
 * tab used (the emoji button reopens that tab). Stickers / GIFs sync with the account; clicking sends them to the open conversation
 * (if replying to a message, they are sent as a reply).
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
import { tr } from '../../../../../shared/i18n';

export type TelegramPickerTab = 'emoji' | 'stickers' | 'gifs';

let lastTab: TelegramPickerTab = 'emoji';

/** Last tab used in the session (default Emoji). */
export function lastTelegramPickerTab(): TelegramPickerTab {
  return lastTab;
}

const TABS: Array<{ value: TelegramPickerTab; label: string }> = [
  { value: 'emoji', label: tr('Emoji') },
  { value: 'stickers', label: tr('Sticker') },
  { value: 'gifs', label: tr('GIF') },
];

export function TelegramMediaPicker({ accountId, initialTab, emoji, canSendMedia, onPick, onClose, anchorRef, className }: {
  accountId: string;
  initialTab: TelegramPickerTab;
  /** Content of the Emoji tab (emoji grid of the input box, inserts into the text being composed). */
  emoji: React.ReactNode;
  /** No permission to send (employee lacks chat permission) → only the Emoji tab remains. */
  canSendMedia: boolean;
  onPick: (item: TelegramStickerItem) => void;
  onClose: () => void;
  /** true → closes automatically when clicking outside the panel and outside the open button (clicking the open button again = close). */
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

  // The caller's onClose is a new function on every render (the input re-renders on every keystroke) → keep it in a ref, do not re-register it
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    if (!anchorRef) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // A sticker set popup opened from the panel (portaled to body) does not count as a click outside
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [anchorRef]);

  // Stable functions for the 2 tabs (memo): typing while the panel is open does not rebuild the whole sticker grid
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
        // Clicking a button in the panel (tab, sticker, emoji) does not take focus from the compose box, so emoji go in at the cursor. Only blocks
        // the default action on the button: the search box can still be typed in, and the scrollbar can still be dragged.
        if (event.target instanceof Element && event.target.closest('button,[role="button"]')) event.preventDefault();
      }}
    >
      {tabs.length > 1 && (
        <div role="tablist" aria-label={tr('Biểu cảm')} className="flex shrink-0 items-center gap-1 border-b border-border px-2">
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
