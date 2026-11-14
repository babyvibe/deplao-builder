/**
 * "Sticker" tab of the Telegram emoji panel, like Telegram: favorite stickers, recent ones, then each set added to the account
 * (synced with the Telegram app on other devices), a set icon bar at the bottom to jump quickly, a search box for sticker sets and trending sets
 * to view / add new sets. Click a sticker = send; "⋯" in the set header = set popup (view, remove from the account).
 *
 * Performance: each section builds its grid only when scrolled near (its height is reserved from the sticker count, so nothing jumps when loaded),
 * sticker tiles load their image only when visible, and set contents load 2 sets at a time.
 */
import React from 'react';
import { cn } from '@/lib/cn';
import { InViewRootContext, useInView } from '@/lib/media/inView';
import { CheckIcon, ClockIcon, CloseIcon, SearchIcon, StarIcon, TrendingUpIcon } from '@/components/common/icons';
import {
  getLoadedStickerSet,
  getStickerPanel,
  getStickerPanelError,
  isStickerSetInstalled,
  loadStickerPanel,
  preloadStickerSets,
  searchTelegramStickerSets,
  setStickerSetInstalled,
  useTelegramStickerData,
  type TelegramCoveredStickerSet,
  type TelegramStickerItem,
  type TelegramStickerSetInfo,
} from '@/lib/chat/telegram/telegramStickerStore';
import { useAppStore } from '@/store/app/appStore';
import { StickerThumb, TelegramStickerTile } from './TelegramStickerTile';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const TILE = 60;
const COLUMNS = 5;
const ROW_GAP = 4;
const RECENT_LIMIT = 20;

interface Section {
  key: string;
  title: string;
  icon?: 'faved' | 'recent';
  set?: TelegramStickerSetInfo;
  /** null = the set's content has not finished loading. */
  stickers: TelegramStickerItem[] | null;
  count: number;
}

