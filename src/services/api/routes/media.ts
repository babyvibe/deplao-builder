/**
 * Media: upload file để gửi vào chat, thư viện media.
 * Kênh IPC: library:getItems, library:getItem, library:upload, library:updateItem, library:deleteItem,
 * library:getFolders, library:createFolder, library:renameFolder, library:deleteFolder.
 */
import * as fs from 'fs';
import { s } from '../schema';
import { ApiContext, ApiError, route, RouteDef } from '../types';
import { accountAllowed } from '../ApiAuth';
import { UploadStore, parseMultipartFile } from '../UploadStore';
import { readBodyBuffer } from '../http';
import { getApiSettingNumber } from '../settings';
import { accountParams, notFound, offsetPage } from './common';
import { streamFile } from './chat';

export interface MediaRouteDeps {
    uploads: UploadStore;
}

function principalKey(ctx: ApiContext): string {
    return `${ctx.principal.kind}:${ctx.principal.id}`;
}

function mapLibraryItem(item: any): any {
    if (!item) return null;
    const { _localPath, _thumbLocalPath, file_path, thumb_path, fileUrl, thumbUrl, ...rest } = item;
    return {
        ...rest,
        file_url: `/api/v1/library/items/${item.uuid}/file`,
        thumb_url: _thumbLocalPath || thumb_path || thumbUrl ? `/api/v1/library/items/${item.uuid}/thumb` : null,
    };
}

async function libraryItem(ctx: ApiContext, uuid: string): Promise<any> {
    const r = await ctx.call('library:getItem', { uuid });
    const item = r?.item;
    if (!item || !accountAllowed(ctx.principal, String(item.owner_zalo_id))) notFound(`item thư viện ${uuid}`);
    return item;
}

