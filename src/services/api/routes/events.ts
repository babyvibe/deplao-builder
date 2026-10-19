/**
 * Sự kiện (polling, SSE, danh mục) và webhook outbound.
 */
import { s } from '../schema';
import { ApiContext, ApiError, paged, principalLogId, RESPONSE_HANDLED, route, RouteDef } from '../types';
import { accountAllowed } from '../ApiAuth';
import { CORS_HEADERS } from '../http';
import { EVENT_TYPES } from '../events/catalog';
import type { EventHub } from '../events/EventHub';
import type { WebhookOutboundService } from '../events/WebhookOutboundService';
import { allowPrivateTargets } from './common';

export interface EventRouteDeps {
    hub: EventHub;
    webhooks: WebhookOutboundService;
}

const typesQuery = s.array(s.string().max(100)).max(50).optional().describe('Lọc loại sự kiện, vd: message.*,friend.request.received');

/** Mỗi principal chỉ thấy webhook của chính mình (key_id = id key, hoặc "<kind>:<id>"). */
function ownerKey(ctx: ApiContext): string {
    return ctx.principal.kind === 'apikey' ? ctx.principal.id : principalLogId(ctx.principal);
}

function checkAccounts(ctx: ApiContext, ids: string[] | undefined | null): void {
    for (const id of ids || []) {
        if (!accountAllowed(ctx.principal, id)) throw new ApiError(403, 'FORBIDDEN_ACCOUNT', `Không được cấp tài khoản ${id}`);
    }
}

