/**
 * "Kho sticker" of the Zalo sticker picker, organised like Zalo's own panel: every pack is a titled section in one scroll,
 * and the pack bar at the bottom jumps to a pack and follows the scroll. Data: shared/zalo/zaloStickerPacks (copied from
 * Zalo Web, no API call). A section mounts its images only when it comes near the view, so opening the library does not
 * load ~1,000 images at once.
 *
 * The + at the end of the pack bar opens Zalo's sticker store (ZaloStickerShop); packs added there come first in the
 * library, like a pack downloaded in Zalo (kept in the DB by lib/chat/zalo/zaloStickers).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { PlusIcon } from '@/components/common/icons';
import { useAppStore } from '@/store/app/appStore';
import { loadZaloAddedPacks, setZaloPackAdded } from '@/lib/chat/zalo/zaloStickers';
import { tr } from '../../../../shared/i18n';
import {
  ZALO_STICKER_PACKS, zaloPackStickers, type ZaloPackSticker, type ZaloStickerPack,
} from '../../../../shared/zalo/zaloStickerPacks';
import ZaloStickerShop from './ZaloStickerShop';

/** Sections rendered right away (the first screen); the others mount when they come within NEAR_PX of the view. */
export const EAGER_SECTIONS = 2;
const NEAR_PX = 480;
const COLUMNS = 4;

