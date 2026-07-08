/**
 * employeeMediaSync - Download media từ Boss về local cache khi Employee click.
 *
 * Khi Employee click vào video/file/ảnh trong chat, file chỉ tồn tại trên Boss.
 * Helper này download file từ Boss REST URL → cache local → trả về local path để mở.
 *
 * Dùng MediaCacheService (main process) với resolveUrlSync để chờ download hoàn tất.
 */

import ipc from './ipc';
import { toLocalMediaUrl } from './localMedia';

export interface EmployeeMediaResult {
  localPath: string;
  displayUrl: string;
  fromCache: boolean;
}

/**
 * Ensure a media file is available locally on the Employee machine.
 * If cached → return immediately. If not → download from Boss → cache → return.
 *
 * @param bossUrl - Boss REST URL của file (từ toLocalMediaUrl hoặc CDN URL)
 * @param mediaType - Loại media: 'image' | 'video' | 'file'
 * @returns { localPath, displayUrl, fromCache }
 */
export async function ensureMediaLocal(
  bossUrl: string,
  mediaType: 'image' | 'video' | 'file' = 'image',
): Promise<EmployeeMediaResult> {
  if (!bossUrl) {
    return { localPath: '', displayUrl: '', fromCache: false };
  }

  // Nếu đã là file:// URL → local sẵn rồi
  if (bossUrl.startsWith('file://')) {
    const localPath = fileUrlToPath(bossUrl);
    return { localPath, displayUrl: bossUrl, fromCache: true };
  }

  // Nếu không phải http (local path raw) → convert qua Boss URL
  const resolvedUrl = bossUrl.startsWith('http')
    ? bossUrl
    : toLocalMediaUrl(bossUrl);

  if (!resolvedUrl || resolvedUrl.startsWith('local-media://')) {
    // Không thể convert → không có Boss URL (standalone/Boss mode)
    return { localPath: '', displayUrl: bossUrl, fromCache: false };
  }

  // Gọi IPC để download + cache
  try {
    const result = await ipc.file?.ensureMediaLocal(resolvedUrl, mediaType);
    if (result?.success && result.displayUrl) {
      if (result.displayUrl.startsWith('file://')) {
        return {
          localPath: result.localPath || fileUrlToPath(result.displayUrl),
          displayUrl: result.displayUrl,
          fromCache: result.fromCache || false,
        };
      }
      // Không phải file:// URL → trả về display URL (boss URL hoặc CDN)
      return {
        localPath: result.localPath || '',
        displayUrl: result.displayUrl,
        fromCache: result.fromCache || false,
      };
    }
  } catch {
    // Fallback: trả về URL gốc
  }

  return { localPath: '', displayUrl: resolvedUrl, fromCache: false };
}

/**
 * Chuyển đổi file:// URL thành đường dẫn local.
 */
function fileUrlToPath(fileUrl: string): string {
  if (!fileUrl.startsWith('file://')) return fileUrl;

  let path = fileUrl.replace('file:///', '');
  // Windows: decode và bỏ leading slash nếu có
  path = decodeURIComponent(path);
  if (process.platform === 'win32' && path.startsWith('/')) {
    path = path.slice(1);
  }
  return path;
}
