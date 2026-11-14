/**
 * safeFileName.ts: turns a file name from outside (the employee's X-Filename header, a name passed in from elsewhere) into a safe name
 * for path.join into the save folder. Previously the employee media upload joined X-Filename straight into the path:
 * "..\..\Start Menu\Programs\Startup\x.bat" could write a file outside the Boss media folder.
 * (The public API has its own variant: sanitizeFileName in services/api/UploadStore.ts.)
 */
import * as path from 'path';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
export const MAX_SAFE_FILENAME_LENGTH = 150;

export interface SafeFileNameOptions {
  /** Decode %xx first (the client encodes X-Filename with encodeURIComponent). Default true. */
  decodeUri?: boolean;
}

/**
 * Keep only the file-name part (drop every folder, both `/` and `\`), drop forbidden / control characters, drop dots / spaces at the start and end
 * (Windows does not allow "file."), avoid Windows device names (CON, NUL…), limit the length (keep the file extension).
 * A name that is already valid (img_123.jpg, "Ảnh căn hộ.jpg") is kept as is.
 */
export function toSafeFileName(raw: unknown, fallback = 'file', options: SafeFileNameOptions = {}): string {
  let name = String(raw ?? '');
  if (options.decodeUri !== false && /%[0-9a-f]{2}/i.test(name)) {
    try { name = decodeURIComponent(name); } catch { /* keep as is */ }
  }
  name = name.split(/[\\/]+/).pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  if (name.length > MAX_SAFE_FILENAME_LENGTH) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_SAFE_FILENAME_LENGTH - ext.length) + ext;
  }
  return name;
}
