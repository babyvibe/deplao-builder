/**
 * Convert absolute local file path → local-media:// URL or boss REST URL.
 *
 * - Standalone/Boss mode: dùng local-media:// (Electron custom protocol)
 * - Employee mode: dùng boss /api/media/ URL
 *
 * Usage:
 *   <img src={toLocalMediaUrl(filePath, zaloId)} />
 */

import { useEmployeeStore } from '../../store/employee/employeeStore';

function getBossBaseUrl(): string {
  try {
    return useEmployeeStore.getState().bossUrl || '';
  } catch {
    return '';
  }
}

export function toLocalMediaUrl(filePath: string, zaloId?: string): string {
  if (!filePath) return '';

  // Already a proper URL → return as-is
  if (filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith('local-media://')) {
    return filePath;
  }

  // media://local/ prefix (legacy Telegram avatar format) → strip prefix and convert
  if (filePath.startsWith('media://local/')) {
    const rawPath = filePath.replace('media://local/', '');
    const normalized = rawPath.replace(/\\/g, '/');
    const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
    return 'local-media://' + withSlash;
  }

  const mode = getMode();
  if (mode === 'employee') {
    // Employee: convert boss local path → boss REST URL
    const bossUrl = getBossBaseUrl();
    if (!bossUrl) return filePath;
    return toBossMediaUrl(filePath, bossUrl, zaloId);
  }

  // Standalone/Boss: local-media:// protocol (current behavior)
  const stripped = filePath.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  const normalized = stripped.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return 'local-media://' + withSlash;
}

/**
 * Convert boss filesystem path → boss REST media URL
 * Input:  /home/boss/media/zaloId/2024/06/27/abc.jpg
 *         D:\media\zaloId\2024\06\27\abc.jpg
 * Output: https://boss/api/media/zaloId/2024/06/27/abc.jpg
 */
function toBossMediaUrl(localPath: string, bossUrl: string, zaloId?: string): string {
  try {
    // Normalize path separators
    let normalized = localPath.replace(/\\/g, '/');

    // Try to extract relative path after the media base directory
    // Patterns: /media/zaloId/... or D:\media\zaloId\...
    const mediaMatch = normalized.match(/(?:^|\/)(media|_uploads|avatar)\/(.+)/);
    if (mediaMatch) {
      return `${bossUrl}/api/${mediaMatch[1]}/${mediaMatch[2]}`;
    }

    // Fallback: use as-is with media prefix
    // Extract filename from path
    const filename = normalized.split('/').pop() || 'file';
    if (zaloId) {
      return `${bossUrl}/api/media/${zaloId}/misc/${filename}`;
    }

    // Last resort: construct from the full path (may not work on boss)
    return `${bossUrl}/api/media/external/${encodeURIComponent(normalized)}`;
  } catch {
    return localPath;
  }
}

function getMode(): string {
  try {
    return useEmployeeStore.getState().mode;
  } catch {
    return 'standalone';
  }
}

/** Thêm tham số vào URL (dùng & khi đã có ?). */
export function appendUrlParam(url: string, key: string, value: string): string {
  if (!url) return url;
  return url + (url.includes('?') ? '&' : '?') + encodeURIComponent(key) + '=' + encodeURIComponent(value);
}

/**
 * local-media:// khi file có thể phải lấy lại từ Cloudflare R2 mà KHÔNG còn nguồn nào khác (link CDN của kênh đã hết
 * hạn / không có): báo main chờ R2 lâu hơn (`cw=long`) thay vì trả 404 sau vài giây. URL khác giữ nguyên.
 */
export function withCloudWaitHint(url: string): string {
  return url.startsWith('local-media://') ? appendUrlParam(url, 'cw', 'long') : url;
}

/**
 * Check if a path is a local file path (not a remote URL)
 */
export function isLocalPath(path: string): boolean {
  if (!path) return false;
  return !path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('data:');
}
