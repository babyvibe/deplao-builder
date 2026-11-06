import * as path from 'path';

/**
 * Sửa ảnh của một tin (file:repairImage — bong bóng chat, trình xem ảnh, quét khi mở hội thoại): tải lại từ CDN bằng
 * phiên của tài khoản, kiểm tra file, cập nhật DB + báo giao diện.
 *
 * - MỘT lượt cho mỗi tin: các nơi gọi cùng lúc dùng chung kết quả. Trước đây khoá theo đường dẫn file (bong bóng / trình
 *   xem ảnh) hoặc theo mã tin (quét khi mở hội thoại) → cùng một ảnh tải song song nhiều lần, mỗi lần đổi local_paths.
 * - Tải xong + file đọc được rồi mới bỏ file cũ. Trước đây xoá file cũ TRƯỚC khi tải: tải lỗi (mạng chập chờn) → DB vẫn
 *   trỏ vào file đã xoá → mọi chỗ hiện ảnh đó lỗi → lại sửa → hết lượt → "Không tải được ảnh".
 * - Chỉ xoá file nằm trong thư mục media của app (ảnh mình gửi có thể trỏ vào file gốc của người dùng).
 */

export interface ImageRepairParams {
  zaloId: string;
  msgId: string;
  threadId?: string;
  localPath?: string;
  remoteUrl?: string;
  /** true = bỏ qua cờ "đã hết hạn" (người dùng bấm Thử tải lại) */
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
  /** local_paths hiện tại của tin (main / hd), thread, link ảnh trong content; loại tin + kênh (ensureMessageImage) */
  messageInfo(zaloId: string, msgId: string): { localPath: string; threadId: string; imageUrl: string; msgType?: string; channel?: string };
  account(zaloId: string): { cookies?: string; user_agent?: string } | undefined;
  /** FileStorageService.downloadImage: đường dẫn tương đối, '' khi CDN trả 401/403/409/410; ném khi lỗi khác */
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
  /** true = bỏ qua cờ "đã hết hạn" (người dùng bấm Thử tải lại) */
  force?: boolean;
}

export interface ImageEnsureResult extends ImageRepairResult {
  /** File đã có sẵn trên máy, không tải lại */
  cached?: boolean;
  /** Lỗi không đổi khi hỏi lại: không thấy tin / không phải ảnh Zalo / không có link ảnh Zalo */
  code?: 'NOT_FOUND' | 'NOT_ZALO_IMAGE' | 'NO_IMAGE_URL';
}

export interface ImageEnsureDeps extends ImageRepairDeps {
  /** Link thuộc CDN Zalo — chỉ tải (kèm cookie phiên tài khoản) từ những link này */
  isZaloMediaUrl(url: string): boolean;
  /** File không còn trên máy (đã dọn lên Cloudflare R2) → lấy lại về đúng chỗ cũ; true = đã có lại */
  restoreFromCloud?(absPath: string): Promise<boolean>;
}

/** Loại tin ảnh Zalo (cột msg_type) — ensureMessageImage chỉ tải ảnh của các tin này. */
export const ZALO_PHOTO_MSG_TYPES: ReadonlySet<string> = new Set(['chat.photo', 'photo', 'image']);

const pendingRepairs = new Map<string, Promise<ImageRepairResult>>();

/** Chỉ dùng trong test. */
export function __resetImageRepairs(): void {
  pendingRepairs.clear();
}

