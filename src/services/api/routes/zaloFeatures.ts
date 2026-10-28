/**
 * Zalo mở rộng (SRS Deplao, ZL-01 → ZL-05): trạng thái truy cập, tự xoá tin nhắn, cài đặt quyền riêng tư, danh mục sản
 * phẩm zBusiness. Mirror UI: chat/zalo/ZaloPresenceLine.tsx, ZaloAutoDeleteSection.tsx, settings/ZaloPrivacySettings.tsx,
 * chat/zalo/ZaloCatalogPicker.tsx. Mọi route gọi đúng IPC handler zalo:* của giao diện.
 * Hội thoại ẩn bằng PIN (ZL-03) chỉ là lớp hiển thị của app — API giữ nguyên hành vi (quyết định Q2), không có route riêng.
 */
import { s } from '../schema';
import { AccountInfo, ApiContext, ApiError, route, RouteDef } from '../types';
import { CHANNELS, requireOnline, threadTypeNum, unsupported } from '../channels/ChannelActions';
import { accountParams, threadParams, threadTypeSchema } from './common';
import { ChatRouteDeps, resolveAttachment } from './chat';
import { ZALO_AUTO_DELETE_OPTIONS, isZaloAutoDeleteTtl } from '../../../shared/zaloAutoDelete';
import {
    ZALO_PRIVACY_SETTINGS, isValidZaloSettingValue, readZaloSettingValue, zaloTwoFactorEnabled,
} from '../../../shared/zaloPrivacySettings';
import { ZALO_PRODUCT_MAX_PHOTOS, validateZaloProduct } from '../../../shared/zaloCatalog';

const catalogParams = s.object({ accountId: s.id(), catalogId: s.id().describe('ID danh mục') });
const productParams = s.object({ accountId: s.id(), catalogId: s.id(), productId: s.id().describe('ID sản phẩm') });
const photoFileInput = s.object({
    upload_id: s.string().optional().describe('ID từ POST /media/uploads'),
    library_uuid: s.string().optional().describe('UUID ảnh trong thư viện media'),
    url: s.string().format('uri').optional().describe('Link ảnh http/https công khai, server tự tải về'),
});
const productBody = {
    name: s.string().min(1).max(200),
    price: s.string().min(1).max(30).describe('Giá, chỉ số (VNĐ), vd "150000"'),
    description: s.string().max(2000).optional(),
    photos: s.array(s.string().max(1000)).max(ZALO_PRODUCT_MAX_PHOTOS).optional()
        .describe('URL ảnh đã có trên Zalo (vd ảnh của sản phẩm khác), giữ đúng thứ tự'),
    photo_files: s.array(photoFileInput).max(ZALO_PRODUCT_MAX_PHOTOS).optional()
        .describe('Ảnh mới: mỗi mục đúng một trong upload_id, library_uuid, url. Deplao tải lên Zalo trước rồi xếp sau photos. '
            + 'Tổng photos + photo_files tối đa 5'),
};

function confirmIrreversible(ok: unknown, what: string): void {
    if (!ok) throw new ApiError(400, 'VALIDATION_ERROR', `Thao tác ${what} không thể hoàn tác — gửi kèm confirm=true`);
}

/** Kiểm cả ảnh sẽ tải lên (đếm chung giới hạn 5 ảnh) trước khi gọi Zalo. */
function productInput(body: any) {
    const pending = (body.photo_files || []).map(() => 'pending');
    const problem = validateZaloProduct({ ...body, photos: [...(body.photos || []), ...pending] });
    if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem);
    return { name: body.name, price: body.price, description: body.description || '', photos: body.photos || [] };
}

/** photo_files → tải lên Zalo (như nút thêm ảnh của app: zalo:uploadProductPhoto) → link, xếp sau photos. */
async function withUploadedPhotos(ctx: ApiContext, deps: ChatRouteDeps, acc: AccountInfo, input: ReturnType<typeof productInput>, files: any[] = []) {
    const photos = [...input.photos];
    if (files.length > 0) {
        if (acc.channel !== CHANNELS.ZALO) unsupported(acc, 'danh mục sản phẩm');
        requireOnline(acc); // trước khi tải ảnh từ url về máy
    }
    for (const file of files) {
        const local = await resolveAttachment(ctx, deps, { upload_id: file.upload_id, library_uuid: file.library_uuid, url: file.url });
        if (local.kind !== 'image') throw new ApiError(400, 'VALIDATION_ERROR', `${local.name} không phải ảnh`);
        const uploaded = await zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:uploadProductPhoto', { photoPath: local.path }, 60_000);
        photos.push(String(uploaded?.url || ''));
    }
    return { ...input, photos: photos.filter(Boolean) };
}