export const TelegramStickerPanel = React.memo(function TelegramStickerPanel({ accountId, onPick, onOpenSet }: {
  accountId: string;
  onPick: (item: TelegramStickerItem) => void;
  onOpenSet: (set: TelegramStickerSetInfo) => void;
}) {
  const version = useTelegramStickerData();
  const panel = getStickerPanel(accountId);
  const error = getStickerPanelError(accountId);
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
  const [activeKey, setActiveKey] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [featuredOpen, setFeaturedOpen] = React.useState(false);

  // On open: show the cached copy at once and ask again at the same time (main compares the hash with Telegram → a change made on another device also comes back)
  React.useEffect(() => { loadStickerPanel(accountId).catch(() => {}); }, [accountId]);

  const sets = panel?.sets;
  React.useEffect(() => {
    if (!sets?.length) return undefined;
    let cancelled = false;
    preloadStickerSets(accountId, sets, () => cancelled).catch(() => {});
    return () => { cancelled = true; };
  }, [accountId, sets]);

  const sections = React.useMemo<Section[]>(() => {
    if (!panel) return [];
    const list: Section[] = [];
    if (panel.faved.length) list.push({ key: 'faved', title: tr('Yêu thích'), icon: 'faved', stickers: panel.faved, count: panel.faved.length });
    if (panel.recent.length) {
      const recent = panel.recent.slice(0, RECENT_LIMIT);
      list.push({ key: 'recent', title: tr('Gần đây'), icon: 'recent', stickers: recent, count: recent.length });
    }
    for (const set of panel.sets) {
      const loaded = getLoadedStickerSet(accountId, { id: set.id });
      list.push({ key: `set:${set.id}`, title: set.title, set, stickers: loaded?.stickers ?? null, count: loaded?.stickers.length ?? set.count });
    }
    return list;
    // version: the set's content that just finished loading is in the store
  }, [accountId, panel, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const searching = query.trim().length > 0 || featuredOpen;

  const frameRef = React.useRef(0);
  const trackActiveSection = React.useCallback(() => {
    if (!scrollEl || frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const top = scrollEl.scrollTop + 8;
      const nodes = scrollEl.querySelectorAll<HTMLElement>('[data-section-key]');
      let current = nodes.length > 0 ? nodes[0].dataset.sectionKey || '' : '';
      for (let index = 0; index < nodes.length; index++) {
        if (nodes[index].offsetTop <= top) current = nodes[index].dataset.sectionKey || current;
        else break;
      }
      setActiveKey(current);
    });
  }, [scrollEl]);
  React.useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); }, []);

  const jumpTo = (key: string) => {
    setQuery('');
    setFeaturedOpen(false);
    // Wait for the normal grid to show again (just left search) before scrolling
    requestAnimationFrame(() => {
      const target = scrollEl?.querySelector<HTMLElement>(`[data-section-key="${key}"]`);
      if (scrollEl && target) scrollEl.scrollTop = target.offsetTop - 2;
      setActiveKey(key);
    });
  };

  const empty = !!panel && sections.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-2 pb-1 pt-2">
        <SearchField value={query} onChange={(value) => { setQuery(value); if (value) setFeaturedOpen(false); }} placeholder={tr('Tìm bộ sticker')} />
      </div>
      <InViewRootContext.Provider value={scrollEl}>
        <div ref={setScrollEl} onScroll={trackActiveSection} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {scrollEl && (searching || empty ? (
            <StickerSetSearch accountId={accountId} query={query.trim()} onPick={onPick} onOpenSet={onOpenSet}
              hint={empty && !query.trim() ? tr('Tài khoản chưa có bộ sticker nào — thêm từ các bộ thịnh hành dưới đây') : undefined} />
          ) : !panel ? (
            error ? <PanelMessage>{error}</PanelMessage> : <PanelMessage loading>{tr('Đang tải sticker…')}</PanelMessage>
          ) : (
            sections.map((section) => (
              <StickerSection key={section.key} accountId={accountId} section={section} onPick={onPick} onOpenSet={onOpenSet} />
            ))
          ))}
        </div>
      </InViewRootContext.Provider>
      {panel && !empty && (
        <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="toolbar" aria-label={tr('Bộ sticker')}>
          <BarButton title={tr('Bộ sticker thịnh hành')} active={featuredOpen} onClick={() => { setQuery(''); setFeaturedOpen((open) => !open); }}>
            <TrendingUpIcon className="h-[18px] w-[18px]" />
          </BarButton>
          {sections.map((section, index) => {
            // Not scrolled yet → the first section is the one being viewed
            const active = !searching && (activeKey ? activeKey === section.key : index === 0);
            const first = section.stickers?.[0];
            return (
              <BarButton key={section.key} title={section.title} active={active} onClick={() => jumpTo(section.key)}>
                {section.icon === 'faved' ? <StarIcon className="h-[18px] w-[18px]" />
                  : section.icon === 'recent' ? <ClockIcon className="h-[18px] w-[18px]" />
                    : first ? <StickerThumb accountId={accountId} item={first} className="h-7 w-7" />
                      : <span className="text-[13px] font-semibold uppercase leading-none">{section.title.trim().charAt(0) || '?'}</span>}
              </BarButton>
            );
          })}
        </div>
      )}
    </div>
  );
});

// memo: another set that just finished loading (store changed) does not rebuild the sections already there
const StickerSection = React.memo(function StickerSection({ accountId, section, onPick, onOpenSet }: {
  accountId: string;
  section: Section;
  onPick: (item: TelegramStickerItem) => void;
  onOpenSet: (set: TelegramStickerSetInfo) => void;
}) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  // Build the grid when scrolled near (the scroll container = root of InViewRootContext), then keep it once built
  const near = useInView(gridRef, { rootMargin: '360px 0px', once: true });
  const rows = Math.max(1, Math.ceil(section.count / COLUMNS));
  const minHeight = rows * TILE + (rows - 1) * ROW_GAP;
  return (
    <section data-section-key={section.key} className="pb-1.5">
      <div className="flex h-7 items-center gap-1 px-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted-foreground">{section.title}</span>
        {section.set && (
          <button
            type="button"
            onClick={() => onOpenSet(section.set!)}
            title={tr('Xem bộ sticker')}
            aria-label={tr('Xem bộ {{title}}', { title: section.title })}
            className="flex h-6 w-7 items-center justify-center rounded-md text-base leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            ⋯
          </button>
        )}
      </div>
      <div ref={gridRef} style={{ minHeight }} className="grid grid-cols-5 justify-items-center gap-1">
        {near && section.stickers?.map((item) => (
          <TelegramStickerTile key={item.id} accountId={accountId} item={item} size={TILE} onClick={onPick} />
        ))}
      </div>
    </section>
  );
}, (previous, next) => previous.accountId === next.accountId && previous.onPick === next.onPick && previous.onOpenSet === next.onOpenSet
  && previous.section.key === next.section.key && previous.section.title === next.section.title
  && previous.section.count === next.section.count && previous.section.stickers === next.section.stickers
  && previous.section.set === next.section.set);

