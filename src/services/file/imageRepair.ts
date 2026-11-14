import * as path from 'path';
import { tr } from '../../shared/i18n';

/**
 * Repairs the image of a message (file:repairImage: chat bubble, image viewer, scan when opening a conversation): re-downloads it from the CDN with the account's session,
 * checks the file, updates the DB and notifies the UI.
 *
 * - ONE run per message: concurrent callers share the same result. Previously the lock was keyed on the file path (bubble / image viewer)
 *   or the message ID (scan when opening a conversation), so the same image was downloaded in parallel several times, each time changing local_paths.
 * - Delete the old file only after the download succeeds and the file can be read. Previously the old file was deleted BEFORE downloading: a failed download (flaky network) left the DB
 *   pointing at a deleted file → every place showing that image errored → repaired again → the attempts ran out → "Không tải được ảnh" (Cannot load image).
 * - Only delete files inside the app's media folder (an image you sent may point at the user's original file).
 */

export interface ImageRepairParams {
  zaloId: string;
  msgId: string;
  threadId?: string;
  localPath?: string;
  remoteUrl?: string;
  /** true = ignore the "đã hết hạn" (expired) flag (the user clicked retry) */
  force?: boolean;
}

export interface ImageRepairResult {
  success: boolean;
  newLocalPath?: string;
  expired?: boolean;
  error?: string;
}

export interface ImageRepairDeps {
  isMediaExpired(zaloId: string, msgId: string): boolean;
  setMediaExpired(zaloId: string, msgId: string, expired: boolean): void;
  /** The message's current local_paths (main / hd), thread, and image links in the content; message type + channel (ensureMessageImage) */
  messageInfo(zaloId: string, msgId: string): { localPath: string; threadId: string; imageUrl: string; msgType?: string; channel?: string };
  account(zaloId: string): { cookies?: string; user_agent?: string } | undefined;
  /** FileStorageService.downloadImage: relative path, '' when the CDN returns 401/403/409/410; throws on other errors */
  download(zaloId: string, url: string, cookies?: string, userAgent?: string): Promise<string>;
  toJpgUrl(url: string): string;
  resolveAbsolutePath(relOrAbs: string): string;
  validateImage(absPath: string): { valid: boolean; reason?: string };
  mediaBaseDir(): string;
  saveLocalPath(zaloId: string, msgId: string, relPath: string): void;
  emitLocalPath(zaloId: string, msgId: string, threadId: string, relPath: string): void;
  classifyError(url: string, err: any): Promise<'ok' | 'expired' | 'unknown'>;
  probe(url: string, cookies?: string, userAgent?: string): Promise<'ok' | 'expired' | 'unknown'>;
  exists(absPath: string): boolean;
  unlink(absPath: string): void;
  log(message: string): void;
  warn(message: string): void;
}

export interface ImageEnsureParams {
  zaloId: string;
  msgId: string;
  threadId?: string;
  /** true = ignore the "đã hết hạn" (expired) flag (the user clicked retry) */
  force?: boolean;
}

export interface ImageEnsureResult extends ImageRepairResult {
  /** The file already exists on this machine, do not download it again */
  cached?: boolean;
  /** Errors that do not change when asked again: message not found / not a Zalo image / no Zalo image link */
  code?: 'NOT_FOUND' | 'NOT_ZALO_IMAGE' | 'NO_IMAGE_URL';
}

export interface ImageEnsureDeps extends ImageRepairDeps {
  /** Link belongs to the Zalo CDN: only download (with the account session cookie) from these links */
  isZaloMediaUrl(url: string): boolean;
  /** File is no longer on this machine (moved to Cloudflare R2) → fetch it back to the same place; true = it is back */
  restoreFromCloud?(absPath: string): Promise<boolean>;
}

/** Zalo image message type (msg_type column): ensureMessageImage only downloads images of these messages. */
export const ZALO_PHOTO_MSG_TYPES: ReadonlySet<string> = new Set(['chat.photo', 'photo', 'image']);

