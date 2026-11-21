/**
 * Zalo sticker packs for the sticker library, organised like the STICKER tab of Zalo itself: the pack order, names, icons and
 * sticker ids were copied from Zalo Web on 2026-11-20 (zaloStickerPacks.json, its "source" says which Zalo storage each part
 * comes from). A sticker image is derived from its id, the same address Zalo Web loads, so the library needs no API call;
 * sending needs only the id (ZaloService.sendSticker reads the sticker details first).
 *
 * zaloStickerStore.json holds the other public packs of Zalo's sticker store (its + button), copied the same way with their
 * sticker ids, so adding one to the library needs no API call either. Added packs are rows of the sticker_packs table
 * (DataAccessor.saveStickerPacks) marked with ZALO_ADDED_PACK_SOURCE.
 */
import catalog from './zaloStickerPacks.json';
import storeCatalog from './zaloStickerStore.json';

export interface ZaloStickerPack {
  /** Zalo sticker category id (cateId of its stickers). */
  id: number;
  name: string;
  iconUrl: string;
  stickerIds: number[];
  /** Zalo shows its "Mới" (new) badge on this pack in the sticker store. */
  isNew?: boolean;
}

/** One sticker as the composer uses it: the same fields as Zalo's sticker detail API. */
export interface ZaloPackSticker {
  id: number;
  cateId: number;
  type: number;
  text: string;
  stickerUrl: string;
  stickerSpriteUrl: string;
}

const ZALO_STICKER_HOST = 'https://zalo-api.zadn.vn/';
/** Preview size Zalo Web uses in its sticker panel. */
export const ZALO_STICKER_PREVIEW_SIZE = 130;
/** Every sticker in the copied packs is an animated sprite sticker (Zalo type 7). */
const ZALO_SPRITE_STICKER_TYPE = 7;

/** Still image of a sticker (Zalo Web's panel image). */
export function zaloStickerImageUrl(stickerId: number, size = ZALO_STICKER_PREVIEW_SIZE): string {
  return `${ZALO_STICKER_HOST}api/emoticon/sticker/webpc?eid=${stickerId}&size=${size}`;
}

/** Animation frames of a sticker (sprite sheet). */
export function zaloStickerSpriteUrl(stickerId: number, size = ZALO_STICKER_PREVIEW_SIZE): string {
  return `${ZALO_STICKER_HOST}api/emoticon/sprite?eid=${stickerId}&size=${size}`;
}

/** A sticker of the copied data (pack, store or keyword table), ready for a sticker grid and for sending. */
export function zaloSticker(id: number, cateId: number, text = ''): ZaloPackSticker {
  return {
    id,
    cateId,
    type: ZALO_SPRITE_STICKER_TYPE,
    text,
    stickerUrl: zaloStickerImageUrl(id),
    stickerSpriteUrl: zaloStickerSpriteUrl(id),
  };
}

type RawPack = { id: number; name: string; icon: string; from?: number; count?: number; stickers?: number[]; new?: boolean };

/** A pack lists its stickers explicitly, or as `from` + `count` when the ids are consecutive (almost every pack). */
function rawStickerIds(raw: RawPack): number[] {
  if (Array.isArray(raw.stickers)) return raw.stickers.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const from = Number(raw.from);
  const count = Number(raw.count);
  if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(count) || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => from + index);
}

/** Icons are paths under `iconBase`; a few packs keep their icon on another Zalo host (full address). */
function packsFromCatalog(source: { iconBase: string; packs: unknown }): ZaloStickerPack[] {
  return (source.packs as RawPack[]).map((raw) => {
    const icon = String(raw.icon || '');
    const pack: ZaloStickerPack = {
      id: Number(raw.id),
      name: String(raw.name || '').trim(),
      iconUrl: /^https?:\/\//i.test(icon) ? icon : `${source.iconBase}${icon}`,
      stickerIds: rawStickerIds(raw),
    };
    if (raw.new) pack.isNew = true;
    return pack;
  });
}

/** The library: the packs of the Zalo account the data was copied from, in its order. */
export const ZALO_STICKER_PACKS: readonly ZaloStickerPack[] = packsFromCatalog(catalog);

/** Zalo's sticker store (the + button of the library): every other public pack, in Zalo's catalog order. */
export const ZALO_STICKER_STORE_PACKS: readonly ZaloStickerPack[] = packsFromCatalog(storeCatalog);

/** The stickers of a pack, ready for the sticker grid and for sending. */
export function zaloPackStickers(pack: ZaloStickerPack): ZaloPackSticker[] {
  return pack.stickerIds.map((id) => zaloSticker(id, pack.id, pack.name));
}

let packNames: Map<number, string> | null = null;

/** Name of a pack of the copied data ('' when the pack is not in the library or the store). */
export function zaloStickerPackName(cateId: number): string {
  if (!packNames) packNames = new Map([...ZALO_STICKER_STORE_PACKS, ...ZALO_STICKER_PACKS].map((p) => [p.id, p.name]));
  return packNames.get(cateId) || '';
}

/** Marks the sticker_packs rows written for packs added from the store (other rows of that table are older caches). */
export const ZALO_ADDED_PACK_SOURCE = 'zalo-store';

/** A sticker_packs row (data_json) of a pack added from the store. */
export interface ZaloAddedPackRecord {
  catId: number;
  name: string;
  thumbUrl: string;
  stickerCount: number;
  stickerIds: number[];
  source: typeof ZALO_ADDED_PACK_SOURCE;
  /** Taken out of the library again: the table has no delete, so the row stays and the library skips it. */
  removed: boolean;
}

export function zaloAddedPackRecord(pack: ZaloStickerPack, removed = false): ZaloAddedPackRecord {
  return {
    catId: pack.id,
    name: pack.name,
    thumbUrl: pack.iconUrl,
    stickerCount: pack.stickerIds.length,
    stickerIds: [...pack.stickerIds],
    source: ZALO_ADDED_PACK_SOURCE,
    removed,
  };
}

/**
 * The packs added from the store, from the rows of getStickerPacks (newest first, one row per pack): rows of other
 * origins, removed packs and packs already in the library are skipped.
 */
export function zaloAddedPacksFromRecords(rows: readonly unknown[]): ZaloStickerPack[] {
  const own = new Set(ZALO_STICKER_PACKS.map((p) => p.id));
  const store = new Map(ZALO_STICKER_STORE_PACKS.map((p) => [p.id, p]));
  const seen = new Set<number>();
  const packs: ZaloStickerPack[] = [];
  for (const row of rows) {
    const record = row as Partial<ZaloAddedPackRecord> | null;
    if (!record || record.source !== ZALO_ADDED_PACK_SOURCE) continue;
    const id = Number(record.catId);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    if (record.removed || own.has(id)) continue;
    const known = store.get(id);
    const saved = Array.isArray(record.stickerIds)
      ? record.stickerIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const stickerIds = saved.length ? saved : [...(known?.stickerIds || [])];
    if (!stickerIds.length) continue;
    packs.push({
      id,
      name: String(record.name || known?.name || '').trim(),
      iconUrl: String(record.thumbUrl || known?.iconUrl || ''),
      stickerIds,
    });
  }
  return packs;
}