const userParams = s.object({ accountId: s.id(), userId: s.id().describe('ID người dùng Zalo') });

const TTL_HELP = `ttl_ms (ms): ${ZALO_AUTO_DELETE_OPTIONS.map((o) => `${o.value} = ${o.label}`).join(', ')}. `
    + 'Zalo xoá tin trên các thiết bị Zalo; Deplao vẫn giữ tin đã lưu.';

async function zaloCall(ctx: ApiContext, acc: AccountInfo, action: string, channel: string, payload: Record<string, any>, timeoutMs?: number) {
    if (acc.channel !== CHANNELS.ZALO) unsupported(acc, action);
    requireOnline(acc);
    const res = await ctx.call(channel, { auth: await ctx.zaloAuth(acc.id), ...payload }, timeoutMs ? { timeoutMs } : undefined);
    return res?.response ?? res;
}

export function zaloFeatureRoutes(deps: ChatRouteDeps): RouteDef[] {
    const ctags = ['Danh bạ'];
    const tags = ['Chat'];
    const atags = ['Tài khoản'];
    const ptags = ['Danh mục sản phẩm'];
    return [
        // ── ZL-02: cài đặt quyền riêng tư ──────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/zalo/settings', scope: 'accounts:read', tags: atags, operationId: 'getZaloPrivacySettings',
            summary: 'Cài đặt quyền riêng tư của tài khoản Zalo',
            description: 'Đọc trực tiếp từ Zalo (như Cài đặt → Tài khoản → Quyền riêng tư Zalo). Mỗi mục: key (dùng khi đổi), '
                + 'value hiện tại (null = Zalo không trả), các lựa chọn hợp lệ. two_factor_enabled chỉ đọc.',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const raw = await zaloCall(ctx, acc, 'cài đặt quyền riêng tư', 'zalo:getAccountSettings', {});
                return {
                    settings: ZALO_PRIVACY_SETTINGS.map((def) => ({
                        key: def.key,
                        label: def.label,
                        group: def.group,
                        value: readZaloSettingValue(def, raw),
                        options: def.kind === 'toggle' ? [{ value: 0, label: 'Tắt' }, { value: 1, label: 'Bật' }] : def.options,
                    })),
                    two_factor_enabled: zaloTwoFactorEnabled(raw),
                };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/zalo/settings', scope: 'accounts:manage', tags: atags, operationId: 'updateZaloPrivacySetting',
            summary: 'Đổi một cài đặt quyền riêng tư Zalo',
            description: 'Mỗi lần một mục, như app Zalo. key theo danh sách của GET; value thuộc lựa chọn của mục đó. '
                + 'Chú ý: receive_message = 2 hoặc accept_stranger_call = 2 (chỉ bạn bè) chặn khách chưa kết bạn nhắn / gọi.',
            params: accountParams,
            body: s.object({ key: s.string().min(1).max(64), value: s.int() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { key, value } = ctx.body;
                if (!isValidZaloSettingValue(key, value)) {
                    throw new ApiError(400, 'VALIDATION_ERROR', `Cài đặt không hợp lệ: ${key} = ${value}`);
                }
                await zaloCall(ctx, acc, 'cài đặt quyền riêng tư', 'zalo:updateAccountSetting', { key, value });
                return { key, value };
            },
        }),

        // ── ZL-01: trạng thái truy cập ──────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/users/:userId/presence', scope: 'contacts:read', tags: ctags, operationId: 'getUserPresence',
            summary: 'Trạng thái truy cập của một người (Zalo)',
            description: 'status: online | offline (kèm last_seen_at, ms) | hidden (người đó ẩn trạng thái truy cập) | unknown. '
                + 'Kết quả đệm 60 giây cho mỗi người; refresh=true hỏi lại Zalo ngay.',
            params: userParams,
            query: s.object({ refresh: s.boolean().optional().describe('Bỏ qua đệm 60 giây') }),
            response: s.object({
                status: s.enum(['online', 'offline', 'hidden', 'unknown'] as const),
                last_seen_at: s.int().nullable(),
                show_online_status: s.boolean(),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const p = await zaloCall(ctx, acc, 'trạng thái truy cập', 'zalo:getPresence', { userId: ctx.params.userId, force: !!ctx.query.refresh });
                return {
                    status: p?.status ?? 'unknown',
                    last_seen_at: typeof p?.lastSeenAt === 'number' ? p.lastSeenAt : null,
                    show_online_status: p?.showOnlineStatus !== false,
                };
            },
        }),

        // ── ZL-04: danh mục sản phẩm Zalo Business ─────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/zalo/catalogs', scope: 'chat:read', tags: ptags, operationId: 'listZaloCatalogs',
            summary: 'Danh mục sản phẩm của tài khoản Zalo Business',
            description: 'Đọc từ Zalo theo trang. url = link catalog.zalo.me để gửi vào hội thoại (route gửi link).',
            params: accountParams,
            query: s.object({ page: s.int().min(0).default(0), limit: s.int().min(1).max(50).default(20) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:getCatalogs', { page: ctx.query.page, limit: ctx.query.limit });
                return { items: res?.items || [], has_more: !!res?.hasMore };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/zalo/catalogs/:catalogId/products', scope: 'chat:read', tags: ptags, operationId: 'listZaloCatalogProducts',
            summary: 'Sản phẩm trong một danh mục Zalo Business',
            description: 'Đọc từ Zalo theo trang. Mỗi sản phẩm có url (catalog.zalo.me) để gửi vào hội thoại.',
            params: catalogParams,
            query: s.object({ page: s.int().min(0).default(0), limit: s.int().min(1).max(100).default(100) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:getCatalogProducts', {
                    catalogId: ctx.params.catalogId, page: ctx.query.page, limit: ctx.query.limit,
                });
                return { items: res?.items || [], has_more: !!res?.hasMore };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/zalo/catalogs', scope: 'crm:write', tags: ptags, operationId: 'createZaloCatalog',
            summary: 'Tạo danh mục sản phẩm Zalo Business',
            params: accountParams,
            body: s.object({ name: s.string().min(1).max(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:createCatalog', { name: ctx.body.name });
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/zalo/catalogs/:catalogId', scope: 'crm:write', tags: ptags, operationId: 'updateZaloCatalog',
            summary: 'Đổi tên danh mục sản phẩm Zalo Business',
            params: catalogParams,
            body: s.object({ name: s.string().min(1).max(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:updateCatalog', { catalogId: ctx.params.catalogId, name: ctx.body.name });
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/zalo/catalogs/:catalogId', scope: 'crm:write', tags: ptags, operationId: 'deleteZaloCatalog',
            summary: 'Xoá danh mục sản phẩm Zalo Business',
            description: 'Xoá cả sản phẩm trong danh mục trên Zalo, không hoàn tác — gửi confirm=true.',
            params: catalogParams,
            query: s.object({ confirm: s.boolean().default(false).describe('Phải là true') }),
            handler: async ctx => {
                confirmIrreversible(ctx.query.confirm, 'xoá danh mục');
                const acc = await ctx.account(ctx.params.accountId);
                return zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:deleteCatalog', { catalogId: ctx.params.catalogId });
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/zalo/catalogs/:catalogId/products', scope: 'crm:write', tags: ptags, operationId: 'createZaloCatalogProduct',
            summary: 'Thêm sản phẩm vào danh mục Zalo Business',
            description: 'Ảnh: photos (link đã có trên Zalo) và / hoặc photo_files (ảnh mới, Deplao tải lên Zalo trước).',
            params: catalogParams,
            body: s.object(productBody),
            handler: async ctx => {
                const input = productInput(ctx.body);
                const acc = await ctx.account(ctx.params.accountId);
                const product = await withUploadedPhotos(ctx, deps, acc, input, ctx.body.photo_files);
                return zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:createCatalogProduct', {
                    product: { catalogId: ctx.params.catalogId, ...product },
                });
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/zalo/catalogs/:catalogId/products/:productId', scope: 'crm:write', tags: ptags, operationId: 'updateZaloCatalogProduct',
            summary: 'Sửa sản phẩm trong danh mục Zalo Business',
            description: 'Gửi đủ tên, giá, mô tả, ảnh (như form sửa của app) và created_at của sản phẩm (từ danh sách sản phẩm). '
                + 'Ảnh giữ lại: photos; ảnh mới: photo_files.',
            params: productParams,
            body: s.object({ ...productBody, created_at: s.int().min(0).describe('created_at của sản phẩm (ms)') }),
            handler: async ctx => {
                const input = productInput(ctx.body);
                const acc = await ctx.account(ctx.params.accountId);
                const product = await withUploadedPhotos(ctx, deps, acc, input, ctx.body.photo_files);
                return zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:updateCatalogProduct', {
                    product: { catalogId: ctx.params.catalogId, productId: ctx.params.productId, createTime: ctx.body.created_at, ...product },
                });
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/zalo/catalogs/:catalogId/products', scope: 'crm:write', tags: ptags, operationId: 'deleteZaloCatalogProducts',
            summary: 'Xoá sản phẩm khỏi danh mục Zalo Business',
            description: 'Xoá trên Zalo, không hoàn tác — gửi confirm=true.',
            params: catalogParams,
            body: s.object({ product_ids: s.array(s.id()).min(1).max(100), confirm: s.boolean().default(false) }),
            handler: async ctx => {
                confirmIrreversible(ctx.body.confirm, 'xoá sản phẩm');
                const acc = await ctx.account(ctx.params.accountId);
                return zaloCall(ctx, acc, 'danh mục sản phẩm', 'zalo:deleteCatalogProducts', {
                    catalogId: ctx.params.catalogId, productIds: ctx.body.product_ids,
                });
            },
        }),

        // ── ZL-05: tự xoá tin nhắn ─────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/auto-delete', scope: 'chat:read', tags, operationId: 'getConversationAutoDelete',
            summary: 'Tự xoá tin nhắn của hội thoại trên Zalo',
            description: `Đọc lại từ Zalo (Zalo không báo khi đổi trên điện thoại). ${TTL_HELP}`,
            params: threadParams,
            response: s.object({ thread_id: s.string(), ttl_ms: s.int(), enabled: s.boolean() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const list = await zaloCall(ctx, acc, 'tự xoá tin nhắn', 'zalo:getAutoDeleteChats', {});
                const found = (Array.isArray(list) ? list : []).find((item: any) => String(item?.threadId) === String(ctx.params.threadId));
                const ttl = Number(found?.ttl) || 0;
                return { thread_id: String(ctx.params.threadId), ttl_ms: ttl, enabled: ttl > 0 };
            },
        }),
        route({
            method: 'PUT', path: '/accounts/:accountId/conversations/:threadId/auto-delete', scope: 'chat:manage', tags, operationId: 'setConversationAutoDelete',
            summary: 'Bật / tắt tự xoá tin nhắn trên Zalo',
            description: `Như mục "Tự xoá tin nhắn" trong chi tiết hội thoại. ${TTL_HELP} Nhóm có thể chỉ cho trưởng / phó nhóm đổi.`,
            params: threadParams,
            body: s.object({
                ttl_ms: s.int().min(0).describe('0 = tắt; 86400000 = 1 ngày; 604800000 = 7 ngày; 1209600000 = 14 ngày'),
                thread_type: threadTypeSchema.default('user'),
            }),
            response: s.object({ thread_id: s.string(), ttl_ms: s.int(), enabled: s.boolean() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const ttl = Number(ctx.body.ttl_ms);
                if (!isZaloAutoDeleteTtl(ttl)) {
                    throw new ApiError(400, 'VALIDATION_ERROR', `ttl_ms chỉ nhận ${ZALO_AUTO_DELETE_OPTIONS.map((o) => o.value).join(', ')}`);
                }
                await zaloCall(ctx, acc, 'tự xoá tin nhắn', 'zalo:setAutoDeleteChat', {
                    threadId: ctx.params.threadId, type: threadTypeNum(ctx.body.thread_type), ttl,
                });
                return { thread_id: String(ctx.params.threadId), ttl_ms: ttl, enabled: ttl > 0 };
            },
        }),
    ];
}
