/**
 * Convert absolute local file path → local-media:// URL or boss REST URL.
 *
 * - Standalone/Boss mode: dùng local-media:// (Electron custom protocol)
 * - Employee mode: dùng boss /api/media/ URL
 *
 * Usage:
 *   <img src={toLocalMediaUrl(filePath, zaloId)} />
 */

import { useEmployeeStore } from '../store/employeeStore';

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

/**
 * Check if a path is a local file path (not a remote URL)
 */
export function isLocalPath(path: string): boolean {
  if (!path) return false;
  return !path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('data:');
}
