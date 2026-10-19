/**
 * Tích hợp (POS, vận chuyển, thanh toán): xem, thêm/sửa/xoá, bật tắt, gọi action của adapter.
 * Kênh IPC: integration:list, integration:get, integration:save, integration:delete, integration:toggle,
 * integration:execute, integration:executeByType, integration:test.
 * Không bao giờ trả credential. Sửa không gửi credential (hoặc gửi rỗng) = giữ credential cũ, như màn cấu hình trong app.
 * Tích hợp dùng chung mọi tài khoản → key bị giới hạn tài khoản không được quản lý.
 */
import { s } from '../schema';
import { ApiContext, ApiError, route, RouteDef } from '../types';
import { notFound, scrub } from './common';

/**
 * Loại tích hợp có adapter (IntegrationRegistry.createAdapter) và các khoá credential/cài đặt (IntegrationPage CATALOG).
 * webhookSecret của phần mềm bán hàng = khoá xác thực webhook (services/integrations/posWebhook.ts).
 */
export const INTEGRATION_TYPES: Array<{ type: string; name: string; category: string; credentials: string[]; settings?: string[] }> = [
    { type: 'kiotviet', name: 'KiotViet', category: 'pos', credentials: ['clientId', 'clientSecret', 'retailerName', 'webhookSecret'], settings: ['defaultBranchId'] },
    { type: 'haravan', name: 'Haravan', category: 'pos', credentials: ['accessToken', 'apiKey', 'password', 'retailerDomain', 'webhookSecret'] },
    { type: 'sapo', name: 'Sapo', category: 'pos', credentials: ['storeDomain', 'apiKey', 'apiSecret', 'accessToken', 'webhookSecret'] },
    { type: 'nhanh', name: 'Nhanh.vn', category: 'pos', credentials: ['appId', 'businessId', 'accessToken', 'webhookSecret'] },
    { type: 'pancake', name: 'Pancake POS', category: 'pos', credentials: ['accessToken', 'shopId', 'webhookSecret'] },
    { type: 'casso', name: 'Casso', category: 'payment', credentials: ['apiKey', 'secretKey'] },
    { type: 'sepay', name: 'SePay', category: 'payment', credentials: ['apiKey', 'webhookSecretKey'] },
    { type: 'ghn', name: 'GHN Express', category: 'shipping', credentials: ['token', 'shopId'], settings: ['environment'] },
    { type: 'ghtk', name: 'GHTK', category: 'shipping', credentials: ['token'] },
    { type: 'telegram_bot', name: 'Telegram Bot', category: 'messaging', credentials: ['botToken'], settings: ['defaultChatId'] },
];

const TYPE_IDS = INTEGRATION_TYPES.map(t => t.type);

function requireUnrestricted(ctx: ApiContext): void {
    if (ctx.principal.accountIds !== null) {
        throw new ApiError(403, 'FORBIDDEN_ACCOUNT', 'Tích hợp dùng chung mọi tài khoản — chỉ key không giới hạn tài khoản mới được quản lý');
    }
}

function cleanCredentials(type: string, input: Record<string, any> | undefined): Record<string, string> {
    const allowed = new Set(INTEGRATION_TYPES.find(t => t.type === type)?.credentials || []);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input || {})) {
        if (!allowed.has(k)) throw new ApiError(400, 'VALIDATION_ERROR', `Credential "${k}" không thuộc loại ${type} (hợp lệ: ${Array.from(allowed).join(', ')})`);
        out[k] = String(v ?? '');
    }
    return out;
}

const integrationBody = s.object({
    type: s.enum(TYPE_IDS as unknown as readonly string[]).describe('Xem GET /integrations/types'),
    name: s.string().min(1).max(100).optional().describe('Bỏ trống = tên loại tích hợp'),
    enabled: s.boolean().default(true),
    credentials: s.record(s.string().max(4000), 20).describe('Khoá theo GET /integrations/types'),
    settings: s.record(s.any(), 50).optional(),
});

function mapIntegration(i: any): any {
    if (!i) return null;
    const { credentials, credentials_encrypted, ...rest } = i;
    return {
        ...scrub(rest),
        has_credentials: !!(credentials && Object.keys(credentials).length) || !!credentials_encrypted,
    };
}

