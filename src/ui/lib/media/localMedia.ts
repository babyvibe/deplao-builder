/**
 * Convert an absolute local file path → local-media:// URL or owner's machine REST URL.
 *
 * - Standalone / owner's machine mode: uses local-media:// (Electron custom protocol)
 * - Employee mode: uses the owner's machine /api/media/ URL
 *
 * Usage:
 *   <img src={toLocalMediaUrl(filePath, zaloId)} />
 */

import { useEmployeeStore } from '../../store/employee/employeeStore';
import { browserMediaUrl } from '../../../shared/platform/browserMedia';

function getBossBaseUrl(): string {
  try {
    return useEmployeeStore.getState().bossUrl || '';
  } catch {
    return '';
  }
}

export function toLocalMediaUrl(filePath: string, zaloId?: string): string {
  if (!filePath) return '';
  if (/^(blob:|data:)/.test(filePath)) return filePath;
  if (filePath.startsWith('/api/browser/media?')) return filePath;
  if (typeof document !== 'undefined' && document.documentElement.dataset.deplaoRuntime === 'web') {
    if (/^(local-media:\/\/|media:\/\/local\/|file:\/\/)/.test(filePath)) return browserMediaUrl(filePath);
    if (!/^https?:\/\//.test(filePath) && getMode() !== 'employee') return browserMediaUrl(filePath);
  }

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
      return `${bossUrl}/api/${mediaMatch[1]}/${encodeUrlPath(mediaMatch[2])}`;
    }

    // Fallback: use as-is with media prefix
    // Extract filename from path
    const filename = normalized.split('/').pop() || 'file';
    if (zaloId) {
      return `${bossUrl}/api/media/${encodeURIComponent(zaloId)}/misc/${encodeURIComponent(filename)}`;
    }

    // Last resort: construct from the full path (may not work on boss)
    return `${bossUrl}/api/media/external/${encodeURIComponent(normalized)}`;
  } catch {
    return localPath;
  }
}

/**
 * Encode each segment of the owner's machine file path (the on-disk path, not yet encoded) for the URL: file names sent by customers can contain "#", "%",
 * "&"… ("Báo giá #3.xlsx", "Giảm 10%.xls"). If left as is, "#…" becomes the URL fragment, so the owner's machine gets the wrong name → the file cannot be downloaded /
 * opened. The owner's machine decodes exactly once (bossFileAccess.parseMediaRelPath).
 */
export function encodeUrlPath(relPath: string): string {
  return relPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function getMode(): string {
  try {
    return useEmployeeStore.getState().mode;
  } catch {
    return 'standalone';
  }
}

/** Add a parameter to the URL (uses & when ? is already present). */
export function appendUrlParam(url: string, key: string, value: string): string {
  if (!url) return url;
  return url + (url.includes('?') ? '&' : '?') + encodeURIComponent(key) + '=' + encodeURIComponent(value);
}

/**
 * local-media:// when the file may have to be fetched again from Cloudflare R2 and there is NO other source left (the channel's CDN link has expired or is missing):
 * tells main to wait longer for R2 (`cw=long`) instead of returning 404 after a few seconds. Other URLs stay unchanged.
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