/** File nằm trong thư mục media của app (được phép xoá). */
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
  // Đã biết ảnh hết hạn → không gọi mạng nữa (tránh tải lại liên tục mỗi lần render)
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
  // Ảnh JPEG XL của Zalo → bản JPG (Chromium không hiển thị JXL)
  const imgUrl = deps.toJpgUrl(params.remoteUrl || info.imageUrl || '');
  if (!imgUrl) return { success: false, error: 'No image URL available' };

  // Tải bằng session của đúng tài khoản: CDN Zalo có thể trả 403 cho request không mang Cookie / User-Agent
  const account = deps.account(zaloId);
  let newLocalPath = '';
  try {
    newLocalPath = await deps.download(zaloId, imgUrl, account?.cookies, account?.user_agent);
  } catch (downloadErr: any) {
    // CDN trả 404 / host CDN cũ không còn tồn tại → ảnh đã hết hạn
    if (await deps.classifyError(imgUrl, downloadErr) === 'expired') {
      deps.setMediaExpired(zaloId, msgId, true);
      deps.warn(`[imageRepair] ảnh đã hết hạn ${msgId} (${downloadErr?.code || downloadErr?.response?.status || downloadErr?.message})`);
      return { success: false, expired: true, error: 'Media expired' };
    }
    throw downloadErr;
  }
  if (!newLocalPath) {
    // downloadImage trả rỗng khi CDN trả 401/403/409/410 — chỉ 410 là hết hạn thật, 401/403 thường do cookie phiên cũ
    if (await deps.probe(imgUrl, account?.cookies, account?.user_agent) === 'expired') {
      deps.setMediaExpired(zaloId, msgId, true);
      return { success: false, expired: true, error: 'Media expired' };
    }
    return { success: false, error: 'Download returned empty (CDN 401/403/409)' };
  }
  // File tải về phải hiển thị được (vd JPEG XL thì Chromium không đọc được) — không báo thành công cho file lỗi.
  // ('truncated' cho qua: Chromium hiển thị được JPEG thiếu marker kết thúc.)
  const newAbsPath = deps.resolveAbsolutePath(newLocalPath);
  const check = deps.validateImage(newAbsPath);
  if (!check.valid && check.reason !== 'truncated') {
    try { deps.unlink(newAbsPath); } catch { /* đã mất */ }
    deps.warn(`[imageRepair] file tải về không hiển thị được (${check.reason}) ${msgId} ← ${imgUrl}`);
    return { success: false, error: `Ảnh tải về không đọc được (${check.reason})` };
  }
  if (force) deps.setMediaExpired(zaloId, msgId, false);

  deps.saveLocalPath(zaloId, msgId, newLocalPath);
  const threadId = params.threadId || info.threadId;
  if (threadId) deps.emitLocalPath(zaloId, msgId, threadId, newLocalPath);

  // Bỏ file cũ SAU khi đã có file mới: file DB vừa trỏ tới + file nơi gọi đang hiện (có thể khác nhau)
  const newResolved = path.resolve(newAbsPath);
  const baseDir = deps.mediaBaseDir();
  for (const old of new Set([info.localPath, params.localPath].filter(Boolean) as string[])) {
    const oldAbs = deps.resolveAbsolutePath(old);
    if (!oldAbs || path.resolve(oldAbs) === newResolved || !isManagedMediaFile(oldAbs, baseDir) || !deps.exists(oldAbs)) continue;
    try { deps.unlink(oldAbs); } catch { /* đang bị khoá — để lại */ }
  }

  deps.log(`[imageRepair] success: ${msgId} → ${newLocalPath}`);
  return { success: true, newLocalPath };
}

/**
 * Ảnh của một tin Zalo phải có trên máy này (máy Boss) — file:ensureMessageImage.
 *
 * Boss chỉ tự tải ảnh lúc NHẬN tin. Tin vào lúc Boss tắt máy (đồng bộ lịch sử sau đó), tin đồng bộ từ điện thoại, lần tải
 * lỗi… không có bản trên máy: giao diện hiện thẳng link Zalo, link hết hạn là mất ảnh. Máy nhân viên còn không có cookie
 * Zalo, chỉ đọc được ảnh từ máy Boss (/api/media). Nên khi ảnh như vậy hiện ra (trên máy Boss, hoặc máy nhân viên nhờ qua
 * proxy), Boss tải về bằng phiên của tài khoản và lưu local_paths; giao diện đổi sang bản đã lưu.
 *
 * - Đã có file đọc được → trả luôn (`cached`), không gọi mạng; file đã dọn lên R2 → lấy lại từ R2 trước.
 * - Chỉ tin ảnh Zalo, chỉ link trong DB của chính tin đó và chỉ host CDN Zalo: nhân viên gọi qua proxy nên KHÔNG nhận
 *   link / đường dẫn từ nơi gọi (tải link tuỳ ý kèm cookie tài khoản = lộ cookie; đường dẫn tuỳ ý = xoá nhầm file).
 * - Chưa có / file hỏng → repairMessageImage (một lượt mỗi tin, tải xong mới bỏ file cũ, CDN báo hết hạn → media_expired).
 */
export async function ensureMessageImage(params: ImageEnsureParams, deps: ImageEnsureDeps): Promise<ImageEnsureResult> {
  const zaloId = String(params?.zaloId || '');
  const msgId = String(params?.msgId || '');
  if (!zaloId || !msgId) return { success: false, error: 'Missing zaloId or msgId' };
  const info = deps.messageInfo(zaloId, msgId);
  if (!info.threadId) return { success: false, error: 'Không tìm thấy tin nhắn', code: 'NOT_FOUND' };
  if ((info.channel && info.channel !== 'zalo') || !ZALO_PHOTO_MSG_TYPES.has(String(info.msgType || ''))) {
    return { success: false, error: 'Không phải tin ảnh Zalo', code: 'NOT_ZALO_IMAGE' };
  }

  if (info.localPath) {
    const absPath = deps.resolveAbsolutePath(info.localPath);
    let check = deps.validateImage(absPath);
    if (check.reason === 'not_found' && deps.restoreFromCloud) {
      try {
        if (await deps.restoreFromCloud(absPath)) check = deps.validateImage(absPath);
      } catch { /* R2 tắt / lỗi → tải lại từ Zalo */ }
    }
    // 'truncated': Chromium vẫn hiện được JPEG thiếu marker kết thúc (repair cũng cho qua)
    if (check.valid || check.reason === 'truncated') return { success: true, newLocalPath: info.localPath, cached: true };
  }

  if (!deps.isZaloMediaUrl(deps.toJpgUrl(info.imageUrl || ''))) {
    return { success: false, error: 'Tin không có link ảnh Zalo', code: 'NO_IMAGE_URL' };
  }
  return repairMessageImage({ zaloId, msgId, threadId: params.threadId || info.threadId, force: !!params.force }, deps);
}
