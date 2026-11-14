import * as fs from 'fs';
import * as path from 'path';
import { writeMediaFile } from '../../file/writeMediaFile';
import type {
  TelegramCoveredStickerSet,
  TelegramStickerFileKind,
  TelegramStickerFormat,
  TelegramStickerItem,
  TelegramStickerSetInfo,
  TelegramStickerSetRef,
} from '../../../shared/telegram/telegramStickers';
import { tr } from '../../../shared/i18n';

export type { TelegramCoveredStickerSet, TelegramStickerFormat, TelegramStickerItem, TelegramStickerSetInfo, TelegramStickerSetRef };

/**
 * Telegram stickers & GIFs (personal account): data SYNCED with the account: installed sticker sets, recent / favourite stickers,
 * saved GIFs (adding / removing here also shows in the other Telegram apps).
 *
 * - Every Document fetched is kept in the per-account cache WITH its source (set / recent / favourite / GIF / GIF search / message):
 *   sending and downloading need a fileReference that is still valid; when it expires (FILE_REFERENCE_*), fetch it again from the source and retry once.
 * - Lists use Telegram's `hash` (NotModified → reuse the copy already held, no download again).
 * - Grid images: the static thumbnail (webp / jpg) if there is one, otherwise the whole file (a small tgs); at most 3 downloads in parallel, with a timeout,
 *   saved to disk in `<media>/<account>/stickers/`. Does NOT go through the chat's sequential media download queue.
 * - GIF search = inline bot @gif (like the Telegram app). `messages.getGifs / searchGifs` is not in the API.
 */

export interface StickerClientDeps {
  client: any;
  Api: any;
  resolvePeer: (chatId: string) => Promise<any>;
  /** Save and show the message just sent (same path as messages I send from another device). */
  persistSent: (message: any) => Promise<void>;
  /** Media folder (FileStorageService.getBaseDir()). */
  baseDir: string;
}

type StickerSource =
  | { kind: 'set'; ref: TelegramStickerSetRef }
  | { kind: 'recent' }
  | { kind: 'faved' }
  | { kind: 'gifs' }
  | { kind: 'gifSearch'; query: string; offset: string }
  | { kind: 'message'; chatId: string; messageId: string }
  | { kind: 'customEmoji' };

type Result<T> = ({ success: true } & T) | { success: false; error: string };

/** 64-bit id / access hash (GramJS BigInteger): String() = toString() keeps every digit; valueOf() returns a Number and loses precision. */
const toId = (value: any): string => (value == null ? '' : String(value));

// ── Pure functions ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function stickerFormatOf(doc: any): TelegramStickerFormat {
  const mime = String(doc?.mimeType || '').toLowerCase();
  const attributes: any[] = doc?.attributes || [];
  if (mime.includes('tgsticker') || mime.includes('lottie')) return 'tgs';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('webp')) return 'webp';
  if (attributes.some((a) => a?.className === 'DocumentAttributeAnimated') || mime === 'video/mp4' || mime === 'image/gif') return 'gif';
  return 'image';
}

export function stickerSetRefOf(inputSet: any): TelegramStickerSetRef | null {
  if (inputSet?.className === 'InputStickerSetID' && inputSet.id != null) {
    return { id: toId(inputSet.id), accessHash: toId(inputSet.accessHash) };
  }
  if (inputSet?.className === 'InputStickerSetShortName' && inputSet.shortName) return { shortName: String(inputSet.shortName) };
  return null;
}

export function toStickerItem(doc: any): TelegramStickerItem | null {
  if (!doc || doc.className === 'DocumentEmpty' || doc.id == null) return null;
  const attributes: any[] = doc.attributes || [];
  // Custom emoji (forum topic icons…) carry the base emoji + the set in DocumentAttributeCustomEmoji
  const sticker = attributes.find((a) => a?.className === 'DocumentAttributeSticker' || a?.className === 'DocumentAttributeCustomEmoji');
  const size = attributes.find((a) => a?.className === 'DocumentAttributeImageSize' || a?.className === 'DocumentAttributeVideo');
  const ref = stickerSetRefOf(sticker?.stickerset);
  return {
    id: toId(doc.id),
    emoji: String(sticker?.alt || ''),
    format: stickerFormatOf(doc),
    width: Number(size?.w || 512),
    height: Number(size?.h || 512),
    ...(ref?.id ? { setId: ref.id, setAccessHash: ref.accessHash } : {}),
    ...(ref?.shortName ? { setShortName: ref.shortName } : {}),
  };
}