export function eventRoutes(deps: EventRouteDeps): RouteDef[] {
    const tags = ['Sự kiện'];
    const wtags = ['Webhook'];
    return [
        route({
            method: 'GET', path: '/events/types', scope: null, tags, operationId: 'listEventTypes',
            summary: 'Danh mục loại sự kiện',
            handler: () => EVENT_TYPES,
        }),
        route({
            method: 'GET', path: '/events', scope: 'events:subscribe', tags, operationId: 'pollEvents',
            summary: 'Lấy sự kiện sau một mốc seq (polling)',
            description: 'Gọi lặp lại với `since = pagination.next_since`. Sự kiện được giữ 7 ngày / 50.000 bản ghi (đổi trong Cài đặt).',
            query: s.object({
                since: s.int().min(0).default(0).describe('seq cuối cùng đã nhận'),
                limit: s.int().min(1).max(1000).default(200),
                types: typesQuery,
                account_ids: s.array(s.id()).max(200).optional(),
            }),
            handler: ctx => {
                const items = deps.hub.replay(ctx.query.since, { principal: ctx.principal, types: ctx.query.types, accountIds: ctx.query.account_ids }, ctx.query.limit);
                const last = items.length ? items[items.length - 1].seq : ctx.query.since;
                return paged(items, { limit: ctx.query.limit, has_more: items.length >= ctx.query.limit, next_since: last });
            },
        }),
        route({
            method: 'GET', path: '/events/stream', scope: 'events:subscribe', tags, operationId: 'streamEvents',
            summary: 'Luồng sự kiện Server-Sent Events',
            description: 'Mỗi sự kiện: `id: <seq>`, `event: <type>`, `data: <json>`. Kết nối lại với header `Last-Event-ID` hoặc `?since=` để nhận phần bị lỡ. Comment `: ping` mỗi 15 giây.',
            query: s.object({ since: s.int().min(0).optional(), types: typesQuery, account_ids: s.array(s.id()).max(200).optional() }),
            rawResponse: { contentType: 'text/event-stream', description: 'Luồng SSE' },
            handler: ctx => {
                if (!ctx.raw) throw new ApiError(400, 'VALIDATION_ERROR', 'Chỉ dùng qua HTTP');
                const { req, res } = ctx.raw;
                const filter = { principal: ctx.principal, types: ctx.query.types, accountIds: ctx.query.account_ids };
                res.writeHead(200, {
                    ...CORS_HEADERS,
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
                const write = (ev: any) => {
                    res.write(`${ev.seq ? `id: ${ev.seq}\n` : ''}event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
                };
                const lastHeader = Number(req.headers['last-event-id']);
                const since = Number.isFinite(lastHeader) && lastHeader > 0 ? lastHeader : ctx.query.since;
                let replaying = true;
                const pending: any[] = [];
                let lastReplayed = since || 0;
                const unsubscribe = deps.hub.subscribe({ ...filter, handler: ev => { if (replaying) pending.push(ev); else write(ev); } });
                if (since !== undefined) {
                    for (const ev of deps.hub.replay(since, filter, 5000)) { write(ev); lastReplayed = Math.max(lastReplayed, ev.seq); }
                }
                replaying = false;
                for (const ev of pending) if (!ev.seq || ev.seq > lastReplayed) write(ev);
                res.write(`: connected seq_now=${deps.hub.latestSeq()}\n\n`);
                const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
                const close = () => { clearInterval(ping); unsubscribe(); };
                req.on('close', close);
                res.on('error', close);
                return RESPONSE_HANDLED;
            },
        }),

        // ── Webhook ───────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/webhooks', scope: 'webhooks:manage', tags: wtags, operationId: 'listWebhooks',
            summary: 'Webhook của key này',
            handler: ctx => deps.webhooks.list(ownerKey(ctx)),
        }),
        route({
            method: 'POST', path: '/webhooks', scope: 'webhooks:manage', tags: wtags, operationId: 'createWebhook',
            summary: 'Đăng ký webhook (trả secret một lần)',
            description: 'Deplao POST sự kiện tới `url` kèm chữ ký `X-Deplao-Signature: v1=<HMAC-SHA256(secret, timestamp + "." + body)>`. Xem hướng dẫn "Webhook".\n\nURL trong mạng nội bộ (localhost, 192.168.x, 10.x) chỉ được phép khi gọi từ chính máy chạy Deplao (không qua tunnel), hoặc khi bật cài đặt `api_allow_private_urls`.',
            body: s.object({
                name: s.string().max(100).default(''),
                url: s.string().format('uri').max(2000),
                events: s.array(s.string().max(100)).max(50).default(['*']),
                account_ids: s.array(s.id()).max(200).optional(),
                secret: s.string().min(16).max(200).optional().describe('Bỏ trống = Deplao tự sinh'),
            }),
            examples: { request: { name: 'CRM sync', url: 'https://crm.example.com/deplao', events: ['message.received', 'friend.request.received'] } },
            handler: ctx => {
                checkAccounts(ctx, ctx.body.account_ids);
                const { subscription, secret } = deps.webhooks.create({
                    keyId: ownerKey(ctx), name: ctx.body.name, url: ctx.body.url, events: ctx.body.events,
                    accountIds: ctx.body.account_ids ?? null, secret: ctx.body.secret,
                    allowPrivate: allowPrivateTargets(ctx),
                });
                return { ...subscription, secret };
            },
        }),
        route({
            method: 'GET', path: '/webhooks/:id', scope: 'webhooks:manage', tags: wtags, operationId: 'getWebhook',
            summary: 'Một webhook',
            params: s.object({ id: s.id() }),
            handler: ctx => deps.webhooks.get(ctx.params.id, ownerKey(ctx)),
        }),
        route({
            method: 'PATCH', path: '/webhooks/:id', scope: 'webhooks:manage', tags: wtags, operationId: 'updateWebhook',
            summary: 'Sửa webhook / bật lại sau khi tự tắt',
            params: s.object({ id: s.id() }),
            body: s.object({
                name: s.string().max(100).optional(), url: s.string().format('uri').max(2000).optional(),
                events: s.array(s.string().max(100)).max(50).optional(), account_ids: s.array(s.id()).max(200).nullable().optional(),
                active: s.boolean().optional(),
            }),
            handler: ctx => {
                checkAccounts(ctx, ctx.body.account_ids);
                return deps.webhooks.update(ctx.params.id, ownerKey(ctx), {
                    name: ctx.body.name, url: ctx.body.url, events: ctx.body.events,
                    accountIds: ctx.body.account_ids, active: ctx.body.active,
                    allowPrivate: allowPrivateTargets(ctx),
                });
            },
        }),
        route({
            method: 'DELETE', path: '/webhooks/:id', scope: 'webhooks:manage', tags: wtags, operationId: 'deleteWebhook',
            summary: 'Xoá webhook',
            params: s.object({ id: s.id() }),
            handler: ctx => { deps.webhooks.remove(ctx.params.id, ownerKey(ctx)); return { deleted: true }; },
        }),
        route({
            method: 'POST', path: '/webhooks/:id/test', scope: 'webhooks:manage', tags: wtags, operationId: 'testWebhook',
            summary: 'Gửi thử sự kiện "ping" ngay',
            params: s.object({ id: s.id() }),
            handler: ctx => deps.webhooks.test(ctx.params.id, ownerKey(ctx)),
        }),
        route({
            method: 'GET', path: '/webhooks/:id/deliveries', scope: 'webhooks:manage', tags: wtags, operationId: 'listWebhookDeliveries',
            summary: 'Lịch sử gửi gần nhất (mặc định 100, tối đa 500)',
            params: s.object({ id: s.id() }),
            query: s.object({ status: s.enum(['pending', 'delivered', 'failed'] as const).optional(), limit: s.int().min(1).max(500).default(100) }),
            handler: ctx => {
                deps.webhooks.get(ctx.params.id, ownerKey(ctx));
                return deps.webhooks.deliveries(ctx.params.id, { status: ctx.query.status, limit: ctx.query.limit });
            },
        }),
        route({
            method: 'POST', path: '/webhook-deliveries/:id/retry', scope: 'webhooks:manage', tags: wtags, operationId: 'retryWebhookDelivery',
            summary: 'Gửi lại một lần gửi lỗi',
            params: s.object({ id: s.id() }),
            handler: ctx => { deps.webhooks.retry(ctx.params.id, ownerKey(ctx)); return { queued: true }; },
        }),
    ];
}