export function integrationRoutes(): RouteDef[] {
    const tags = ['Tích hợp'];
    return [
        route({
            method: 'GET', path: '/integrations', scope: 'integrations:read', tags, operationId: 'listIntegrations',
            summary: 'Danh sách tích hợp đã cấu hình',
            handler: async ctx => {
                const res = await ctx.call('integration:list');
                return (res?.integrations || []).map(mapIntegration);
            },
        }),
        route({
            method: 'GET', path: '/integrations/:integrationId', scope: 'integrations:read', tags, operationId: 'getIntegration',
            summary: 'Một tích hợp (không có credential)',
            params: s.object({ integrationId: s.id() }),
            handler: async ctx => {
                const res = await ctx.call('integration:get', { id: ctx.params.integrationId });
                if (!res?.integration) notFound(`tích hợp ${ctx.params.integrationId}`);
                return mapIntegration(res.integration);
            },
        }),
        route({
            method: 'POST', path: '/integrations/:integrationId/actions/:action', scope: 'integrations:execute', tags, operationId: 'executeIntegrationAction',
            summary: 'Gọi một action của adapter (vd: lookupOrder, createOrder, getTracking)',
            description: 'Tên action và tham số giống node workflow tương ứng (vd. node `nhanh.lookupOrder` ↔ action `lookupOrder`).',
            params: s.object({ integrationId: s.id(), action: s.string().min(1).max(100).pattern(/^[A-Za-z0-9_.-]+$/) }),
            body: s.object({ params: s.any('object').default({}) }).optional(),
            examples: { request: { params: { orderId: 'DH2291' } } },
            handler: async ctx => {
                const res = await ctx.call('integration:execute', {
                    id: ctx.params.integrationId, action: ctx.params.action, params: ctx.body?.params || {},
                }, { timeoutMs: 120_000 });
                return scrub(res?.data ?? res?.result ?? null);
            },
        }),
        route({
            method: 'GET', path: '/integrations/types', scope: 'integrations:read', tags, operationId: 'listIntegrationTypes',
            summary: 'Loại tích hợp hỗ trợ và các khoá credential / cài đặt cần nhập',
            handler: async () => INTEGRATION_TYPES,
        }),
        route({
            method: 'POST', path: '/integrations', scope: 'integrations:manage', tags, operationId: 'createIntegration',
            summary: 'Thêm tích hợp (credential được mã hoá, không bao giờ trả ra)',
            body: integrationBody,
            examples: { request: { type: 'ghn', credentials: { token: 'ghn_xxx', shopId: '123456' }, settings: { environment: 'production' } } },
            handler: async ctx => {
                requireUnrestricted(ctx);
                const b = ctx.body;
                const credentials = cleanCredentials(b.type, b.credentials);
                if (!Object.values(credentials).some(v => v.trim())) throw new ApiError(400, 'VALIDATION_ERROR', 'Cần ít nhất một credential');
                const res = await ctx.call('integration:save', {
                    integration: {
                        type: b.type, name: b.name || INTEGRATION_TYPES.find(t => t.type === b.type)!.name,
                        enabled: b.enabled, credentials, settings: b.settings || {},
                    },
                });
                return { id: String(res?.id) };
            },
        }),
        route({
            method: 'PATCH', path: '/integrations/:integrationId', scope: 'integrations:manage', tags, operationId: 'updateIntegration',
            summary: 'Sửa tích hợp: tên, cài đặt, credential (bỏ trống = giữ cũ), bật/tắt',
            params: s.object({ integrationId: s.id() }),
            body: s.object({
                name: s.string().min(1).max(100).optional(),
                enabled: s.boolean().optional(),
                credentials: s.record(s.string().max(4000), 20).optional(),
                settings: s.record(s.any(), 50).optional(),
            }),
            handler: async ctx => {
                requireUnrestricted(ctx);
                const id = ctx.params.integrationId;
                const cur = (await ctx.call('integration:get', { id }, { errorMap: { 'Không tìm thấy': [404, 'NOT_FOUND'] } }))?.integration;
                if (!cur) notFound(`tích hợp ${id}`);
                const b = ctx.body || {};
                const onlyToggle = b.enabled !== undefined && b.name === undefined && b.credentials === undefined && b.settings === undefined;
                if (onlyToggle) {
                    await ctx.call('integration:toggle', { id, enabled: b.enabled });
                } else {
                    await ctx.call('integration:save', {
                        integration: {
                            id, type: cur.type, name: b.name ?? cur.name,
                            enabled: b.enabled ?? !!cur.enabled,
                            credentials: cleanCredentials(cur.type, b.credentials),
                            settings: b.settings ?? cur.settings ?? {},
                        },
                    });
                }
                return mapIntegration((await ctx.call('integration:get', { id }))?.integration);
            },
        }),
        route({
            method: 'DELETE', path: '/integrations/:integrationId', scope: 'integrations:manage', tags, operationId: 'deleteIntegration',
            summary: 'Xoá tích hợp (workflow dùng tích hợp này sẽ báo lỗi khi chạy)',
            params: s.object({ integrationId: s.id() }),
            handler: async ctx => {
                requireUnrestricted(ctx);
                const id = ctx.params.integrationId;
                const cur = (await ctx.call('integration:get', { id }, { errorMap: { 'Không tìm thấy': [404, 'NOT_FOUND'] } }))?.integration;
                if (!cur) notFound(`tích hợp ${id}`);
                await ctx.call('integration:delete', { id });
                return { deleted: true };
            },
        }),
        route({
            method: 'POST', path: '/integrations/by-type/:type/actions/:action', scope: 'integrations:execute', tags, operationId: 'executeIntegrationActionByType',
            summary: 'Gọi action theo loại tích hợp (dùng tích hợp đang bật của loại đó)',
            description: 'Tiện khi chỉ có một tích hợp mỗi loại, như node workflow (vd. `ghn` + `getTracking`).',
            params: s.object({ type: s.enum(TYPE_IDS as unknown as readonly string[]), action: s.string().min(1).max(100).pattern(/^[A-Za-z0-9_.-]+$/) }),
            body: s.object({ params: s.any('object').default({}) }).optional(),
            handler: async ctx => {
                const res = await ctx.call('integration:executeByType', {
                    type: ctx.params.type, action: ctx.params.action, params: ctx.body?.params || {},
                }, { timeoutMs: 120_000 });
                return scrub(res?.data ?? null);
            },
        }),
        route({
            method: 'POST', path: '/integrations/:integrationId/test', scope: 'integrations:execute', tags, operationId: 'testIntegration',
            summary: 'Kiểm tra kết nối của tích hợp',
            params: s.object({ integrationId: s.id() }),
            handler: async ctx => {
                const res = await ctx.ipc('integration:test', { id: ctx.params.integrationId });
                return { success: !!res?.success, message: res?.message || res?.error || '' };
            },
        }),
    ];
}
