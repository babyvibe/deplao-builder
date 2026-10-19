/**
 * LibraryHandler - REST API cho thư viện media.
 * Các endpoint /api/library/* được HttpRelayService gọi.
 */

import * as http from 'http';
import * as path from 'path';
import LibraryService from '../../library/LibraryService';
import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';
import { canAccessLibraryOwner, checkLibraryAccess, type FileAccessEmployee } from '../bossFileAccess';
import { sendFileError, sendLocalFile } from './MediaHandler';

const lib = () => LibraryService.getInstance();

/** true = nhân viên được tải item; false = đã trả 401 / 404 / 403. */
function authorizeLibraryItem(res: http.ServerResponse, uuid: string, employee?: FileAccessEmployee | null): boolean {
  if (!employee) {
    sendFileError(res, 401, 'Unauthorized');
    return false;
  }
  const item = lib().getItem(uuid);
  if (!item) {
    sendFileError(res, 404, 'File not found');
    return false;
  }
  const denied = checkLibraryAccess(employee, String(item.owner_zalo_id || ''));
  if (denied) {
    Logger.warn(`[LibraryHandler] 🚫 ${denied.code} employee=${employee.employee_id || '?'} item=${uuid}`);
    sendFileError(res, denied.status, denied.error, denied.code);
    return false;
  }
  return true;
}

/** Content-Disposition inline: tên ASCII dự phòng + filename* UTF-8 (tên có dấu làm writeHead ném lỗi, '"' làm hỏng header). */
function inlineDisposition(fileName: string): string {
  const name = String(fileName || 'file').replace(/[\r\n\t]/g, ' ');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function parseOwnerZaloIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return value.split(',').filter(Boolean);
}

/**
 * Thân request upload tối đa (multipart / JSON base64 — cả file nằm trong RAM). Trước đây không giới hạn: một nhân viên
 * gửi body vài GB làm Boss hết RAM. Base64 nở ~4/3 → file thực tế tối đa ~150 MB.
 */
export const MAX_LIBRARY_UPLOAD_BODY_BYTES = 200 * 1024 * 1024;

/** Gom body upload có giới hạn; vượt giới hạn → 413 + bỏ phần còn lại (onDone không được gọi). */
function readUploadBody(req: http.IncomingMessage, res: http.ServerResponse, onDone: (raw: Buffer) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', (chunk: Buffer) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_LIBRARY_UPLOAD_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ success: false, error: `File tối đa ${Math.round(MAX_LIBRARY_UPLOAD_BODY_BYTES / 1024 / 1024 * 3 / 4)} MB`, code: 'PAYLOAD_TOO_LARGE' }));
      }
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (!tooLarge) onDone(Buffer.concat(chunks));
  });
}

/** Trang mặc định khi request không gửi zaloId: chỉ khi nhân viên được giao đúng một trang (không lấy trang đầu tiên). */
function defaultLibraryOwner(employee: any): string {
  const assigned = [...new Set<string>((employee?.assigned_accounts || []).map(String).filter(Boolean))];
  return assigned.length === 1 ? assigned[0] : '';
}

/** Trang (tài khoản) nhân viên được ghi thư viện vào: có tài khoản được giao thì phải là một trong số đó. */
function uploadOwnerError(employee: any, zaloId: string): string | null {
  if (!zaloId) return 'Missing zaloId';
  return canAccessLibraryOwner(employee, zaloId) ? null : 'Không có quyền ghi thư viện của trang này';
}

/** Item thư viện nhân viên được sửa / xoá: thuộc trang được giao (cùng quy tắc tải file — checkLibraryAccess). */
function itemWriteError(employee: any, uuid: string): string | null {
  const item = lib().getItem(uuid);
  if (!item) return 'Item not found';
  return checkLibraryAccess(employee, String(item.owner_zalo_id || '')) ? 'Không có quyền với item thư viện này' : null;
}

/** Thư mục thư viện nhân viên được đổi tên / xoá: thuộc trang được giao. */
function folderWriteError(employee: any, folderId: number): string | null {
  const row = DatabaseService.getInstance().queryOne<{ owner_zalo_id: string }>(
    'SELECT owner_zalo_id FROM media_library_folders WHERE id = ?', [folderId]);
  if (!row) return 'Folder not found';
  return canAccessLibraryOwner(employee, String(row.owner_zalo_id || '')) ? null : 'Không có quyền với thư mục này';
}

function resolveAccessibleOwners(employee: any, zaloId: string, requested: string[]): string[] | null {
  const assigned = new Set((employee.assigned_accounts || []).map(String));
  if (assigned.size === 0) return requested.length > 0 ? requested : [zaloId];
  if (requested.length === 0) return assigned.has(zaloId) ? [zaloId] : null;
  const allowed = requested.filter(id => assigned.has(id));
  return allowed.length > 0 ? allowed : null;
}

