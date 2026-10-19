/**
 * Tab "GIF" của bảng biểu cảm Telegram: GIF đã lưu của tài khoản (đồng bộ app Telegram) + GIF thịnh hành, ô tìm GIF qua
 * bot @gif như Telegram, cuộn xuống để tải thêm. Bấm GIF = gửi (Telegram tự thêm vào "GIF đã lưu"); rê chuột để xem
 * chuyển động; "✕" trên GIF đã lưu = bỏ khỏi danh sách.
 */
import React from 'react';
import { cn } from '@/lib/cn';
import { InViewRootContext } from '@/lib/media/inView';
import { CloseIcon } from '@/components/common/icons';
import {
  getSavedGifs,
  loadSavedGifs,
  removeSavedGif,
  searchTelegramGifs,
  useTelegramStickerData,
  type TelegramStickerItem,
} from '@/lib/chat/telegramStickerStore';
import { TelegramStickerTile } from './TelegramStickerTile';
import { PanelMessage, SearchField } from './TelegramStickerPanel';

const GIF_HEIGHT = 84;
const LOAD_MORE_DISTANCE = 240;

interface GifResults {
  query: string;
  gifs: TelegramStickerItem[];
  nextOffset: string;
  loading: boolean;
  error?: string;
}

function mergeGifs(current: TelegramStickerItem[], more: TelegramStickerItem[]): TelegramStickerItem[] {
  const seen = new Set(current.map((gif) => gif.id));
  return [...current, ...more.filter((gif) => !seen.has(gif.id))];
}

export const TelegramGifPanel = React.memo(function TelegramGifPanel({ accountId, onPick }: {
  accountId: string;
  onPick: (item: TelegramStickerItem) => void;
}) {
  useTelegramStickerData();
  const saved = getSavedGifs(accountId);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<GifResults>({ query: '\u0000', gifs: [], nextOffset: '', loading: true });
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
  const q = query.trim();

  React.useEffect(() => { loadSavedGifs(accountId).catch(() => {}); }, [accountId]);

  React.useEffect(() => {
    let cancelled = false;
    setResults((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(async () => {
      const res = await searchTelegramGifs(accountId, q);
      if (!cancelled) setResults({ query: q, gifs: res.gifs, nextOffset: res.nextOffset, loading: false, error: res.error });
    }, q ? 350 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountId, q]);

  const resultsRef = React.useRef(results);
  resultsRef.current = results;
  const loadMore = React.useCallback(async () => {
    const current = resultsRef.current;
    if (current.loading || !current.nextOffset) return;
    setResults({ ...current, loading: true });
    const res = await searchTelegramGifs(accountId, current.query, current.nextOffset);
    setResults((previous) => (previous.query !== current.query ? previous : {
      query: current.query,
      gifs: mergeGifs(previous.gifs, res.gifs),
      nextOffset: res.error ? current.nextOffset : res.nextOffset,
      loading: false,
      error: res.error,
    }));
  }, [accountId]);

  const onScroll = () => {
    if (!scrollEl) return;
    if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < LOAD_MORE_DISTANCE) void loadMore();
  };

  const stale = results.query !== q;
  const showSaved = !q && !!saved && saved.length > 0;
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-2 pb-1 pt-2">
        <SearchField value={query} onChange={setQuery} placeholder="Tìm GIF" />
      </div>
      <InViewRootContext.Provider value={scrollEl}>
        <div ref={setScrollEl} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {scrollEl && (
            <>
              {showSaved && (
                <>
                  <SectionTitle>GIF đã lưu</SectionTitle>
                  <GifGrid accountId={accountId} gifs={saved!} onPick={onPick} onRemove={(gif) => void removeSavedGif(accountId, gif.id)} />
                </>
              )}
              <SectionTitle>{q ? 'Kết quả' : 'Thịnh hành'}</SectionTitle>
              {results.gifs.length > 0 && !stale ? (
                <GifGrid accountId={accountId} gifs={results.gifs} onPick={onPick} />
              ) : results.loading || stale ? (
                <PanelMessage loading>Đang tải GIF…</PanelMessage>
              ) : (
                <PanelMessage>{results.error || (q ? 'Không tìm thấy GIF' : 'Chưa có GIF')}</PanelMessage>
              )}
              {results.loading && !stale && results.gifs.length > 0 && (
                <div className="flex justify-center py-2" aria-hidden>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
                </div>
              )}
            </>
          )}
        </div>
      </InViewRootContext.Provider>
    </div>
  );
});

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="flex h-7 items-center px-1 text-[11px] font-semibold text-muted-foreground">{children}</div>;
}

function GifGrid({ accountId, gifs, onPick, onRemove }: {
  accountId: string;
  gifs: TelegramStickerItem[];
  onPick: (item: TelegramStickerItem) => void;
  onRemove?: (item: TelegramStickerItem) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 pb-1.5">
      {gifs.map((gif) => (
        <TelegramStickerTile key={gif.id} accountId={accountId} item={gif} size={GIF_HEIGHT} cover onClick={onPick} title="Gửi GIF">
          {onRemove && (
            <span
              role="button"
              tabIndex={-1}
              title="Bỏ khỏi GIF đã lưu"
              aria-label="Bỏ khỏi GIF đã lưu"
              onClick={(event) => { event.stopPropagation(); onRemove(gif); }}
              className={cn(
                'absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/55 group-hover:flex',
              )}
              style={{ color: '#fff' }}
            >
              <CloseIcon className="h-3 w-3" />
            </span>
          )}
        </TelegramStickerTile>
      ))}
    </div>
  );
}
