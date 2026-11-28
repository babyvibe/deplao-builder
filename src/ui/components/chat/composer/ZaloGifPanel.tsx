/**
 * "GIF" tab of the Zalo sticker panel, like the GIF tab of Zalo: trending GIFs, topic chips and a search
 * (Giphy through the Zalo account). Zalo answers with 20 GIFs per list (no paging); click a GIF = send it to the open conversation.
 */
import React from 'react';
import { cn } from '@/lib/cn';
import {
  loadZaloGifCategories,
  loadZaloGifs,
  zaloGifAnimated,
  zaloGifThumb,
  type ZaloGif,
  type ZaloGifCategory,
} from '@/lib/chat/zalo/zaloGifs';
import { PanelMessage, SearchField } from '../telegram/stickers/TelegramStickerPanel';
import { tr } from '../../../../shared/i18n';

const TILE_HEIGHT = 92;
/** Fixed height: the panel does not jump while a list loads. */
const PANEL_HEIGHT = '24.5rem';

interface Results {
  keyword: string;
  gifs: ZaloGif[];
  loading: boolean;
  error?: string;
}

export default function ZaloGifPanel({ getAuth, onPick }: {
  getAuth: () => any;
  onPick: (gif: ZaloGif) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<ZaloGifCategory | null>(null);
  const [categories, setCategories] = React.useState<ZaloGifCategory[]>([]);
  const [results, setResults] = React.useState<Results>({ keyword: '\u0000', gifs: [], loading: true });
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const getAuthRef = React.useRef(getAuth);
  getAuthRef.current = getAuth;
  const typed = query.trim();
  const keyword = typed || category?.keyword || '';

  React.useEffect(() => {
    let cancelled = false;
    void loadZaloGifCategories(getAuthRef.current()).then((list) => { if (!cancelled) setCategories(list); });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setResults((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(async () => {
      const page = await loadZaloGifs(getAuthRef.current(), keyword);
      if (cancelled) return;
      setResults({ keyword, gifs: page.gifs, loading: false, error: page.error });
      scrollRef.current?.scrollTo({ top: 0 });
    }, typed ? 400 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [keyword, typed]);

  const stale = results.keyword !== keyword;
  const title = !keyword ? tr('Thịnh hành') : category && !typed ? category.name : tr('Kết quả');
  return (
    <div className="flex min-h-0 flex-col" style={{ height: PANEL_HEIGHT }}>
      <div className="shrink-0 px-2 pb-1.5 pt-2">
        <SearchField
          value={query}
          onChange={(value) => { setQuery(value); if (value.trim()) setCategory(null); }}
          placeholder={tr('Tìm GIF')}
        />
      </div>
      {!typed && categories.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto px-2 pb-1.5 [scrollbar-width:none]">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={category?.id === c.id}
              onClick={() => setCategory((previous) => (previous?.id === c.id ? null : c))}
              className={cn(
                'flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                category?.id === c.id
                  ? 'border-blue-400 bg-blue-500/15 text-blue-400'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {c.icon && <img src={c.icon} alt="" className="h-4 w-4 object-contain" loading="lazy" draggable={false} />}
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        <div className="flex h-7 items-center px-1 text-[11px] font-semibold text-muted-foreground">{title}</div>
        {results.gifs.length > 0 && !stale ? (
          <div className="grid grid-cols-3 gap-1 pb-1.5">
            {results.gifs.map((gif) => <GifTile key={gif.id} gif={gif} onPick={onPick} />)}
          </div>
        ) : results.loading || stale ? (
          <PanelMessage loading>{tr('Đang tải GIF…')}</PanelMessage>
        ) : (
          <PanelMessage>{results.error || (keyword ? tr('Không tìm thấy GIF') : tr('Chưa có GIF'))}</PanelMessage>
        )}
      </div>
    </div>
  );
}

/** Still picture until the pointer is on the tile, then the moving GIF (dozens of animated GIFs at once = tens of MB). */
function GifTile({ gif, onPick }: { gif: ZaloGif; onPick: (gif: ZaloGif) => void }) {
  const still = zaloGifThumb(gif);
  const moving = zaloGifAnimated(gif);
  const [hover, setHover] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  if (!still || failed) return null;
  return (
    <button
      type="button"
      title={tr('Gửi GIF')}
      onClick={() => onPick(gif)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative overflow-hidden rounded-lg bg-muted"
      style={{ height: TILE_HEIGHT }}
    >
      <img
        src={still.url}
        alt=""
        loading="lazy"
        draggable={false}
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
      {hover && moving && moving.url !== still.url && (
        <img src={moving.url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      )}
    </button>
  );
}
