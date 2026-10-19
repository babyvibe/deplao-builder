import * as fs from 'fs';
import * as path from 'path';
import type {
  TelegramCoveredStickerSet,
  TelegramStickerFileKind,
  TelegramStickerFormat,
  TelegramStickerItem,
  TelegramStickerSetInfo,
  TelegramStickerSetRef,
} from '../../shared/telegramStickers';

export type { TelegramCoveredStickerSet, TelegramStickerFormat, TelegramStickerItem, TelegramStickerSetInfo, TelegramStickerSetRef };

/**
 * Sticker & GIF Telegram (tài khoản cá nhân) — dữ liệu ĐỒNG BỘ với tài khoản: bộ sticker đã cài, sticker gần đây /
 * yêu thích, GIF đã lưu (thêm / gỡ ở đây thì app Telegram khác cũng thấy).
 *
 * - Mọi Document lấy về được giữ trong bộ đệm theo tài khoản KÈM NGUỒN (bộ / gần đây / yêu thích / GIF / tìm GIF / tin
 *   nhắn): gửi và tải cần fileReference còn hạn — hết hạn (FILE_REFERENCE_*) thì lấy lại từ nguồn rồi thử lại 1 lần.
 * - Danh sách dùng `hash` của Telegram (NotModified → dùng lại bản đã có, không tải lại).
 * - Ảnh cho lưới: thumbnail tĩnh (webp / jpg) nếu có, không thì cả file (tgs nhỏ); tải song song tối đa 3, có hạn giờ,
 *   lưu đĩa `<media>/<tài khoản>/stickers/` — KHÔNG đi qua hàng đợi tải media tuần tự của khung chat.
 * - Tìm GIF = inline bot @gif (như app Telegram). `messages.getGifs / searchGifs` không có trong API.
 */

export interface StickerClientDeps {
  client: any;
  Api: any;
  resolvePeer: (chatId: string) => Promise<any>;
  /** Lưu + hiện tin vừa gửi (cùng đường với tin của mình gửi từ thiết bị khác). */
  persistSent: (message: any) => Promise<void>;
  /** Thư mục media (FileStorageService.getBaseDir()). */
  baseDir: string;
}

type StickerSource =
  | { kind: 'set'; ref: TelegramStickerSetRef }
  | { kind: 'recent' }
  | { kind: 'faved' }
  | { kind: 'gifs' }
  | { kind: 'gifSearch'; query: string; offset: string }
  | { kind: 'message'; chatId: string; messageId: string };

type Result<T> = ({ success: true } & T) | { success: false; error: string };

/** id / access hash 64 bit (BigInteger của GramJS): String() = toString() đủ chữ số — valueOf() ra Number, mất chính xác. */
const toId = (value: any): string => (value == null ? '' : String(value));

// ── Hàm thuần ───────────────────────────────────────────────────────────────────────────────────────────────────────

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
  const sticker = attributes.find((a) => a?.className === 'DocumentAttributeSticker');
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

/** Bộ sticker thật (không phải bộ emoji tuỳ chỉnh / mặt nạ). */
export function isRegularStickerSet(set: any): boolean {
  return !!set && !set.emojis && !set.masks;
}

/** Thumbnail tĩnh để vẽ lưới: ảnh cỡ 'm' (≈ 128–320 px) nếu có, không thì ảnh lớn nhất ≤ 512 px. */
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

// ── Bộ đệm ─────────────────────────────────────────────────────────────────────────────────────────────────────────

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

/** Chỉ dùng trong test. */
export function __resetTelegramStickerCaches(): void {
  docsByAccount.clear();
  listCache.clear();
  setCache.clear();
  fileInflight.clear();
}

function inputStickerSet(Api: any, ref: TelegramStickerSetRef): any {
  if (ref.id && ref.accessHash) return new Api.InputStickerSetID({ id: BigInt(ref.id), accessHash: BigInt(ref.accessHash) });
  if (ref.shortName) return new Api.InputStickerSetShortName({ shortName: ref.shortName });
  throw new Error('Thiếu thông tin bộ sticker');
}

function setKey(accountId: string, ref: TelegramStickerSetRef): string {
  return `${accountId}:${ref.id || `name:${ref.shortName || ''}`}`;
}

// ── Gọi Telegram ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Bộ sticker đã cài (thứ tự của tài khoản) + sticker gần đây + yêu thích. */
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

/** Nội dung 1 bộ sticker + đã cài chưa (xem trước khi thêm, như popup "Add stickers" của Telegram). */
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
    return { success: false, error: /STICKERSET_INVALID/i.test(message) ? 'Bộ sticker không còn tồn tại' : message };
  }
}

