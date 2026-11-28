/**
 * GIF tab of the Zalo sticker panel: Giphy GIFs through the Zalo account (zalo:getGifs / zalo:getGifCategories),
 * cached for a few minutes per account and keyword so reopening the panel shows them at once.
 */
import ipc from '@/lib/ipc';
import { tr } from '../../../../shared/i18n';

export interface ZaloGifMedia {
  url: string;
  width: number;
  height: number;
}

export interface ZaloGif {
  id: string;
  original?: ZaloGifMedia;
  normal?: ZaloGifMedia;
  hd?: ZaloGifMedia;
  preview?: ZaloGifMedia;
}

export interface ZaloGifCategory {
  id: string;
  name: string;
  keyword: string;
  icon?: string;
}

export interface ZaloGifPage {
  gifs: ZaloGif[];
  error?: string;
}

/**
 * Zalo answers with one list of 20 GIFs: any offset / limit returns the same 20 (measured on real accounts, trending and
 * search), so there is no "load more".
 */
export const ZALO_GIF_PAGE_SIZE = 20;
const PAGE_TTL_MS = 10 * 60 * 1000;
const CATEGORY_TTL_MS = 60 * 60 * 1000;

const pageCache = new Map<string, { page: ZaloGifPage; at: number }>();
const categoryCache = new Map<string, { list: ZaloGifCategory[]; at: number }>();

function media(value: any): ZaloGifMedia | undefined {
  const url = String(value?.url || '').trim();
  return /^https:\/\//i.test(url) ? { url, width: Number(value?.width) || 0, height: Number(value?.height) || 0 } : undefined;
}

export function normalizeZaloGif(raw: any): ZaloGif | null {
  const id = String(raw?.id ?? '').trim();
  const gif: ZaloGif = { id, original: media(raw?.original), normal: media(raw?.normal), hd: media(raw?.hd), preview: media(raw?.preview) };
  if (!id || !(gif.preview || gif.normal || gif.original || gif.hd)) return null;
  return gif;
}

const cleanText = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Topic chip. Zalo gives a Vietnamese name ("chào") and an English one ("hello"); the search works best with the English
 * one (GIFs come from Giphy). Keyword lists can hold padding / line breaks, so they are only a fallback.
 */
export function normalizeZaloGifCategory(raw: any): ZaloGifCategory | null {
  const name = cleanText(raw?.name) || cleanText(raw?.enName);
  const keywords = Array.isArray(raw?.keywords) ? raw.keywords.map(cleanText).filter(Boolean) : [];
  const keyword = cleanText(raw?.enName) || keywords[0] || name;
  if (!name || !keyword) return null;
  const icon = String(raw?.icon || '').trim();
  return { id: String(raw?.id ?? name), name, keyword, ...(/^https:\/\//i.test(icon) ? { icon } : {}) };
}

const isVideoUrl = (url: string) => /\.(mp4|webm)(\?|$)/i.test(url);
const isGifUrl = (url: string) => /\.gif(\?|$)/i.test(url);

/** Still picture of a tile: Zalo's preview is a PNG of the first frame (~100 KB, the GIF itself is 0.4-1.2 MB). */
export function zaloGifThumb(gif: ZaloGif): ZaloGifMedia | undefined {
  return [gif.preview, gif.normal, gif.original, gif.hd].find((m) => m && !isVideoUrl(m.url));
}

/** The moving GIF (shown on hover and in the sent message). */
export function zaloGifAnimated(gif: ZaloGif): ZaloGifMedia | undefined {
  return [gif.normal, gif.original, gif.hd, gif.preview].find((m) => m && isGifUrl(m.url))
    || [gif.normal, gif.original, gif.hd].find((m) => m && !isVideoUrl(m.url));
}

/** URLs to try when sending, best first: the main process sends the first one that really is a GIF file. */
export function zaloGifSendUrls(gif: ZaloGif): string[] {
  const all = [gif.normal, gif.original, gif.hd, gif.preview].map((m) => m?.url || '').filter((u) => u && !isVideoUrl(u));
  const gifs = all.filter(isGifUrl);
  const urls = gifs.length ? gifs : all;
  return urls.filter((u, i) => urls.indexOf(u) === i);
}

/** Trending GIFs (empty keyword) or search results. */
export async function loadZaloGifs(auth: any, keyword: string): Promise<ZaloGifPage> {
  const kw = String(keyword || '').trim();
  const key = `${auth?.accountId || ''}|${kw.toLowerCase()}`;
  const cached = pageCache.get(key);
  if (cached && Date.now() - cached.at < PAGE_TTL_MS) return cached.page;
  try {
    const res = await ipc.zalo?.getGifs({ auth, keyword: kw, offset: 0, limit: ZALO_GIF_PAGE_SIZE });
    if (!res?.success) return { gifs: [], error: res?.error || tr('Không tải được GIF') };
    const list: any[] = Array.isArray(res.response?.data_list) ? res.response.data_list : [];
    const page: ZaloGifPage = { gifs: list.map(normalizeZaloGif).filter((gif): gif is ZaloGif => !!gif) };
    pageCache.set(key, { page, at: Date.now() });
    return page;
  } catch (err: any) {
    return { gifs: [], error: err?.message || tr('Không tải được GIF') };
  }
}

/** Topic chips of the GIF tab ([] when Zalo has none or the call fails). */
export async function loadZaloGifCategories(auth: any): Promise<ZaloGifCategory[]> {
  const key = String(auth?.accountId || '');
  const cached = categoryCache.get(key);
  if (cached && Date.now() - cached.at < CATEGORY_TTL_MS) return cached.list;
  try {
    const res = await ipc.zalo?.getGifCategories({ auth });
    if (!res?.success) return [];
    const raw: any[] = Array.isArray(res.response?.data_list) ? res.response.data_list : [];
    const list = raw.map(normalizeZaloGifCategory).filter((c): c is ZaloGifCategory => !!c);
    categoryCache.set(key, { list, at: Date.now() });
    return list;
  } catch {
    return [];
  }
}
