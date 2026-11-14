/**
 * Workflow: read/edit/turn on-off/run, trigger.api events, run history, node catalog.
 * IPC channels: workflow:list, workflow:get, workflow:save, workflow:delete, workflow:toggle, workflow:clone,
 * workflow:runManual, workflow:simulate, workflow:triggerApi, workflow:getLogs, workflow:getWebhookUrl,
 * workflow:getNodeTypes, workflow:regenerateWebhookToken, workflow:deleteLogs, workflow:cloneAll.
 *
 * Keys limited to some accounts: only see workflows that apply to their own accounts (or shared workflows,
 * read-only); can only edit/run a workflow when every account it applies to is within the key's scope.
 */
import { s } from '../schema';
import { ApiContext, ApiError, Principal, route, RouteDef } from '../types';
import { accountAllowed } from '../auth/ApiAuth';
import { notFound } from './common';
import { tr } from '../../../shared/i18n';

const wfParams = s.object({ workflowId: s.id() });

export function mapWorkflow(wf: any): any {
    if (!wf) return null;
    return {
        id: wf.id,
        name: wf.name,
        description: wf.description || '',
        enabled: !!wf.enabled,
        channel: wf.channel || 'zalo',
        account_ids: Array.isArray(wf.pageIds) ? wf.pageIds : [],
        nodes: wf.nodes || [],
        edges: wf.edges || [],
        created_at: wf.createdAt ?? null,
        updated_at: wf.updatedAt ?? null,
    };
}

function canSee(p: Principal, wf: any): boolean {
    if (p.accountIds === null) return true;
    const ids: string[] = wf.pageIds || [];
    return ids.length === 0 || ids.some(id => accountAllowed(p, id));
}

function canModify(p: Principal, wf: { pageIds?: string[] }): boolean {
    if (p.accountIds === null) return true;
    const ids = wf.pageIds || [];
    return ids.length > 0 && ids.every(id => accountAllowed(p, id));
}

async function loadWorkflow(ctx: ApiContext, id: string, forWrite: boolean): Promise<any> {
    const res = await ctx.call('workflow:get', { id }, { errorMap: { 'Not found': [404, 'NOT_FOUND'] } });
    const wf = res?.workflow;
    if (!wf || !canSee(ctx.principal, wf)) notFound(`workflow ${id}`);
    if (forWrite && !canModify(ctx.principal, wf)) {
        throw new ApiError(403, 'FORBIDDEN_ACCOUNT', tr('Workflow áp dụng cho tài khoản ngoài phạm vi key (hoặc là workflow chung)'));
    }
    return wf;
}

const workflowBody = s.object({
    name: s.string().min(1).max(200),
    description: s.string().max(2000).default(''),
    enabled: s.boolean().default(false),
    channel: s.enum(['zalo', 'facebook', 'telegram_user', 'telegram_bot'] as const).default('zalo'),
    account_ids: s.array(s.id()).max(200).default([]).describe(tr('Tài khoản áp dụng; rỗng = mọi tài khoản')),
    nodes: s.array(s.any('object')).max(500).describe(tr('Node theo định dạng của trình soạn workflow (xem GET /workflows/node-types)')),
    edges: s.array(s.any('object')).max(2000),
});