/** Bộ sticker của 1 tin sticker trong chat (bấm vào sticker → popup bộ). */
export async function getStickerSetOfMessage(accountId: string, chatId: string, messageId: string, deps: StickerClientDeps): Promise<Result<{
  set: TelegramStickerSetInfo; stickers: TelegramStickerItem[];
}>> {
  try {
    const peer = await deps.resolvePeer(chatId);
    const fetched: any[] = await deps.client.getMessages(peer, { ids: [Number(messageId)] });
    const doc = fetched?.find((m: any) => String(m?.id) === String(messageId))?.media?.document;
    if (!doc) return { success: false, error: 'Tin nhắn không còn sticker' };
    rememberDocs(accountId, [doc], { kind: 'message', chatId, messageId });
    const attribute = (doc.attributes || []).find((a: any) => a?.className === 'DocumentAttributeSticker');
    const ref = stickerSetRefOf(attribute?.stickerset);
    if (!ref) return { success: false, error: 'Sticker này không thuộc bộ nào' };
    return getStickerSet(accountId, ref, deps);
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Thêm / gỡ bộ sticker khỏi tài khoản (đồng bộ mọi thiết bị). */
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

/** Tìm bộ sticker theo tên / từ khoá (như ô tìm của bảng sticker Telegram). */
export async function searchStickerSets(accountId: string, query: string, deps: StickerClientDeps): Promise<Result<{ sets: TelegramCoveredStickerSet[] }>> {
  const { client, Api } = deps;
  try {
    const result: any = await client.invoke(new Api.messages.SearchStickerSets({ q: String(query || ''), excludeFeatured: false, hash: BigInt(0) }));
    return { success: true, sets: toCoveredSets(accountId, result?.sets || []) };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Bộ sticker thịnh hành (Telegram gợi ý). */
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

/** GIF đã lưu của tài khoản. */
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

/** Tìm GIF qua inline bot @gif (như app Telegram); `nextOffset` để tải tiếp. */
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

/** Lấy lại Document từ nguồn của nó (fileReference hết hạn). */
async function refreshDoc(accountId: string, docId: string, deps: StickerClientDeps): Promise<any | null> {
  const entry = cachedDoc(accountId, docId);
  if (!entry) return null;
  const source = entry.source;
  if (source.kind === 'set') await getStickerSet(accountId, source.ref, deps, true);
  else if (source.kind === 'recent' || source.kind === 'faved') {
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

// ── Tải ảnh cho lưới ───────────────────────────────────────────────────────────────────────────────────────────────

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
 * File để vẽ sticker / GIF: `thumb` = ảnh tĩnh nhỏ cho lưới (không có thì cả file — tgs vài chục KB); `full` = cả file
 * (GIF / sticker video phát khi rê chuột). Có trên đĩa rồi thì trả ngay.
 */
export function getStickerFile(accountId: string, docId: string, variant: 'thumb' | 'full', deps: StickerClientDeps): Promise<Result<{
  localPath: string; kind: StickerFileKind;
}>> {
  const key = `${accountId}:${docId}:${variant}`;
  const running = fileInflight.get(key);
  if (running) return running;
  const task = (async (): Promise<Result<{ localPath: string; kind: StickerFileKind }>> => {
    const entry = cachedDoc(accountId, docId);
    if (!entry) return { success: false, error: 'STICKER_NOT_CACHED' };
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
    if (!data || (typeof data !== 'string' && data.length === 0)) return { success: false, error: 'Không tải được sticker' };
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ext = detectFileExt(buffer, thumb ? '.webp' : FULL_EXT[stickerFormatOf(entry.doc)]);
    fs.mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, baseName + ext);
    fs.writeFileSync(localPath, buffer);
    return { success: true, localPath, kind: fileKindOfExt(ext) };
  })().catch((err: any) => ({ success: false as const, error: err?.message || String(err) }))
    .finally(() => { fileInflight.delete(key); });
  fileInflight.set(key, task);
  return task;
}

// ── Gửi ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Gửi sticker / GIF đã có trong bộ đệm (lấy từ bảng / bộ / tìm kiếm). Tin gửi đi lưu + hiện qua `persistSent`. Như app
 * Telegram: sticker vừa gửi vào "gần đây", GIF vừa gửi vào "GIF đã lưu".
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
    // Chủ đề forum: tin "trả lời" gốc chủ đề; trả lời 1 tin trong chủ đề thì kèm topMsgId
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
    // Vào "gần đây" / "GIF đã lưu" của tài khoản — chạy nền, tin đã gửi xong
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
 * Tìm Document theo id cho nơi gọi chỉ có id (workflow `tg.sendSticker`, API): bộ đệm → gần đây / yêu thích → GIF đã
 * lưu → các bộ đã cài (mỗi bộ 1 lần / phiên nhờ hash).
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

/** Lưu / bỏ lưu GIF (đồng bộ tài khoản). */
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
