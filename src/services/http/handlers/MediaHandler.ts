/**
 * MediaHandler: serves media files from Boss storage over HTTP.
 * Employees use the URL directly in <img src> instead of a binary request. The employee machine attaches
 * `Authorization: Bearer` itself (session.webRequest, see bossSessionAuth.ts) because an <img> tag cannot send headers.
 *
 * Routes (employee session required; per-account permissions in bossFileAccess.ts):
 *   GET /api/media/{zaloId}/{date}/{filename}  → original file
 *   GET /api/media/thumb/{zaloId}/{date}/{filename} → thumbnail
 *   GET /api/media/avatar/{zaloId}/{filename}  → avatar
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import Logger from '../../../utils/Logger';
import FileStorageService from '../../file/FileStorageService';
import {
  checkMediaAccess,
  classifyMediaPath,
  isPathInside,
  parseByteRange,
  parseMediaRelPath,
  privateCacheHeaders,
  unsatisfiableRangeHeader,
  type FileAccessDenied,
  type FileAccessEmployee,
} from '../bossFileAccess';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
};

function detectMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/** JSON error response of the file route: `no-store` so the tunnel / browser never caches 401/403/404. */
export function sendFileError(res: http.ServerResponse, status: number, error: string, code?: string): void {
  if (res.headersSent) {
    try { res.end(); } catch { /* already closed */ }
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(code ? { success: false, error, code } : { success: false, error }));
}

export interface SendFileOptions {
  mime: string;
  /** Seconds: Cache-Control: private, max-age (with Vary: Authorization). */
  maxAge: number;
  /** Supports Range (video / files); images still return the whole file as before. */
  allowRange: boolean;
  stat?: fs.Stats;
  headers?: Record<string, string>;
}

/** Sends the file to an authenticated session: 200, 206 (valid Range) or 416; cache `private` (never cached at the tunnel edge). */
export function sendLocalFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  opts: SendFileOptions,
): void {
  const stat = opts.stat ?? fs.statSync(filePath);
  const headers: Record<string, string | number> = {
    'Content-Type': opts.mime,
    ...privateCacheHeaders(opts.maxAge),
    'X-Content-Type-Options': 'nosniff',
    'ETag': `"${stat.mtimeMs}"`,
    ...(opts.allowRange ? { 'Accept-Ranges': 'bytes' } : {}),
    ...(opts.headers || {}),
  };
  const range = opts.allowRange ? parseByteRange(req.headers.range, stat.size) : { kind: 'full' as const };
  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': unsatisfiableRangeHeader(stat.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (range.kind === 'partial') {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': range.end - range.start + 1,
    });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  }
  const stream = fs.createReadStream(filePath, range.kind === 'partial' ? { start: range.start, end: range.end } : undefined);
  stream.on('error', (err) => {
    Logger.warn(`[MediaHandler] Đọc file lỗi: ${err.message}`);
    res.destroy();
  });
  stream.pipe(res);
}

/** Session loading media (HttpRelayService has verified the token). */
export interface MediaAccess {
  /** Authenticated employee; null → 401. */
  employee: FileAccessEmployee | null;
  /** Folder name → canonical account id (accounts.zalo_id, case-insensitive) or null. */
  lookupAccount: (segment: string) => string | null;
}

/**
 * realpath for BOTH the root folder and the file, in the same way: the native version first (Windows: GetFinalPathNameByHandle → canonical
 * name: correct case, long name instead of the 8.3 alias, no trailing dot), and only if that fails (virtual drive / RAM disk...) the JS version.
 */
const REALPATH_FNS: Array<(p: string) => string> = [(p) => fs.realpathSync.native(p), (p) => fs.realpathSync(p)];

function realpathPair(base: string, target: string): { base: string; target: string } | null {
  for (const realpath of REALPATH_FNS) {
    try {
      return { base: realpath(path.resolve(base)), target: realpath(target) };
    } catch { /* try the next method */ }
  }
  return null;
}

/** Real file (symlinks/junctions followed) + path relative to the media folder; 'outside' = escapes the media folder. */
function resolveMediaFile(mediaBasePath: string, relPath: string): { filePath: string; relPath: string } | 'outside' | null {
  const candidates = [path.resolve(mediaBasePath, relPath)];
  // Not found in the current media folder → try resolveAbsolutePath (file stored under an old configFolder: toBossMediaUrl takes
  // the part after /media/ of the absolute path on Boss, getBaseDir() now points elsewhere) - it must still be inside the media folder.
  try {
    const alt = FileStorageService.resolveAbsolutePath(path.join('media', relPath));
    if (alt) candidates.push(alt);
  } catch { /* ignore */ }
  for (const candidate of candidates) {
    const real = realpathPair(mediaBasePath, candidate);
    if (!real) continue;
    if (!isPathInside(real.base, real.target)) return 'outside';
    return { filePath: real.target, relPath: path.relative(real.base, real.target) };
  }
  return null;
}