/** Search sticker sets (empty keyword = Telegram's trending sets). */
function StickerSetSearch({ accountId, query, hint, onPick, onOpenSet }: {
  accountId: string;
  query: string;
  hint?: string;
  onPick: (item: TelegramStickerItem) => void;
  onOpenSet: (set: TelegramStickerSetInfo) => void;
}) {
  useTelegramStickerData(); // "Đã thêm" (Added) updates right after adding
  const [result, setResult] = React.useState<{ query: string; sets: TelegramCoveredStickerSet[]; loading: boolean; error?: string }>({ query: '\u0000', sets: [], loading: true });
  const [installing, setInstalling] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    setResult((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(async () => {
      const res = await searchTelegramStickerSets(accountId, query);
      if (!cancelled) setResult({ query, sets: res.sets, loading: false, error: res.error });
    }, query ? 350 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountId, query]);

  const install = async (set: TelegramCoveredStickerSet) => {
    setInstalling(set.id);
    const res = await setStickerSetInstalled(accountId, set, true);
    setInstalling('');
    if (!res.success) useAppStore.getState().showNotification(tr('Không thêm được bộ sticker: {{error}}', { error: res.error }), 'error');
  };

  const title = query ? tr('Kết quả tìm bộ sticker') : tr('Bộ sticker thịnh hành');
  return (
    <div className="pt-1">
      {hint && <p className="px-1 pb-2 text-[12px] leading-5 text-muted-foreground">{hint}</p>}
      <div className="px-1 pb-1 text-[11px] font-semibold text-muted-foreground">{title}</div>
      {result.loading && result.sets.length === 0 ? (
        <PanelMessage loading>{tr('Đang tìm…')}</PanelMessage>
      ) : result.sets.length === 0 ? (
        <PanelMessage>{result.error || (query ? tr('Không tìm thấy bộ sticker') : tr('Chưa có bộ thịnh hành'))}</PanelMessage>
      ) : (
        <div className={cn('flex flex-col gap-1 transition-opacity', result.loading && 'opacity-60')}>
          {result.sets.map((set) => {
            const installed = isStickerSetInstalled(accountId, set.id);
            return (
              <div key={set.id} className="rounded-lg px-1 py-1.5 transition-colors hover:bg-muted/60">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => onOpenSet(set)} className="min-w-0 flex-1 text-left" title={tr('Xem bộ sticker')}>
                    <div className="truncate text-[13px] font-medium text-foreground">{set.title}</div>
                    <div className="text-[11px] text-muted-foreground">{trx('{{count}} sticker', { count: set.count })}</div>
                  </button>
                  {installed ? (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">{trx('<0/>Đã thêm', { 0: <CheckIcon className="h-3.5 w-3.5" /> })}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void install(set)}
                      disabled={installing === set.id}
                      className="h-7 shrink-0 rounded-full bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
                    >
                      {installing === set.id ? tr('Đang thêm…') : tr('Thêm')}
                    </button>
                  )}
                </div>
                {set.covers.length > 0 && (
                  <div className="mt-1 flex gap-1">
                    {set.covers.map((item) => (
                      <TelegramStickerTile key={item.id} accountId={accountId} item={item} size={56} onClick={onPick} title={tr('Gửi sticker này')} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="flex h-8 items-center gap-2 rounded-full border border-input bg-muted/50 px-3 text-muted-foreground focus-within:border-primary">
      <SearchIcon className="h-3.5 w-3.5 shrink-0" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && value) { event.stopPropagation(); onChange(''); } }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-subtle-foreground focus:outline-none"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label={tr('Xoá')} className="shrink-0 rounded-full p-0.5 hover:bg-muted hover:text-foreground">
          <CloseIcon className="h-3 w-3" />
        </button>
      )}
    </label>
  );
}

export function PanelMessage({ loading, children }: { loading?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-[12px] text-muted-foreground">
      {loading && <span className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" aria-hidden />}
      <span>{children}</span>
    </div>
  );
}

function BarButton({ title, active, onClick, children }: { title: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        active && 'bg-muted text-primary',
      )}
    >
      {children}
    </button>
  );
}
