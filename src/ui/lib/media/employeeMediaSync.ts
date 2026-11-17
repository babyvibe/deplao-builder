/**
 * employeeMediaSync - Download media from the owner's machine to the local cache when an Employee clicks it.
 *
 * When an Employee clicks a video/file/photo in the chat, the file only exists on the owner's machine.
 * This helper downloads the file from the owner's machine REST URL → local cache → returns the local path to open.
 *
 * Uses MediaCacheService (main process) with resolveUrlSync to wait until the download completes.
 */

import ipc from '../ipc';
import { toLocalMediaUrl } from './localMedia';
import { useEmployeeStore } from '../../store/employee/employeeStore';

export interface EmployeeMediaResult {
  localPath: string;
  displayUrl: string;
  fromCache: boolean;
}

/**
 * Ensure a media file is available locally on the Employee machine.
 * If cached → return immediately. If not → download from the owner's machine → cache → return.
 *
 * @param bossUrl - Owner's machine REST URL of the file (from toLocalMediaUrl or CDN URL)
 * @param mediaType - Media type: 'image' | 'video' | 'file'
 * @returns { localPath, displayUrl, fromCache }
 */
export async function ensureMediaLocal(
  bossUrl: string,
  mediaType: 'image' | 'video' | 'file' = 'image',
): Promise<EmployeeMediaResult> {
  if (!bossUrl) {
    return { localPath: '', displayUrl: '', fromCache: false };
  }

  // If it is already a file:// URL → it is already local
  if (bossUrl.startsWith('file://')) {
    const localPath = fileUrlToPath(bossUrl);
    return { localPath, displayUrl: bossUrl, fromCache: true };
  }

  // If it is not http (a raw local path) → convert it through the owner's machine URL
  const resolvedUrl = bossUrl.startsWith('http')
    ? bossUrl
    : toLocalMediaUrl(bossUrl);

  if (!resolvedUrl || resolvedUrl.startsWith('local-media://')) {
    // Cannot convert → no owner's machine URL (standalone / owner's machine mode)
    return { localPath: '', displayUrl: bossUrl, fromCache: false };
  }

  // Call IPC to download + cache
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
      // Not a file:// URL → return the display URL (owner's machine URL or CDN)
      return {
        localPath: result.localPath || '',
        displayUrl: result.displayUrl,
        fromCache: result.fromCache || false,
      };
    }
  } catch {
    // Fallback: return the original URL
  }

  return { localPath: '', displayUrl: resolvedUrl, fromCache: false };
}

/**
 * File path on THIS machine, to open / show in the folder. Employee machine: local_paths is a path on the owner's machine → downloads
 * the owner's copy to this machine (MediaCacheService attaches the employee session token), then returns the downloaded path ('' = download failed).
 * Owner / standalone: returns the path unchanged.
 */
export async function fileOnThisMachine(
  localPath: string,
  mediaType: 'image' | 'video' | 'file' = 'file',
): Promise<string> {
  if (!localPath) return '';
  let employee = false;
  try {
    employee = useEmployeeStore.getState().mode === 'employee';
  } catch { /* store not ready yet */ }
  if (!employee) return localPath;
  const { localPath: downloaded } = await ensureMediaLocal(localPath, mediaType);
  return downloaded;
}

/**
 * Convert a file:// URL to a local path.
 */
function fileUrlToPath(fileUrl: string): string {
  if (!fileUrl.startsWith('file://')) return fileUrl;

  let path = fileUrl.replace('file:///', '');
  // Windows: decode and remove the leading slash if present
  path = decodeURIComponent(path);
  if (/^\/[a-z]:\//i.test(path)) {
    path = path.slice(1);
  }
  return path;
}
