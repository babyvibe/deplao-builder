/**
 * Facebook sticker panel: the like (👍) Messenger's own button sends, and the stickers this account sent or received
 * lately (fb:getRecentStickers). Messenger has no public sticker catalogue, so the panel grows as stickers are used.
 */
import React from 'react';
import { ipc } from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { tr } from '../../../../shared/i18n';

/** Messenger's like sticker (what its 👍 button sends in ordinary threads). */
export const FACEBOOK_LIKE_STICKER_ID = '369239263222822';

export interface FacebookStickerItem {
  /** '' = sticker of an encrypted chat (only its image is known): it can be sent to encrypted chats only. */
  stickerId: string;
  key?: string;
  url: string;
  localPath?: string;
}

export default function FacebookStickerPicker({ accountId, imageStickers = true, onPick, onClose }: {
  accountId: string;
  /** Stickers without a Messenger id are offered (encrypted 1:1 chats), not in groups. */
  imageStickers?: boolean;
  onPick: (sticker: FacebookStickerItem | 'like') => void;
  onClose: () => void;
}) {
  const [stickers, setStickers] = React.useState<FacebookStickerItem[] | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let alive = true;
    ipc.fb?.getRecentStickers({ accountId })
      .then(res => { if (alive) setStickers(res?.success ? res.stickers || [] : []); })
      .catch(() => { if (alive) setStickers([]); });
    return () => { alive = false; };
  }, [accountId]);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const shown = (stickers || []).filter(item => imageStickers || item.stickerId);

  const srcOf = (item: FacebookStickerItem) => (item.localPath ? toLocalMediaUrl(item.localPath, accountId) : item.url);

  return (
    <div ref={panelRef} className="absolute bottom-full left-0 mb-2 z-50 w-80 rounded-xl border border-border bg-popover shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium text-foreground">{tr('Nhãn dán')}</span>
        <button
          type="button"
          onClick={() => onPick('like')}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-foreground hover:bg-muted"
          title={tr('Gửi biểu tượng thích')}
        >
          <span className="text-xl leading-none">👍</span>
          <span>{tr('Thích')}</span>
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto p-2">
        {stickers === null ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{tr('Đang tải...')}</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">{tr('Nhãn dán bạn gửi hoặc nhận trên Messenger sẽ hiện ở đây để gửi lại.')}</p>
        ) : (
          <div className="grid grid-cols-4 gap-1">
            {shown.map(item => (
              <button
                key={item.key || item.stickerId}
                type="button"
                onClick={() => onPick(item)}
                className="flex aspect-square items-center justify-center rounded-lg p-1 hover:bg-muted"
              >
                <img src={srcOf(item)} alt="" loading="lazy" className="max-h-full max-w-full object-contain"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