export function toStickerSetInfo(set: any): TelegramStickerSetInfo {
  return {
    id: toId(set?.id),
    accessHash: toId(set?.accessHash),
    shortName: String(set?.shortName || ''),
    title: String(set?.title || ''),
    count: Number(set?.count || 0),
    installed: set?.installedDate != null && !set?.archived,
    archived: !!set?.archived,
  };
}

/** A real sticker set (not a custom emoji set / mask set). */
export function isRegularStickerSet(set: any): boolean {
  return !!set && !set.emojis && !set.masks;
}

/** Static thumbnail for the grid: 'm' size image (≈ 128–320 px) if there is one, otherwise the largest image ≤ 512 px. */
export function pickStickerThumb(doc: any): any | null {
  const thumbs: any[] = (doc?.thumbs || []).filter((t: any) => t?.className === 'PhotoSize' || t?.className === 'PhotoCachedSize');
  if (thumbs.length === 0) return null;
  return thumbs.find((t) => t.type === 'm')
    || [...thumbs].sort((a, b) => Number(b.w || 0) - Number(a.w || 0)).find((t) => Number(t.w || 0) <= 512)
    || thumbs[0];
}

export function detectFileExt(buffer: Buffer, fallback: string): string {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG') return '.png';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return '.tgs';
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return '.webm';
  if (buffer.length >= 8 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') return '.mp4';
  return fallback;
}

export type StickerFileKind = TelegramStickerFileKind;

export function fileKindOfExt(ext: string): StickerFileKind {
  if (ext === '.tgs') return 'tgs';
  if (ext === '.webm' || ext === '.mp4') return 'video';
  return 'image';
}

const FULL_EXT: Record<TelegramStickerFormat, string> = { webp: '.webp', tgs: '.tgs', webm: '.webm', gif: '.mp4', image: '.jpg' };
const KNOWN_EXTS = ['.webp', '.jpg', '.png', '.gif', '.tgs', '.webm', '.mp4'];

export function isFileReferenceError(err: any): boolean {
  return /FILE_REFERENCE_/i.test(String(err?.errorMessage || err?.message || err || ''));
}

// ── Cache ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_DOCS_PER_ACCOUNT = 5000;
const docsByAccount = new Map<string, Map<string, { doc: any; source: StickerSource }>>();

function rememberDocs(accountId: string, docs: any[], source: StickerSource): TelegramStickerItem[] {
  let cache = docsByAccount.get(accountId);
  if (!cache) docsByAccount.set(accountId, (cache = new Map()));
  const items: TelegramStickerItem[] = [];
  for (const doc of docs || []) {
    const item = toStickerItem(doc);
    if (!item) continue;
    cache.delete(item.id);
    cache.set(item.id, { doc, source });
    items.push(item);
  }
  while (cache.size > MAX_DOCS_PER_ACCOUNT) cache.delete(cache.keys().next().value as string);
  return items;
}

function cachedDoc(accountId: string, docId: string) {
  return docsByAccount.get(accountId)?.get(String(docId)) || null;
}

interface HashedList<T> { hash: any; value: T }
const listCache = new Map<string, HashedList<any>>();
const setCache = new Map<string, { hash: number; set: TelegramStickerSetInfo; stickers: TelegramStickerItem[] }>();

/** Test only. */
export function __resetTelegramStickerCaches(): void {
  docsByAccount.clear();
  listCache.clear();
  setCache.clear();
  fileInflight.clear();
}

function inputStickerSet(Api: any, ref: TelegramStickerSetRef): any {
  if (ref.id && ref.accessHash) return new Api.InputStickerSetID({ id: BigInt(ref.id), accessHash: BigInt(ref.accessHash) });
  if (ref.shortName) return new Api.InputStickerSetShortName({ shortName: ref.shortName });
  throw new Error(tr('Thiếu thông tin bộ sticker'));
}

function setKey(accountId: string, ref: TelegramStickerSetRef): string {
  return `${accountId}:${ref.id || `name:${ref.shortName || ''}`}`;
}

// ── Telegram calls ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Installed sticker sets (the account's order) + recent stickers + favourites. */
export async function getStickerPanel(accountId: string, deps: StickerClientDeps): Promise<Result<{
  sets: TelegramStickerSetInfo[]; recent: TelegramStickerItem[]; faved: TelegramStickerItem[];
}>> {
  const { client, Api } = deps;
  try {
    const setsKey = `${accountId}:sets`;
    const recentKey = `${accountId}:recent`;
    const favedKey = `${accountId}:faved`;
    const [allResult, recentResult, favedResult]: any[] = await Promise.all([
      client.invoke(new Api.messages.GetAllStickers({ hash: listCache.get(setsKey)?.hash ?? BigInt(0) })),
      client.invoke(new Api.messages.GetRecentStickers({ hash: listCache.get(recentKey)?.hash ?? BigInt(0) })).catch(() => null),
      client.invoke(new Api.messages.GetFavedStickers({ hash: listCache.get(favedKey)?.hash ?? BigInt(0) })).catch(() => null),
    ]);
    if (allResult?.className !== 'messages.AllStickersNotModified') {
      listCache.set(setsKey, {
        hash: allResult?.hash ?? BigInt(0),
        value: (allResult?.sets || []).filter(isRegularStickerSet).map((set: any) => ({ ...toStickerSetInfo(set), installed: !set.archived })),
      });
    }
    if (recentResult && recentResult.className !== 'messages.RecentStickersNotModified') {
      listCache.set(recentKey, { hash: recentResult.hash ?? BigInt(0), value: rememberDocs(accountId, recentResult.stickers || [], { kind: 'recent' }) });
    }
    if (favedResult && favedResult.className !== 'messages.FavedStickersNotModified') {
      listCache.set(favedKey, { hash: favedResult.hash ?? BigInt(0), value: rememberDocs(accountId, favedResult.stickers || [], { kind: 'faved' }) });
    }
    return {
      success: true,
      sets: listCache.get(setsKey)?.value || [],
      recent: listCache.get(recentKey)?.value || [],
      faved: listCache.get(favedKey)?.value || [],
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Contents of 1 sticker set + whether it is installed (preview before adding, like Telegram's "Add stickers" popup). */
export async function getStickerSet(accountId: string, ref: TelegramStickerSetRef, deps: StickerClientDeps, force = false): Promise<Result<{
  set: TelegramStickerSetInfo; stickers: TelegramStickerItem[];
}>> {
  const { client, Api } = deps;
  try {
    const key = setKey(accountId, ref);
    const cached = force ? undefined : setCache.get(key);
    const result: any = await client.invoke(new Api.messages.GetStickerSet({ stickerset: inputStickerSet(Api, ref), hash: cached?.hash ?? 0 }));
    if (result?.className === 'messages.StickerSetNotModified' && cached) {
      return { success: true, set: cached.set, stickers: cached.stickers };
    }
    const set = toStickerSetInfo(result?.set);
    const stickers = rememberDocs(accountId, result?.documents || [], { kind: 'set', ref: { id: set.id, accessHash: set.accessHash, shortName: set.shortName } });
    const entry = { hash: Number(result?.set?.hash || 0), set, stickers };
    setCache.set(key, entry);
    setCache.set(setKey(accountId, { id: set.id }), entry);
    return { success: true, set, stickers };
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    return { success: false, error: /STICKERSET_INVALID/i.test(message) ? tr('Bộ sticker không còn tồn tại') : message };
  }
}

/** Sticker set of 1 sticker message in the chat (click a sticker → set popup). */
export async function getStickerSetOfMessage(accountId: string, chatId: string, messageId: string, deps: StickerClientDeps): Promise<Result<{
  set: TelegramStickerSetInfo; stickers: TelegramStickerItem[];
}>> {
  try {
    const peer = await deps.resolvePeer(chatId);
    const fetched: any[] = await deps.client.getMessages(peer, { ids: [Number(messageId)] });
    const doc = fetched?.find((m: any) => String(m?.id) === String(messageId))?.media?.document;
    if (!doc) return { success: false, error: tr('Tin nhắn không còn sticker') };
    rememberDocs(accountId, [doc], { kind: 'message', chatId, messageId });
    const attribute = (doc.attributes || []).find((a: any) => a?.className === 'DocumentAttributeSticker');
    const ref = stickerSetRefOf(attribute?.stickerset);
    if (!ref) return { success: false, error: tr('Sticker này không thuộc bộ nào') };
    return getStickerSet(accountId, ref, deps);
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Add / remove a sticker set from the account (synced across all devices). */
export async function setStickerSetInstalled(accountId: string, ref: TelegramStickerSetRef, install: boolean, deps: StickerClientDeps): Promise<Result<{ installed: boolean }>> {
  const { client, Api } = deps;
  try {
    const stickerset = inputStickerSet(Api, ref);
    if (install) await client.invoke(new Api.messages.InstallStickerSet({ stickerset, archived: false }));
    else await client.invoke(new Api.messages.UninstallStickerSet({ stickerset }));
    listCache.delete(`${accountId}:sets`);
    for (const key of [setKey(accountId, ref), ...(ref.id ? [setKey(accountId, { id: ref.id })] : [])]) {
      const entry = setCache.get(key);
      if (entry) entry.set = { ...entry.set, installed: install, archived: false };
    }
    return { success: true, installed: install };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

function toCoveredSets(accountId: string, coveredSets: any[]): TelegramCoveredStickerSet[] {
  const sets: TelegramCoveredStickerSet[] = [];
  for (const covered of coveredSets || []) {
    if (!isRegularStickerSet(covered?.set)) continue;
    const info = toStickerSetInfo(covered.set);
    const docs = covered.className === 'StickerSetCovered' ? [covered.cover]
      : covered.className === 'StickerSetMultiCovered' ? covered.covers || []
        : covered.className === 'StickerSetFullCovered' ? (covered.documents || []).slice(0, 5)
          : [];
    const covers = rememberDocs(accountId, docs.filter(Boolean), { kind: 'set', ref: { id: info.id, accessHash: info.accessHash, shortName: info.shortName } });
    sets.push({ ...info, covers: covers.slice(0, 5) });
  }
  return sets;
}

/** Search sticker sets by name / keyword (like the search box of Telegram's sticker panel). */
export async function searchStickerSets(accountId: string, query: string, deps: StickerClientDeps): Promise<Result<{ sets: TelegramCoveredStickerSet[] }>> {
  const { client, Api } = deps;
  try {
    const result: any = await client.invoke(new Api.messages.SearchStickerSets({ q: String(query || ''), excludeFeatured: false, hash: BigInt(0) }));
    return { success: true, sets: toCoveredSets(accountId, result?.sets || []) };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Trending sticker sets (suggested by Telegram). */
export async function getFeaturedStickerSets(accountId: string, deps: StickerClientDeps): Promise<Result<{ sets: TelegramCoveredStickerSet[] }>> {
  const { client, Api } = deps;
  try {
    const key = `${accountId}:featured`;
    const result: any = await client.invoke(new Api.messages.GetFeaturedStickers({ hash: listCache.get(key)?.hash ?? BigInt(0) }));
    if (result?.className !== 'messages.FeaturedStickersNotModified') {
      listCache.set(key, { hash: result?.hash ?? BigInt(0), value: toCoveredSets(accountId, result?.sets || []) });
    }
    return { success: true, sets: listCache.get(key)?.value || [] };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** The account's saved GIFs. */
export async function getSavedGifs(accountId: string, deps: StickerClientDeps): Promise<Result<{ gifs: TelegramStickerItem[] }>> {
  const { client, Api } = deps;
  try {
    const key = `${accountId}:gifs`;
    const result: any = await client.invoke(new Api.messages.GetSavedGifs({ hash: listCache.get(key)?.hash ?? BigInt(0) }));
    if (result?.className !== 'messages.SavedGifsNotModified') {
      listCache.set(key, { hash: result?.hash ?? BigInt(0), value: rememberDocs(accountId, result?.gifs || [], { kind: 'gifs' }) });
    }
    return { success: true, gifs: listCache.get(key)?.value || [] };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Search GIFs through the @gif inline bot like the Telegram app (empty keyword = trending GIFs); `nextOffset` to load more. */
export async function searchGifs(accountId: string, query: string, offset: string, deps: StickerClientDeps): Promise<Result<{
  gifs: TelegramStickerItem[]; nextOffset: string;
}>> {
  const { client, Api } = deps;
  try {
    const bot = await client.getInputEntity('gif');
    const result: any = await client.invoke(new Api.messages.GetInlineBotResults({
      bot, peer: new Api.InputPeerSelf(), query: String(query || ''), offset: String(offset || ''),
    }));
    const docs = (result?.results || []).map((item: any) => item?.document).filter(Boolean);
    const gifs = rememberDocs(accountId, docs, { kind: 'gifSearch', query: String(query || ''), offset: String(offset || '') });
    return { success: true, gifs, nextOffset: String(result?.nextOffset || '') };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Custom emoji by id (forum topic icons): the Document is remembered in the cache like a sticker so the file can be downloaded (getStickerFile) and
 * fetched again when its fileReference expires. An id already in the cache does not call Telegram; an id that no longer exists is left out of the
 * result.
 */
export async function getCustomEmojiItems(
  accountId: string,
  docIds: string[],
  deps: Pick<StickerClientDeps, 'client' | 'Api'>,
): Promise<Map<string, TelegramStickerItem>> {
  const items = new Map<string, TelegramStickerItem>();
  const missing: string[] = [];
  for (const id of new Set(docIds.map(String).filter((id) => /^\d+$/.test(id)))) {
    const cached = cachedDoc(accountId, id);
    const item = cached ? toStickerItem(cached.doc) : null;
    if (item) items.set(id, item);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const docs: any[] = await deps.client.invoke(new deps.Api.messages.GetCustomEmojiDocuments({ documentId: missing.map((id) => BigInt(id)) }));
    for (const item of rememberDocs(accountId, Array.isArray(docs) ? docs : [], { kind: 'customEmoji' })) items.set(item.id, item);
  }
  return items;
}

/** Fetch a Document again from its source (fileReference expired). */
async function refreshDoc(accountId: string, docId: string, deps: StickerClientDeps): Promise<any | null> {
  const entry = cachedDoc(accountId, docId);
  if (!entry) return null;
  const source = entry.source;
  if (source.kind === 'set') await getStickerSet(accountId, source.ref, deps, true);
  else if (source.kind === 'customEmoji') {
    const docs: any[] = await deps.client.invoke(new deps.Api.messages.GetCustomEmojiDocuments({ documentId: [BigInt(docId)] }));
    rememberDocs(accountId, Array.isArray(docs) ? docs : [], source);
  } else if (source.kind === 'recent' || source.kind === 'faved') {
    listCache.delete(`${accountId}:${source.kind}`);
    await getStickerPanel(accountId, deps);
  } else if (source.kind === 'gifs') {
    listCache.delete(`${accountId}:gifs`);
    await getSavedGifs(accountId, deps);
  } else if (source.kind === 'gifSearch') await searchGifs(accountId, source.query, source.offset, deps);
  else if (source.kind === 'message') {
    const peer = await deps.resolvePeer(source.chatId);
    const fetched: any[] = await deps.client.getMessages(peer, { ids: [Number(source.messageId)] });
    const doc = fetched?.find((m: any) => String(m?.id) === source.messageId)?.media?.document;
    if (doc) rememberDocs(accountId, [doc], source);
  }
  const fresh = cachedDoc(accountId, docId);
  return fresh && fresh.doc !== entry.doc ? fresh.doc : null;
}

// ── Load images for the grid ─────────────────────────────────────────────────────────────────────────────────────────────

const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_DEADLINE_MS = 30_000;
let activeDownloads = 0;
const downloadWaiters: Array<() => void> = [];
const fileInflight = new Map<string, Promise<Result<{ localPath: string; kind: StickerFileKind }>>>();

async function withDownloadSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeDownloads >= DOWNLOAD_CONCURRENCY) await new Promise<void>((resolve) => downloadWaiters.push(resolve));
  activeDownloads++;
  try {
    return await run();
  } finally {
    activeDownloads--;
    downloadWaiters.shift()?.();
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TELEGRAM_STICKER_DOWNLOAD_TIMEOUT')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * A file downloaded earlier, when the Document is not in this session's cache (the app just opened, not connected yet): `thumb` takes the
 * static image `_t` or the whole file (a Document has no static image), `full` takes only the whole file.
 */
export function stickerFileOnDisk(baseDir: string, accountId: string, docId: string, variant: 'thumb' | 'full'): {
  localPath: string; kind: StickerFileKind;
} | null {
  const id = String(docId || '').replace(/[^0-9a-z_-]/gi, '');
  if (!baseDir || !id) return null;
  const dir = path.join(baseDir, accountId, 'stickers');
  for (const baseName of variant === 'thumb' ? [`tg_${id}_t`, `tg_${id}`] : [`tg_${id}`]) {
    for (const ext of KNOWN_EXTS) {
      const localPath = path.join(dir, baseName + ext);
      if (fs.existsSync(localPath)) return { localPath, kind: fileKindOfExt(ext) };
    }
  }
  return null;
}

/**
 * File to draw a sticker / GIF: `thumb` = small static image for the grid (if none, the whole file: tgs, a few tens of KB); `full` = the whole file
 * (GIF / video sticker played on hover). If it is already on disk, return it at once.
 */
export function getStickerFile(accountId: string, docId: string, variant: 'thumb' | 'full', deps: StickerClientDeps): Promise<Result<{
  localPath: string; kind: StickerFileKind;
}>> {
  const key = `${accountId}:${docId}:${variant}`;
  const running = fileInflight.get(key);
  if (running) return running;
  const task = (async (): Promise<Result<{ localPath: string; kind: StickerFileKind }>> => {
    const entry = cachedDoc(accountId, docId);
    if (!entry) {
      const onDisk = stickerFileOnDisk(deps.baseDir, accountId, docId, variant);
      return onDisk ? { success: true, ...onDisk } : { success: false, error: 'STICKER_NOT_CACHED' };
    }
    const thumb = variant === 'thumb' ? pickStickerThumb(entry.doc) : null;
    const dir = path.join(deps.baseDir, accountId, 'stickers');
    const baseName = `tg_${String(docId).replace(/[^0-9a-z_-]/gi, '')}${thumb ? '_t' : ''}`;
    for (const ext of KNOWN_EXTS) {
      const existing = path.join(dir, baseName + ext);
      if (fs.existsSync(existing)) return { success: true, localPath: existing, kind: fileKindOfExt(ext) };
    }
    const download = (doc: any) => withDownloadSlot(() => withDeadline<any>(
      deps.client.downloadMedia(doc, thumb ? { thumb: pickStickerThumb(doc) || thumb } : {}),
      DOWNLOAD_DEADLINE_MS,
    ));
    let data: any;
    try {
      data = await download(entry.doc);
    } catch (err) {
      if (!isFileReferenceError(err)) throw err;
      const fresh = await refreshDoc(accountId, docId, deps);
      if (!fresh) throw err;
      data = await download(fresh);
    }
    if (!data || (typeof data !== 'string' && data.length === 0)) return { success: false, error: tr('Không tải được sticker') };
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ext = detectFileExt(buffer, thumb ? '.webp' : FULL_EXT[stickerFormatOf(entry.doc)]);
    await fs.promises.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, baseName + ext);
    await writeMediaFile(localPath, buffer);
    return { success: true, localPath, kind: fileKindOfExt(ext) };
  })().catch((err: any) => ({ success: false as const, error: err?.message || String(err) }))
    .finally(() => { fileInflight.delete(key); });
  fileInflight.set(key, task);
  return task;
}

// ── Send ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Send a sticker / GIF already in the cache (taken from the panel / a set / a search). The sent message is saved and shown via `persistSent`. Like the
 * Telegram app: a sticker just sent goes to "gần đây" (recent), a GIF just sent goes to "GIF đã lưu" (saved GIFs).
 */
export async function sendStickerDocument(
  accountId: string,
  chatId: string,
  docId: string,
  options: { replyToMsgId?: string; topicRootId?: string },
  deps: StickerClientDeps,
): Promise<Result<{ messageId: string }>> {
  const entry = cachedDoc(accountId, docId);
  if (!entry) return { success: false, error: 'STICKER_NOT_CACHED' };
  try {
    const peer = await deps.resolvePeer(chatId);
    const numeric = (value?: string) => (value && /^\d+$/.test(value) ? Number(value) : undefined);
    const replyToMsgId = numeric(options.replyToMsgId);
    const topicRootId = numeric(options.topicRootId);
    // Forum topic: "trả lời" (reply) to the topic's root message; replying to a message inside the topic includes topMsgId
    const replyOptions = replyToMsgId
      ? { replyTo: replyToMsgId, ...(topicRootId && topicRootId !== replyToMsgId ? { topMsgId: topicRootId } : {}) }
      : topicRootId ? { replyTo: topicRootId } : {};
    const send = (doc: any) => deps.client.sendFile(peer, { file: doc, ...replyOptions });
    let doc = entry.doc;
    let message: any;
    try {
      message = await send(doc);
    } catch (err) {
      if (!isFileReferenceError(err)) throw err;
      const fresh = await refreshDoc(accountId, docId, deps);
      if (!fresh) throw err;
      doc = fresh;
      message = await send(doc);
    }
    if (message) await deps.persistSent(message).catch(() => {});
    // Goes into the account's "gần đây" (recent) / "GIF đã lưu" (saved GIFs) lists: runs in the background, after the message is sent
    const { Api } = deps;
    const inputDocument = new Api.InputDocument({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference });
    const isGif = stickerFormatOf(doc) === 'gif';
    const save = isGif
      ? new Api.messages.SaveGif({ id: inputDocument, unsave: false })
      : new Api.messages.SaveRecentSticker({ id: inputDocument, unsave: false });
    Promise.resolve(deps.client.invoke(save))
      .catch(() => {})
      .finally(() => { listCache.delete(`${accountId}:${isGif ? 'gifs' : 'recent'}`); });
    return { success: true, messageId: String(message?.id || '') };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

const MAX_SETS_SCAN = 60;

/**
 * Find a Document by id for callers that only have the id (workflow `tg.sendSticker`, API): cache → recent / favourites → saved GIFs → the
 * installed sets (each set once per session, thanks to the hash).
 */
export async function ensureStickerCached(accountId: string, docId: string, deps: StickerClientDeps): Promise<boolean> {
  const id = String(docId || '');
  if (!id) return false;
  if (cachedDoc(accountId, id)) return true;
  const panel = await getStickerPanel(accountId, deps);
  if (cachedDoc(accountId, id)) return true;
  await getSavedGifs(accountId, deps);
  if (cachedDoc(accountId, id)) return true;
  if (!panel.success) return false;
  for (const set of panel.sets.slice(0, MAX_SETS_SCAN)) {
    await getStickerSet(accountId, { id: set.id, accessHash: set.accessHash, shortName: set.shortName }, deps);
    if (cachedDoc(accountId, id)) return true;
  }
  return false;
}

/** Save / unsave a GIF (synced to the account). */
export async function setGifSaved(accountId: string, docId: string, saved: boolean, deps: StickerClientDeps): Promise<Result<{ saved: boolean }>> {
  const entry = cachedDoc(accountId, docId);
  if (!entry) return { success: false, error: 'STICKER_NOT_CACHED' };
  const { Api } = deps;
  try {
    const doc = entry.doc;
    await deps.client.invoke(new Api.messages.SaveGif({
      id: new Api.InputDocument({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference }),
      unsave: !saved,
    }));
    listCache.delete(`${accountId}:gifs`);
    return { success: true, saved };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