const deniedLogAt = new Map<string, number>();

/** 403 logs grouped by employee + folder, at most 1 line per minute (one chat screen can load dozens of images). */
function logDenied(employee: FileAccessEmployee, relPath: string, denied: FileAccessDenied): void {
  const folder = relPath.split(/[\\/]/).slice(0, 2).join('/');
  const key = `${employee.employee_id || '?'}|${folder}`;
  const now = Date.now();
  if (now - (deniedLogAt.get(key) || 0) < 60_000) return;
  if (deniedLogAt.size > 500) deniedLogAt.clear();
  deniedLogAt.set(key, now);
  Logger.warn(`[MediaHandler] 🚫 ${denied.code} employee=${employee.employee_id || '?'} media/${folder}/…`);
}

/**
 * Media file no longer on the machine → ask the R2 module (cloudflare/media) to download it back to the same place, then check the real path
 * and the permissions again, as in the normal flow, before serving it. Lazy require: R2 off / not loaded → 404 as before.
 */
async function serveRestoredFromCloud(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mediaBasePath: string,
  relPath: string,
  authorize: (rel: string) => boolean,
): Promise<void> {
  try {
    let restored: string | null = null;
    try {
      restored = await require('../../cloudflare/media').cloudMedia.resolveMissingMediaFile(path.resolve(mediaBasePath, relPath));
    } catch { restored = null; }
    if (!restored) return sendFileError(res, 404, 'File not found');
    const file = resolveMediaFile(mediaBasePath, relPath);
    if (file === 'outside') return sendFileError(res, 403, 'Forbidden');
    if (!file) return sendFileError(res, 404, 'File not found');
    if (!authorize(file.relPath)) return;
    const stat = fs.statSync(file.filePath);
    if (!stat.isFile()) return sendFileError(res, 404, 'File not found');
    const mime = detectMime(file.filePath);
    const maxAge = `/${relPath}`.includes('/avatar/') ? 604800 : 86400;
    sendLocalFile(req, res, file.filePath, { mime, maxAge, allowRange: !mime.startsWith('image/'), stat });
  } catch (err: any) {
    Logger.error(`[MediaHandler] Error: ${err.message}`);
    sendFileError(res, 500, 'Internal error');
  }
}

/**
 * Handle GET /api/media/* request.
 * Returns the file directly with a suitable Content-Type.
 * Supports Range requests for video / files.
 */
export function handleMediaRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mediaBasePath: string,
  access: MediaAccess,
): void {
  try {
    const employee = access?.employee;
    if (!employee) return sendFileError(res, 401, 'Unauthorized');

    // /api/media/{zaloId}/{date}/{filename} | thumb/... | avatar/... → decoded, normalized relative path
    const relPath = parseMediaRelPath(req.url || '');
    if (!relPath) return sendFileError(res, 400, 'Invalid media path');

    const authorize = (rel: string): boolean => {
      const denied = checkMediaAccess(employee, classifyMediaPath(rel, access.lookupAccount));
      if (!denied) return true;
      logDenied(employee, rel, denied);
      sendFileError(res, denied.status, denied.error, denied.code);
      return false;
    };
    // Check the URL first (does not reveal whether the file exists), then the REAL path after realpath
    if (!authorize(relPath)) return;

    const file = resolveMediaFile(mediaBasePath, relPath);
    if (file === 'outside') return sendFileError(res, 403, 'Forbidden');
    if (!file) {
      // Not on the machine: try downloading it again from R2 (media was uploaded to Cloudflare and the local file was cleaned up); R2 off / missing → 404 as before
      void serveRestoredFromCloud(req, res, mediaBasePath, relPath, authorize);
      return;
    }
    if (!authorize(file.relPath)) return;

    const stat = fs.statSync(file.filePath);
    if (!stat.isFile()) return sendFileError(res, 404, 'File not found');
    const mime = detectMime(file.filePath);
    const maxAge = `/${relPath}`.includes('/avatar/') ? 604800 : 86400; // Avatar: 7 days, everything else: 1 day
    sendLocalFile(req, res, file.filePath, { mime, maxAge, allowRange: !mime.startsWith('image/'), stat });
  } catch (err: any) {
    Logger.error(`[MediaHandler] Error: ${err.message}`);
    sendFileError(res, 500, 'Internal error');
  }
}
