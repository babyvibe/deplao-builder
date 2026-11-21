/**
 * Zalo's sticker store (the + button of the sticker library), laid out like Zalo's STICKER STORE: one row per pack with its
 * name, sticker count, four stickers and a "Tải về" button that adds the pack to the library ("Gỡ" takes it out again).
 * Data: ZALO_STICKER_STORE_PACKS (copied from Zalo Web with every sticker id, so adding a pack needs no API call). Every pack
 * of Zalo's store is free.
 */
import React from 'react';
import { cn } from '@/lib/cn';
import { ArrowLeftIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';
import {
  ZALO_STICKER_STORE_PACKS, zaloStickerImageUrl, type ZaloStickerPack,
} from '../../../../shared/zalo/zaloStickerPacks';

const PREVIEW_STICKERS = 4;

export default function ZaloStickerShop({
  packs = ZALO_STICKER_STORE_PACKS, addedIds, busyId = null, onToggle, onBack,
}: {
  packs?: readonly ZaloStickerPack[];
  /** Packs already added to the library. */
  addedIds: ReadonlySet<number>;
  /** Pack being saved (its button is disabled meanwhile). */
  busyId?: number | null;
  onToggle: (pack: ZaloStickerPack, add: boolean) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/60 flex-shrink-0">
        <button
          type="button"
          onClick={onBack}
          title={tr('Quay lại')}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="w-4 h-4" />
        </button>
        <p className="text-xs font-semibold text-foreground truncate">{tr('Thêm bộ sticker')}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {packs.map((pack) => {
          const added = addedIds.has(pack.id);
          return (
            <section key={pack.id} data-store-pack-id={pack.id} className="py-2 border-b border-border/40 last:border-b-0">
              <div className="flex items-center gap-2 px-1">
                <div className="flex-1 min-w-0">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground/90 min-w-0">
                    <span className="truncate">{pack.name}</span>
                    {pack.isNew && (
                      <span className="flex-shrink-0 px-1.5 rounded-full bg-red-500 text-white text-[10px] leading-4 font-semibold">
                        {tr('Mới')}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{tr('{{count}} sticker', { count: pack.stickerIds.length })}</p>
                </div>
                <button
                  type="button"
                  data-store-action={added ? 'remove' : 'add'}
                  disabled={busyId === pack.id}
                  onClick={() => onToggle(pack, !added)}
                  className={cn(
                    'flex-shrink-0 min-w-[4.5rem] px-2.5 py-1 rounded-md border text-[11px] font-semibold transition-colors disabled:opacity-50',
                    added
                      ? 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'
                      : 'border-blue-400/70 text-blue-400 hover:bg-blue-500/10',
                  )}
                >
                  {added ? tr('Gỡ') : tr('Tải về')}
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1 mt-1.5">
                {pack.stickerIds.slice(0, PREVIEW_STICKERS).map((id) => (
                  <div key={id} className="aspect-square p-1.5">
                    <img
                      src={zaloStickerImageUrl(id)}
                      alt=""
                      className="w-full h-full object-contain"
                      loading="lazy"
                      draggable={false}
                      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
