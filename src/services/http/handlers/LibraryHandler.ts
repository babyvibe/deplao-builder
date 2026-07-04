/**
 * LibraryHandler - REST API cho thư viện media.
 * Các endpoint /api/library/* được HttpRelayService gọi.
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import LibraryService from '../../library/LibraryService';
import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';

const lib = () => LibraryService.getInstance();

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
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        const parsed = this.parseMultipart(raw, boundary);

        const fileField = parsed.files?.[0];
        if (!fileField || !fileField.data || fileField.data.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error('No file uploaded')));
          return;
        }

        const zaloId = parsed.fields?.zaloId || employee.assigned_accounts?.[0] || '';
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
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(body);
        const { zaloId, fileName, mimeType, base64, tags, folderId } = parsed;

        if (!base64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error('Missing base64')));
          return;
        }

        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(error('Empty file data')));
          return;
        }

        const empZaloId = zaloId || employee.assigned_accounts?.[0] || '';
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

    const page = parseInt(params.page) || 1;
    const limit = Math.min(parseInt(params.limit) || 50, 200);
    const result = lib().getItems({
      zaloId,
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
    if (!item) return error('Item not found');
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

  updateItem(employee: any, params: any): JsonResponse {
    if (!params.uuid) return error('Missing uuid');
    lib().updateItem(params.uuid, params);
    return success({ uuid: params.uuid });
  },

  deleteItem(employee: any, params: any): JsonResponse {
    if (!params.uuid) return error('Missing uuid');
    lib().deleteItem(params.uuid);
    return success({ uuid: params.uuid });
  },

  // ── Folders ─────────────────────────────────────────────────────

  createFolder(employee: any, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts?.[0] || '';
    if (!zaloId) return error('Missing zaloId');
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
    const folders = lib().getFolders(zaloId, params.type);
    return success({ items: folders });
  },

  deleteFolder(employee: any, params: any): JsonResponse {
    const id = parseInt(params.id);
    if (!id) return error('Missing id');
    lib().deleteFolder(id);
    return success({ id });
  },

  // ── Serve file (không phải JSON) ────────────────────────────────

  serveFile(req: http.IncomingMessage, res: http.ServerResponse, uuid: string): void {
    const fileInfo = lib().getFilePath(uuid);
    if (!fileInfo) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error('File not found')));
      return;
    }

    const stat = fs.statSync(fileInfo.filePath);
    res.writeHead(200, {
      'Content-Type': fileInfo.mimeType,
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${fileInfo.fileName}"`,
      'Cache-Control': 'public, max-age=604800',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(fileInfo.filePath).pipe(res);
  },

  serveThumb(req: http.IncomingMessage, res: http.ServerResponse, uuid: string): void {
    const thumbInfo = lib().getThumbPath(uuid);
    if (!thumbInfo) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error('Thumb not found')));
      return;
    }

    const stat = fs.statSync(thumbInfo.filePath);
    res.writeHead(200, {
      'Content-Type': thumbInfo.mimeType,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=604800',
    });
    fs.createReadStream(thumbInfo.filePath).pipe(res);
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