export default function ZaloStickerStore({ onSelect, packs = ZALO_STICKER_PACKS, addedPacks }: {
  onSelect: (sticker: ZaloPackSticker) => void;
  packs?: readonly ZaloStickerPack[];
  /** Packs added from the store; read from the DB when not given. */
  addedPacks?: readonly ZaloStickerPack[];
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [added, setAdded] = useState<readonly ZaloStickerPack[]>(addedPacks ?? []);
  const [view, setView] = useState<'library' | 'shop'>('library');
  const [busyId, setBusyId] = useState<number | null>(null);
  const jumpAfterShop = useRef<number | null>(null);

  const libraryPacks = useMemo(() => {
    const addedIds = new Set(added.map((p) => p.id));
    return [...added, ...packs.filter((p) => !addedIds.has(p.id))];
  }, [added, packs]);
  const addedIds = useMemo(() => new Set(added.map((p) => p.id)), [added]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<number, HTMLElement>());
  const scrollFrame = useRef(0);
  const stickersByPack = useMemo(
    () => new Map(libraryPacks.map((pack) => [pack.id, zaloPackStickers(pack)])),
    [libraryPacks],
  );
  const [mounted, setMounted] = useState<ReadonlySet<number>>(
    () => new Set(libraryPacks.slice(0, EAGER_SECTIONS).map((p) => p.id)),
  );
  const [activeId, setActiveId] = useState<number | null>(libraryPacks[0]?.id ?? null);

  // Packs added from the store (DB), unless given
  useEffect(() => {
    if (addedPacks) return;
    let alive = true;
    void loadZaloAddedPacks().then((list) => { if (alive && list.length) setAdded(list); });
    return () => { alive = false; };
  }, [addedPacks]);

  // Mount the sections that come near the view (once mounted, a section stays)
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === 'undefined') {
      setMounted(new Set(libraryPacks.map((p) => p.id)));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const near = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.packId));
      if (!near.length) return;
      setMounted((prev) => {
        if (near.every((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        near.forEach((id) => next.add(id));
        return next;
      });
    }, { root, rootMargin: `${NEAR_PX}px 0px` });
    sections.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [libraryPacks]);

  // Keep the active icon visible in the pack bar
  useEffect(() => {
    const bar = barRef.current;
    const button = bar?.querySelector<HTMLElement>(`[data-pack-button="${activeId}"]`);
    if (!bar || !button) return;
    const left = button.offsetLeft - 8;
    const right = button.offsetLeft + button.offsetWidth + 8;
    if (left < bar.scrollLeft) bar.scrollLeft = left;
    else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth;
  }, [activeId]);

  // Active pack = the last section whose title has reached the top of the scroll area
  const updateActive = () => {
    const root = scrollRef.current;
    if (!root) return;
    let current = libraryPacks[0]?.id ?? null;
    for (const pack of libraryPacks) {
      const el = sections.current.get(pack.id);
      if (el && el.offsetTop <= root.scrollTop + 8) current = pack.id;
      else if (el) break;
    }
    setActiveId(current);
  };
  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      updateActive();
    });
  };
  useEffect(() => () => { if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current); }, []);

  // The pack list changed (added packs came first): the highlighted icon follows the scroll position again
  useEffect(() => { if (view === 'library') updateActive(); }, [libraryPacks]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpTo = (packId: number) => {
    const root = scrollRef.current;
    const el = sections.current.get(packId);
    if (!root || !el) return;
    setMounted((prev) => (prev.has(packId) ? prev : new Set([...prev, packId])));
    root.scrollTop = el.offsetTop; // instant: a smooth scroll would mount every section on the way
    setActiveId(packId);
  };

  // Back from the store: show the pack added last
  useEffect(() => {
    if (view !== 'library' || jumpAfterShop.current == null) return;
    const packId = jumpAfterShop.current;
    jumpAfterShop.current = null;
    requestAnimationFrame(() => jumpTo(packId));
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePack = async (pack: ZaloStickerPack, add: boolean) => {
    if (busyId != null) return;
    setBusyId(pack.id);
    const ok = await setZaloPackAdded(pack, add);
    setBusyId(null);
    if (!ok) {
      showNotification(tr('Không lưu được bộ sticker, vui lòng thử lại'), 'error');
      return;
    }
    setAdded((prev) => (add ? [pack, ...prev.filter((p) => p.id !== pack.id)] : prev.filter((p) => p.id !== pack.id)));
    jumpAfterShop.current = add ? pack.id : (jumpAfterShop.current === pack.id ? null : jumpAfterShop.current);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {view === 'shop' && (
        <ZaloStickerShop addedIds={addedIds} busyId={busyId} onToggle={togglePack} onBack={() => setView('library')} />
      )}

      {/* The library stays mounted behind the store, so its scroll position and loaded images are kept */}
      <div className={cn('flex flex-col flex-1 min-h-0', view === 'shop' && 'hidden')}>
        <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto px-2 pb-2">
          {libraryPacks.map((pack) => {
            const stickers = stickersByPack.get(pack.id) || [];
            const rows = Math.max(1, Math.ceil(stickers.length / COLUMNS));
            return (
              <section
                key={pack.id}
                data-pack-id={pack.id}
                ref={(el) => { if (el) sections.current.set(pack.id, el); else sections.current.delete(pack.id); }}
                className="pt-2"
              >
                <p className="text-xs font-semibold text-foreground/90 px-1 pb-1.5 truncate">{pack.name}</p>
                {mounted.has(pack.id) ? (
                  <div className="grid grid-cols-4 gap-1">
                    {stickers.map((sticker) => (
                      <button
                        key={sticker.id}
                        type="button"
                        onClick={() => onSelect(sticker)}
                        className="aspect-square rounded-xl hover:bg-muted flex items-center justify-center overflow-hidden transition-colors p-1"
                        title={pack.name}
                      >
                        <img
                          src={sticker.stickerUrl}
                          alt=""
                          className="w-full h-full object-contain"
                          loading="lazy"
                          draggable={false}
                          onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  // Same height as the grid (width / 4 per row), so the scroll position does not move when it mounts
                  <div aria-hidden style={{ aspectRatio: `${COLUMNS} / ${rows}` }} />
                )}
              </section>
            );
          })}
        </div>

        <div className="flex items-center border-t border-border/60 flex-shrink-0">
          <div
            ref={barRef}
            className="relative flex-1 min-w-0 flex items-center gap-1 pl-2 pr-1 py-1.5 overflow-x-auto"
            onWheel={(e) => {
              // The mouse wheel scrolls the pack bar sideways
              if (e.deltaY !== 0) e.currentTarget.scrollBy({ left: e.deltaY, behavior: 'auto' });
            }}
          >
            {libraryPacks.map((pack) => (
              <button
                key={pack.id}
                type="button"
                data-pack-button={pack.id}
                onClick={() => jumpTo(pack.id)}
                title={pack.name}
                className={cn(
                  'flex-shrink-0 w-9 h-9 rounded-lg p-1 transition-colors',
                  activeId === pack.id ? 'bg-muted ring-1 ring-blue-400/60' : 'hover:bg-muted/70',
                )}
              >
                <img src={pack.iconUrl} alt={pack.name} className="w-full h-full object-contain" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
          <button
            type="button"
            data-sticker-shop-button=""
            onClick={() => setView('shop')}
            title={tr('Thêm bộ sticker')}
            className="flex-shrink-0 w-9 h-9 mr-1.5 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
          >
            <PlusIcon className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
