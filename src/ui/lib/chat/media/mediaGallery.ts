/**
 * mediaGallery.ts - order, identity and paging of the image viewer gallery ("Bộ sưu tập").
 *
 * Like Zalo: oldest → newest (newest last); "<" goes to older images, ">" to newer ones and
 * both stop at the ends (no wrap-around). The gallery is paged like the chat (Telegram / Zalo style):
 * keyset cursors on (timestamp, msg_id), see useMediaGallery + db:getMediaMessages.
 * Pure (no store / IPC imports). Unit-tested in src/__tests__/chat/messages/starredMessages.test.ts and
 * src/__tests__/chat/media/mediaGalleryPaging.test.ts.
 */
import { toZaloJpgUrl } from '../../../../utils/zalo/zaloImageUrl';
import { isTelegramMetaAttachment } from '../../../../shared/telegram/telegramAttachmentTypes';

/**
 * Chronological order (oldest first). Stable: equal / missing timestamps keep their relative
 * order, so callers holding a newest-first list (DB pages) reverse it before sorting.
 */
export function sortGalleryChronologically<T extends { timestamp?: number }>(images: T[]): T[] {
  return images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => ((Number(a.image.timestamp) || 0) - (Number(b.image.timestamp) || 0)) || (a.index - b.index))
    .map(entry => entry.image);
}

/** Next index for `direction` (-1 = older, +1 = newer), clamped to the list (no wrap-around). */
export function stepGalleryIndex(current: number, length: number, direction: -1 | 1): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, current + direction));
}

// ─── Paged gallery ──────────────────────────────────────────────────────────────

/** What the helpers need from a gallery item (MediaViewerImage satisfies it). */
export interface GalleryItemLike {
  src?: string;
  displaySrc?: string;
  msgId?: string;
  timestamp?: number;
}

/** A position in the (timestamp, msg_id) order of the DB cursor. */
export interface GalleryCursor {
  ts: number;
  msgId?: string;
}

export type GalleryDirection = 'older' | 'newer';

/** The DB row fields a page needs (rows of db:getMediaMessages). */
export interface GalleryRowLike {
  timestamp?: number | string | null;
  msg_id?: string | number | null;
}

/** Stable identity of an item: its message id, else its URL. Survives pages merged in front of it. */
export function galleryItemKey(item: GalleryItemLike): string {
  return item.msgId ? `m:${item.msgId}` : `u:${item.displaySrc || item.src || ''}`;
}

/** Same key as the old viewer dedupe (src + displaySrc); '' when the item has no URL. */
function urlKey(item: GalleryItemLike): string {
  return item.src || item.displaySrc ? `${item.src || ''}__${item.displaySrc || ''}` : '';
}

/** (timestamp, msg_id) order — the same total order as SQLite's (timestamp, msg_id) row values (ASCII ids). */
function comparePosition(aTs: number, aId: string, bTs: number, bId: string): number {
  if (aTs !== bTs) return aTs < bTs ? -1 : 1;
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

/** Oldest → newest comparator for gallery items (ties: message id). */
export function compareGalleryItems(a: GalleryItemLike, b: GalleryItemLike): number {
  return comparePosition(Number(a.timestamp) || 0, a.msgId || '', Number(b.timestamp) || 0, b.msgId || '');
}

/** Cursor at an item, or null when it has no usable time (cannot be placed in the thread's media). */
export function galleryCursorOf(item: GalleryItemLike | null | undefined): GalleryCursor | null {
  if (!item) return null;
  const ts = Math.floor(Number(item.timestamp));
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return item.msgId ? { ts, msgId: String(item.msgId) } : { ts };
}

/**
 * Adds `incoming` to a gallery list without reloading it: skips items already present (same message id, or same
 * src + displaySrc like the old dedupe), keeps the existing objects (stable keys / React identity) and returns the
 * list oldest → newest. Returns `existing` itself when nothing was added.
 */
export function mergeGalleryItems<T extends GalleryItemLike>(existing: T[], incoming: T[]): T[] {
  if (!incoming || !incoming.length) return existing;
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const item of existing) {
    if (item.msgId) ids.add(item.msgId);
    const key = urlKey(item);
    if (key) urls.add(key);
  }
  const added: T[] = [];
  for (const item of incoming) {
    if (!item) continue;
    if (item.msgId && ids.has(item.msgId)) continue;
    const key = urlKey(item);
    if (key && urls.has(key)) continue;
    if (item.msgId) ids.add(item.msgId);
    if (key) urls.add(key);
    added.push(item);
  }
  if (!added.length) return existing;
  // Array.prototype.sort is stable: equal positions keep list order, new ones after the existing ones
  return [...existing, ...added].sort(compareGalleryItems);
}

function normalizeGalleryUrl(url?: string): string {
  if (!url) return '';
  return url
    .replace(/^local-media:\/+/, 'local-media:///')
    .replace(/\\/g, '/')
    .split('?')[0]
    .trim();
}

