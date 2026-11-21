/**
 * Zalo stickers of the composer: the packs added from the sticker store (sticker_packs table, so an employee machine sees
 * the packs of its Boss) and the sticker suggestions for a typed text: Zalo's keyword table first (no network, right
 * away), then Zalo's suggestion API (cached per keyword in the DB) for newer stickers. Sticker details are asked from Zalo
 * only for stickers the copied data does not know (the packs and the keyword table already give pack and type).
 */
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import {
  ZALO_STICKER_PACKS, ZALO_STICKER_STORE_PACKS, zaloAddedPackRecord, zaloAddedPacksFromRecords, zaloSticker,
  type ZaloPackSticker, type ZaloStickerPack,
} from '../../../../shared/zalo/zaloStickerPacks';
import {
  findZaloKeywordStickers, loadZaloStickerKeywordIndex, type ZaloStickerKeywordIndex,
} from '../../../../shared/zalo/zaloStickerKeywords';

// ─── Packs added from the store ──────────────────────────────────────────────

let addedPacks: Promise<ZaloStickerPack[]> | null = null;

/** Added packs, newest first (read once, again after a change). */
export function loadZaloAddedPacks(): Promise<ZaloStickerPack[]> {
  if (!addedPacks) {
    addedPacks = DataAccessor.getStickerPacks()
      .then((res: any) => zaloAddedPacksFromRecords(Array.isArray(res?.packs) ? res.packs : []))
      .catch(() => {
        addedPacks = null;
        return [];
      });
  }
  return addedPacks;
}

/** Adds a store pack to the library, or takes it out again. */
export async function setZaloPackAdded(pack: ZaloStickerPack, added: boolean): Promise<boolean> {
  try {
    const res: any = await DataAccessor.saveStickerPacks({ packs: [zaloAddedPackRecord(pack, !added)] });
    return res?.success !== false;
  } catch {
    return false;
  } finally {
    addedPacks = null;
  }
}

// ─── Suggestions for a typed text ────────────────────────────────────────────

/** Sticker as the composer receives it from Zalo's API or the copied data. */
export type ZaloSuggestedSticker = ZaloPackSticker | (Record<string, any> & { id: number });

/** Zalo's keyword table: the user's library packs (own + added) first. */
export async function zaloKeywordStickerSuggestions(text: string, limit: number): Promise<ZaloPackSticker[]> {
  try {
    const [index, added] = await Promise.all([loadZaloStickerKeywordIndex(), loadZaloAddedPacks()]);
    const preferPacks = new Set([...added, ...ZALO_STICKER_PACKS].map((p) => p.id));
    return findZaloKeywordStickers(index, text, { limit, preferPacks });
  } catch {
    return [];
  }
}

let knownStickers: Promise<Map<number, ZaloPackSticker>> | null = null;

/** Every sticker of the copied data by id: library packs, store packs and the keyword table. */
export function zaloKnownStickerMap(index: ZaloStickerKeywordIndex | null): Map<number, ZaloPackSticker> {
  const map = new Map<number, ZaloPackSticker>();
  for (const pack of [...ZALO_STICKER_PACKS, ...ZALO_STICKER_STORE_PACKS]) {
    for (const id of pack.stickerIds) if (!map.has(id)) map.set(id, zaloSticker(id, pack.id, pack.name));
  }
  for (const [cateId, id] of index?.stickers || []) if (!map.has(id)) map.set(id, zaloSticker(id, cateId));
  return map;
}

function loadKnownStickers(): Promise<Map<number, ZaloPackSticker>> {
  if (!knownStickers) {
    knownStickers = loadZaloStickerKeywordIndex()
      .catch(() => null)
      .then((index) => zaloKnownStickerMap(index));
  }
  return knownStickers;
}

/**
 * Zalo's suggestion API for a keyword, as before: the keyword's ids come from the DB cache when it was asked already
 * ([] = asked, nothing found), otherwise from Zalo (then cached). Details only for stickers the app does not know.
 */
export async function zaloApiStickerSuggestions(keyword: string, auth: any, limit: number): Promise<ZaloSuggestedSticker[]> {
  let ids: number[] | null = null;
  const cached: any = await DataAccessor.getKeywordStickers(keyword).catch(() => null);
  if (cached?.success && Array.isArray(cached.stickerIds)) ids = cached.stickerIds.map(Number);
  if (ids === null) {
    if (!auth) return [];
    const res: any = await ipc.zalo?.getStickers({ auth, keyword });
    if (!Array.isArray(res?.response)) return [];
    ids = res.response.map(Number);
    DataAccessor.saveKeywordStickers?.({ keyword, stickerIds: ids as number[] }).catch(() => {});
  }
  const wanted = (ids as number[]).filter((id) => Number.isInteger(id) && id > 0).slice(0, limit);
  if (!wanted.length) return [];

  const known = await loadKnownStickers();
  const byId = new Map<number, ZaloSuggestedSticker>();
  let unknown: number[] = [];
  for (const id of wanted) {
    const sticker = known.get(id);
    if (sticker) byId.set(id, sticker);
    else unknown.push(id);
  }
  if (unknown.length) {
    const fromDb: any = await DataAccessor.getStickers({ stickerIds: unknown }).catch(() => null);
    for (const s of Array.isArray(fromDb?.stickers) ? fromDb.stickers : []) if (s?.id) byId.set(Number(s.id), s);
    unknown = unknown.filter((id) => !byId.has(id));
  }
  if (unknown.length && auth) {
    const detail: any = await ipc.zalo?.getStickersDetail({ auth, stickerIds: unknown });
    const stickers: any[] = Array.isArray(detail?.response) ? detail.response : [];
    for (const s of stickers) if (s?.id) byId.set(Number(s.id), s);
    if (stickers.length) DataAccessor.saveStickers({ stickers }).catch(() => {});
  }
  return wanted.map((id) => byId.get(id)).filter((s): s is ZaloSuggestedSticker => !!s);
}

/** `first` then the stickers of `second` that are not in it yet, at most `max`. */
export function mergeStickerSuggestions<T extends { id?: any }>(first: readonly T[], second: readonly T[], max: number): T[] {
  const seen = new Set<number>();
  const merged: T[] = [];
  for (const sticker of [...first, ...second]) {
    const id = Number(sticker?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(sticker);
    if (merged.length >= max) break;
  }
  return merged;
}