export function workflowRoutes(): RouteDef[] {
    const tags = ['Workflow'];
    return [
        route({
            method: 'GET', path: '/workflows', scope: 'workflow:read', tags, operationId: 'listWorkflows',
            summary: tr('Danh sách workflow'),
            query: s.object({ account_id: s.id().optional().describe(tr('Chỉ workflow áp dụng cho tài khoản này')) }),
            handler: async ctx => {
                const res = await ctx.call('workflow:list');
                let list: any[] = (res?.workflows || []).filter((wf: any) => canSee(ctx.principal, wf));
                if (ctx.query.account_id) list = list.filter(wf => !wf.pageIds?.length || wf.pageIds.includes(ctx.query.account_id));
                return list.map(mapWorkflow);
            },
        }),
        route({
            method: 'GET', path: '/workflows/node-types', scope: 'workflow:read', tags, operationId: 'listWorkflowNodeTypes',
            summary: tr('Danh mục node (như palette của trình soạn) và cấu hình mặc định'),
            description: tr('`defaults[<type>]` liệt kê các khoá cấu hình node đó hiểu. Kiểm tra tính năng theo khoá, ví dụ `includeThreadIds` có trong `defaults["trigger.message"]` (và `tg.trigger.message`, `tgbot.trigger.message`, `fb.trigger.message`) = trigger tin nhắn nhận danh sách "Chỉ các chat/nhóm đã chọn" (mảng JSON ID; rỗng = mọi chat; ID có cả ở `excludeThreadIds` bị loại trừ).'),
            handler: async ctx => {
                const res = await ctx.call('workflow:getNodeTypes');
                return { groups: res?.groups || [], defaults: res?.defaults || {}, plugin_nodes: res?.pluginNodes || [] };
            },
        }),
        route({
            method: 'GET', path: '/workflows/:workflowId', scope: 'workflow:read', tags, operationId: 'getWorkflow',
            summary: tr('Một workflow (kèm nodes, edges)'),
            params: wfParams,
            handler: async ctx => mapWorkflow(await loadWorkflow(ctx, ctx.params.workflowId, false)),
        }),
        route({
            method: 'POST', path: '/workflows', scope: 'workflow:write', tags, operationId: 'createWorkflow',
            summary: tr('Tạo workflow'),
            body: workflowBody,
            handler: async ctx => {
                const b = ctx.body;
                if (!canModify(ctx.principal, { pageIds: b.account_ids })) {
                    throw new ApiError(403, 'FORBIDDEN_ACCOUNT', tr('Key giới hạn tài khoản phải chỉ rõ account_ids trong phạm vi được cấp'));
                }
                const res = await ctx.call('workflow:save', {
                    workflow: {
                        name: b.name, description: b.description, enabled: b.enabled, channel: b.channel,
                        pageIds: b.account_ids, nodes: b.nodes, edges: b.edges,
                    },
                });
                return { id: res?.id, webhook_token: res?.webhookToken ?? null };
            },
        }),
        route({
            method: 'PUT', path: '/workflows/:workflowId', scope: 'workflow:write', tags, operationId: 'updateWorkflow',
            summary: tr('Ghi đè workflow (giữ id, ngày tạo)'),
            params: wfParams,
            body: workflowBody,
            handler: async ctx => {
                const current = await loadWorkflow(ctx, ctx.params.workflowId, true);
                const b = ctx.body;
                if (!canModify(ctx.principal, { pageIds: b.account_ids })) {
                    throw new ApiError(403, 'FORBIDDEN_ACCOUNT', tr('account_ids ngoài phạm vi key'));
                }
                const res = await ctx.call('workflow:save', {
                    workflow: {
                        id: current.id, createdAt: current.createdAt, name: b.name, description: b.description,
                        enabled: b.enabled, channel: b.channel, pageIds: b.account_ids, nodes: b.nodes, edges: b.edges,
                    },
                });
                return { id: res?.id, webhook_token: res?.webhookToken ?? null };
            },
        }),
        route({
            method: 'PATCH', path: '/workflows/:workflowId', scope: 'workflow:write', tags, operationId: 'toggleWorkflow',
            summary: tr('Bật / tắt workflow'),
            params: wfParams,
            body: s.object({ enabled: s.boolean() }),
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, true);
                await ctx.call('workflow:toggle', { id: ctx.params.workflowId, enabled: ctx.body.enabled });
                return { enabled: ctx.body.enabled };
            },
        }),
        route({
            method: 'DELETE', path: '/workflows/:workflowId', scope: 'workflow:write', tags, operationId: 'deleteWorkflow',
            summary: tr('Xoá workflow'),
            params: wfParams,
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, true);
                await ctx.call('workflow:delete', { id: ctx.params.workflowId });
                return { deleted: true };
            },
        }),
        route({
            method: 'POST', path: '/workflows/:workflowId/clone', scope: 'workflow:write', tags, operationId: 'cloneWorkflow',
            summary: tr('Nhân bản workflow sang tài khoản khác'),
            params: wfParams,
            body: s.object({ target_account_id: s.id() }),
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, false);
                await ctx.account(ctx.body.target_account_id);
                const res = await ctx.call('workflow:clone', { id: ctx.params.workflowId, targetZaloId: ctx.body.target_account_id });
                return { id: res?.id ?? res?.newId ?? null };
            },
        }),
        route({
            method: 'POST', path: '/workflows/:workflowId/run', scope: 'workflow:run', tags, operationId: 'runWorkflow',
            summary: tr('Chạy workflow ngay với dữ liệu kích hoạt tuỳ ý (như nút "Chạy thử")'),
            params: wfParams,
            body: s.object({ trigger_data: s.any('object').default({}) }).optional(),
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, true);
                const res = await ctx.call('workflow:runManual', { id: ctx.params.workflowId, triggerData: ctx.body?.trigger_data || {} }, { timeoutMs: 300_000 });
                return { log: res?.log ?? null };
            },
        }),
        route({
            method: 'POST', path: '/workflows/:workflowId/simulate', scope: 'workflow:run', tags, operationId: 'simulateWorkflow',
            summary: tr('Chạy giả lập (không gửi tin thật)'),
            params: wfParams,
            body: s.object({ trigger_data: s.any('object').default({}) }).optional(),
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, false);
                const res = await ctx.call('workflow:simulate', { id: ctx.params.workflowId, triggerData: ctx.body?.trigger_data || {} }, { timeoutMs: 120_000 });
                return { log: res?.log ?? null };
            },
        }),
        route({
            method: 'POST', path: '/workflows/events/:eventName', scope: 'workflow:run', tags, operationId: 'emitWorkflowEvent',
            summary: tr('Bắn sự kiện cho các workflow có node "Khi API/plugin gọi" (trigger.api)'),
            description: tr('Workflow khớp tên sự kiện sẽ chạy bất đồng bộ (như mọi trigger). Trong workflow dùng `{{ $trigger.payload.<trường> }}`.'),
            params: s.object({ eventName: s.string().min(1).max(100).pattern(/^[A-Za-z0-9_.:-]+$/) }),
            body: s.object({
                payload: s.any('object').default({}),
                account_id: s.id().optional().describe(tr('Chỉ chạy workflow áp dụng cho tài khoản này')),
            }).optional(),
            examples: { request: { payload: { order_id: 'DH2291', phone: '0901234567' } }, response: { matched: 1, workflow_ids: ['8c1f…'] } },
            handler: async ctx => {
                const accountId = ctx.body?.account_id;
                if (accountId) await ctx.account(accountId);
                if (ctx.principal.accountIds !== null && !accountId) {
                    throw new ApiError(400, 'VALIDATION_ERROR', tr('Key giới hạn tài khoản phải truyền account_id'));
                }
                const res = await ctx.call('workflow:triggerApi', {
                    eventName: ctx.params.eventName,
                    payload: ctx.body?.payload || {},
                    keyId: ctx.principal.kind === 'apikey' ? ctx.principal.id : '',
                    accountId: accountId || '',
                    source: ctx.principal.kind === 'plugin' ? `plugin:${ctx.principal.id}` : 'api',
                });
                return { matched: Number(res?.matched) || 0, workflow_ids: res?.workflowIds || [] };
            },
        }),
        route({
            method: 'GET', path: '/workflows/:workflowId/runs', scope: 'workflow:read', tags, operationId: 'listWorkflowRuns',
            summary: tr('Lịch sử chạy gần đây'),
            params: wfParams,
            query: s.object({ limit: s.int().min(1).max(200).default(50) }),
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, false);
                const res = await ctx.call('workflow:getLogs', { id: ctx.params.workflowId, limit: ctx.query.limit });
                return res?.logs || [];
            },
        }),
        route({
            method: 'GET', path: '/workflows/:workflowId/webhook-url', scope: 'workflow:read', tags, operationId: 'getWorkflowWebhookUrl',
            summary: tr('URL webhook công khai của node "Webhook bên ngoài"'),
            params: wfParams,
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, false);
                const res = await ctx.call('workflow:getWebhookUrl', { id: ctx.params.workflowId });
                return { url: res?.webhookUrl ?? null, token: res?.token ?? null, tunnel_active: !!res?.tunnelActive };
            },
        }),
        route({
            method: 'POST', path: '/workflows/:workflowId/webhook-url/regenerate', scope: 'workflow:write', tags, operationId: 'regenerateWorkflowWebhookToken',
            summary: tr('Đổi token webhook (link cũ hết hiệu lực ngay)'),
            params: wfParams,
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, true);
                const res = await ctx.call('workflow:regenerateWebhookToken', { id: ctx.params.workflowId });
                return { url: res?.webhookUrl ?? null, token: res?.token ?? null };
            },
        }),
        route({
            method: 'DELETE', path: '/workflows/:workflowId/runs', scope: 'workflow:write', tags, operationId: 'deleteWorkflowRuns',
            summary: tr('Xoá lịch sử chạy của workflow'),
            params: wfParams,
            handler: async ctx => {
                await loadWorkflow(ctx, ctx.params.workflowId, true);
                await ctx.call('workflow:deleteLogs', { id: ctx.params.workflowId });
                return { deleted: true };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/workflows/clone', scope: 'workflow:write', tags, operationId: 'cloneAccountWorkflows',
            summary: tr('Sao chép mọi workflow của tài khoản này sang tài khoản khác'),
            description: tr('Như "Sao chép workflow sang tài khoản" trong app: bản sao áp dụng cho tài khoản đích, giữ trạng thái bật/tắt.'),
            params: s.object({ accountId: s.id() }),
            body: s.object({ to_account_id: s.id() }),
            handler: async ctx => {
                const from = await ctx.account(ctx.params.accountId);
                const to = await ctx.account(ctx.body.to_account_id);
                if (from.id === to.id) throw new ApiError(400, 'VALIDATION_ERROR', tr('Hai tài khoản phải khác nhau'));
                const r = await ctx.call('workflow:cloneAll', { sourceZaloId: from.id, targetZaloId: to.id });
                return { cloned: Number(r?.count) || 0 };
            },
        }),
    ];
}
