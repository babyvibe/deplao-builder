/**
 * MediaHandler - Serve media files từ Boss storage qua HTTP.
 * Employee dùng URL trực tiếp trong <img src> thay vì request binary — máy nhân viên tự gắn
 * `Authorization: Bearer` (session.webRequest, xem bossSessionAuth.ts) vì thẻ <img> không gửi header được.
 *
 * Routes (bắt buộc phiên nhân viên; quyền theo tài khoản ở bossFileAccess.ts):
 *   GET /api/media/{zaloId}/{date}/{filename}  → File gốc
 *   GET /api/media/thumb/{zaloId}/{date}/{filename} → Thumbnail
 *   GET /api/media/avatar/{zaloId}/{filename}  → Avatar
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

/** Phản hồi lỗi JSON của route file — `no-store` để tunnel / trình duyệt không lưu 401/403/404. */
export function sendFileError(res: http.ServerResponse, status: number, error: string, code?: string): void {
  if (res.headersSent) {
    try { res.end(); } catch { /* đã đóng */ }
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(code ? { success: false, error, code } : { success: false, error }));
}

export interface SendFileOptions {
  mime: string;
  /** Giây — Cache-Control: private, max-age (kèm Vary: Authorization). */
  maxAge: number;
  /** Hỗ trợ Range (video / file); ảnh trả cả file như trước. */
  allowRange: boolean;
  stat?: fs.Stats;
  headers?: Record<string, string>;
}

/** Gửi file cho phiên đã xác thực: 200, 206 (Range hợp lệ) hoặc 416; cache `private` (không cache ở edge tunnel). */
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

/** Phiên đang tải media (HttpRelayService đã xác thực token). */
export interface MediaAccess {
  /** Nhân viên đã xác thực; null → 401. */
  employee: FileAccessEmployee | null;
  /** Tên thư mục → id tài khoản chuẩn (accounts.zalo_id, không phân biệt hoa/thường) hoặc null. */
  lookupAccount: (segment: string) => string | null;
}

/**
 * realpath cho CẢ thư mục gốc lẫn file theo cùng một cách: bản native trước (Windows: GetFinalPathNameByHandle → tên
 * chuẩn: đúng hoa/thường, tên dài thay alias 8.3, bỏ dấu chấm cuối), lỗi (ổ ảo / RAM disk…) mới dùng bản JS.
 */
const REALPATH_FNS: Array<(p: string) => string> = [(p) => fs.realpathSync.native(p), (p) => fs.realpathSync(p)];

function realpathPair(base: string, target: string): { base: string; target: string } | null {
  for (const realpath of REALPATH_FNS) {
    try {
      return { base: realpath(path.resolve(base)), target: realpath(target) };
    } catch { /* thử cách sau */ }
  }
  return null;
}

/** File thật (đã theo symlink/junction) + đường dẫn tương đối so với thư mục media; 'outside' = thoát khỏi thư mục media. */
function resolveMediaFile(mediaBasePath: string, relPath: string): { filePath: string; relPath: string } | 'outside' | null {
  const candidates = [path.resolve(mediaBasePath, relPath)];
  // Không thấy ở thư mục media hiện tại → thử resolveAbsolutePath (file lưu dưới configFolder cũ: toBossMediaUrl lấy
  // phần sau /media/ của đường dẫn tuyệt đối trên Boss, getBaseDir() nay trỏ chỗ khác) — vẫn phải nằm trong thư mục media.
  try {
    const alt = FileStorageService.resolveAbsolutePath(path.join('media', relPath));
    if (alt) candidates.push(alt);
  } catch { /* bỏ qua */ }
  for (const candidate of candidates) {
    const real = realpathPair(mediaBasePath, candidate);
    if (!real) continue;
    if (!isPathInside(real.base, real.target)) return 'outside';
    return { filePath: real.target, relPath: path.relative(real.base, real.target) };
  }
  return null;
}

const deniedLogAt = new Map<string, number>();

/** Log 403 gộp theo nhân viên + thư mục, tối đa 1 dòng / phút (một màn chat có thể tải hàng chục ảnh). */
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
 * File media không còn trên máy → nhờ module R2 (cloudflare/media) tải lại về đúng chỗ cũ, rồi kiểm tra lại đường dẫn thật
 * + quyền như luồng thường trước khi phục vụ. require lười: R2 tắt / chưa nạp → 404 như trước.
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
 * Trả về file trực tiếp với Content-Type phù hợp.
 * Supports Range requests cho video / file.
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

    // /api/media/{zaloId}/{date}/{filename} | thumb/... | avatar/... → đường dẫn tương đối đã giải mã + chuẩn hoá
    const relPath = parseMediaRelPath(req.url || '');
    if (!relPath) return sendFileError(res, 400, 'Invalid media path');

    const authorize = (rel: string): boolean => {
      const denied = checkMediaAccess(employee, classifyMediaPath(rel, access.lookupAccount));
      if (!denied) return true;
      logDenied(employee, rel, denied);
      sendFileError(res, denied.status, denied.error, denied.code);
      return false;
    };
    // Theo URL trước (không lộ file có tồn tại hay không), rồi theo đường dẫn THẬT sau realpath
    if (!authorize(relPath)) return;

    const file = resolveMediaFile(mediaBasePath, relPath);
    if (file === 'outside') return sendFileError(res, 403, 'Forbidden');
    if (!file) {
      // Không có trên máy: thử tải lại từ R2 (lưu media lên Cloudflare đã dọn file); R2 tắt / không có → 404 như cũ
      void serveRestoredFromCloud(req, res, mediaBasePath, relPath, authorize);
      return;
    }
    if (!authorize(file.relPath)) return;

    const stat = fs.statSync(file.filePath);
    if (!stat.isFile()) return sendFileError(res, 404, 'File not found');
    const mime = detectMime(file.filePath);
    const maxAge = `/${relPath}`.includes('/avatar/') ? 604800 : 86400; // Avatar: 7 ngày, còn lại: 1 ngày
    sendLocalFile(req, res, file.filePath, { mime, maxAge, allowRange: !mime.startsWith('image/'), stat });
  } catch (err: any) {
    Logger.error(`[MediaHandler] Error: ${err.message}`);
    sendFileError(res, 500, 'Internal error');
  }
}