export function mediaRoutes(deps: MediaRouteDeps): RouteDef[] {
    const tags = ['Media'];
    return [
        route({
            method: 'POST', path: '/media/uploads', scope: 'media:write', tags, operationId: 'uploadMedia',
            summary: 'Upload file để gửi vào chat (trả upload_id, hết hạn sau 24 giờ)',
            description: [
                'Hai cách gửi:',
                '- Raw body: header `X-Filename: ten-file.pdf` (URL-encode nếu có dấu) + `Content-Type` của file. Ghi thẳng xuống đĩa.',
                '- `multipart/form-data` với trường `file`.',
                'upload_id chỉ key đã upload dùng được.',
            ].join('\n'),
            rawBody: { contentType: 'application/octet-stream', description: 'Nội dung file (hoặc multipart/form-data trường file)' },
            response: s.object({
                upload_id: s.string(), name: s.string(), mime: s.string(), size: s.int(), kind: s.string(), expires_at: s.int(),
            }),
            handler: async ctx => {
                if (!ctx.raw) throw new ApiError(400, 'VALIDATION_ERROR', 'Upload chỉ qua HTTP');
                const req = ctx.raw.req;
                const maxBytes = Math.max(1, getApiSettingNumber('api_upload_max_mb')) * 1024 * 1024;
                const ct = String(req.headers['content-type'] || '');
                let rec;
                if (ct.toLowerCase().startsWith('multipart/form-data')) {
                    const buf = await readBodyBuffer(req, maxBytes + 256 * 1024);
                    const part = parseMultipartFile(buf, ct);
                    if (!part) throw new ApiError(400, 'VALIDATION_ERROR', 'Không tìm thấy trường file trong multipart');
                    rec = await deps.uploads.saveBuffer(part.data, part.name, part.mime, principalKey(ctx));
                } else {
                    const raw = String(req.headers['x-filename'] || '');
                    let name = 'file';
                    try { name = raw ? decodeURIComponent(raw) : 'file'; } catch { name = raw || 'file'; }
                    rec = await deps.uploads.saveStream(req, name, ct.split(';')[0].trim(), maxBytes, principalKey(ctx));
                }
                return { upload_id: rec.id, name: rec.name, mime: rec.mime, size: rec.size, kind: rec.kind, expires_at: rec.expires_at };
            },
        }),
        route({
            method: 'DELETE', path: '/media/uploads/:uploadId', scope: 'media:write', tags, operationId: 'deleteUpload',
            summary: 'Xoá file đã upload (không đợi hết hạn)',
            params: s.object({ uploadId: s.string().min(1).max(100) }),
            handler: ctx => ({ deleted: deps.uploads.delete(ctx.params.uploadId, principalKey(ctx)) }),
        }),

        // ── Thư viện ──────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/library/items', scope: 'media:read', tags, operationId: 'listLibraryItems',
            summary: 'Item trong thư viện media của tài khoản',
            params: accountParams,
            query: s.object({
                type: s.enum(['all', 'image', 'video', 'file', 'audio'] as const).default('all'),
                search: s.string().max(200).optional(),
                folder_id: s.int().optional().describe('-1 = chưa có thư mục'),
                page: s.int().min(1).default(1),
                limit: s.int().min(1).max(200).default(50),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const q = ctx.query;
                const r = await ctx.call('library:getItems', { zaloId: acc.id, type: q.type, search: q.search, folderId: q.folder_id, page: q.page, limit: q.limit });
                return offsetPage((r?.items || []).map(mapLibraryItem), q.limit, (q.page - 1) * q.limit, Number(r?.total) || 0);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/library/items', scope: 'media:write', tags, operationId: 'addLibraryItem',
            summary: 'Đưa file đã upload vào thư viện',
            params: accountParams,
            body: s.object({
                upload_id: s.string().min(1),
                name: s.string().max(200).optional(),
                tags: s.string().max(500).default(''),
                folder_id: s.int().nullable().optional(),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const rec = deps.uploads.get(ctx.body.upload_id, principalKey(ctx));
                const base64 = (await fs.promises.readFile(rec.path)).toString('base64');
                const r = await ctx.call('library:upload', {
                    zaloId: acc.id, fileName: ctx.body.name || rec.name, mimeType: rec.mime, base64,
                    tags: ctx.body.tags, folderId: ctx.body.folder_id ?? null, employeeId: '',
                }, { timeoutMs: 180_000 });
                return mapLibraryItem(r?.data);
            },
        }),
        route({
            method: 'PATCH', path: '/library/items/:uuid', scope: 'media:write', tags, operationId: 'updateLibraryItem',
            summary: 'Đổi tên, tag, thư mục, yêu thích',
            params: s.object({ uuid: s.string().min(1).max(100) }),
            body: s.object({
                name: s.string().max(200).optional(), tags: s.string().max(500).optional(),
                folder_id: s.int().nullable().optional(), is_favorite: s.boolean().optional(), alt_text: s.string().max(500).optional(),
            }),
            handler: async ctx => {
                await libraryItem(ctx, ctx.params.uuid);
                const b = ctx.body;
                await ctx.call('library:updateItem', {
                    uuid: ctx.params.uuid,
                    ...(b.name !== undefined ? { name: b.name } : {}),
                    ...(b.tags !== undefined ? { tags: b.tags } : {}),
                    ...(b.folder_id !== undefined ? { folderId: b.folder_id } : {}),
                    ...(b.is_favorite !== undefined ? { isFavorite: b.is_favorite ? 1 : 0 } : {}),
                    ...(b.alt_text !== undefined ? { altText: b.alt_text } : {}),
                });
                return { updated: true };
            },
        }),
        route({
            method: 'DELETE', path: '/library/items/:uuid', scope: 'media:write', tags, operationId: 'deleteLibraryItem',
            summary: 'Xoá item khỏi thư viện',
            params: s.object({ uuid: s.string().min(1).max(100) }),
            handler: async ctx => {
                await libraryItem(ctx, ctx.params.uuid);
                await ctx.ipc('library:deleteItem', ctx.params.uuid);
                return { deleted: true };
            },
        }),
        route({
            method: 'GET', path: '/library/items/:uuid/file', scope: 'media:read', tags, operationId: 'downloadLibraryItem',
            summary: 'Tải file của item',
            params: s.object({ uuid: s.string().min(1).max(100) }),
            rawResponse: { contentType: 'application/octet-stream', description: 'Nội dung file' },
            handler: async ctx => {
                const item = await libraryItem(ctx, ctx.params.uuid);
                return streamFile(ctx, String(item._localPath || ''), item.name);
            },
        }),
        route({
            method: 'GET', path: '/library/items/:uuid/thumb', scope: 'media:read', tags, operationId: 'downloadLibraryThumb',
            summary: 'Ảnh thu nhỏ của item',
            params: s.object({ uuid: s.string().min(1).max(100) }),
            rawResponse: { contentType: 'image/jpeg', description: 'Ảnh thu nhỏ' },
            handler: async ctx => {
                const item = await libraryItem(ctx, ctx.params.uuid);
                if (!item._thumbLocalPath) notFound('ảnh thu nhỏ');
                return streamFile(ctx, String(item._thumbLocalPath));
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/library/folders', scope: 'media:read', tags, operationId: 'listLibraryFolders',
            summary: 'Thư mục thư viện',
            params: accountParams,
            query: s.object({ type: s.string().max(20).optional() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return (await ctx.call('library:getFolders', { zaloId: acc.id, type: ctx.query.type }))?.folders || [];
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/library/folders', scope: 'media:write', tags, operationId: 'createLibraryFolder',
            summary: 'Tạo thư mục',
            params: accountParams,
            body: s.object({ name: s.string().min(1).max(200), color: s.string().max(20).optional() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const r = await ctx.call('library:createFolder', { zaloId: acc.id, name: ctx.body.name, color: ctx.body.color });
                return { id: Number(r?.id) };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/library/folders/:folderId', scope: 'media:write', tags, operationId: 'renameLibraryFolder',
            summary: 'Đổi tên thư mục',
            params: s.object({ accountId: s.id(), folderId: s.int().min(1) }),
            body: s.object({ name: s.string().min(1).max(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await ownFolder(ctx, acc.id, ctx.params.folderId);
                await ctx.call('library:renameFolder', { id: ctx.params.folderId, name: ctx.body.name });
                return { id: ctx.params.folderId, name: ctx.body.name };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/library/folders/:folderId', scope: 'media:write', tags, operationId: 'deleteLibraryFolder',
            summary: 'Xoá thư mục (file bên trong chuyển ra ngoài, không bị xoá)',
            params: s.object({ accountId: s.id(), folderId: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await ownFolder(ctx, acc.id, ctx.params.folderId);
                await ctx.call('library:deleteFolder', ctx.params.folderId);
                return { deleted: true };
            },
        }),
    ];
}

/** Thư mục phải thuộc tài khoản (handler đổi tên/xoá chỉ nhận id). */
async function ownFolder(ctx: ApiContext, accountId: string, folderId: number): Promise<void> {
    const folders: any[] = (await ctx.call('library:getFolders', { zaloId: accountId }))?.folders || [];
    if (!folders.some(f => Number(f.id) === folderId)) notFound(`thư mục ${folderId}`);
}