interface JsonResponse {
  success: boolean;
  data?: any;
  error?: string;
  pagination?: { page: number; limit: number; total: number; hasMore: boolean };
}

function success(data: any, pagination?: JsonResponse['pagination']): JsonResponse {
  const res: JsonResponse = { success: true };
  if (data !== undefined) res.data = data;
  if (pagination) res.pagination = pagination;
  return res;
}

function error(msg: string): JsonResponse {
  return { success: false, error: msg };
}

export const libraryHandlers = {
  // ── Upload (multipart) ──────────────────────────────────────────
  // Boss nhận multipart từ employee (gửi qua curl, HTTP client, ...)

  handleUpload(req: http.IncomingMessage, res: http.ServerResponse, employee: any): void {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error('Expected multipart/form-data')));
      return;
    }

    const boundary = '--' + contentType.split('boundary=')[1];
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error('Missing boundary')));
      return;
    }

    // Capture pinned DB path BEFORE async callback (same as handleUploadJson)
    const pinnedDbPath = DatabaseService.getInstance().getDbPath();
    readUploadBody(req, res, async (raw) => {
      try {
        const parsed = this.parseMultipart(raw, boundary);

        const fileField = parsed.files?.[0];
        if (!fileField || !fileField.data || fileField.data.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error('No file uploaded')));
          return;
        }

        const zaloId = parsed.fields?.zaloId || defaultLibraryOwner(employee);
        // Trước đây zaloId trong form không được kiểm tra: ghi được vào thư viện của trang không được giao
        const ownerDenied = uploadOwnerError(employee, zaloId);
        if (ownerDenied) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error(ownerDenied)));
          return;
        }
        const employeeId = employee.employee_id || '';
        const tags = parsed.fields?.tags || '';
        const folderId = parsed.fields?.folderId ? parseInt(parsed.fields.folderId) : null;

        const item = await DatabaseService.getInstance().withDbPathAsync(pinnedDbPath, () => lib().upload({
          zaloId,
          buffer: fileField.data,
          fileName: fileField.filename || 'unnamed',
          mimeType: fileField.mimeType || 'application/octet-stream',
          employeeId,
          tags,
          folderId,
        }));

        // Build URLs
        const bossUrl = `//${req.headers.host || ''}`;
        const fileUrl = `${bossUrl}/api/library/file/${item.uuid}`;
        const thumbUrl = item.thumb_path ? `${bossUrl}/api/library/thumb/${item.uuid}` : null;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(success({
          ...item,
          file_path: undefined,
          thumb_path: undefined,
          fileUrl,
          thumbUrl,
        })));
      } catch (err: any) {
        Logger.error(`[LibraryHandler] Upload error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(error(err.message)));
      }
    });
  },

  // ── Upload (JSON base64 - employee mode) ────────────────────────
  // Employee gửi POST /api/library/upload/json với JSON body:
  // { zaloId, fileName, mimeType, base64, tags?, folderId? }
  handleUploadJson(req: http.IncomingMessage, res: http.ServerResponse, employee: any): void {
    // ⚠️ Capture pinned DB path BEFORE async callback. handleRestApi wraps this in
    // runOnPinnedDb which swaps db. When req.on('end') fires later the context is gone.
    const pinnedDbPath = DatabaseService.getInstance().getDbPath();
    readUploadBody(req, res, async (raw) => {
      try {
        const body = raw.toString('utf8');
        const parsed = JSON.parse(body);
        const { zaloId, fileName, mimeType, base64, tags, folderId } = parsed;

        if (!base64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error('Missing base64')));
          return;
        }

        const empZaloId = zaloId || defaultLibraryOwner(employee);
        // Trước đây zaloId trong body không được kiểm tra: ghi được vào thư viện của trang không được giao
        const ownerDenied = uploadOwnerError(employee, empZaloId);
        if (ownerDenied) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error(ownerDenied)));
          return;
        }

        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error('Empty file data')));
          return;
        }

        // ⚠️ Dùng withDbPathAsync vì lib().upload() là async (có await sharp bên trong).
        // withDbPath (sync) sẽ restore db BEFORE async ops complete → INSERT vào sai DB!
        const item = await DatabaseService.getInstance().withDbPathAsync(pinnedDbPath, () => lib().upload({
          zaloId: empZaloId,
          buffer,
          fileName: fileName || 'unnamed',
          mimeType: mimeType || 'application/octet-stream',
          employeeId: employee.employee_id || '',
          tags: tags || '',
          folderId: folderId ? parseInt(folderId) : null,
        }));

        // Build URLs using request host
        const bossUrl = `//${req.headers.host || ''}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(success({
          ...item,
          file_path: undefined,
          thumb_path: undefined,
          fileUrl: `${bossUrl}/api/library/file/${item.uuid}`,
          thumbUrl: item.thumb_path ? `${bossUrl}/api/library/thumb/${item.uuid}` : null,
        })));
      } catch (err: any) {
        Logger.error(`[LibraryHandler] handleUploadJson error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(error(err.message)));
      }
    });
  },

  // ── Query ───────────────────────────────────────────────────────

  getItems(employee: any, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts?.[0] || '';
    if (!zaloId) return error('Missing zaloId');
    const requestedOwners = parseOwnerZaloIds(params.ownerZaloIds);
    const ownerZaloIds = resolveAccessibleOwners(employee, zaloId, requestedOwners);
    if (!ownerZaloIds) return error('Không có quyền xem thư viện của trang này');

    const page = parseInt(params.page) || 1;
    const limit = Math.min(parseInt(params.limit) || 50, 200);
    const result = lib().getItems({
      zaloId,
      ownerZaloIds,
      type: params.type || params.type,
      search: params.search,
      folderId: params.folderId !== undefined ? parseInt(params.folderId) : undefined,
      page,
      limit,
    });

    return success(
      result.items.map(item => ({
        ...item,
        file_path: undefined,
        thumb_path: undefined,
        fileUrl: params._bossUrl
          ? `${params._bossUrl}/api/library/file/${item.uuid}`
          : `/api/library/file/${item.uuid}`,
        thumbUrl: item.thumb_path
          ? (params._bossUrl
            ? `${params._bossUrl}/api/library/thumb/${item.uuid}`
            : `/api/library/thumb/${item.uuid}`)
          : null,
        _localPath: item.file_path,
        _thumbLocalPath: item.thumb_path,
      })),
      { page, limit, total: result.total, hasMore: page * limit < result.total }
    );
  },

  getItem(employee: any, params: any): JsonResponse {
    if (!params.uuid) return error('Missing uuid');
    const item = lib().getItem(params.uuid);
    // Cùng quy tắc chủ item với tải file (checkLibraryAccess): item của trang không được giao = "không có"
    if (!item || checkLibraryAccess(employee, String(item.owner_zalo_id || ''))) return error('Item not found');
    const bossUrl = params._bossUrl || '';
    return success({
      ...item,
      file_path: undefined,
      thumb_path: undefined,
      fileUrl: bossUrl
        ? `${bossUrl}/api/library/file/${item.uuid}`
        : `/api/library/file/${item.uuid}`,
      thumbUrl: item.thumb_path
        ? (bossUrl
          ? `${bossUrl}/api/library/thumb/${item.uuid}`
          : `/api/library/thumb/${item.uuid}`)
        : null,
      _localPath: item.file_path,
      _thumbLocalPath: item.thumb_path,
    });
  },

  // Ghi (sửa / xoá item, tạo / đổi tên / xoá thư mục): chỉ trên trang được giao — trước đây theo uuid / id là sửa được
  // thư viện của mọi trang (PATCH còn không bao giờ chạy: router trả 404 và uuid không được lấy từ đường dẫn).

  updateItem(employee: any, params: any): JsonResponse {
    if (!params.uuid) return error('Missing uuid');
    const denied = itemWriteError(employee, params.uuid);
    if (denied) return error(denied);
    // Chỉ các trường được sửa (không đẩy cả query / tham số khác vào event library:itemUpdated)
    const patch: any = {};
    for (const key of ['name', 'tags', 'folderId', 'isFavorite', 'altText']) {
      if (params[key] !== undefined) patch[key] = params[key];
    }
    if (patch.folderId !== undefined && patch.folderId !== null) patch.folderId = parseInt(patch.folderId) || null;
    if (patch.isFavorite !== undefined) patch.isFavorite = patch.isFavorite ? 1 : 0;
    const updated = lib().updateItem(params.uuid, patch);
    if (!updated) return error('Không có thay đổi nào');
    return success({ uuid: params.uuid });
  },

  deleteItem(employee: any, params: any): JsonResponse {
    if (!params.uuid) return error('Missing uuid');
    const denied = itemWriteError(employee, params.uuid);
    if (denied) return error(denied);
    if (!lib().deleteItem(params.uuid)) return error('Item not found');
    return success({ uuid: params.uuid });
  },

  // ── Folders ─────────────────────────────────────────────────────

  createFolder(employee: any, params: any): JsonResponse {
    const zaloId = params.zaloId || defaultLibraryOwner(employee);
    const ownerDenied = uploadOwnerError(employee, zaloId);
    if (ownerDenied) return error(ownerDenied);
    if (!params.name) return error('Missing name');

    const id = lib().createFolder({
      name: params.name,
      zaloId,
      parentId: params.parentId ? parseInt(params.parentId) : null,
      color: params.color,
      type: params.type,
    });
    return success({ id });
  },

  getFolders(employee: any, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts?.[0] || '';
    if (!zaloId) return error('Missing zaloId');
    const requestedOwners = parseOwnerZaloIds(params.ownerZaloIds);
    const ownerZaloIds = resolveAccessibleOwners(employee, zaloId, requestedOwners);
    if (!ownerZaloIds) return error('Không có quyền xem thư viện của trang này');
    const folders = lib().getFolders(zaloId, params.type, ownerZaloIds);
    return success({ items: folders });
  },

  deleteFolder(employee: any, params: any): JsonResponse {
    const id = parseInt(params.id);
    if (!id) return error('Missing id');
    const denied = folderWriteError(employee, id);
    if (denied) return error(denied);
    lib().deleteFolder(id);
    return success({ id });
  },

  /** Đổi tên thư mục (PATCH /api/library/folders/:id) — cùng câu lệnh với library:renameFolder của Boss. */
  renameFolder(employee: any, params: any): JsonResponse {
    const id = parseInt(params.id);
    if (!id) return error('Missing id');
    const name = String(params.name ?? '').trim();
    if (!name) return error('Missing name');
    const denied = folderWriteError(employee, id);
    if (denied) return error(denied);
    DatabaseService.getInstance().run('UPDATE media_library_folders SET name=? WHERE id=?', [name, id]);
    return success({ id, name });
  },

  // ── Serve file (không phải JSON) ────────────────────────────────
  // HttpRelayService đã xác thực phiên nhân viên; ở đây kiểm tra chủ item (checkLibraryAccess — cùng quy tắc với
  // resolveAccessibleOwners). Không truyền nhân viên → 401 (an toàn mặc định cho mọi chỗ gọi).

  serveFile(req: http.IncomingMessage, res: http.ServerResponse, uuid: string, employee?: FileAccessEmployee | null): void {
    try {
      if (!authorizeLibraryItem(res, uuid, employee)) return;
      const fileInfo = lib().getFilePath(uuid);
      if (!fileInfo) return sendFileError(res, 404, 'File not found');
      const mime = fileInfo.mimeType || 'application/octet-stream';
      sendLocalFile(req, res, fileInfo.filePath, {
        mime,
        maxAge: 604800,
        allowRange: !mime.startsWith('image/'),
        headers: { 'Content-Disposition': inlineDisposition(fileInfo.fileName || path.basename(fileInfo.filePath)) },
      });
    } catch (err: any) {
      Logger.error(`[LibraryHandler] serveFile error: ${err.message}`);
      sendFileError(res, 500, 'Internal error');
    }
  },

  serveThumb(req: http.IncomingMessage, res: http.ServerResponse, uuid: string, employee?: FileAccessEmployee | null): void {
    try {
      if (!authorizeLibraryItem(res, uuid, employee)) return;
      const thumbInfo = lib().getThumbPath(uuid);
      if (!thumbInfo) return sendFileError(res, 404, 'Thumb not found');
      sendLocalFile(req, res, thumbInfo.filePath, { mime: thumbInfo.mimeType, maxAge: 604800, allowRange: false });
    } catch (err: any) {
      Logger.error(`[LibraryHandler] serveThumb error: ${err.message}`);
      sendFileError(res, 500, 'Internal error');
    }
  },

  // ── Multipart parser ────────────────────────────────────────────

  parseMultipart(raw: Buffer, boundary: string): { fields: Record<string, string>; files: Array<{ field: string; filename: string; mimeType: string; data: Buffer }> } {
    const fields: Record<string, string> = {};
    const files: Array<{ field: string; filename: string; mimeType: string; data: Buffer }> = [];

    const parts = raw.toString('binary').split(boundary);
    for (const part of parts) {
      if (part.includes('Content-Disposition')) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.substring(0, headerEnd);
        const bodyStart = headerEnd + 4;
        const bodyEnd = part.lastIndexOf('\r\n--');
        const body = part.substring(bodyStart, bodyEnd > bodyStart ? bodyEnd : part.length);

        // Check if it's a file
        const filenameMatch = headers.match(/filename="?([^"]*)"?/);
        if (filenameMatch) {
          const fieldMatch = headers.match(/name="?([^"]*)"?/);
          const mimeMatch = headers.match(/Content-Type:\s*(\S+)/);
          // Convert back to Buffer for binary safety
          const buf = Buffer.from(body, 'binary');
          files.push({
            field: fieldMatch?.[1] || 'file',
            filename: filenameMatch[1],
            mimeType: mimeMatch?.[1] || 'application/octet-stream',
            data: buf,
          });
        } else {
          const fieldMatch = headers.match(/name="?([^"]*)"?/);
          if (fieldMatch) {
            fields[fieldMatch[1]] = body.replace(/\r?\n$/, '').replace(/^\r?\n/, '');
          }
        }
      }
    }

    return { fields, files };
  },
};