/** Index of the clicked image (bubble URL = remote or local display URL), -1 when not in the list. */
export function findGalleryIndexByUrl(items: GalleryItemLike[], url: string): number {
  if (!url) return -1;
  const exact = items.findIndex(item => item.src === url || item.displaySrc === url);
  if (exact >= 0) return exact;
  const wanted = normalizeGalleryUrl(url);
  if (!wanted) return -1;
  return items.findIndex(item => normalizeGalleryUrl(item.src) === wanted || normalizeGalleryUrl(item.displaySrc) === wanted);
}

function rowPosition(row: GalleryRowLike): { ts: number; id: string } {
  return {
    ts: Number(row?.timestamp) || 0,
    id: row?.msg_id === undefined || row?.msg_id === null ? '' : String(row.msg_id),
  };
}

/**
 * One cursor page from DB rows (any order). Keeps only rows strictly past `cursor` in `dir` (inclusive on the
 * timestamp when the cursor has no msgId, like the SQL) — so a server that ignored the cursor cannot inject rows
 * out of place — then the `limit` rows closest to the cursor. The query asks `limit + 1` rows: one more means more
 * exist (no probe request at the end). `next` is the cursor for the following page in `dir`, taken from the raw
 * rows (not from built items), so rows that are not displayable images (videos…) are never fetched twice.
 */
export function takeGalleryPage<R extends GalleryRowLike>(
  rows: R[],
  cursor: GalleryCursor,
  dir: GalleryDirection,
  limit: number,
): { rows: R[]; hasMore: boolean; next: GalleryCursor | null } {
  const older = dir === 'older';
  const beyond = (rows || []).filter(row => {
    if (!row) return false;
    const p = rowPosition(row);
    if (!cursor.msgId) return older ? p.ts <= cursor.ts : p.ts >= cursor.ts;
    const c = comparePosition(p.ts, p.id, cursor.ts, cursor.msgId);
    return older ? c < 0 : c > 0;
  });
  beyond.sort((a, b) => {
    const pa = rowPosition(a);
    const pb = rowPosition(b);
    return comparePosition(pa.ts, pa.id, pb.ts, pb.id);
  });
  const size = Math.max(1, Math.floor(limit) || 1);
  const kept = older ? beyond.slice(Math.max(0, beyond.length - size)) : beyond.slice(0, size);
  const edge = kept.length ? rowPosition(older ? kept[0] : kept[kept.length - 1]) : null;
  return {
    rows: kept,
    hasMore: beyond.length > size,
    next: edge ? (edge.id ? { ts: edge.ts, msgId: edge.id } : { ts: edge.ts }) : null,
  };
}

/**
 * How many positions the item at `anchorIndex` of `prev` moved in `next` (items merged in above it). The strip
 * scrolls by that many tiles so what the user is looking at does not jump. 0 when unknown.
 */
export function galleryInsertShift(prev: GalleryItemLike[], next: GalleryItemLike[], anchorIndex: number): number {
  if (!prev.length || !next.length) return 0;
  const index = Math.min(Math.max(0, Math.floor(anchorIndex) || 0), prev.length - 1);
  const key = galleryItemKey(prev[index]);
  const moved = next.findIndex(item => galleryItemKey(item) === key);
  return moved >= 0 ? moved - index : 0;
}

function parseObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : (value as Record<string, any>);
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const isUsableLocalPath = (path: unknown): path is string =>
  typeof path === 'string' && !!path && path !== 'undefined' && path !== 'null' && !/\.jxl$/i.test(path);

const isRemoteUrl = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url);

/**
 * Smallest image for a gallery tile, like the Telegram / Zalo strips: a local thumbnail file
 * (`local_paths.thumb` / `thumbnail`), else the remote thumbnail (Zalo `content.thumb` / `params.thumbUrl`,
 * Facebook / Telegram `attachments[].thumb`). Remote thumbs are skipped for Zalo media flagged expired.
 * Empty when there is none: the tile then uses the display image.
 */
export function pickGalleryThumb(msg: any): { localPath?: string; url?: string } {
  const localPaths = parseObject(msg?.local_paths);
  const localThumb = [localPaths.thumb, localPaths.thumbnail].find(isUsableLocalPath);
  if (localThumb) return { localPath: localThumb };
  if (Number(msg?.media_expired) === 1) return {};
  const content = parseObject(msg?.content);
  const params = parseObject(content.params);
  const zaloThumb = [content.thumb, params.thumbUrl, params.thumb].find(isRemoteUrl);
  if (zaloThumb) return { url: toZaloJpgUrl(zaloThumb) };
  const attachment = parseArray(msg?.attachments).find(att =>
    att && typeof att === 'object' && isRemoteUrl(att.thumb)
    && !isTelegramMetaAttachment(att));
  return attachment ? { url: attachment.thumb } : {};
}
