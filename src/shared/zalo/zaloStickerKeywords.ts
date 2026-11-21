/**
 * Zalo's sticker keyword table (zaloStickerKeywords.json, copied from Zalo Web on 2026-11-20, its "source" says from where):
 * the words Zalo knows ("hi", "ok", ":)", "cam on", "chào"...) and the stickers it suggests for each. The composer shows
 * these right away while typing; Zalo's suggestion API still runs after a pause and adds newer stickers, like Zalo does.
 *
 * Lookup like Zalo: the whole message, lower case; a keyword written with diacritics must match them ("hôn" and "hờn" are
 * different keywords); text with no exact keyword falls back to the keywords that read the same without diacritics
 * ("cảm ơn" → "cam on", "chao" → "chào").
 *
 * The JSON is ~340 KB, so it is a separate chunk loaded on first use (loadZaloStickerKeywordIndex).
 */
import { zaloSticker, zaloStickerPackName, type ZaloPackSticker } from './zaloStickerPacks';

/** The JSON file: stickers = [cateId, stickerId]; keywords = [keyword, indexes into stickers] in Zalo's order. */
export interface ZaloStickerKeywordData {
  version: number;
  stickers: number[][];
  keywords: Array<[string, number[]]>;
}

export interface ZaloStickerKeywordIndex {
  version: number;
  /** [cateId, stickerId] */
  stickers: ReadonlyArray<readonly number[]>;
  /** Normalised keyword → sticker indexes. */
  exact: ReadonlyMap<string, readonly number[]>;
  /** Keyword without diacritics → sticker indexes of every keyword that reads so. */
  folded: ReadonlyMap<string, readonly number[]>;
  /** Longer text is never a keyword, so it is not looked up. */
  longestKeyword: number;
}

/** Zalo's own entries that nobody types (topic groups, test keywords). */
const INTERNAL_KEYWORD = /^topic\s|test_kwd/i;
/** "ok!!", "hi." → "ok", "hi" when the text with its punctuation is not a keyword ("?" and "ts khong?" are). */
const TRAILING_PUNCTUATION = /[\s.!?,~…]+$/u;

/** Lower case, one space between words, no space around. */
export function normalizeStickerKeyword(text: string): string {
  return String(text || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** normalizeStickerKeyword without Vietnamese diacritics ("cảm ơn" → "cam on", "đói" → "doi"). */
export function foldStickerKeyword(text: string): string {
  return normalizeStickerKeyword(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').normalize('NFC');
}

function appendList(map: Map<string, number[]>, key: string, items: readonly number[]): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [...items]);
    return;
  }
  for (const item of items) if (!list.includes(item)) list.push(item);
}

export function buildZaloStickerKeywordIndex(data: ZaloStickerKeywordData): ZaloStickerKeywordIndex {
  const stickers = Array.isArray(data?.stickers) ? data.stickers : [];
  const exact = new Map<string, number[]>();
  const folded = new Map<string, number[]>();
  let longestKeyword = 0;
  for (const entry of Array.isArray(data?.keywords) ? data.keywords : []) {
    const [raw, list] = Array.isArray(entry) ? entry : [];
    if (typeof raw !== 'string' || INTERNAL_KEYWORD.test(raw) || !Array.isArray(list)) continue;
    const keyword = normalizeStickerKeyword(raw);
    const items = list.filter((i) => Number.isInteger(i) && i >= 0 && i < stickers.length);
    if (!keyword || !items.length) continue;
    appendList(exact, keyword, items);
    appendList(folded, foldStickerKeyword(keyword), items);
    longestKeyword = Math.max(longestKeyword, keyword.length);
  }
  return { version: Number(data?.version) || 0, stickers, exact, folded, longestKeyword };
}

function keywordHits(index: ZaloStickerKeywordIndex, keyword: string): readonly number[] {
  return index.exact.get(keyword) || index.folded.get(foldStickerKeyword(keyword)) || [];
}

export interface ZaloKeywordStickerOptions {
  /** Default 20. */
  limit?: number;
  /** Stickers of these packs (the user's library) come first; Zalo's order is kept inside each group. */
  preferPacks?: ReadonlySet<number>;
}

/** The stickers Zalo suggests for a message ([] when the message is not one of its keywords). */
export function findZaloKeywordStickers(
  index: ZaloStickerKeywordIndex,
  text: string,
  options: ZaloKeywordStickerOptions = {},
): ZaloPackSticker[] {
  const limit = options.limit ?? 20;
  const keyword = normalizeStickerKeyword(text);
  if (!keyword || keyword.length > index.longestKeyword + 3 || limit <= 0) return [];
  let hits = keywordHits(index, keyword);
  if (!hits.length) {
    const trimmed = keyword.replace(TRAILING_PUNCTUATION, '');
    if (trimmed && trimmed !== keyword) hits = keywordHits(index, trimmed);
  }
  const prefer = options.preferPacks;
  const ordered = prefer?.size
    ? [...hits.filter((i) => prefer.has(index.stickers[i][0])), ...hits.filter((i) => !prefer.has(index.stickers[i][0]))]
    : hits;
  return ordered.slice(0, limit).map((i) => {
    const [cateId, stickerId] = index.stickers[i];
    return zaloSticker(stickerId, cateId, zaloStickerPackName(cateId));
  });
}

let loading: Promise<ZaloStickerKeywordIndex> | null = null;

/** The keyword table, loaded once (a failed load is tried again next time). */
export function loadZaloStickerKeywordIndex(): Promise<ZaloStickerKeywordIndex> {
  if (!loading) {
    loading = import('./zaloStickerKeywords.json')
      .then((mod: any) => buildZaloStickerKeywordIndex((mod?.default ?? mod) as ZaloStickerKeywordData))
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}