const pendingRepairs = new Map<string, Promise<ImageRepairResult>>();

/** Used in tests only. */
export function __resetImageRepairs(): void {
  pendingRepairs.clear();
}

/** File is inside the app's media folder (allowed to delete). */
export function isManagedMediaFile(absPath: string, mediaBaseDir: string): boolean {
  if (!absPath || !mediaBaseDir) return false;
  const base = path.resolve(mediaBaseDir);
  const target = path.resolve(absPath);
  const rel = path.relative(base, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function repairMessageImage(params: ImageRepairParams, deps: ImageRepairDeps): Promise<ImageRepairResult> {
  const { zaloId, msgId, force } = params;
  if (!zaloId || !msgId) return Promise.resolve({ success: false, error: 'Missing zaloId or msgId' });
  // Image already known to be expired → no more network calls (avoids re-downloading on every render)
  if (!force && deps.isMediaExpired(zaloId, msgId)) return Promise.resolve({ success: false, expired: true, error: 'Media expired' });

  const key = `${zaloId}:${msgId}`;
  const running = pendingRepairs.get(key);
  if (running) return running;
  const task = runRepair(params, deps)
    .catch((error: any): ImageRepairResult => {
      deps.warn(`[imageRepair] ${msgId}: ${error?.message || error}`);
      return { success: false, error: error?.message || String(error) };
    })
    .finally(() => { pendingRepairs.delete(key); });
  pendingRepairs.set(key, task);
  return task;
}

async function runRepair(params: ImageRepairParams, deps: ImageRepairDeps): Promise<ImageRepairResult> {
  const { zaloId, msgId, force } = params;
  const info = deps.messageInfo(zaloId, msgId);
  // Zalo's JPEG XL image → JPG version (Chromium cannot display JXL)
  const imgUrl = deps.toJpgUrl(params.remoteUrl || info.imageUrl || '');
  if (!imgUrl) return { success: false, error: 'No image URL available' };

  // Download with the session of the correct account: Zalo's CDN may return 403 for a request without the Cookie / User-Agent
  const account = deps.account(zaloId);
  let newLocalPath = '';
  try {
    newLocalPath = await deps.download(zaloId, imgUrl, account?.cookies, account?.user_agent);
  } catch (downloadErr: any) {
    // CDN returns 404 / the old CDN host no longer exists → the image has expired
    if (await deps.classifyError(imgUrl, downloadErr) === 'expired') {
      deps.setMediaExpired(zaloId, msgId, true);
      deps.warn(`[imageRepair] ảnh đã hết hạn ${msgId} (${downloadErr?.code || downloadErr?.response?.status || downloadErr?.message})`);
      return { success: false, expired: true, error: 'Media expired' };
    }
    throw downloadErr;
  }
  if (!newLocalPath) {
    // downloadImage returns empty when the CDN returns 401/403/409/410: only 410 is truly expired; 401/403 are usually an old session cookie
    if (await deps.probe(imgUrl, account?.cookies, account?.user_agent) === 'expired') {
      deps.setMediaExpired(zaloId, msgId, true);
      return { success: false, expired: true, error: 'Media expired' };
    }
    return { success: false, error: 'Download returned empty (CDN 401/403/409)' };
  }
  // The downloaded file must be displayable (e.g. JPEG XL cannot be read by Chromium): do not report success for a broken file.
  // ('truncated' is allowed: Chromium can display a JPEG missing its end marker.)
  const newAbsPath = deps.resolveAbsolutePath(newLocalPath);
  const check = deps.validateImage(newAbsPath);
  if (!check.valid && check.reason !== 'truncated') {
    try { deps.unlink(newAbsPath); } catch { /* file is gone */ }
    deps.warn(`[imageRepair] file tải về không hiển thị được (${check.reason}) ${msgId} ← ${imgUrl}`);
    return { success: false, error: tr('Ảnh tải về không đọc được ({{reason}})', { reason: check.reason }) };
  }
  if (force) deps.setMediaExpired(zaloId, msgId, false);

  deps.saveLocalPath(zaloId, msgId, newLocalPath);
  const threadId = params.threadId || info.threadId;
  if (threadId) deps.emitLocalPath(zaloId, msgId, threadId, newLocalPath);

  // Delete the old file only AFTER the new file exists: the file the DB just pointed to + the file the caller is showing (they may differ)
  const newResolved = path.resolve(newAbsPath);
  const baseDir = deps.mediaBaseDir();
  for (const old of new Set([info.localPath, params.localPath].filter(Boolean) as string[])) {
    const oldAbs = deps.resolveAbsolutePath(old);
    if (!oldAbs || path.resolve(oldAbs) === newResolved || !isManagedMediaFile(oldAbs, baseDir) || !deps.exists(oldAbs)) continue;
    try { deps.unlink(oldAbs); } catch { /* locked, keep it */ }
  }

  deps.log(`[imageRepair] success: ${msgId} → ${newLocalPath}`);
  return { success: true, newLocalPath };
}

/**
 * A Zalo message's image must exist on this machine (Boss machine): file:ensureMessageImage.
 *
 * Boss only auto-downloads images when a message is RECEIVED. Messages that arrived while Boss's machine was off (history synced afterwards), messages synced from the phone, failed downloads… have no local copy: the UI shows the Zalo link directly, and once it expires the image is gone. Employee machines have no Zalo cookies and can only read images from the Boss machine (/api/media). So when such an image appears (on the Boss machine, or on an employee machine via the proxy), Boss downloads it with the account's session and saves local_paths; the UI switches to the saved copy.
 *
 * - If a readable file already exists → return it right away (`cached`), no network call; a file already moved to R2 is fetched back from R2 first.
 * - Only Zalo image messages, only the link in the message's own DB row, and only Zalo CDN hosts: employees call through the proxy, so NO link / path is accepted from the caller (downloading an arbitrary link with the account cookie = cookie leak; an arbitrary path = deleting the wrong file).
 * - Missing / corrupt file → repairMessageImage (one run per message; the old file is deleted only after the download succeeds; the CDN says expired → media_expired).
 */
export async function ensureMessageImage(params: ImageEnsureParams, deps: ImageEnsureDeps): Promise<ImageEnsureResult> {
  const zaloId = String(params?.zaloId || '');
  const msgId = String(params?.msgId || '');
  if (!zaloId || !msgId) return { success: false, error: 'Missing zaloId or msgId' };
  const info = deps.messageInfo(zaloId, msgId);
  if (!info.threadId) return { success: false, error: tr('Không tìm thấy tin nhắn'), code: 'NOT_FOUND' };
  if ((info.channel && info.channel !== 'zalo') || !ZALO_PHOTO_MSG_TYPES.has(String(info.msgType || ''))) {
    return { success: false, error: tr('Không phải tin ảnh Zalo'), code: 'NOT_ZALO_IMAGE' };
  }

  if (info.localPath) {
    const absPath = deps.resolveAbsolutePath(info.localPath);
    let check = deps.validateImage(absPath);
    if (check.reason === 'not_found' && deps.restoreFromCloud) {
      try {
        if (await deps.restoreFromCloud(absPath)) check = deps.validateImage(absPath);
      } catch { /* R2 off / error → re-download from Zalo */ }
    }
    // 'truncated': Chromium still displays a JPEG missing its end marker (repair also allows it)
    if (check.valid || check.reason === 'truncated') return { success: true, newLocalPath: info.localPath, cached: true };
  }

  if (!deps.isZaloMediaUrl(deps.toJpgUrl(info.imageUrl || ''))) {
    return { success: false, error: tr('Tin không có link ảnh Zalo'), code: 'NO_IMAGE_URL' };
  }
  return repairMessageImage({ zaloId, msgId, threadId: params.threadId || info.threadId, force: !!params.force }, deps);
}
