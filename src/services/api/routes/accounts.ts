/**
 * Nhóm Tài khoản: danh sách, trạng thái, kết nối/ngắt, proxy.
 * Kênh IPC: login:getAccounts, login:checkHealth, login:connect, login:disconnect,
 * fb:connect, fb:disconnect, fb:checkHealth, telegramUser:startListener, telegramUser:isConnected,
 * proxy:getForAccount, proxy:setAccount, proxy:list.
 */
import { s } from '../schema';
import { ApiError, route, RouteDef } from '../types';
import { accountAllowed } from '../ApiAuth';
import { CHANNELS } from '../channels/ChannelActions';
import { accountParams, scrub } from './common';

const accountSchema = s.object({
    id: s.string(), channel: s.string(), display_name: s.string(), avatar_url: s.string(), phone: s.string(),
    online: s.boolean(), is_business: s.boolean(), listener_active: s.boolean(),
    created_at: s.any().nullable(), last_seen: s.any().nullable(),
});

function maskProxy(p: any): any {
    if (!p || typeof p !== 'object') return p;
    const { password, ...rest } = p;
    return { ...scrub(rest), has_password: !!password };
}

async function rawAccount(ctx: any, accountId: string): Promise<any> {
    const res = await ctx.call('login:getAccounts');
    return (res?.accounts || []).find((a: any) => String(a.zalo_id) === String(accountId)) || null;
}

export function accountRoutes(): RouteDef[] {
    return [
        route({
            method: 'GET', path: '/accounts', scope: 'accounts:read', tags: ['Tài khoản'], operationId: 'listAccounts',
            summary: 'Danh sách tài khoản (Zalo, Facebook, Telegram) mà key được phép',
            query: s.object({
                channel: s.enum(['zalo', 'facebook', 'telegram_user', 'telegram_bot'] as const).optional().describe('Lọc theo kênh'),
                online: s.boolean().optional().describe('Chỉ tài khoản đang online'),
            }),
            response: s.array(accountSchema),
            handler: async ctx => {
                const list = await ctx.listAccounts();
                return list
                    .filter((a: any) => accountAllowed(ctx.principal, a.id))
                    .filter((a: any) => !ctx.query.channel || a.channel === ctx.query.channel)
                    .filter((a: any) => ctx.query.online === undefined || a.online === ctx.query.online);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId', scope: 'accounts:read', tags: ['Tài khoản'], operationId: 'getAccount',
            summary: 'Thông tin một tài khoản',
            params: accountParams,
            response: accountSchema,
            handler: ctx => ctx.account(ctx.params.accountId),
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/status', scope: 'accounts:read', tags: ['Tài khoản'], operationId: 'getAccountStatus',
            summary: 'Trạng thái kết nối/listener chi tiết và proxy đang dùng',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                let health: any = null;
                try {
                    if (acc.channel === CHANNELS.ZALO) {
                        const res = await ctx.call('login:checkHealth', { zaloIds: [acc.id] });
                        health = res?.results?.[0] || null;
                    } else if (acc.channel === CHANNELS.FACEBOOK) {
                        health = await ctx.call('fb:checkHealth', { accountId: acc.id });
                    } else if (acc.channel === CHANNELS.TELEGRAM_USER) {
                        health = await ctx.ipc('telegramUser:isConnected', acc.id);
                    }
                } catch (err: any) {
                    health = { error: err?.message || String(err) };
                }
                let proxy: any = null;
                try {
                    const p = await ctx.call('proxy:getForAccount', { zaloId: acc.id });
                    proxy = maskProxy(p?.proxy ?? null);
                } catch { proxy = null; }
                return { account: acc, health: scrub(health), proxy };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/connect', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'connectAccount',
            summary: 'Kết nối lại tài khoản bằng phiên đã lưu',
            description: 'Dùng phiên đăng nhập đã lưu trên máy (không nhận cookie từ client). Zalo: login:connect; Facebook: fb:connect; Telegram: telegramUser:startListener.',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.FACEBOOK) {
                    const r = await ctx.call('fb:connect', { accountId: acc.id }, { timeoutMs: 120_000 });
                    return { connected: true, listener_connected: !!r?.listenerConnected };
                }
                const raw = await rawAccount(ctx, acc.id);
                if (!raw) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy phiên đăng nhập đã lưu');
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    if (!raw.cookies) throw new ApiError(409, 'CONFLICT', 'Phiên Telegram không còn, cần đăng nhập lại trên app');
                    await ctx.call('telegramUser:startListener', { accountId: acc.id, phoneNumber: '', stringSession: raw.cookies }, { timeoutMs: 120_000 });
                    return { connected: true };
                }
                if (acc.channel === CHANNELS.ZALO) {
                    await ctx.call('login:connect', {
                        auth: { cookies: raw.cookies || '', imei: raw.imei || '', userAgent: raw.user_agent || '' },
                    }, { timeoutMs: 120_000 });
                    return { connected: true };
                }
                throw new ApiError(422, 'CHANNEL_UNSUPPORTED', `Kênh ${acc.channel} chưa hỗ trợ kết nối qua API`);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/disconnect', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'disconnectAccount',
            summary: 'Ngắt kết nối tài khoản (giữ dữ liệu)',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.FACEBOOK) await ctx.call('fb:disconnect', { accountId: acc.id });
                else await ctx.call('login:disconnect', { zaloId: acc.id });
                return { disconnected: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/proxy', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'getAccountProxy',
            summary: 'Proxy đang gán cho tài khoản (không trả mật khẩu)',
            params: accountParams,
            handler: async ctx => {
                await ctx.account(ctx.params.accountId);
                const res = await ctx.call('proxy:getForAccount', { zaloId: ctx.params.accountId });
                return maskProxy(res?.proxy ?? null);
            },
        }),
        route({
            method: 'PUT', path: '/accounts/:accountId/proxy', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'setAccountProxy',
            summary: 'Gán proxy (id trong danh sách proxy) hoặc bỏ proxy (null)',
            params: accountParams,
            body: s.object({ proxy_id: s.int().nullable().describe('ID proxy từ GET /proxies; null = bỏ proxy') }),
            handler: async ctx => {
                await ctx.account(ctx.params.accountId);
                await ctx.call('proxy:setAccount', { zaloId: ctx.params.accountId, proxyId: ctx.body.proxy_id ?? null });
                return { proxy_id: ctx.body.proxy_id ?? null };
            },
        }),
        route({
            method: 'GET', path: '/proxies', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'listProxies',
            summary: 'Danh sách proxy đã cấu hình (không trả mật khẩu)',
            handler: async ctx => {
                const res = await ctx.call('proxy:list');
                const list = Array.isArray(res) ? res : (res?.proxies || res?.items || []);
                return list.map(maskProxy);
            },
        }),
    ];
}
